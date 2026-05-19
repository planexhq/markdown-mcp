/**
 * `structural_path` builder + `stable_id` hash per D27 + D20.
 *
 * D27 hash input: `relpath + ":" + structural_path`, where
 * `structural_path = "h{L1}[i1]/h{L2}[i2]/.../h{Ln}[in]"` — the heading's
 * full ancestor chain of (level, sibling-index) pairs. Sibling index is
 * 1-based, scoped to a parent's children at THAT level.
 *
 * Counter-example D27 fixes: under the pre-D27 `occurrence_index_at_level`
 * formula, the second H2 under the first H1 and the first H2 under the
 * second H1 both had sibling-index 1 → identical hashes → collision. The
 * full ancestor chain is unique by construction.
 *
 * D20 + Brief line 77: hash is SHA-1 of the input string, encoded hex,
 * truncated to 14 characters (56 bits → ~0.0007% collision at 1M
 * headings). Prefixed `h:` to distinguish from `t:` tree-item IDs (D25).
 *
 * Renaming a heading does NOT invalidate its `stable_id` — text doesn't
 * enter the hash. Only structural moves do (reorder siblings, change
 * level, move under different parent). Recovery for stale IDs lands in
 * W3 via `heading_history` + `stable-id-fuzzy-v1` (D32).
 */

import { createHash } from "node:crypto";

import type { HeadingLevel } from "../types.js";

export interface StructuralAncestor {
	level: HeadingLevel;
	/** 1-based index among siblings at THIS level under the same parent. */
	siblingIndex: number;
}

/**
 * Build the `structural_path` segment for a heading. Empty array → empty
 * string (top-level virtual-root walk shouldn't pass an empty chain in
 * practice; included for safety).
 */
export function buildStructuralPath(ancestors: ReadonlyArray<StructuralAncestor>): string {
	let out = "";
	for (let i = 0; i < ancestors.length; i++) {
		const a = ancestors[i];
		// `noUncheckedIndexedAccess`: index access is `T | undefined`.
		// Skip is impossible here (loop bounds), so assert presence with
		// `!` after the runtime guard so tsc accepts it.
		if (!a) continue;
		if (i > 0) out += "/";
		out += `h${a.level}[${a.siblingIndex}]`;
	}
	return out;
}

/**
 * Compute the `stable_id` for a heading per D27 + D20.
 *
 * `relpath` MUST be the vault-relative path with forward slashes (the same
 * form `validatePath` returns as `SafePath.relative`); `structuralPath`
 * MUST be the output of {@link buildStructuralPath} for the heading's
 * ancestor chain.
 */
export function stableId(relpath: string, structuralPath: string): string {
	return `h:${sha1HexN(`${relpath}:${structuralPath}`, 14)}`;
}

/**
 * Truncated sha1 hex digest. Shared spine for the three vault hash IDs:
 * heading `stable_id` (n=14, `h:` prefix, D27), tree-item id (n=14, `t:`
 * prefix, D25), and OpenAPI operation slot (n=14, embedded in
 * `structural_path` per D44). `n` is the hex-character length, NOT bytes —
 * sha1's full output is 40 hex chars / 20 bytes.
 */
export function sha1HexN(input: string, n: number): string {
	return createHash("sha1").update(input).digest("hex").slice(0, n);
}
