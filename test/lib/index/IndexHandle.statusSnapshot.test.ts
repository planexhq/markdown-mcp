/**
 * D39 — `getStatusSnapshot()` returns the same shape as `getStatus()` plus
 * `ever_complete`, all read in a single prepared-statement invocation.
 *
 * Atomicity (multi-process peer-finalize race) is exercised separately in
 * `IndexHandle.multiProcess.test.ts`; this file pins the per-call shape /
 * field-presence contract.
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

describe("IndexHandle.getStatusSnapshot — combined shape", () => {
	test("fresh DB: ever_complete=false, no last_scan_finished_at, no degraded", () => {
		const snap = index.getStatusSnapshot();
		expect(snap.state).toBe("cold");
		expect(snap.files_indexed).toBe(0);
		expect(snap.ever_complete).toBe(false);
		expect(snap.last_scan_finished_at).toBeUndefined();
		expect(snap.degraded).toBeUndefined();
	});

	test("post-finalize: ever_complete=true and last_scan_finished_at populated", () => {
		index.markScanFinalized();
		const snap = index.getStatusSnapshot();
		expect(snap.ever_complete).toBe(true);
		expect(snap.last_scan_finished_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
	});

	test("getStatus + getEverComplete agree with getStatusSnapshot on the same DB", () => {
		index.markScanFinalized();
		const status = index.getStatus();
		const everComplete = index.getEverComplete();
		const snap = index.getStatusSnapshot();
		expect(snap.state).toBe(status.state);
		expect(snap.files_indexed).toBe(status.files_indexed);
		expect(snap.last_scan_finished_at).toBe(status.last_scan_finished_at);
		expect(snap.ever_complete).toBe(everComplete);
	});

	test("degraded propagates: failed_subtrees_present flag surfaces on snapshot too", () => {
		index.setFailedSubtreesPresent(true);
		const snap = index.getStatusSnapshot();
		expect(snap.degraded).toEqual({ failed_subtrees_present: true, pending_retries: 0 });
	});

	test("markScanFinalized clears failedSubtreesPresent", () => {
		// Merkle-driven finalize did not reset this flag pre-D40 (only
		// scanner's finally cleared it), so a recovered subtree kept
		// reporting degraded until process restart.
		index.setFailedSubtreesPresent(true);
		expect(index.getStatus().degraded?.failed_subtrees_present).toBe(true);
		index.markScanFinalized();
		const snap = index.getStatusSnapshot();
		expect(snap.degraded).toBeUndefined();
		expect(snap.ever_complete).toBe(true);
	});

	test("markScanFinalized does NOT clear pendingRetries (separate signal)", () => {
		// pendingRetries is per-file and drains via clearPendingRetry; the
		// finalize-time clear only touches the subtree flag.
		index.setFailedSubtreesPresent(true);
		index.addPendingRetry("notes/foo.md");
		index.markScanFinalized();
		const snap = index.getStatusSnapshot();
		expect(snap.degraded).toEqual({ failed_subtrees_present: false, pending_retries: 1 });
	});
});
