/**
 * Path validation — the single security entry point for every vault read.
 *
 * Mandated by ADR D8 ("reject all symlinks") and D16 ("single serializer
 * for Tool + Resource"). Every tool handler and the `note://` resource
 * MUST call `validatePath(input, vaultRoot)` before touching the FS.
 *
 * Algorithm (Brief lines 686–763):
 *   1. Input pre-checks: length, null byte, percent-encoded octet,
 *      backslash, absolute path, `.`/`..` segments, depth > 32.
 *   2. NFC normalize.
 *   3. Segment-by-segment `lstat` walk from cached vault root; reject any
 *      symlink (D8 — no "follow if inside vault" policy).
 *   4. `realpath` for containment cross-check ONLY:
 *      `path.relative(vaultRoot, real)` must NOT start with `..` (D8
 *      again — `path.relative`, NEVER string-prefix).
 *   5. Return `SafePath{absolute: walked}` (pre-realpath). Read sites
 *      use {@link openNoFollow} so the open itself refuses any leaf-
 *      symlink swap that happened post-validation; returning `real`
 *      would silently follow such a swap when its target is in-vault.
 *
 * The window between segment walk and final open is the documented
 * residual TOCTOU (THREAT_MODEL V1/V6 — Node 22 has no FD-relative
 * `openat` API; closing it requires a native addon, deferred).
 *
 * On Windows, libuv silently ignores `O_NOFOLLOW`. {@link openNoFollow}
 * substitutes a pre-open `lstat` + post-open `fstat` dev/ino compare so
 * a leaf-symlink swap during the validation→open window still gets
 * rejected; see that function's doc comment for the full reasoning.
 */

import { constants as fsConstants, type Stats } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { PathRejectionReason, SafePath, VaultError } from "../types.js";
import { CANDIDATE_LIST_SEP, CONTROL_CHAR_CLASS_TAIL, HEADING_PATH_SEP } from "./controlChars.js";
import { errorMessage, getErrnoCode, isVanishedErrno, vaultError } from "./error.js";
import { isNonNfc } from "./hiddenPath.js";
import { indexCacheFiles } from "./index/sqlite.js";
import { MAX_PATH_DEPTH, MAX_PATH_LENGTH } from "./limits.js";
import { toPosix } from "./pathPosix.js";

/**
 * Resolved vault root context. Produced once at startup by
 * {@link validateVaultRoot}; passed to every {@link validatePath} call.
 */
export interface VaultRoot {
	/** Realpath-resolved absolute path; load-bearing for containment. */
	absolute: string;
}

/**
 * Error class wrapping a {@link VaultError} payload. Throw from
 * validation; tool handlers catch and wrap with `toolErrorEnvelope`.
 */
export class PathValidationError extends Error {
	override readonly name = "PathValidationError";
	readonly payload: VaultError;
	constructor(payload: VaultError) {
		super(payload.message);
		this.payload = payload;
	}
}

/**
 * Patterns evaluated once at module load — `validatePath` is invoked on
 * every tool call, so per-call regex compilation or template-literal
 * allocation would be hot-path bloat.
 */
