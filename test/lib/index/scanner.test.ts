/**
 * Scanner tests against a temp vault + :memory: SQLite.
 *
 * The retirement-diff non-growth case is the load-bearing one: when
 * a file is rewritten with the same heading set, `heading_history`
 * MUST NOT grow.
 */

import { rm, stat, truncate, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

import { createIndexHandle, type IndexHandle } from "../../../src/lib/index/IndexHandle.js";
import { scanVault } from "../../../src/lib/index/scanner.js";
import { closeSqlite, openSqlite } from "../../../src/lib/index/sqlite.js";
import { type VaultRoot, validateVaultRoot } from "../../../src/lib/validatePath.js";
import { createTempVault, type VaultStructure } from "../../helpers/vault.js";

interface Setup {
	vault: { path: string; cleanup: () => Promise<void> };
	opened: ReturnType<typeof openSqlite>;
	index: IndexHandle;
	vaultRoot: VaultRoot;
	teardown: () => Promise<void>;
}

const setups: Setup[] = [];

async function setup(structure: VaultStructure): Promise<Setup> {
	const vault = await createTempVault(structure);
	const opened = openSqlite({ dbPath: ":memory:" });
	const index = createIndexHandle(opened.db);
	// validateVaultRoot realpath's the temp dir — required for indexOne's
	// `validatePath` containment check to pass on macOS where /var/folders
	// resolves through a symlink to /private/var/folders.
	const vaultRoot: VaultRoot = await validateVaultRoot(vault.path);
	const s: Setup = {
		vault,
		opened,
		index,
		vaultRoot,
		teardown: async () => {
			closeSqlite(opened.db);
			await vault.cleanup();
		},
	};
	setups.push(s);
	return s;
}

afterEach(async () => {
	while (setups.length > 0) {
		const s = setups.pop();
		if (s) await s.teardown();
	}
});

describe("scanVault — basic", () => {
	test("indexes markdown files; skips hidden + non-markdown", async () => {
		const s = await setup({
			"a.md": "# A\n\nbody",
			"b.txt": "ignored",
			".hidden": { "secret.md": "# secret\n" },
			sub: { "c.md": "# C\n" },
		});
		const result = await scanVault({ vaultRoot: s.vaultRoot, index: s.index, concurrency: 2 });
		expect(result.aborted).toBe(false);
		expect(result.filesIndexed).toBe(2); // a.md + sub/c.md
		expect(s.index.getStatus().state).toBe("warm");
	});

	test("stores st.mtimeMs without flooring (preserves sub-ms precision)", async () => {
		// Whatever mtimeMs `stat` returned must round-trip into the index.
		// On macOS APFS / Linux ext4 this often has a fractional component;
		// `Math.floor` would silently drop it and break warm-restart change
		// detection for two saves in the same integer-ms.
		const s = await setup({ "a.md": "# A\n\nbody" });
		const st = await stat(join(s.vault.path, "a.md"));
		await scanVault({ vaultRoot: s.vaultRoot, index: s.index, concurrency: 1 });
		const stored = s.opened.db.prepare("SELECT mtime FROM fragments WHERE file = 'a.md' LIMIT 1").get() as
			| { mtime: number }
			| undefined;
		expect(stored).toBeDefined();
		expect(stored?.mtime).toBe(st.mtimeMs);
	});

	test("aborts cooperatively when AbortSignal fires", async () => {
		const s = await setup({
			"a.md": "# A\n\nbody",
			"b.md": "# B\n\nbody",
		});
		const ctrl = new AbortController();
		ctrl.abort();
		const result = await scanVault({ vaultRoot: s.vaultRoot, index: s.index, signal: ctrl.signal });
		expect(result.aborted).toBe(true);
	});
});

describe("scanVault — D31 file row for frontmatter-only notes", () => {
	test("frontmatter-only note emits one `file` row", async () => {
		// Without this row, filter-only search by tag/date can't surface
		// metadata-only notes — the fragments table is the only retrieval
		// surface for filter-mode queries.
		const s = await setup({
			"fm-only.md": "---\ntags: [important]\n---\n",
		});
		await scanVault({ vaultRoot: s.vaultRoot, index: s.index, concurrency: 1 });
		const row = s.opened.db
			.prepare("SELECT anchor_kind, body, headings FROM fragments WHERE file = 'fm-only.md'")
			.get() as { anchor_kind: string; body: string; headings: string } | undefined;
		expect(row).toBeDefined();
		expect(row?.anchor_kind).toBe("file");
		expect(row?.body).toBe("");
		expect(row?.headings).toBe("fm-only");
		const tag = s.opened.db.prepare("SELECT tag FROM frontmatter_tags WHERE file = 'fm-only.md'").all() as Array<{
			tag: string;
		}>;
		expect(tag.map((t) => t.tag)).toContain("important");
	});
});

describe("scanVault — D32 retirement-diff non-growth", () => {
	test("rewriting a file with unchanged headings does NOT grow heading_history", async () => {
		const s = await setup({ "a.md": "# A\n\nbody" });
		await scanVault({ vaultRoot: s.vaultRoot, index: s.index, concurrency: 1 });
		const historyBefore = countHistory(s.opened.db, "a.md");
		expect(historyBefore).toBe(0);
		// Mutate the body but keep the heading the same. Touch the mtime so
		// the second scan re-processes the file.
		const { writeFile } = await import("node:fs/promises");
		const { join } = await import("node:path");
		await writeFile(join(s.vault.path, "a.md"), "# A\n\nnew body content", "utf8");
		await scanVault({ vaultRoot: s.vaultRoot, index: s.index, concurrency: 1 });
		const historyAfter = countHistory(s.opened.db, "a.md");
		expect(historyAfter).toBe(0);
	});

	test("removed heading writes to heading_history", async () => {
		const s = await setup({ "a.md": "# A\n\n## B\n\nbody" });
		await scanVault({ vaultRoot: s.vaultRoot, index: s.index, concurrency: 1 });
		expect(countHistory(s.opened.db, "a.md")).toBe(0);
		const { writeFile } = await import("node:fs/promises");
		const { join } = await import("node:path");
		// Remove `## B` heading.
		await writeFile(join(s.vault.path, "a.md"), "# A\n\nbody only", "utf8");
		await scanVault({ vaultRoot: s.vaultRoot, index: s.index, concurrency: 1 });
		expect(countHistory(s.opened.db, "a.md")).toBe(1);
	});
});

describe("scanVault — frontmatter ingestion", () => {
	test("YAML tags + dates land in side-tables", async () => {
		const s = await setup({
			"a.md": "---\ntags: [api, auth]\ncreated: 2024-01-01\n---\n\n# A\n\nbody",
		});
		await scanVault({ vaultRoot: s.vaultRoot, index: s.index, concurrency: 1 });
		const tags = s.opened.db
			.prepare("SELECT tag FROM frontmatter_tags WHERE file = 'a.md' ORDER BY tag")
			.all() as Array<{
			tag: string;
		}>;
		expect(tags.map((t) => t.tag)).toEqual(["api", "auth"]);
		const fm = s.opened.db.prepare("SELECT created FROM frontmatter WHERE file = 'a.md'").get() as {
			created: string;
		};
		expect(fm.created).toBe("2024-01-01T00:00:00Z");
	});
});

describe("scanVault — F5 date normalization in fields_json", () => {
	test("date-only `date` key normalized to T00:00:00Z so COALESCE chain compares against ISO", async () => {
		const s = await setup({
			"a.md": "---\ndate: 2024-06-01\n---\n\n# A\n\nbody",
		});
		await scanVault({ vaultRoot: s.vaultRoot, index: s.index, concurrency: 1 });
		const row = s.opened.db
			.prepare("SELECT json_extract(fields_json, '$.\"date\"') AS d FROM frontmatter WHERE file = 'a.md'")
			.get() as { d: string };
		expect(row.d).toBe("2024-06-01T00:00:00Z");
	});

	test("invalid reserved `date` stored raw in fields_json", async () => {
		// Brief line 593 mandates raw-text storage so `fields["date"].eq`
		// can lex-match. The reserved `date` filter chain skips raw non-
		// canonical values via the GLOB shape-check on RESERVED_DATE_EXPR.
		const s = await setup({
			"a.md": "---\ndate: not-a-date\nupdated: 2024-06-01\n---\n\n# A\n\nbody",
		});
		await scanVault({ vaultRoot: s.vaultRoot, index: s.index, concurrency: 1 });
		const row = s.opened.db
			.prepare("SELECT json_extract(fields_json, '$.\"date\"') AS d FROM frontmatter WHERE file = 'a.md'")
			.get() as { d: string | null };
		expect(row.d).toBe("not-a-date");
	});

	test("custom field date-only string normalized to T00:00:00Z", async () => {
		// Filter normalizes `gte: "2024-06-01"` to `"2024-06-01T00:00:00Z"`.
		// Index must mirror or lex-compare against the bound silently fails
		// (shorter string is less than longer).
		const s = await setup({
			"a.md": "---\ndue: 2024-06-01\n---\n\n# A\n\nbody",
		});
		await scanVault({ vaultRoot: s.vaultRoot, index: s.index, concurrency: 1 });
		const row = s.opened.db
			.prepare("SELECT json_extract(fields_json, '$.\"due\"') AS d FROM frontmatter WHERE file = 'a.md'")
			.get() as { d: string };
		expect(row.d).toBe("2024-06-01T00:00:00Z");
	});

	test("nested custom field (D30 dotted-path) normalized recursively", async () => {
		const s = await setup({
			"a.md": "---\nmeta:\n  published: 2024-06-01\n---\n\n# A\n\nbody",
		});
		await scanVault({ vaultRoot: s.vaultRoot, index: s.index, concurrency: 1 });
		const row = s.opened.db
			.prepare("SELECT json_extract(fields_json, '$.\"meta\".\"published\"') AS d FROM frontmatter WHERE file = 'a.md'")
			.get() as { d: string };
		expect(row.d).toBe("2024-06-01T00:00:00Z");
	});

	test("non-ISO custom field stays raw (version strings unaffected)", async () => {
		const s = await setup({
			"a.md": "---\nversion: 1.2.3\n---\n\n# A\n\nbody",
		});
		await scanVault({ vaultRoot: s.vaultRoot, index: s.index, concurrency: 1 });
		const row = s.opened.db
			.prepare("SELECT json_extract(fields_json, '$.\"version\"') AS v FROM frontmatter WHERE file = 'a.md'")
			.get() as { v: string };
		expect(row.v).toBe("1.2.3");
	});

	test('`updated` key normalized in fields_json so fields["updated"] queries see ISO', async () => {
		const s = await setup({
			"a.md": "---\nupdated: 2024-06-01\n---\n\n# A\n\nbody",
		});
		await scanVault({ vaultRoot: s.vaultRoot, index: s.index, concurrency: 1 });
		const row = s.opened.db
			.prepare("SELECT json_extract(fields_json, '$.\"updated\"') AS u FROM frontmatter WHERE file = 'a.md'")
			.get() as { u: string };
		expect(row.u).toBe("2024-06-01T00:00:00Z");
	});
});

describe("scanVault — calendar + ISO-shape validation at index time", () => {
	test("calendar-invalid date-only (Feb 31) → fields_json stores raw, COALESCE skips", async () => {
		const s = await setup({
			"a.md": "---\ndate: 2024-02-31\nupdated: 2024-04-01\n---\n\n# A\n\nbody",
		});
		await scanVault({ vaultRoot: s.vaultRoot, index: s.index, concurrency: 1 });
		const row = s.opened.db
			.prepare("SELECT json_extract(fields_json, '$.\"date\"') AS d FROM frontmatter WHERE file = 'a.md'")
			.get() as { d: string | null };
		expect(row.d).toBe("2024-02-31");
	});

	test('non-ISO single-digit string ("1") → fields_json stores raw', async () => {
		const s = await setup({
			"a.md": '---\ndate: "1"\n---\n\n# A\n\nbody',
		});
		await scanVault({ vaultRoot: s.vaultRoot, index: s.index, concurrency: 1 });
		const row = s.opened.db
			.prepare("SELECT json_extract(fields_json, '$.\"date\"') AS d FROM frontmatter WHERE file = 'a.md'")
			.get() as { d: string | null };
		expect(row.d).toBe("1");
	});

	test("free-form prose value (`not-a-date`) → fields_json stores raw", async () => {
		const s = await setup({
			"a.md": '---\ndate: "not-a-date"\n---\n\n# A\n\nbody',
		});
		await scanVault({ vaultRoot: s.vaultRoot, index: s.index, concurrency: 1 });
		const row = s.opened.db
			.prepare("SELECT json_extract(fields_json, '$.\"date\"') AS d FROM frontmatter WHERE file = 'a.md'")
			.get() as { d: string | null };
		expect(row.d).toBe("not-a-date");
	});

	test("invalid reserved `created` → fields_json raw, dedicated `created` column NULL", async () => {
		// Dedicated columns (`created`/`updated`) drive the COALESCE chain
		// directly; they MUST stay canonical-or-null. Only `fields_json`
		// preserves the raw form for `fields["created"].eq` access.
		const s = await setup({
			"a.md": '---\ncreated: "garbage"\n---\n\n# A\n\nbody',
		});
		await scanVault({ vaultRoot: s.vaultRoot, index: s.index, concurrency: 1 });
		const row = s.opened.db
			.prepare(
				"SELECT created AS col, json_extract(fields_json, '$.\"created\"') AS j FROM frontmatter WHERE file = 'a.md'",
			)
			.get() as { col: string | null; j: string | null };
		expect(row.col).toBeNull();
		expect(row.j).toBe("garbage");
	});

	test("custom calendar-invalid date stays raw (normalizer returns null → original kept)", async () => {
		const s = await setup({
			"a.md": "---\ndue: 2024-13-01\n---\n\n# A\n\nbody",
		});
		await scanVault({ vaultRoot: s.vaultRoot, index: s.index, concurrency: 1 });
		const row = s.opened.db
			.prepare("SELECT json_extract(fields_json, '$.\"due\"') AS d FROM frontmatter WHERE file = 'a.md'")
			.get() as { d: string };
		expect(row.d).toBe("2024-13-01");
	});

	test("clean date-only still works (regression guard)", async () => {
		const s = await setup({
			"a.md": "---\ndate: 2024-06-01\n---\n\n# A\n\nbody",
		});
		await scanVault({ vaultRoot: s.vaultRoot, index: s.index, concurrency: 1 });
		const row = s.opened.db
			.prepare("SELECT json_extract(fields_json, '$.\"date\"') AS d FROM frontmatter WHERE file = 'a.md'")
			.get() as { d: string };
		expect(row.d).toBe("2024-06-01T00:00:00Z");
	});

	test("calendar-invalid canonical-shape literal: raw stored, COALESCE chain skips it via UDF", async () => {
		// Raw text preservation is intentional (brief line 593: `fields["date"]`
		// can lex-match the literal). The reserved `date` filter chain MUST
		// skip this raw value — `iso_calendar_valid` UDF returns NULL for
		// calendar-invalid inputs, so COALESCE flows to fm.updated below.
		const s = await setup({
			"a.md": '---\ndate: "2024-02-31T00:00:00Z"\nupdated: 2024-04-01\n---\n\n# A\n\nbody',
		});
		await scanVault({ vaultRoot: s.vaultRoot, index: s.index, concurrency: 1 });
		const row = s.opened.db
			.prepare("SELECT json_extract(fields_json, '$.\"date\"') AS d FROM frontmatter WHERE file = 'a.md'")
			.get() as { d: string };
		expect(row.d).toBe("2024-02-31T00:00:00Z");
		// UDF gates the chain: invalid raw → NULL → COALESCE picks fm.updated.
		expect(s.opened.db.prepare("SELECT iso_calendar_valid(?) AS v").get(row.d)).toEqual({ v: null });
	});
});

describe("scanVault — heading body indexes immediate body only (F3)", () => {
	test("term only under a child heading does NOT match the parent row", async () => {
		// Without the bodyOffsetRange fix, `# Outer`'s indexed body would
		// include the `## Inner` subtree, so an FTS MATCH on a child-only term
		// would surface BOTH rows. The fix scopes the indexed body to the
		// parent's IMMEDIATE body (heading-line-end → first-child-start).
		const s = await setup({
			"nested.md": "# Outer\n\n## Inner\n\nuniqueprobe text lives only here\n",
		});
		await scanVault({ vaultRoot: s.vaultRoot, index: s.index, concurrency: 1 });
		const rows = s.opened.db
			.prepare(
				"SELECT f.file, f.heading_text, f.anchor_kind FROM fragments f JOIN fragments_fts ON fragments_fts.rowid = f.id WHERE fragments_fts MATCH 'uniqueprobe'",
			)
			.all() as Array<{ file: string; heading_text: string; anchor_kind: string }>;
		expect(rows).toHaveLength(1);
		expect(rows[0]?.heading_text).toBe("Inner");
		expect(rows[0]?.anchor_kind).toBe("heading");
	});

	test("range_start/range_end remain full-section (so get_fragment can re-slice the whole section)", async () => {
		const s = await setup({
			"nested.md": "# Outer\n\n## Inner\n\nbody under inner\n",
		});
		await scanVault({ vaultRoot: s.vaultRoot, index: s.index, concurrency: 1 });
		const outerRow = s.opened.db
			.prepare("SELECT range_start, range_end, body FROM fragments WHERE file = 'nested.md' AND heading_text = 'Outer'")
			.get() as { range_start: number; range_end: number; body: string };
		// Outer's range covers the entire file (no shallower-or-equal heading
		// follows it). Its indexed body is JUST the immediate slice — empty
		// or whitespace-only because Outer has no text before the child.
		expect(outerRow.range_end).toBeGreaterThan(outerRow.range_start);
		expect(outerRow.body).not.toContain("body under inner");
	});

	test("leaf heading (no children) is unchanged: body equals full section", async () => {
		const s = await setup({
			"flat.md": "# A\n\nfirst-paragraph term\n\n# B\n\nsecond-paragraph other\n",
		});
		await scanVault({ vaultRoot: s.vaultRoot, index: s.index, concurrency: 1 });
		const rowA = s.opened.db
			.prepare("SELECT body FROM fragments WHERE file = 'flat.md' AND heading_text = 'A'")
			.get() as { body: string };
		expect(rowA.body).toContain("first-paragraph term");
		expect(rowA.body).not.toContain("second-paragraph");
	});
});

describe("scanVault — body column excludes code/math", () => {
	// `excludedRanges` (fenced/inline code, math) must be elided from the
	// `body` slice so a code-only term is indexed in `code` only. Otherwise
	// the 2.0 body weight stacks on top of 0.5 code per D18 bm25 weights,
	// defeating the code downweight.
	test("fenced code-only term: present in code column, absent from body column", async () => {
		const s = await setup({
			"mixed.md": "# Section\n\nprose-here\n\n```\ncodeonlyword\n```\n",
		});
		await scanVault({ vaultRoot: s.vaultRoot, index: s.index, concurrency: 1 });
		const row = s.opened.db
			.prepare("SELECT body, code FROM fragments WHERE file = 'mixed.md' AND heading_text = 'Section'")
			.get() as { body: string; code: string };
		expect(row.body).toContain("prose-here");
		expect(row.body).not.toContain("codeonlyword");
		expect(row.code).toContain("codeonlyword");
	});

	test("inline code term excluded from body column", async () => {
		const s = await setup({
			"inline.md": "# Section\n\nprose-here `inlinetoken` more prose\n",
		});
		await scanVault({ vaultRoot: s.vaultRoot, index: s.index, concurrency: 1 });
		const row = s.opened.db
			.prepare("SELECT body, code FROM fragments WHERE file = 'inline.md' AND heading_text = 'Section'")
			.get() as { body: string; code: string };
		expect(row.body).toContain("prose-here");
		expect(row.body).toContain("more prose");
		expect(row.body).not.toContain("inlinetoken");
		expect(row.code).toContain("inlinetoken");
	});

	test("FTS body-column MATCH for code-only term returns no row", async () => {
		// FTS5 column-scoped MATCH: `{body}: term` only fires when the term is
		// in the body column. The bodyOffsetRange narrowing + excludedRanges
		// elision compose: a code-only term is indexed exclusively under `code`.
		const s = await setup({
			"mixed.md": "# Section\n\nprose-here\n\n```\ncodeonlyword\n```\n",
		});
		await scanVault({ vaultRoot: s.vaultRoot, index: s.index, concurrency: 1 });
		const bodyHit = s.opened.db
			.prepare(
				"SELECT f.id FROM fragments f JOIN fragments_fts ON fragments_fts.rowid = f.id WHERE fragments_fts MATCH '{body}: codeonlyword'",
			)
			.all();
		expect(bodyHit).toHaveLength(0);
		const codeHit = s.opened.db
			.prepare(
				"SELECT f.id FROM fragments f JOIN fragments_fts ON fragments_fts.rowid = f.id WHERE fragments_fts MATCH '{code}: codeonlyword'",
			)
			.all();
		expect(codeHit).toHaveLength(1);
	});

	test("heading with all-code body: body column whitespace-only, code populated, row still emitted", async () => {
		const s = await setup({
			"allcode.md": "# Snippet\n\n```\nallcodecontent\n```\n",
		});
		await scanVault({ vaultRoot: s.vaultRoot, index: s.index, concurrency: 1 });
		const row = s.opened.db
			.prepare("SELECT body, code FROM fragments WHERE file = 'allcode.md' AND heading_text = 'Snippet'")
			.get() as { body: string; code: string } | undefined;
		expect(row).toBeDefined();
		expect(row?.body.trim()).toBe("");
		expect(row?.code).toContain("allcodecontent");
	});
});

describe("scanVault — F6 singular `tag:` frontmatter key", () => {
	test("singular `tag` (string) → indexed", async () => {
		const s = await setup({
			"a.md": "---\ntag: api/auth\n---\n\n# A\n\nbody",
		});
		await scanVault({ vaultRoot: s.vaultRoot, index: s.index, concurrency: 1 });
		const tags = s.opened.db
			.prepare("SELECT tag FROM frontmatter_tags WHERE file = 'a.md' ORDER BY tag")
			.all() as Array<{ tag: string }>;
		expect(tags.map((t) => t.tag)).toEqual(["api/auth"]);
	});

	test("singular `tag` (array) → all entries indexed", async () => {
		const s = await setup({
			"a.md": "---\ntag: [api, auth]\n---\n\n# A\n\nbody",
		});
		await scanVault({ vaultRoot: s.vaultRoot, index: s.index, concurrency: 1 });
		const tags = s.opened.db
			.prepare("SELECT tag FROM frontmatter_tags WHERE file = 'a.md' ORDER BY tag")
			.all() as Array<{ tag: string }>;
		expect(tags.map((t) => t.tag)).toEqual(["api", "auth"]);
	});

	test("both `tag` and `tags` present → deduped union", async () => {
		const s = await setup({
			"a.md": "---\ntags: [api]\ntag: [api, auth]\n---\n\n# A\n\nbody",
		});
		await scanVault({ vaultRoot: s.vaultRoot, index: s.index, concurrency: 1 });
		const tags = s.opened.db
			.prepare("SELECT tag FROM frontmatter_tags WHERE file = 'a.md' ORDER BY tag")
			.all() as Array<{ tag: string }>;
		expect(tags.map((t) => t.tag)).toEqual(["api", "auth"]);
	});
});

describe("scanVault — G1 state transitions", () => {
	test("starting state cold → scan transitions to warming → warm", async () => {
		const s = await setup({ "a.md": "# A\n\nbody" });
		expect(s.index.getStatus().state).toBe("cold");
		const states: string[] = [];
		s.index.setStatus("cold");
		await scanVault({
			vaultRoot: s.vaultRoot,
			index: s.index,
			concurrency: 1,
			onProgress: (_p) => states.push(s.index.getStatus().state),
		});
		expect(s.index.getStatus().state).toBe("warm");
		// At least one progress callback fires after the initial setStatus
		// transition; verify it observed `warming`, not `reconciling`.
		expect(states).toContain("warming");
		expect(states).not.toContain("reconciling");
	});

	test("starting state warm (preexisted+complete) → scan transitions to reconciling → warm", async () => {
		const s = await setup({ "a.md": "# A\n\nbody" });
		// Simulate a preexisted-warm DB: run one full scan, then mark warm
		// as the startup branch in src/index.ts would.
		await scanVault({ vaultRoot: s.vaultRoot, index: s.index, concurrency: 1 });
		expect(s.index.getStatus().state).toBe("warm");

		const states: string[] = [];
		s.index.setStatus("warm");
		await scanVault({
			vaultRoot: s.vaultRoot,
			index: s.index,
			concurrency: 1,
			onProgress: (_p) => states.push(s.index.getStatus().state),
		});
		expect(s.index.getStatus().state).toBe("warm");
		expect(states).toContain("reconciling");
		expect(states).not.toContain("warming");
	});
});

describe("scanVault — G2 prune vanished files", () => {
	test("file deleted between scans is pruned from index", async () => {
		const s = await setup({
			"a.md": "# A\n\nfirst body",
			"b.md": "# B\n\nsecond body",
		});
		await scanVault({ vaultRoot: s.vaultRoot, index: s.index, concurrency: 1 });
		expect(s.index.listIndexedFiles().sort()).toEqual(["a.md", "b.md"]);

		await rm(join(s.vault.path, "b.md"));
		await scanVault({ vaultRoot: s.vaultRoot, index: s.index, concurrency: 1 });
		expect(s.index.listIndexedFiles()).toEqual(["a.md"]);

		// `removeFile` writes a retirement-diff for B's heading.
		const history = s.opened.db.prepare("SELECT count(*) AS n FROM heading_history WHERE file = 'b.md'").get() as {
			n: number;
		};
		expect(history.n).toBe(1);

		// Frontmatter + tags rows for B are gone too.
		const fm = s.opened.db.prepare("SELECT count(*) AS n FROM frontmatter WHERE file = 'b.md'").get() as { n: number };
		expect(fm.n).toBe(0);
	});

	test("file added between scans is indexed on the next scan", async () => {
		const s = await setup({ "a.md": "# A\n\nbody" });
		await scanVault({ vaultRoot: s.vaultRoot, index: s.index, concurrency: 1 });
		expect(s.index.listIndexedFiles()).toEqual(["a.md"]);

		await writeFile(join(s.vault.path, "c.md"), "# C\n\nthird body", "utf8");
		await scanVault({ vaultRoot: s.vaultRoot, index: s.index, concurrency: 1 });
		expect(s.index.listIndexedFiles().sort()).toEqual(["a.md", "c.md"]);
	});
});

describe("scanVault — prune set discriminates parse_failed vs vanished", () => {
	test("parse_failed file is preserved (soft-fail, NOT pruned)", async () => {
		// Soft-fail: a transient YAML typo shouldn't nuke search results.
		// The `parse_failed` outcome adds the relpath to the prune-input
		// set so existing entries survive. The dual `vanished` outcome
		// (file gone between walk and stat) is type-checked and observed
		// via stat failure in the same code path.
		const s = await setup({
			"a.md": "# A\n\nbody",
			"b.md": "# B\n\nbody",
		});
		await scanVault({ vaultRoot: s.vaultRoot, index: s.index, concurrency: 1 });
		expect(s.index.listIndexedFiles().sort()).toEqual(["a.md", "b.md"]);

		// Overwrite b.md with content that triggers ParseError — unclosed
		// frontmatter delimiter so the YAML loader bails.
		await writeFile(
			join(s.vault.path, "b.md"),
			"---\nbroken: [unclosed\n# B body without closing frontmatter\n",
			"utf8",
		);
		await scanVault({ vaultRoot: s.vaultRoot, index: s.index, concurrency: 1 });

		// b.md still listed — prior index entries preserved.
		expect(s.index.listIndexedFiles().sort()).toEqual(["a.md", "b.md"]);
	});

	test("indexer-thrown file (FileTooLargeError) is preserved (NOT pruned)", async () => {
		// Forces FileTooLargeError to exercise the throw path (readNote
		// raises after stat success) and verifies prior rows survive.
		const s = await setup({
			"a.md": "# A\n\nbody",
			"b.md": "# B\n\nbody",
		});
		await scanVault({ vaultRoot: s.vaultRoot, index: s.index, concurrency: 1 });
		expect(s.index.listIndexedFiles().sort()).toEqual(["a.md", "b.md"]);

		// Sparse-extend b.md past MAX_FILE_BYTES (10 MB). `truncate` writes
		// no userland buffer — orders of magnitude faster than Buffer.alloc.
		await truncate(join(s.vault.path, "b.md"), 10 * 1024 * 1024 + 1);

		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			await scanVault({ vaultRoot: s.vaultRoot, index: s.index, concurrency: 1 });
			expect(s.index.listIndexedFiles().sort()).toEqual(["a.md", "b.md"]);
			const stderr = errSpy.mock.calls.flat().join("\n");
			expect(stderr).toMatch(/failed to index b\.md/);
		} finally {
			errSpy.mockRestore();
		}
	});
});

