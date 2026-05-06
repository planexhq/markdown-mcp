/**
 * `get_fragment` — heading / block / preamble / file resolution per
 * Brief lines 92–204 + D29 (discriminated union over `anchor_kind`).
 *
 * W2 scope:
 *   - `stable_id` lookup: in-memory only against parsed.headings. Stale
 *     `stable_id` returns `HEADING_NOT_FOUND` directly with empty
 *     `candidates` (CLAUDE.md gotcha + plan W2 round 8) — durable
 *     fuzzy recovery via `heading_history` lands W3.
 *   - `anchor: { kind: "heading_path", path }`: array OR string ("A > B")
 *     accepted; ambiguity → `HEADING_AMBIGUOUS` with all candidates.
 *   - `anchor: { kind: "block", id }`: in-memory blockIndex lookup;
 *     missing id → `HEADING_NOT_FOUND` (no separate BLOCK_NOT_FOUND code
 *     in the v1 ErrorCode union, by design — same disambiguation surface).
 *   - `anchor: { kind: "file" }`: whole file minus frontmatter.
 *   - `expand_embeds` is accepted but a no-op — wikilink/embed resolution
 *     is W4. Embeds are populated with `resolved: false`, `expanded: false`.
 *
 * Outgoing-link / embed extraction is regex-on-content in W2; targets are
 * UNRESOLVED (`resolved: false`, no `target_file`). W4 will replace the
 * extractor with the real Obsidian three-phase resolver.
 */

import { extname } from "node:path";

import { type ExcludedRange, isInsideAny } from "../lib/blockIds.js";
import {
	headingAmbiguousEnvelope,
	headingNotFoundEnvelope,
	internalErrorEnvelope,
	newMeta,
	successEnvelope,
	type ToolErrorEnvelope,
	type ToolSuccessEnvelope,
} from "../lib/error.js";
import { type BlockMeta, type HeadingMeta, normalizeHeadingText, type ParsedFile } from "../lib/parser.js";
import { readNote } from "../lib/readNote.js";
import { estimateTokens, getTokenizerId } from "../lib/tokenizer.js";
import { type VaultRoot, validatePath } from "../lib/validatePath.js";
import type {
	BlockFragment,
	Embed,
	EmbedKind,
	FileFragment,
	FragmentResult,
	GetFragmentInput,
	HeadingCandidate,
	HeadingFragment,
	OutgoingLink,
	PreambleFragment,
} from "../types.js";
import { routeToolError } from "./routeError.js";

export async function handleGetFragment(
	input: GetFragmentInput,
	vaultRoot: VaultRoot,
): Promise<ToolSuccessEnvelope<FragmentResult> | ToolErrorEnvelope> {
	try {
		const safePath = await validatePath(input.file, vaultRoot);
		const { parsed } = await readNote(safePath);
		const meta = newMeta({ tokenizer: getTokenizerId() });

		// 1. stable_id wins per Brief line 116 ("the precise identifier").
		if (input.stable_id) {
			// Schema accepts case-insensitively (`/^h:[0-9a-f]{14}$/i`); generated
			// IDs are always lowercase (sha1 hex). Normalize before comparing so
			// `H:ABCDEF...` resolves identically to `h:abcdef...`. The original
			// input is preserved on stale-error reporting via `requested_stable_id`.
			const normalized = input.stable_id.toLowerCase();
			const heading = parsed.headings.find((h) => h.stable_id === normalized);
			if (heading) {
				return successEnvelope(buildHeadingFragment(heading, parsed, "fresh"), meta);
			}
			return headingNotFoundEnvelope(
				{
					message: `stable_id ${input.stable_id} not found in current outline.`,
					param: "stable_id",
					requested_stable_id: input.stable_id,
					stable_id_status: "stale",
					candidates: [],
					suggestion: "Call get_file_outline(file) and choose a current heading.",
				},
				meta,
			);
		}

		// 2. Dispatch on anchor.kind.
		switch (input.anchor.kind) {
			case "file":
				return successEnvelope(buildFileFragment(parsed), meta);

			case "heading_path": {
				const path = normalizeHeadingPath(input.anchor.path);
				if (path.length === 0) {
					return successEnvelope(buildPreambleFragment(parsed), meta);
				}
				const matches = parsed.headings.filter((h) => arraysEqual(h.headingPath, path));
				if (matches.length === 0) {
					return headingNotFoundEnvelope(
						{
							message: `Heading path not found: ${path.join(" > ")}`,
							param: "anchor.path",
							stable_id_status: "missing",
							candidates: [],
							suggestion: "Call get_file_outline(file) to inspect available headings.",
						},
						meta,
					);
				}
				if (matches.length > 1) {
					const candidates: HeadingCandidate[] = matches.map((m) => ({
						stable_id: m.stable_id,
						heading_path: m.headingPath,
					}));
					return headingAmbiguousEnvelope(
						{
							candidates,
							param: "anchor.path",
							message: `Heading path "${path.join(" > ")}" matches ${matches.length} headings.`,
							suggestion: "Re-issue with `stable_id` (precise) or a deeper `heading_path`.",
						},
						meta,
					);
				}
				const heading = matches[0];
				if (!heading) {
					return internalErrorEnvelope(
						"get_fragment: heading match list is non-empty but indexable element is undefined.",
					);
				}
				return successEnvelope(buildHeadingFragment(heading, parsed, "fresh"), meta);
			}

			case "block": {
				const blockId = input.anchor.id;
				const block = parsed.blocks.find((b) => b.id === blockId);
				if (!block) {
					return headingNotFoundEnvelope(
						{
							message: `Block id "^${blockId}" not found.`,
							param: "anchor.id",
							stable_id_status: "missing",
							candidates: [],
							suggestion: "Call get_file_outline(file) to see available block IDs.",
						},
						meta,
					);
				}
				return successEnvelope(buildBlockFragment(block, parsed), meta);
			}
		}
	} catch (err) {
		return routeToolError(err, "get_fragment");
	}
}

