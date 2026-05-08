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
 * On Windows, libuv silently ignores `O_NOFOLLOW`. v1 CI is macOS+Linux
 * only; Windows is best-effort via WSL.
 */

import { constants as fsConstants, type Stats } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, join, normalize, relative, sep } from "node:path";
import type { PathRejectionReason, SafePath, VaultError } from "../types.js";
import { errorMessage, getErrnoCode, isVanishedErrno, vaultError } from "./error.js";
import { isNonNfc } from "./hiddenPath.js";
import { indexCacheFiles } from "./index/sqlite.js";
import { MAX_PATH_DEPTH, MAX_PATH_LENGTH } from "./limits.js";

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
const PARENT_REL_PREFIX = `..${sep}`;

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
	// POSIX `lstat` dereferences trailing `/`, `/.`, and `/./` forms,
	// bypassing the symlink-root check. `path.normalize` collapses dot
	// segments uniformly; then strip the trailing slash it preserves.
	// Empty input is kept as-is (normalize("") === ".") so the lstat below
	// fails with ENOENT instead of silently accepting the CWD.
	const normalized = input === "" ? "" : normalize(input);
	const trimmed = normalized.length > 1 ? normalized.replace(/\/+$/, "") : normalized;
	await assertRealDirectory(trimmed, { label: "Vault root" });
	return { absolute: await realpath(trimmed) };
}

/**
 * Refuse to open the SQLite cache path if its parent directory is a
 * symlink (or anything other than a real directory). Without this guard,
 * a hostile vault that pre-plants `.vault-mcp` as a symlink would
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
	| "PERCENT_ENCODED"
	| "BACKSLASH"
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
	if (PERCENT_ENCODED_RE.test(input)) return "PERCENT_ENCODED";
	if (BACKSLASH_RE.test(input)) return "BACKSLASH";
	if (isAbsolute(input)) return "ABSOLUTE_PATH";

	const normalized = input.normalize("NFC");
	const cleaned = normalized.startsWith("./") ? normalized.slice(2) : normalized;
	const segments = cleaned.split("/").filter((s) => s.length > 0);
	if (segments.length === 0) return "EMPTY_PATH";
	for (const seg of segments) {
		if (seg === "." || seg === "..") return "TRAVERSAL_SEGMENT";
	}
	if (segments.length > MAX_PATH_DEPTH) return "TOO_DEEP";
	return null;
}

const POLICY_REJECTION_MESSAGES: Record<SyncPathRejection, string> = {
	EMPTY_PATH: "Path is empty.",
	PATH_TOO_LONG: `Path exceeds ${MAX_PATH_LENGTH} characters.`,
	NULL_BYTE: "Path contains NUL byte.",
	PERCENT_ENCODED: "Path contains percent-encoded octet; pass paths in their decoded form.",
	BACKSLASH: "Path contains backslash; use forward slashes.",
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
	const policyReason = classifyRelpathPolicy(input);
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
	const normalized = input.normalize("NFC");

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
	const relativePosix = sep === "/" ? rel : rel.split(sep).join("/");

	return {
		input,
		normalized,
		absolute: walked,
		relative: relativePosix,
	};
}

/**
 * Open a previously-validated absolute path with
 * `O_RDONLY | O_NOFOLLOW | O_NONBLOCK`. Returned `FileHandle` is the
 * caller's responsibility to close.
 *
 * Two protections layered:
 *   - `O_NOFOLLOW` refuses a final-component symlink swap that occurred
 *     between `validatePath` and the open (THREAT_MODEL V1/V6).
 *   - `O_NONBLOCK` ensures the open returns immediately for FIFOs / named
 *     pipes that have no writer attached. Without it, `open(O_RDONLY)`
 *     on a FIFO blocks indefinitely waiting for a writer — a trivial
 *     server-hang vector if a vault contains a FIFO. POSIX says
 *     `O_NONBLOCK` is unspecified-but-harmless on regular files, so
 *     normal note reads are unaffected. The caller is responsible for
 *     `fstat`-ing and rejecting non-regular files (see `readNote`).
 *
 * On platforms where `O_NOFOLLOW` is not supported (Windows / libuv
 * silently strips the flag), the protection degrades to "rejected
 * upstream by validatePath segment walk" — acceptable for v1 since
 * Windows is not a CI target.
 */
export async function openNoFollow(absolutePath: string): Promise<import("node:fs/promises").FileHandle> {
	return open(absolutePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function isENOENT(err: unknown): boolean {
	return getErrnoCode(err) === "ENOENT";
}