describe("scanVault — skips paths that violate validatePath policy", () => {
	// Asymmetry guard: indexing a path the tool surface would reject
	// would put non-addressable rows into search results. `walkVault`
	// applies the same sync-policy classifier as `validatePath`.

	test("file at depth > 32 is not indexed", async () => {
		// 33 directory levels under root; deepest file path has 34
		// segments total, exceeding MAX_PATH_DEPTH (32).
		const buildNested = (depth: number, leaf: string): VaultStructure => {
			let cur: VaultStructure = { [leaf]: "# Deep\n" };
			for (let i = depth - 1; i >= 0; i--) {
				cur = { [`d${i}`]: cur };
			}
			return cur;
		};
		const s = await setup({
			"shallow.md": "# Shallow\n",
			...buildNested(33, "deep.md"),
		});
		const result = await scanVault({ vaultRoot: s.vaultRoot, index: s.index, concurrency: 1 });
		const files = s.index.listIndexedFiles();
		expect(files).toContain("shallow.md");
		expect(files.some((f) => f.endsWith("deep.md"))).toBe(false);
		expect(result.aborted).toBe(false);
	});

	test("filename with literal %xx octet is not indexed", async () => {
		const s = await setup({
			"clean.md": "# Clean\n",
			"name%2fescape.md": "# Encoded\n",
		});
		await scanVault({ vaultRoot: s.vaultRoot, index: s.index, concurrency: 1 });
		const files = s.index.listIndexedFiles();
		expect(files).toContain("clean.md");
		expect(files).not.toContain("name%2fescape.md");
	});

	test("filename with backslash is not indexed (POSIX)", async () => {
		const s = await setup({
			"clean.md": "# Clean\n",
			"name\\bs.md": "# Backslash\n",
		});
		await scanVault({ vaultRoot: s.vaultRoot, index: s.index, concurrency: 1 });
		const files = s.index.listIndexedFiles();
		expect(files).toContain("clean.md");
		expect(files).not.toContain("name\\bs.md");
	});
});

