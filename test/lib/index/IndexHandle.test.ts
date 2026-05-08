/**
 * IndexHandle integration tests against `:memory:` SQLite.
 */

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { parseHeadingPathJson } from "../../../src/lib/cursor.js";
import { compileFilter } from "../../../src/lib/filter.js";
import { createIndexHandle, type FragmentRowInput, type IndexHandle } from "../../../src/lib/index/IndexHandle.js";
import { closeSqlite, openSqlite } from "../../../src/lib/index/sqlite.js";

let opened: ReturnType<typeof openSqlite>;
let index: IndexHandle;

beforeEach(() => {
	opened = openSqlite({ dbPath: ":memory:" });
	index = createIndexHandle(opened.db);
});

afterEach(() => {
	closeSqlite(opened.db);
});

function headingRow(args: {
	stable_id: string;
	heading_path: string[];
	heading_text: string;
	structural_path: string;
	body?: string;
}): FragmentRowInput {
	return {
		anchor_kind: "heading",
		stable_id: args.stable_id,
		heading_path_json: JSON.stringify(args.heading_path),
		heading_text: args.heading_text,
		structural_path: args.structural_path,
		range_start: 0,
		range_end: 100,
		body: args.body ?? `body for ${args.heading_text}`,
		code: "",
		headings: args.heading_path.join(" "),
	};
}

describe("replaceFile — round-trip", () => {
	test("inserts heading rows + frontmatter + tags", () => {
		index.replaceFile({
			file: "a.md",
			mtime: 1000,
			size: 100,
			fragments: [
				headingRow({ stable_id: "h:1", heading_path: ["A"], heading_text: "A", structural_path: "h1[1]" }),
				headingRow({
					stable_id: "h:2",
					heading_path: ["A", "B"],
					heading_text: "B",
					structural_path: "h1[1]/h2[1]",
				}),
			],
			frontmatter: { created: "2024-01-01T00:00:00Z", updated: null, fields_json: '{"x":1}', tags: ["api"] },
		});
		expect(index.countFiles()).toBe(1);
		const row = opened.db.prepare("SELECT count(*) AS n FROM fragments WHERE file = ?").get("a.md") as { n: number };
		expect(row.n).toBe(2);
		const fm = opened.db.prepare("SELECT created, fields_json FROM frontmatter WHERE file = ?").get("a.md") as {
			created: string;
			fields_json: string;
		};
		expect(fm.created).toBe("2024-01-01T00:00:00Z");
		expect(fm.fields_json).toBe('{"x":1}');
		const tagRow = opened.db.prepare("SELECT tag FROM frontmatter_tags WHERE file = ?").all("a.md") as Array<{
			tag: string;
		}>;
		expect(tagRow.map((t) => t.tag)).toContain("api");
	});

	test("snapshot bumps after replaceFile", () => {
		const before = index.getSnapshot();
		index.replaceFile({
			file: "a.md",
			mtime: 1000,
			size: 100,
			fragments: [headingRow({ stable_id: "h:1", heading_path: ["A"], heading_text: "A", structural_path: "h1[1]" })],
			frontmatter: { created: null, updated: null, fields_json: "{}", tags: [] },
		});
		expect(index.getSnapshot()).toBeGreaterThan(before);
	});

	test("isFileUnchanged round-trips fractional mtime bit-exact", () => {
		// Sub-ms precision must survive write+read so `Math.floor` isn't
		// reintroduced silently. APFS/ext4 pass fractional mtimeMs values
		// through `stat`; collapsing them would let two distinct revisions
		// in the same integer ms compare equal in the warm-restart skip.
		const fractional = 1746789432891.5;
		index.replaceFile({
			file: "frac.md",
			mtime: fractional,
			size: 100,
			fragments: [headingRow({ stable_id: "h:1", heading_path: ["A"], heading_text: "A", structural_path: "h1[1]" })],
			frontmatter: { created: null, updated: null, fields_json: "{}", tags: [] },
		});
		expect(index.isFileUnchanged({ file: "frac.md", mtime: fractional, size: 100 })).toBe(true);
		expect(index.isFileUnchanged({ file: "frac.md", mtime: 1746789432891, size: 100 })).toBe(false);
		expect(index.isFileUnchanged({ file: "frac.md", mtime: 1746789432892, size: 100 })).toBe(false);
	});

	test("isFileUnchanged false when size diverges (rsync -t / cp -p / tar -p hazard)", () => {
		// `rsync -t` / `cp -p` / `tar -p` preserve source mtime on a content-
		// changed copy. The (mtime, size) skip key catches it; mtime alone
		// would silently retain stale rows.
		index.replaceFile({
			file: "rs.md",
			mtime: 1000,
			size: 100,
			fragments: [headingRow({ stable_id: "h:1", heading_path: ["A"], heading_text: "A", structural_path: "h1[1]" })],
			frontmatter: { created: null, updated: null, fields_json: "{}", tags: [] },
		});
		expect(index.isFileUnchanged({ file: "rs.md", mtime: 1000, size: 100 })).toBe(true);
		expect(index.isFileUnchanged({ file: "rs.md", mtime: 1000, size: 200 })).toBe(false);
	});

	test("isFileUnchanged false when stored size is NULL (self-heal channel)", () => {
		// `fragments.size = NULL` is the runtime self-heal marker: any path
		// (corruption-recovery rebuild, manual surgery) can NULL the size to
		// force re-parse on next scan. NULL must return false here, otherwise
		// the skip-path would silently keep stale rows past the marker.
		index.replaceFile({
			file: "legacy.md",
			mtime: 1000,
			size: 100,
			fragments: [headingRow({ stable_id: "h:1", heading_path: ["A"], heading_text: "A", structural_path: "h1[1]" })],
			frontmatter: { created: null, updated: null, fields_json: "{}", tags: [] },
		});
		opened.db.prepare("UPDATE fragments SET size = NULL WHERE file = 'legacy.md'").run();
		expect(index.isFileUnchanged({ file: "legacy.md", mtime: 1000, size: 100 })).toBe(false);
	});
});

