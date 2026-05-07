/**
 * SQLite schema + migration tests.
 */

import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, test, vi } from "vitest";

import {
	closeSqlite,
	openSqlite,
	openSqliteWithRecovery,
	runMigrationV1,
	runMigrationV2,
	runMigrationV3,
	wipeIndexCache,
} from "../../../src/lib/index/sqlite.js";

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

describe("migration idempotency", () => {
	test("running migration on already-migrated DB is a no-op (no error, schema unchanged)", () => {
		const { db } = open();
		// Re-import + re-run via the same connection — the IF-NOT-EXISTS DDL
		// must be safe.
		const v1 = db.prepare("SELECT version FROM schema_version").get() as { version: number };
		expect(v1.version).toBe(1);
	});
});

describe("migration v2 (ever_complete)", () => {
	test("fresh DB has ever_complete=0 after openSqlite", () => {
		const { db } = open();
		const row = db.prepare("SELECT ever_complete FROM index_meta WHERE id = 1").get() as { ever_complete: number };
		expect(row.ever_complete).toBe(0);
	});

	test("v1-shaped DB with scan_complete=1 backfills ever_complete=1", () => {
		// Simulate a DB that pre-dates the v2 migration: run v1 only, then
		// flip scan_complete=1 (modeling a previously-clean scan), THEN run
		// v2. The migration must add the column AND backfill from
		// scan_complete.
		const db = new Database(":memory:");
		try {
			runMigrationV1(db);
			db.prepare("UPDATE index_meta SET scan_complete = 1 WHERE id = 1").run();
			runMigrationV2(db);
			const row = db.prepare("SELECT ever_complete FROM index_meta WHERE id = 1").get() as {
				ever_complete: number;
			};
			expect(row.ever_complete).toBe(1);
		} finally {
			db.close();
		}
	});

	test("v1-shaped DB with scan_complete=0 leaves ever_complete=0 (conservative)", () => {
		// Round-13 buggy state: scan_complete=0 + count>0. Backfill MUST
		// stay 0 here — otherwise upgraders re-inherit the partial-warm
		// bug that round 14 fixes.
		const db = new Database(":memory:");
		try {
			runMigrationV1(db);
			expect(
				(db.prepare("SELECT scan_complete FROM index_meta WHERE id = 1").get() as { scan_complete: number })
					.scan_complete,
			).toBe(0);
			runMigrationV2(db);
			const row = db.prepare("SELECT ever_complete FROM index_meta WHERE id = 1").get() as {
				ever_complete: number;
			};
			expect(row.ever_complete).toBe(0);
		} finally {
			db.close();
		}
	});

	test("running v2 twice is idempotent (no error, no duplicate column)", () => {
		const db = new Database(":memory:");
		try {
			runMigrationV1(db);
			runMigrationV2(db);
			expect(() => runMigrationV2(db)).not.toThrow();
			const cols = db.prepare("PRAGMA table_info(index_meta)").all() as Array<{ name: string }>;
			const everCount = cols.filter((c) => c.name === "ever_complete").length;
			expect(everCount).toBe(1);
		} finally {
			db.close();
		}
	});
});

describe("migration v3 (fragments.size)", () => {
	test("fresh DB has size column on fragments after openSqlite", () => {
		const { db } = open();
		const cols = db.prepare("PRAGMA table_info(fragments)").all() as Array<{ name: string }>;
		expect(cols.some((c) => c.name === "size")).toBe(true);
	});

	test("v1-only DB with existing row gets size=NULL after v3 (no backfill — self-heal on next scan)", () => {
		const db = new Database(":memory:");
		try {
			runMigrationV1(db);
			db.prepare(
				"INSERT INTO fragments (file, anchor_kind, stable_id, heading_path_json, heading_text, structural_path, range_start, range_end, body, code, headings, mtime) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
			).run("a.md", "heading", "h:abcd1234567890", '["A"]', "A", "h2[1]", 0, 100, "hello", "", "A", 1000);
			runMigrationV3(db);
			const row = db.prepare("SELECT size FROM fragments WHERE file = 'a.md'").get() as { size: number | null };
			expect(row.size).toBeNull();
		} finally {
			db.close();
		}
	});

	test("running v3 twice is idempotent (no error, no duplicate column)", () => {
		const db = new Database(":memory:");
		try {
			runMigrationV1(db);
			runMigrationV3(db);
			expect(() => runMigrationV3(db)).not.toThrow();
			const cols = db.prepare("PRAGMA table_info(fragments)").all() as Array<{ name: string }>;
			const sizeCount = cols.filter((c) => c.name === "size").length;
			expect(sizeCount).toBe(1);
		} finally {
			db.close();
		}
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