const PERCENT_ENCODED_RE = /%[0-9a-fA-F]{2}/;
const BACKSLASH_RE = /\\/;
// NTFS reserved device names per Microsoft Learn (Naming Files, Paths, and
// Namespaces): CON, PRN, AUX, NUL, COM1-9, LPT1-9, plus the 8859-1
// superscript variants COM¹/COM²/COM³, LPT¹/LPT²/LPT³ (U+00B9/B2/B3 — NOT
// the Unicode superscript block U+2070+; only the legacy 8859-1 code
// points are device-aliased). Reserved case-insensitively, bare or with
// any extension (`CON.md` ≡ `CON`); `CONFIGS.md` is fine — the trailing
// `(\.|$)` enforces a base-name boundary. COM0 / LPT0 are NOT enumerated
// by MS and so are NOT rejected — vaults migrate cross-platform, so a
// legitimate `COM0.md` note must round-trip.
const RESERVED_DEVICE_NAME_RE = /^(CON|PRN|AUX|NUL|COM[1-9\u00B9\u00B2\u00B3]|LPT[1-9\u00B9\u00B2\u00B3])(\.|$)/i;
// NTFS strips trailing dots and spaces during normalization, so `notes.md.`
// and `notes.md ` open the same file as `notes.md` while `readdir` only
// enumerates `notes.md` — breaks the "every addressable path is enumerable"
// invariant.
const TRAILING_DOT_OR_SPACE_RE = /[. ]$/;
// Inverse of `formatFileHeading`'s `«…»` wrap (`renderText/_shared.ts`).
// The wrap fires when output contains ` › ` (heading-path fence) or
// `, ` (candidate-list fence); mirror both triggers here so a vault
// file literally named `«foo.md»` (no inner separator) isn't rewritten
// to `foo.md` before validation. Inner content still flows through the
// regular pipeline below so `«foo\nbar»` is rejected by `CONTROL_CHAR`.
function stripOuterGuillemets(input: string): string {
	if (input.length < 2 || !input.startsWith("«") || !input.endsWith("»")) return input;
	const inner = input.slice(1, -1);
	return inner.includes(HEADING_PATH_SEP) || inner.includes(CANDIDATE_LIST_SEP) ? inner : input;
}
// C0 controls minus NUL (NUL has its own rejection above) plus the
// class tail (DEL + C1 + U+2028 / U+2029) shared with the prose-side
// `PROSE_CONTROL_RE_*` in `renderText/_shared.ts`. POSIX admits these
// in filenames but they break prose-channel rendering: a `\n` in
// `${row.file}` forges a fake `next: <cursor>` line that an LLM client
// can mistake for a server pagination cursor. U+2028 / U+2029 are
// visually rendered as line breaks in many chat UIs and terminals —
// same forgery class as a literal `\n`.
const CONTROL_CHAR_RE = new RegExp(`[\\x01-\\x1F${CONTROL_CHAR_CLASS_TAIL}]`);
const PARENT_REL_PREFIX = `..${sep}`;

/** True for `/` (always accepted) and the platform separator (`\` on Windows). */
const isPathSep = (c: string): boolean => c === "/" || c === sep;

/**
 * `path.relative(vaultRoot, ...)` returns an escape path iff it equals
 * `..`, starts with `../` (or `..\\` on Windows), or is absolute. A
 * filename like `..draft.md` is legal — `startsWith("..")` would falsely
 * flag it.
 */
function isEscapePath(rel: string): boolean {
	return rel === ".." || rel.startsWith(PARENT_REL_PREFIX) || isAbsolute(rel);
}

/**
 * Combined gate for "would this relpath be addressable through the
 * tool surface?" — sync portion of `validatePath` plus the NFC check.
 * Used by every walker that yields candidate paths (scanner, merkle,
 * tree) to skip files whose rows would dangle behind a `validatePath`
 * reject from the read side.
 */
export function passesPathPolicy(rel: string): boolean {
	if (classifyRelpathPolicy(rel) !== null) return false;
	if (isNonNfc(rel)) return false;
	return true;
}

/**
 * Validate the configured vault path at startup. Order is load-bearing
 * (Brief lines 754–758):
 *
 *   1. `lstat` the user input — if it's a symlink itself, refuse to
 *      start. Resolving first would silently follow the symlink.
 *   2. Then `realpath` to canonicalize (handles `/var → /private/var`
 *      style stable resolutions).
 *
 * Throws {@link PathValidationError} with `code: "PATH_OUTSIDE_VAULT"`
 * and `reason: "SYMLINK_SEGMENT"` if the configured root is a symlink.
 */
export async function validateVaultRoot(input: string): Promise<VaultRoot> {
	const trimmed = stripDeviceNamespacePrefix(stripTrailingPathSep(input));
	const resolved = await walkVaultRoot(trimmed);
	await assertRealDirectory(resolved, { label: "Vault root" });
	return { absolute: await realpath(resolved) };
}

/**
 * Strip trailing separators and trailing `/.` / `/./` no-op segments,
 * leaving interior `./..` untouched. `path.resolve` would collapse `..`
 * lexically — `missing-subdir/..` then resolves to CWD and
 * `<symlink>/..` to the symlink's lexical parent rather than the FS-
 * reached parent. Trailing separators still need stripping so POSIX
 * `lstat` doesn't dereference a symlinked vault root via `dir/`; the
 * trailing `/.` strip preserves the same semantics for shells that
 * emit `mylink/.`. Windows drive roots (`C:\`) keep their separator —
 * `C:` is "current directory on drive C," a different target.
 */
