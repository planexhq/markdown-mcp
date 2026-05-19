/**
 * Domain façade over the SQLite + FTS5 index. All prepared statements
 * are centralized here; other modules never construct raw statements.
 * Lifecycle state (cold/warming/warm/reconciling) lives in memory;
 * persisted state is the schema rows + the single-row `snapshot` counter.
 */

import type { Database as DatabaseType, Statement } from "better-sqlite3";

import type {
	AnchorKind,
	ContentKind,
	IndexState,
	IndexStatus,
	IndexStatusSnapshot,
	SearchScopeKind,
} from "../../types.js";
import { type FilterKeysetKey, type LinksKeysetKey, parseHeadingPathJson, type ScoreDescKey } from "../cursor.js";
import { type CompiledFilter, escapeLike, globEscape } from "../filter.js";
import type { HeadingHistoryRow } from "../fuzzy.js";
import { INDEX_DIR_NAME, isFsCaseInsensitiveResolved } from "../hiddenPath.js";
import { transition } from "../index_status.js";
import { PARSER_SHAPE_VERSION } from "../parsers/version.js";
import { basenameNoExt, type VaultFileIndex } from "../wikilinks.js";

/** Row shape returned by `stmtGetStatusFields` — shared between `readStatusFields` and `buildStatus`. */
interface StatusFieldsRow {
	files_indexed: number;
	last_scan_finished_at: number | null;
	ever_complete: number;
}

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
 * items. Computed by the scanner from the parser's per-heading
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
	/** Aggregate body tokens; 0 when v7 `file_metrics` row absent (legacy). */
	bodyTokensApprox: number;
	/** Same as `bodyTokensApprox` for files (a leaf has no descendants). */
	descendantTokensApprox: number;
	contentKinds: ReadonlyArray<ContentKind>;
}

/**
 * `includeHidden` and `vaultExtensions` are captured here so
 * {@link IndexHandle.markScanFinalized} persists them atomically with
 * `scan_complete=true` — that invariant is what lets a startup mismatch
 * check distinguish "last clean snapshot's policy" from
 * "currently-running process flag."
 *
 * `vaultExtensions` (optional) is the canonical sorted lowercase
 * comma-joined form (e.g. `"md,yaml,yml"`). Production callers
 * (`src/index.ts`) produce it once at startup via
 * `[...getVaultExtensions()].sort().join(",")`; tests that bypass that
 * code path omit the field and accept the default `"md"` (matches the
 * pre-column cache default — `chooseStartupState` treats NULL or `"md"` as
 * "no mismatch" for default-extension vaults).
 */
export interface CreateIndexHandleOptions {
	includeHidden: boolean;
	vaultExtensions?: string;
}

export function createIndexHandle(db: DatabaseType, options: CreateIndexHandleOptions): IndexHandle {
	return new IndexHandle(db, options.includeHidden, options.vaultExtensions ?? "md");
}

interface FileCacheSnapshot {
	snapshot: number;
	basenames: Map<string, string[]>;
	pathLc: Map<string, string>;
}

const INDEX_CACHE_GLOB = `${globEscape(INDEX_DIR_NAME)}/*`;

export class IndexHandle implements VaultFileIndex {
	private readonly db: DatabaseType;

	private state: IndexState = "cold";

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
	private readonly stmtGetIncludeHidden: Statement;
	private readonly stmtGetInflightIncludeHidden: Statement;
	private readonly stmtSetInflightIncludeHidden: Statement;
	private readonly stmtGetInflightParserShape: Statement;
	private readonly stmtSetInflightParserShape: Statement;
	private readonly stmtGetEverComplete: Statement;
	private readonly stmtGetVaultExtensions: Statement;
	private readonly stmtGetParserShapeVersion: Statement;
	private readonly stmtFinalize: Statement;
	// Single round-trip for `getStatus()`'s two SELECTs
	// (files_indexed + last_scan_finished_at). Used by `getStatus()` and
	// by `getLastScanFinishedAt()` so there's one source-of-SQL.
	private readonly stmtGetStatusFields: Statement;
	private readonly stmtListIndexedFiles: Statement;
	private readonly stmtDeleteWikilinksForFile: Statement;
	private readonly stmtInsertWikilink: Statement;
	private readonly stmtCountWikilinksForFile: Statement;
	private readonly stmtUpsertFileMetrics: Statement;
	private readonly stmtDeleteFileMetrics: Statement;
	private readonly stmtsSweepCacheLower: ReadonlyArray<Statement>;
	private readonly stmtsSweepCacheByteWise: ReadonlyArray<Statement>;