describe("replaceFile — D32 retirement-diff", () => {
	test("survivor heading does NOT add to heading_history (non-growth)", () => {
		index.replaceFile({
			file: "a.md",
			mtime: 1000,
			size: 100,
			fragments: [headingRow({ stable_id: "h:1", heading_path: ["A"], heading_text: "A", structural_path: "h1[1]" })],
			frontmatter: { created: null, updated: null, fields_json: "{}", tags: [] },
		});
		expect(historyRowCount(opened.db, "a.md")).toBe(0);
		// Re-write with the SAME heading set.
		index.replaceFile({
			file: "a.md",
			mtime: 2000,
			size: 100,
			fragments: [headingRow({ stable_id: "h:1", heading_path: ["A"], heading_text: "A", structural_path: "h1[1]" })],
			frontmatter: { created: null, updated: null, fields_json: "{}", tags: [] },
		});
		expect(historyRowCount(opened.db, "a.md")).toBe(0);
	});

	test("retired heading DOES add to heading_history", () => {
		index.replaceFile({
			file: "a.md",
			mtime: 1000,
			size: 100,
			fragments: [
				headingRow({ stable_id: "h:1", heading_path: ["A"], heading_text: "A", structural_path: "h1[1]" }),
				headingRow({ stable_id: "h:2", heading_path: ["B"], heading_text: "B", structural_path: "h1[2]" }),
			],
			frontmatter: { created: null, updated: null, fields_json: "{}", tags: [] },
		});
		// Re-write WITHOUT h:2.
		index.replaceFile({
			file: "a.md",
			mtime: 2000,
			size: 100,
			fragments: [headingRow({ stable_id: "h:1", heading_path: ["A"], heading_text: "A", structural_path: "h1[1]" })],
			frontmatter: { created: null, updated: null, fields_json: "{}", tags: [] },
		});
		expect(historyRowCount(opened.db, "a.md")).toBe(1);
		const row = index.getHistoryRow("a.md", "h:2");
		expect(row).not.toBeNull();
		expect(row?.last_heading_text).toBe("B");
		expect(row?.retired_at_mtime).toBe(2000);
	});

	test("sibling swap does NOT write history (same stable_id set; outline stays authoritative)", () => {
		// Pre-swap: A at slot 1 (h:s1), B at slot 2 (h:s2). Post-swap: same
		// hash set, texts swapped. Diff loop only writes history when an ID
		// is GONE from the new set; neither is, so heading_history stays
		// empty and the resolver trusts the current outline.
		index.replaceFile({
			file: "swap.md",
			mtime: 1000,
			size: 100,
			fragments: [
				headingRow({ stable_id: "h:s1", heading_path: ["A"], heading_text: "A", structural_path: "h1[1]" }),
				headingRow({ stable_id: "h:s2", heading_path: ["B"], heading_text: "B", structural_path: "h1[2]" }),
			],
			frontmatter: { created: null, updated: null, fields_json: "{}", tags: [] },
		});
		expect(historyRowCount(opened.db, "swap.md")).toBe(0);
		index.replaceFile({
			file: "swap.md",
			mtime: 2000,
			size: 100,
			fragments: [
				headingRow({ stable_id: "h:s1", heading_path: ["B"], heading_text: "B", structural_path: "h1[1]" }),
				headingRow({ stable_id: "h:s2", heading_path: ["A"], heading_text: "A", structural_path: "h1[2]" }),
			],
			frontmatter: { created: null, updated: null, fields_json: "{}", tags: [] },
		});
		expect(historyRowCount(opened.db, "swap.md")).toBe(0);
	});

	test("rename-in-place does NOT add history (ID survives → skip)", () => {
		// Same stable_id present in both old + new set → diff loop skips it.
		// The cached ID still semantically refers to the same heading;
		// surfacing it as stale would mark every typo-fix as stale.
		index.replaceFile({
			file: "rename.md",
			mtime: 1000,
			size: 100,
			fragments: [
				headingRow({ stable_id: "h:r", heading_path: ["Apha"], heading_text: "Apha", structural_path: "h1[1]" }),
			],
			frontmatter: { created: null, updated: null, fields_json: "{}", tags: [] },
		});
		index.replaceFile({
			file: "rename.md",
			mtime: 2000,
			size: 100,
			fragments: [
				headingRow({ stable_id: "h:r", heading_path: ["Alpha"], heading_text: "Alpha", structural_path: "h1[1]" }),
			],
			frontmatter: { created: null, updated: null, fields_json: "{}", tags: [] },
		});
		expect(historyRowCount(opened.db, "rename.md")).toBe(0);
	});

	test("pure survivor (same id + same text) stays out of history (regression guard)", () => {
		index.replaceFile({
			file: "survivor.md",
			mtime: 1000,
			size: 100,
			fragments: [
				headingRow({ stable_id: "h:v", heading_path: ["Same"], heading_text: "Same", structural_path: "h1[1]" }),
			],
			frontmatter: { created: null, updated: null, fields_json: "{}", tags: [] },
		});
		index.replaceFile({
			file: "survivor.md",
			mtime: 2000,
			size: 100,
			fragments: [
				headingRow({ stable_id: "h:v", heading_path: ["Same"], heading_text: "Same", structural_path: "h1[1]" }),
			],
			frontmatter: { created: null, updated: null, fields_json: "{}", tags: [] },
		});
		expect(historyRowCount(opened.db, "survivor.md")).toBe(0);
	});
});