function stripTrailingPathSep(input: string): string {
	if (input === "") return "";
	let end = input.length;
	while (end > 0) {
		const c = input.charAt(end - 1);
		if (isPathSep(c)) {
			end--;
			continue;
		}
		if (c === "." && end >= 2 && isPathSep(input.charAt(end - 2))) {
			end -= 2;
			continue;
		}
		break;
	}
	// All chars strippable; preserve the leading char as sole survivor
	// (`"/"`, `"//"` → `"/"`; `"."`, `"./"` → `"."`).
	if (end === 0) return input.charAt(0);
	const stripped = input.slice(0, end);
	// Restore the trailing separator only when the loop stripped one AND
	// the stripped form is a Windows root whose semantics flip without
	// the trailer: bare drive `C:` is drive-relative ("current dir on
	// drive C") not the drive root; `\\?\C:` and `\\.\C:` are invalid
	// without the trailer; UNC roots without the trailer are ambiguous.
	if (end < input.length && sep === "\\" && WIN_ROOT_NEEDING_SEP.test(stripped)) {
		return `${stripped}${sep}`;
	}
	return stripped;
}

/** Windows root forms requiring a trailing separator: bare drive, verbatim
 *  namespace drive (`\\?\C:`) / Volume GUID (`\\?\Volume{GUID}`), DOS device
 *  drive (`\\.\C:`) / Volume GUID (`\\.\Volume{GUID}`), verbatim UNC root
 *  (`\\?\UNC\server\share`), regular UNC root (`\\server\share`). Volume
 *  GUID paths are common for unlettered volumes / multi-disk setups and
 *  name the device object (not the root dir) without the trailer. */
export const WIN_ROOT_NEEDING_SEP =
	/^(?:[A-Za-z]:|\\\\(?:[?.]\\[A-Za-z]:|[?.]\\Volume\{[^}\\]+\}|\?\\UNC\\[^\\]+\\[^\\]+|[^\\?.][^\\]*\\[^\\]+))$/;

/**
 * Strip the `\\?\` / `\\.\` device-namespace prefix from a drive-letter
 * path (`\\?\C:\notes` → `C:\notes`). libuv's `lstat` / `realpath` reject
 * the device-namespace *drive-root* forms (`\\?\C:\`) with `EISDIR`, while
 * the plain drive form resolves normally. Verbatim UNC (`\\?\UNC\…`) and
 * Volume-GUID (`\\?\Volume{…}\…`) paths are left untouched — stripping
 * would corrupt the UNC root, and a GUID volume has no plain equivalent.
 *
 * A path separator after the drive colon is required: `\\?\C:\…` strips,
 * but trailerless `\\?\C:` does not. The latter is a malformed root, and
 * stripping it to bare `C:` would silently retarget the server at the
 * drive-relative CWD; left unchanged it falls through to `lstat`, which
 * rejects it.
 */
function stripDeviceNamespacePrefix(input: string): string {
	return /^\\\\[?.]\\([A-Za-z]:[\\/].*)$/.exec(input)?.[1] ?? input;
}

/**
 * Vault-root path-segment separators. Windows accepts both `\` and `/`;
 * POSIX treats `\` as an ordinary filename character, so a vault root such
 * as `/srv/a\b` must NOT split on it — that shatters the real directory
 * name `a\b` into two non-existent segments.
 */
const VAULT_ROOT_SEGMENT_SEP_RE = sep === "\\" ? /[\\/]+/ : /\/+/;

/**
 * `..`-aware segment walk for vault-root validation. Windows `lstat` and
 * `realpath` collapse interior `..` *lexically* before the syscall, so a
 * single `lstat` of `<dir>/missing/..` wrongly succeeds and `<symlink>/..`
 * yields the link's lexical parent. Walking component-by-component —
 * `lstat` each real segment (a missing one throws), and resolving each
 * `..` via `realpath` + `dirname` — restores POSIX component-walk
 * semantics on every platform. Intermediate symlinks are tolerated; only
 * the final target's symlink check (in {@link assertRealDirectory}) is
 * load-bearing, matching the pre-fix single-`lstat` behavior.
 */
