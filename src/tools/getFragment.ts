/**
 * `get_fragment` — heading / block / preamble / file resolution per
 * Brief lines 92–204 + D29 (discriminated union over `anchor_kind`).
 *
 * Outgoing wikilinks resolve against the vault index (Obsidian three-
 * phase). When `index` is provided, `OutgoingLink` and `Embed` rows
 * carry `resolved`, `target_file?`, `target_heading_path?`,
 * `target_block_id?`, and `candidates?`.
 *
 * `expand_embeds` triggers recursive expansion (cycle-detected,
 * depth-capped at 10) into `Embed.expanded_content` / `expansion_error`.
 * `bodyTokensApprox` is NOT changed by expansion (D11 — counts source
 * body, not expanded).
 */

import { stripBlockIdMarker } from "../lib/blockIds.js";
import { type EmbedExpansionContext, expandEmbed, makeFragmentCycleKey } from "../lib/embeds.js";
import {
	headingAmbiguousEnvelope,
	headingNotFoundEnvelope,
	internalErrorEnvelope,
	newMetaForHandler,
	successEnvelope,
	type ToolErrorEnvelope,
	type ToolSuccessEnvelope,
} from "../lib/error.js";
import { FUZZY_ALGORITHM_ID, type HeadingHistoryRow, recoverStaleStableId } from "../lib/fuzzy.js";
import type { IndexHandle } from "../lib/index/IndexHandle.js";
import { isReadyForIndexLookup } from "../lib/index_status.js";
import {
	type BlockMeta,
	fileBodyStartOffset,
	type HeadingMeta,
	headingPathsEqual,
	normalizeHeadingPath,
	type ParsedFile,
} from "../lib/parser.js";
import { readNote } from "../lib/readNote.js";
import { renderFragment } from "../lib/renderText/getFragment.js";
import { estimateTokens, getTokenizerId } from "../lib/tokenizer.js";
import { type VaultRoot, validatePath } from "../lib/validatePath.js";
import {
	buildEmbed,
	buildOutgoingLink,
	extractWikilinks,
	type ResolvedWikilink,
	resolveWikilink,
	type VaultFileIndex,
} from "../lib/wikilinks.js";
import type {
	BlockFragment,
	Embed,
	ExpandEmbedsOption,
	FileFragment,
	FragmentResult,
	GetFragmentInput,
	HeadingCandidate,
	HeadingFragment,
	MetaEnvelope,
	OutgoingLink,
	PreambleFragment,
} from "../types.js";
import { routeToolError } from "./routeError.js";

const MAX_EMBED_DEPTH = 10;