describe("removeFile — snapshot bump gate", () => {
	test("never-indexed path is a no-op: snapshot + filesIndexed unchanged", () => {
		// No-op writes must preserve `snapshot_mtime` so in-flight
		// cursors stay valid.
		const beforeSnap = index.getSnapshot();
		const beforeCount = index.countFiles();
		index.removeFile("never-indexed.png", Date.now());
		expect(index.getSnapshot()).toBe(beforeSnap);
		expect(index.countFiles()).toBe(beforeCount);
	});

	test("indexed path: snapshot bumps after removeFile", () => {
		index.replaceFile({
			file: "real.md",
			mtime: 1000,
			size: 100,
			fragments: [headingRow({ stable_id: "h:1", heading_path: ["A"], heading_text: "A", structural_path: "h1[1]" })],
			frontmatter: { created: null, updated: null, fields_json: "{}", tags: [] },
		});
		const before = index.getSnapshot();
		index.removeFile("real.md", Date.now());
		expect(index.getSnapshot()).toBeGreaterThan(before);
	});
});

describe("searchQueryMode + searchFilterMode", () => {
	beforeEach(() => {
		index.replaceFile({
			file: "a.md",
			mtime: 1000,
			size: 100,
			fragments: [
				headingRow({
					stable_id: "h:1",
					heading_path: ["Auth"],
					heading_text: "Auth",
					structural_path: "h1[1]",
					body: "OAuth2 setup notes",
				}),
				headingRow({
					stable_id: "h:2",
					heading_path: ["Tags"],
					heading_text: "Tags",
					structural_path: "h1[2]",
					body: "Frontmatter tags discussion",
				}),
			],
			frontmatter: { created: null, updated: null, fields_json: "{}", tags: ["api"] },
		});
	});

	test("query mode finds matching row by FTS5 MATCH", () => {
		const rows = index.searchQueryMode({
			match: '"oauth2"',
			scope: { kind: "vault" },
			filter: null,
			pageSize: 10,
		});
		expect(rows.length).toBeGreaterThan(0);
		expect(rows[0]?.body).toContain("OAuth2");
	});

	test("filter mode returns rows in deterministic order", () => {
		const rows = index.searchFilterMode({
			scope: { kind: "vault" },
			filter: null,
			pageSize: 10,
		});
		expect(rows.length).toBe(2);
		expect(rows[0]?.score).toBe(0);
	});
});

