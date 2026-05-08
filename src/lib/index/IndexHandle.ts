/**
 * Domain façade over the SQLite + FTS5 index. All prepared statements
 * are centralized here; other modules never construct raw statements.
 * Lifecycle state (cold/warming/warm/reconciling) and `filesIndexed`
 * live in memory and are kept in sync by `replaceFile` / `removeFile`;
 * persisted state is the schema rows + the single-row `snapshot` counter.
 */

import type { Database as DatabaseType, Statement } from "better-sqlite3";

import type { AnchorKind, ContentKind, IndexState, IndexStatus, SearchScopeKind } from "../../types.js";
import { type FilterKeysetKey, type LinksKeysetKey, parseHeadingPathJson, type ScoreDescKey } from "../cursor.js";
import { type CompiledFilter, escapeLike, globEscape } from "../filter.js";
import type { HeadingHistoryRow } from "../fuzzy.js";
import { transition } from "../index_status.js";
import { basenameNoExt, type VaultFileIndex } from "../wikilinks.js";

/**
 * One row to write to the `fragments` table. Heading-kind rows MUST
 * carry every heading-only field; preamble/file kinds MUST leave them
 * NULL (matches the table CHECK constraint).
 */
export interface FragmentRowInput {
	anchor_kind: AnchorKind;
	stable_id: string | null;
	heading_path_json: string | null;
	heading_text: string | null;
	structural_path: string | null;
	range_start: number;
	range_end: number;
	body: string;
	code: string;
	headings: string;
}

/** Frontmatter to upsert per file. `tags` are de-normalized into the
 * `frontmatter_tags` table (one row per tag, hierarchy preserved). */
export interface FrontmatterInput {
	created: string | null;
	updated: string | null;
	fields_json: string;
	tags: ReadonlyArray<string>;
}

/**
 * One row to write to the `wikilinks` table. Resolution columns are
 * absent — `getLinks` re-resolves at read time from `raw_target` against
 * the current vault snapshot, so a watcher-driven file rename
 * invalidates stale resolutions for free.
 */
export interface WikilinkRowInput {
	source_heading_path_json: string | null;
	source_stable_id: string | null;
	source_anchor_kind: AnchorKind;
	link_ordinal: number;
	raw_target: string;
	is_embed: boolean;
	alias: string | null;
	link_text: string;
}

/**
 * File-level token + content-kind aggregates for `get_vault_tree` file
 * items (D35). Computed by the scanner from the parser's per-heading
 * data and persisted via the v7 `file_metrics` table; without these,
 * the tree's main budgeting signal would always be zero.
 */
export interface FileMetricsInput {
	bodyTokensApprox: number;
	descendantTokensApprox: number;
	contentKinds: ReadonlyArray<ContentKind>;
}

export interface ReplaceFileArgs {
	file: string;
	mtime: number;
	size: number;
	fragments: ReadonlyArray<FragmentRowInput>;
	frontmatter: FrontmatterInput;
	/** Defaults to empty when omitted (callers from W3 don't track links). */
	links?: ReadonlyArray<WikilinkRowInput>;
	/** File-level aggregates surfaced by `get_vault_tree`. Optional for
	 * legacy callers; missing → zeroed metrics row written. */
	metrics?: FileMetricsInput;
}

export interface SearchScopeClause {
	kind: SearchScopeKind;
	value?: string;
}

export interface SearchRow {
	id: number;
	file: string;
	anchor_kind: AnchorKind;
	stable_id: string | null;
	heading_path_json: string | null;
	body: string;
	code: string;
	score: number;
}

export interface SearchQueryArgs {
	match: string;
	scope: SearchScopeClause;
	filter: CompiledFilter | null;
	pageSize: number;
	after?: ScoreDescKey | undefined;
}

export interface SearchFilterArgs {
	scope: SearchScopeClause;
	filter: CompiledFilter | null;
	pageSize: number;
	after?: FilterKeysetKey | undefined;
}

/**
 * One row from the `wikilinks` table — the persisted shape `getLinks`
 * paginates over. Resolution is computed downstream against
 * `raw_target` and the current vault snapshot.
 */
export interface WikilinkRow {
	id: number;
	source_file: string;
	source_heading_path_json: string | null;
	source_stable_id: string | null;
	source_anchor_kind: AnchorKind;
	link_ordinal: number;
	raw_target: string;
	is_embed: number; // 0 | 1
	alias: string | null;
	link_text: string;
}

export interface ListOutgoingArgs {
	file: string;
	/** Narrow to a specific source section by heading path. JSON form ('null' string for null). */
	source_heading_path_json?: string | null | undefined;
	/**
	 * Narrow to a specific source section by stable_id — strictly more precise
	 * than `source_heading_path_json` (disambiguates duplicate-heading sections
	 * sharing the same path). Wins over `source_heading_path_json` when both
	 * supplied.
	 */
	source_stable_id?: string | undefined;
	pageSize: number;
	after?: LinksKeysetKey | undefined;
}

export interface ListIncomingArgs {
	candidatePrefixes: ReadonlyArray<string>;
	pageSize: number;
	after?: LinksKeysetKey | undefined;
}

export interface FileStats {
	subheadings: number;
	mtime: number;
	size: number | null;
	/** Aggregate body tokens; 0 when v7 `file_metrics` row absent (legacy). */
	bodyTokensApprox: number;
	/** Same as `bodyTokensApprox` for files (a leaf has no descendants). */
	descendantTokensApprox: number;
	contentKinds: ReadonlyArray<ContentKind>;
}

export function createIndexHandle(db: DatabaseType): IndexHandle {
	return new IndexHandle(db);
}

interface FileCacheSnapshot {
	snapshot: number;
	basenames: Map<string, string[]>;
	pathLc: Map<string, string>;
}

export class IndexHandle implements VaultFileIndex {
	private readonly db: DatabaseType;