describe("scanVault — skips non-NFC filenames", () => {
	test("non-NFC filename is not indexed and clean siblings are", async () => {
		const s = await setup({
			"clean.md": "# Clean\n",
			"cafe\u0301.md": "# Decomposed\n", // NFD: e + combining acute
		});
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			await scanVault({ vaultRoot: s.vaultRoot, index: s.index, concurrency: 1 });
			const files = s.index.listIndexedFiles();
			expect(files).toContain("clean.md");
			expect(files).not.toContain("cafe\u0301.md"); // NFD raw
			expect(files).not.toContain("caf\u00e9.md"); // NFC equivalent

			const stderr = errSpy.mock.calls.flat().join("\n");
			expect(stderr).toMatch(/non-NFC name/);
		} finally {
			errSpy.mockRestore();
		}
	});

	test("clean NFC filename with combining-mark equivalents is indexed", async () => {
		const s = await setup({
			"caf\u00e9.md": "# Composed\n", // NFC `é` (single codepoint U+00E9)
		});
		await scanVault({ vaultRoot: s.vaultRoot, index: s.index, concurrency: 1 });
		expect(s.index.listIndexedFiles()).toContain("caf\u00e9.md");
	});
});

describe("scanVault — scan_complete persistence", () => {
	test("clean run flips scan_complete from false → true", async () => {
		const s = await setup({ "a.md": "# A\n\nbody" });
		expect(s.index.getScanComplete()).toBe(false);
		await scanVault({ vaultRoot: s.vaultRoot, index: s.index, concurrency: 1 });
		expect(s.index.getScanComplete()).toBe(true);
	});

	test("scan started but aborted mid-loop leaves scan_complete=false", async () => {
		const s = await setup({ "a.md": "# A\n\nbody", "b.md": "# B\n\nbody" });
		await scanVault({ vaultRoot: s.vaultRoot, index: s.index, concurrency: 1 });
		expect(s.index.getScanComplete()).toBe(true);
		const ctrl = new AbortController();
		queueMicrotask(() => ctrl.abort());
		await scanVault({ vaultRoot: s.vaultRoot, index: s.index, signal: ctrl.signal, concurrency: 1 });
		expect(s.index.getScanComplete()).toBe(false);
	});
});

