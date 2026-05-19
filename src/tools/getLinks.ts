/**
 * `get_links` — backlinks (incoming) + forward links (outgoing) for a
 * file or specific section. `direction: in|out|both` (default `both`).
 *
 * Pattern mirrors `tools/search.ts:48-144`:
 *   1. validatePath
 *   2. cold/warming gate → `INDEX_WARMING` (incoming requires the
 *      `wikilinks` table populated by the scanner)
 *   3. narrowing: stable_id wins over heading_path; D32 fuzzy fallback
 *      on stale stable_id; heading_path with 0 matches returns empty
 *      arrays (NOT error)
 *   4. requestHash = sha1(file + direction + narrowKey) for cursor stability
 *   5. cursor decode/validate (`links-keyset-v1`)
 *   6. incoming: SQL pre-filter via candidate raw_target prefixes,
 *      then re-resolve in JS to confirm target match
 *   7. outgoing: SQL on `wikilinks WHERE source_file = :file …`
 *   8. direction:"both" emits incoming first, then outgoing per Brief
 *      line 354 ("incoming exhausts first"); cursor `phase` discriminates
 *      the leg
 */

import { createHash } from "node:crypto";

import {
	type CursorEnvelope,
	decodeOptionalCursor,
	encodeCursor,
	type LinksKeysetKey,
	parseHeadingPathJson,
} from "../lib/cursor.js";
import {
	headingAmbiguousEnvelope,
	headingNotFoundEnvelope,
	indexWarmingEnvelope,
	newMetaForHandler,
	successEnvelope,
	type ToolErrorEnvelope,
	type ToolSuccessEnvelope,
} from "../lib/error.js";
import { FUZZY_ALGORITHM_ID, recoverStaleStableId } from "../lib/fuzzy.js";
import type { IndexHandle, WikilinkRow } from "../lib/index/IndexHandle.js";
import { isIndexWarming } from "../lib/index_status.js";
import { clampPageSize, MAX_PAGE_SIZE, MAX_PATH_DEPTH } from "../lib/limits.js";
import { type HeadingMeta, headingPathsEqual, normalizeHeadingPath, type ParsedFile } from "../lib/parser.js";
import { assertNotePathPolicy, readNote } from "../lib/readNote.js";
import { renderLinks } from "../lib/renderText/getLinks.js";
import { type VaultRoot, validatePath } from "../lib/validatePath.js";
import { getVaultExtensions, YAML_EXTENSIONS } from "../lib/vaultExtensions.js";
import { resolveWikilink, stripMarkdownExt, type VaultFileIndex } from "../lib/wikilinks.js";
import type {
	GetLinksInput,
	GetLinksResult,
	HeadingCandidate,
	IncomingLink,
	LinkDirection,
	MetaEnvelope,
	OutgoingLinkRow,
	ResolvedAnchor,
	StableIdStatus,
} from "../types.js";
import { routeToolError } from "./routeError.js";

/**
 * Local narrowing state. `"missing"` is set when `heading_path` was
 * provided but matched no heading; `"preamble"` is set when caller
 * passed empty `heading_path: []` (preamble/file-level narrowing key).
 * Public `ResolvedAnchor.stable_id_status` is the narrower public union
 * — both internal sentinels project to `"fresh"` (preamble) or omit the
 * anchor entirely (missing).
 */
type LocalStableIdStatus = StableIdStatus | "missing" | "preamble";

interface Narrowing {
	/**
	 * `null` is the preamble/file-level narrowing key — matches rows
	 * stored with `source_heading_path_json IS NULL`. Empty
	 * `heading_path: []` from the agent normalizes to this, mirroring
	 * `get_fragment`'s `anchor: { kind: "heading_path", path: [] }`
	 * preamble case.
	 */
	headingPathJson: string | null;
	headingPath: string[];
	stableId?: string;
	requestedStableId?: string;
	stableIdStatus: LocalStableIdStatus;
}

