/**
 * D37: `IndexStatus.degraded` omit-when-clean + populate-when-set
 * semantics. Source signals:
 *
 *   - `failedSubtreesPresent` (sticky boolean, set by scanner at end of
 *     scan, reset at start of next scan) — exposed via
 *     `setFailedSubtreesPresent`.
 *   - `pendingRetries: Set<string>` — exposed via `addPendingRetry`,
 *     `clearPendingRetry`, `hasPendingRetries`, `pendingRetriesSnapshot`.
 *
 * The new `getDegradedSignals()` getter returns both in one call; the
 * extended `getStatus()` omits `degraded` entirely when both are clean.
 */

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { createIndexHandle, type IndexHandle } from "../../../src/lib/index/IndexHandle.js";
import { closeSqlite, openSqlite } from "../../../src/lib/index/sqlite.js";

let opened: ReturnType<typeof openSqlite>;
let index: IndexHandle;

beforeEach(() => {
	opened = openSqlite({ dbPath: ":memory:" });
	index = createIndexHandle(opened.db, { includeHidden: false });
});

afterEach(() => {
	closeSqlite(opened.db);
});

describe("getDegradedSignals — atomic read", () => {
	test("returns both signals in a single call", () => {
		expect(index.getDegradedSignals()).toEqual({
			failed_subtrees_present: false,
			pending_retries: 0,
		});
	});

	test("reflects setFailedSubtreesPresent state", () => {
		index.setFailedSubtreesPresent(true);
		expect(index.getDegradedSignals().failed_subtrees_present).toBe(true);
		index.setFailedSubtreesPresent(false);
		expect(index.getDegradedSignals().failed_subtrees_present).toBe(false);
	});

	test("reflects addPendingRetry / clearPendingRetry size", () => {
		index.addPendingRetry("a.md");
		index.addPendingRetry("b.md");
		expect(index.getDegradedSignals().pending_retries).toBe(2);
		// `clearPendingRetry` returns true ONLY when the set drains AND
		// other gates are clean — we just want to verify size tracks here.
		index.addPendingRetry("c.md");
		expect(index.getDegradedSignals().pending_retries).toBe(3);
	});
});

describe("getStatus().degraded — omit-when-clean", () => {
	test("clean → `degraded` undefined", () => {
		const status = index.getStatus();
		expect(status.degraded).toBeUndefined();
	});

	test("failed_subtrees_present=true → `degraded` populated", () => {
		index.setFailedSubtreesPresent(true);
		const status = index.getStatus();
		expect(status.degraded).toEqual({
			failed_subtrees_present: true,
			pending_retries: 0,
		});
	});

	test("pending_retries > 0 → `degraded` populated", () => {
		index.addPendingRetry("x.md");
		const status = index.getStatus();
		expect(status.degraded).toEqual({
			failed_subtrees_present: false,
			pending_retries: 1,
		});
	});

	test("both signals set → `degraded` populated with both", () => {
		index.setFailedSubtreesPresent(true);
		index.addPendingRetry("x.md");
		index.addPendingRetry("y.md");
		const status = index.getStatus();
		expect(status.degraded).toEqual({
			failed_subtrees_present: true,
			pending_retries: 2,
		});
	});

	test("clearing both signals returns to clean (degraded omitted)", () => {
		index.setFailedSubtreesPresent(true);
		index.addPendingRetry("x.md");
		// Resolve both.
		index.setFailedSubtreesPresent(false);
		// `clearPendingRetry` is the standard drain — returns false here
		// because `scanInProgress` is implicitly false but the markScanFinalized
		// gate fires only when the set actually drains AND all gates clean.
		// What matters for this test is that `pendingRetries.size` drops to 0.
		// We achieve that by reaching into the public API: re-add nothing and
		// invoke clearPendingRetry to drain the single entry.
		index.clearPendingRetry("x.md");
		expect(index.getDegradedSignals()).toEqual({
			failed_subtrees_present: false,
			pending_retries: 0,
		});
		expect(index.getStatus().degraded).toBeUndefined();
	});
});