describe("scanVault — ever_complete one-way latch", () => {
	test("clean run flips ever_complete=true; subsequent interrupted scans do NOT reset it", async () => {
		const s = await setup({ "a.md": "# A\n\nbody", "b.md": "# B\n\nbody" });
		expect(s.index.getEverComplete()).toBe(false);
		await scanVault({ vaultRoot: s.vaultRoot, index: s.index, concurrency: 1 });
		expect(s.index.getEverComplete()).toBe(true);

		// Interrupt the next scan: scan_complete flips to false, but
		// ever_complete must stay true (one-way latch).
		const ctrl = new AbortController();
		queueMicrotask(() => ctrl.abort());
		await scanVault({ vaultRoot: s.vaultRoot, index: s.index, signal: ctrl.signal, concurrency: 1 });
		expect(s.index.getScanComplete()).toBe(false);
		expect(s.index.getEverComplete()).toBe(true);
	});

	test("aborted-before-clean-finish leaves ever_complete=false (round-14 partial-first-scan case)", async () => {
		const s = await setup({ "a.md": "# A\n\nbody", "b.md": "# B\n\nbody" });
		const ctrl = new AbortController();
		queueMicrotask(() => ctrl.abort());
		await scanVault({ vaultRoot: s.vaultRoot, index: s.index, signal: ctrl.signal, concurrency: 1 });
		expect(s.index.getScanComplete()).toBe(false);
		expect(s.index.getEverComplete()).toBe(false);
	});
});