export async function handleGetLinks(
	input: GetLinksInput,
	vaultRoot: VaultRoot,
	index: IndexHandle,
	includeHidden = false,
): Promise<ToolSuccessEnvelope<GetLinksResult> | ToolErrorEnvelope> {
	const meta = newMetaForHandler(index);
	try {
		// Permanent input errors (PATH_OUTSIDE_VAULT, PATH_NOT_FOUND for
		// missing/non-markdown extension) must surface before the transient
		// INDEX_WARMING gate, otherwise agents retry indefinitely against
		// permanently malformed requests. `readNote` is a bounded read and
		// safe during cold/warming.
		const safePath = await validatePath(input.file, vaultRoot);
		// Policy gates (extension / hidden / regular-file) must run on every
		// path — the `needsAst` skip below would otherwise let asset paths,
		// directories, or hidden files reach the SQL layer with an empty-
		// success result (and a hidden-existence side channel).
		await assertNotePathPolicy(safePath, includeHidden);
		const direction: LinkDirection = input.direction ?? "both";
		const isNarrowed = input.heading_path !== undefined || input.stable_id !== undefined;
		// Outgoing/incoming rows come from SQL wikilinks; AST is read only
		// for narrowing. Skipping it lets a temporarily-unparseable file
		// still serve its previously-indexed links.
		const needsAst = isNarrowed;
		let parsed: ParsedFile | null = null;
		if (needsAst) {
			const result = await readNote(safePath, {}, includeHidden);
			parsed = result.parsed;
		}

		const indexStatus = index.getStatus();
		if (isIndexWarming(indexStatus.state)) {
			// Vault-wide tool: incoming queries read from the `wikilinks` table
			// populated by the scanner. During `warming` the table is only
			// partially populated, so partial backlinks are worse than the
			// documented transient error.
			return indexWarmingEnvelope(meta, {
				filesIndexed: indexStatus.files_indexed,
				message: "Index is warming; backlinks not yet available.",
				suggestion: "Bounded reads (outline/fragment/metadata) work now; links waits for the initial scan.",
			});
		}

		const vaultIndex = index;
		const file = safePath.relative;

		const narrowResult: NarrowOk | NarrowError = parsed
			? await resolveNarrowing(input, parsed, index, meta)
			: NO_NARROWING;
		if (narrowResult.kind === "error") return narrowResult.envelope;
		const narrowing = narrowResult.narrowing;
		const fuzzyAlgoUsed = narrowResult.fuzzyApplied;

		const responseMeta: MetaEnvelope = fuzzyAlgoUsed ? { ...meta, fuzzy_algorithm: FUZZY_ALGORITHM_ID } : meta;

		const requestHash = computeRequestHash(file, direction, narrowing);
		const snapshotMtime = index.getSnapshot();
		const pageSize = clampPageSize(input.pageSize);
		const cursorEnv = decodeOptionalCursor(input.cursor, {
			expectedSort: "links-keyset-v1",
			currentRequestHash: requestHash,
			currentSnapshotMtime: snapshotMtime,
		});
		const cursorKey = cursorEnv?.after_key as LinksKeysetKey | undefined;

		const result: GetLinksResult = {};
		if (narrowing) {
			const anchor = buildResolvedAnchor(narrowing);
			if (anchor) result.resolved_anchor = anchor;
		}

		const wantOut = direction === "out" || direction === "both";
		const wantIn = direction === "in" || direction === "both";

		// `direction: "both"` emits incoming first, then outgoing per Brief
		// line 354 ("incoming exhausts first"). Cursor `phase` discriminates
		// the active leg so a continuation resumes in the right one.
		const cursorPhase = cursorKey?.phase;
		let lastEmitted: { phase: "out" | "in"; key: LinksKeysetKey } | null = null;

		const outRows: OutgoingLinkRow[] = [];
		const inRows: IncomingLink[] = [];
		let pageRemaining = pageSize;

		if (wantIn && (cursorPhase === undefined || cursorPhase === "in")) {
			const candidatePrefixes = computeIncomingCandidates(file);
			// `cursorPhase === "in"` is only ever set after a real incoming
			// row was emitted, so the cursor key is always a valid keyset
			// resume point (no in-phase start sentinel exists).
			let batchAfter: LinksKeysetKey | undefined = cursorPhase === "in" ? cursorKey : undefined;
			let lastScannedKey: LinksKeysetKey | null = null;
			let totalScanned = 0;
			let exhausted = false;
			// Pathological vaults (e.g. 10k self-link rows from `[[#X]]`
			// forms via the empty `""` candidate's `LIKE '#%'` clause) can
			// fill an entire batch with false positives. Loop batches until
			// we confirm enough rows, run out of candidates, or hit the
			// CPU cap. Without this, a request with 0 confirmed rows would
			// emit an empty page + cursor; clients that stop on empty pages
			// silently miss valid backlinks.
			while (
				inRows.length < pageRemaining &&
				totalScanned < INCOMING_SCAN_ABSOLUTE_CAP &&
				(inRows.length === 0 || totalScanned < INCOMING_SCAN_SOFT_CAP)
			) {
				const remaining = pageRemaining - inRows.length;
				const oversample = Math.min(remaining * 4, MAX_PAGE_SIZE);
				const rows = index.listIncomingCandidates({
					candidatePrefixes,
					pageSize: oversample + 1,
					...(batchAfter ? { after: batchAfter } : {}),
				});
				if (rows.length === 0) {
					exhausted = true;
					break;
				}
				let pageFilledMidBatch = false;
				for (const row of rows) {
					if (inRows.length >= pageRemaining) {
						// Page filled. Any remaining rows in this batch are
						// unprocessed — don't mark exhausted; emit cursor at
						// `lastScannedKey` so the next page resumes past the
						// last emitted row.
						pageFilledMidBatch = true;
						break;
					}
					const key = rowToKey(row);
					lastScannedKey = key;
					totalScanned++;
					const verdict = resolveAndCheck(row, vaultIndex, file, narrowing, parsed);
					if (!verdict) continue;
					inRows.push(buildIncomingRow(row));
					lastEmitted = { phase: "in", key };
				}
				if (!pageFilledMidBatch && rows.length <= oversample) {
					exhausted = true;
					break;
				}
				batchAfter = lastScannedKey ?? batchAfter;
			}
			pageRemaining -= inRows.length;
			if (!exhausted && lastScannedKey !== null) {
				// Cap hit OR more rows past the last batch → emit cursor at
				// the last scanned key so the client resumes scanning past
				// the false-positive cluster.
				const more = { phase: "in" as const, key: lastScannedKey };
				return finalize(result, outRows, inRows, responseMeta, more, requestHash, snapshotMtime, wantOut, wantIn);
			}
			// `direction: "both"` exact-page boundary: incoming filled the
			// page with no more in-phase rows. The wantOut gate below would
			// skip outgoing with no continuation cursor. Probe outgoing for
			// at least one row that respects narrowing (the SQL keyset is
			// narrowing-aware via source_stable_id / source_heading_path_json,
			// no false-positive scan needed).
			if (wantOut && pageRemaining === 0) {
				const probeRows = index.listOutgoingLinks({
					file,
					source_stable_id: narrowing?.stableId,
					source_heading_path_json: narrowing?.headingPathJson,
					pageSize: 1,
				});
				if (probeRows.length === 0) {
					return finalize(result, outRows, inRows, responseMeta, null, requestHash, snapshotMtime, wantOut, wantIn);
				}
				const sentinel = { phase: "out" as const, key: OUT_PHASE_START };
				return finalize(result, outRows, inRows, responseMeta, sentinel, requestHash, snapshotMtime, wantOut, wantIn);
			}
		}

		if (wantOut && pageRemaining > 0) {
			const after = cursorPhase === "out" && !isOutPhaseStart(cursorKey) ? cursorKey : undefined;
			// Pass both narrowing keys; `listOutgoingLinks` enforces the
			// stable_id-wins-over-heading_path precedence (single source of
			// truth — see IndexHandle.listOutgoingLinks).
			const rows = index.listOutgoingLinks({
				file,
				source_stable_id: narrowing?.stableId,
				source_heading_path_json: narrowing?.headingPathJson,
				pageSize: pageRemaining + 1, // +1 to detect "more remain"
				...(after ? { after } : {}),
			});
			const taken = rows.slice(0, pageRemaining);
			for (const row of taken) {
				outRows.push(buildOutgoingRow(row, vaultIndex, file));
				lastEmitted = { phase: "out", key: rowToKey(row) };
			}
			if (rows.length > pageRemaining && taken.length === pageRemaining) {
				return finalize(
					result,
					outRows,
					inRows,
					responseMeta,
					lastEmitted,
					requestHash,
					snapshotMtime,
					wantOut,
					wantIn,
				);
			}
		}

		return finalize(result, outRows, inRows, responseMeta, null, requestHash, snapshotMtime, wantOut, wantIn);
	} catch (err) {
		return routeToolError(err, "get_links", meta);
	}
}

