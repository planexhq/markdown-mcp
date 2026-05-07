/**
 * SQLite + FTS5 schema, pragmas, and migration runner. Single home for
 * raw DDL; all DML routes through {@link IndexHandle}. Schema v1 is
 * applied idempotently on every open via `CREATE ... IF NOT EXISTS` +
 * `INSERT OR IGNORE`, so reopening an existing DB is effectively a
 * no-op (better-sqlite3's `prepare` throws on missing tables, ruling
 * out a cheap pre-check short-circuit).
 */

import { existsSync } from "node:fs";
import { unlink } from "node:fs/promises";
import type { Database as DatabaseType } from "better-sqlite3";
import Database from "better-sqlite3";

import { getErrnoCode } from "../error.js";
import { isCanonicalUtcIso } from "../filter.js";

/**
 * Output of {@link openSqlite}. `preexisted` distinguishes "fresh DB,
 * scanner must populate" from "existing DB, snapshot is usable" so the
 * server can set initial `index_status` correctly.
 */
export interface OpenedSqlite {
	db: DatabaseType;
	preexisted: boolean;
}

export interface OpenSqliteOptions {
	dbPath: string;
	/**
	 * `"create"` (default) opens-or-creates. `"open"` requires the file
	 * to exist (used by tests that pre-populate a DB). `":memory:"` is
	 * passed through verbatim — useful for unit tests.
	 */
	policy?: "create" | "open";
}

const PRAGMAS = [
	"PRAGMA journal_mode = WAL",
	"PRAGMA synchronous = NORMAL",
	"PRAGMA foreign_keys = ON",
	"PRAGMA busy_timeout = 5000",
] as const;

/**
 * Open (or create) the index database, apply pragmas, and ensure the
 * schema is at v1. Returns the raw `Database` plus a `preexisted` flag.
 *
 * For `:memory:` DBs `preexisted` is always `false` (each open is a
 * brand-new in-memory database).
 */
export function openSqlite(options: OpenSqliteOptions): OpenedSqlite {
	const { dbPath, policy = "create" } = options;
	const isMemory = dbPath === ":memory:";
	const preexisted = isMemory ? false : existsSync(dbPath);
	if (policy === "open" && !preexisted) {
		throw new Error(`openSqlite: policy="open" but ${dbPath} does not exist.`);
	}
	const db = new Database(dbPath);
	for (const pragma of PRAGMAS) db.exec(pragma);
	registerUdfs(db);
	runMigrationV1(db);
	runMigrationV2(db);
	runMigrationV3(db);
	return { db, preexisted };
}

/**
 * The `.sqlite3` main file plus the WAL-mode sidecars `-wal` and `-shm`.
 * Single source of truth for "what files make up the on-disk index" —
 * shared by the symlink/regular-file guard in `validatePath.ts` and the
 * corruption-recovery wipe below.
 */
export function indexCacheFiles(dbPath: string): readonly string[] {
	return [dbPath, `${dbPath}-wal`, `${dbPath}-shm`];
}

/**
 * SQLite codes that mean the on-disk file is structurally unusable.
 * `SQLITE_NOTADB` = magic-header mismatch (someone wrote non-DB bytes);
 * `SQLITE_CORRUPT` = malformed page; `SQLITE_IOERR_SHORT_READ` = file
 * truncated mid-page (sigkill / disk-full mid-write).
 *
 * Deliberately excluded: `SQLITE_BUSY`, `SQLITE_LOCKED`, `SQLITE_PERM`,
 * `SQLITE_READONLY`, `SQLITE_CANTOPEN`. These are operator-actionable
 * (kill the holder, fix permissions, remount RW) — silent wipe-and-retry
 * would either fail the same way or paper over the real issue.
 */
const CORRUPTION_CODES = new Set(["SQLITE_NOTADB", "SQLITE_CORRUPT", "SQLITE_IOERR_SHORT_READ"]);

function isCorruptionError(err: unknown): err is Error & { code: string } {
	if (!(err instanceof Error)) return false;
	const code = getErrnoCode(err);
	return code !== undefined && CORRUPTION_CODES.has(code);
}

/**
 * Each unlink is ENOENT-tolerant — partial corruption may leave only a
 * subset present. Other errno (EROFS, EACCES) rethrows so the caller
 * sees a real filesystem problem instead of a silent partial wipe.
 */
export async function wipeIndexCache(dbPath: string): Promise<void> {
	for (const path of indexCacheFiles(dbPath)) {
		try {
			await unlink(path);
		} catch (err) {
			if (getErrnoCode(err) !== "ENOENT") throw err;
		}
	}
}

