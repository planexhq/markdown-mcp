/**
 * Wikilink + embed extraction and Obsidian-style resolution. Shared by
 * the scanner (per-section persistence), `get_links` (resolution at
 * read time), and `get_fragment` (outgoing-link population +
 * embed-expansion seed).
 *
 * Extraction is pure regex over the source slice; resolution is a query
 * against an in-memory {@link VaultFileIndex} adapter, implemented on
 * `IndexHandle` with a snapshot-cached basename map.
 *
 * `link_ordinal` per D34 is "1-based within source section, document
 * order." Each call to {@link extractWikilinks} returns ordinals 1..N
 * for one section's slice; callers scope the slice (heading body,
 * preamble body, file body) so per-section semantics fall out naturally.
 */

import { extname, posix } from "node:path";
import type { Embed, EmbedKind, OutgoingLink } from "../types.js";
import { type ExcludedRange, isInsideAny } from "./blockIds.js";
import { normalizeHeadingText } from "./parser.js";
import { getVaultExtensions, isAssetPath, isLinkableExtension, isResolvableLinkTarget } from "./vaultExtensions.js";

// ─── Extraction ────────────────────────────────────────────────────────────

const WIKILINK_RE = /(!)?\[\[([^\]\n]+)\]\]/g;

export interface ExtractedWikilink {
	/** Inner `[[…]]` text (everything between the brackets, alias and fragment included). */
	raw: string;
	/** Target portion (before the optional `|alias`). */
	rawTarget: string;
	/** Display alias when the source used `[[Target|Alias]]`. */
	alias?: string;
	/** True for `![[…]]` (embed). */
	isEmbed: boolean;
	/** Source-absolute byte offset of the first `[` (or `!` for embeds). */
	absoluteOffset: number;
	/** Full match length including `!` and brackets — caller can splice with `[absoluteOffset, absoluteOffset+matchLength)`. */
	matchLength: number;
	/** 1-based document-order index within this extraction call (D34). */
	ordinalInSection: number;
}

export interface ExtractWikilinksArgs {
	source: string;
	sliceStart: number;
	excludedRanges: ReadonlyArray<ExcludedRange>;
}

/**
 * Single-pass scan of `source` for wikilinks, skipping matches whose
 * absolute offset falls inside `excludedRanges` (code spans / math).
 * Backslash-escaped openers (`\[[X]]`) are skipped — Obsidian honors the
 * CommonMark §2.4 rule that an odd backslash count immediately before
 * the match makes the syntax inert.
 *
 * Returns ordinal 1..N in document order so callers can persist
 * `link_ordinal` directly without re-numbering.
 */
