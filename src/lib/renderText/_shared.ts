/**
 * Shared helpers for the per-tool prose renderers in this directory.
 *
 * Opaque tokens (`stable_id`, `nextCursor`) are placed on dedicated
 * labeled lines so the LLM can echo them verbatim — the one reliability
 * edge JSON keeps over prose. `_meta` footer collapses to nothing when
 * all fields are at default; non-default values surface as a single
 * trailing `meta: ...` line.
 */

import type { MetaEnvelope } from "../../types.js";
import { CANDIDATE_LIST_SEP, CONTROL_CHAR_CLASS_PROSE, HEADING_PATH_SEP, NAMED_ESCAPES } from "../controlChars.js";
import { QUERY_ALGORITHM_ID } from "../search/sanitize.js";
import { BM25_SNIPPET_ALGORITHM_ID } from "../search/snippet.js";
import { TOKENIZER_HEURISTIC } from "../tokenizer.js";

// Round-trip-safe heading-path encoding (parser-side inverse:
// `normalizeHeadingPath` in `parser.ts`). Two escapes compose:
//
//   1. `\` → `\\`. Literal `\>` / `\›` in heading text would otherwise
//      render to the same bytes as a separator escape (`\>` / `\›`),
//      and the parser would strip the user's backslash. Doubling
//      distinguishes literal (`\\›`) from escape (`\›`).
//   2. `(?<=^|\s)[›>](?=\s|$)` → `\[›>]`. Two whitespace-context
//      sub-cases compose into one regex:
//      - INTERIOR: `["Cost › Benefit"]` and `["Cost", "Benefit"]` would
//        otherwise both render to `Cost › Benefit`.
//      - BOUNDARY: a separator at the start or end of a segment finds
//        its missing whitespace from the joining `" › "`, so
//        `["Cost ›", "Outer"]` would otherwise collide with
//        `["Cost", "Outer"]`. `^`/`$` close the boundary leak.
//      Lookbehind/lookahead are zero-width so adjacent separators
//      inside one segment (`["A > > B"]`) each match independently —
//      a consuming `(^|\s)...(\s|$)` would eat the shared trailing
//      space and miss the second `>`.
//      `OutgoingLink` carries `heading_path` but no `target_stable_id`,
//      so the rendered string IS the addressing.
//
// Order: backslash-escape MUST precede `sanitizePathForProse` so
// sanitize's own `\X` display escapes (`\n`/`\t`/…) are not doubled.
const HEADING_SEP_ESCAPE_RE = /(?<=^|\s)([›>])(?=\s|$)/g;
const HEADING_BACKSLASH_ESCAPE_RE = /\\/g;
function escapeBackslashes(seg: string): string {
	if (!seg.includes("\\")) return seg;
	return seg.replace(HEADING_BACKSLASH_ESCAPE_RE, "\\\\");
}
function escapeHeadingSeparator(seg: string): string {
	if (!seg.includes("›") && !seg.includes(">")) return seg;
	return seg.replace(HEADING_SEP_ESCAPE_RE, "\\$1");
}

// Per-segment encoder; `formatHeadingPath` maps over it.
export function formatHeadingSegment(seg: string): string {
	return escapeHeadingSeparator(sanitizePathForProse(escapeBackslashes(seg)));
}

export function formatHeadingPath(path: ReadonlyArray<string>): string {
	return path.map(formatHeadingSegment).join(HEADING_PATH_SEP);
}

/** `next: <opaque-base64>` on its own line, or null when no cursor. */
export function formatCursor(cursor: string | undefined): string | null {
	return cursor ? `next: ${cursor}` : null;
}

/**
 * Build the trailing `meta: ...` line from a `MetaEnvelope`. Returns
 * `null` when every field is at its default (warm state, heuristic
 * tokenizer, bm25 snippet, query-sanitize-v1, no `query_note` /
 * `fuzzy_algorithm`) so the renderer can omit the line entirely.
 *
 * The `_meta` envelope itself (sibling to `content` in the MCP
 * response) is unchanged regardless — this only controls whether the
 * prose channel surfaces the non-default fields.
 */
export function formatMeta(meta: MetaEnvelope): string | null {
	const parts: string[] = [];
	const status = meta.index_status;
	if (status.state !== "warm") {
		parts.push(`state=${status.state} files=${status.files_indexed}`);
	}
	if (meta.tokenizer !== undefined && meta.tokenizer !== TOKENIZER_HEURISTIC) {
		parts.push(`tokenizer=${meta.tokenizer}`);
	}
	if (meta.snippet_algorithm !== undefined && meta.snippet_algorithm !== BM25_SNIPPET_ALGORITHM_ID) {
		parts.push(`snippet=${meta.snippet_algorithm}`);
	}
	if (meta.query_algorithm !== undefined && meta.query_algorithm !== QUERY_ALGORITHM_ID) {
		parts.push(`query_algorithm=${meta.query_algorithm}`);
	}
	if (meta.query_note !== undefined) {
		parts.push(`query=${meta.query_note}`);
	}
	if (meta.fuzzy_algorithm !== undefined) {
		parts.push(`fuzzy=${meta.fuzzy_algorithm}`);
	}
	if (parts.length === 0) return null;
	return `meta: ${parts.join(" · ")}`;
}