	// In-memory lifecycle state. `files_indexed` is cached at startup
	// and updated incrementally on `replaceFile` / `removeFile` so the
	// `getStatus` hot path doesn't run a `COUNT(DISTINCT file)` per call.
	private state: IndexState = "cold";
	private filesIndexed: number;

	private readonly stmtBumpSnapshot: Statement;
	private readonly stmtGetSnapshot: Statement;
	private readonly stmtCountFiles: Statement;
	private readonly stmtFileExists: Statement;
	private readonly stmtGetFileMeta: Statement;
	private readonly stmtGetFileStats: Statement;
	private readonly stmtSelectOldHeadings: Statement;
	private readonly stmtHeadingsByPath: Statement;
	private readonly stmtHeadingsByText: Statement;
	private readonly stmtDeleteFragmentsForFile: Statement;
	private readonly stmtInsertFragment: Statement;
	private readonly stmtUpsertFrontmatter: Statement;
	private readonly stmtDeleteFrontmatterFile: Statement;
	private readonly stmtDeleteFrontmatterTags: Statement;
	private readonly stmtInsertFrontmatterTag: Statement;
	private readonly stmtUpsertHistory: Statement;
	private readonly stmtGetHistoryRow: Statement;
	private readonly stmtGetScanComplete: Statement;
	private readonly stmtSetScanComplete: Statement;
	private readonly stmtGetEverComplete: Statement;
	private readonly stmtMarkEverComplete: Statement;
	private readonly stmtListIndexedFiles: Statement;
	private readonly stmtDeleteWikilinksForFile: Statement;
	private readonly stmtInsertWikilink: Statement;
	private readonly stmtCountWikilinksForFile: Statement;
	private readonly stmtUpsertFileMetrics: Statement;
	private readonly stmtDeleteFileMetrics: Statement;

	// Single-pass snapshot cache for wikilink resolution. Invalidated on
	// `bumpSnapshot`; basename + case-insensitive path lookup share one
	// iteration over `listIndexedFiles()`.
	private fileCache: FileCacheSnapshot | null = null;

	// One-way latch for `ever_complete`. Never resets within a process
	// lifetime, so caching the `true` state skips no-op WAL writes on
	// every reconcile clean-finish.
	private everCompleteOnce = false;

	// Per-file failures the watcher can still recover. Both scanner and
	// the watcher's `reindexCallback` add via {@link addPendingRetry};
	// recovery is signalled by {@link clearPendingRetry} on a successful
	// reindex — the outcome itself evidences recovery, no mtime/size
	// comparison needed.
	private pendingRetries: Set<string> = new Set();

	// Gate for {@link clearPendingRetry}'s `markScanFinalized` call.
	// True between scanner's start and its end-of-scan check; gates
	// finalize so scanner's own synchronous if-check is the source of
	// truth during the scan.
	private scanInProgress = false;

	// Sticky "the most recent scan had unenumerable subtrees (EACCES /
	// EMFILE / EIO on readdir)." Set by scanner at end-of-scan; gates
	// {@link clearPendingRetry} so a watcher recovery on the last
	// pending-retry entry can't finalize `scan_complete=true` while a
	// known-on-disk subtree remains uncovered. Reset by scanner at the
	// start of every scan.
	private failedSubtreesPresent = false;

	// Sticky "the most recent scan didn't reach its end-of-scan check"
	// (signal abort or thrown error). Distinct from
	// `failedSubtreesPresent` (per-directory enumeration failure within
	// a completed scan); this is per-scan. Gates {@link clearPendingRetry}
	// so a post-abort watcher recovery can't finalize on a partial index.
	private scanIncomplete = false;