export function extractWikilinks(args: ExtractWikilinksArgs): ExtractedWikilink[] {
	const { source, sliceStart, excludedRanges } = args;
	const out: ExtractedWikilink[] = [];
	let ord = 0;
	for (const m of source.matchAll(WIKILINK_RE)) {
		if (m.index === undefined) continue;
		const absoluteOffset = sliceStart + m.index;
		if (isInsideAny(absoluteOffset, excludedRanges)) continue;
		if (isBackslashEscaped(source, m.index)) continue;
		const inner = m[2] ?? "";
		const pipeIdx = inner.indexOf("|");
		// Canonicalize at extraction so the SQL prefilter in
		// `listIncomingCandidates` can match `[[ Target ]]` and
		// `[[Target #Heading]]` against canonical candidates without a
		// per-row UDF callback. Trim mirrors `parseTarget`'s filePart trim;
		// `\s*#\s*` is the equivalent for the heading separator. Pipe-split
		// happens above so `|` never appears in rawTarget. NFC mirrors the
		// vault-path canonical form (watcher / scanner reject NFD via
		// `isNonNfc`) — without it, `[[Cafe\u0301]]` lower-cases to NFD and
		// misses both NFC-keyed `filesByBasename` lookups and the SQL LIKE
		// against canonical target basenames.
		const innerCanon = (pipeIdx >= 0 ? inner.slice(0, pipeIdx) : inner)
			.trim()
			.normalize("NFC")
			.replace(/\s*#\s*/, "#");
		// Collapse REDUNDANT dot segments (`./../X`, `.././X`, `X/./Y`,
		// `X/../Y`) so stored `raw_target` matches `computeIncomingCandidates`
		// — the prefilter only enumerates canonical `./form` / `../form`,
		// and a redundant-dot source like `[[./../target]]` would
		// otherwise miss its backlink row. PRESERVE a leading `./` marker:
		// `./X` is Phase 0 (source-relative), `X` (post-`posix.normalize`)
		// is Phase 2/3 (basename) — collapsing it is a semantic change.
		// resolveSourceRelative already normalizes internally, so outgoing
		// resolution is unaffected.
		const fragmentIdx = innerCanon.indexOf("#");
		const filePartRaw = fragmentIdx >= 0 ? innerCanon.slice(0, fragmentIdx) : innerCanon;
		let rawTarget = innerCanon;
		// Quick-reject: only run posix.normalize when the input contains
		// at least one dot segment (`.` or `..`). Skips the call for the
		// common `[[X]]` / `[[folder/note]]` shape.
		if (filePartRaw.length > 0 && (filePartRaw.includes("./") || filePartRaw.includes("/."))) {
			const filePartNorm = posix.normalize(filePartRaw);
			// posix.normalize strips a leading `./`. Re-prepend it when input
			// started with `./` and the result is a bare relpath (not
			// `..`-prefixed, not pure `.`).
			const needsLeadingDotSlash =
				filePartRaw.startsWith("./") &&
				!filePartNorm.startsWith("./") &&
				!filePartNorm.startsWith("../") &&
				filePartNorm !== ".";
			const canonicalFilePart = needsLeadingDotSlash ? `./${filePartNorm}` : filePartNorm;
			if (canonicalFilePart !== filePartRaw) {
				rawTarget = fragmentIdx >= 0 ? canonicalFilePart + innerCanon.slice(fragmentIdx) : canonicalFilePart;
			}
		}
		const alias = pipeIdx >= 0 ? inner.slice(pipeIdx + 1) : undefined;
		const isEmbed = m[1] === "!";
		ord++;
		const link: ExtractedWikilink = {
			raw: inner,
			rawTarget,
			isEmbed,
			absoluteOffset,
			matchLength: m[0]?.length ?? 0,
			ordinalInSection: ord,
		};
		if (alias !== undefined) link.alias = alias;
		out.push(link);
	}
	return out;
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

// ─── Embed kind classifier ────────────────────────────────────────────────

const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "svg", "webp"]);
const MEDIA_EXTS = new Set(["mp3", "mp4", "mov", "webm", "wav", "m4a", "ogg"]);

/**
 * Classify embed target by extension. Strips Obsidian fragment first
 * (`#page=2`, `#t=10`, `#Section`) — `extname("paper.pdf#page=2")` is
 * `.pdf#page=2`, which would mis-classify as `note`.
 */
export function guessEmbedKind(target: string): EmbedKind {
	const hashIdx = target.indexOf("#");
	const path = hashIdx >= 0 ? target.slice(0, hashIdx) : target;
	const ext = extname(path).slice(1).toLowerCase();
	if (ext === "") return "note";
	if (IMAGE_EXTS.has(ext)) return "image";
	if (ext === "pdf") return "pdf";
	if (MEDIA_EXTS.has(ext)) return "media";
	return "note";
}

// ─── Resolution ────────────────────────────────────────────────────────────

/**
 * Read-side adapter the resolver calls into. `IndexHandle` implements
 * this so the resolver doesn't need a SQLite import.
 *
 * Implementations should snapshot-cache the basename map — `resolveWikilink`
 * is called many times per `get_links` request and per-call SQL would
 * dominate the resolver's CPU.
 */
export interface VaultFileIndex {
	hasFile(relpath: string): boolean;
	/**
	 * Case-insensitive vault-relative path lookup. Returns the actual stored
	 * relpath (case preserved from disk) for the first match, or `null`.
	 * Mirrors `filesByBasename`'s case-insensitivity contract for path-bearing
	 * forms — `[[notes/auth]]` against an on-disk `Notes/Auth.md` should
	 * resolve symmetrically with the basename phase.
	 */
	findFileCi(relpath: string): string | null;
	/** Lowercase-basename (no extension) → matching relpaths, sorted shortest-first. */
	filesByBasename(name: string): ReadonlyArray<string>;
	/** Headings in `file` whose `heading_path` equals `path` (exact array equality). */
	headingsByPath(file: string, path: string[]): ReadonlyArray<{ stable_id: string; heading_path: string[] }>;
	/** Any heading in `file` whose own pathText equals `text`. Returns ordered by document position. */
	headingsByText(file: string, text: string): ReadonlyArray<{ stable_id: string; heading_path: string[] }>;
}

