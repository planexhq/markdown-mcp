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