	// Single-pass snapshot cache for wikilink resolution. Invalidated on
	// `bumpSnapshot`; basename + case-insensitive path lookup share one
	// iteration over `listIndexedFiles()`.
	private fileCache: FileCacheSnapshot | null = null;

	// Persisted-flag getters (`scan_complete`, `inflight_include_hidden`,
	// `include_hidden`, `ever_complete`) all read disk per call — under
	// same-policy multi-process operation (round 30) a peer's mid-life
	// finalize is invisible to any in-memory cache, producing
	// self-contradictory snapshots (e.g. cached `ever_complete=false`
	// alongside the peer's freshly-written `last_scan_finished_at`).
	// Setters write disk directly; getters issue a fresh SELECT each call.

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

	// See {@link CreateIndexHandleOptions}.
	private readonly includeHidden: boolean;
	private readonly vaultExtensions: string;

	constructor(db: DatabaseType, includeHidden: boolean, vaultExtensions: string) {
		this.db = db;
		this.includeHidden = includeHidden;
		this.vaultExtensions = vaultExtensions;
		this.stmtBumpSnapshot = db.prepare("UPDATE snapshot SET value = MAX(value + 1, :now) WHERE id = 1 RETURNING value");
		this.stmtGetSnapshot = db.prepare("SELECT value FROM snapshot WHERE id = 1");
		// `frontmatter` has one row per file (line 367 — canonical "indexed
		// files" set), keyed by `file TEXT PRIMARY KEY`, so COUNT(*) is an
		// O(log N) b-tree boundary lookup. COUNT(DISTINCT file) on
		// `fragments` would walk every heading/preamble/file row to dedupe.
		this.stmtCountFiles = db.prepare("SELECT COUNT(*) AS n FROM frontmatter");
		// Cover both orphan directions. `replaceFile` upserts both tables
		// in one txn, but legacy/corrupt/manually-edited DBs can leave a
		// row in either table without the other. Querying only `frontmatter`
		// defeats `removeFile` for fragments-only orphans (they stay
		// searchable via the `fragments f LEFT JOIN frontmatter fm` in
		// `searchQueryMode` / `searchFilterMode`); querying only `fragments`
		// defeats it for frontmatter-only orphans (they keep inflating
		// `countFiles`).
		this.stmtFileExists = db.prepare(
			"SELECT 1 WHERE EXISTS (SELECT 1 FROM frontmatter WHERE file = :file) " +
				"OR EXISTS (SELECT 1 FROM fragments WHERE file = :file)",
		);
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
		this.stmtGetIncludeHidden = db.prepare("SELECT include_hidden FROM index_meta WHERE id = 1");
		this.stmtGetInflightIncludeHidden = db.prepare("SELECT inflight_include_hidden FROM index_meta WHERE id = 1");
		this.stmtSetInflightIncludeHidden = db.prepare(
			"UPDATE index_meta SET inflight_include_hidden = :value WHERE id = 1",
		);
		this.stmtGetInflightParserShape = db.prepare("SELECT inflight_parser_shape_version FROM index_meta WHERE id = 1");
		this.stmtSetInflightParserShape = db.prepare(
			"UPDATE index_meta SET inflight_parser_shape_version = :value WHERE id = 1",
		);
		this.stmtGetEverComplete = db.prepare("SELECT ever_complete FROM index_meta WHERE id = 1");
		this.stmtGetVaultExtensions = db.prepare("SELECT vault_extensions FROM index_meta WHERE id = 1");
		this.stmtGetParserShapeVersion = db.prepare("SELECT parser_shape_version FROM index_meta WHERE id = 1");
		// Single statement so the finalize columns commit atomically.
		// `inflight_include_hidden = NULL` clears the in-flight marker in
		// the same UPDATE — a SIGTERM mid-finalize cannot leave the clear
		// half-done. `vault_extensions` is in the atomic set so the
		// persisted snapshot's extension policy always matches its
		// `include_hidden`. `parser_shape_version` joins for the
		// same reason — the persisted stamp always identifies the
		// parser output shape of the snapshot's contents.
		this.stmtFinalize = db.prepare(
			"UPDATE index_meta SET scan_complete = 1, ever_complete = 1, include_hidden = :include_hidden, " +
				"inflight_include_hidden = NULL, inflight_parser_shape_version = NULL, " +
				"last_scan_finished_at = :last_scan_finished_at, " +
				"vault_extensions = :vault_extensions, parser_shape_version = :parser_shape_version WHERE id = 1",
		);
		// Inline subqueries so the round-trip is one prepared-statement
		// invocation. `frontmatter` count matches `countFiles()`'s query;
		// `index_meta` is a single row so the inner SELECT is O(1).
		// `ever_complete` joined in so {@link getStatusSnapshot} can
		// surface an atomic combined snapshot — a peer's `markScanFinalized`
		// writes all three fields in one UPDATE, and reading them via two
		// separate SELECTs would expose a torn combination that never
		// existed on disk.
		this.stmtGetStatusFields = db.prepare(
			"SELECT (SELECT COUNT(*) FROM frontmatter) AS files_indexed, " +
				"(SELECT last_scan_finished_at FROM index_meta WHERE id = 1) AS last_scan_finished_at, " +
				"(SELECT ever_complete FROM index_meta WHERE id = 1) AS ever_complete",
		);
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
		// `lower()` loses index-eligibility on `file` but the sweep runs
		// once per startup against a small cache-prefix row set (zero
		// on a clean DB).
		const sweepTargets = [
			["fragments", "file"],
			["frontmatter", "file"],
			["frontmatter_tags", "file"],
			["wikilinks", "source_file"],
			["file_metrics", "file"],
			["heading_history", "file"],
		] as const;
		this.stmtsSweepCacheLower = sweepTargets.map(([t, c]) =>
			db.prepare(`DELETE FROM ${t} WHERE lower(${c}) GLOB :prefix`),
		);
		this.stmtsSweepCacheByteWise = sweepTargets.map(([t, c]) => db.prepare(`DELETE FROM ${t} WHERE ${c} GLOB :prefix`));
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
	 * "Has any scan ever finished cleanly?" Written only by
	 * {@link markScanFinalized} — never resets once set. Distinct from
	 * `scan_complete` (per-scan flag): a partial first scan has
	 * `scan_complete=false AND ever_complete=false`, while an
	 * interrupted reconcile of a previously-complete index has
	 * `scan_complete=false AND ever_complete=true`. Startup state
	 * machine only treats the latter as "warm" — see
	 * `chooseStartupState`.
	 *
	 * Reads disk per call: under same-policy multi-process operation
	 * (round 30) a peer's finalize is invisible to other peers'
	 * in-memory state, producing a self-contradictory `get_server_info`
	 * snapshot (`ever_complete=false` alongside the peer's
	 * `last_scan_finished_at`). Cost: ~µs via prepared statement.
	 */
	getEverComplete(): boolean {
		const row = this.stmtGetEverComplete.get() as { ever_complete: number } | undefined;
		return row !== undefined && row.ever_complete === 1;
	}

	/**
	 * Persisted `--include-hidden` policy from the last cleanly-finalized
	 * snapshot. `null` signals a fresh DB or pre-column upgrade; the next
	 * {@link markScanFinalized} writes the running policy. Compared
	 * against the current flag at startup to detect policy flips that
	 * invalidate the snapshot's row population.
	 */
	getIncludeHiddenPolicy(): boolean | null {
		const row = this.stmtGetIncludeHidden.get() as { include_hidden: number | null } | undefined;
		if (row === undefined || row.include_hidden === null) return null;
		return row.include_hidden === 1;
	}

	/**
	 * Persisted `VAULT_EXTENSIONS` snapshot (sorted, lowercase,
	 * comma-joined) from the last cleanly-finalized scan. `null` signals
	 * a fresh DB or pre-column upgrade; the next {@link markScanFinalized}
	 * writes the running policy. Compared against the current
	 * `getVaultExtensions()` snapshot at startup to detect flips that
	 * invalidate row population (e.g. `md` → `md,yaml,yml` adds files
	 * never indexed; `md,yaml` → `md` adds rows that must be pruned).
	 */
	getVaultExtensionsPolicy(): string | null {
		const row = this.stmtGetVaultExtensions.get() as { vault_extensions: string | null } | undefined;
		if (row === undefined || row.vault_extensions === null) return null;
		return row.vault_extensions;
	}

	/**
	 * Persisted parser-output-shape stamp from the last cleanly-
	 * finalized scan. `null` signals a fresh DB or pre-column upgrade; the
	 * next {@link markScanFinalized} writes the running
	 * {@link PARSER_SHAPE_VERSION}. Compared against the in-code constant
	 * at startup; mismatch forces a cold rescan so previously-indexed
	 * files pick up new synthesizer output (e.g. AsyncAPI 3.x specs that
	 * were previously opaque YAML become structured operation fragments).
	 */
	getParserShapeVersionPolicy(): number | null {
		const row = this.stmtGetParserShapeVersion.get() as { parser_shape_version: number | null } | undefined;
		if (row === undefined || row.parser_shape_version === null) return null;
		return row.parser_shape_version;
	}

	/**
	 * Tri-state read of the IN-FLIGHT scan policy. NULL = no scan in
	 * progress or last scan finalized cleanly; true/false = a scan is/was
	 * interrupted under that policy. Startup uses this to detect a
	 * partial scan whose policy may differ from the current
	 * `args.includeHidden` — `getIncludeHiddenPolicy` only captures the
	 * LAST CLEAN policy, so a revert-restart after a SIGTERM mid-flip
	 * would otherwise see no mismatch and serve a contaminated snapshot
	 * until reconcile drained.
	 */
	getInflightIncludeHidden(): boolean | null {
		const row = this.stmtGetInflightIncludeHidden.get() as { inflight_include_hidden: number | null } | undefined;
		if (row === undefined || row.inflight_include_hidden === null) return null;
		return row.inflight_include_hidden === 1;
	}

	/**
	 * Records the policy under which the current scan is starting.
	 * Cleared in {@link markScanFinalized}'s single UPDATE on clean finish.
	 */
	setInflightIncludeHidden(value: boolean): void {
		this.stmtSetInflightIncludeHidden.run({ value: value ? 1 : 0 });
	}

	/**
	 * Tri-state read of the IN-FLIGHT scan's {@link PARSER_SHAPE_VERSION}.
	 * NULL = no scan in progress or last scan finalized cleanly; integer =
	 * a scan is/was running under that shape. Startup compares this against
	 * the in-code constant when `scan_complete=0` so a partial rescan
	 * under a different shape, followed by a revert-restart back to the
	 * shape the finalized stamp records, surfaces as a mismatch and forces
	 * cold instead of serving a mixed-shape warm snapshot.
	 */
	getInflightParserShape(): number | null {
		const row = this.stmtGetInflightParserShape.get() as { inflight_parser_shape_version: number | null } | undefined;
		if (row === undefined || row.inflight_parser_shape_version === null) return null;
		return row.inflight_parser_shape_version;
	}

	/**
	 * Records the parser-output-shape under which the current scan is
	 * starting. Cleared in {@link markScanFinalized}'s single UPDATE on
	 * clean finish, atomically with the include-hidden inflight marker.
	 */
	setInflightParserShape(value: number): void {
		this.stmtSetInflightParserShape.run({ value });
	}

	/**
	 * Single point of "scan reached full success." Atomically commits
	 * `scan_complete=1`, `ever_complete=1`,
	 * `include_hidden=<current policy>`, and `inflight_include_hidden=NULL`
	 * via one UPDATE so the persisted `include_hidden` always identifies
	 * the last cleanly-finalized snapshot's policy AND the in-flight
	 * marker is cleared atomically.
	 *
	 * Also resets `failedSubtreesPresent`. Merkle-driven finalizes
	 * did not previously clear this sticky flag, leaving degradation stuck
	 * `true` until process restart. Both scanner and merkle gate finalize
	 * on "no failures observed this pass," so clearing here is always
	 * correct.
	 *
	 * Every call writes; no cache-skip. Under same-policy multi-process
	 * operation a peer's cached `scan_complete=true` can be stale
	 * relative to disk if another peer writes `scan_complete=0` during
	 * its scan; a cache-skip would leave disk stuck at 0. The skip would
	 * save ~1 SQL write per peer lifetime — unmeasurable; dropping it is
	 * free.
	 */
	markScanFinalized(): void {
		// Capture once so the surfaced `last_scan_finished_at` exactly
		// matches the DB row (no jitter from a second `Date.now()` read).
		const finishedAt = Date.now();
		this.stmtFinalize.run({
			include_hidden: this.includeHidden ? 1 : 0,
			last_scan_finished_at: finishedAt,
			vault_extensions: this.vaultExtensions,
			parser_shape_version: PARSER_SHAPE_VERSION,
		});
		this.setStatus("warm");
		this.scanIncomplete = false;
		this.failedSubtreesPresent = false;
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
		return this.buildStatus(this.readStatusFields());
	}

	/**
	 * Atomic combined snapshot of `IndexStatus` plus `ever_complete`,
	 * read in ONE prepared-statement invocation. Used by `buildServerInfo`
	 * (`get_server_info`) so a same-policy multi-process peer's atomic
	 * `markScanFinalized` cannot land between two SELECTs and surface a
	 * `{ever_complete: true, last_scan_finished_at: undefined}` combination
	 * that never existed on disk.
	 *
	 * `_meta.index_status` stays on the narrower {@link IndexStatus} shape
	 * so `ever_complete` doesn't leak onto every tool's envelope.
	 */
	getStatusSnapshot(): IndexStatusSnapshot {
		const row = this.readStatusFields();
		return { ...this.buildStatus(row), ever_complete: row.ever_complete === 1 };
	}

	/**
	 * Epoch-ms of the most recent {@link markScanFinalized}. NULL when
	 * never finalized. Surfaced as ISO 8601 via {@link getStatus}; this
	 * accessor returns the raw ms value for tests that need exact-bounds
	 * comparisons against `Date.now()`.
	 */
	getLastScanFinishedAt(): number | null {
		return this.readStatusFields().last_scan_finished_at;
	}

	private buildStatus(row: StatusFieldsRow): IndexStatus {
		const status: IndexStatus = { state: this.state, files_indexed: row.files_indexed };
		if (row.last_scan_finished_at !== null) {
			status.last_scan_finished_at = new Date(row.last_scan_finished_at).toISOString();
		}
		const degraded = this.getDegradedSignals();
		if (degraded.failed_subtrees_present || degraded.pending_retries > 0) status.degraded = degraded;
		return status;
	}

	private readStatusFields(): StatusFieldsRow {
		return this.stmtGetStatusFields.get() as StatusFieldsRow;
	}

	/**
	 * Current-scan degradation signals for `_meta.index_status.degraded`
	 * and `get_server_info`. `failedSubtreesPresent` is sticky from end of
	 * the most recent scan (reset at scanner start), so this reflects the
	 * CURRENT scan only — historical EACCES is not retained.
	 */
	getDegradedSignals(): { failed_subtrees_present: boolean; pending_retries: number } {
		return {
			failed_subtrees_present: this.failedSubtreesPresent,
			pending_retries: this.pendingRetries.size,
		};
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
		return (this.stmtCountFiles.get() as { n: number }).n;
	}

	/**
	 * Currently-indexed file paths. Used by the scanner's clean-finish
	 * prune pass: files in this list but not on disk are deleted via
	 * {@link removeFile}.
	 */
	listIndexedFiles(): string[] {
		return (this.stmtListIndexedFiles.all() as Array<{ file: string }>).map((r) => r.file);
	}

	fileHasRows(file: string): boolean {
		return this.stmtFileExists.get({ file }) !== undefined;
	}

	/**
	 * Storage-layer cache-prefix predicate: search / get_links SQL has
	 * none, so a pre-existing or planted DB with `.markdown-mcp/*` rows
	 * would leak through the warm-publish window.
	 */
	sweepIndexCacheRows(): void {
		const args = { prefix: INDEX_CACHE_GLOB };
		const stmts = isFsCaseInsensitiveResolved() ? this.stmtsSweepCacheLower : this.stmtsSweepCacheByteWise;
		this.db
			.transaction(() => {
				let totalChanges = 0;
				for (const stmt of stmts) totalChanges += stmt.run(args).changes;
				// Snapshot persists in SQLite; without a bump on real deletes,
				// a pre-restart cursor would pass the equality check on a
				// different row set. Zero-changes skips the bump to preserve
				// cursors across no-op restarts (common path).
				if (totalChanges > 0) this.bumpSnapshot();
			})
			.immediate();
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
	 * Retirement-diff per-file commit. Survivors (stable_id present in
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
		// `ORDER BY id ASC` IS document order: SQLite assigns rowids
		// monotonically per insert, scanner inserts wikilinks preamble-first
		// then headings in source order. The pre-rename ORDER BY used JSON-lex
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
		// alphabetically and within each file in document order.
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
 * BY uses (`source_file ASC, id ASC`). After cross-chunk merging,
 * sort with this comparator and the merged output is byte-for-byte
 * identical to a single-pass query (modulo the page cap).
 */
function compareIncomingKeyset(a: WikilinkRow, b: WikilinkRow): number {
	if (a.source_file !== b.source_file) return a.source_file < b.source_file ? -1 : 1;
	return a.id - b.id;
}

/**
 * Wikilinks keyset cursor on `{source_file?, id}`. SQLite rowids
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