	constructor(db: DatabaseType) {
		this.db = db;
		this.stmtBumpSnapshot = db.prepare("UPDATE snapshot SET value = MAX(value + 1, :now) WHERE id = 1 RETURNING value");
		this.stmtGetSnapshot = db.prepare("SELECT value FROM snapshot WHERE id = 1");
		this.stmtCountFiles = db.prepare("SELECT COUNT(DISTINCT file) AS n FROM fragments");
		this.stmtFileExists = db.prepare("SELECT 1 FROM fragments WHERE file = :file LIMIT 1");
		this.stmtGetFileMeta = db.prepare("SELECT mtime, size FROM fragments WHERE file = :file LIMIT 1");
		// `mtime` and `size` are identical across every row of a file (the
		// per-file txn writes the same scalars), so MAX collapses to that
		// scalar; SUM(CASE …) gives the heading count in the same scan.
		// LEFT JOIN + COALESCE so legacy files without a metrics row read
		// as zero (distinguishable from the null-row "file not in index"
		// case). Honest reporting; agents can tell "0 tokens" apart from
		// "no data."
		this.stmtGetFileStats = db.prepare(
			`SELECT
			   SUM(CASE WHEN f.anchor_kind = 'heading' THEN 1 ELSE 0 END) AS subheadings,
			   MAX(f.mtime) AS mtime,
			   MAX(f.size) AS size,
			   COALESCE(m.body_tokens_approx, 0) AS body_tokens_approx,
			   COALESCE(m.descendant_tokens_approx, 0) AS descendant_tokens_approx,
			   COALESCE(m.content_kinds_json, '[]') AS content_kinds_json
			 FROM fragments f
			 LEFT JOIN file_metrics m ON m.file = f.file
			 WHERE f.file = :file
			 GROUP BY f.file`,
		);
		this.stmtSelectOldHeadings = db.prepare(
			`SELECT stable_id, heading_text, heading_path_json, structural_path, range_start, range_end, mtime
			 FROM fragments WHERE file = :file AND anchor_kind = 'heading'`,
		);
		this.stmtHeadingsByPath = db.prepare(
			`SELECT stable_id, heading_path_json
			 FROM fragments
			 WHERE file = :file AND anchor_kind = 'heading' AND heading_path_json = :path_json
			 ORDER BY range_start ASC`,
		);
		this.stmtHeadingsByText = db.prepare(
			`SELECT stable_id, heading_path_json
			 FROM fragments
			 WHERE file = :file AND anchor_kind = 'heading' AND heading_text = :text
			 ORDER BY range_start ASC`,
		);
		this.stmtDeleteFragmentsForFile = db.prepare("DELETE FROM fragments WHERE file = :file");
		this.stmtInsertFragment = db.prepare(
			`INSERT INTO fragments
			 (file, anchor_kind, stable_id, heading_path_json, heading_text, structural_path,
			  range_start, range_end, body, code, headings, mtime, size)
			 VALUES (:file, :anchor_kind, :stable_id, :heading_path_json, :heading_text, :structural_path,
			         :range_start, :range_end, :body, :code, :headings, :mtime, :size)`,
		);
		this.stmtUpsertFrontmatter = db.prepare(
			`INSERT INTO frontmatter (file, created, updated, fields_json)
			 VALUES (:file, :created, :updated, :fields_json)
			 ON CONFLICT(file) DO UPDATE SET
			   created = excluded.created,
			   updated = excluded.updated,
			   fields_json = excluded.fields_json`,
		);
		this.stmtDeleteFrontmatterFile = db.prepare("DELETE FROM frontmatter WHERE file = :file");
		this.stmtDeleteFrontmatterTags = db.prepare("DELETE FROM frontmatter_tags WHERE file = :file");
		this.stmtInsertFrontmatterTag = db.prepare(
			"INSERT OR IGNORE INTO frontmatter_tags (file, tag) VALUES (:file, :tag)",
		);
		this.stmtUpsertHistory = db.prepare(
			`INSERT OR REPLACE INTO heading_history
			 (file, stable_id, last_heading_text, last_heading_path_json, last_structural_path,
			  last_range_start, last_range_end, last_seen_mtime, retired_at_mtime)
			 VALUES (:file, :stable_id, :last_heading_text, :last_heading_path_json, :last_structural_path,
			         :last_range_start, :last_range_end, :last_seen_mtime, :retired_at_mtime)`,
		);
		this.stmtGetHistoryRow = db.prepare("SELECT * FROM heading_history WHERE file = :file AND stable_id = :stable_id");
		this.stmtGetScanComplete = db.prepare("SELECT scan_complete FROM index_meta WHERE id = 1");
		this.stmtSetScanComplete = db.prepare("UPDATE index_meta SET scan_complete = :value WHERE id = 1");
		this.stmtGetEverComplete = db.prepare("SELECT ever_complete FROM index_meta WHERE id = 1");
		this.stmtMarkEverComplete = db.prepare("UPDATE index_meta SET ever_complete = 1 WHERE id = 1");
		// `frontmatter` is the canonical "indexed files" set: every
		// `replaceFile` upserts a row, even for files with zero fragments.
		this.stmtListIndexedFiles = db.prepare("SELECT file FROM frontmatter");
		this.stmtDeleteWikilinksForFile = db.prepare("DELETE FROM wikilinks WHERE source_file = :source_file");
		this.stmtInsertWikilink = db.prepare(
			`INSERT INTO wikilinks
			 (source_file, source_heading_path_json, source_stable_id, source_anchor_kind, link_ordinal,
			  raw_target, lc_raw_target, is_embed, alias, link_text)
			 VALUES (:source_file, :source_heading_path_json, :source_stable_id, :source_anchor_kind, :link_ordinal,
			         :raw_target, :lc_raw_target, :is_embed, :alias, :link_text)`,
		);
		this.stmtCountWikilinksForFile = db.prepare("SELECT COUNT(*) AS n FROM wikilinks WHERE source_file = :source_file");
		this.stmtUpsertFileMetrics = db.prepare(
			`INSERT INTO file_metrics (file, body_tokens_approx, descendant_tokens_approx, content_kinds_json)
			 VALUES (:file, :body_tokens_approx, :descendant_tokens_approx, :content_kinds_json)
			 ON CONFLICT(file) DO UPDATE SET
			   body_tokens_approx = excluded.body_tokens_approx,
			   descendant_tokens_approx = excluded.descendant_tokens_approx,
			   content_kinds_json = excluded.content_kinds_json`,
		);
		this.stmtDeleteFileMetrics = db.prepare("DELETE FROM file_metrics WHERE file = :file");
		const row = this.stmtCountFiles.get() as { n: number };
		this.filesIndexed = row.n;
	}

	/**
	 * Persisted "did the last scan run to completion" flag. Independent
	 * from the in-memory `state` so {@link scanner.ts} remains the only
	 * writer; reopening a partial DB returns `false` and the caller
	 * reruns the scan rather than serving from incomplete data.
	 */
	getScanComplete(): boolean {
		const row = this.stmtGetScanComplete.get() as { scan_complete: number } | undefined;
		return row !== undefined && row.scan_complete === 1;
	}

	setScanComplete(value: boolean): void {
		this.stmtSetScanComplete.run({ value: value ? 1 : 0 });
	}

	/**
	 * "Has any scan ever finished cleanly?" One-way: never resets after first
	 * `markEverComplete`. Distinct from `scan_complete` (per-scan flag): a
	 * partial first scan has `scan_complete=false AND ever_complete=false`,
	 * while an interrupted reconcile of a previously-complete index has
	 * `scan_complete=false AND ever_complete=true`. Startup state machine
	 * only treats the latter as "warm" — see `chooseStartupState`.
	 */
	getEverComplete(): boolean {
		const row = this.stmtGetEverComplete.get() as { ever_complete: number } | undefined;
		return row !== undefined && row.ever_complete === 1;
	}