describe("searchQueryMode — D18 BM25 column weights (body=2.0, code=0.5, headings=3.0)", () => {
	test("same term ranks heading-only > body-only > code-only", () => {
		// Three single-row files isolating "uniqueterm" to one FTS column each.
		// Equal frequency (1 occurrence); rank differs by D18 column weights.
		const filler = "filler text content here padding for similar doc length";
		const baseFragment = {
			anchor_kind: "heading" as const,
			heading_path_json: JSON.stringify(["title"]),
			heading_text: "title",
			structural_path: "h1[1]",
			range_start: 0,
			range_end: 100,
		};
		index.replaceFile({
			file: "a.md",
			mtime: 1000,
			size: 100,
			fragments: [{ ...baseFragment, stable_id: "h:a", body: filler, code: "", headings: "uniqueterm padding here" }],
			frontmatter: { created: null, updated: null, fields_json: "{}", tags: [] },
		});
		index.replaceFile({
			file: "b.md",
			mtime: 1000,
			size: 100,
			fragments: [
				{ ...baseFragment, stable_id: "h:b", body: `uniqueterm ${filler}`, code: "", headings: "padding here" },
			],
			frontmatter: { created: null, updated: null, fields_json: "{}", tags: [] },
		});
		index.replaceFile({
			file: "c.md",
			mtime: 1000,
			size: 100,
			fragments: [{ ...baseFragment, stable_id: "h:c", body: filler, code: "uniqueterm", headings: "padding here" }],
			frontmatter: { created: null, updated: null, fields_json: "{}", tags: [] },
		});
		const rows = index.searchQueryMode({
			match: '"uniqueterm"',
			scope: { kind: "vault" },
			filter: null,
			pageSize: 10,
		});
		expect(rows.map((r) => r.file)).toEqual(["a.md", "b.md", "c.md"]);
		// Higher score is better (`-bm25` inversion); confirm strict ordering.
		expect(rows[0]?.score).toBeGreaterThan(rows[1]?.score ?? 0);
		expect(rows[1]?.score).toBeGreaterThan(rows[2]?.score ?? 0);
	});
});

describe("search cursor — `id` tiebreaker for duplicate heading_path", () => {
	beforeEach(() => {
		// Two sibling headings with identical heading_path JSON: the
		// `(file, heading_path, anchor_kind)` tuple ties between them.
		// Without the `id` tiebreaker, page-2's strict-greater-than
		// predicate would skip the second row.
		index.replaceFile({
			file: "dup.md",
			mtime: 1000,
			size: 100,
			fragments: [
				headingRow({
					stable_id: "h:dup-a",
					heading_path: ["Setup", "Database"],
					heading_text: "Database",
					structural_path: "h1[1]/h2[1]",
					body: "first occurrence body",
				}),
				headingRow({
					stable_id: "h:dup-b",
					heading_path: ["Setup", "Database"],
					heading_text: "Database",
					structural_path: "h1[1]/h2[2]",
					body: "second occurrence body",
				}),
			],
			frontmatter: { created: null, updated: null, fields_json: "{}", tags: [] },
		});
	});

	test("filter mode pageSize=1 paginates through both duplicate-path rows", () => {
		const page1 = index.searchFilterMode({
			scope: { kind: "vault" },
			filter: null,
			pageSize: 1,
		});
		expect(page1.length).toBe(1);
		const first = page1[0];
		if (first === undefined) throw new Error("expected first row");

		const page2 = index.searchFilterMode({
			scope: { kind: "vault" },
			filter: null,
			pageSize: 1,
			after: {
				file: first.file,
				heading_path: parseHeadingPathJson(first.heading_path_json),
				anchor_kind: first.anchor_kind,
				id: first.id,
			},
		});
		expect(page2.length).toBe(1);
		const second = page2[0];
		if (second === undefined) throw new Error("expected second row");
		expect(second.id).not.toBe(first.id);
		expect(second.stable_id).not.toBe(first.stable_id);
	});

	test("query mode pageSize=1 paginates through bm25-tied rows", () => {
		// Both rows share the body keyword; their bm25 scores will be very
		// close (often equal). The `id` tiebreaker keeps pagination correct
		// even when score ties.
		const page1 = index.searchQueryMode({
			match: "occurrence",
			scope: { kind: "vault" },
			filter: null,
			pageSize: 1,
		});
		expect(page1.length).toBe(1);
		const first = page1[0];
		if (first === undefined) throw new Error("expected first row");

		const page2 = index.searchQueryMode({
			match: "occurrence",
			scope: { kind: "vault" },
			filter: null,
			pageSize: 1,
			after: {
				score: first.score,
				file: first.file,
				heading_path: parseHeadingPathJson(first.heading_path_json),
				anchor_kind: first.anchor_kind,
				id: first.id,
			},
		});
		expect(page2.length).toBe(1);
		expect(page2[0]?.id).not.toBe(first.id);
	});
});

