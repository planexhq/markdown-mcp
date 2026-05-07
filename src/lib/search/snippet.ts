/**
 * `bm25-fragment-v1` (D19) and `filter-preview-v1` (D33 Note) snippet
 * builders.
 *
 * Query mode (`bm25-fragment-v1`):
 *   1. Find all body word ranges via `Intl.Segmenter("en", {granularity:
 *      "word"})`; stem each `isWordLike` token via `porterStem` and
 *      check membership in the (also-stemmed) query terms set.
 *   2. Walk sentence segments. The "best sentence" is the one with the
 *      highest match-count; ties resolve to the first by source offset.
 *   3. If best sentence ≤ 200 chars, slice it whole. Else slide a
 *      200-char window centered on the densest match cluster, snapping
 *      window boundaries to word starts/ends.
 *   4. Wrap matches with `**term**` (right-to-left splice — preserves
 *      offsets for later writes). Match-inside-bold yields
 *      `****term****` per D19 (we don't strip pre-existing `**`).
 *   5. Hard cap 220 chars (cut at the next prior word boundary).
 *   6. Zero matches in body AND code → first 200 chars of body, no
 *      highlights.
 *
 * Both `body` and `code` are accepted because the FTS5 schema indexes
 * them as separate columns (D18 weights body=2.0, code=0.5). A query
 * that hits only the `code` column on a code-heavy section (e.g.
 * `npm install vault-mcp`) would otherwise produce an empty / heading-
 * only snippet because `extractFtsTexts` strips code from `body`. Body
 * is preferred when it carries any matches (mirrors the BM25 weight
 * preference); fall through to `code` only when body is term-empty.
 *
 * Filter mode (`filter-preview-v1`): strip leading whitespace, take
 * first 200 chars (220 hard cap, word-snapped), no highlights. Empty
 * body falls through to `code` so code-only sections still get a
 * preview instead of `""`.
 */

import { porterStem } from "./porter.js";

export const SNIPPET_BUDGET = 200;
export const SNIPPET_HARD_CAP = 220;

export const BM25_SNIPPET_ALGORITHM_ID = "bm25-fragment-v1";
export const FILTER_PREVIEW_ALGORITHM_ID = "filter-preview-v1";

// Per-page rendering can call snippet helpers up to `pageSize` times;
// each call previously instantiated 3–5 segmenters. Cache singletons.
const WORD_SEGMENTER = new Intl.Segmenter("en", { granularity: "word" });
const SENTENCE_SEGMENTER = new Intl.Segmenter("en", { granularity: "sentence" });

interface MatchRange {
	start: number;
	end: number;
}

export interface StemmedTerms {
	exact: ReadonlySet<string>;
	prefixes: ReadonlyArray<string>;
}

export const EMPTY_STEMMED_TERMS: StemmedTerms = Object.freeze({ exact: new Set<string>(), prefixes: [] });

/**
 * Build a BM25-style snippet: highest-match sentence (or 200-char
 * window centered on densest cluster) with `**term**` highlights.
 * Prefers `body`; falls through to `code` only when body has no
 * stemmed term match. `terms` accepts a raw token array (each call
 * stems it) or a pre-stemmed `StemmedTerms` (callers paginating
 * many rows should pre-stem once via `stemTerms` and reuse).
 */
export function buildBm25Snippet(args: {
	body: string;
	code: string;
	terms: ReadonlyArray<string> | StemmedTerms;
}): string {
	const { body, code, terms } = args;
	const stemmedTerms = isStemmedTerms(terms) ? terms : stemTerms(terms);

	const bodyResult = snippetForText(body, stemmedTerms);
	if (bodyResult.matched) return bodyResult.text;

	const codeResult = snippetForText(code, stemmedTerms);
	if (codeResult.matched) return codeResult.text;

	// Heading-only hit: degraded body preview, falling through to code
	// when body is empty (`snippetForText` returns "" for empty input).
	return body.length > 0 ? bodyResult.text : codeResult.text;
}

/**
 * Build a filter-only-mode snippet: leading whitespace stripped, first
 * ~200 chars (220 hard cap, word-snapped), no highlights. Falls
 * through to `code` when `body` is empty / whitespace-only.
 */