function finalize(
	result: GetLinksResult,
	outgoing: OutgoingLinkRow[],
	incoming: IncomingLink[],
	meta: MetaEnvelope,
	moreFromKey: { phase: "out" | "in"; key: LinksKeysetKey } | null,
	requestHash: string,
	snapshotMtime: number,
	wantOut: boolean,
	wantIn: boolean,
): ToolSuccessEnvelope<GetLinksResult> {
	// Preserve the direction signal: a requested direction surfaces as an
	// array (possibly empty) so callers can distinguish "no results" from
	// "direction not queried". Omit `outgoing` only when it was requested
	// but the outgoing phase has not been visited and the page emits a
	// continuation cursor (incoming early-return OR boundary probe sentinel
	// — both share `outgoing.length === 0 && moreFromKey !== null`).
	// Setting `outgoing: []` here would let a client treat outgoing as
	// exhausted before the cursor reaches it. When `moreFromKey === null`,
	// outgoing was genuinely visited and any empty array is the truth.
	const outgoingUnvisited = wantOut && outgoing.length === 0 && moreFromKey !== null;
	if (wantOut && !outgoingUnvisited) result.outgoing = outgoing;
	if (wantIn) result.incoming = incoming;
	if (moreFromKey) {
		const env: CursorEnvelope = {
			v: 1,
			sort: "links-keyset-v1",
			request_hash: requestHash,
			snapshot_mtime: snapshotMtime,
			after_key: { ...moreFromKey.key, phase: moreFromKey.phase },
		};
		result.nextCursor = encodeCursor(env);
	}
	return successEnvelope(result, meta, { renderText: renderLinks });
}