describe("subtree scope — case sensitivity (G4)", () => {
	beforeEach(() => {
		index.replaceFile({
			file: "Notes/uppercase.md",
			mtime: 1000,
			size: 100,
			fragments: [
				headingRow({
					stable_id: "h:up",
					heading_path: ["Upper"],
					heading_text: "Upper",
					structural_path: "h1[1]",
					body: "uppercase notes body",
				}),
			],
			frontmatter: { created: null, updated: null, fields_json: "{}", tags: [] },
		});
		index.replaceFile({
			file: "notes/lowercase.md",
			mtime: 1000,
			size: 100,
			fragments: [
				headingRow({
					stable_id: "h:lo",
					heading_path: ["Lower"],
					heading_text: "Lower",
					structural_path: "h1[1]",
					body: "lowercase notes body",
				}),
			],
			frontmatter: { created: null, updated: null, fields_json: "{}", tags: [] },
		});
	});

	test("subtree 'Notes' matches only Notes/ (not notes/) — case-sensitive", () => {
		const rows = index.searchFilterMode({
			scope: { kind: "subtree", value: "Notes" },
			filter: null,
			pageSize: 10,
		});
		expect(rows.map((r) => r.file)).toEqual(["Notes/uppercase.md"]);
	});

	test("subtree 'notes' matches only notes/ (not Notes/) — case-sensitive", () => {
		const rows = index.searchFilterMode({
			scope: { kind: "subtree", value: "notes" },
			filter: null,
			pageSize: 10,
		});
		expect(rows.map((r) => r.file)).toEqual(["notes/lowercase.md"]);
	});

	test("subtree with GLOB metachars in directory name escapes correctly", () => {
		index.replaceFile({
			file: "weird*dir/leaf.md",
			mtime: 1000,
			size: 100,
			fragments: [
				headingRow({
					stable_id: "h:weird",
					heading_path: ["Weird"],
					heading_text: "Weird",
					structural_path: "h1[1]",
					body: "weird path body",
				}),
			],
			frontmatter: { created: null, updated: null, fields_json: "{}", tags: [] },
		});
		// `weird*dir` literal must match only that exact path; without
		// escaping, GLOB would treat `*` as a wildcard.
		const rows = index.searchFilterMode({
			scope: { kind: "subtree", value: "weird*dir" },
			filter: null,
			pageSize: 10,
		});
		expect(rows.map((r) => r.file)).toEqual(["weird*dir/leaf.md"]);
	});
});