	markEverComplete(): void {
		if (this.everCompleteOnce) return;
		this.stmtMarkEverComplete.run();
		this.everCompleteOnce = true;
	}

	/**
	 * Single point of "scan reached full success." Flips `scan_complete`,
	 * one-way-latches `ever_complete`, and flips state to `warm`. Called
	 * by both the scanner end-of-scan clean branch and the watcher's
	 * pending-retry drain — keeping the steps in one place ensures
	 * consistent finalization across recovery paths.
	 */
	markScanFinalized(): void {
		this.setScanComplete(true);
		this.markEverComplete();
		this.setStatus("warm");
		// Self-clear so a clean merkle reconcile after an aborted scan
		// correctly re-arms — the next aborted scan flips this back via
		// `setScanIncomplete(true)`.
		this.scanIncomplete = false;
	}

	/**
	 * Both scanner workers and the watcher's reindex callback write
	 * here so chokidar-observed mid-scan files participate in the
	 * gating set even when scanner's own walk never enumerated them.
	 */
	addPendingRetry(rel: string): void {
		this.pendingRetries.add(rel);
	}

	hasPendingRetries(): boolean {
		return this.pendingRetries.size > 0;
	}

	/** Snapshot for scanner's end-of-scan vanished-file sweep. */
	pendingRetriesSnapshot(): string[] {
		return [...this.pendingRetries];
	}

	setScanInProgress(value: boolean): void {
		this.scanInProgress = value;
	}

	setFailedSubtreesPresent(value: boolean): void {
		this.failedSubtreesPresent = value;
	}

	setScanIncomplete(value: boolean): void {
		this.scanIncomplete = value;
	}

	/**
	 * Returns `true` when this call drained the set and finalized the
	 * scan. Three independent failure gates must be empty (each
	 * documented at its field declaration): `scanInProgress`,
	 * `failedSubtreesPresent`, `scanIncomplete`.
	 */
	clearPendingRetry(rel: string): boolean {
		if (!this.pendingRetries.delete(rel)) return false;
		if (this.pendingRetries.size > 0) return false;
		if (this.scanInProgress) return false;
		if (this.failedSubtreesPresent) return false;
		if (this.scanIncomplete) return false;
		this.markScanFinalized();
		return true;
	}

	getStatus(): IndexStatus {
		return { state: this.state, files_indexed: this.filesIndexed };
	}

	/**
	 * Flip lifecycle state through the validated arc table in
	 * `index_status.ts`. Same-state arcs are no-ops; illegal transitions
	 * throw `IllegalStateTransitionError`.
	 */
	setStatus(state: IndexState): void {
		this.state = transition(this.state, state);
	}

	countFiles(): number {
		return this.filesIndexed;
	}

	/**
	 * Currently-indexed file paths. Used by the scanner's clean-finish
	 * prune pass: files in this list but not on disk are deleted via
	 * {@link removeFile}.
	 */
	listIndexedFiles(): string[] {
		return (this.stmtListIndexedFiles.all() as Array<{ file: string }>).map((r) => r.file);
	}

	private fileHasRows(file: string): boolean {
		return this.stmtFileExists.get({ file }) !== undefined;
	}

	/**
	 * `replaceFile` writes the same mtime + size to every fragment row for a
	 * file in one transaction, so any single row is authoritative. The scanner
	 * calls this to skip no-op reconciles — replacing rows would bump the
	 * snapshot and invalidate in-flight cursors for an unchanged file.
	 *
	 * Skip key is `(mtime, size)`: mtime alone is fooled by `rsync -t` /
	 * `cp -p` / `tar -p` (preserve source mtime) and by filesystems that
	 * coarsen timestamps. Stored size NULL is the self-heal marker —
	 * return false so the next scan re-indexes and repopulates the row.
	 */
	isFileUnchanged(args: { file: string; mtime: number; size: number }): boolean {
		const row = this.stmtGetFileMeta.get({ file: args.file }) as { mtime: number; size: number | null } | undefined;
		if (row === undefined) return false;
		if (row.size === null) return false;
		return row.mtime === args.mtime && row.size === args.size;
	}

	getSnapshot(): number {
		const row = this.stmtGetSnapshot.get() as { value: number };
		return row.value;
	}

	/**
	 * `MAX(value + 1, now)` keeps the snapshot strictly monotonic even
	 * when the system clock stalls or moves backwards.
	 */
	bumpSnapshot(now: number = Date.now()): number {
		const row = this.stmtBumpSnapshot.get({ now }) as { value: number };
		return row.value;
	}

