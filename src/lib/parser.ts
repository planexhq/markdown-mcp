/**
 * Markdown parser — single entry point that consumes raw source and emits
 * everything `get_file_outline`, `get_fragment`, and `get_metadata` need.
 *
 * Pipeline (D3): `unified` + `remark-parse` + `remark-frontmatter` +
 * `remark-gfm`. CommonMark-compliant with byte-offset position tracking;
 * GFM tables/strikethrough/task lists supported. YAML body parsed via the
 * `yaml` library — `remark-frontmatter` only delimits the block.
 *
 * Three logical passes (Brief lines 774–791 decision matrix):
 *   1. Frontmatter — first child of root if it's a `yaml` node.
 *   2. Outline — top-level `heading` nodes only; nested headings inside
 *      list items / blockquotes are explicitly excluded per the matrix.
 *      Sibling-index counter is per-parent per-level for D27's
 *      structural_path.
 *   3. Block IDs — regex scan of source with code-block exclusions, then
 *      each id mapped to its containing heading via offset binary search.
 *
 * Hard caps:
 *   - AST > 50K nodes → throws `ParseError("ast_node_cap_exceeded")`.
 *   - YAML parse failure → throws `ParseError("syntax")`.
 *   - File-size cap (10 MB) and encoding errors are caller concerns
 *     (`readNote.ts` enforces them; this module is pure source-in / data-out).
 */

import type { Heading, ListItem, Paragraph, Parent, Root, Yaml } from "mdast";
import { toString as mdastToString } from "mdast-util-to-string";
import remarkFrontmatter from "remark-frontmatter";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkParse from "remark-parse";
import { unified } from "unified";
import type { Node } from "unist";
import { visit } from "unist-util-visit";
import { parse as parseYAML } from "yaml";

import type { BlockIndexEntry, ContentKind, HeadingLevel, OutlineNode, Range } from "../types.js";
import {
	type BlockableNodeRange,
	type BlockIdMatch,
	type ExcludedRange,
	extractBlockIds,
	isInsideAny,
	isWhitespaceRange,
} from "./blockIds.js";
import { errorMessage } from "./error.js";
import { MAX_AST_NODES } from "./limits.js";
import { buildStructuralPath, type StructuralAncestor, stableId } from "./structuralPath.js";
import { estimateTokens } from "./tokenizer.js";

// ─── Public types ──────────────────────────────────────────────────────────

/** Inclusive byte-offset range in source string. */
export interface OffsetRange {
	start: number;
	end: number;
}

/**
 * Heading metadata enriched with everything needed to slice the section
 * source, look it up by stable_id, and serialize a `HeadingFragment`.
 */
export interface HeadingMeta {
	stable_id: string;
	structuralPath: string;
	level: HeadingLevel;
	/** Path-matchable text (inline formatting stripped, NFC-normalized). */
	pathText: string;
	/** Source-slice display text (inline formatting preserved). */
	displayText: string;
	/** GitHub-compatible slug for this heading. */
	slug: string;
	/** Ancestor chain INCLUDING this heading (path text per ancestor). */
	headingPath: string[];
	/** Section line range (inclusive) — heading line through last body line. */
	range: Range;
	/** Heading line range only. */
	selectionRange: Range;
	/** Section byte offsets (heading line start → just past last body byte). */
	offsetRange: OffsetRange;
	/** Heading line byte offsets only. */
	headingLineOffset: OffsetRange;
	/** Immediate body offsets (heading-line-end → first child start, or section end). */
	bodyOffsetRange: OffsetRange;
	bodyTokensApprox: number;
	descendantTokensApprox: number;
	subheadings: number;
	contentKinds: ContentKind[];
	blockIds: string[];
}

/** Block-ID metadata. */
export interface BlockMeta {
	id: string;
	range: Range;
	offsetRange: OffsetRange;
	containingHeadingPath: string[];
	containingStableId: string | null;
}

/** Output of `parseFile`. */
export interface ParsedFile {
	/** Vault-relative path with forward slashes — same form the stable_id hash consumed. */
	relpath: string;
	source: string;
	hasFrontmatter: boolean;
	frontmatter: Record<string, unknown> | null;
	/**
	 * Byte offset of the first character after the frontmatter block (or 0
	 * if `hasFrontmatter` is false). Authoritative source for "where does
	 * the body start" — `buildFileFragment` reads this so frontmatter-only
	 * notes don't accidentally emit YAML in `anchor: {kind: "file"}`.
	 */
	frontmatterEndOffset: number;
	outline: OutlineNode[];
	blockIndex: Record<string, BlockIndexEntry>;
	headings: HeadingMeta[];
	blocks: BlockMeta[];
	preamble: { range: Range; offsetRange: OffsetRange; contentKinds: ContentKind[] } | null;
	/**
	 * Source offsets of `code`/`inlineCode`/`math`/`inlineMath` AST nodes,
	 * ascending. Wikilinks and block-IDs inside these ranges are notation,
	 * not graph edges (Obsidian doesn't resolve them); fragment builders
	 * skip regex matches that fall here. Same ranges feed `extractBlockIds`.
	 */
	excludedRanges: ExcludedRange[];
}