describe("searchFilterMode + filter null-aware in/nin (end-to-end)", () => {
	beforeEach(() => {
		// Three rows with `x` ∈ {"a", "b", null} so each null-aware
		// IN/NOT IN combination produces a distinguishable result set.
		index.replaceFile({
			file: "x-a.md",
			mtime: 1000,
			size: 100,
			fragments: [headingRow({ stable_id: "h:a", heading_path: ["A"], heading_text: "A", structural_path: "h1[1]" })],
			frontmatter: { created: null, updated: null, fields_json: '{"x":"a"}', tags: [] },
		});
		index.replaceFile({
			file: "x-b.md",
			mtime: 1000,
			size: 100,
			fragments: [headingRow({ stable_id: "h:b", heading_path: ["B"], heading_text: "B", structural_path: "h1[1]" })],
			frontmatter: { created: null, updated: null, fields_json: '{"x":"b"}', tags: [] },
		});
		index.replaceFile({
			file: "x-null.md",
			mtime: 1000,
			size: 100,
			fragments: [headingRow({ stable_id: "h:n", heading_path: ["N"], heading_text: "N", structural_path: "h1[1]" })],
			// `x` absent from frontmatter → json_extract returns SQL NULL
			frontmatter: { created: null, updated: null, fields_json: "{}", tags: [] },
		});
	});

	test("in: [null] returns the null-x row only", () => {
		const filter = compileFilter({ fields: { x: { in: [null] } } });
		const rows = index.searchFilterMode({ scope: { kind: "vault" }, filter, pageSize: 10 });
		expect(rows.map((r) => r.file)).toEqual(["x-null.md"]);
	});

	test("nin: [null] returns non-null rows only (excludes the null-x row)", () => {
		const filter = compileFilter({ fields: { x: { nin: [null] } } });
		const rows = index.searchFilterMode({ scope: { kind: "vault" }, filter, pageSize: 10 });
		expect(rows.map((r) => r.file).sort()).toEqual(["x-a.md", "x-b.md"]);
	});

	test("in: ['a', null] returns x=a + null-x rows", () => {
		const filter = compileFilter({ fields: { x: { in: ["a", null] } } });
		const rows = index.searchFilterMode({ scope: { kind: "vault" }, filter, pageSize: 10 });
		expect(rows.map((r) => r.file).sort()).toEqual(["x-a.md", "x-null.md"]);
	});

	test("nin: ['a', null] returns only x=b (excludes both 'a' and null)", () => {
		const filter = compileFilter({ fields: { x: { nin: ["a", null] } } });
		const rows = index.searchFilterMode({ scope: { kind: "vault" }, filter, pageSize: 10 });
		expect(rows.map((r) => r.file)).toEqual(["x-b.md"]);
	});

	test("nin: ['a'] (no null) preserves null-x row (existing SQL convention)", () => {
		const filter = compileFilter({ fields: { x: { nin: ["a"] } } });
		const rows = index.searchFilterMode({ scope: { kind: "vault" }, filter, pageSize: 10 });
		expect(rows.map((r) => r.file).sort()).toEqual(["x-b.md", "x-null.md"]);
	});
});

describe("searchFilterMode + filter ISO-canonical scalar operand", () => {
	beforeEach(() => {
		// Two rows with custom `due` field. Mirrors what the scanner stores
		// after `normalizeNestedDates` canonicalizes ISO-shaped strings:
		// `due: 2024-06-01` (date-only) → "2024-06-01T00:00:00Z" in fields_json.
		index.replaceFile({
			file: "due-jun.md",
			mtime: 1000,
			size: 100,
			fragments: [headingRow({ stable_id: "h:dj", heading_path: ["J"], heading_text: "J", structural_path: "h1[1]" })],
			frontmatter: {
				created: null,
				updated: null,
				fields_json: '{"due":"2024-06-01T00:00:00Z"}',
				tags: [],
			},
		});
		index.replaceFile({
			file: "due-jul.md",
			mtime: 1000,
			size: 100,
			fragments: [headingRow({ stable_id: "h:dl", heading_path: ["L"], heading_text: "L", structural_path: "h1[1]" })],
			frontmatter: {
				created: null,
				updated: null,
				fields_json: '{"due":"2024-07-01T00:00:00Z"}',
				tags: [],
			},
		});
	});

	test("eq: '2024-06-01' canonicalizes operand → matches canonical-stored value", () => {
		const filter = compileFilter({ fields: { due: { eq: "2024-06-01" } } });
		const rows = index.searchFilterMode({ scope: { kind: "vault" }, filter, pageSize: 10 });
		expect(rows.map((r) => r.file)).toEqual(["due-jun.md"]);
	});

	test("nin: ['2024-06-01'] canonicalizes operand → excludes June, returns July", () => {
		const filter = compileFilter({ fields: { due: { nin: ["2024-06-01"] } } });
		const rows = index.searchFilterMode({ scope: { kind: "vault" }, filter, pageSize: 10 });
		expect(rows.map((r) => r.file)).toEqual(["due-jul.md"]);
	});

	test("in: ['2024-06-01', '2024-07-01'] canonicalizes both → returns both", () => {
		const filter = compileFilter({ fields: { due: { in: ["2024-06-01", "2024-07-01"] } } });
		const rows = index.searchFilterMode({ scope: { kind: "vault" }, filter, pageSize: 10 });
		expect(rows.map((r) => r.file).sort()).toEqual(["due-jul.md", "due-jun.md"]);
	});

	test("eq: canonical operand also matches (idempotent)", () => {
		// Round-trip: agents that already canonicalize their operand still
		// hit the same stored value.
		const filter = compileFilter({ fields: { due: { eq: "2024-06-01T00:00:00Z" } } });
		const rows = index.searchFilterMode({ scope: { kind: "vault" }, filter, pageSize: 10 });
		expect(rows.map((r) => r.file)).toEqual(["due-jun.md"]);
	});
});