async function walkVaultRoot(input: string): Promise<string> {
	// An empty root would fall through to `cur = root || "."` below and
	// silently resolve to the process CWD. Reject it. (`parseCli` already
	// rejects an empty `--vault`; this guards direct callers of the exported
	// `validateVaultRoot`.)
	if (input === "") {
		throw new PathValidationError(
			vaultError("PATH_OUTSIDE_VAULT", "Vault root is empty.", {
				param: "vault",
				reason: "VAULT_ROOT_INACCESSIBLE" satisfies PathRejectionReason,
			}),
		);
	}
	// `path.parse` truncates a verbatim-UNC root to `\\?\UNC\`, dropping the
	// `server\share` that together form the real share root — the walk would
	// then `lstat` the bare `\\?\UNC\server` and reject a valid root. The
	// plain UNC form (`\\server\share\…`) parses correctly and is supported;
	// point the operator there rather than mis-walking the verbatim form.
	if (/^\\\\[?.]\\UNC\\/i.test(input)) {
		throw new PathValidationError(
			vaultError(
				"PATH_OUTSIDE_VAULT",
				`Verbatim UNC vault root is not supported: ${input} — use the plain \\\\server\\share\\... form.`,
				{
					param: "vault",
					reason: "VAULT_ROOT_INACCESSIBLE" satisfies PathRejectionReason,
				},
			),
		);
	}
	const root = parse(input).root;
	const segments = input
		.slice(root.length)
		.split(VAULT_ROOT_SEGMENT_SEP_RE)
		.filter((s) => s.length > 0 && s !== ".");
	// Seed the walk base. A relative input has an empty root → seed "." so
	// realpath/join have a valid base. A bare drive root ("C:") is drive-
	// relative — the CWD on that drive, not the drive root — so resolve it;
	// otherwise the first `join` jumps to the drive root (`join("C:","notes")`
	// → "C:\notes", which differs from drive-relative "C:notes").
	let cur = /^[A-Za-z]:$/.test(root) ? resolve(root) : root || ".";
	for (const seg of segments) {
		try {
			if (seg === "..") {
				// `..` cannot traverse out of a non-directory (POSIX → ENOTDIR).
				// realpath() resolves a file / symlink-to-file target happily, so
				// guard before taking the parent. realpath output is symlink-free,
				// so lstat here is a faithful is-it-a-directory check.
				const real = await realpath(cur);
				if (!(await lstat(real)).isDirectory()) {
					throw new Error(`Not a directory: ${cur}`);
				}
				cur = dirname(real);
			} else {
				cur = join(cur, seg);
				await lstat(cur);
			}
		} catch (cause) {
			throw new PathValidationError(
				vaultError("PATH_OUTSIDE_VAULT", `Vault root not accessible: ${cur}`, {
					param: "vault",
					reason: "VAULT_ROOT_INACCESSIBLE" satisfies PathRejectionReason,
					cause: errorMessage(cause),
				}),
			);
		}
	}
	return cur;
}

/**
 * Refuse to open the SQLite cache path if its parent directory is a
 * symlink (or anything other than a real directory). Without this guard,
 * a hostile vault that pre-plants `.markdown-mcp` as a symlink would
 * redirect all index writes outside the vault — `mkdir(..., recursive)`
 * silently follows symlinks, and the subsequent `Database` open follows
 * them too. ENOENT is fine: the caller will mkdir a fresh directory.
 */
export async function ensureIndexDirIsRealDir(dirAbsolute: string): Promise<void> {
	await assertRealDirectory(dirAbsolute, { label: "Index directory", allowEnoent: true });
}

/**
 * Refuse to open the SQLite cache file (or its WAL/SHM sidecars) if any
 * exist as anything other than a regular file. Symlinks redirect index
 * writes outside the vault; directories crash startup; FIFOs hang on
 * read; block devices redirect writes onto a real partition. ENOENT is
 * fine: SQLite will create the file fresh.
 *
 * WAL mode (`PRAGMA journal_mode = WAL` in `sqlite.ts`) creates only the
 * `-wal` and `-shm` sidecars; the legacy rollback `-journal` is not used
 * and `-master-journal` is multi-DB-only.
 *
 * Residual TOCTOU window between this lstat and `new Database(dbPath)`
 * is the same class as `validatePath`'s segment-walk → `O_NOFOLLOW`
 * window (THREAT_MODEL V1/V6). Closing it requires `O_NOFOLLOW` on the
 * SQLite open, which better-sqlite3 doesn't expose.
 */
