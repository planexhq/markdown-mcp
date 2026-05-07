/**
 * Domain façade over the SQLite + FTS5 index. All prepared statements
 * are centralized here; other modules never construct raw statements.
 * Lifecycle state (cold/warming/warm/reconciling) and `filesIndexed`
 * live in memory and are kept in sync by `replaceFile` / `removeFile`;
 * persisted state is the schema rows + the single-row `snapshot` counter.
 */

import type { Database as DatabaseType, Statement } from "better-sqlite3";

import type { AnchorKind, IndexState, IndexStatus, SearchScopeKind } from "../../types.js";
import type { FilterKeysetKey, ScoreDescKey } from "../cursor.js";
import { type CompiledFilter, globEscape } from "../filter.js";
import type { HeadingHistoryRow } from "../fuzzy.js";

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

export interface ReplaceFileArgs {
	file: string;
	mtime: number;
	size: number;
	fragments: ReadonlyArray<FragmentRowInput>;
	frontmatter: FrontmatterInput;
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

export function createIndexHandle(db: DatabaseType): IndexHandle {
	return new IndexHandle(db);
}

export class IndexHandle {
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
	private readonly stmtSelectOldHeadings: Statement;
	private readonly stmtDeleteFragmentsForFile: Statement;
	private readonly stmtInsertFragment: Statement;
	private readonly stmtUpsertFrontmatter: Statement;
	private readonly stmtDeleteFrontmatterTags: Statement;
	private readonly stmtInsertFrontmatterTag: Statement;
	private readonly stmtUpsertHistory: Statement;
	private readonly stmtGetHistoryRow: Statement;
	private readonly stmtGetScanComplete: Statement;
	private readonly stmtSetScanComplete: Statement;
	private readonly stmtGetEverComplete: Statement;
	private readonly stmtMarkEverComplete: Statement;
	private readonly stmtListIndexedFiles: Statement;

	constructor(db: DatabaseType) {
		this.db = db;
		this.stmtBumpSnapshot = db.prepare("UPDATE snapshot SET value = MAX(value + 1, :now) WHERE id = 1 RETURNING value");
		this.stmtGetSnapshot = db.prepare("SELECT value FROM snapshot WHERE id = 1");
		this.stmtCountFiles = db.prepare("SELECT COUNT(DISTINCT file) AS n FROM fragments");
		this.stmtFileExists = db.prepare("SELECT 1 FROM fragments WHERE file = :file LIMIT 1");
		this.stmtGetFileMeta = db.prepare("SELECT mtime, size FROM fragments WHERE file = :file LIMIT 1");
		this.stmtSelectOldHeadings = db.prepare(
			`SELECT stable_id, heading_text, heading_path_json, structural_path, range_start, range_end, mtime
			 FROM fragments WHERE file = :file AND anchor_kind = 'heading'`,
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
		this.stmtMarkEverComplete.run();
	}

	getStatus(): IndexStatus {
		return { state: this.state, files_indexed: this.filesIndexed };
	}

	setStatus(state: IndexState): void {
		this.state = state;
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
	 * coarsen timestamps. Stored size NULL means a v3-migrated row whose
	 * size hasn't been refreshed yet — return false so the next scan re-
	 * indexes it and self-heals the migration.
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
	 * file get a `heading_history` row, which the round-9 confidence-gated
	 * fuzzy resolver later uses to recover cached agent IDs whose slot has
	 * moved (different parent / level / position). Sibling swaps preserve
	 * the per-slot ID set, so neither old ID is "retired".
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
		const hadRows = this.fileHasRows(file);
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
			this.db.prepare("DELETE FROM frontmatter WHERE file = :file").run({ file });
			this.stmtDeleteFrontmatterTags.run({ file });
			this.bumpSnapshot();
		});
		txn();
		if (hadRows) this.filesIndexed--;
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