describe("searchFilterMode + reserved date COALESCE chain (UDF gate)", () => {
	beforeEach(() => {
		// `bogus.md` carries a calendar-invalid `date` whose 20-char shape
		// matches canonical, plus a valid `updated`. The COALESCE chain
		// must skip the bogus value via the UDF and fall through to
		// `updated`. `valid.md` exercises the happy path.
		index.replaceFile({
			file: "bogus.md",
			mtime: 1000,
			size: 100,
			fragments: [headingRow({ stable_id: "h:bg", heading_path: ["B"], heading_text: "B", structural_path: "h1[1]" })],
			frontmatter: {
				created: null,
				updated: "2024-04-01T00:00:00Z",
				fields_json: '{"date":"2024-99-99T00:00:00Z"}',
				tags: [],
			},
		});
		index.replaceFile({
			file: "valid.md",
			mtime: 1000,
			size: 100,
			fragments: [headingRow({ stable_id: "h:vl", heading_path: ["V"], heading_text: "V", structural_path: "h1[1]" })],
			frontmatter: {
				created: null,
				updated: null,
				fields_json: '{"date":"2024-06-01T00:00:00Z"}',
				tags: [],
			},
		});
	});

	test("date.gte: 2024-01-01 — bogus row falls through to updated; valid row matches via date", () => {
		const filter = compileFilter({ date: { gte: "2024-01-01" } });
		const rows = index.searchFilterMode({ scope: { kind: "vault" }, filter, pageSize: 10 });
		expect(rows.map((r) => r.file).sort()).toEqual(["bogus.md", "valid.md"]);
	});

	test("date.lt: 2024-05-01 — bogus matches (updated 2024-04-01 < 2024-05-01); valid (date 2024-06-01) excluded", () => {
		// Without the UDF, the bogus `date` "2024-99-99T00:00:00Z" would
		// lex-compare and incorrectly EXCLUDE bogus.md from this lt query
		// (99 > 05 lex). With the UDF, the chain reads `updated = 2024-04-01`.
		const filter = compileFilter({ date: { lt: "2024-05-01" } });
		const rows = index.searchFilterMode({ scope: { kind: "vault" }, filter, pageSize: 10 });
		expect(rows.map((r) => r.file)).toEqual(["bogus.md"]);
	});
});

