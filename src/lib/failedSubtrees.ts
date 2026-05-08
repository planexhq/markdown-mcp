/**
 * Shared predicate for the readdir-errno partition: subtrees whose
 * enumeration failed with a non-deletion errno (EACCES, EMFILE, EIO,
 * …) are tracked so the prune pass leaves their rows alone. Both the
 * vault scanner (cold/warm scan) and the periodic reconciler use it.
 *
 * The empty string represents the vault root — `walkVault` / `walkVaultMarkdown`
 * stamp it when readdir on the root itself fails, and this predicate
 * short-circuits to true so the prune pass becomes a no-op.
 */
export function isUnderFailedSubtree(file: string, failedSubtrees: ReadonlySet<string>): boolean {
	if (failedSubtrees.size === 0) return false;
	if (failedSubtrees.has("")) return true;
	for (const prefix of failedSubtrees) {
		if (file === prefix || file.startsWith(`${prefix}/`)) return true;
	}
	return false;
}
