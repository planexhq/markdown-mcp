/**
 * Block-ID extractor — Obsidian-canonical syntax (`^[a-zA-Z0-9-]+`).
 *
 * Operates on raw source plus AST-derived offset ranges so it correctly
 * skips block IDs inside fenced code blocks and inline `code` spans.
 *
 * Recognized positions (Obsidian-canonical):
 *   1. Inline at end of paragraph/list item: `text content ^my-id`
 *   2. On its own line directly after a paragraph/list item:
 *
 *      Some paragraph
 *      ^my-id
 *
 *      In MDAST the lone `^my-id` parses as its OWN paragraph; the
 *      extractor detects this case (block content is exactly `^id`) and
 *      attributes the id to the PREVIOUS blockable node.
 *
 * Per Brief line 90: duplicate `^id` within a file resolves to the FIRST
 * occurrence — caller dedupes when building `blockIndex`. The flat
 * matches list returned here keeps every occurrence so the parser can
 * audit duplicates if it wants to (W2 doesn't surface that, but the API
 * stays open).
 *
 * Underscore is NOT permitted (Brief line 833: "underscores explicitly
 * rejected"); the regex enforces this.
 */

export interface BlockableNodeRange {
	/** Byte offset of the block (paragraph / listItem) start in source. */
	offsetStart: number;
	/** Byte offset of the block end (one past last char). */
	offsetEnd: number;
	/**
	 * Trailing edge for the trailing-only `^id` check. Equals `offsetEnd` for
	 * paragraphs; for listItems excludes nested sub-lists — mdast's listItem
	 * range covers the whole sub-tree, but `^id` validates only against the
	 * parent's text edge.
	 */
	trailingEdgeOffset: number;
	/** 1-based line number of the block's first line. */
	lineStart: number;
	/** 1-based line number of the block's last line. */
	lineEnd: number;
	/**
	 * True if the block's mdast position lay inside a blockquote node. Affects
	 * deferred-form `^id` adjacency: `>` markers between paragraphs and on the
	 * lone `^id` line aren't real content, so the whitespace checks must allow
	 * them when either endpoint is in a blockquote.
	 */
	inBlockquote: boolean;
}

export interface ExcludedRange {
	offsetStart: number;
	offsetEnd: number;
}

export interface BlockIdMatch {
	/** Block ID without the leading caret. */
	id: string;
	/** Range of the BLOCK this id refers to (NOT the `^id` token). */
	block: BlockableNodeRange;
}

// `(?<=^|\s)` — preceded by start-of-line (in multiline mode) or whitespace.
// `(?=\s|$)` — followed by whitespace or end-of-line/EOF.
// `m` flag makes `^` and `$` match line boundaries; the lookbehind's `^`
// is similarly anchored.
const BLOCK_ID_RE = /(?<=^|\s)\^([a-zA-Z0-9-]+)(?=\s|$)/gm;

/**
 * Find every block-id occurrence in `source` and associate it with the
 * blockable node it addresses. Excluded ranges (fenced code blocks,
 * inline code spans) suppress matches that fall within them.
 *
 * `blockableNodes` and `excludedRanges` need not be pre-sorted; this
 * function sorts internally. Inputs are treated as immutable.
 *
 * Trailing-only rule: per Obsidian-canonical syntax, an inline `^id` is
 * only valid at the END of a paragraph/list item. Mid-paragraph matches
 * (e.g. `Use ^alpha as notation here`) are rejected. The deferred form
 * (lone `^id` paragraph following a regular paragraph) trivially satisfies
 * trailing-only since the lone paragraph's content IS the match.
 */
export function extractBlockIds(
	source: string,
	blockableNodes: ReadonlyArray<BlockableNodeRange>,
	excludedRanges: ReadonlyArray<ExcludedRange>,
): BlockIdMatch[] {
	const sortedBlocks = [...blockableNodes].sort((a, b) => a.offsetStart - b.offsetStart);
	const sortedExcluded = [...excludedRanges].sort((a, b) => a.offsetStart - b.offsetStart);

	const out: BlockIdMatch[] = [];
	for (const match of source.matchAll(BLOCK_ID_RE)) {
		if (match.index === undefined) continue;
		const id = match[1];
		if (!id) continue;
		const caretOffset = match.index;
		if (isInsideAny(caretOffset, sortedExcluded)) continue;
		const containingIdx = findContainingBlockIndex(caretOffset, sortedBlocks);
		if (containingIdx < 0) continue;
		const containing = sortedBlocks[containingIdx];
		if (!containing) continue;
		const matchEndOffset = caretOffset + match[0].length;
		if (!isWhitespaceRange(source, matchEndOffset, containing.trailingEdgeOffset)) continue;
		// Deferred-form: a lone-line `^id` paragraph addresses the
		// IMMEDIATELY-PRECEDING blockable node. Detected structurally — the
		// match is the entire non-whitespace content of its containing
		// block — and only valid when an *adjacent* prior block exists
		// (whitespace-only gap between them). Anything else (note start,
		// after a heading, after a fenced code block, after HTML) is an
		// orphan: skip rather than silently emit a phantom or misattributed
		// entry.
		// `>` markers between blockquoted paragraphs (and on the lone `> ^id`
		// line itself) are notation, not content — allow them as adjacency
		// whitespace when either endpoint is in a blockquote.
		const isLoneLine = isWhitespaceRange(source, containing.offsetStart, caretOffset, containing.inBlockquote);
		let block: BlockableNodeRange = containing;
		if (isLoneLine) {
			const previous = containingIdx > 0 ? sortedBlocks[containingIdx - 1] : undefined;
			const allowMarker = containing.inBlockquote || (previous?.inBlockquote ?? false);
			if (previous && isWhitespaceRange(source, previous.offsetEnd, containing.offsetStart, allowMarker)) {
				block = previous;
			} else {
				continue;
			}
		}
		out.push({ id, block });
	}
	return out;
}