interface NarrowError {
	kind: "error";
	envelope: ToolErrorEnvelope;
}
interface NarrowOk {
	kind: "ok";
	narrowing: Narrowing | null;
	fuzzyApplied: boolean;
}

const NO_NARROWING: NarrowOk = { kind: "ok", narrowing: null, fuzzyApplied: false };

async function resolveNarrowing(
	input: GetLinksInput,
	parsed: ParsedFile,
	index: IndexHandle,
	meta: MetaEnvelope,
): Promise<NarrowOk | NarrowError> {
	if (input.stable_id) {
		const normalized = input.stable_id.toLowerCase();
		const heading = parsed.headings.find((h) => h.stable_id === normalized);
		if (heading) {
			return {
				kind: "ok",
				narrowing: makeNarrowing(heading, "fresh", normalized, undefined),
				fuzzyApplied: false,
			};
		}
		const history = index.getHistoryRow(parsed.relpath, normalized);
		if (history !== null) {
			const recovery = recoverStaleStableId({ history, currentHeadings: parsed.headings });
			if (recovery.primary !== null) {
				return {
					kind: "ok",
					narrowing: makeNarrowing(
						recovery.primary.heading,
						"stale",
						recovery.primary.heading.stable_id,
						input.stable_id,
					),
					fuzzyApplied: true,
				};
			}
			const candidates = recovery.others.map((c) => ({
				stable_id: c.heading.stable_id,
				heading_path: c.heading.headingPath,
				score: c.score,
			}));
			const fuzzyMeta = { ...meta, fuzzy_algorithm: FUZZY_ALGORITHM_ID };
			return {
				kind: "error",
				envelope: headingNotFoundEnvelope(
					{
						message: `stable_id ${input.stable_id} not recoverable: heading text no longer present.`,
						param: "stable_id",
						requested_stable_id: input.stable_id,
						stable_id_status: "stale",
						candidates,
						suggestion: "Call get_file_outline(file) and choose a current heading.",
					},
					fuzzyMeta,
				),
			};
		}
		return {
			kind: "error",
			envelope: headingNotFoundEnvelope(
				{
					message: `stable_id ${input.stable_id} not found in current outline.`,
					param: "stable_id",
					requested_stable_id: input.stable_id,
					stable_id_status: "stale",
					candidates: [],
					suggestion: "Call get_file_outline(file) and choose a current heading.",
				},
				meta,
			),
		};
	}

	if (input.heading_path !== undefined) {
		const path = normalizeHeadingPath(input.heading_path);
		if (path.length === 0) {
			return {
				kind: "ok",
				narrowing: { headingPathJson: null, headingPath: [], stableIdStatus: "preamble" },
				fuzzyApplied: false,
			};
		}
		const matches = parsed.headings.filter((h) => headingPathsEqual(h.headingPath, path));
		if (matches.length === 0) {
			return {
				kind: "ok",
				narrowing: { headingPathJson: "<<no-match>>", headingPath: path, stableIdStatus: "missing" },
				fuzzyApplied: false,
			};
		}
		if (matches.length > 1) {
			const candidates: HeadingCandidate[] = matches.map((m) => ({
				stable_id: m.stable_id,
				heading_path: m.headingPath,
			}));
			return {
				kind: "error",
				envelope: headingAmbiguousEnvelope(
					{
						candidates,
						param: "heading_path",
						message: `Heading path "${path.join(" > ")}" matches ${matches.length} headings.`,
						suggestion: "Re-issue with `stable_id` (precise) or a deeper `heading_path`.",
					},
					meta,
				),
			};
		}
		const heading = matches[0];
		if (!heading) return NO_NARROWING;
		return {
			kind: "ok",
			narrowing: makeNarrowing(heading, "fresh", heading.stable_id, undefined),
			fuzzyApplied: false,
		};
	}

	return NO_NARROWING;
}

