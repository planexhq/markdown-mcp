/**
 * D37: `index_meta.last_scan_finished_at` round-trip.
 *
 * - Column is NULL on a freshly-migrated DB.
 * - `markScanFinalized` writes `Date.now()` epoch ms atomically with the
 *   rest of the finalize columns.
 * - `getStatus()` surfaces it as ISO 8601 when populated, omits when NULL.
 * - Pre-D37 caches (without the column) migrate cleanly via `ensureColumn`;
 *   first post-upgrade finalize populates the value.
 */

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { createIndexHandle, type IndexHandle } from "../../../src/lib/index/IndexHandle.js";
import { closeSqlite, openSqlite, runMigrationV1 } from "../../../src/lib/index/sqlite.js";

let opened: ReturnType<typeof openSqlite>;

beforeEach(() => {
	opened = openSqlite({ dbPath: ":memory:" });
});

afterEach(() => {
	closeSqlite(opened.db);
});

function readColumn(): number | null {
	const row = opened.db.prepare("SELECT last_scan_finished_at FROM index_meta WHERE id = 1").get() as {
		last_scan_finished_at: number | null;
	};
	return row.last_scan_finished_at;
}

describe("last_scan_finished_at — column lifecycle", () => {
	test("freshly migrated DB has NULL", () => {
		const index: IndexHandle = createIndexHandle(opened.db, { includeHidden: false });
		expect(readColumn()).toBeNull();
		expect(index.getLastScanFinishedAt()).toBeNull();
	});

	test("`markScanFinalized` writes a positive epoch-ms timestamp", () => {
		const index: IndexHandle = createIndexHandle(opened.db, { includeHidden: false });
		const before = Date.now();
		index.markScanFinalized();
		const after = Date.now();

		const stored = readColumn();
		expect(stored).not.toBeNull();
		// The write happens between `before` and `after`; allow exact equality
		// (sub-ms scheduling can produce identical Date.now() reads).
		expect(stored).toBeGreaterThanOrEqual(before);
		expect(stored).toBeLessThanOrEqual(after);

		expect(index.getLastScanFinishedAt()).toBe(stored);
	});

	test("repeated `markScanFinalized` updates the timestamp (later > earlier)", async () => {
		const index: IndexHandle = createIndexHandle(opened.db, { includeHidden: false });
		index.markScanFinalized();
		const first = index.getLastScanFinishedAt();
		expect(first).not.toBeNull();

		// Ensure a measurable gap so Date.now() advances at least 1 ms.
		await new Promise((resolve) => setTimeout(resolve, 2));

		index.markScanFinalized();
		const second = index.getLastScanFinishedAt();
		expect(second).not.toBeNull();
		expect(second).toBeGreaterThan(first as number);
	});
});

describe("last_scan_finished_at — getStatus integration", () => {
	test("`getStatus()` omits the field when column is NULL", () => {
		const index: IndexHandle = createIndexHandle(opened.db, { includeHidden: false });
		const status = index.getStatus();
		expect(status.last_scan_finished_at).toBeUndefined();
	});

	test("`getStatus()` surfaces ISO 8601 after finalize", () => {
		const index: IndexHandle = createIndexHandle(opened.db, { includeHidden: false });
		index.markScanFinalized();
		const status = index.getStatus();
		expect(status.last_scan_finished_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
		// And the parsed ISO equals the stored ms.
		const ms = new Date(status.last_scan_finished_at as string).getTime();
		expect(ms).toBe(readColumn());
	});
});

test("migration idempotency: running migration twice does not duplicate last_scan_finished_at", () => {
	// First run already happened inside `openSqlite`; do it again
	// explicitly to simulate a same-policy peer migration race
	// (round 36 / round 42).
	runMigrationV1(opened.db);
	runMigrationV1(opened.db);
	const cols = opened.db.prepare("PRAGMA table_info(index_meta)").all() as Array<{ name: string }>;
	const matches = cols.filter((c) => c.name === "last_scan_finished_at");
	expect(matches).toHaveLength(1);
});