// ─── Fragment builders ────────────────────────────────────────────────────

function buildHeadingFragment(heading: HeadingMeta, parsed: ParsedFile, status: "fresh" | "stale"): HeadingFragment {
	const content = parsed.source.slice(heading.offsetRange.start, heading.offsetRange.end);
	const { outgoing, embeds } = extractWikilinks(content, heading.offsetRange.start, parsed.excludedRanges);
	return {
		anchor_kind: "heading",
		file: parsed.relpath,
		content,
		bodyTokensApprox: estimateTokens(content),
		outgoing_links: outgoing,
		embeds,
		stable_id: heading.stable_id,
		stable_id_status: status,
		heading_path: heading.headingPath,
		slug_path: heading.slug,
		level: heading.level,
	};
}

function buildPreambleFragment(parsed: ParsedFile): PreambleFragment {
	const content = parsed.preamble
		? parsed.source.slice(parsed.preamble.offsetRange.start, parsed.preamble.offsetRange.end)
		: "";
	const sliceStart = parsed.preamble?.offsetRange.start ?? 0;
	const { outgoing, embeds } = extractWikilinks(content, sliceStart, parsed.excludedRanges);
	return {
		anchor_kind: "preamble",
		file: parsed.relpath,
		content,
		bodyTokensApprox: estimateTokens(content),
		outgoing_links: outgoing,
		embeds,
	};
}

function buildBlockFragment(block: BlockMeta, parsed: ParsedFile): BlockFragment {
	const raw = parsed.source.slice(block.offsetRange.start, block.offsetRange.end);
	// Extract wikilinks from `raw` BEFORE stripping the marker — the strip
	// can excise chars mid-`raw` (nested-list parent: ` ^p` between the
	// parent text and its sub-list), which would shift every downstream
	// `m.index` out of sync with `parsed.excludedRanges` (absolute source
	// offsets) and leak code-span wikilinks in child items as graph edges.
	// Marker text is `[a-zA-Z0-9-]+` so the wikilink regex matches nothing
	// inside `^${id}` — running over `raw` is safe.
	const { outgoing, embeds } = extractWikilinks(raw, block.offsetRange.start, parsed.excludedRanges);
	// Strip the addressing marker for display. The `(?:^|[ \t])` prefix
	// avoids matching `^2` in `Value x^2` (no preceding whitespace, not a
	// block ID per BLOCK_ID_RE) and consuming the leading space avoids a
	// dangling trailer before the newline in the nested-list case.
	// Known edge: deferred-form addressing where literal `^${id}` text
	// appears at an internal line-end of `raw` strips the literal. Fix
	// would thread the parser-accepted match offset through BlockMeta.
	const trimRe = new RegExp(String.raw`(?:^|[ \t])\^${block.id}\s*$`, "m");
	const content = raw.replace(trimRe, "").trimEnd();
	const result: BlockFragment = {
		anchor_kind: "block",
		file: parsed.relpath,
		content,
		bodyTokensApprox: estimateTokens(content),
		outgoing_links: outgoing,
		embeds,
		block_id: block.id,
		containing_heading_path: block.containingHeadingPath,
	};
	if (block.containingStableId !== null) {
		result.containing_stable_id = block.containingStableId;
	}
	return result;
}