	/**
	 * D32 retirement-diff per-file commit. Survivors (stable_id present in
	 * the new heading set) skip history; only IDs that disappear from the
	 * file get a `heading_history` row, which the confidence-gated fuzzy
	 * resolver later uses to recover cached agent IDs whose slot has moved
	 * (different parent / level / position). Sibling swaps preserve the
	 * per-slot ID set, so neither old ID is "retired".
	 *
	 * Snapshot is bumped at the end of the txn so in-flight cursors
	 * invalidate on the next continuation.
	 */
	replaceFile(args: ReplaceFileArgs): void {
		const { file, mtime, size, fragments, frontmatter } = args;
		const newStableIds = new Set<string>();
		for (const f of fragments) {
			if (f.anchor_kind === "heading" && f.stable_id !== null) {
				newStableIds.add(f.stable_id);
			}
		}
		const hadRowsBefore = this.fileHasRows(file);

		const txn = this.db.transaction(() => {
			const oldHeadings = this.stmtSelectOldHeadings.all({ file }) as Array<{
				stable_id: string;
				heading_text: string;
				heading_path_json: string;
				structural_path: string;
				range_start: number;
				range_end: number;
				mtime: number;
			}>;
			for (const old of oldHeadings) {
				if (newStableIds.has(old.stable_id)) continue;
				this.stmtUpsertHistory.run({
					file,
					stable_id: old.stable_id,
					last_heading_text: old.heading_text,
					last_heading_path_json: old.heading_path_json,
					last_structural_path: old.structural_path,
					last_range_start: old.range_start,
					last_range_end: old.range_end,
					last_seen_mtime: old.mtime,
					retired_at_mtime: mtime,
				});
			}

			this.stmtDeleteFragmentsForFile.run({ file });
			for (const f of fragments) {
				this.stmtInsertFragment.run({
					file,
					anchor_kind: f.anchor_kind,
					stable_id: f.stable_id,
					heading_path_json: f.heading_path_json,
					heading_text: f.heading_text,
					structural_path: f.structural_path,
					range_start: f.range_start,
					range_end: f.range_end,
					body: f.body,
					code: f.code,
					headings: f.headings,
					mtime,
					size,
				});
			}

			this.stmtUpsertFrontmatter.run({
				file,
				created: frontmatter.created,
				updated: frontmatter.updated,
				fields_json: frontmatter.fields_json,
			});
			this.stmtDeleteFrontmatterTags.run({ file });
			for (const tag of frontmatter.tags) {
				this.stmtInsertFrontmatterTag.run({ file, tag });
			}

			this.stmtDeleteWikilinksForFile.run({ source_file: file });
			const links = args.links ?? [];
			for (const l of links) {
				this.stmtInsertWikilink.run({
					source_file: file,
					source_heading_path_json: l.source_heading_path_json,
					source_stable_id: l.source_stable_id,
					source_anchor_kind: l.source_anchor_kind,
					link_ordinal: l.link_ordinal,
					raw_target: l.raw_target,
					// JS toLowerCase folds Unicode (`É → é`); SQLite LIKE without
					// COLLATE folds only ASCII. Storing the JS-folded form lets
					// the SQL prefilter match non-ASCII case variants.
					lc_raw_target: l.raw_target.toLowerCase(),
					is_embed: l.is_embed ? 1 : 0,
					alias: l.alias,
					link_text: l.link_text,
				});
			}

			// `metrics` is optional so test fixtures that don't track
			// aggregates round-trip without contention. Production callers
			// always pass real values from `computeFileMetrics`.
			const metrics = args.metrics ?? { bodyTokensApprox: 0, descendantTokensApprox: 0, contentKinds: [] };
			this.stmtUpsertFileMetrics.run({
				file,
				body_tokens_approx: metrics.bodyTokensApprox,
				descendant_tokens_approx: metrics.descendantTokensApprox,
				content_kinds_json: JSON.stringify([...metrics.contentKinds]),
			});

			this.fileCache = null;
			this.bumpSnapshot();
		});
		txn();
		const hasRowsAfter = fragments.length > 0;
		if (hadRowsBefore !== hasRowsAfter) {
			this.filesIndexed += hasRowsAfter ? 1 : -1;
		}
	}

	/**
	 * Drop a file from the index entirely (used when the scanner
	 * detects a deletion). Same retirement-diff write rule as
	 * {@link replaceFile}, but with an empty new set.
	 */
	removeFile(file: string, retiredAtMtime: number): void {
		// No-op writes must not bump the snapshot: in-flight cursors
		// validate against `snapshot_mtime`, so a bump on a never-indexed
		// path (common when chokidar's stats-undefined initial crawl
		// emits add events for non-markdown assets) would invalidate
		// every cursor without any rows changing.
		if (!this.fileHasRows(file)) return;
		const txn = this.db.transaction(() => {
			const oldHeadings = this.stmtSelectOldHeadings.all({ file }) as Array<{
				stable_id: string;
				heading_text: string;
				heading_path_json: string;
				structural_path: string;
				range_start: number;
				range_end: number;
				mtime: number;
			}>;
			for (const old of oldHeadings) {
				this.stmtUpsertHistory.run({
					file,
					stable_id: old.stable_id,
					last_heading_text: old.heading_text,
					last_heading_path_json: old.heading_path_json,
					last_structural_path: old.structural_path,
					last_range_start: old.range_start,
					last_range_end: old.range_end,
					last_seen_mtime: old.mtime,
					retired_at_mtime: retiredAtMtime,
				});
			}
			this.stmtDeleteFragmentsForFile.run({ file });
			this.stmtDeleteFrontmatterFile.run({ file });
			this.stmtDeleteFrontmatterTags.run({ file });
			this.stmtDeleteWikilinksForFile.run({ source_file: file });
			this.stmtDeleteFileMetrics.run({ file });
			this.fileCache = null;
			this.bumpSnapshot();
		});
		txn();
		this.filesIndexed--;
	}

	getHistoryRow(file: string, stable_id: string): HeadingHistoryRow | null {
		const row = this.stmtGetHistoryRow.get({ file, stable_id }) as HeadingHistoryRow | undefined;
		return row ?? null;
	}

	/**
	 * BM25-ranked rows. Score is `-bm25()` so higher = more relevant —
	 * cursors store the same sign convention.
	 */
	searchQueryMode(args: SearchQueryArgs): SearchRow[] {
		const params: Record<string, unknown> = {
			match: args.match,
			pageSize: args.pageSize,
		};
		const conditions: string[] = ["fragments_fts MATCH :match"];
		applyScope(conditions, params, args.scope);
		applyFilter(conditions, params, args.filter);

		const cursor = args.after;
		const cursorClause = cursor ? buildScoreDescCursor(params, cursor) : null;

		// CTE materializes `score` so the keyset clause can reference
		// it symbolically. `-bm25()` flips FTS5's lower-is-better sign
		// into the unified higher-is-better scheme cursors persist.
		const sql = `
WITH ranked AS (
  SELECT f.id              AS id,
         f.file            AS file,
         f.anchor_kind     AS anchor_kind,
         f.stable_id       AS stable_id,
         f.heading_path_json AS heading_path_json,
         f.body            AS body,
         f.code            AS code,
         -bm25(fragments_fts, 2.0, 0.5, 3.0) AS score
  FROM fragments f
  JOIN fragments_fts ON fragments_fts.rowid = f.id
  LEFT JOIN frontmatter fm ON fm.file = f.file
  WHERE ${conditions.join(" AND ")}
)
SELECT *
FROM ranked
${cursorClause ? `WHERE ${cursorClause}` : ""}
ORDER BY score DESC, file ASC, COALESCE(heading_path_json, '') ASC, anchor_kind ASC, id ASC
LIMIT :pageSize
`;
		const stmt = this.db.prepare(sql);
		return stmt.all(params) as SearchRow[];
	}

