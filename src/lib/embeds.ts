/**
 * Recursive `![[embed]]` expansion with cycle detection (obsidian-export
 * algorithm).
 *
 * Public surface is `expandEmbed`, called by `getFragment` once per
 * top-level embed when `expand_embeds` is requested. Recursion handles
 * embeds-within-embeds; the `visited` set keys on
 * `targetFile + "#" + heading_path + "^" + block_id` so a single file
 * can host multiple distinct embeds without false-positive cycles.
 *
 * Hard cap depth 10. Values >10 from the request are clamped at the
 * call site (`getFragment.ts`); this module trusts the caller's
 * `maxDepth` and uses it as the limit.
 *
 * `bodyTokensApprox` semantics (D11): unaffected by expansion. The
 * source body is what we count; expanded content is supplementary.
 */

import { stat } from "node:fs/promises";
import { posix } from "node:path";

import type { ExpansionError, FragmentResult } from "../types.js";
import { stripBlockIdMarker } from "./blockIds.js";
import { getErrnoCode } from "./error.js";
import { isHiddenPath } from "./hiddenPath.js";
import { fileBodyStartOffset, type HeadingMeta, headingPathsEqual, type ParsedFile } from "./parser.js";
import { PathValidationError, type VaultRoot, validatePath } from "./validatePath.js";
import { isAssetPath, isMarkdownPath } from "./vaultExtensions.js";
import {
	extractWikilinks,
	parseTarget,
	type ResolvedWikilink,
	resolveSourceRelative,
	resolveWikilink,
	type VaultFileIndex,
} from "./wikilinks.js";

export interface EmbedExpansionContext {
	vaultIndex: VaultFileIndex;
	/** Vault root for the asset-existence probe (non-markdown `![[asset.png]]`). */
	vaultRoot: VaultRoot;
	/** Memoized loader. Returns `null` on read/parse failure. */
	loadFile: (relpath: string) => Promise<ParsedFile | null>;
	/** Cycle-detection set. Caller seeds with the host fragment's
	 * {@link makeFragmentCycleKey} and reuses across all embeds in
	 * one fragment so embeds within the parent are also cycle-protected. */
	visited: Set<string>;
	maxDepth: number;
}

interface ExpansionResult {
	expanded: boolean;
	expanded_content?: string;
	expansion_error?: ExpansionError;
}

/**
 * Expand one embed. Pure: returns whether expansion succeeded plus the
 * expanded content (or the failure reason). Callers apply the result to
 * their `Embed` row.
 *
 * `sourceFile` is the markdown file that emitted this embed — needed to
 * resolve `./X` and `../X` asset paths against the source's directory
 * (mirrors wikilinks.ts Phase 0). Recursive embed expansion threads the
 * inner-source file through so nested asset probes resolve relative to
 * THEIR host, not the original.
 */
export async function expandEmbed(
	resolved: ResolvedWikilink,
	sourceFile: string,
	ctx: EmbedExpansionContext,
	depth: number,
): Promise<ExpansionResult> {
	if (depth > ctx.maxDepth) {
		return { expanded: false, expansion_error: "max_depth_exceeded" };
	}
	if (!resolved.resolved) {
		// The markdown index doesn't track non-markdown assets, so probe the
		// filesystem before declaring `![[image.png]]` missing — separates
		// "asset doesn't exist" from "asset exists but is non-markdown."
		if (await assetExistsOnDisk(resolved.rawTarget, ctx.vaultRoot, sourceFile)) {
			return { expanded: false, expansion_error: "non_markdown_target" };
		}
		const candidates = resolved.candidates ?? [];
		const err: ExpansionError = candidates.length > 1 ? "ambiguous_file" : "unresolved_file";
		return { expanded: false, expansion_error: err };
	}
	const targetFile = resolved.targetFile;
	if (targetFile === undefined) {
		return { expanded: false, expansion_error: "unresolved_file" };
	}
	if (!isMarkdownPath(targetFile)) {
		return { expanded: false, expansion_error: "non_markdown_target" };
	}
	// `![[Note#Missing]]`: file resolved but heading didn't. Distinct from a
	// heading-less embed (which legitimately slices the whole file).
	if (resolved.headingResolutionFailed) {
		return { expanded: false, expansion_error: "unresolved_heading" };
	}
	const cycleKey = makeCycleKey(
		targetFile,
		resolved.targetHeadingPath,
		resolved.targetBlockId,
		resolved.targetStableId,
	);
	if (ctx.visited.has(cycleKey)) {
		return { expanded: false, expansion_error: "cycle_detected" };
	}

	const parsed = await ctx.loadFile(targetFile);
	if (parsed === null) {
		return { expanded: false, expansion_error: "unresolved_file" };
	}

	const slice = sliceTarget(parsed, resolved.targetHeadingPath, resolved.targetBlockId);
	if (slice === null) {
		if (resolved.targetBlockId !== undefined) {
			return { expanded: false, expansion_error: "unresolved_block" };
		}
		if (resolved.targetHeadingPath !== undefined) {
			return { expanded: false, expansion_error: "unresolved_heading" };
		}
		return { expanded: false, expansion_error: "unresolved_file" };
	}

	ctx.visited.add(cycleKey);
	try {
		let expandedContent = await recursivelyExpandSlice(slice, parsed, targetFile, ctx, depth + 1);
		if (slice.blockId !== undefined) {
			expandedContent = stripBlockIdMarker(expandedContent, slice.blockId);
		}
		return { expanded: true, expanded_content: expandedContent };
	} finally {
		ctx.visited.delete(cycleKey);
	}
}

