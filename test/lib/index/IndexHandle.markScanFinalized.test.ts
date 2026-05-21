/**
 * `markScanFinalized` commits `scan_complete + ever_complete +
 * include_hidden + inflight_include_hidden=NULL` atomically via one
 * UPDATE so SIGTERM mid-finalize cannot leave a partial state — the
 * persisted `include_hidden` always identifies the last cleanly-
 * finalized snapshot's policy, and the in-flight marker is cleared in
 * the same transition.
 */

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { createIndexHandle, type IndexHandle } from "../../../src/lib/index/IndexHandle.js";
import { closeSqlite, openSqlite } from "../../../src/lib/index/sqlite.js";
import { PARSER_SHAPE_VERSION } from "../../../src/lib/parsers/version.js";

let opened: ReturnType<typeof openSqlite>;

beforeEach(() => {
	opened = openSqlite({ dbPath: ":memory:" });
});

afterEach(() => {
	closeSqlite(opened.db);
});

interface MetaRow {
	scan_complete: number;
	ever_complete: number;
	include_hidden: number | null;
	inflight_include_hidden: number | null;
}

function readMeta(): MetaRow {
	return opened.db
		.prepare(
			"SELECT scan_complete, ever_complete, include_hidden, inflight_include_hidden FROM index_meta WHERE id = 1",
		)
		.get() as MetaRow;
}

describe("markScanFinalized atomicity", () => {
	test("commits scan_complete + ever_complete + include_hidden + cleared inflight in one transition", () => {
		const index: IndexHandle = createIndexHandle(opened.db, { includeHidden: true });
		expect(readMeta()).toEqual({
			scan_complete: 0,
			ever_complete: 0,
			include_hidden: null,
			inflight_include_hidden: null,
		});

		index.markScanFinalized();

		expect(readMeta()).toEqual({
			scan_complete: 1,
			ever_complete: 1,
			include_hidden: 1,
			inflight_include_hidden: null,
		});
		expect(index.getStatus().state).toBe("warm");
	});

	test("persists includeHidden=false correctly (off policy is not just NULL)", () => {
		const index: IndexHandle = createIndexHandle(opened.db, { includeHidden: false });
		index.markScanFinalized();
		expect(readMeta()).toEqual({
			scan_complete: 1,
			ever_complete: 1,
			include_hidden: 0,
			inflight_include_hidden: null,
		});
	});

	test("clears a pre-set inflight_include_hidden marker", () => {
		const index: IndexHandle = createIndexHandle(opened.db, { includeHidden: true });
		// Simulate scanVault's start-of-scan write: marker reflects the
		// running policy until finalize lands.
		index.setInflightIncludeHidden(true);
		expect(readMeta().inflight_include_hidden).toBe(1);

		index.markScanFinalized();

		expect(readMeta().inflight_include_hidden).toBeNull();
		expect(index.getInflightIncludeHidden()).toBeNull();
	});

	test("disk wins over in-memory cache: out-of-band scan_complete reset is overwritten", () => {
		// Invariant: `markScanFinalized` always writes — disk is authoritative.
		// Without this, a concurrent same-policy peer flipping `scan_complete=0`
		// on disk while our cache reads `true` would silently desync.
		const index: IndexHandle = createIndexHandle(opened.db, { includeHidden: true });
		index.markScanFinalized();
		const baselineSnapshot = opened.db.prepare("SELECT value FROM snapshot WHERE id = 1").get() as { value: number };

		opened.db.prepare("UPDATE index_meta SET scan_complete = 0 WHERE id = 1").run();

		index.markScanFinalized();

		expect(readMeta()).toEqual({
			scan_complete: 1,
			ever_complete: 1,
			include_hidden: 1,
			inflight_include_hidden: null,
		});
		// `markScanFinalized` must not bump the snapshot — those bumps are
		// reserved for content-bearing writes in `replaceFile`/`removeFile`.
		const finalSnapshot = opened.db.prepare("SELECT value FROM snapshot WHERE id = 1").get() as { value: number };
		expect(finalSnapshot.value).toBe(baselineSnapshot.value);
	});

	test("policy-flip-then-finalize overwrites prior persisted policy", () => {
		// A clean scan under one policy, then a rebuild under the opposite.
		// The persisted column must reflect the rebuild's policy after
		// `markScanFinalized` lands.
		const first: IndexHandle = createIndexHandle(opened.db, { includeHidden: true });
		first.markScanFinalized();
		expect(readMeta().include_hidden).toBe(1);

		const second: IndexHandle = createIndexHandle(opened.db, { includeHidden: false });
		second.markScanFinalized();
		expect(readMeta()).toEqual({
			scan_complete: 1,
			ever_complete: 1,
			include_hidden: 0,
			inflight_include_hidden: null,
		});
	});
});