/**
 * Open SQLite with one auto-recovery pass for cache corruption. On a
 * corruption code (SQLITE_NOTADB / SQLITE_CORRUPT / SQLITE_IOERR_SHORT_READ),
 * wipe the file + WAL/SHM sidecars and retry once. Any other error — and a
 * second corruption throw on the retry — propagates.
 *
 * Logs to stderr so operators see the recovery happened: silent rebuild
 * would mask data loss when an agent expected the prior snapshot.
 *
 * Recovery resets `preexisted=false` (the wipe removed the file before the
 * retry), so `chooseStartupState` correctly cold-starts and triggers a
 * full rescan.
 */
export async function openSqliteWithRecovery(options: OpenSqliteOptions): Promise<OpenedSqlite> {
	try {
		return openSqlite(options);
	} catch (err) {
		if (!isCorruptionError(err)) throw err;
		console.error(`vault-mcp index: corrupt cache detected (${err.code}); wiping and rebuilding.`);
		await wipeIndexCache(options.dbPath);
		return openSqlite(options);
	}
}

/**
 * Connection-scoped SQL UDFs. Re-registered on every {@link openSqlite}
 * since better-sqlite3 user functions don't persist with the database.
 *
 * `iso_calendar_valid(s)` returns `s` when {@link isCanonicalUtcIso}
 * accepts it; otherwise NULL. Used by `RESERVED_DATE_EXPR` in
 * `filter.ts` to gate the COALESCE chain so raw frontmatter typos like
 * `"2024-99-99T00:00:00Z"` fall through to `updated`/`created`/mtime
 * instead of slipping in via a shape-only GLOB.
 */
export function registerUdfs(db: DatabaseType): void {
	db.function("iso_calendar_valid", { deterministic: true, varargs: false }, (s: unknown): string | null => {
		return typeof s === "string" && isCanonicalUtcIso(s) ? s : null;
	});
}

/**
 * Close the database. Issues `PRAGMA wal_checkpoint(TRUNCATE)` first so
 * the WAL is folded into the main file (the next reopen sees a single
 * file, no `-wal` / `-shm` left over). Safe to call multiple times.
 */
export function closeSqlite(db: DatabaseType): void {
	if (!db.open) return;
	try {
		db.pragma("wal_checkpoint(TRUNCATE)");
	} catch {
		// WAL checkpoint can fail if another connection holds the file;
		// the DB still closes cleanly. Don't surface as a fatal error.
	}
	db.close();
}

export function runMigrationV1(db: DatabaseType): void {
	db.transaction(() => {
		db.exec(SCHEMA_V1_DDL);
	})();
}

/**
 * Idempotent `ALTER TABLE … ADD COLUMN` with optional in-txn backfill.
 *
 * Skipped via `PRAGMA table_info` (cheap metadata read) rather than a
 * `schema_version` bump because v1's `CHECK (version = 1)` pins the row
 * and widening it would require a table rebuild — not worth it for
 * single-column adds.
 *
 * `postAdd` runs inside the same transaction as the ALTER, so a crash
 * between the column add and the backfill rolls both back together.
 */
function alterAddColumn(
	db: DatabaseType,
	table: string,
	column: string,
	ddl: string,
	postAdd?: (db: DatabaseType) => void,
): void {
	const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
	if (cols.some((c) => c.name === column)) return;
	db.transaction(() => {
		db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
		postAdd?.(db);
	})();
}

/**
 * v2 adds `index_meta.ever_complete`: a one-way persistent flag set on the
 * first clean scan finish. `chooseStartupState` uses it to distinguish a
 * partial first scan (no usable snapshot) from an interrupted reconcile of
 * a previously-complete index. Without this flag, a partial first scan with
 * any rows would advertise itself as warm at restart, silently truncating
 * vault-wide search to the indexed subset.
 */
export function runMigrationV2(db: DatabaseType): void {
	alterAddColumn(db, "index_meta", "ever_complete", "ever_complete INTEGER NOT NULL DEFAULT 0", (d) => {
		// Backfill: existing DBs with `scan_complete=1` definitely had a clean
		// scan. Existing partial-state DBs (`scan_complete=0` + count>0) are
		// conservatively treated as never-complete — they get a one-time
		// rescan to gain warm status, which is the correct behavior; the
		// alternative (backfill from `EXISTS rows`) would re-introduce the
		// round-13 partial-warm bug for upgraders.
		d.exec("UPDATE index_meta SET ever_complete = 1 WHERE scan_complete = 1");
	});
}

/**
 * v3 adds `fragments.size`: the on-disk file size in bytes, captured at
 * `replaceFile` time. The warm-restart skip path keys on `(mtime, size)` so
 * `rsync -t` / `cp -p` / `tar -p` (which preserve source mtime on a content-
 * changed copy) can no longer slip through and leave stale FTS / frontmatter
 * rows in place.
 *
 * No backfill: existing rows stay NULL. `isFileUnchanged` treats NULL as
 * "stored size unknown → cannot trust the skip" and returns false, forcing
 * a one-time re-index that populates size on every file. Self-healing.
 */