describe("scanVault — F2 mtime-skip preserves snapshot on no-op reconcile", () => {
	test("unchanged file with prior clean shutdown → snapshot unchanged", async () => {
		const s = await setup({ "a.md": "# A\n\nbody" });
		await scanVault({ vaultRoot: s.vaultRoot, index: s.index, concurrency: 1 });
		expect(s.index.getScanComplete()).toBe(true);
		const before = s.index.getSnapshot();

		// Re-scan with no on-disk changes — every file's mtime matches the
		// stored mtime, so indexOne short-circuits before replaceFile.
		await scanVault({ vaultRoot: s.vaultRoot, index: s.index, concurrency: 1 });
		expect(s.index.getSnapshot()).toBe(before);
	});

	test("file with bumped mtime triggers replaceFile → snapshot increments (regression guard)", async () => {
		const s = await setup({ "a.md": "# A\n\nbody" });
		await scanVault({ vaultRoot: s.vaultRoot, index: s.index, concurrency: 1 });
		const before = s.index.getSnapshot();

		// Force a strictly-greater mtime (utimes is the only portable way —
		// `writeFile` may collide within a single ms-precision tick).
		const futureSec = Math.floor(Date.now() / 1000) + 60;
		await utimes(join(s.vault.path, "a.md"), futureSec, futureSec);

		await scanVault({ vaultRoot: s.vaultRoot, index: s.index, concurrency: 1 });
		expect(s.index.getSnapshot()).toBeGreaterThan(before);
	});

	test("interrupted prior scan (scan_complete=false) → re-indexes everything (snapshot increments)", async () => {
		const s = await setup({ "a.md": "# A\n\nbody", "b.md": "# B\n\nbody" });
		await scanVault({ vaultRoot: s.vaultRoot, index: s.index, concurrency: 1 });
		expect(s.index.getScanComplete()).toBe(true);
		const before = s.index.getSnapshot();

		// Force the next scan to behave like one resuming from an interrupted
		// run. With wasComplete=false the mtime-skip is disabled — every
		// file gets replaceFile'd → snapshot bumps.
		s.index.setScanComplete(false);
		await scanVault({ vaultRoot: s.vaultRoot, index: s.index, concurrency: 1 });
		expect(s.index.getSnapshot()).toBeGreaterThan(before);
	});

	test("unchanged file is still kept in index (not pruned)", async () => {
		const s = await setup({ "a.md": "# A\n\nbody", "b.md": "# B\n\nbody" });
		await scanVault({ vaultRoot: s.vaultRoot, index: s.index, concurrency: 1 });
		expect(s.index.listIndexedFiles().sort()).toEqual(["a.md", "b.md"]);

		// Skip path adds the relpath to `stillOnDisk`, so the prune pass
		// MUST NOT drop it. Regression guard for the bookkeeping.
		await scanVault({ vaultRoot: s.vaultRoot, index: s.index, concurrency: 1 });
		expect(s.index.listIndexedFiles().sort()).toEqual(["a.md", "b.md"]);
	});
});