export async function handleGetFragment(
	input: GetFragmentInput,
	vaultRoot: VaultRoot,
	index?: IndexHandle,
	includeHidden = false,
): Promise<ToolSuccessEnvelope<FragmentResult> | ToolErrorEnvelope> {
	// Hoisted before try so the catch can pass meta to routeToolError —
	// preserves `index_status` and `tokenizer` on error envelopes.
	const meta = newMetaForHandler(index, { tokenizer: getTokenizerId() });
	try {
		const safePath = await validatePath(input.file, vaultRoot);
		const { parsed, sizeBytes } = await readNote(safePath, {}, includeHidden);
		// Defer link resolution and embed expansion until the index has a
		// usable snapshot — pre-warm, basename/heading maps are a strict
		// subset of the eventual vault, so `[[foo]]` can resolve uniquely
		// against the only-so-far-seen `notes/foo.md` even when a later
		// `archive/foo.md` would have made it ambiguous. Bounded reads
		// (heading/block/preamble/file body, frontmatter) still work
		// because they're parsed on demand. The agent sees
		// `index_status.state` in `_meta` and can re-query when warm.
		const vaultIndex = index && isReadyForIndexLookup(index.getStatus().state) ? index : undefined;

		// 1. stable_id wins per Brief line 116 ("the precise identifier").
		if (input.stable_id) {
			// Schema accepts case-insensitively (`/^h:[0-9a-f]{14}$/i`); generated
			// IDs are always lowercase (sha1 hex). Normalize before comparing so
			// `H:ABCDEF...` resolves identically to `h:abcdef...`. The original
			// input is preserved on stale-error reporting via `requested_stable_id`.
			const normalized = input.stable_id.toLowerCase();
			// Outline is authoritative (D27 — `stable_id` is a slot hash). When
			// the cached id resolves in `parsed.headings`, return it directly,
			// even if a sibling-swap left an orphaned `heading_history` row
			// pointing at the previous text — the server cannot distinguish a
			// cached pre-swap id from a fresh post-swap id.
			const heading = parsed.headings.find((h) => h.stable_id === normalized);
			if (heading) {
				const fragment = buildHeadingFragment(heading, parsed, sizeBytes, "fresh", vaultIndex);
				await maybeExpandEmbeds(fragment, input.expand_embeds, vaultRoot, vaultIndex, includeHidden);
				return successEnvelope(fragment, meta, { renderText: renderFragment });
			}
			const history = index?.getHistoryRow(safePath.relative, normalized) ?? null;
			if (history !== null) {
				return resolveStaleStableId(
					history,
					parsed,
					sizeBytes,
					input.stable_id,
					meta,
					vaultRoot,
					vaultIndex,
					input.expand_embeds,
					includeHidden,
				);
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
			case "file": {
				const fragment = buildFileFragment(parsed, sizeBytes, vaultIndex);
				await maybeExpandEmbeds(fragment, input.expand_embeds, vaultRoot, vaultIndex, includeHidden);
				return successEnvelope(fragment, meta, { renderText: renderFragment });
			}

			case "heading_path": {
				const path = normalizeHeadingPath(input.anchor.path);
				if (path.length === 0) {
					const fragment = buildPreambleFragment(parsed, sizeBytes, vaultIndex);
					await maybeExpandEmbeds(fragment, input.expand_embeds, vaultRoot, vaultIndex, includeHidden);
					return successEnvelope(fragment, meta, { renderText: renderFragment });
				}
				const matches = parsed.headings.filter((h) => headingPathsEqual(h.headingPath, path));
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
						meta,
					);
				}
				const fragment = buildHeadingFragment(heading, parsed, sizeBytes, "fresh", vaultIndex);
				await maybeExpandEmbeds(fragment, input.expand_embeds, vaultRoot, vaultIndex, includeHidden);
				return successEnvelope(fragment, meta, { renderText: renderFragment });
			}

			case "block": {
				// Tolerate leading `^`: the outline renderer emits `^abc` for
				// blocks (matching Obsidian's wikilink fragment convention
				// `[[file#^abc]]`); the canonical stored id is bare so an agent
				// copying the rendered form must round-trip.
				const blockId = input.anchor.id.startsWith("^") ? input.anchor.id.slice(1) : input.anchor.id;
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
				const fragment = buildBlockFragment(block, parsed, sizeBytes, vaultIndex);
				await maybeExpandEmbeds(fragment, input.expand_embeds, vaultRoot, vaultIndex, includeHidden);
				return successEnvelope(fragment, meta, { renderText: renderFragment });
			}
		}
	} catch (err) {
		return routeToolError(err, "get_fragment", meta);
	}
}

/**
 * Shared stale-`stable_id` recovery routing — used when the cached
 * ID is missing from current `parsed.headings` (D32 confidence-gated
 * fuzzy resolver).
 *
 * Fires `recoverStaleStableId` against the existing history row, then
 * either:
 *   - returns the success envelope with `stable_id_status: "stale"`,
 *     `requested_stable_id`, and optional `fuzzy_candidates` when the
 *     confidence-gated text match yields a primary; or
 *   - returns `HEADING_NOT_FOUND` with up to 3 structural-proximity
 *     candidates when no text match is available.
 *
 * Always stamps `_meta.fuzzy_algorithm` so callers can distinguish a
 * fuzzy-resolved response from a fresh-success response.
 */
