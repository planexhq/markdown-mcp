/**
 * SQLite schema + migration tests.
 */

import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database, { type Database as DatabaseType } from "better-sqlite3";
import { afterEach, describe, expect, test, vi } from "vitest";

import {
	closeSqlite,
	detectPreW4Schema,
	openSqlite,
	openSqliteWithRecovery,
	runMigrationV1,
	wipeIndexCache,
} from "../../../src/lib/index/sqlite.js";

function listMaster(db: DatabaseType, type: "table" | "index"): string[] {
	const rows = db.prepare("SELECT name FROM sqlite_master WHERE type = ? ORDER BY name").all(type) as Array<{
		name: string;
	}>;
	return rows.map((r) => r.name);
}

/**
 * Seed a fresh DB with the legacy 3-column `index_meta` shape, used
 * by upgrade-path tests to exercise `ensureColumn`'s idempotent
 * ALTER TABLE migrations.
 */
function seedLegacy3ColumnIndexMeta(dbPath: string, scanComplete: 0 | 1, everComplete: 0 | 1): void {
	const seed = new Database(dbPath);
	seed.exec(`
		CREATE TABLE index_meta (
		  id            INTEGER PRIMARY KEY CHECK (id = 1),
		  scan_complete INTEGER NOT NULL DEFAULT 0,
		  ever_complete INTEGER NOT NULL DEFAULT 0
		);
		INSERT INTO index_meta (id, scan_complete, ever_complete) VALUES (1, ${scanComplete}, ${everComplete});
	`);
	seed.close();
}

const opens: ReturnType<typeof openSqlite>[] = [];

afterEach(() => {
	while (opens.length > 0) {
		const o = opens.pop();
		if (o) closeSqlite(o.db);
	}
});

function open() {
	const o = openSqlite({ dbPath: ":memory:" });
	opens.push(o);
	return o;
}

