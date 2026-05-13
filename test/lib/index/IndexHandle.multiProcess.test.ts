/**
 * Two `IndexHandle` instances on the same file-backed SQLite DB must
 * report consistent `files_indexed` counts — a per-process incremental
 * cache would desync under same-policy multi-process operation.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { createIndexHandle, type FragmentRowInput, type IndexHandle } from "../../../src/lib/index/IndexHandle.js";
import { closeSqlite, openSqlite } from "../../../src/lib/index/sqlite.js";

let dir: string;
let openedA: ReturnType<typeof openSqlite>;
let openedB: ReturnType<typeof openSqlite>;
let handleA: IndexHandle;
let handleB: IndexHandle;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "markdown-mcp-indexhandle-multiproc-"));
	const dbPath = join(dir, "index.sqlite3");
	openedA = openSqlite({ dbPath });
	openedB = openSqlite({ dbPath });
	handleA = createIndexHandle(openedA.db, { includeHidden: false });
	handleB = createIndexHandle(openedB.db, { includeHidden: false });
});

afterEach(async () => {
	closeSqlite(openedA.db);
	closeSqlite(openedB.db);
	await rm(dir, { recursive: true, force: true });
});

function headingRow(stableId: string): FragmentRowInput {
	return {
		anchor_kind: "heading",
		stable_id: stableId,
		heading_path_json: JSON.stringify(["H"]),
		heading_text: "H",
		structural_path: "h1[1]",
		range_start: 0,
		range_end: 10,
		body: "body",
		code: "",
		headings: "H",
	};
}

function writeOne(handle: IndexHandle, file: string): void {
	handle.replaceFile({
		file,
		mtime: 1000,
		size: 100,
		fragments: [headingRow("h:1")],
		frontmatter: { created: null, updated: null, fields_json: "{}", tags: [] },
	});
}

describe("IndexHandle.getStatus().files_indexed — multi-process same-policy", () => {
	test("peer's replaceFile is visible to the other handle's countFiles", () => {
		expect(handleA.countFiles()).toBe(0);
		expect(handleB.countFiles()).toBe(0);
		writeOne(handleA, "x.md");
		expect(handleA.countFiles()).toBe(1);
		expect(handleB.countFiles()).toBe(1);
		expect(handleA.getStatus().files_indexed).toBe(1);
		expect(handleB.getStatus().files_indexed).toBe(1);
	});

	test("peer's removeFile is visible — count does not go negative", () => {
		writeOne(handleA, "x.md");
		expect(handleB.countFiles()).toBe(1);
		// B decrements for a row B never inserted; a cached count would
		// underflow to -1 because B's startup-time count was 0.
		handleB.removeFile("x.md", Date.now());
		expect(handleA.countFiles()).toBe(0);
		expect(handleB.countFiles()).toBe(0);
		expect(handleA.getStatus().files_indexed).toBe(0);
		expect(handleB.getStatus().files_indexed).toBe(0);
	});

	test("interleaved inserts + removes stay consistent across handles", () => {
		writeOne(handleA, "a.md");
		writeOne(handleB, "b.md");
		expect(handleA.countFiles()).toBe(2);
		expect(handleB.countFiles()).toBe(2);
		handleA.removeFile("b.md", Date.now());
		expect(handleA.countFiles()).toBe(1);
		expect(handleB.countFiles()).toBe(1);
		handleB.removeFile("a.md", Date.now());
		expect(handleA.countFiles()).toBe(0);
		expect(handleB.countFiles()).toBe(0);
	});
});
