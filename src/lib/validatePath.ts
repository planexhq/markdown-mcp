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
import { errorMessage, vaultError } from "./error.js";
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
	let stat: Stats;
	try {
		stat = await lstat(trimmed);
	} catch (cause) {
		throw new PathValidationError(
			vaultError("PATH_OUTSIDE_VAULT", `Vault root not accessible: ${input}`, {
				param: "vault",
				reason: "VAULT_ROOT_INACCESSIBLE" satisfies PathRejectionReason,
				cause: errorMessage(cause),
			}),
		);
	}
	if (stat.isSymbolicLink()) {
		throw new PathValidationError(
			vaultError("PATH_OUTSIDE_VAULT", `Vault root is a symlink: ${input}`, {
				param: "vault",
				reason: "VAULT_ROOT_SYMLINK" satisfies PathRejectionReason,
			}),
		);
	}
	if (!stat.isDirectory()) {
		throw new PathValidationError(
			vaultError("PATH_OUTSIDE_VAULT", `Vault root is not a directory: ${input}`, {
				param: "vault",
				reason: "VAULT_ROOT_NOT_DIRECTORY" satisfies PathRejectionReason,
			}),
		);
	}
	return { absolute: await realpath(trimmed) };
}

/**
 * Validate a vault-relative path string. Throws
 * {@link PathValidationError} on every rejection condition; returns a
 * {@link SafePath} on success.
 *
 * The `vaultRoot.absolute` MUST be the realpath-resolved root (use
 * {@link validateVaultRoot}).
 */
export async function validatePath(input: string, vaultRoot: VaultRoot): Promise<SafePath> {
	rejectIf(input === "", "EMPTY_PATH", "Path is empty.");
	rejectIf(input.length > MAX_PATH_LENGTH, "PATH_TOO_LONG", `Path exceeds ${MAX_PATH_LENGTH} characters.`);
	rejectIf(input.includes("\x00"), "NULL_BYTE", "Path contains NUL byte.");
	rejectIf(
		PERCENT_ENCODED_RE.test(input),
		"PERCENT_ENCODED",
		"Path contains percent-encoded octet; pass paths in their decoded form.",
	);
	rejectIf(BACKSLASH_RE.test(input), "BACKSLASH", "Path contains backslash; use forward slashes.");
	rejectIf(isAbsolute(input), "ABSOLUTE_PATH", "Path is absolute; pass vault-relative paths.");

	// NFC normalize before any FS operation. macOS APFS lookups are
	// normalization-insensitive but we keep input form consistent for
	// containment checks. Do NOT also normalize realpath output —
	// containment compares against the FS-native form.
	const normalized = input.normalize("NFC");

	// Strip a leading "./" if present (common shorthand). Treat as empty
	// segment elsewhere — the split below ignores it.
	const cleaned = normalized.startsWith("./") ? normalized.slice(2) : normalized;
	const segments = cleaned.split("/").filter((s) => s.length > 0);

	rejectIf(segments.length === 0, "EMPTY_PATH", "Path is empty after normalization.");
	for (const seg of segments) {
		rejectIf(seg === "." || seg === "..", "TRAVERSAL_SEGMENT", `Path contains traversal segment: ${seg}`);
	}
	rejectIf(segments.length > MAX_PATH_DEPTH, "TOO_DEEP", `Path exceeds maximum depth of ${MAX_PATH_DEPTH} segments.`);

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
			if (isENOENT(cause) || isENOTDIR(cause)) {
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

	// Segment-aware: `startsWith("..")` falsely catches files literally
	// named `..draft.md` whose relative form is `..draft.md` (no separator).
	const rel = relative(vaultRoot.absolute, real);
	if (rel === "" || rel === ".." || rel.startsWith(PARENT_REL_PREFIX) || isAbsolute(rel)) {
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

function rejectIf(condition: boolean, reason: PathRejectionReason, message: string): void {
	if (condition) {
		throw new PathValidationError(
			vaultError("PATH_OUTSIDE_VAULT", message, {
				param: "file",
				reason,
			}),
		);
	}
}

function isENOENT(err: unknown): boolean {
	return typeof err === "object" && err !== null && "code" in err && (err as { code: unknown }).code === "ENOENT";
}

function isENOTDIR(err: unknown): boolean {
	return typeof err === "object" && err !== null && "code" in err && (err as { code: unknown }).code === "ENOTDIR";
}