interface Slice {
	/** Slice content (substring of `parsed.source`). */
	content: string;
	/** Absolute offset of `content[0]` within `parsed.source`. */
	start: number;
	/**
	 * Block ID whose trailing `^id` marker should be stripped from the
	 * final content. Set only for block slices. The strip runs AFTER
	 * recursive expansion so excludedRanges (parent-absolute offsets)
	 * align with `sliceStart + m.index` during nested wikilink extraction.
	 * Pre-strip would shift offsets for listItem blocks whose
	 * `offsetRange.end` covers nested sub-lists past the marker, leaking
	 * inline-code wikilinks as real embeds.
	 */
	blockId?: string;
}

function sliceTarget(parsed: ParsedFile, headingPath: string[] | undefined, blockId: string | undefined): Slice | null {
	if (blockId !== undefined) {
		const block = parsed.blocks.find((b) => b.id === blockId);
		if (!block) return null;
		return {
			content: parsed.source.slice(block.offsetRange.start, block.offsetRange.end),
			start: block.offsetRange.start,
			blockId: block.id,
		};
	}
	if (headingPath !== undefined && headingPath.length > 0) {
		const heading = findHeadingByPath(parsed.headings, headingPath);
		if (!heading) return null;
		return {
			content: parsed.source.slice(heading.offsetRange.start, heading.offsetRange.end),
			start: heading.offsetRange.start,
		};
	}
	// Whole file (post-frontmatter).
	const start = fileBodyStartOffset(parsed);
	return {
		content: parsed.source.slice(start),
		start,
	};
}

function findHeadingByPath(headings: ReadonlyArray<HeadingMeta>, path: string[]): HeadingMeta | undefined {
	if (path.length === 0) return undefined;
	return headings.find((h) => headingPathsEqual(h.headingPath, path));
}

function makeCycleKey(
	file: string,
	headingPath: string[] | undefined,
	blockId: string | undefined,
	stableId: string | undefined,
): string {
	if (stableId !== undefined) {
		// D27 stable_id uniquely identifies a heading slot, so duplicate
		// heading texts (`# A ... # A`) get distinct ids. A (file,
		// heading_path) key would collapse both — Obsidian first-match
		// resolves `![[#A]]` to the first section regardless of source,
		// so expanding from the second section's body would falsely trip
		// the visited check seeded by the host on the same heading_path.
		return `${file}#h:${stableId}^${blockId ?? ""}`;
	}
	return `${file}#${JSON.stringify(headingPath ?? [])}^${blockId ?? ""}`;
}

/**
 * Cycle key for a {@link FragmentResult} host. Callers seed `visited`
 * with this before expanding the host's embeds — without the seed,
 * `a → b → a` recurses one level too deep and the host body appears
 * recursively inside b's expansion. The discriminator switch lives
 * here so the format definition stays a single source of truth; an
 * exhaustive switch lets TypeScript flag a missing case if the
 * `FragmentResult` union grows.
 */
export function makeFragmentCycleKey(fragment: FragmentResult): string {
	switch (fragment.anchor_kind) {
		case "heading":
			// `stable_id` is always present on HeadingFragment (resolved or
			// fuzzy-recovered) — discriminates duplicate-heading sections.
			return makeCycleKey(fragment.file, fragment.heading_path, undefined, fragment.stable_id);
		case "block":
			// `block_id` is unique within the file (Obsidian first-match),
			// so it alone discriminates without needing a stable_id.
			return makeCycleKey(fragment.file, undefined, fragment.block_id, undefined);
		case "preamble":
		case "file":
			return makeCycleKey(fragment.file, undefined, undefined, undefined);
	}
}