export async function assertIndexFilesAreRegular(dbPath: string): Promise<void> {
	for (const path of indexCacheFiles(dbPath)) {
		let stat: Stats;
		try {
			stat = await lstat(path);
		} catch (cause) {
			if (isENOENT(cause)) continue;
			throw new PathValidationError(
				vaultError("PATH_OUTSIDE_VAULT", `Failed to stat index file: ${path}`, {
					param: "vault",
					reason: "STAT_FAILED" satisfies PathRejectionReason,
					cause: errorMessage(cause),
				}),
			);
		}
		if (stat.isSymbolicLink()) {
			throw new PathValidationError(
				vaultError("PATH_OUTSIDE_VAULT", `Index file is a symlink: ${path}`, {
					param: "vault",
					reason: "INDEX_FILE_SYMLINK" satisfies PathRejectionReason,
				}),
			);
		}
		if (!stat.isFile()) {
			throw new PathValidationError(
				vaultError("PATH_OUTSIDE_VAULT", `Index file is not a regular file: ${path}`, {
					param: "vault",
					reason: "INDEX_FILE_NOT_REGULAR" satisfies PathRejectionReason,
				}),
			);
		}
	}
}

/**
 * Shared `lstat` → reject-symlink → reject-non-directory sequence. Used by
 * both startup vault-root validation and the index-dir guard. ENOENT is
 * fatal unless `allowEnoent` is set (the index-dir caller can mkdir
 * afterwards). All other failures throw {@link PathValidationError}.
 */
async function assertRealDirectory(path: string, options: { label: string; allowEnoent?: boolean }): Promise<void> {
	const { label, allowEnoent = false } = options;
	let stat: Stats;
	try {
		stat = await lstat(path);
	} catch (cause) {
		if (allowEnoent && isENOENT(cause)) return;
		throw new PathValidationError(
			vaultError("PATH_OUTSIDE_VAULT", `${label} not accessible: ${path}`, {
				param: "vault",
				reason: "VAULT_ROOT_INACCESSIBLE" satisfies PathRejectionReason,
				cause: errorMessage(cause),
			}),
		);
	}
	if (stat.isSymbolicLink()) {
		throw new PathValidationError(
			vaultError("PATH_OUTSIDE_VAULT", `${label} is a symlink: ${path}`, {
				param: "vault",
				reason: "VAULT_ROOT_SYMLINK" satisfies PathRejectionReason,
			}),
		);
	}
	if (!stat.isDirectory()) {
		throw new PathValidationError(
			vaultError("PATH_OUTSIDE_VAULT", `${label} is not a directory: ${path}`, {
				param: "vault",
				reason: "VAULT_ROOT_NOT_DIRECTORY" satisfies PathRejectionReason,
			}),
		);
	}
}

/**
 * Subset of {@link PathRejectionReason} produced by the sync policy
 * classifier (no FS I/O). Excludes reasons that require an `lstat` walk
 * or `realpath`, like `SYMLINK_SEGMENT` or `OUTSIDE_VAULT`.
 */
export type SyncPathRejection =
	| "EMPTY_PATH"
	| "PATH_TOO_LONG"
	| "NULL_BYTE"
	| "CONTROL_CHAR"
	| "PERCENT_ENCODED"
	| "BACKSLASH"
	| "COLON"
	| "RESERVED_DEVICE_NAME"
	| "TRAILING_DOT_OR_SPACE"
	| "ABSOLUTE_PATH"
	| "TRAVERSAL_SEGMENT"
	| "TOO_DEEP";

/**
 * Sync subset of {@link validatePath}'s policy — string-only checks that
 * never touch the filesystem. Returns the FIRST violation, or `null` if
 * the relpath would survive the sync portion of validation.
 *
 * Used by:
 *   - {@link validatePath} for early rejection before the segment-walk
 *     `lstat` chain (single source of truth for policy reasons).
 *   - `walkVault` in `src/lib/index/scanner.ts` — skips files whose
 *     paths the tool surface would reject, preserving the invariant
 *     that every indexed file is addressable via `get_fragment` /
 *     `note://`.
 */