/**
 * `offset` falls inside any `[offsetStart, offsetEnd)` range. `ranges` MUST
 * be sorted ascending by `offsetStart`; the linear scan exits early at the
 * first range starting past `offset`. Reused by `getFragment` to filter
 * wikilink regex matches inside `code`/`inlineCode` AST ranges — same
 * exclusion semantics as block IDs.
 */
export function isInsideAny(offset: number, ranges: ReadonlyArray<ExcludedRange>): boolean {
	for (const r of ranges) {
		if (r.offsetStart > offset) return false;
		if (offset < r.offsetEnd) return true;
	}
	return false;
}

/**
 * `[start, end)` of `source` is whitespace-only (or empty). Defaults check
 * the whole string. Charcode-loop avoids `source.slice(...).trim()`
 * allocations on hot paths (block-ID extraction, tokenizer empty-body
 * detection, preamble emptiness check). ASCII whitespace only — matches
 * the markdown whitespace surface relevant to heading-body emptiness;
 * Unicode whitespace (NBSP etc.) is treated as content.
 *
 * `allowBlockquoteMarker`: when true, `>` is also accepted. Used by deferred-
 * form `^id` adjacency where mdast paragraph offsets DON'T cover the `> `
 * line prefix (pushRange walks offsetStart back to line start to preserve
 * the marker) and the separator line between two paragraphs in one
 * blockquote is `> ` itself — neither is real content for adjacency.
 */
export function isWhitespaceRange(
	source: string,
	start = 0,
	end: number = source.length,
	allowBlockquoteMarker = false,
): boolean {
	for (let i = start; i < end; i++) {
		const c = source.charCodeAt(i);
		// space, tab, CR, LF, FF, VT
		if (c === 32 || c === 9 || c === 10 || c === 13 || c === 12 || c === 11) continue;
		if (allowBlockquoteMarker && c === 62) continue;
		return false;
	}
	return true;
}

/**
 * Strip the trailing `^id` block-addressing marker from a raw source
 * slice. The `(?:^|[ \t])` prefix avoids matching `^2` in `Value x^2`
 * (no preceding whitespace, not a block ID per BLOCK_ID_RE) and
 * consuming the leading space avoids a dangling trailer before the
 * newline in nested-list cases.
 *
 * Strips the LAST `^id` occurrence (not the first). The marker is
 * always at the end of the original block per Obsidian spec, but embed
 * expansion can splice nested content into the slice that incidentally
 * contains literal `^id` text matching the parent's blockId. Per-line
 * regex matching with `/m` would strip the first such occurrence,
 * leaving the actual marker intact and corrupting the embedded text;
 * matching the last occurrence puts the strip back on the parent's own
 * marker since splices land before it.
 */
export function stripBlockIdMarker(raw: string, blockId: string): string {
	const trimRe = new RegExp(String.raw`(?:^|[ \t])\^${blockId}\s*$`, "gm");
	const matches = [...raw.matchAll(trimRe)];
	if (matches.length === 0) return raw.trimEnd();
	const last = matches[matches.length - 1];
	if (!last || last.index === undefined) return raw.trimEnd();
	const start = last.index;
	const end = start + last[0].length;
	return (raw.slice(0, start) + raw.slice(end)).trimEnd();
}

/**
 * Index of the deepest block in `sortedBlocks` whose offset range contains
 * `offset`. Returns -1 if none matches.
 */
function findContainingBlockIndex(offset: number, sortedBlocks: ReadonlyArray<BlockableNodeRange>): number {
	let containingIdx = -1;
	for (let i = 0; i < sortedBlocks.length; i++) {
		const b = sortedBlocks[i];
		if (!b) continue;
		if (b.offsetStart > offset) break;
		if (offset < b.offsetEnd) containingIdx = i;
	}
	return containingIdx;
}