async function recursivelyExpandSlice(
	slice: Slice,
	parsed: ParsedFile,
	parsedFile: string,
	ctx: EmbedExpansionContext,
	depth: number,
): Promise<string> {
	// Find child `![[…]]` embeds in slice. extractWikilinks's `sliceStart`
	// arg is the slice's absolute offset so excludedRanges (which carry
	// parent-absolute offsets) are checked correctly.
	const extracted = extractWikilinks({
		source: slice.content,
		sliceStart: slice.start,
		excludedRanges: parsed.excludedRanges,
	});
	const replacements: Array<{ start: number; end: number; replacement: string }> = [];
	for (const e of extracted) {
		if (!e.isEmbed) continue;
		const childResolved = resolveWikilink(e.rawTarget, parsedFile, ctx.vaultIndex);
		const childResult = await expandEmbed(childResolved, parsedFile, ctx, depth);
		if (childResult.expanded && childResult.expanded_content !== undefined) {
			const sliceRelStart = e.absoluteOffset - slice.start;
			replacements.push({
				start: sliceRelStart,
				end: sliceRelStart + e.matchLength,
				replacement: childResult.expanded_content,
			});
		}
		// On failure: leave the source `![[…]]` text in place so the agent
		// sees the original embed reference. The error is surfaced
		// separately via `embeds[].expansion_error` on the parent fragment.
	}
	// Apply replacements right-to-left to keep earlier offsets valid.
	replacements.sort((a, b) => b.start - a.start);
	let out = slice.content;
	for (const r of replacements) {
		out = `${out.slice(0, r.start)}${r.replacement}${out.slice(r.end)}`;
	}
	return out;
}

/**
 * Filesystem probe for `![[asset.png]]`-style embeds — distinguishes "asset
 * exists, non-markdown" from "asset missing." Uses `stat` (not `lstat`) so
 * symlinked image stores resolve; `validatePath`'s segment-walk lstat has
 * already rejected any symlinked PARENT in the path.
 */
async function assetExistsOnDisk(rawTarget: string, vaultRoot: VaultRoot, sourceFile: string): Promise<boolean> {
	const { filePart } = parseTarget(rawTarget);
	if (filePart.length === 0) return false;
	if (!isAssetPath(filePart)) return false;

	// Bare filenames probe source-relative first then vault-root —
	// approximation of Obsidian's "shortest path that uniquely identifies"
	// for the common case of an image colocated with its host note. Full
	// shortest-path resolution would need a non-markdown asset basename
	// index; deferred.
	const candidates: string[] = [];
	if (filePart.startsWith("./") || filePart.startsWith("../")) {
		const base = resolveSourceRelative(filePart, sourceFile);
		if (base === null) return false; // vault-escape or empty
		candidates.push(base);
	} else if (!filePart.includes("/")) {
		// Bare filename — source-relative first, then vault-root fallback.
		const sourceDir = posix.dirname(sourceFile);
		if (sourceDir !== "." && sourceDir !== "") {
			candidates.push(`${sourceDir}/${filePart}`);
		}
		candidates.push(filePart);
	} else {
		// Slash-bearing input (`![[folder/image.png]]`): vault-root-relative
		// explicit path. Source-relative would mask the explicit-path
		// semantic and silently resolve to a colocated subfolder.
		candidates.push(filePart);
	}

	for (const candidate of candidates) {
		try {
			const safe = await validatePath(candidate, vaultRoot);
			// Hidden-path policy is server-wide ("all-or-nothing per server").
			// Without this gate the probe would distinguish hidden-asset
			// existence from missing via the `non_markdown_target` vs
			// `unresolved_file` discriminator. validatePath itself doesn't
			// enforce hidden — that lives in readSource for markdown reads;
			// mirror it here.
			if (isHiddenPath(safe.relative)) continue;
			const st = await stat(safe.absolute);
			if (st.isFile()) return true;
		} catch (err) {
			// Path-domain rejections (containment, traversal, hidden) and the
			// expected filesystem errno codes all map to "not found." Narrow
			// the catch so genuine bugs (TypeError, etc.) still surface.
			if (err instanceof PathValidationError) continue;
			const code = getErrnoCode(err);
			if (code === "ENOENT" || code === "ENOTDIR" || code === "EACCES" || code === "ELOOP") continue;
			throw err;
		}
	}
	return false;
}