async function resolveStaleStableId(
	history: HeadingHistoryRow,
	parsed: ParsedFile,
	sizeBytes: number,
	requestedStableId: string,
	meta: MetaEnvelope,
	vaultRoot: VaultRoot,
	vaultIndex: VaultFileIndex | undefined,
	expandEmbedsOpt: ExpandEmbedsOption | undefined,
	includeHidden: boolean,
): Promise<ToolSuccessEnvelope<FragmentResult> | ToolErrorEnvelope> {
	const recovery = recoverStaleStableId({ history, currentHeadings: parsed.headings });
	const candidates = recovery.others.map((c) => ({
		stable_id: c.heading.stable_id,
		heading_path: c.heading.headingPath,
		score: c.score,
	}));
	const fuzzyMeta = { ...meta, fuzzy_algorithm: FUZZY_ALGORITHM_ID };
	if (recovery.primary !== null) {
		const fragment = buildHeadingFragment(recovery.primary.heading, parsed, sizeBytes, "stale", vaultIndex);
		fragment.requested_stable_id = requestedStableId;
		if (candidates.length > 0) fragment.fuzzy_candidates = candidates;
		await maybeExpandEmbeds(fragment, expandEmbedsOpt, vaultRoot, vaultIndex, includeHidden);
		return successEnvelope(fragment, fuzzyMeta, { renderText: renderFragment });
	}
	return headingNotFoundEnvelope(
		{
			message: `stable_id ${requestedStableId} not recoverable: heading text no longer present.`,
			param: "stable_id",
			requested_stable_id: requestedStableId,
			stable_id_status: "stale",
			candidates,
			suggestion: "Call get_file_outline(file) and choose a current heading.",
		},
		fuzzyMeta,
	);
}

// ─── Fragment builders ────────────────────────────────────────────────────

function buildHeadingFragment(
	heading: HeadingMeta,
	parsed: ParsedFile,
	sizeBytes: number,
	status: "fresh" | "stale",
	vaultIndex: VaultFileIndex | undefined,
): HeadingFragment {
	const content = parsed.source.slice(heading.offsetRange.start, heading.offsetRange.end);
	const { outgoing, embeds } = buildLinksAndEmbeds(
		parsed,
		heading.offsetRange.start,
		heading.offsetRange.end,
		vaultIndex,
	);
	return {
		anchor_kind: "heading",
		file: parsed.relpath,
		content,
		bodyTokensApprox: estimateTokens(content),
		file_size_bytes: sizeBytes,
		outgoing_links: outgoing,
		embeds,
		stable_id: heading.stable_id,
		stable_id_status: status,
		heading_path: heading.headingPath,
		slug_path: heading.slug,
		level: heading.level,
	};
}

function buildPreambleFragment(
	parsed: ParsedFile,
	sizeBytes: number,
	vaultIndex: VaultFileIndex | undefined,
): PreambleFragment {
	const start = parsed.preamble?.offsetRange.start ?? 0;
	const end = parsed.preamble?.offsetRange.end ?? 0;
	const content = parsed.preamble ? parsed.source.slice(start, end) : "";
	const { outgoing, embeds } = buildLinksAndEmbeds(parsed, start, end, vaultIndex);
	return {
		anchor_kind: "preamble",
		file: parsed.relpath,
		content,
		bodyTokensApprox: estimateTokens(content),
		file_size_bytes: sizeBytes,
		outgoing_links: outgoing,
		embeds,
	};
}