export function classifyRelpathPolicy(input: string): SyncPathRejection | null {
	if (input === "") return "EMPTY_PATH";
	if (input.length > MAX_PATH_LENGTH) return "PATH_TOO_LONG";
	if (input.includes("\x00")) return "NULL_BYTE";
	if (CONTROL_CHAR_RE.test(input)) return "CONTROL_CHAR";
	if (PERCENT_ENCODED_RE.test(input)) return "PERCENT_ENCODED";
	if (BACKSLASH_RE.test(input)) return "BACKSLASH";
	// Test for absolute paths BEFORE the `:` guard so a Windows drive-
	// prefixed path like `C:/vault/note.md` surfaces as ABSOLUTE_PATH on
	// Win32 (`node:path.isAbsolute` is platform-aware). Without this
	// ordering, the COLON branch fires first and points agents at an ADS
	// fix when the actual issue is "pass a vault-relative path."
	if (isAbsolute(input)) return "ABSOLUTE_PATH";
	// `:` is NTFS's alternate-data-stream separator (`note.md:secret` opens a
	// hidden stream of `note.md`). Reject always-on because vaults migrate
	// between platforms (sync, NFS, archive extract).
	if (input.includes(":")) return "COLON";

	const normalized = input.normalize("NFC");
	const cleaned = normalized.startsWith("./") ? normalized.slice(2) : normalized;
	const segments = cleaned.split("/").filter((s) => s.length > 0);
	if (segments.length === 0) return "EMPTY_PATH";
	for (const seg of segments) {
		if (seg === "." || seg === "..") return "TRAVERSAL_SEGMENT";
		if (RESERVED_DEVICE_NAME_RE.test(seg)) return "RESERVED_DEVICE_NAME";
		if (TRAILING_DOT_OR_SPACE_RE.test(seg)) return "TRAILING_DOT_OR_SPACE";
	}
	if (segments.length > MAX_PATH_DEPTH) return "TOO_DEEP";
	return null;
}

const POLICY_REJECTION_MESSAGES: Record<SyncPathRejection, string> = {
	EMPTY_PATH: "Path is empty.",
	PATH_TOO_LONG: `Path exceeds ${MAX_PATH_LENGTH} characters.`,
	NULL_BYTE: "Path contains NUL byte.",
	CONTROL_CHAR: "Path contains a control character (newline, tab, DEL, etc.); use printable characters only.",
	PERCENT_ENCODED: "Path contains percent-encoded octet; pass paths in their decoded form.",
	BACKSLASH: "Path contains backslash; use forward slashes.",
	COLON: "Path contains ':'; reserved on NTFS as the alternate-data-stream separator.",
	RESERVED_DEVICE_NAME: "Path segment is a Windows reserved device name (CON, PRN, AUX, NUL, COM1-9, LPT1-9).",
	TRAILING_DOT_OR_SPACE:
		"Path segment ends in a dot or space; NTFS strips these during normalization, creating a name-alias.",
	ABSOLUTE_PATH: "Path is absolute; pass vault-relative paths.",
	TRAVERSAL_SEGMENT: "Path contains traversal segment.",
	TOO_DEEP: `Path exceeds maximum depth of ${MAX_PATH_DEPTH} segments.`,
};

/**
 * Validate a vault-relative path string. Throws
 * {@link PathValidationError} on every rejection condition; returns a
 * {@link SafePath} on success.
 *
 * The `vaultRoot.absolute` MUST be the realpath-resolved root (use
 * {@link validateVaultRoot}).
 */