/**
 * Reasons a parse can fail. Routed by the tool handlers to the
 * `MARKDOWN_PARSE_ERROR.reason` enum (Brief — `MARKDOWN_PARSE_ERROR` table
 * + CLAUDE.md "Hard-cap routing").
 */
export type ParseErrorReason = "syntax" | "ast_node_cap_exceeded" | "encoding_failed";

export class ParseError extends Error {
	override readonly name = "ParseError";
	readonly reason: ParseErrorReason;
	readonly line?: number;
	readonly column?: number;
	constructor(reason: ParseErrorReason, message: string, line?: number, column?: number) {
		super(message);
		this.reason = reason;
		if (line !== undefined) this.line = line;
		if (column !== undefined) this.column = column;
	}
}

// ─── Pipeline ──────────────────────────────────────────────────────────────

// `remarkMath` parses `$inline$` and `$$display$$` into `inlineMath` / `math`
// mdast nodes (Obsidian-compatible). Without it, `$...$` stays plain text and
// the public `contentKinds: "math"` value (Brief lines 52, 84) is unreachable.
const PROCESSOR = unified().use(remarkParse).use(remarkFrontmatter, ["yaml"]).use(remarkGfm).use(remarkMath);

export interface ParseFileOptions {
	/** Override the AST node cap. Used by tests; production code should rely on `MAX_AST_NODES`. */
	maxAstNodes?: number;
	/**
	 * Skip outline / token / block work — return only frontmatter and source-level
	 * fields. Used by `get_metadata` so an unsupported tokenizer
	 * (`VAULT_TOKENIZER=tiktoken/...`, accepted by the selector but throws on use)
	 * doesn't INTERNAL_ERROR a frontmatter-only read.
	 */
	frontmatterOnly?: boolean;
}

/**
 * Parse `source` into a {@link ParsedFile}. `relpath` is the vault-relative
 * path used in the `stable_id` hash input (D27); pass exactly the
 * `SafePath.relative` form so IDs stay stable across calls.
 */
export function parseFile(source: string, relpath: string, options: ParseFileOptions = {}): ParsedFile {
	if (options.frontmatterOnly) {
		// Skip remark-parse entirely. `get_metadata` is the only frontmatterOnly
		// caller and reads only `frontmatter`/`hasFrontmatter`; running the full
		// markdown parser on a multi-MB body wastes hundreds of ms and risks a
		// spurious `ast_node_cap_exceeded` despite us never inspecting the body.
		const fm = extractFrontmatterFromSource(source);
		return {
			relpath,
			source,
			hasFrontmatter: fm.hasFrontmatter,
			frontmatter: fm.frontmatter,
			frontmatterEndOffset: fm.frontmatterEndOffset,
			outline: [],
			blockIndex: {},
			headings: [],
			blocks: [],
			preamble: null,
			excludedRanges: [],
		} satisfies ParsedFile;
	}

	const tree = PROCESSOR.parse(source) as Root;
	const cap = options.maxAstNodes ?? MAX_AST_NODES;

	let nodeCount = 0;
	visit(tree, () => {
		nodeCount++;
	});
	if (nodeCount > cap) {
		throw new ParseError(
			"ast_node_cap_exceeded",
			`Markdown parse produced ${nodeCount} AST nodes, exceeding the ${cap} cap.`,
		);
	}

	const { hasFrontmatter, frontmatter, frontmatterEndOffset } = extractFrontmatter(tree, source);

	const headings = buildHeadingMetas(tree, source, relpath);
	finalizeHeadingRanges(headings, source);
	annotateBodyTokens(headings, source, tree);

	const preamble = computePreamble(headings, source, frontmatterEndOffset);
	// Preamble passed in so kinds for headingless files (and pre-first-heading
	// nodes) accumulate on `preamble.contentKinds` instead of being silently
	// dropped — `get_vault_tree`'s file-row `contentKinds` reads through the
	// preamble bucket via `computeFileMetrics`.
	annotateContentKinds(headings, tree, preamble);

	const blockableNodes = collectBlockableNodes(tree, source);
	const excludedRanges = collectExcludedRanges(tree);
	const blockMatches = extractBlockIds(source, blockableNodes, excludedRanges);
	const { blocks, blockIndex } = buildBlockMetas(blockMatches, headings);
	annotateHeadingBlockIds(headings, blocks);

	const outline = buildOutlineTree(headings);
	annotateDescendantTokens(outline, headings);

	return {
		relpath,
		source,
		hasFrontmatter,
		frontmatter,
		frontmatterEndOffset,
		outline,
		blockIndex,
		headings,
		blocks,
		preamble,
		excludedRanges,
	};
}

// ─── Frontmatter ───────────────────────────────────────────────────────────

interface FrontmatterResult {
	hasFrontmatter: boolean;
	frontmatter: Record<string, unknown> | null;
	frontmatterEndOffset: number;
}