export interface ResolvedWikilink {
	rawTarget: string;
	resolved: boolean;
	targetFile?: string;
	targetHeadingPath?: string[];
	/**
	 * Slot-precise identifier of the matched target heading. Populated whenever
	 * the heading anchor resolved (Obsidian first-match semantics on duplicates).
	 * Lets `get_links` narrowing distinguish duplicate-heading sections sharing
	 * a `heading_path`.
	 */
	targetStableId?: string;
	targetBlockId?: string;
	duplicateHeading?: boolean;
	candidates?: Array<{ file: string; heading_path?: string[] }>;
	/**
	 * True when the wikilink had a `#heading` fragment but the heading didn't
	 * resolve in the target file. The file IS resolved (`targetFile` set), but
	 * `targetHeadingPath` is omitted by design — `get_links` UX wants the
	 * agent to see file-level resolution and re-query. Embed expansion
	 * MUST short-circuit on this flag instead of slicing the whole file.
	 */
	headingResolutionFailed?: true;
}

export interface ParsedTarget {
	filePart: string;
	heading?: string[];
	block?: string;
}

export function parseTarget(rawTarget: string): ParsedTarget {
	const hashIdx = rawTarget.indexOf("#");
	if (hashIdx < 0) return { filePart: rawTarget.trim() };
	const filePart = rawTarget.slice(0, hashIdx).trim();
	const fragment = rawTarget.slice(hashIdx + 1).trim();
	if (fragment.length === 0) return { filePart };
	if (fragment.startsWith("^")) return { filePart, block: fragment.slice(1) };
	const parts = fragment
		.split(/\s*>\s*/)
		.map((s) => normalizeHeadingText(s))
		.filter((s) => s.length > 0);
	return parts.length > 0 ? { filePart, heading: parts } : { filePart };
}

/**
 * Strip a leading `./` from a wikilink filePart. `[[./Target]]` is
 * Obsidian's same-directory shorthand; the resolver maps it to `Target`
 * before any vault lookup.
 */