export function buildFilterPreview(args: { body: string; code: string }): string {
	const bodyTrimmed = args.body.trimStart();
	if (bodyTrimmed.length > 0) return wordTrim(bodyTrimmed, SNIPPET_BUDGET, SNIPPET_HARD_CAP);
	const codeTrimmed = args.code.trimStart();
	if (codeTrimmed.length > 0) return wordTrim(codeTrimmed, SNIPPET_BUDGET, SNIPPET_HARD_CAP);
	return "";
}

interface SnippetResult {
	text: string;
	matched: boolean;
}

function isStemmedTerms(t: ReadonlyArray<string> | StemmedTerms): t is StemmedTerms {
	return !Array.isArray(t);
}

/**
 * Split terms into exact-match stems and prefix-match stems. Tokens
 * ending in `*` came from `query-sanitize-v1`'s prefix path and must
 * highlight any body word whose stem starts with the marker's stem.
 * Stemming the prefix mirrors FTS5's porter tokenizer applying to both
 * sides at match time — `editing*` and `edit*` are equivalent in FTS,
 * so the snippet must agree.
 */
export function stemTerms(terms: ReadonlyArray<string>): StemmedTerms {
	const exact = new Set<string>();
	const prefixes: string[] = [];
	for (const t of terms) {
		const isPrefix = t.endsWith("*") && t.length > 1;
		const word = isPrefix ? t.slice(0, -1) : t;
		const stem = porterStem(word.toLowerCase());
		if (stem.length === 0) continue;
		if (isPrefix) prefixes.push(stem);
		else exact.add(stem);
	}
	return { exact, prefixes };
}

function snippetForText(text: string, stemmedTerms: StemmedTerms): SnippetResult {
	if (text.length === 0) return { text: "", matched: false };
	if (stemmedTerms.exact.size === 0 && stemmedTerms.prefixes.length === 0) {
		return { text: wordTrim(text, SNIPPET_BUDGET, SNIPPET_HARD_CAP), matched: false };
	}
	const matches = findMatches(text, stemmedTerms);
	if (matches.length === 0) return { text: wordTrim(text, SNIPPET_BUDGET, SNIPPET_HARD_CAP), matched: false };
	const slice = pickWindow(text, matches);
	const sliceText = text.slice(slice.start, slice.end);
	const sliceMatches = matches
		.filter((m) => m.start >= slice.start && m.end <= slice.end)
		.map((m) => ({ start: m.start - slice.start, end: m.end - slice.start }));
	const highlighted = applyHighlights(sliceText, sliceMatches);
	return { text: wordTrim(highlighted, SNIPPET_HARD_CAP, SNIPPET_HARD_CAP), matched: true };
}

// ─── Internals ─────────────────────────────────────────────────────────

function findMatches(body: string, stemmedTerms: StemmedTerms): MatchRange[] {
	const segmenter = WORD_SEGMENTER;
	const out: MatchRange[] = [];
	const { exact, prefixes } = stemmedTerms;
	const prefixCount = prefixes.length;
	for (const seg of segmenter.segment(body)) {
		if (!seg.isWordLike) continue;
		const stem = porterStem(seg.segment.toLowerCase());
		if (stem.length === 0) continue;
		// Hot path: per-page word counts × `prefixes.some` would allocate
		// a closure per word. Plain index loop avoids that; the early
		// `prefixCount === 0` skip covers the common no-prefix-query case.
		let hit = exact.has(stem);
		if (!hit && prefixCount > 0) {
			for (let i = 0; i < prefixCount; i++) {
				if (stem.startsWith(prefixes[i] as string)) {
					hit = true;
					break;
				}
			}
		}
		if (hit) out.push({ start: seg.index, end: seg.index + seg.segment.length });
	}
	return out;
}

interface Slice {
	start: number;
	end: number;
}