function buildBlockFragment(
	block: BlockMeta,
	parsed: ParsedFile,
	sizeBytes: number,
	vaultIndex: VaultFileIndex | undefined,
): BlockFragment {
	const raw = parsed.source.slice(block.offsetRange.start, block.offsetRange.end);
	// Extract wikilinks from `raw` BEFORE stripping the marker — the strip
	// can excise chars mid-`raw` (nested-list parent: ` ^p` between the
	// parent text and its sub-list), which would shift every downstream
	// `m.index` out of sync with `parsed.excludedRanges` (absolute source
	// offsets) and leak code-span wikilinks in child items as graph edges.
	// Marker text is `[a-zA-Z0-9-]+` so the wikilink regex matches nothing
	// inside `^${id}` — running over `raw` is safe.
	const { outgoing, embeds } = buildLinksAndEmbeds(parsed, block.offsetRange.start, block.offsetRange.end, vaultIndex);
	const content = stripBlockIdMarker(raw, block.id);
	const result: BlockFragment = {
		anchor_kind: "block",
		file: parsed.relpath,
		content,
		bodyTokensApprox: estimateTokens(content),
		file_size_bytes: sizeBytes,
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

function buildFileFragment(
	parsed: ParsedFile,
	sizeBytes: number,
	vaultIndex: VaultFileIndex | undefined,
): FileFragment {
	// File fragment excludes frontmatter (Brief decision matrix line 785).
	const start = fileBodyStartOffset(parsed);
	const content = parsed.source.slice(start);
	const end = parsed.source.length;
	const { outgoing, embeds } = buildLinksAndEmbeds(parsed, start, end, vaultIndex);
	return {
		anchor_kind: "file",
		file: parsed.relpath,
		content,
		bodyTokensApprox: estimateTokens(content),
		file_size_bytes: sizeBytes,
		outgoing_links: outgoing,
		embeds,
	};
}

// ─── Outgoing + embed extraction/resolution helper ────────────────────────

function buildLinksAndEmbeds(
	parsed: ParsedFile,
	start: number,
	end: number,
	vaultIndex: VaultFileIndex | undefined,
): { outgoing: OutgoingLink[]; embeds: Embed[] } {
	const slice = parsed.source.slice(start, end);
	const extracted = extractWikilinks({
		source: slice,
		sliceStart: start,
		excludedRanges: parsed.excludedRanges,
	});
	const outgoing: OutgoingLink[] = [];
	const embeds: Embed[] = [];
	for (const e of extracted) {
		const resolved: ResolvedWikilink = vaultIndex
			? resolveWikilink(e.rawTarget, parsed.relpath, vaultIndex)
			: { rawTarget: e.rawTarget, resolved: false };
		if (e.isEmbed) embeds.push(buildEmbed(e, resolved));
		else outgoing.push(buildOutgoingLink(e, resolved));
	}
	return { outgoing, embeds };
}

// ─── Embed expansion ──────────────────────────────────────────────────────

function computeMaxDepth(opt: ExpandEmbedsOption | undefined): number {
	if (opt === true) return MAX_EMBED_DEPTH;
	if (opt && typeof opt === "object") {
		const requested = opt.max_depth ?? MAX_EMBED_DEPTH;
		return Math.min(Math.max(1, requested), MAX_EMBED_DEPTH);
	}
	return 0;
}

/**
 * Walk `fragment.embeds` and expand each. Mutates the embed objects in
 * place: sets `expanded`, `expanded_content`, and `expansion_error`. No-op
 * when `maxDepth === 0` (i.e., `expand_embeds` was `false` / `undefined`)
 * or when `vaultIndex === undefined`.
 *
 * Loader is memoized per call so cycle-detected re-visits are cheap.
 */
async function maybeExpandEmbeds(
	fragment: FragmentResult,
	opt: ExpandEmbedsOption | undefined,
	vaultRoot: VaultRoot,
	vaultIndex: VaultFileIndex | undefined,
	includeHidden: boolean,
): Promise<void> {
	const maxDepth = computeMaxDepth(opt);
	if (maxDepth <= 0 || !vaultIndex) return;
	if (fragment.embeds.length === 0) return;

	const fileCache = new Map<string, ParsedFile | null>();
	const loadFile = async (relpath: string): Promise<ParsedFile | null> => {
		if (fileCache.has(relpath)) return fileCache.get(relpath) ?? null;
		try {
			const safePath = await validatePath(relpath, vaultRoot);
			const note = await readNote(safePath, {}, includeHidden);
			fileCache.set(relpath, note.parsed);
			return note.parsed;
		} catch {
			fileCache.set(relpath, null);
			return null;
		}
	};
	const ctx: EmbedExpansionContext = {
		vaultIndex,
		vaultRoot,
		loadFile,
		// Seed `visited` with the host fragment so `a → b → a` is detected
		// at the second `a` rather than one level deeper. An empty seed
		// would let b's `![[a]]` re-expand the host body inside b's
		// content, with the cycle tripping only at the next `b` reference.
		visited: new Set<string>([makeFragmentCycleKey(fragment)]),
		maxDepth,
		includeHidden,
	};

	for (const embed of fragment.embeds) {
		// Re-resolve to recover the internal `headingResolutionFailed` flag
		// (not on the persisted `Embed`); without it `![[note#missing]]`
		// falls through to whole-file expansion.
		const resolved = resolveWikilink(embed.raw_target, fragment.file, vaultIndex);
		const result = await expandEmbed(resolved, fragment.file, ctx, 1);
		embed.expanded = result.expanded;
		if (result.expanded_content !== undefined) embed.expanded_content = result.expanded_content;
		if (result.expansion_error !== undefined) embed.expansion_error = result.expansion_error;
	}
}
