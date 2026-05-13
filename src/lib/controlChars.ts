/**
 * Shared "control character" class used by both
 * - `validatePath.ts` (ingress rejection): permanent-reject filenames
 *   carrying these so the indexer never sees them; and
 * - `renderText/_shared.ts` (defense-in-depth render-side escape):
 *   pre-existing index rows + a future ingest regression both still
 *   need the renderer-side escape.
 *
 * The two regexes differ only by their handling of NUL: the ingress
 * regex starts at `\x01` (NUL has its own NULL_BYTE rejection earlier
 * in `classifyRelpathPolicy`); the prose-side regex starts at `\x00`
 * because by the time a row reaches the renderer, a literal NUL is
 * an existing-rows leak that still needs escaping.
 *
 * Covers: DEL (U+007F), C1 controls (U+0080-U+009F, incl. U+0085
 * NEL), U+2028 LINE SEPARATOR, U+2029 PARAGRAPH SEPARATOR.
 * C0 (U+0001-U+001F or U+0000-U+001F) is supplied by the call site.
 */
export const CONTROL_CHAR_CLASS_TAIL = "\\x7F\\u0080-\\u009F\\u2028\\u2029";

/**
 * Prose-side composition: C0 (incl. NUL) + `CONTROL_CHAR_CLASS_TAIL`.
 * `_shared.ts`'s `PROSE_CONTROL_RE_*` + `SINGLE_LINE_COLLAPSE_RE` all
 * share this body; one constant prevents drift if a future control
 * char joins the tail. validatePath's ingress regex is intentionally
 * a different shape (`\x01-` prefix — NUL has its own rejection) so
 * it stays composed in place.
 */
export const CONTROL_CHAR_CLASS_PROSE = `\\x00-\\x1F${CONTROL_CHAR_CLASS_TAIL}`;

/**
 * Bidirectional named-escape contract between `sanitizePathForProse`
 * (encoder, `_shared.ts`) and `normalizeHeadingPath` (decoder,
 * `parser.ts`). Tuple form so a single source of truth feeds both
 * tables at module load — adding `["\v", "v"]` here updates both
 * sides atomically, no drift risk for round-trip integrity.
 */
export const NAMED_ESCAPES = [
	["\n", "n"],
	["\r", "r"],
	["\t", "t"],
] as const satisfies ReadonlyArray<readonly [char: string, kind: string]>;

/**
 * Used by `renderText/_shared.ts` (formatter) and `validatePath.ts`'s
 * `stripOuterGuillemets` (inverse strip). Lives here so the security
 * entry point doesn't import from a presentation-layer module.
 */
export const HEADING_PATH_SEP = " › ";

/**
 * Separator between candidate entries in `formatCandidateList`. Shared
 * with `formatFileHeading`'s wrap trigger and `stripOuterGuillemets`'s
 * inverse so the three rules agree on a single boundary substring.
 */
export const CANDIDATE_LIST_SEP = ", ";