function pickWindow(body: string, matches: ReadonlyArray<MatchRange>): Slice {
	const sentence = pickBestSentence(body, matches);
	if (sentence.end - sentence.start <= SNIPPET_BUDGET) return sentence;

	// Densest cluster: pick the contiguous sub-range of `matches` whose
	// span fits within the budget AND contains the most matches; center
	// the window on that span. Snap to word boundaries.
	const sentenceMatches = matches.filter((m) => m.start >= sentence.start && m.end <= sentence.end);
	const cluster = densestCluster(sentenceMatches, SNIPPET_BUDGET);
	if (cluster === null) {
		// Fallback: simple budget slice from sentence start.
		const end = Math.min(sentence.end, sentence.start + SNIPPET_BUDGET);
		return { start: snapToWordStart(body, sentence.start), end: snapToWordEnd(body, end) };
	}

	// Center the window on the cluster; clamp to sentence bounds; snap to word.
	const center = (cluster.firstStart + cluster.lastEnd) / 2;
	let start = Math.max(sentence.start, Math.round(center - SNIPPET_BUDGET / 2));
	let end = start + SNIPPET_BUDGET;
	if (end > sentence.end) {
		end = sentence.end;
		start = Math.max(sentence.start, end - SNIPPET_BUDGET);
	}
	start = snapToWordStart(body, start);
	end = snapToWordEnd(body, Math.min(end, body.length));
	return { start, end };
}

function pickBestSentence(body: string, matches: ReadonlyArray<MatchRange>): Slice {
	const segmenter = SENTENCE_SEGMENTER;
	let bestStart = 0;
	let bestEnd = 0;
	let bestCount = -1;
	for (const seg of segmenter.segment(body)) {
		const start = seg.index;
		const end = start + seg.segment.length;
		let count = 0;
		for (const m of matches) {
			if (m.start >= start && m.end <= end) count++;
		}
		if (count > bestCount) {
			bestCount = count;
			bestStart = start;
			bestEnd = end;
		}
	}
	return { start: bestStart, end: bestEnd };
}

interface ClusterInfo {
	firstStart: number;
	lastEnd: number;
	count: number;
}

function densestCluster(matches: ReadonlyArray<MatchRange>, budget: number): ClusterInfo | null {
	if (matches.length === 0) return null;
	let best: ClusterInfo | null = null;
	for (let i = 0; i < matches.length; i++) {
		const start = matches[i]?.start;
		if (start === undefined) continue;
		let count = 0;
		let end = start;
		for (let j = i; j < matches.length; j++) {
			const m = matches[j];
			if (m === undefined) continue;
			if (m.end - start > budget) break;
			count++;
			end = m.end;
		}
		if (best === null || count > best.count) {
			best = { firstStart: start, lastEnd: end, count };
		}
	}
	return best;
}

function applyHighlights(text: string, matches: ReadonlyArray<MatchRange>): string {
	if (matches.length === 0) return text;
	// Right-to-left splice keeps offsets stable for the next write.
	const sorted = [...matches].sort((a, b) => b.start - a.start);
	let out = text;
	for (const m of sorted) {
		if (m.start < 0 || m.end > out.length || m.start >= m.end) continue;
		out = `${out.slice(0, m.start)}**${out.slice(m.start, m.end)}**${out.slice(m.end)}`;
	}
	return out;
}

/**
 * Trim `s` to ≤ `budget` chars at the nearest preceding word
 * boundary, then enforce a hard cap. Used for filter previews and the
 * fallback "first 200 chars" path.
 */
function wordTrim(s: string, budget: number, cap: number): string {
	if (s.length <= budget) return s;
	const segmenter = WORD_SEGMENTER;
	let cut = budget;
	let lastBoundary = 0;
	for (const seg of segmenter.segment(s)) {
		if (seg.index >= budget) {
			cut = lastBoundary > 0 ? lastBoundary : seg.index;
			break;
		}
		lastBoundary = seg.index + seg.segment.length;
	}
	const trimmed = s.slice(0, cut).replace(/\s+$/, "");
	return trimmed.length > cap ? trimmed.slice(0, cap) : trimmed;
}

function snapToWordStart(body: string, offset: number): number {
	if (offset <= 0) return 0;
	const segmenter = WORD_SEGMENTER;
	let prev = 0;
	for (const seg of segmenter.segment(body)) {
		if (seg.index >= offset) return prev;
		if (seg.isWordLike) prev = seg.index;
	}
	return prev;
}

function snapToWordEnd(body: string, offset: number): number {
	if (offset >= body.length) return body.length;
	const segmenter = WORD_SEGMENTER;
	let last = offset;
	for (const seg of segmenter.segment(body)) {
		const segEnd = seg.index + seg.segment.length;
		if (seg.index > offset) return last;
		last = segEnd;
	}
	return Math.min(last, body.length);
}