export async function validatePath(input: string, vaultRoot: VaultRoot): Promise<SafePath> {
	const stripped = stripOuterGuillemets(input);
	const policyReason = classifyRelpathPolicy(stripped);
	if (policyReason !== null) {
		throw new PathValidationError(
			vaultError("PATH_OUTSIDE_VAULT", POLICY_REJECTION_MESSAGES[policyReason], {
				param: "file",
				reason: policyReason,
			}),
		);
	}

	// NFC normalize before any FS operation. macOS APFS lookups are
	// normalization-insensitive but we keep input form consistent for
	// containment checks. Do NOT also normalize realpath output —
	// containment compares against the FS-native form.
	const normalized = stripped.normalize("NFC");

	// Strip a leading "./" if present (common shorthand). Treat as empty
	// segment elsewhere — the split below ignores it.
	const cleaned = normalized.startsWith("./") ? normalized.slice(2) : normalized;
	const segments = cleaned.split("/").filter((s) => s.length > 0);

	// Segment-walk lstat from vault root. Reject any symlink encountered
	// — including the leaf. This catches `linked_dir/secret.md` where
	// only `linked_dir` is a symlink and a final-only check would miss.
	let walked = vaultRoot.absolute;
	for (const seg of segments) {
		walked = join(walked, seg);
		let stat: Stats;
		try {
			stat = await lstat(walked);
		} catch (cause) {
			// ENOTDIR: traversing through a regular file (e.g. `foo.md/bar`).
			// Same domain answer as ENOENT — the deeper path doesn't exist.
			if (isVanishedErrno(cause)) {
				throw new PathValidationError(
					vaultError("PATH_NOT_FOUND", `Path does not exist: ${input}`, {
						param: "file",
					}),
				);
			}
			throw new PathValidationError(
				vaultError("PATH_OUTSIDE_VAULT", `Failed to stat path segment: ${input}`, {
					param: "file",
					reason: "STAT_FAILED" satisfies PathRejectionReason,
					cause: errorMessage(cause),
				}),
			);
		}
		if (stat.isSymbolicLink()) {
			throw new PathValidationError(
				vaultError("PATH_OUTSIDE_VAULT", `Path contains a symlink at segment '${seg}'.`, {
					param: "file",
					reason: "SYMLINK_SEGMENT" satisfies PathRejectionReason,
				}),
			);
		}
	}

	// realpath for containment cross-check ONLY (D8 — `path.relative`,
	// NEVER string-prefix). Result is NOT returned; read sites get
	// `walked` so `O_NOFOLLOW` can refuse a post-validation symlink swap.
	let real: string;
	try {
		real = await realpath(walked);
	} catch (cause) {
		if (isENOENT(cause)) {
			throw new PathValidationError(
				vaultError("PATH_NOT_FOUND", `Path does not exist: ${input}`, {
					param: "file",
				}),
			);
		}
		throw new PathValidationError(
			vaultError("PATH_OUTSIDE_VAULT", `Failed to realpath: ${input}`, {
				param: "file",
				reason: "REALPATH_FAILED" satisfies PathRejectionReason,
				cause: errorMessage(cause),
			}),
		);
	}

	const rel = relative(vaultRoot.absolute, real);
	if (rel === "" || isEscapePath(rel)) {
		throw new PathValidationError(
			vaultError("PATH_OUTSIDE_VAULT", `Path resolves outside the vault: ${input}`, {
				param: "file",
				reason: "OUTSIDE_VAULT" satisfies PathRejectionReason,
			}),
		);
	}

	// Re-emit relative form using forward slashes for client display
	// regardless of OS path separator.
	const relativePosix = toPosix(rel);

	return {
		input,
		normalized,
		absolute: walked,
		relative: relativePosix,
	};
}

/** Bounded retries for `openNoFollow`'s win32 identity match — see below. */
const WIN32_OPEN_RETRIES = 4;

/**
 * Backoff between Win32 vanish-retries. AV scanner and SMB
 * unlink-then-rename windows are documented at 5–50 ms (cross-platform
 * editors like vim on Windows and opt-in VS Code atomic save trigger
 * them). 4 attempts × 3 retry gaps × 25 ms = 75 ms max sleep budget —
 * covers the upper end of the documented window with headroom for
 * variance; truly-gone files pay one 25 ms wait per failed open before
 * settling. Identity-mismatch retry stays delay-free — TOCTOU
 * resolution, not a save-window race.
 */
const WIN32_VANISH_RETRY_DELAY_MS = 25;