export function runMigrationV3(db: DatabaseType): void {
	alterAddColumn(db, "fragments", "size", "size INTEGER");
}

// One `db.exec` so a crash mid-CREATE rolls back the txn cleanly. The
// FTS5 `tokenchars ''-_''` literal uses SQL's doubled-single-quote
// escape — each `''` collapses to one `'`, leaving FTS5 to see
// `tokenchars '-_'`.
const SCHEMA_V1_DDL = `
CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER PRIMARY KEY CHECK (version = 1)
);
INSERT OR IGNORE INTO schema_version (version) VALUES (1);

CREATE TABLE IF NOT EXISTS snapshot (
  id    INTEGER PRIMARY KEY CHECK (id = 1),
  value INTEGER NOT NULL
);
INSERT OR IGNORE INTO snapshot (id, value) VALUES (1, 0);

CREATE TABLE IF NOT EXISTS fragments (
  id                INTEGER PRIMARY KEY,
  file              TEXT    NOT NULL,
  anchor_kind       TEXT    NOT NULL,
  stable_id         TEXT,
  heading_path_json TEXT,
  heading_text      TEXT,
  structural_path   TEXT,
  range_start       INTEGER NOT NULL,
  range_end         INTEGER NOT NULL,
  body              TEXT    NOT NULL,
  code              TEXT    NOT NULL,
  headings          TEXT    NOT NULL,
  mtime             INTEGER NOT NULL,
  CHECK (
    (anchor_kind = 'heading'  AND stable_id IS NOT NULL AND heading_path_json IS NOT NULL AND heading_text IS NOT NULL AND structural_path IS NOT NULL)
 OR (anchor_kind = 'preamble' AND stable_id IS NULL     AND heading_path_json IS NULL     AND heading_text IS NULL     AND structural_path IS NULL)
 OR (anchor_kind = 'file'     AND stable_id IS NULL     AND heading_path_json IS NULL     AND heading_text IS NULL     AND structural_path IS NULL)
  )
);
CREATE INDEX IF NOT EXISTS fragments_by_file      ON fragments(file);
CREATE INDEX IF NOT EXISTS fragments_by_kind_file ON fragments(anchor_kind, file);
CREATE UNIQUE INDEX IF NOT EXISTS fragments_by_stable_id
  ON fragments(file, stable_id) WHERE stable_id IS NOT NULL;

CREATE VIRTUAL TABLE IF NOT EXISTS fragments_fts USING fts5(
  body, code, headings,
  content='fragments', content_rowid='id',
  tokenize='porter unicode61 remove_diacritics 2 tokenchars ''-_'''
);

CREATE TRIGGER IF NOT EXISTS fragments_ai AFTER INSERT ON fragments BEGIN
  INSERT INTO fragments_fts(rowid, body, code, headings)
    VALUES (new.id, new.body, new.code, new.headings);
END;
CREATE TRIGGER IF NOT EXISTS fragments_ad AFTER DELETE ON fragments BEGIN
  INSERT INTO fragments_fts(fragments_fts, rowid, body, code, headings)
    VALUES ('delete', old.id, old.body, old.code, old.headings);
END;
CREATE TRIGGER IF NOT EXISTS fragments_au AFTER UPDATE ON fragments BEGIN
  INSERT INTO fragments_fts(fragments_fts, rowid, body, code, headings)
    VALUES ('delete', old.id, old.body, old.code, old.headings);
  INSERT INTO fragments_fts(rowid, body, code, headings)
    VALUES (new.id, new.body, new.code, new.headings);
END;

CREATE TABLE IF NOT EXISTS frontmatter (
  file        TEXT PRIMARY KEY,
  created     TEXT,
  updated     TEXT,
  fields_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS frontmatter_tags (
  file TEXT NOT NULL,
  tag  TEXT NOT NULL,
  PRIMARY KEY (file, tag)
);
CREATE INDEX IF NOT EXISTS frontmatter_tags_by_tag ON frontmatter_tags(tag);

CREATE TABLE IF NOT EXISTS index_meta (
  id            INTEGER PRIMARY KEY CHECK (id = 1),
  scan_complete INTEGER NOT NULL DEFAULT 0
);
INSERT OR IGNORE INTO index_meta (id, scan_complete) VALUES (1, 0);

CREATE TABLE IF NOT EXISTS heading_history (
  file                   TEXT    NOT NULL,
  stable_id              TEXT    NOT NULL,
  last_heading_text      TEXT    NOT NULL,
  last_heading_path_json TEXT    NOT NULL,
  last_structural_path   TEXT    NOT NULL,
  last_range_start       INTEGER NOT NULL,
  last_range_end         INTEGER NOT NULL,
  last_seen_mtime        INTEGER NOT NULL,
  retired_at_mtime       INTEGER NOT NULL,
  PRIMARY KEY (file, stable_id)
);
`;
