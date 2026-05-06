/**
 * Hidden-path predicate — single source of truth for "is this path
 * dot-prefixed and therefore policy-excluded by default."
 *
 * Brief line 928 + CLAUDE.md round 6: hidden files (`.obsidian/`, `.git/`,
 * `.DS_Store`, etc.) are excluded from every direct-read surface by default.
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
		// `.` and `..` are already rejected by `validatePath` as
		// TRAVERSAL_SEGMENT, but the `seg.length > 1` guard is defensive
		// and would correctly classify a literal single-`.` segment as
		// non-hidden anyway.
		if (seg.length > 1 && seg.startsWith(".")) return true;
	}
	return false;
}