describe("scanVault — skip key extends to (mtime, size)", () => {
	test("rsync -t style content swap with mtime stamped back → re-indexes", async () => {
		// `rsync -t` / `cp -p` / `tar -p` preserve source mtime on a content-
		// changed copy. The (mtime, size) skip key catches it; mtime alone
		// would let new content slip through with stale FTS / frontmatter
		// rows.
		const s = await setup({ "a.md": "# A\n\nhello" });
		const path = join(s.vault.path, "a.md");
		// Pin to an integer-second mtime so `utimes` round-trips exactly —
		// passing fractional `mtimeMs / 1000` loses sub-ms via float→nsec
		// conversion and would fail the (mtime, size) parity below.
		const stableSec = Math.floor(Date.now() / 1000) - 60;
		await utimes(path, stableSec, stableSec);
		await scanVault({ vaultRoot: s.vaultRoot, index: s.index, concurrency: 1 });
		const stOrig = await stat(path);
		const before = s.index.getSnapshot();

		await writeFile(path, "# A\n\nhello world!\n");
		await utimes(path, stableSec, stableSec);
		const stAfter = await stat(path);
		expect(stAfter.mtimeMs).toBe(stOrig.mtimeMs);
		expect(stAfter.size).not.toBe(stOrig.size);

		await scanVault({ vaultRoot: s.vaultRoot, index: s.index, concurrency: 1 });
		expect(s.index.getSnapshot()).toBeGreaterThan(before);
	});

	test("scanner persists st.size into fragments.size", async () => {
		// Round-trip guard: every replaceFile call must propagate size from
		// `stat` into the row, otherwise legacy NULL forces a re-index every
		// scan and the optimization is lost.
		const s = await setup({ "a.md": "# A\n\nbody" });
		const st = await stat(join(s.vault.path, "a.md"));
		await scanVault({ vaultRoot: s.vaultRoot, index: s.index, concurrency: 1 });
		const stored = s.opened.db.prepare("SELECT size FROM fragments WHERE file = 'a.md' LIMIT 1").get() as
			| { size: number | null }
			| undefined;
		expect(stored?.size).toBe(st.size);
	});
});

function countHistory(db: import("better-sqlite3").Database, file: string): number {
	const row = db.prepare("SELECT count(*) AS n FROM heading_history WHERE file = ?").get(file) as { n: number };
	return row.n;
}