function extractFrontmatter(tree: Root, source: string): FrontmatterResult {
	const first = tree.children[0];
	if (!first || first.type !== "yaml") {
		return { hasFrontmatter: false, frontmatter: null, frontmatterEndOffset: 0 };
	}
	const yamlNode = first as Yaml;
	const errorLine = yamlNode.position?.start.line ?? 1;
	const frontmatter = parseFrontmatterYaml(yamlNode.value, errorLine);
	// `position.end.offset` points at the end of the closing `---`, before
	// its EOL. Route through `consumeEol` so the two extractor paths agree
	// on every EOL style (CRLF/LF/bare CR) — otherwise `get_metadata`
	// (frontmatterOnly) and `get_fragment` (full parser) diverge on
	// Mac-Classic-style notes.
	const endOffset = yamlNode.position?.end.offset ?? 0;
	const consumed = consumeEol(source, endOffset);
	const adjusted = consumed >= 0 ? consumed : endOffset;
	return { hasFrontmatter: true, frontmatter, frontmatterEndOffset: adjusted };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Parse a YAML body and gate it through JSON.stringify. `parseYAML` admits
 * circular structures (self-referential aliases like `a: &a [*a]`) and
 * BigInts (large ints) — both throw at MCP envelope-encode time, so we
 * route them as MARKDOWN_PARSE_ERROR with a useful line rather than letting
 * an INTERNAL_ERROR leak. Non-object top-level (scalar/array) collapses to
 * `{}` per Brief — frontmatter is always Record<string, unknown>.
 */
function parseFrontmatterYaml(yamlBody: string, errorLine = 1): Record<string, unknown> {
	let parsed: unknown;
	try {
		parsed = parseYAML(yamlBody);
	} catch (cause) {
		throw new ParseError("syntax", `YAML frontmatter parse failed: ${errorMessage(cause)}`, errorLine);
	}
	try {
		JSON.stringify(parsed);
	} catch (cause) {
		throw new ParseError("syntax", `YAML frontmatter is not JSON-serializable: ${errorMessage(cause)}`, errorLine);
	}
	return isPlainObject(parsed) ? parsed : {};
}

/**
 * Extract YAML frontmatter without running remark-parse. Mirrors the
 * micromark-extension-frontmatter ABNF: opening fence at offset 0
 * (`---` + optional spaces/tabs + eol), zero or more YAML lines, closing
 * fence (`---` + optional spaces/tabs + eol-or-eof). All three eols
 * (`\n`, `\r`, `\r\n`) are accepted. Single linear pass, no regex
 * backtracking. Used by the `frontmatterOnly` fast path.
 */
function extractFrontmatterFromSource(source: string): FrontmatterResult {
	if (source[0] !== "-" || source[1] !== "-" || source[2] !== "-") {
		return { hasFrontmatter: false, frontmatter: null, frontmatterEndOffset: 0 };
	}
	let cursor = 3;
	while (source[cursor] === " " || source[cursor] === "\t") cursor++;
	const afterOpenFence = consumeEol(source, cursor);
	if (afterOpenFence < 0) {
		return { hasFrontmatter: false, frontmatter: null, frontmatterEndOffset: 0 };
	}
	const yamlStart = afterOpenFence;
	cursor = yamlStart;

	while (cursor < source.length) {
		if (source[cursor] === "-" && source[cursor + 1] === "-" && source[cursor + 2] === "-") {
			let after = cursor + 3;
			while (source[after] === " " || source[after] === "\t") after++;
			const fenceEnd = after === source.length ? after : consumeEol(source, after);
			if (fenceEnd >= 0) {
				const frontmatter = parseFrontmatterYaml(source.slice(yamlStart, cursor));
				return { hasFrontmatter: true, frontmatter, frontmatterEndOffset: fenceEnd };
			}
		}
		const next = nextLineStart(source, cursor);
		if (next < 0) break;
		cursor = next;
	}
	return { hasFrontmatter: false, frontmatter: null, frontmatterEndOffset: 0 };
}

/** Consume one eol (`\r\n` | `\n` | `\r`) at `offset`. Returns post-eol offset, or -1 if absent. */
function consumeEol(source: string, offset: number): number {
	if (source[offset] === "\r" && source[offset + 1] === "\n") return offset + 2;
	if (source[offset] === "\n" || source[offset] === "\r") return offset + 1;
	return -1;
}

/** Offset of the start of the next line strictly after `from`, or -1 at EOF. */
function nextLineStart(source: string, from: number): number {
	for (let i = from; i < source.length; i++) {
		const c = source.charCodeAt(i);
		if (c === 13 /* \r */) return source.charCodeAt(i + 1) === 10 ? i + 2 : i + 1;
		if (c === 10 /* \n */) return i + 1;
	}
	return -1;
}

// ─── Outline construction ─────────────────────────────────────────────────

interface StackFrame {
	heading: HeadingMeta;
	ancestors: StructuralAncestor[];
	pathChain: string[];
}

function buildHeadingMetas(tree: Root, source: string, relpath: string): HeadingMeta[] {
	const headings: HeadingMeta[] = [];
	const stack: StackFrame[] = [];
	// `null` parent ⇒ virtual root; key Map by frame reference, with a
	// dedicated sentinel for the virtual root.
	const rootCounts = new Map<HeadingLevel, number>();
	const childCounts = new WeakMap<StackFrame, Map<HeadingLevel, number>>();
	// Per-document slug dedup state (github-slugger algorithm). `slugSeen`
	// holds every emitted slug; `slugCounters` carries the last `-N` suffix
	// per base so a third duplicate doesn't restart at `-1`. Looping until
	// unique handles the literal-collision edge case where a heading text
	// already happens to be `Foo-1` (so the second `Foo` must skip past the
	// literal `foo-1` to `foo-2`).
	const slugSeen = new Set<string>();
	const slugCounters = new Map<string, number>();

	for (const child of tree.children) {
		if (child.type !== "heading") continue;
		const heading = child as Heading;
		const level = heading.depth as HeadingLevel;

		// Pop until top frame is at a strictly shallower level than this heading
		while (stack.length > 0) {
			const top = stack[stack.length - 1];
			if (top && top.heading.level < level) break;
			stack.pop();
		}
		const parentFrame = stack[stack.length - 1] ?? null;

		const counts = parentFrame
			? (childCounts.get(parentFrame) ??
				(() => {
					const m = new Map<HeadingLevel, number>();
					childCounts.set(parentFrame, m);
					return m;
				})())
			: rootCounts;
		const siblingIndex = (counts.get(level) ?? 0) + 1;
		counts.set(level, siblingIndex);

		const parentAncestors = parentFrame ? parentFrame.ancestors : [];
		const ancestors: StructuralAncestor[] = [...parentAncestors, { level, siblingIndex }];
		const structuralPath = buildStructuralPath(ancestors);
		const stable_id = stableId(relpath, structuralPath);

		// `includeHtml: false` strips mdast `html` nodes only, NOT `inlineCode`,
		// so `# Use \`<T>\` …` preserves `<T>` while `# <span>x</span> H` → `x H`
		// (Brief decision matrix line 789). Path-matching collapses whitespace
		// runs so users can query `"A B"` regardless of source spacing; the slug
		// pipeline keeps original whitespace so multi-space headings produce
		// GitHub-compatible per-space hyphenation.
		const stripped = mdastToString(heading, { includeHtml: false }).normalize("NFC").trim();
		const pathText = normalizeHeadingText(stripped);
		const headingPosStart = heading.position?.start.offset ?? 0;
		const headingPosEnd = heading.position?.end.offset ?? headingPosStart;
		const displayText = sliceHeadingDisplay(heading, source);
		const headingPath = parentFrame ? [...parentFrame.pathChain, pathText] : [pathText];

		const meta: HeadingMeta = {
			stable_id,
			structuralPath,
			level,
			pathText,
			displayText,
			slug: uniqueSlug(githubSlug(stripped), slugSeen, slugCounters),
			headingPath,
			range: {
				start: heading.position?.start.line ?? 1,
				end: heading.position?.end.line ?? 1,
			},
			selectionRange: {
				start: heading.position?.start.line ?? 1,
				end: heading.position?.end.line ?? 1,
			},
			offsetRange: { start: headingPosStart, end: headingPosEnd },
			headingLineOffset: { start: headingPosStart, end: headingPosEnd },
			bodyOffsetRange: { start: headingPosEnd, end: headingPosEnd },
			bodyTokensApprox: 0,
			descendantTokensApprox: 0,
			subheadings: 0,
			contentKinds: [],
			blockIds: [],
		};
		headings.push(meta);

		const frame: StackFrame = { heading: meta, ancestors, pathChain: headingPath };
		stack.push(frame);
	}
	return headings;
}

/**
 * Second pass: each heading's section ends at the start of the NEXT
 * heading at the same OR shallower level (or EOF). Body range starts
 * after the heading line. `bodyOffsetRange.end` initially set to section
 * end; {@link annotateBodyTokens} narrows it to the next sibling-or-ancestor.
 */
function finalizeHeadingRanges(headings: HeadingMeta[], source: string): void {
	// EOF defaults are computed ONCE — countLines is O(n) on source length, so
	// hoisting it out of the per-heading loop avoids O(n × headings) work.
	const eofOffset = source.length;
	const eofLine = countLines(source);
	for (let i = 0; i < headings.length; i++) {
		const h = headings[i];
		if (!h) continue;
		let nextSectionOffset = eofOffset;
		let nextSectionLine = eofLine;
		for (let j = i + 1; j < headings.length; j++) {
			const candidate = headings[j];
			if (!candidate) continue;
			if (candidate.level <= h.level) {
				nextSectionOffset = candidate.offsetRange.start;
				nextSectionLine = candidate.range.start - 1;
				break;
			}
		}
		h.offsetRange.end = nextSectionOffset;
		h.range.end = Math.max(nextSectionLine, h.selectionRange.start);
		h.bodyOffsetRange.end = nextSectionOffset;
	}
}

/**
 * `bodyTokensApprox` per heading = tokens of the immediate body slice
 * (heading-line-end → first child heading start, or section end).
 *
 * In source order, the heading immediately AFTER `h` is `h`'s first child
 * iff its level is strictly deeper (the section-end pass already
 * guarantees a deeper heading falls inside `h`'s offsetRange). Otherwise
 * `h` has no descendants and its body extends to its section end.
 */
function annotateBodyTokens(headings: HeadingMeta[], source: string, _tree: Root): void {
	for (let i = 0; i < headings.length; i++) {
		const h = headings[i];
		if (!h) continue;
		const next = headings[i + 1];
		const bodyEnd = next && next.level > h.level ? next.offsetRange.start : h.offsetRange.end;
		h.bodyOffsetRange.end = bodyEnd;
		const slice = source.slice(h.bodyOffsetRange.start, bodyEnd);
		h.bodyTokensApprox = estimateTokens(slice);
	}
}

function annotateContentKinds(
	headings: HeadingMeta[],
	tree: Root,
	preamble: { range: Range; offsetRange: OffsetRange; contentKinds: ContentKind[] } | null,
): void {
	// Body ranges are non-overlapping slices of the document (each top-level
	// non-heading node belongs to exactly one heading's IMMEDIATE body OR to
	// the preamble), so one pass over `tree.children` + binary-search per
	// node is O(C × log H) instead of the previous O(H × C × nested-list).
	//
	// Per node, recurse uniformly via `visit()` — paragraphs hold inline
	// `image` nodes and blockquotes hold arbitrary block content; both
	// contribute kinds. `nodeContentKind` returns null for uninteresting
	// types (heading, paragraph, text, etc.) so visit-the-start-node is
	// idempotent on a Set.
	const kindsByStableId = new Map<string, Set<ContentKind>>();
	const preambleKinds = new Set<ContentKind>();
	for (const node of tree.children) {
		const start = node.position?.start.offset ?? -1;
		if (start < 0) continue;
		const heading = findHeadingByBodyOffset(start, headings);
		// Headingless file OR pre-first-heading nodes route to the preamble
		// bucket so their kinds aren't silently dropped.
		let target: Set<ContentKind>;
		if (heading) {
			let existing = kindsByStableId.get(heading.stable_id);
			if (!existing) {
				existing = new Set<ContentKind>();
				kindsByStableId.set(heading.stable_id, existing);
			}
			target = existing;
		} else {
			target = preambleKinds;
		}
		visit(node, (n) => {
			const k = nodeContentKind(n);
			if (k) target.add(k);
			if (n.type === "blockquote" && isCallout(n as Parent)) target.add("callout");
		});
	}
	for (const h of headings) {
		const kinds = kindsByStableId.get(h.stable_id);
		if (kinds && kinds.size > 0) h.contentKinds = [...kinds];
	}
	if (preamble && preambleKinds.size > 0) preamble.contentKinds = [...preambleKinds];
}

/**
 * Binary-search a sorted (source-order) heading list for the one whose
 * IMMEDIATE body contains `offset`. Body ranges don't overlap, so the
 * single search suffices — no backward-walk fallback needed (unlike
 * {@link findContainingHeading} which walks full sections).
 */
function findHeadingByBodyOffset(offset: number, headings: HeadingMeta[]): HeadingMeta | null {
	let lo = 0;
	let hi = headings.length;
	while (lo < hi) {
		const mid = (lo + hi) >>> 1;
		const h = headings[mid];
		if (!h) break;
		if (h.bodyOffsetRange.start <= offset) lo = mid + 1;
		else hi = mid;
	}
	if (lo === 0) return null;
	const candidate = headings[lo - 1];
	if (!candidate) return null;
	return offset < candidate.bodyOffsetRange.end ? candidate : null;
}

function nodeContentKind(node: Node): ContentKind | null {
	switch (node.type) {
		case "code":
			return "code";
		case "table":
			return "table";
		case "image":
			return "image";
		case "list":
			return "list";
		case "math":
		case "inlineMath":
			return "math";
		default:
			return null;
	}
}

function isCallout(blockquote: Parent): boolean {
	const first = blockquote.children[0];
	if (!first || first.type !== "paragraph") return false;
	const text = mdastToString(first as Paragraph);
	return /^\[!/.test(text);
}

// ─── Block IDs ─────────────────────────────────────────────────────────────

function collectBlockableNodes(tree: Root, source: string): BlockableNodeRange[] {
	// Single visit collects blockquote ranges AND blockable nodes — pre-order
	// DFS guarantees an enclosing blockquote is recorded before its descendant
	// blockable nodes, which need it to detect any-ancestor blockquote membership
	// (mdast nests `blockquote → list → listItem`, so `parent.type` alone misses
	// the list-inside-blockquote case).
	const blockquoteRanges: ExcludedRange[] = [];
	const out: BlockableNodeRange[] = [];
	visit(tree, (node, _index, parent) => {
		if (node.type === "blockquote") {
			const pos = node.position;
			if (pos && pos.start.offset !== undefined && pos.end.offset !== undefined) {
				blockquoteRanges.push({ offsetStart: pos.start.offset, offsetEnd: pos.end.offset });
			}
		} else if (node.type === "paragraph") {
			// Skip paragraphs nested inside listItems — the listItem itself is
			// the addressable block per Obsidian semantics.
			if (parent?.type === "listItem") return;
			pushRange(out, node as Paragraph, source, blockquoteRanges);
		} else if (node.type === "listItem") {
			pushRange(out, node as ListItem, source, blockquoteRanges);
		}
	});
	return out;
}

function pushRange(
	out: BlockableNodeRange[],
	node: Paragraph | ListItem,
	source: string,
	blockquoteRanges: ReadonlyArray<ExcludedRange>,
): void {
	const pos = node.position;
	if (!pos || pos.start.offset === undefined || pos.end.offset === undefined) return;
	// mdast paragraph/listItem offsets start AFTER the `> ` markers when nested
	// in a blockquote (any ancestor) — walk back to line start so block content
	// retains the marker.
	const startOffset = pos.start.offset;
	const inBlockquote = isInsideAny(startOffset, blockquoteRanges);
	const offsetStart = inBlockquote ? lineStartOffset(source, startOffset) : startOffset;
	const trailingEdgeOffset = node.type === "listItem" ? listItemTrailingEdge(node, pos.end.offset) : pos.end.offset;
	out.push({
		offsetStart,
		offsetEnd: pos.end.offset,
		trailingEdgeOffset,
		lineStart: pos.start.line,
		lineEnd: pos.end.line,
		inBlockquote,
	});
}

/**
 * End offset of the listItem's last non-`list` child — the parent's text
 * edge for trailing-only `^id` validation (sub-lists are nested content,
 * not text). Falls back to the listItem's own end when every child is a list.
 */
function listItemTrailingEdge(node: ListItem, fallback: number): number {
	const last = node.children.findLast((c) => c.type !== "list" && c.position?.end.offset !== undefined);
	return last?.position?.end.offset ?? fallback;
}

function lineStartOffset(source: string, offset: number): number {
	// CommonMark §2.3 line endings: `\n`, `\r`, or `\r\n`. Walk back over
	// non-EOL bytes; either `\n` or `\r` marks the prior line's terminator.
	let i = offset;
	while (i > 0) {
		const c = source.charCodeAt(i - 1);
		if (c === 10 || c === 13) break;
		i--;
	}
	return i;
}

function collectExcludedRanges(tree: Root): ExcludedRange[] {
	const out: ExcludedRange[] = [];
	visit(tree, (node) => {
		if (node.type === "code" || node.type === "inlineCode" || node.type === "math" || node.type === "inlineMath") {
			const pos = node.position;
			if (!pos || pos.start.offset === undefined || pos.end.offset === undefined) return;
			out.push({ offsetStart: pos.start.offset, offsetEnd: pos.end.offset });
		}
	});
	return out;
}

function buildBlockMetas(
	matches: BlockIdMatch[],
	headings: HeadingMeta[],
): { blocks: BlockMeta[]; blockIndex: Record<string, BlockIndexEntry> } {
	const blocks: BlockMeta[] = [];
	const blockIndex: Record<string, BlockIndexEntry> = {};
	for (const m of matches) {
		const containing = findContainingHeading(m.block.offsetStart, headings);
		const block: BlockMeta = {
			id: m.id,
			range: { start: m.block.lineStart, end: m.block.lineEnd },
			offsetRange: { start: m.block.offsetStart, end: m.block.offsetEnd },
			containingHeadingPath: containing ? containing.headingPath : [],
			containingStableId: containing ? containing.stable_id : null,
		};
		blocks.push(block);
		// First-match-wins per Brief line 90. `Object.hasOwn` (not `in`)
		// because block-ID grammar admits Object.prototype keys (`constructor`,
		// `toString`, …) that `in` would falsely report as already-present.
		if (!Object.hasOwn(blockIndex, m.id)) {
			blockIndex[m.id] = {
				range: block.range,
				heading_path: block.containingHeadingPath,
				containing_stable_id: block.containingStableId,
			};
		}
	}
	return { blocks, blockIndex };
}

function findContainingHeading(offset: number, headings: HeadingMeta[]): HeadingMeta | null {
	// Headings are pushed in source order, so `offsetRange.start` is non-decreasing.
	// Binary-search for the rightmost heading whose start ≤ offset, then walk
	// backward to skip deeper-but-already-ended siblings until we hit a containing
	// section. Backward walk is bounded by max heading depth (≤ 6) in practice.
	let lo = 0;
	let hi = headings.length;
	while (lo < hi) {
		const mid = (lo + hi) >>> 1;
		const h = headings[mid];
		if (!h) break;
		if (h.offsetRange.start <= offset) lo = mid + 1;
		else hi = mid;
	}
	for (let i = lo - 1; i >= 0; i--) {
		const h = headings[i];
		if (!h) continue;
		if (offset < h.offsetRange.end) return h;
	}
	return null;
}

function annotateHeadingBlockIds(headings: HeadingMeta[], blocks: BlockMeta[]): void {
	// First-match-wins per Brief line 90 applies across ALL blocks (preamble
	// AND headings): mark `seen` BEFORE the preamble check so a preamble
	// first-occurrence locks the id, mirroring `blockIndex`. Otherwise a
	// later duplicate under a heading is wrongly advertised in that
	// heading's `blockIds` while `get_fragment` still resolves to the
	// preamble.
	const byHeading = new Map<string, string[]>();
	const seen = new Set<string>();
	for (const b of blocks) {
		if (seen.has(b.id)) continue;
		seen.add(b.id);
		if (!b.containingStableId) continue;
		const list = byHeading.get(b.containingStableId) ?? [];
		list.push(b.id);
		byHeading.set(b.containingStableId, list);
	}
	for (const h of headings) {
		const ids = byHeading.get(h.stable_id);
		if (ids && ids.length > 0) h.blockIds = ids;
	}
}

// ─── Outline tree ─────────────────────────────────────────────────────────

function buildOutlineTree(headings: HeadingMeta[]): OutlineNode[] {
	const out: OutlineNode[] = [];
	const nodeStack: OutlineNode[] = [];
	const levelStack: HeadingLevel[] = [];

	for (const h of headings) {
		while (levelStack.length > 0) {
			const topLevel = levelStack[levelStack.length - 1];
			if (topLevel !== undefined && topLevel < h.level) break;
			nodeStack.pop();
			levelStack.pop();
		}
		const node: OutlineNode = {
			level: h.level,
			text: h.displayText,
			path: h.pathText,
			stable_id: h.stable_id,
			anchor: h.slug,
			range: { ...h.range },
			selectionRange: { ...h.selectionRange },
			bodyTokensApprox: h.bodyTokensApprox,
			subheadings: 0,
			descendantTokensApprox: 0,
		};
		if (h.contentKinds.length > 0) node.contentKinds = [...h.contentKinds];
		if (h.blockIds.length > 0) node.blockIds = [...h.blockIds];

		const parent = nodeStack[nodeStack.length - 1];
		if (parent) {
			parent.children = parent.children ?? [];
			parent.children.push(node);
		} else {
			out.push(node);
		}
		nodeStack.push(node);
		levelStack.push(h.level);
	}
	return out;
}

function annotateDescendantTokens(outline: OutlineNode[], headings: HeadingMeta[]): void {
	const metaByStableId = new Map<string, HeadingMeta>();
	for (const h of headings) metaByStableId.set(h.stable_id, h);
	function recurse(node: OutlineNode): number {
		let total = node.bodyTokensApprox;
		const children = node.children ?? [];
		for (const child of children) {
			total += recurse(child);
		}
		node.subheadings = children.length;
		node.descendantTokensApprox = total;
		const meta = metaByStableId.get(node.stable_id);
		if (meta) {
			meta.descendantTokensApprox = total;
			meta.subheadings = children.length;
		}
		return total;
	}
	for (const root of outline) recurse(root);
}

// ─── Preamble ──────────────────────────────────────────────────────────────

function computePreamble(
	headings: HeadingMeta[],
	source: string,
	frontmatterEndOffset: number,
): { range: Range; offsetRange: OffsetRange; contentKinds: ContentKind[] } | null {
	// Headingless notes: the entire post-frontmatter body IS the preamble
	// — Brief line 784 says `anchor: {kind: "heading_path", path: []}`
	// must resolve to "content before first heading," and for a headingless
	// note that means everything. Otherwise such notes are invisible to
	// fragment retrieval.
	const firstHeading = headings[0];
	const startOffset = frontmatterEndOffset;
	const endOffset = firstHeading?.offsetRange.start ?? source.length;
	if (endOffset <= startOffset) return null;
	if (isWhitespaceRange(source, startOffset, endOffset)) return null;
	const startLine = lineAtOffset(source, startOffset);
	const lastBodyLine = firstHeading ? firstHeading.range.start - 1 : countLines(source);
	return {
		range: { start: startLine, end: Math.max(startLine, lastBodyLine) },
		offsetRange: { start: startOffset, end: endOffset },
		contentKinds: [],
	};
}

// ─── Helpers ───────────────────────────────────────────────────────────────

const ATX_PREFIX_RE = /^#+\s*/;
const ATX_TRAILING_RE = /\s+#+\s*$/;

/**
 * Slice the inline-content portion of an ATX or setext heading from
 * `source`. Inline formatting (`**bold**`, `*em*`, `[link]()`, etc.) is
 * preserved verbatim; the `#` markers and setext underlines are not
 * children of the heading node so the slice naturally excludes them.
 *
 * Fallback path fires for empty-content headings (`## ##` parses with
 * `children.length === 0`) and the rare case where remark omits child
 * positions: it strips ATX markers from the full node slice.
 */
function sliceHeadingDisplay(heading: Heading, source: string): string {
	const children = heading.children;
	const firstChild = children[0];
	const lastChild = children[children.length - 1];
	const firstStart = firstChild?.position?.start.offset;
	const lastEnd = lastChild?.position?.end.offset;
	if (firstStart !== undefined && lastEnd !== undefined && lastEnd >= firstStart) {
		return source.slice(firstStart, lastEnd);
	}
	const fallbackStart = heading.position?.start.offset ?? 0;
	const fallbackEnd = heading.position?.end.offset ?? fallbackStart;
	return source.slice(fallbackStart, fallbackEnd).replace(ATX_PREFIX_RE, "").replace(ATX_TRAILING_RE, "");
}

// Underscore in keep-list: GitHub permalinks preserve `_` (`# foo_bar` →
// `#foo_bar`); without it `# foo_bar` and `# foobar` falsely collide.
const SLUG_STRIP_RE = /[^\p{L}\p{N}\s_-]/gu;

function githubSlug(text: string): string {
	// No NFKD: would decompose accents (`é → e + U+0301`) and the next strip
	// drops the combining mark, breaking `# Café → café`. Brief lines 78/148
	// promise GitHub-compatible slugs (Unicode letters preserved intact).
	// Per-whitespace-char replacement (`/\s/g`, NOT `/\s+/g`) keeps
	// github-slugger v2's run-preserving semantics: `# A   B` → `a---b`, not
	// `a-b`. Tabs and other non-space `\s` chars also become one hyphen each;
	// SLUG_STRIP_RE keeps `\s` so the strip step lets them through to here.
	return text.toLowerCase().replace(SLUG_STRIP_RE, "").trim().replace(/\s/g, "-");
}

/**
 * Canonical heading-text shape for `heading_path` matching: NFC + trim +
 * whitespace-collapse. Used at index time to build `pathText` and at query
 * time to normalize agent input — both endpoints must run the same
 * pipeline or sloppy whitespace silently drops to HEADING_NOT_FOUND. NFC
 * and trim are idempotent so calling on already-stripped text is safe.
 */
export function normalizeHeadingText(text: string): string {
	return text.normalize("NFC").trim().replace(/\s+/g, " ");
}

/**
 * Canonicalize an agent-supplied `heading_path` to the array form used
 * by every `parsed.headings[].headingPath` field. Accepts either an
 * array or `"A > B"` string form; each component is normalized through
 * {@link normalizeHeadingText} and empty segments dropped. Shared by
 * `get_fragment` and `get_links` narrowing.
 */
export function normalizeHeadingPath(path: string | string[]): string[] {
	const components = typeof path === "string" ? path.split(/\s*>\s*/) : path;
	return components.map(normalizeHeadingText).filter((s) => s.length > 0);
}

export function headingPathsEqual(a: ReadonlyArray<string>, b: ReadonlyArray<string>): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
	return true;
}

/**
 * Byte offset where a file's body begins after the frontmatter — the
 * starting point a "whole file" fragment slice or embed expansion uses.
 *
 * Fallback chain: preamble offset (when present) → first heading start
 * (skips a whitespace-only gap between frontmatter and heading, e.g.
 * `---\n...\n---\n\n# H\n`) → first block start → raw frontmatter end
 * for the truly empty / frontmatter-only case. Plain `preamble ??
 * frontmatterEndOffset` would emit a stray leading `\n` on
 * frontmatter+blank+heading files.
 */
export function fileBodyStartOffset(parsed: ParsedFile): number {
	return (
		parsed.preamble?.offsetRange.start ??
		parsed.headings[0]?.offsetRange.start ??
		parsed.blocks[0]?.offsetRange.start ??
		parsed.frontmatterEndOffset
	);
}

function uniqueSlug(base: string, seen: Set<string>, counters: Map<string, number>): string {
	let slug = base;
	let count = counters.get(base) ?? 0;
	while (seen.has(slug)) {
		count++;
		slug = `${base}-${count}`;
	}
	seen.add(slug);
	counters.set(base, count);
	return slug;
}

function countLines(source: string): number {
	// CommonMark §2.3 line endings: each `\n`, bare `\r`, or `\r\n` pair
	// counts once. Outline ranges (preamble.range, last-heading EOF line)
	// and pushRange's blockquote walk-back rely on this EOL surface — the
	// frontmatter layer also accepts bare CR for the same reason.
	if (source.length === 0) return 1;
	let count = 1;
	for (let i = 0; i < source.length; i++) {
		const c = source.charCodeAt(i);
		if (c === 10) count++;
		else if (c === 13) {
			count++;
			if (source.charCodeAt(i + 1) === 10) i++;
		}
	}
	return count;
}

function lineAtOffset(source: string, offset: number): number {
	let line = 1;
	const limit = Math.min(offset, source.length);
	for (let i = 0; i < limit; i++) {
		const c = source.charCodeAt(i);
		if (c === 10) line++;
		else if (c === 13) {
			line++;
			if (i + 1 < limit && source.charCodeAt(i + 1) === 10) i++;
		}
	}
	return line;
}