describe("parser_shape_version persistence", () => {
	test("getParserShapeVersionPolicy returns null on a fresh DB before any finalize", () => {
		const index: IndexHandle = createIndexHandle(opened.db, { includeHidden: false });
		expect(index.getParserShapeVersionPolicy()).toBeNull();
	});

	test("markScanFinalized persists the running PARSER_SHAPE_VERSION", () => {
		const index: IndexHandle = createIndexHandle(opened.db, { includeHidden: false });
		index.markScanFinalized();
		expect(index.getParserShapeVersionPolicy()).toBe(PARSER_SHAPE_VERSION);
	});

	test("parser_shape_version writes atomically alongside scan_complete + ever_complete + include_hidden", () => {
		const index: IndexHandle = createIndexHandle(opened.db, { includeHidden: true });
		index.markScanFinalized();
		const row = opened.db
			.prepare("SELECT scan_complete, ever_complete, include_hidden, parser_shape_version FROM index_meta WHERE id = 1")
			.get() as {
			scan_complete: number;
			ever_complete: number;
			include_hidden: number | null;
			parser_shape_version: number | null;
		};
		expect(row).toEqual({
			scan_complete: 1,
			ever_complete: 1,
			include_hidden: 1,
			parser_shape_version: PARSER_SHAPE_VERSION,
		});
	});

	test("re-finalize after manual column reset re-stamps the running version", () => {
		// Manual UPDATE simulates an out-of-band cache corruption or a
		// downgrade-then-upgrade cycle. The next finalize writes the
		// current in-code value regardless of what's on disk.
		const index: IndexHandle = createIndexHandle(opened.db, { includeHidden: false });
		index.markScanFinalized();
		opened.db.prepare("UPDATE index_meta SET parser_shape_version = 0 WHERE id = 1").run();
		expect(index.getParserShapeVersionPolicy()).toBe(0);

		index.markScanFinalized();
		expect(index.getParserShapeVersionPolicy()).toBe(PARSER_SHAPE_VERSION);
	});
});

describe("multi-process write-on-change cache removal", () => {
	test("setScanComplete writes disk even when this handle's prior observation matches the requested value", () => {
		// Same-policy multi-process operation is allowed. Peer A and
		// peer B both construct against a cold DB (`scan_complete=0`); if
		// `setScanComplete` cached, B's `setScanComplete(false)` after A
		// finalizes `scan_complete=1` on disk would skip the write and
		// leave disk at 1 mid-B-scan — next startup would see warm and
		// take the (mtime, size) skip path, silently missing preserved-
		// mtime edits made during B's interrupted run.
		const peerA: IndexHandle = createIndexHandle(opened.db, { includeHidden: false });
		const peerB: IndexHandle = createIndexHandle(opened.db, { includeHidden: false });
		// Both peers observed `scan_complete=0` at construction. A finalizes.
		peerA.markScanFinalized();
		expect(readMeta().scan_complete).toBe(1);

		// B's "cache" (if any) would say 0; the persisted value is 1. B
		// must write 0 to disk for its scan to honor the per-scan reset.
		peerB.setScanComplete(false);
		expect(readMeta().scan_complete).toBe(0);
	});

	test("setInflightIncludeHidden writes disk even when this handle's prior observation matches", () => {
		// Symmetric with the scan_complete case: A's finalize clears
		// inflight to NULL on disk; B's cached observation may still say
		// the same NULL, but `setInflightIncludeHidden(true)` after that
		// must hit disk for the next startup's interrupted-flip detection
		// to fire correctly.
		const peerA: IndexHandle = createIndexHandle(opened.db, { includeHidden: true });
		const peerB: IndexHandle = createIndexHandle(opened.db, { includeHidden: true });
		peerA.setInflightIncludeHidden(true);
		peerA.markScanFinalized();
		expect(readMeta().inflight_include_hidden).toBeNull();

		// B's observation could be stale `null`; setting to `true` must
		// still write disk regardless.
		peerB.setInflightIncludeHidden(true);
		expect(readMeta().inflight_include_hidden).toBe(1);
	});
});

describe("inflight_parser_shape_version", () => {
	function readInflightShape(): number | null {
		const row = opened.db.prepare("SELECT inflight_parser_shape_version FROM index_meta WHERE id = 1").get() as {
			inflight_parser_shape_version: number | null;
		};
		return row.inflight_parser_shape_version;
	}

	test("setter / getter round-trip via the dedicated column", () => {
		const index: IndexHandle = createIndexHandle(opened.db, { includeHidden: false });
		expect(index.getInflightParserShape()).toBeNull();
		index.setInflightParserShape(PARSER_SHAPE_VERSION);
		expect(readInflightShape()).toBe(PARSER_SHAPE_VERSION);
		expect(index.getInflightParserShape()).toBe(PARSER_SHAPE_VERSION);
	});

	test("markScanFinalized clears the inflight column atomically", () => {
		const index: IndexHandle = createIndexHandle(opened.db, { includeHidden: false });
		index.setInflightParserShape(PARSER_SHAPE_VERSION);
		expect(readInflightShape()).toBe(PARSER_SHAPE_VERSION);

		index.markScanFinalized();

		expect(readInflightShape()).toBeNull();
		expect(index.getInflightParserShape()).toBeNull();
		// Finalize still writes the canonical stamp into the finalized column.
		const finalized = opened.db.prepare("SELECT parser_shape_version FROM index_meta WHERE id = 1").get() as {
			parser_shape_version: number;
		};
		expect(finalized.parser_shape_version).toBe(PARSER_SHAPE_VERSION);
	});

	test("stale inflight value from an interrupted older binary surfaces on next open", () => {
		// Simulate: an older binary started a scan, wrote inflight=9,
		// then SIGTERMed before finalize. A fresh handle (this one) opens
		// the same DB and reads the stale value.
		opened.db.prepare("UPDATE index_meta SET inflight_parser_shape_version = 9 WHERE id = 1").run();
		const index: IndexHandle = createIndexHandle(opened.db, { includeHidden: false });
		expect(index.getInflightParserShape()).toBe(9);
	});
});