	// ─── VaultFileIndex (wikilinks resolution) ────────────────────────────

	hasFile(relpath: string): boolean {
		const row = this.db.prepare("SELECT 1 FROM frontmatter WHERE file = :file LIMIT 1").get({ file: relpath });
		return row !== undefined;
	}

	/**
	 * Case-insensitive sibling of {@link hasFile}. On filesystems that admit
	 * both `notes/auth.md` and `Notes/Auth.md` coexisting, the lex-smallest
	 * stored relpath wins (deterministic across snapshots).
	 */
	findFileCi(relpath: string): string | null {
		return this.refreshFileCache().pathLc.get(relpath.toLowerCase()) ?? null;
	}

	/**
	 * Lowercase basename → matching relpaths, sorted shortest-relpath-first
	 * (Obsidian closest-to-root wins).
	 */
	filesByBasename(name: string): ReadonlyArray<string> {
		return this.refreshFileCache().basenames.get(name.toLowerCase()) ?? [];
	}

	private refreshFileCache(): FileCacheSnapshot {
		const snap = this.getSnapshot();
		if (this.fileCache?.snapshot === snap) return this.fileCache;
		// Sort once so basename buckets are deterministic AND `pathLc` keeps
		// the lex-smallest original on case collisions.
		const files = [...this.listIndexedFiles()].sort();
		const basenames = new Map<string, string[]>();
		const pathLc = new Map<string, string>();
		for (const f of files) {
			const base = basenameNoExt(f);
			let list = basenames.get(base);
			if (!list) {
				list = [];
				basenames.set(base, list);
			}
			list.push(f);
			const key = f.toLowerCase();
			if (!pathLc.has(key)) pathLc.set(key, f);
		}
		// Lex sort already orders by string; basename buckets need
		// shortest-relpath-first per Obsidian closest-to-root semantics.
		for (const list of basenames.values()) {
			list.sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b));
		}
		this.fileCache = { snapshot: snap, basenames, pathLc };
		return this.fileCache;
	}

	headingsByPath(file: string, path: string[]): ReadonlyArray<{ stable_id: string; heading_path: string[] }> {
		const rows = this.stmtHeadingsByPath.all({ file, path_json: JSON.stringify(path) }) as Array<{
			stable_id: string;
			heading_path_json: string;
		}>;
		return rows.map((row) => ({
			stable_id: row.stable_id,
			heading_path: parseHeadingPathJson(row.heading_path_json) ?? [],
		}));
	}

	headingsByText(file: string, text: string): ReadonlyArray<{ stable_id: string; heading_path: string[] }> {
		const rows = this.stmtHeadingsByText.all({ file, text }) as Array<{
			stable_id: string;
			heading_path_json: string;
		}>;
		return rows.map((row) => ({
			stable_id: row.stable_id,
			heading_path: parseHeadingPathJson(row.heading_path_json) ?? [],
		}));
	}

	// ─── File stats (get_vault_tree, merkle) ──────────────────────────────

	/**
	 * Cheap `(mtime, size)` lookup via `LIMIT 1` — `mtime`/`size` are uniform
	 * across a file's rows so the first row suffices. Use this for drift
	 * detection; reach for `getFileStats` only when `subheadings` is needed.
	 */
	getFileMeta(file: string): { mtime: number; size: number | null } | null {
		const row = this.stmtGetFileMeta.get({ file }) as { mtime: number; size: number | null } | undefined;
		return row ?? null;
	}

	getFileMtime(file: string): number | null {
		return this.getFileMeta(file)?.mtime ?? null;
	}

	getFileStats(file: string): FileStats | null {
		// `GROUP BY f.file` returns zero rows when the file has no
		// fragments — that's the unindexed signal.
		const row = this.stmtGetFileStats.get({ file }) as
			| {
					subheadings: number | null;
					mtime: number;
					size: number | null;
					body_tokens_approx: number;
					descendant_tokens_approx: number;
					content_kinds_json: string;
			  }
			| undefined;
		if (!row) return null;
		let contentKinds: ReadonlyArray<ContentKind> = [];
		try {
			const parsed = JSON.parse(row.content_kinds_json);
			if (Array.isArray(parsed)) contentKinds = parsed as ContentKind[];
		} catch {
			// Malformed JSON in content_kinds_json (shouldn't happen — we
			// always JSON.stringify on write). Treat as empty rather than
			// blow up the tree handler.
		}
		return {
			subheadings: row.subheadings ?? 0,
			mtime: row.mtime,
			size: row.size,
			bodyTokensApprox: row.body_tokens_approx,
			descendantTokensApprox: row.descendant_tokens_approx,
			contentKinds,
		};
	}

	// ─── Wikilinks ────────────────────────────────────────────────────────

	wikilinksRowCountForFile(file: string): number {
		const row = this.stmtCountWikilinksForFile.get({ source_file: file }) as { n: number };
		return row.n;
	}

	listOutgoingLinks(args: ListOutgoingArgs): WikilinkRow[] {
		const params: Record<string, unknown> = { source_file: args.file, pageSize: args.pageSize };
		const conditions: string[] = ["source_file = :source_file"];
		// Stable_id is strictly more precise than heading_path; when both are
		// supplied (or just stable_id), use stable_id alone — heading_path's
		// bucket key would silently merge duplicate-heading sections.
		if (args.source_stable_id !== undefined) {
			conditions.push("source_stable_id = :source_stable_id");
			params.source_stable_id = args.source_stable_id;
		} else if (args.source_heading_path_json !== undefined) {
			if (args.source_heading_path_json === null) {
				conditions.push("source_heading_path_json IS NULL");
			} else {
				conditions.push("source_heading_path_json = :sh_path");
				params.sh_path = args.source_heading_path_json;
			}
		}
		if (args.after) applyLinksKeysetCursor(conditions, params, args.after, false);
		// `ORDER BY id ASC` IS document order (D36): SQLite assigns rowids
		// monotonically per insert, scanner inserts wikilinks preamble-first
		// then headings in source order. The pre-D36 ORDER BY used JSON-lex
		// of `source_heading_path_json` which had nothing to do with
		// document position.
		const sql = `
SELECT id, source_file, source_heading_path_json, source_stable_id, source_anchor_kind, link_ordinal,
       raw_target, is_embed, alias, link_text
FROM wikilinks
WHERE ${conditions.join(" AND ")}
ORDER BY id ASC
LIMIT :pageSize
`;
		return this.db.prepare(sql).all(params) as WikilinkRow[];
	}

	/**
	 * Pre-filter incoming-link rows whose `raw_target` starts with one of
	 * the supplied prefixes (with or without `#anchor`). The caller
	 * re-resolves each row to confirm the target actually points at the
	 * desired file — the SQL filter is a candidate set, not a verdict
	 * (basename matches can be ambiguous and overshoot).
	 *
	 * Chunks the candidate list to keep the OR-tree under SQLite's default
	 * `SQLITE_MAX_EXPR_DEPTH=1000`. A target nested ≥10 segments deep with
	 * the multi-level `../` enumeration produces 1000+ OR clauses, which
	 * trips `SQLITE_ERROR: Expression tree is too large`.
	 */
	listIncomingCandidates(args: ListIncomingArgs): WikilinkRow[] {
		const candidates = args.candidatePrefixes;
		if (candidates.length === 0) return [];
		if (candidates.length <= INCOMING_CANDIDATE_CHUNK_SIZE) {
			return this.listIncomingCandidatesChunk(candidates, args);
		}
		// Each chunk applies the same `after` filter; merge by primary key,
		// sort by the same keyset the SQL ORDER BY uses, take pageSize.
		// DISTINCT-by-id avoids double-counting a wikilink whose raw_target
		// matches multiple chunked candidates.
		const seen = new Set<number>();
		const merged: WikilinkRow[] = [];
		for (let i = 0; i < candidates.length; i += INCOMING_CANDIDATE_CHUNK_SIZE) {
			const chunk = candidates.slice(i, i + INCOMING_CANDIDATE_CHUNK_SIZE);
			const rows = this.listIncomingCandidatesChunk(chunk, args);
			for (const row of rows) {
				if (seen.has(row.id)) continue;
				seen.add(row.id);
				merged.push(row);
			}
		}
		merged.sort(compareIncomingKeyset);
		return merged.slice(0, args.pageSize);
	}

	private listIncomingCandidatesChunk(prefixes: ReadonlyArray<string>, args: ListIncomingArgs): WikilinkRow[] {
		const params: Record<string, unknown> = { pageSize: args.pageSize };
		const orClauses: string[] = [];
		for (let i = 0; i < prefixes.length; i++) {
			// LIKE without wildcards on `lc_raw_target` matches the
			// JS-lowercased candidate form so non-ASCII case variants
			// (`CAFÉ` vs `café`) resolve symmetrically with the outgoing
			// resolver's JS `toLowerCase()`. The hash form covers
			// `[[file#anchor]]` references. Both branches escape `_`/`%`/`\`
			// so paths like `api_v1` don't false-match `apixv1`. raw_target
			// is stored canonical (extraction-time trim in
			// `extractWikilinks`); lc_raw_target is the same string folded.
			const escaped = escapeLike((prefixes[i] ?? "").toLowerCase());
			params[`exact${i}`] = escaped;
			params[`hash${i}`] = `${escaped}#%`;
			orClauses.push(`(lc_raw_target LIKE :exact${i} ESCAPE '\\' OR lc_raw_target LIKE :hash${i} ESCAPE '\\')`);
		}
		const conditions: string[] = [`(${orClauses.join(" OR ")})`];
		if (args.after) applyLinksKeysetCursor(conditions, params, args.after, true);
		// `ORDER BY source_file, id` paginates incoming across files
		// alphabetically and within each file in document order (D36).
		const sql = `
SELECT id, source_file, source_heading_path_json, source_stable_id, source_anchor_kind, link_ordinal,
       raw_target, is_embed, alias, link_text
FROM wikilinks
WHERE ${conditions.join(" AND ")}
ORDER BY source_file ASC, id ASC
LIMIT :pageSize
`;
		return this.db.prepare(sql).all(params) as WikilinkRow[];
	}

	// ─── Search ───────────────────────────────────────────────────────────

	/** Search filter mode: no MATCH; deterministic file-keyset order. */
	searchFilterMode(args: SearchFilterArgs): SearchRow[] {
		const params: Record<string, unknown> = { pageSize: args.pageSize };
		const conditions: string[] = [];
		applyScope(conditions, params, args.scope);
		applyFilter(conditions, params, args.filter);

		const cursor = args.after;
		const cursorClause = cursor ? buildFilterCursor(params, cursor) : null;
		const where = [...conditions, cursorClause].filter((c): c is string => c !== null);

		const sql = `
SELECT f.id               AS id,
       f.file              AS file,
       f.anchor_kind       AS anchor_kind,
       f.stable_id         AS stable_id,
       f.heading_path_json AS heading_path_json,
       f.body              AS body,
       f.code              AS code,
       0                   AS score
FROM fragments f
LEFT JOIN frontmatter fm ON fm.file = f.file
${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
ORDER BY f.file ASC, COALESCE(f.heading_path_json, '') ASC, f.anchor_kind ASC, f.id ASC
LIMIT :pageSize
`;
		const stmt = this.db.prepare(sql);
		return stmt.all(params) as SearchRow[];
	}
}