function makeNarrowing(
	heading: HeadingMeta,
	status: LocalStableIdStatus,
	stableId: string,
	requestedStableId: string | undefined,
): Narrowing {
	const result: Narrowing = {
		headingPathJson: JSON.stringify(heading.headingPath),
		headingPath: heading.headingPath,
		stableId,
		stableIdStatus: status,
	};
	if (requestedStableId !== undefined) result.requestedStableId = requestedStableId;
	return result;
}

/**
 * Returns null when `narrowing.stableIdStatus === "missing"` — a
 * `heading_path` narrowing miss returns empty arrays and OMITS
 * `resolved_anchor`. `"missing"` and `"preamble"` are internal
 * sentinels; ResolvedAnchor's public `stable_id_status` excludes both.
 * `"preamble"` projects to `"fresh"` and surfaces an
 * empty `heading_path: []` so agents can see the preamble was selected.
 */
function buildResolvedAnchor(n: Narrowing): ResolvedAnchor | null {
	if (n.stableIdStatus === "missing") return null;
	if (n.stableIdStatus === "preamble") {
		return { stable_id_status: "fresh", heading_path: [] };
	}
	const out: ResolvedAnchor = {
		stable_id_status: n.stableIdStatus,
	};
	if (n.stableId !== undefined) out.stable_id = n.stableId;
	if (n.requestedStableId !== undefined) out.requested_stable_id = n.requestedStableId;
	if (n.headingPath.length > 0) out.heading_path = n.headingPath;
	return out;
}

function buildOutgoingRow(row: WikilinkRow, vaultIndex: VaultFileIndex, sourceFile: string): OutgoingLinkRow {
	const resolved = resolveWikilink(row.raw_target, sourceFile, vaultIndex);
	const out: OutgoingLinkRow = {
		raw_target: row.raw_target,
		link_text: row.link_text,
		is_embed: row.is_embed === 1,
		resolved: resolved.resolved,
		link_ordinal: row.link_ordinal,
	};
	const sourceHeadingPath = parseHeadingPathJson(row.source_heading_path_json);
	if (sourceHeadingPath !== null) out.source_heading_path = sourceHeadingPath;
	if (row.alias !== null) out.alias = row.alias;
	if (resolved.targetFile !== undefined) out.target_file = resolved.targetFile;
	if (resolved.targetHeadingPath !== undefined) out.target_heading_path = resolved.targetHeadingPath;
	if (resolved.targetBlockId !== undefined) out.target_block_id = resolved.targetBlockId;
	if (resolved.duplicateHeading) out.duplicate_heading = true;
	if (resolved.candidates !== undefined) out.candidates = resolved.candidates;
	return out;
}