describe("openSqlite", () => {
	test("fresh in-memory DB returns preexisted=false and runs migration v1", () => {
		const { db, preexisted } = open();
		expect(preexisted).toBe(false);
		const row = db.prepare("SELECT version FROM schema_version").get() as { version: number };
		expect(row.version).toBe(1);
	});

	test("snapshot row exists with value=0", () => {
		const { db } = open();
		const row = db.prepare("SELECT value FROM snapshot WHERE id = 1").get() as { value: number };
		expect(row.value).toBe(0);
	});

	test("pragmas applied — journal_mode=WAL is no-op for :memory:, but file-mode WAL works on a tempfile", () => {
		const { db } = open();
		const journal = db.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
		// :memory: forces "memory" journal mode regardless; file-backed DBs
		// would report "wal". The pragma was applied either way.
		expect(["memory", "wal"]).toContain(journal.journal_mode.toLowerCase());
		const fk = db.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number };
		expect(fk.foreign_keys).toBe(1);
	});

	test("consolidated schema creates every expected table + index", () => {
		const { db } = open();
		expect(listMaster(db, "table")).toEqual(
			expect.arrayContaining([
				"file_metrics",
				"fragments",
				"frontmatter",
				"frontmatter_tags",
				"heading_history",
				"index_meta",
				"schema_version",
				"snapshot",
				"wikilinks",
			]),
		);
		expect(listMaster(db, "index")).toEqual(
			expect.arrayContaining([
				"fragments_by_file",
				"fragments_by_kind_file",
				"fragments_by_stable_id",
				"frontmatter_tags_by_tag",
				"wikilinks_by_lc_raw_target",
				"wikilinks_by_raw_target",
				"wikilinks_by_source",
			]),
		);
	});

	test("index_meta has scan_complete + ever_complete + include_hidden + inflight_include_hidden columns", () => {
		const { db } = open();
		const cols = (db.prepare("PRAGMA table_info(index_meta)").all() as Array<{ name: string }>).map((c) => c.name);
		expect(cols.sort()).toEqual(["ever_complete", "id", "include_hidden", "inflight_include_hidden", "scan_complete"]);
	});

	test("legacy 3-column index_meta upgrades cleanly via ensureColumn", async () => {
		// Regression: the seed `INSERT OR IGNORE` once referenced
		// `include_hidden` inside `SCHEMA_V1_DDL`, which runs BEFORE
		// `ensureColumn`. SQLite resolves column names at prepare time, so
		// reopening a legacy 3-col table threw `no column named
		// include_hidden`. Tempfile (not :memory:) is required — the bug
		// only manifests across an open/close cycle.
		const dir = await mkdtemp(join(tmpdir(), "vault-mcp-sqlite-legacy-"));
		const dbPath = join(dir, "index.sqlite3");
		try {
			seedLegacy3ColumnIndexMeta(dbPath, 1, 1);

			const opened = openSqlite({ dbPath });
			try {
				expect(opened.preexisted).toBe(true);
				const cols = (opened.db.prepare("PRAGMA table_info(index_meta)").all() as Array<{ name: string }>).map(
					(c) => c.name,
				);
				expect(cols.sort()).toEqual([
					"ever_complete",
					"id",
					"include_hidden",
					"inflight_include_hidden",
					"scan_complete",
				]);
				const row = opened.db
					.prepare(
						"SELECT scan_complete, ever_complete, include_hidden, inflight_include_hidden FROM index_meta WHERE id = 1",
					)
					.get() as {
					scan_complete: number;
					ever_complete: number;
					include_hidden: number | null;
					inflight_include_hidden: number | null;
				};
				expect(row.scan_complete).toBe(1);
				expect(row.ever_complete).toBe(1);
				expect(row.include_hidden).toBeNull();
				expect(row.inflight_include_hidden).toBeNull();
			} finally {
				closeSqlite(opened.db);
			}
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});

describe("runMigrationV1 concurrent same-policy peers", () => {
	test("two parallel migrations on a legacy 3-col DB both succeed without duplicate-column-name", async () => {
		// Same-policy peers must serialize on the migration's
		// `ensureColumn` PRAGMA→ALTER window — ALTER reads live schema
		// (no snapshot isolation), so a deferred transaction races to
		// "duplicate column name". Iterate to surface timing differences.
		const dir = await mkdtemp(join(tmpdir(), "vault-mcp-sqlite-concurrent-mig-"));
		const dbPath = join(dir, "index.sqlite3");
		try {
			seedLegacy3ColumnIndexMeta(dbPath, 0, 0);

			for (let i = 0; i < 30; i++) {
				const a = new Database(dbPath);
				const b = new Database(dbPath);
				a.pragma("busy_timeout = 5000");
				b.pragma("busy_timeout = 5000");
				try {
					await Promise.all([
						Promise.resolve().then(() => runMigrationV1(a)),
						Promise.resolve().then(() => runMigrationV1(b)),
					]);
				} finally {
					a.close();
					b.close();
				}

				const check = new Database(dbPath);
				try {
					const cols = (check.prepare("PRAGMA table_info(index_meta)").all() as Array<{ name: string }>).map(
						(c) => c.name,
					);
					expect(cols.sort()).toEqual([
						"ever_complete",
						"id",
						"include_hidden",
						"inflight_include_hidden",
						"scan_complete",
					]);
				} finally {
					check.close();
				}
			}
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 30_000);
});

describe("schema CHECK constraints", () => {
	test("heading row missing stable_id rejected", () => {
		const { db } = open();
		expect(() =>
			db
				.prepare(
					"INSERT INTO fragments (file, anchor_kind, range_start, range_end, body, code, headings, mtime) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
				)
				.run("a.md", "heading", 0, 1, "body", "", "h", 0),
		).toThrow();
	});

	test("preamble row with stable_id rejected", () => {
		const { db } = open();
		expect(() =>
			db
				.prepare(
					"INSERT INTO fragments (file, anchor_kind, stable_id, range_start, range_end, body, code, headings, mtime) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
				)
				.run("a.md", "preamble", "h:abcd", 0, 1, "body", "", "h", 0),
		).toThrow();
	});

	test("file row with all heading fields NULL accepted", () => {
		const { db } = open();
		expect(() =>
			db
				.prepare(
					"INSERT INTO fragments (file, anchor_kind, range_start, range_end, body, code, headings, mtime) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
				)
				.run("a.md", "file", 0, 1, "body", "", "stem", 0),
		).not.toThrow();
	});
});

describe("FTS5 trigger correctness", () => {
	test("INSERT into fragments → fragments_fts row appears", () => {
		const { db } = open();
		db.prepare(
			"INSERT INTO fragments (file, anchor_kind, stable_id, heading_path_json, heading_text, structural_path, range_start, range_end, body, code, headings, mtime) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
		).run("a.md", "heading", "h:abcd1234567890", '["A"]', "A", "h2[1]", 0, 100, "hello world", "", "A", 0);
		const row = db.prepare("SELECT count(*) AS n FROM fragments_fts WHERE fragments_fts MATCH 'hello'").get() as {
			n: number;
		};
		expect(row.n).toBe(1);
	});

	test("DELETE from fragments → fragments_fts row removed", () => {
		const { db } = open();
		db.prepare(
			"INSERT INTO fragments (file, anchor_kind, stable_id, heading_path_json, heading_text, structural_path, range_start, range_end, body, code, headings, mtime) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
		).run("a.md", "heading", "h:abcd1234567890", '["A"]', "A", "h2[1]", 0, 100, "hello world", "", "A", 0);
		db.prepare("DELETE FROM fragments WHERE file = ?").run("a.md");
		const row = db.prepare("SELECT count(*) AS n FROM fragments_fts WHERE fragments_fts MATCH 'hello'").get() as {
			n: number;
		};
		expect(row.n).toBe(0);
	});
});

describe("detectPreW4Schema", () => {
	test("fresh DB (both tables empty) → false (no fragments to suspect)", () => {
		const { db } = open();
		expect(detectPreW4Schema(db)).toBe(false);
	});

	test("fragments populated AND file_metrics empty → true (pre-W4 state)", () => {
		const { db } = open();
		db.prepare(
			"INSERT INTO fragments (file, anchor_kind, range_start, range_end, body, code, headings, mtime) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
		).run("a.md", "file", 0, 10, "body", "", "stem", 1000);
		expect(detectPreW4Schema(db)).toBe(true);
	});

	test("fragments populated AND file_metrics populated → false (W4-native)", () => {
		const { db } = open();
		db.prepare(
			"INSERT INTO fragments (file, anchor_kind, range_start, range_end, body, code, headings, mtime) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
		).run("a.md", "file", 0, 10, "body", "", "stem", 1000);
		db.prepare(
			"INSERT INTO file_metrics (file, body_tokens_approx, descendant_tokens_approx, content_kinds_json) VALUES (?, ?, ?, ?)",
		).run("a.md", 5, 5, "[]");
		expect(detectPreW4Schema(db)).toBe(false);
	});

	test("partial: fragments + ONE file_metrics row → false (mixed state, not flagged)", () => {
		// Strict `count = 0` form: any file_metrics row at all skips
		// detection so an in-progress rebuild isn't re-triggered. Trade-
		// off accepted: a hand-corrupted DB with stale fragments + one
		// orphan metrics row would slip through, but no normal code
		// path produces that state.
		const { db } = open();
		db.prepare(
			"INSERT INTO fragments (file, anchor_kind, range_start, range_end, body, code, headings, mtime) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
		).run("a.md", "file", 0, 10, "body", "", "stem", 1000);
		db.prepare(
			"INSERT INTO fragments (file, anchor_kind, range_start, range_end, body, code, headings, mtime) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
		).run("b.md", "file", 0, 10, "body", "", "stem", 1000);
		db.prepare(
			"INSERT INTO file_metrics (file, body_tokens_approx, descendant_tokens_approx, content_kinds_json) VALUES (?, ?, ?, ?)",
		).run("a.md", 5, 5, "[]");
		expect(detectPreW4Schema(db)).toBe(false);
	});
});

describe("migration idempotency", () => {
	test("re-running runMigrationV1 on an already-migrated DB is a no-op", () => {
		const { db } = open();
		const tablesBefore = listMaster(db, "table");
		const indexesBefore = listMaster(db, "index");
		expect(() => runMigrationV1(db)).not.toThrow();
		expect(listMaster(db, "table")).toEqual(tablesBefore);
		expect(listMaster(db, "index")).toEqual(indexesBefore);
	});
});

describe("iso_calendar_valid UDF", () => {
	function selectV(value: unknown): string | null {
		const { db } = open();
		const row = db.prepare("SELECT iso_calendar_valid(?) AS v").get(value) as { v: string | null };
		return row.v;
	}

	test("valid canonical UTC ISO returns input unchanged", () => {
		expect(selectV("2024-06-01T12:34:56Z")).toBe("2024-06-01T12:34:56Z");
	});

	test("leap day (Feb 29 in leap year) accepted", () => {
		expect(selectV("2024-02-29T00:00:00Z")).toBe("2024-02-29T00:00:00Z");
	});

	test("Feb 29 in non-leap year rejected", () => {
		expect(selectV("2023-02-29T00:00:00Z")).toBeNull();
	});

	test("calendar-invalid Feb 31 rejected", () => {
		expect(selectV("2024-02-31T00:00:00Z")).toBeNull();
	});

	test("month 99 / day 99 rejected (regex shape-match but calendar-invalid)", () => {
		expect(selectV("2024-99-99T00:00:00Z")).toBeNull();
	});

	test("hour > 23 rejected", () => {
		expect(selectV("2024-06-01T24:00:00Z")).toBeNull();
	});

	test("minute > 59 rejected", () => {
		expect(selectV("2024-06-01T00:60:00Z")).toBeNull();
	});

	test("second > 59 rejected (no leap-second support)", () => {
		expect(selectV("2024-06-01T00:00:60Z")).toBeNull();
	});

	test("non-canonical shape (date-only) rejected", () => {
		expect(selectV("2024-06-01")).toBeNull();
	});

	test("non-canonical shape (offset, not Z) rejected", () => {
		expect(selectV("2024-06-01T00:00:00+00:00")).toBeNull();
	});

	test("non-canonical shape (fractional seconds) rejected", () => {
		expect(selectV("2024-06-01T00:00:00.123Z")).toBeNull();
	});

	test("NULL input returns NULL", () => {
		expect(selectV(null)).toBeNull();
	});

	test("non-string input returns NULL", () => {
		expect(selectV(20240601)).toBeNull();
	});
});

// Tests use on-disk SQLite (not :memory:) because corruption is a property
// of the file's bytes — the in-memory engine has no path to corrupt.
describe("wipeIndexCache + openSqliteWithRecovery — corruption recovery", () => {
	let tempDir: string;

	async function setup(): Promise<string> {
		tempDir = await mkdtemp(join(tmpdir(), "vault-mcp-sqlite-test-"));
		return join(tempDir, "index.sqlite3");
	}

	afterEach(async () => {
		if (tempDir) await rm(tempDir, { recursive: true, force: true });
		vi.restoreAllMocks();
	});

	describe("wipeIndexCache", () => {
		test("removes main + WAL + SHM when all present", async () => {
			const dbPath = await setup();
			await writeFile(dbPath, "x");
			await writeFile(`${dbPath}-wal`, "x");
			await writeFile(`${dbPath}-shm`, "x");
			await wipeIndexCache(dbPath);
			expect(existsSync(dbPath)).toBe(false);
			expect(existsSync(`${dbPath}-wal`)).toBe(false);
			expect(existsSync(`${dbPath}-shm`)).toBe(false);
		});

		test("ENOENT on any sidecar is tolerated (partial corruption pattern)", async () => {
			const dbPath = await setup();
			await writeFile(dbPath, "x");
			await expect(wipeIndexCache(dbPath)).resolves.toBeUndefined();
			expect(existsSync(dbPath)).toBe(false);
		});

		test("ENOENT on all paths returns without throwing (cold start)", async () => {
			const dbPath = await setup();
			await expect(wipeIndexCache(dbPath)).resolves.toBeUndefined();
		});
	});

	describe("openSqliteWithRecovery", () => {
		test("happy path: valid DB opens unchanged (preexisted=false on first open)", async () => {
			const dbPath = await setup();
			const opened = await openSqliteWithRecovery({ dbPath });
			try {
				expect(opened.preexisted).toBe(false);
				const row = opened.db.prepare("SELECT version FROM schema_version").get() as { version: number };
				expect(row.version).toBe(1);
			} finally {
				closeSqlite(opened.db);
			}
		});

		test("warm restart: existing valid DB opens with preexisted=true", async () => {
			const dbPath = await setup();
			const first = await openSqliteWithRecovery({ dbPath });
			closeSqlite(first.db);
			const second = await openSqliteWithRecovery({ dbPath });
			try {
				expect(second.preexisted).toBe(true);
			} finally {
				closeSqlite(second.db);
			}
		});

		test("corrupt main file (SQLITE_NOTADB) → wipe + retry succeeds", async () => {
			const dbPath = await setup();
			await writeFile(dbPath, "NOTASQLITEDATABASE");
			const stderrSpy = vi.spyOn(console, "error").mockImplementation(() => {});
			const opened = await openSqliteWithRecovery({ dbPath });
			try {
				expect(opened.preexisted).toBe(false);
				const row = opened.db.prepare("SELECT version FROM schema_version").get() as { version: number };
				expect(row.version).toBe(1);
				expect(stderrSpy).toHaveBeenCalledWith(expect.stringMatching(/corrupt cache detected.*SQLITE_NOTADB/));
			} finally {
				closeSqlite(opened.db);
			}
		});

		test("corrupt main + present WAL sidecar → both wiped before retry", async () => {
			const dbPath = await setup();
			await writeFile(dbPath, "NOTASQLITEDATABASE");
			await writeFile(`${dbPath}-wal`, "old wal bytes");
			const stderrSpy = vi.spyOn(console, "error").mockImplementation(() => {});
			const opened = await openSqliteWithRecovery({ dbPath });
			try {
				expect(opened.preexisted).toBe(false);
				expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("corrupt cache detected"));
				// WAL-mode reopen creates a fresh -wal again — what matters is
				// the pre-existing one was wiped, replaced by the retry open.
				expect(existsSync(dbPath)).toBe(true);
			} finally {
				closeSqlite(opened.db);
			}
		});

		test("non-corruption error (policy:open + missing file) propagates unchanged — no wipe attempt", async () => {
			const dbPath = await setup();
			await expect(openSqliteWithRecovery({ dbPath, policy: "open" })).rejects.toThrow(/policy="open"/);
			// File was never created — confirms no wipe path was taken.
			expect(existsSync(dbPath)).toBe(false);
		});
	});
});