// ─── Helpers ───────────────────────────────────────────────────────────

function applyScope(conditions: string[], params: Record<string, unknown>, scope: SearchScopeClause): void {
	switch (scope.kind) {
		case "vault":
			return;
		case "subtree": {
			if (!scope.value) return;
			// `scope.value` is a vault-relative directory path. Match
			// `<value>/<rest>` only — exact path is the directory itself.
			// Use GLOB (byte-wise, case-sensitive) instead of LIKE: SQLite
			// LIKE is case-insensitive for ASCII by default, which leaks
			// rows from sibling directories that differ only in case on
			// case-sensitive vault filesystems.
			conditions.push("f.file GLOB :scope_prefix");
			params.scope_prefix = `${globEscape(scope.value)}/*`;
			return;
		}
		case "file": {
			if (!scope.value) return;
			conditions.push("f.file = :scope_file");
			params.scope_file = scope.value;
			return;
		}
	}
}

/**
 * Maximum candidate prefixes per `listIncomingCandidates` SQL chunk.
 * 200 candidates × 2 LIKE clauses each = 400 OR pairs, well under the
 * default `SQLITE_MAX_EXPR_DEPTH=1000`. Larger chunks risk hitting the
 * depth cap on deeply-nested vaults; smaller chunks pay extra prepare
 * cost. better-sqlite3 caches prepared statements by SQL text, so the
 * per-chunk cost is amortized within a single request once the SQL is
 * cached.
 */
