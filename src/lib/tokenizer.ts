/**
 * Content-aware heuristic tokenizer. Default backend per Brief lines
 * 795–817. Pluggable via the `VAULT_TOKENIZER` env var (`tiktoken/...`,
 * `anthropic/count_tokens_api`) — only the heuristic is implemented in
 * W2; other IDs throw rather than silently fall back to the heuristic
 * because that would produce wrong-but-confident token counts.
 *
 * Divisors per Brief lines 797–803:
 *   - 3.5 chars/token for English prose (default)
 *   - 2.7 chars/token for code-heavy sections (>30% code-fence chars)
 *   - 1.5 chars/token for CJK-heavy sections (>30% CJK chars)
 *
 * "Chars" = Unicode codepoints (not UTF-16 code units), so a section
 * dominated by CJK Extension B (surrogate pairs) is still classified
 * correctly. The CJK detector itself is BMP-only because non-BMP CJK is
 * rare enough that its absence from the count doesn't shift a 30%
 * boundary in practice.
 *
 * Field naming MUST be `*Approx` per D11 — load-bearing honesty signal.
 * Calling code that produces token counts is responsible for using the
 * `Approx` suffix in its public field names; this module just returns
 * numbers.
 */

import { isWhitespaceRange } from "./blockIds.js";

/** Algorithm-id for the heuristic. Internal-versioning convention `<name>-v<N>` per Brief line 815. */
export const TOKENIZER_HEURISTIC = "heuristic/content-aware-v1" as const;

/**
 * Resolve the active tokenizer id. Reads `VAULT_TOKENIZER` once per call
 * (so tests can mutate the env var between calls without re-importing).
 */
export function getTokenizerId(): string {
	const env = process.env.VAULT_TOKENIZER;
	return env && env.length > 0 ? env : TOKENIZER_HEURISTIC;
}

/**
 * Estimate token count for `text` using the active tokenizer (or the one
 * supplied in `tokenizerId`). Throws on unsupported tokenizer ids — W2
 * ships only the heuristic; gpt-tokenizer and the Anthropic count_tokens
 * API are deferred to later weeks.
 */
export function estimateTokens(text: string, tokenizerId: string = getTokenizerId()): number {
	if (tokenizerId !== TOKENIZER_HEURISTIC) {
		throw new Error(`Tokenizer "${tokenizerId}" is not yet supported. W2 ships only "${TOKENIZER_HEURISTIC}".`);
	}
	return estimateHeuristic(text);
}

// CommonMark §4.5 allows tilde fences (`~~~`) as well as backticks. The
// backreference forces the closing fence to be the same type as the opener,
// so a stray `~~~` inside backtick-fenced text doesn't terminate the match.
const CODE_FENCE_RE = /(`{3,}|~{3,})[\s\S]*?\1/g;

const PROSE_DIVISOR = 3.5;
const CODE_DIVISOR = 2.7;
const CJK_DIVISOR = 1.5;
const CONTENT_KIND_THRESHOLD = 0.3;

function estimateHeuristic(text: string): number {
	// Whitespace-only slices are common: empty heading bodies (between
	// `# H\n` and `## Child\n` the body is just `\n\n`). Return 0 so empty
	// sections report `bodyTokensApprox: 0`; the non-empty minimum below
	// would otherwise round to a phantom 1, breaking token budgeting.
	if (isWhitespaceRange(text)) return 0;
	const { codepoints, cjk } = countCodepointsAndCJK(text);
	const codeFenceRatio = countCodeFenceChars(text) / codepoints;
	const cjkRatio = cjk / codepoints;
	const divisor =
		codeFenceRatio > CONTENT_KIND_THRESHOLD
			? CODE_DIVISOR
			: cjkRatio > CONTENT_KIND_THRESHOLD
				? CJK_DIVISOR
				: PROSE_DIVISOR;
	return Math.max(1, Math.round(codepoints / divisor));
}

function countCodepointsAndCJK(text: string): { codepoints: number; cjk: number } {
	// Single-pass `charCodeAt` — `for...of` allocates per codepoint and
	// `text.match(/.../g)` allocates per matched char (hundreds of MB transient
	// near the 10 MB cap on CJK-heavy files). Non-BMP CJK is uncounted per
	// file header.
	let codepoints = 0;
	let cjk = 0;
	for (let i = 0; i < text.length; i++) {
		const c = text.charCodeAt(i);
		if (c >= 0xd800 && c <= 0xdbff) {
			codepoints++;
			i++;
			continue;
		}
		codepoints++;
		if (
			(c >= 0x4e00 && c <= 0x9fff) || // CJK Unified Ideographs
			(c >= 0x3040 && c <= 0x309f) || // Hiragana
			(c >= 0x30a0 && c <= 0x30ff) || // Katakana
			(c >= 0xac00 && c <= 0xd7af) || // Hangul Syllables
			(c >= 0x3400 && c <= 0x4dbf) || // CJK Unified Ideographs Ext A
			(c >= 0x3000 && c <= 0x303f) || // CJK Symbols and Punctuation
			(c >= 0xff00 && c <= 0xffef) //   Halfwidth + Fullwidth Forms
		) {
			cjk++;
		}
	}
	return { codepoints, cjk };
}

function countCodeFenceChars(text: string): number {
	// `length` (UTF-16 code units) is a fine proxy for codepoint count inside
	// fenced code blocks — non-BMP codepoints are extremely rare in code, and
	// the heuristic only needs the >30% threshold, not exact counts.
	let total = 0;
	for (const match of text.matchAll(CODE_FENCE_RE)) {
		total += match[0].length;
	}
	return total;
}