function buildFileFragment(parsed: ParsedFile): FileFragment {
	// File fragment excludes frontmatter (Brief decision matrix line 785).
	// Fallback chain: preamble offset (when present) → first heading start
	// (skips a whitespace-only gap between frontmatter and heading, e.g.
	// `---\n...\n---\n\n# H\n`) → first block start → raw frontmatter end
	// for the truly empty / frontmatter-only case. Plain `preamble ??
	// frontmatterEndOffset` would emit a stray leading `\n` on
	// frontmatter+blank+heading files.
	const start =
		parsed.preamble?.offsetRange.start ??
		parsed.headings[0]?.offsetRange.start ??
		parsed.blocks[0]?.offsetRange.start ??
		parsed.frontmatterEndOffset;
	const content = parsed.source.slice(start);
	const { outgoing, embeds } = extractWikilinks(content, start, parsed.excludedRanges);
	return {
		anchor_kind: "file",
		file: parsed.relpath,
		content,
		bodyTokensApprox: estimateTokens(content),
		outgoing_links: outgoing,
		embeds,
	};
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function normalizeHeadingPath(path: string | string[]): string[] {
	const components = typeof path === "string" ? path.split(/\s*>\s*/) : path;
	return components.map(normalizeHeadingText).filter((s) => s.length > 0);
}

function arraysEqual(a: string[], b: string[]): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
	return true;
}

const WIKILINK_RE = /(!)?\[\[([^\]\n]+)\]\]/g;

interface WikilinkExtraction {
	outgoing: OutgoingLink[];
	embeds: Embed[];
}

/**
 * Single-pass wikilink scan: one regex iteration produces both outgoing
 * links and embeds. Keeps `link_ordinal` consistent across calls and
 * avoids two full-content scans per fragment.
 *
 * Matches whose absolute offset (`sliceStart + match.index`) falls inside
 * a `code` / `inlineCode` range are skipped — Obsidian doesn't resolve
 * wikilinks in code, so emitting them creates phantom graph edges.
 */
function extractWikilinks(
	content: string,
	sliceStart: number,
	excludedRanges: ReadonlyArray<ExcludedRange>,
): WikilinkExtraction {
	const outgoing: OutgoingLink[] = [];
	const embeds: Embed[] = [];
	let ord = 0;
	for (const m of content.matchAll(WIKILINK_RE)) {
		if (m.index === undefined) continue;
		if (isInsideAny(sliceStart + m.index, excludedRanges)) continue;
		// CommonMark §2.4 backslash-escape: an odd count of backslashes
		// immediately before the match escapes its first character (`!` or `[`),
		// rendering the wikilink syntax inert. Obsidian honors the same rule.
		// Even count is a literal `\` followed by an unescaped match. Without
		// this filter `\[[NoLink]]` emits a phantom link AND shifts every
		// subsequent `link_ordinal` (breaks `get_links` cursor stability).
		if (isBackslashEscaped(content, m.index)) continue;
		const raw = m[2] ?? "";
		const pipeIdx = raw.indexOf("|");
		const target = pipeIdx >= 0 ? raw.slice(0, pipeIdx) : raw;
		const alias = pipeIdx >= 0 ? raw.slice(pipeIdx + 1) : undefined;
		if (m[1]) {
			embeds.push({
				raw_target: raw,
				kind: guessEmbedKind(target),
				resolved: false,
				expanded: false,
			});
			continue;
		}
		ord++;
		const link: OutgoingLink = {
			raw_target: target,
			link_text: alias ?? target,
			resolved: false,
			link_ordinal: ord,
		};
		if (alias !== undefined) link.alias = alias;
		outgoing.push(link);
	}
	return { outgoing, embeds };
}

function isBackslashEscaped(content: string, idx: number): boolean {
	let count = 0;
	let i = idx - 1;
	while (i >= 0 && content[i] === "\\") {
		count++;
		i--;
	}
	return count % 2 === 1;
}

const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "svg", "webp"]);
const MEDIA_EXTS = new Set(["mp3", "mp4", "mov", "webm", "wav", "m4a", "ogg"]);

function guessEmbedKind(target: string): EmbedKind {
	// Strip Obsidian fragment (`#page=2`, `#t=10`, `#Section`) before extname:
	// `extname("paper.pdf#page=2")` is `.pdf#page=2`, mis-classifying as note.
	const hashIdx = target.indexOf("#");
	const path = hashIdx >= 0 ? target.slice(0, hashIdx) : target;
	const ext = extname(path).slice(1).toLowerCase();
	if (ext === "") return "note";
	if (IMAGE_EXTS.has(ext)) return "image";
	if (ext === "pdf") return "pdf";
	if (MEDIA_EXTS.has(ext)) return "media";
	return "note";
}