function buildIncomingRow(row: WikilinkRow): IncomingLink {
	const out: IncomingLink = {
		raw_target: row.raw_target,
		source_file: row.source_file,
		link_text: row.link_text,
		is_embed: row.is_embed === 1,
		link_ordinal: row.link_ordinal,
	};
	const sourceHeadingPath = parseHeadingPathJson(row.source_heading_path_json);
	if (sourceHeadingPath !== null) out.source_heading_path = sourceHeadingPath;
	if (row.source_stable_id !== null) out.source_stable_id = row.source_stable_id;
	if (row.alias !== null) out.alias = row.alias;
	return out;
}

/**
 * Confirm that an incoming candidate row truly targets `targetFile` (the
 * SQL pre-filter is a basename/path match; resolution may pick a
 * different file when the basename is ambiguous). Also enforces optional
 * narrowing — if `narrowing` is set, the row's resolved heading_path
 * must match.
 *
 * `targetParsed` is the queried file's parsed AST (only loaded when the
 * request is narrowed). For incoming links the queried file IS the
 * target, so `parsed.blockIndex` resolves `[[targetFile#^block-id]]` to
 * its containing heading without re-parsing.
 */
function resolveAndCheck(
	row: WikilinkRow,
	vaultIndex: VaultFileIndex,
	targetFile: string,
	narrowing: Narrowing | null,
	targetParsed: ParsedFile | null,
): boolean {
	const resolved = resolveWikilink(row.raw_target, row.source_file, vaultIndex);
	if (!resolved.resolved) return false;
	if (resolved.targetFile !== targetFile) return false;
	if (narrowing && narrowing.stableIdStatus === "missing") {
		// Narrowing miss → empty arrays. SQL may still return candidates;
		// drop them all.
		return false;
	}
	if (narrowing) {
		// Block-anchor link (`[[note#^block-id]]`): resolveWikilink
		// populates `targetBlockId` and skips the heading branch, leaving
		// `targetHeadingPath` undefined. Map block ID to its containing
		// heading via the queried file's `blockIndex` so section narrowing
		// surfaces these rows (otherwise common Obsidian block links are
		// silently dropped).
		if (resolved.targetHeadingPath === undefined && resolved.targetBlockId !== undefined && targetParsed !== null) {
			const entry = targetParsed.blockIndex[resolved.targetBlockId];
			if (entry === undefined) return false;
			if (narrowing.stableId !== undefined) {
				// Use the block's recorded containing stable_id directly.
				// `headings.find(by-path)` collides on duplicate headings
				// (D27 — same heading_path, distinct ids), mis-attributing
				// the row to the first heading match.
				return entry.containing_stable_id === narrowing.stableId;
			}
			return headingPathsEqual(entry.heading_path, narrowing.headingPath);
		}
		if (resolved.targetHeadingPath === undefined) {
			// `[[file#Missing]]` resolves at the file but not the heading;
			// it isn't a preamble link and shouldn't fold into one.
			if (resolved.headingResolutionFailed === true) return false;
			return narrowing.stableIdStatus === "preamble";
		}
		// Stable_id is slot-precise; on a file with duplicate headings sharing
		// `headingPath`, the path comparison would let both narrow buckets
		// match the same backlinks. Compare by stable_id whenever both sides
		// surface one (resolver populates `targetStableId` via Obsidian
		// first-match semantics).
		if (narrowing.stableId !== undefined && resolved.targetStableId !== undefined) {
			return resolved.targetStableId === narrowing.stableId;
		}
		if (!headingPathsEqual(resolved.targetHeadingPath, narrowing.headingPath)) return false;
	}
	return true;
}