// `\s` (ECMA-262) covers LineTerminator + WhiteSpace + Zs USP but
// NOT the non-whitespace C0, DEL, or C1 — U+0085 NEL especially
// renders as a newline in terminals + chat UIs that interpret it.
// Union with `CONTROL_CHAR_CLASS_PROSE` closes the gap; LS/PS are
// already in `\s` so the union effectively adds non-whitespace C0
// + DEL + C1.
const SINGLE_LINE_TEST_RE = new RegExp(`[\\s${CONTROL_CHAR_CLASS_PROSE}]`);
const SINGLE_LINE_COLLAPSE_RE = new RegExp(`[\\s${CONTROL_CHAR_CLASS_PROSE}]+`, "g");

/**
 * Normalize a snippet or link-text fragment for single-line inline
 * display. The source may contain embedded newlines if the chosen BM25
 * sentence spans one — flattening them keeps result lists scannable.
 * Runs of whitespace AND line-break control chars collapse to a single
 * space; leading/trailing whitespace stripped.
 */
export function singleLine(s: string): string {
	if (!SINGLE_LINE_TEST_RE.test(s)) return s;
	return s.replace(SINGLE_LINE_COLLAPSE_RE, " ").trim();
}

// Backslash MUST escape before `"` so a literal `\"` in the alias
// becomes `\\\"` (unambiguous boundary) instead of `\\"` (the wrapping
// `"..."` reads as closed-then-reopened).
const ALIAS_ESCAPE_TEST_RE = /["\\]/;
const ALIAS_BACKSLASH_RE = /\\/g;
const ALIAS_QUOTE_RE = /"/g;

/**
 * Quoted alias label `  "alias"` for prose rows, with embedded `"` and
 * `\` JSON-escaped. Returns `""` for an empty/missing alias.
 */
export function formatAliasLabel(alias: string | undefined | null): string {
	if (!alias || alias.length === 0) return "";
	const collapsed = singleLine(alias);
	const escaped = ALIAS_ESCAPE_TEST_RE.test(collapsed)
		? collapsed.replace(ALIAS_BACKSLASH_RE, "\\\\").replace(ALIAS_QUOTE_RE, '\\"')
		: collapsed;
	return `  "${escaped}"`;
}

// Split test vs. replace forms: a `/g` regex's `lastIndex` is stateful
// across `test` calls, so reusing one form for both would let a later
// `test` start scanning past a leading control char and miss it.
// Shared body kept in `lib/controlChars.ts` so the ingress regex in
// `validatePath.ts` can't drift out of sync.
const PROSE_CONTROL_RE_TEST = new RegExp(`[${CONTROL_CHAR_CLASS_PROSE}]`);
const PROSE_CONTROL_RE_REPLACE = new RegExp(`[${CONTROL_CHAR_CLASS_PROSE}]`, "g");
const PROSE_ESCAPE_TABLE: Record<string, string> = Object.fromEntries(
	NAMED_ESCAPES.map(([ch, kind]) => [ch, `\\${kind}`]),
);

/**
 * Escape control characters in a vault path before interpolating into
 * prose. POSIX filesystems admit `\n`/`\r`/`\t`/etc. in filenames; a
 * hostile vault with `foo\nnext: <forged-cursor>.md` would otherwise
 * emit a fake dedicated `next: …` line that LLM clients can read as a
 * pagination cursor. `classifyRelpathPolicy` now rejects these at
 * ingress, but pre-existing index rows (and defense-in-depth against
 * a future ingest regression) need the renderer-side escape too.
 *
 * `singleLine` collapses whitespace to a single space and so would
 * mangle the original filename — agents need a stable representation
 * they can map back, not destructive normalization.
 */
export function sanitizePathForProse(path: string): string {
	// `replace` doesn't short-circuit on no-match; the pre-test skips the
	// callback + allocation on every renderer row when nothing to escape.
	if (!PROSE_CONTROL_RE_TEST.test(path)) return path;
	return path.replace(PROSE_CONTROL_RE_REPLACE, (c) => {
		const named = PROSE_ESCAPE_TABLE[c];
		if (named !== undefined) return named;
		const code = c.charCodeAt(0);
		// `\xHH` is only unambiguous through U+00FF (2 hex digits). For
		// U+2028 / U+2029 (and any future > 0xFF members of the class)
		// emit `\uHHHH` so the escaped form can be read back unambiguously.
		if (code <= 0xff) return `\\x${code.toString(16).padStart(2, "0")}`;
		return `\\u${code.toString(16).padStart(4, "0")}`;
	});
}

/**
 * Render `${file} › ${heading_path}` for prose. Wraps in `«…»` when
 * the output contains a list-relevant separator (` › ` or `, `) so
 * structurally-different inputs can't render to byte-equal output —
 * `OutgoingLink` has no `target_stable_id` fallback; prose IS the
 * address. `validatePath:stripOuterGuillemets` is the inverse.
 *
 * The ` › ` trigger reads the ORIGINAL `filePath` so a control char
 * adjacent to the separator can't suppress the wrap.
 */
export function formatFileHeading(filePath: string, headingPath?: ReadonlyArray<string>): string {
	const encodedFile = sanitizePathForProse(filePath);
	const fileToken = filePath.includes(HEADING_PATH_SEP) ? `«${encodedFile}»` : encodedFile;
	const base =
		!headingPath || headingPath.length === 0
			? fileToken
			: `${fileToken}${HEADING_PATH_SEP}${formatHeadingPath(headingPath)}`;
	return base.includes(CANDIDATE_LIST_SEP) ? `«${base}»` : base;
}

/**
 * Body of a wikilink anchor — the `#` and surrounding whitespace
 * stripped so the result is directly usable as `heading_path[0]` /
 * `block.id`. Returns `""` for no `#`, empty (`note#`), or whitespace-
 * only (`note# `) fragments — all three parse as file-only links.
 */
export function extractAnchorBody(rawTarget: string): string {
	const hashIndex = rawTarget.indexOf("#");
	return hashIndex >= 0 ? rawTarget.slice(hashIndex + 1).trim() : "";
}

/**
 * Compact single-line display for an outgoing link or embed target.
 *
 *   resolved + heading?     → "target_file › H1 › H2"
 *   resolved + block?       → "target_file ^block_id"
 *   resolved + dup heading  → "target_file › H  (ambiguous: N candidates: a.md, b.md)"
 *   resolved + bad anchor   → "target_file  (anchor not found in raw_target: #Missing)"
 *   unresolved + 0/1 cand   → "raw_target  (unresolved)"
 *   unresolved + N cands    → "raw_target  (ambiguous: a/foo.md, b/foo.md, c/foo.md)"
 *
 * Every candidate is inlined — the structured-channel `candidates[]`
 * is the source of truth and prose mirrors it. Pathological vaults
 * with high same-basename ambiguity pay linear prose growth but every
 * option remains addressable for content-only clients.
 */
function formatCandidateList(candidates: ReadonlyArray<{ file: string; heading_path?: string[] }>): string {
	return candidates.map((c) => formatFileHeading(c.file, c.heading_path)).join(CANDIDATE_LIST_SEP);
}

export function formatOutgoingTarget(link: {
	raw_target: string;
	target_file?: string | undefined;
	target_heading_path?: string[] | undefined;
	target_block_id?: string | undefined;
	resolved: boolean;
	duplicate_heading?: boolean | undefined;
	candidates?: ReadonlyArray<{ file: string; heading_path?: string[] }> | undefined;
}): string {
	if (!link.resolved || !link.target_file) {
		// `raw_target` may carry control chars only via a hostile-source
		// vault — sanitize on the unresolved branches where we actually
		// surface it. Resolved branches use `target_file` instead.
		const rawTarget = sanitizePathForProse(link.raw_target);
		if (link.candidates && link.candidates.length > 1) {
			return `${rawTarget}  (ambiguous: ${formatCandidateList(link.candidates)})`;
		}
		return `${rawTarget}  (unresolved)`;
	}
	let out = formatFileHeading(link.target_file, link.target_heading_path);
	if (link.target_block_id) {
		// `parseTarget` (wikilinks.ts) takes `fragment.slice(1).trim()`
		// with no `[a-zA-Z0-9_-]+` validation — v1 design (wikilinks.ts
		// `resolveWikilink` doc) trusts the agent's wikilink. A hostile
		// vault containing `[[t#^id\u0085forged-label]]` would otherwise
		// emit a forged labeled line on the prose channel.
		out += ` ^${sanitizePathForProse(link.target_block_id)}`;
	}
	if (link.duplicate_heading) {
		out +=
			link.candidates && link.candidates.length > 0
				? `  (ambiguous: ${link.candidates.length} candidates: ${formatCandidateList(link.candidates)})`
				: "  (duplicate heading)";
	} else if (!link.target_heading_path && !link.target_block_id) {
		// Surface the unresolved anchor so the agent doesn't read the bare
		// `target_file` as exact. Empty/whitespace fragments aren't broken
		// anchors — they parse as legitimate file-only links — so skip.
		const anchorBody = extractAnchorBody(link.raw_target);
		if (anchorBody.length > 0) {
			out += `  (anchor not found in raw_target: #${sanitizePathForProse(anchorBody)})`;
		}
	}
	return out;
}

/**
 * Compact single-line display for an incoming link's source.
 *
 *   "source_file › H1 › H2"   (when source_heading_path set)
 *   "source_file"             (file-level link)
 */
export function formatIncomingSource(source: { source_file: string; source_heading_path?: string[] }): string {
	return formatFileHeading(source.source_file, source.source_heading_path);
}

/**
 * Join an array of lines, omitting only `null` / `undefined` entries.
 * Empty strings are preserved so callers can use them as intentional
 * blank-line separators between sections; truly-optional sections
 * should pass `null` (e.g. via `formatCursor` / `formatMeta` returning
 * null when there's nothing to surface).
 */
export function joinLines(lines: ReadonlyArray<string | null | undefined>): string {
	return lines.filter((x): x is string => typeof x === "string").join("\n");
}