/**
 * Open a previously-validated absolute path. Returned `FileHandle` is the
 * caller's responsibility to close.
 *
 * Two protections layered on POSIX:
 *   - `O_NOFOLLOW` refuses a final-component symlink swap that occurred
 *     between `validatePath` and the open (THREAT_MODEL V1/V6).
 *   - `O_NONBLOCK` ensures the open returns immediately for FIFOs / named
 *     pipes that have no writer attached — otherwise `open(O_RDONLY)`
 *     blocks waiting for a writer, a trivial server-hang vector. The
 *     caller `fstat`s and rejects non-regular files (see `readNote`).
 *
 * Windows libuv silently strips `O_NOFOLLOW`, so a swapped-in symlink is
 * followed during the open itself. Two substitutes layered: (a) a pre-open
 * `lstat` rejects symlink leaves before the open triggers the libuv follow,
 * closing the `validatePath → openNoFollow` hang vector for slow UNC
 * targets; (b) the existing post-open `fstat`/`lstat` identity check stays
 * for the residual pre-lstat → open race. Both attempts also `continue` on
 * `ENOENT`/`ENOTDIR` so a benign unlink-then-rename safe-save settles
 * within one retry, with a {@link WIN32_VANISH_RETRY_DELAY_MS} sleep so
 * AV/SMB-latent rename windows actually get a chance to land; final-attempt
 * vanish propagates so a truly-gone file still routes to `PATH_NOT_FOUND`
 * → prune. A sustained hostile swap never matches and is rejected
 * (bounded — a DoS at worst, never an escape).
 *
 * Residual (V1/V6 in THREAT_MODEL): the pre-open `lstat` closes the
 * common Win32 attack vector (leaf is a symlink at lstat time →
 * `SYMLINK_SEGMENT` throw before `open`). The residual race window is
 * between the pre-open lstat resolving and the `open()` syscall —
 * microseconds on local FS. An attacker with vault-write access can
 * theoretically swap the leaf to a symlink pointing at a slow UNC share
 * or named pipe in that window, causing libuv (which strips `O_NOFOLLOW`)
 * to block on the open. Node 22 `fs.promises.open` does NOT accept an
 * `AbortSignal` (verified against the official Node 22 fs/promises API
 * surface — `open()` takes `(path, flags[, mode])`, no options
 * parameter), so we cannot cleanly cancel a hanging open. `Promise.race`
 * with `setTimeout` would leak the libuv worker thread without preventing
 * `UV_THREADPOOL_SIZE=4` exhaustion under sustained attack. The residual
 * is bounded by the trusted-vault threat model; worker-thread isolation
 * or a native `CreateFile` path is reserved for a future hardening round
 * if cross-mount hostile scenarios emerge.
 */
export async function openNoFollow(absolutePath: string): Promise<import("node:fs/promises").FileHandle> {
	if (process.platform !== "win32") {
		return open(absolutePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
	}
	for (let attempt = 0; attempt < WIN32_OPEN_RETRIES; attempt++) {
		// Pre-open lstat: libuv strips O_NOFOLLOW on Win32, so an open
		// against a leaf-symlink would follow the link and could hang on a
		// slow UNC target before the post-open identity check fires. Catch
		// the symlink here; the post-open check stays for the residual
		// pre-lstat → open race.
		let preStatIsSymlink: boolean;
		try {
			preStatIsSymlink = (await lstat(absolutePath, { bigint: true })).isSymbolicLink();
		} catch (err) {
			if (isVanishedErrno(err) && attempt < WIN32_OPEN_RETRIES - 1) {
				await sleep(WIN32_VANISH_RETRY_DELAY_MS);
				continue;
			}
			throw err;
		}
		if (preStatIsSymlink) {
			// Symlink leaf is never legitimate post-validatePath; editors
			// don't transit through leaf-symlinks as a transient state.
			throw new PathValidationError(
				vaultError("PATH_OUTSIDE_VAULT", "Path leaf became a symlink.", {
					param: "file",
					reason: "SYMLINK_SEGMENT" satisfies PathRejectionReason,
				}),
			);
		}
		let fh: import("node:fs/promises").FileHandle;
		try {
			fh = await open(absolutePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
		} catch (err) {
			if (isVanishedErrno(err) && attempt < WIN32_OPEN_RETRIES - 1) {
				await sleep(WIN32_VANISH_RETRY_DELAY_MS);
				continue;
			}
			throw err;
		}
		try {
			const handleStat = await fh.stat({ bigint: true });
			const leafStat = await lstat(absolutePath, { bigint: true });
			if (!leafStat.isSymbolicLink() && handleStat.ino === leafStat.ino && handleStat.dev === leafStat.dev) {
				return fh;
			}
		} catch (err) {
			await fh.close().catch(() => {});
			if (isVanishedErrno(err) && attempt < WIN32_OPEN_RETRIES - 1) {
				await sleep(WIN32_VANISH_RETRY_DELAY_MS);
				continue;
			}
			throw err;
		}
		// Identity mismatch — a symlink swap or an atomic save raced the
		// open; close this handle and retry against the settled leaf.
		await fh.close().catch(() => {});
	}
	throw new PathValidationError(
		vaultError("PATH_OUTSIDE_VAULT", "Path leaf could not be opened without an unresolved swap.", {
			param: "file",
			reason: "SYMLINK_SEGMENT" satisfies PathRejectionReason,
		}),
	);
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function isENOENT(err: unknown): boolean {
	return getErrnoCode(err) === "ENOENT";
}