const INCOMING_CANDIDATE_CHUNK_SIZE = 200;

/**
 * Lex-compare wikilink rows by the same keyset the per-chunk SQL ORDER
 * BY uses (`source_file ASC, id ASC` per D36). After cross-chunk merging,
 * sort with this comparator and the merged output is byte-for-byte
 * identical to a single-pass query (modulo the page cap).
 */
function compareIncomingKeyset(a: WikilinkRow, b: WikilinkRow): number {
	if (a.source_file !== b.source_file) return a.source_file < b.source_file ? -1 : 1;
	return a.id - b.id;
}

/**
 * Wikilinks keyset cursor on `{source_file?, id}` — D36. SQLite rowids
 * are monotonic per insert and scanner inserts wikilinks in document
 * order, so `id` is the document-order key. `includeSourceFile` adds the
 * `source_file` prefix for incoming (paginates across files); outgoing
 * locks `source_file` via the WHERE filter so it's omitted.
 *
 * `LinksKeysetKey` still carries `source_heading_path` and `link_ordinal`
 * for legacy cursor decode compatibility, but they're ignored here. Old
 * cursors get invalidated naturally by snapshot_mtime drift on reindex.
 */
function applyLinksKeysetCursor(
	conditions: string[],
	params: Record<string, unknown>,
	cur: LinksKeysetKey,
	includeSourceFile: boolean,
): void {
	params.cur_id = cur.id;
	if (includeSourceFile) {
		params.cur_file = cur.source_file;
		conditions.push("(source_file > :cur_file OR (source_file = :cur_file AND id > :cur_id))");
	} else {
		conditions.push("id > :cur_id");
	}
}

function applyFilter(conditions: string[], params: Record<string, unknown>, filter: CompiledFilter | null): void {
	if (!filter) return;
	conditions.push(filter.whereSql);
	for (const [k, v] of Object.entries(filter.params)) {
		params[k] = v;
	}
}

/** Encode a cursor's `heading_path` for SQL comparison. NULL `heading_path_json`
 *  rows COALESCE to `''`, so cursors must mirror that shape on the bind side. */
function encodeHeadingPath(headingPath: ReadonlyArray<string> | null): string {
	return headingPath === null ? "" : JSON.stringify(headingPath);
}

function buildScoreDescCursor(params: Record<string, unknown>, key: ScoreDescKey): string {
	params.cur_score = key.score;
	params.cur_file = key.file;
	params.cur_path = encodeHeadingPath(key.heading_path);
	params.cur_kind = key.anchor_kind;
	params.cur_id = key.id;
	return `(
  score < :cur_score
  OR (score = :cur_score AND file > :cur_file)
  OR (score = :cur_score AND file = :cur_file AND COALESCE(heading_path_json, '') > :cur_path)
  OR (score = :cur_score AND file = :cur_file AND COALESCE(heading_path_json, '') = :cur_path AND anchor_kind > :cur_kind)
  OR (score = :cur_score AND file = :cur_file AND COALESCE(heading_path_json, '') = :cur_path AND anchor_kind = :cur_kind AND id > :cur_id)
)`;
}

function buildFilterCursor(params: Record<string, unknown>, key: FilterKeysetKey): string {
	params.cur_file = key.file;
	params.cur_path = encodeHeadingPath(key.heading_path);
	params.cur_kind = key.anchor_kind;
	params.cur_id = key.id;
	return `(
  f.file > :cur_file
  OR (f.file = :cur_file AND COALESCE(f.heading_path_json, '') > :cur_path)
  OR (f.file = :cur_file AND COALESCE(f.heading_path_json, '') = :cur_path AND f.anchor_kind > :cur_kind)
  OR (f.file = :cur_file AND COALESCE(f.heading_path_json, '') = :cur_path AND f.anchor_kind = :cur_kind AND f.id > :cur_id)
)`;
}