describe("pendingRetries — incremental write semantics + scanInProgress gate", () => {
	test("addPendingRetry adds; hasPendingRetries reflects the size", () => {
		expect(index.hasPendingRetries()).toBe(false);
		index.addPendingRetry("a.md");
		expect(index.hasPendingRetries()).toBe(true);
		index.addPendingRetry("b.md");
		expect(index.hasPendingRetries()).toBe(true);
	});

	test("clearPendingRetry while scanInProgress=true removes from set but does NOT fire markScanFinalized", () => {
		// Gate keeps watcher recoveries from finalizing ahead of
		// scanner's own end-of-scan if-check.
		index.addPendingRetry("a.md");
		index.setScanInProgress(true);
		const drained = index.clearPendingRetry("a.md");
		expect(drained).toBe(false);
		expect(index.hasPendingRetries()).toBe(false);
		expect(index.getScanComplete()).toBe(false);
	});

	test("clearPendingRetry while scanInProgress=false drains set AND fires markScanFinalized", () => {
		index.setStatus("warming");
		index.addPendingRetry("a.md");
		index.setScanInProgress(false);
		const drained = index.clearPendingRetry("a.md");
		expect(drained).toBe(true);
		expect(index.getScanComplete()).toBe(true);
		expect(index.getStatus().state).toBe("warm");
	});

	test("post-release clearPendingRetry on a fresh entry finalizes", () => {
		// A clear that happens while gated removes the entry but doesn't
		// finalize. The next clear after the gate is released — even on a
		// freshly-added entry — must finalize.
		index.setStatus("warming");
		index.addPendingRetry("a.md");
		index.setScanInProgress(true);
		expect(index.clearPendingRetry("a.md")).toBe(false);
		index.setScanInProgress(false);
		index.addPendingRetry("b.md");
		expect(index.clearPendingRetry("b.md")).toBe(true);
		expect(index.getScanComplete()).toBe(true);
		expect(index.getStatus().state).toBe("warm");
	});

	test("clearPendingRetry blocked by failedSubtreesPresent gate", () => {
		// Scenario: scan exited with failedSubtrees=non-empty +
		// pendingRetries=non-empty → setStatus("warming") +
		// setScanInProgress(false) + setFailedSubtreesPresent(true). A
		// later watcher recovery on the last pending entry must NOT
		// finalize because the failed subtree is still uncovered.
		index.setStatus("warming");
		index.addPendingRetry("bar.md");
		index.setScanInProgress(false);
		index.setFailedSubtreesPresent(true);

		const drained = index.clearPendingRetry("bar.md");
		expect(drained).toBe(false);
		expect(index.hasPendingRetries()).toBe(false);
		expect(index.getScanComplete()).toBe(false);
		expect(index.getStatus().state).toBe("warming");
	});

	test("clearPendingRetry finalizes once failedSubtreesPresent flips to false", () => {
		// After a clean follow-up scan that successfully enumerated the
		// previously-failed subtree, the next watcher recovery should
		// finalize.
		index.setStatus("warming");
		index.addPendingRetry("bar.md");
		index.setScanInProgress(false);
		index.setFailedSubtreesPresent(true);
		expect(index.clearPendingRetry("bar.md")).toBe(false);

		// Counter-case: gate releases. A fresh entry's clear must
		// finalize since nothing else is blocking.
		index.setFailedSubtreesPresent(false);
		index.addPendingRetry("baz.md");
		expect(index.clearPendingRetry("baz.md")).toBe(true);
		expect(index.getScanComplete()).toBe(true);
		expect(index.getStatus().state).toBe("warm");
	});

	test("clearPendingRetry blocked by scanIncomplete gate", () => {
		// A scan that aborted before its end-of-scan check has an
		// incomplete walk. Draining the last pendingRetry must not
		// finalize `scan_complete=true` — that would advertise truncated
		// data as warm on the next startup.
		index.setStatus("warming");
		index.addPendingRetry("bar.md");
		index.setScanInProgress(false);
		index.setFailedSubtreesPresent(false);
		index.setScanIncomplete(true);

		const drained = index.clearPendingRetry("bar.md");
		expect(drained).toBe(false);
		expect(index.hasPendingRetries()).toBe(false);
		expect(index.getScanComplete()).toBe(false);
		expect(index.getStatus().state).toBe("warming");
	});

	test("clearPendingRetry finalizes when scanIncomplete is false", () => {
		index.setStatus("warming");
		index.addPendingRetry("bar.md");
		index.setScanInProgress(false);
		index.setFailedSubtreesPresent(false);
		index.setScanIncomplete(false);

		expect(index.clearPendingRetry("bar.md")).toBe(true);
		expect(index.getScanComplete()).toBe(true);
		expect(index.getStatus().state).toBe("warm");
	});

	test("markScanFinalized self-clears scanIncomplete", () => {
		// Merkle's clean-finish calls markScanFinalized directly. The
		// flag must self-clear so a subsequent watcher-driven
		// clearPendingRetry isn't blocked by stale residue.
		index.setStatus("warming");
		index.setScanIncomplete(true);
		index.markScanFinalized();
		expect(index.getScanComplete()).toBe(true);
		expect(index.getStatus().state).toBe("warm");

		index.addPendingRetry("baz.md");
		index.setScanInProgress(false);
		index.setFailedSubtreesPresent(false);
		expect(index.clearPendingRetry("baz.md")).toBe(true);
	});
});

function historyRowCount(db: import("better-sqlite3").Database, file: string): number {
	const row = db.prepare("SELECT count(*) AS n FROM heading_history WHERE file = ?").get(file) as { n: number };
	return row.n;
}
