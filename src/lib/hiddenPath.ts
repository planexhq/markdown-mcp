/**
 * Hidden-path predicate — single source of truth for "is this path
 * dot-prefixed and therefore policy-excluded by default."
 *
 * Per Brief line 928, hidden files (`.obsidian/`, `.git/`, `.DS_Store`,
 * etc.) are excluded from every direct-read surface by default.
 * Direct calls return `PATH_NOT_FOUND` (the file *exists* on disk; it's
 * policy-excluded — distinguishing it from `PATH_OUTSIDE_VAULT` which is
 * reserved for traversal/security violations). The `--include-hidden` CLI
 * flag is the single global override (W5); when it lands, the call site
 * gates this predicate behind the flag instead of changing the predicate.
 *
 * Operates on the POSIX-slash relative form returned by `validatePath`.
 */
export function isHiddenPath(relpath: string): boolean {
	for (const seg of relpath.split("/")) {
		if (isHiddenName(seg)) return true;
	}
	return false;
}

/**
 * Per-segment hot-path predicate. Recursive walks vet parents on the way down,
 * so callers iterating one entry at a time can skip the per-call `split("/")`.
 * `.` and `..` are TRAVERSAL_SEGMENT-rejected by `validatePath`, but the
 * `length > 1` guard correctly classifies a literal single-`.` as non-hidden
 * anyway.
 */
export function isHiddenName(name: string): boolean {
	return name.length > 1 && name.startsWith(".");
}

/**
 * NFC-only ingest gate. validatePath NFC-normalizes incoming agent paths,
 * so an indexed/event-targeted NFD relpath would mismatch on Linux byte-
 * exact filesystems (and risk colliding rows if normalized blindly).
 * macOS APFS is normalization-insensitive — preventative there.
 */
export function isNonNfc(s: string): boolean {
	return s.normalize("NFC") !== s;
}

/**
 * Top-level directory name (under the vault root) where the server
 * stores its own SQLite cache + WAL/SHM siblings. Single source of
 * truth: callers compose the full DB path and the watcher / tree
 * exclusions from this constant so a future rename only touches one
 * place.
 */
export const INDEX_DIR_NAME = ".vault-mcp";

// Hoisted so chokidar's per-event `shouldIgnore` callback doesn't
// re-allocate a template literal on every fs event.
const INDEX_DIR_PREFIX = `${INDEX_DIR_NAME}/`;

/**
 * Result of the one-time FS case-sensitivity probe done at server
 * startup (see `fsDetect.ts`). `null` means the probe hasn't run yet,
 * which `isIndexCachePath` treats as case-insensitive — the safer
 * fallback (false positive on Linux rejects access to a niche user dir,
 * false negative on macOS would leak the SQLite cache).
 *
 * Per-process state is appropriate because the server serves exactly
 * one vault per process. vitest forks per file (default since v1.0),
 * so cross-file test pollution is impossible; within a file, tests that
 * need the case-sensitive branch call `setFsCaseInsensitive(false)` in
 * `beforeEach` and `resetFsCaseInsensitiveForTest()` in `afterEach`.
 */
let isFsCaseInsensitive: boolean | null = null;

export function setFsCaseInsensitive(value: boolean): void {
	isFsCaseInsensitive = value;
}

/** Visible for testing only — resets the module-level FS-detection flag. */
export function resetFsCaseInsensitiveForTest(): void {
	isFsCaseInsensitive = null;
}

/** Resolved FS verdict for SQL gates. Unset flag folds to `true` (see flag doc). */
export function isFsCaseInsensitiveResolved(): boolean {
	return isFsCaseInsensitive !== false;
}

/**
 * `true` for the server's own cache dir or anything beneath it. Used
 * by the watcher (don't reindex our own writes) and the tree (don't
 * leak server internals — and because `.vault-mcp` sorts before any
 * letter-named content, it would consume the first page on small
 * `pageSize` requests). Independent of `--include-hidden`: the cache
 * is a server artifact, never user content.
 *
 * Routing branches on FS case-sensitivity. Case-insensitive FS (macOS
 * APFS, Windows NTFS): `validatePath` preserves user-supplied casing
 * and `.Vault-MCP/...` aliases to the server's lowercase cache; fold
 * to lowercase before comparing or the variant slips past the gate
 * and the SQLite cache leaks. Case-sensitive FS (Linux ext4 / btrfs
 * default): `.Vault-MCP/` is a distinct inode and may be legitimate
 * user content; byte-wise compare preserves access. Unset flag falls
 * back to the case-insensitive branch (safer default — see fsDetect).
 *
 * `INDEX_DIR_NAME` is ASCII, so `toLowerCase` is byte-deterministic
 * and locale-safe (no Turkish dotless-i pitfall).
 */
export function isIndexCachePath(posixRelpath: string): boolean {
	if (!posixRelpath.startsWith(".")) return false;
	if (isFsCaseInsensitive === false) {
		return posixRelpath === INDEX_DIR_NAME || posixRelpath.startsWith(INDEX_DIR_PREFIX);
	}
	const lower = posixRelpath.toLowerCase();
	return lower === INDEX_DIR_NAME || lower.startsWith(INDEX_DIR_PREFIX);
}