export function stripDotSlash(s: string): string {
	return s.replace(/^\.\//, "");
}

/**
 * Resolve a `./X` or `../X` filePart against `sourceFile`'s directory.
 * Returns the vault-relative path, or `null` if the result is empty or
 * escapes the vault. Caller MUST have verified the `./`/`../` prefix —
 * non-relative input yields incorrect results.
 *
 * Used by both note-link resolution (`resolveFile` Phase 0) and embed
 * asset existence probing (`assetExistsOnDisk`). Both surfaces follow
 * the same Obsidian semantics; centralizing the path math keeps them
 * symmetric and makes future rule changes (e.g. tightened vault-escape
 * detection) a single edit.
 */
export function resolveSourceRelative(relativeFilePart: string, sourceFile: string): string | null {
	const sourceDir = posix.dirname(sourceFile);
	const joined = posix.normalize(posix.join(sourceDir === "." ? "" : sourceDir, relativeFilePart));
	if (joined === ".." || joined.startsWith("../") || joined.startsWith("/")) return null;
	const base = joined === "." ? "" : joined;
	return base.length === 0 ? null : base;
}

/**
 * Strip a trailing markdown extension from a relpath. Used for basename
 * lookup so `notes/auth.md` indexes as `auth` and `[[auth]]` matches.
 * Honors `VAULT_EXTENSIONS` so `target.txt` strips to `target` when txt
 * is configured — same predicate as indexing (single-predicate
 * file-content surface rule).
 */
export function stripMarkdownExt(relpath: string): string {
	if (!isResolvableLinkTarget(relpath)) return relpath;
	return relpath.slice(0, -extname(relpath).length);
}

export function basenameNoExt(relpath: string): string {
	const slash = relpath.lastIndexOf("/");
	const base = slash >= 0 ? relpath.slice(slash + 1) : relpath;
	return stripMarkdownExt(base).toLowerCase();
}

/**
 * Three-phase Obsidian-style resolver. Returns one outcome:
 *  - `resolved: true`  → exactly one file match (or unique shortest path),
 *    plus heading/block resolution within that file.
 *  - `resolved: false` → 0 matches OR ambiguous file match. `candidates`
 *    enumerates every plausible target so the caller can surface them.
 *
 * Block IDs are NOT validated against the target file's parsed `^id`
 * markers in v1 — we'd need to load and parse the target on every link.
 * The compose helper trusts the agent's wikilink and exposes
 * `target_block_id` so a downstream `get_fragment` call can fail with
 * `HEADING_NOT_FOUND` on a stale ref. (`expansion_error` for embeds is
 * still emitted on missing block via the parsed fragment from
 * `expandEmbed` — that path DOES load the target.)
 */
export function resolveWikilink(rawTarget: string, sourceFile: string, vaultIndex: VaultFileIndex): ResolvedWikilink {
	const parsed = parseTarget(rawTarget);
	// `[[ ]]`, `[[|alias]]`, `[[#]]` all parse to filePart="" with no
	// heading and no block. Without this guard, the same-file branch in
	// `resolveFile` would resolve them to a self-link with no anchor —
	// spurious row that surfaces as outgoing + backlink. `[[#Heading]]`
	// and `[[#^block]]` carry a real anchor and stay legitimate.
	if (parsed.filePart.length === 0 && parsed.heading === undefined && parsed.block === undefined) {
		return { rawTarget, resolved: false };
	}
	const fileMatch = resolveFile(parsed.filePart, sourceFile, vaultIndex);

	if (!fileMatch.resolved) {
		const result: ResolvedWikilink = { rawTarget, resolved: false };
		if (fileMatch.candidates && fileMatch.candidates.length > 0) {
			result.candidates = fileMatch.candidates.map((file) => ({ file }));
		}
		return result;
	}

	const target: ResolvedWikilink = {
		rawTarget,
		resolved: true,
		targetFile: fileMatch.file,
	};
	if (parsed.block !== undefined) {
		target.targetBlockId = parsed.block;
	}
	if (parsed.heading !== undefined) {
		const headingResolution = resolveHeading(fileMatch.file, parsed.heading, vaultIndex);
		if (!headingResolution.resolved) {
			// File found but heading not — still resolved at the file level so
			// `target_file` is populated. `targetHeadingPath` left unset; the
			// agent sees `target_file` without a heading and can re-query.
			// `headingResolutionFailed` lets `expandEmbed` distinguish this
			// from a heading-less embed (which legitimately slices the whole
			// file) and surface `unresolved_heading`.
			target.headingResolutionFailed = true;
			return target;
		}
		if (headingResolution.headingPath !== undefined) {
			target.targetHeadingPath = headingResolution.headingPath;
		}
		if (headingResolution.stableId !== undefined) {
			target.targetStableId = headingResolution.stableId;
		}
		if (headingResolution.duplicate) {
			target.duplicateHeading = true;
			if (headingResolution.candidates !== undefined) {
				target.candidates = headingResolution.candidates;
			}
		}
	}
	return target;
}

interface FileResolution {
	resolved: boolean;
	file: string;
	candidates?: ReadonlyArray<string>;
}

function resolveFile(filePart: string, sourceFile: string, vaultIndex: VaultFileIndex): FileResolution {
	if (filePart.length === 0) {
		// `[[#Heading]]` → same-file reference.
		return { resolved: true, file: sourceFile };
	}

	// Phase 0: source-relative `./` and `../`. From `notes/caller.md`,
	// `[[./target]]` must resolve against `notes/`, not vault root.
	if (filePart.startsWith("./") || filePart.startsWith("../")) {
		const base = resolveSourceRelative(filePart, sourceFile);
		if (base === null) return { resolved: false, file: "" };
		if (isResolvableLinkTarget(base)) {
			const found = vaultIndex.findFileCi(base);
			if (found !== null) return { resolved: true, file: found };
		} else if (extname(base) === "") {
			// Extensionless inputs only — non-markdown-extensioned forms
			// like `[[./diagram.png]]` must NOT resolve to a colliding
			// `diagram.png.md` (asset-shadowing). Unresolved here lets
			// `assetExistsOnDisk` surface the asset via `non_markdown_target`.
			const found = findFileWithVaultExt(vaultIndex, base);
			if (found !== null) return { resolved: true, file: found };
		}
		return { resolved: false, file: "" };
	}

	// Phase 1: explicit vault-root relpath (slash or extension present).
	if (filePart.includes("/") || isResolvableLinkTarget(filePart)) {
		// D46 — `[[notes/auth.yaml]]` enters via the slash branch even though
		// `isResolvableLinkTarget` rejects YAML; gate the direct-lookup so a
		// YAML target is left unresolved (asset path) instead of silently
		// landing in `wikilinks` as a resolved markdown link.
		if (isAssetPath(filePart)) return { resolved: false, file: "" };
		const direct = vaultIndex.findFileCi(filePart);
		if (direct !== null) return { resolved: true, file: direct };
		// Extensionless explicit path — try every configured `VAULT_EXTENSIONS`
		// so `[[notes/auth]]` finds `notes/auth.mdx` in mixed-extension vaults.
		if (extname(filePart) === "") {
			const found = findFileWithVaultExt(vaultIndex, filePart);
			if (found !== null) return { resolved: true, file: found };
		}
		// Phase 1.5: path-suffix lookup (Obsidian three-phase resolver).
		// `[[folder/note]]` should match `projects/folder/note.md` even when
		// vault-root lookup misses. Filter the basename bucket by suffix to
		// keep the candidate set O(B) (B = files-with-this-basename) instead
		// of scanning every file in the vault.
		if (filePart.includes("/")) {
			// Suffix lookup over the basename bucket would otherwise match
			// `projects/folder/diagram.png.md` for `[[folder/diagram.png]]`
			// (the index strips `.md`, so `endsWith("/folder/diagram.png")`
			// passes when the candidate sits deeper than the input).
			if (isAssetPath(filePart)) {
				return { resolved: false, file: "" };
			}
			const baseLower = basenameNoExt(filePart);
			const suffixLower = stripMarkdownExt(filePart).toLowerCase();
			// `[[folder/note.md]]` named a specific extension. Stripping
			// both sides would silently resolve to `projects/folder/note.mdx`
			// in mixed-extension vaults. Require an exact-extension match
			// when the link carried one; extensionless inputs
			// (`[[folder/note]]`) keep matching any configured extension.
			const explicitExt = isResolvableLinkTarget(filePart) ? extname(filePart).toLowerCase() : null;
			const bucket = vaultIndex.filesByBasename(baseLower);
			const matches: string[] = [];
			for (const cand of bucket) {
				if (!isResolvableLinkTarget(cand)) continue;
				const candNoExtLower = stripMarkdownExt(cand).toLowerCase();
				if (!candNoExtLower.endsWith(`/${suffixLower}`)) continue;
				if (explicitExt !== null && extname(cand).toLowerCase() !== explicitExt) continue;
				matches.push(cand);
			}
			if (matches.length === 1) return { resolved: true, file: matches[0] ?? "" };
			if (matches.length > 1) return { resolved: false, file: "", candidates: matches };
			return { resolved: false, file: "" };
		}
		// No slash + extension-bearing (`[[target.md]]`) falls through to
		// Phase 2/3 so `[[target]]` and `[[target.md]]` resolve symmetrically
		// (Obsidian "shortest match wins").
	}

	// Phase 2 + 3: basename match. `filesByBasename` returns shortest-first
	// per impl contract; if the shortest is unique, that wins (Obsidian
	// closest-to-root semantics). If multiple share the shortest length,
	// it's ambiguous and we surface every candidate. `filesByBasename` is
	// keyed on extensionless lowercase basename, so strip + lower the input.
	// `[[diagram.png]]` must not shadow `notes/diagram.png` via a
	// collision-named markdown file `notes/diagram.png.md` — the basename
	// index strips `.md`, so both share key `diagram.png`.
	if (isAssetPath(filePart)) {
		return { resolved: false, file: "" };
	}
	const matches = vaultIndex
		.filesByBasename(stripMarkdownExt(filePart).toLowerCase())
		.filter((f) => isResolvableLinkTarget(f));
	if (matches.length === 0) return { resolved: false, file: "" };
	if (matches.length === 1) return { resolved: true, file: matches[0] ?? "" };

	const first = matches[0] ?? "";
	const second = matches[1] ?? "";
	if (segmentLength(first) < segmentLength(second)) {
		return { resolved: true, file: first };
	}
	return { resolved: false, file: "", candidates: matches };
}

function segmentLength(relpath: string): number {
	return relpath.split("/").length;
}

/**
 * Try `${base}.${ext}` for every configured vault extension that's a valid
 * wikilink target — `isLinkableExtension` enforces the family rules
 * (markdown only; YAML and Prisma deferred). Hardcoding `.md`
 * would miss `notes/auth.mdx` in mixed-markdown-extension vaults.
 */
function findFileWithVaultExt(vaultIndex: VaultFileIndex, base: string): string | null {
	for (const ext of getVaultExtensions()) {
		if (!isLinkableExtension(ext)) continue;
		const found = vaultIndex.findFileCi(`${base}.${ext}`);
		if (found !== null) return found;
	}
	return null;
}

interface HeadingResolution {
	resolved: boolean;
	headingPath?: string[];
	stableId?: string;
	duplicate?: boolean;
	candidates?: Array<{ file: string; heading_path?: string[] }>;
}

function resolveHeading(file: string, heading: string[], vaultIndex: VaultFileIndex): HeadingResolution {
	// Brief §heading anchor: match the *first* heading whose normalized text
	// equals the anchor. For multi-segment (`A > B`) wikilinks, match by
	// exact `heading_path` array equality first; then fall back to last-
	// segment text match across the file (Obsidian commonly uses single-
	// segment anchors and we want to find a heading no matter where it lives
	// in the outline).
	if (heading.length > 1) {
		const matches = vaultIndex.headingsByPath(file, heading);
		if (matches.length === 0) {
			return { resolved: false };
		}
		const first = matches[0];
		if (!first) return { resolved: false };
		if (matches.length > 1) {
			return {
				resolved: true,
				headingPath: first.heading_path,
				stableId: first.stable_id,
				duplicate: true,
				candidates: matches.map((m) => ({ file, heading_path: m.heading_path })),
			};
		}
		return { resolved: true, headingPath: first.heading_path, stableId: first.stable_id };
	}

	const last = heading[heading.length - 1];
	if (last === undefined) return { resolved: false };
	const matches = vaultIndex.headingsByText(file, last);
	if (matches.length === 0) return { resolved: false };
	const first = matches[0];
	if (!first) return { resolved: false };
	if (matches.length > 1) {
		return {
			resolved: true,
			headingPath: first.heading_path,
			stableId: first.stable_id,
			duplicate: true,
			candidates: matches.map((m) => ({ file, heading_path: m.heading_path })),
		};
	}
	return { resolved: true, headingPath: first.heading_path, stableId: first.stable_id };
}

// ─── Shape adapters ────────────────────────────────────────────────────────

/**
 * Compose a public `OutgoingLink` from extraction + resolution. The two
 * are kept separate (rather than rolled into `extractWikilinks`) so the
 * scanner can persist raw extractions without paying the resolution
 * cost, and `getLinks` can re-resolve at read time off the persisted
 * row's `raw_target` for snapshot-fresh resolution.
 */
export function buildOutgoingLink(extracted: ExtractedWikilink, resolved: ResolvedWikilink): OutgoingLink {
	const link: OutgoingLink = {
		raw_target: extracted.rawTarget,
		link_text: extracted.alias ?? extracted.rawTarget,
		resolved: resolved.resolved,
		link_ordinal: extracted.ordinalInSection,
	};
	if (extracted.alias !== undefined) link.alias = extracted.alias;
	if (resolved.targetFile !== undefined) link.target_file = resolved.targetFile;
	if (resolved.targetHeadingPath !== undefined) link.target_heading_path = resolved.targetHeadingPath;
	if (resolved.targetBlockId !== undefined) link.target_block_id = resolved.targetBlockId;
	if (resolved.duplicateHeading) link.duplicate_heading = true;
	if (resolved.candidates !== undefined) link.candidates = resolved.candidates;
	return link;
}

/**
 * Compose an `Embed` from extraction + resolution. `expanded` defaults
 * to `false` and `expansion_error` is set only for known-pre-expansion
 * conditions (non-markdown target). Cycle / max-depth / unresolved-heading
 * etc. are set later by {@link expandEmbed}.
 */
export function buildEmbed(extracted: ExtractedWikilink, resolved: ResolvedWikilink): Embed {
	const kind = guessEmbedKind(extracted.rawTarget);
	const embed: Embed = {
		raw_target: extracted.rawTarget,
		kind,
		resolved: resolved.resolved,
		expanded: false,
	};
	if (resolved.targetFile !== undefined) embed.target_file = resolved.targetFile;
	if (resolved.targetHeadingPath !== undefined) embed.target_heading_path = resolved.targetHeadingPath;
	if (resolved.targetBlockId !== undefined) embed.target_block_id = resolved.targetBlockId;
	if (resolved.duplicateHeading) embed.duplicate_heading = true;
	if (resolved.candidates !== undefined) embed.candidates = resolved.candidates;
	return embed;
}