/**
 * Soft cap on rows scanned during the incoming-link batch loop. Fires
 * only when at least one row has been confirmed — exiting empty +
 * cursor would let clients that stop on empty pages silently miss real
 * backlinks past a false-positive cluster. Bounds CPU on pathological
 * vaults (e.g. 10k self-link rows matching the empty `""` candidate's
 * `LIKE '#%'` clause) while still fitting more than enough true
 * positives in a single response.
 */
const INCOMING_SCAN_SOFT_CAP = MAX_PAGE_SIZE * 2;

/**
 * Absolute ceiling, 5× the soft cap. Bounds runaway scans on vaults
 * with 100% false-positive candidate prefixes. Empty page + cursor at
 * this level is acceptable — extreme pathology, not the common case.
 */
const INCOMING_SCAN_ABSOLUTE_CAP = INCOMING_SCAN_SOFT_CAP * 5;

/**
 * Sentinel cursor `after_key` for "resume outgoing from the start."
 * Emitted at the `direction: "both"` mid-page boundary when incoming
 * fills `pageSize` exactly and outgoing has rows but no continuation
 * row is available. The keyset SQL clause filters with strict `>` over
 * real row values, so empty + zero never matches a real row.
 */
const OUT_PHASE_START: LinksKeysetKey = { source_file: "", source_heading_path: null, link_ordinal: 0, id: 0 };

function isOutPhaseStart(key: LinksKeysetKey | undefined): boolean {
	return key !== undefined && key.source_file === "" && key.link_ordinal === 0;
}

function rowToKey(row: WikilinkRow): LinksKeysetKey {
	const headingPath = parseHeadingPathJson(row.source_heading_path_json);
	return {
		source_file: row.source_file,
		source_heading_path: headingPath,
		link_ordinal: row.link_ordinal,
		id: row.id,
	};
}

/**
 * Over-fetch candidate `raw_target` values for the SQL prefilter:
 * every path suffix of `targetFile` × {bare, `./`, `../`-up-to-N} ×
 * {with-ext, no-ext × VAULT_EXTENSIONS} plus the empty `""` (which feeds
 * the builder's `${c}#%` clause to catch same-file `[[#X]]` anchors).
 * `resolveAndCheck` re-resolves each row to drop false positives;
 * over-emit is safe, under-emit silently drops backlinks.
 *
 * A future indexed `target_basename_lc` column would replace this
 * enumeration with a direct lookup; until then, the `../` enumeration
 * up to MAX_PATH_DEPTH covers every legal source location's
 * relative-link form via the `Set` dedup.
 */
function computeIncomingCandidates(targetFile: string): string[] {
	const out = new Set<string>();
	out.add("");
	const segments = targetFile.split("/");
	for (let i = 0; i < segments.length; i++) {
		const suffix = segments.slice(i).join("/");
		if (suffix.length === 0) continue;
		addPathVariants(out, suffix);
		const noExt = stripMarkdownExt(suffix);
		if (noExt !== suffix && noExt.length > 0) {
			addPathVariants(out, noExt);
			for (const ext of getVaultExtensions()) {
				// D46 — wikilinks INTO YAML are deferred; mirror the
				// `findFileWithVaultExt` filter so candidates don't include
				// `notes/auth.yaml` for a markdown target query.
				if (YAML_EXTENSIONS.has(ext)) continue;
				const withExt = `${noExt}.${ext}`;
				if (withExt !== suffix) addPathVariants(out, withExt);
			}
		}
	}
	return [...out];
}

function addPathVariants(out: Set<string>, form: string): void {
	out.add(form);
	out.add(`./${form}`);
	// `[[../../target]]` from a source nested below the target requires
	// matching every `../`-prefix level the source could legally use.
	// Source depth is bounded by MAX_PATH_DEPTH per validatePath.
	let prefix = "../";
	for (let i = 0; i < MAX_PATH_DEPTH; i++) {
		out.add(`${prefix}${form}`);
		prefix += "../";
	}
}

function computeRequestHash(file: string, direction: LinkDirection, narrowing: Narrowing | null): string {
	const narrowKey =
		narrowing === null
			? ""
			: narrowing.stableId !== undefined
				? `sid:${narrowing.stableId}`
				: `hp:${narrowing.headingPathJson}`;
	return createHash("sha1").update(`${file}\u0000${direction}\u0000${narrowKey}`).digest("hex");
}
