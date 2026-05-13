/**
 * `get_links` integration tests — D34 link_ordinal pagination contract.
 *
 * Exit criterion (IMPLEMENTATION_PLAN.md:82): 5 wikilinks under one
 * source section, paginated at `pageSize: 2`, round-trips in 3 pages
 * with no duplicates and ascending `link_ordinal`.
 *
 * Other behaviors covered: outgoing-only direction, incoming
 * back-resolution, narrowing miss returns empty arrays without
 * `resolved_anchor`, INDEX_WARMING gate.
 */

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { createIndexHandle } from "../../src/lib/index/IndexHandle.js";
import { closeSqlite, openSqlite } from "../../src/lib/index/sqlite.js";
import { type VaultRoot, validateVaultRoot } from "../../src/lib/validatePath.js";
import { handleGetLinks } from "../../src/tools/getLinks.js";
import type { GetLinksInput, GetLinksResult, VaultError } from "../../src/types.js";
import { spawnTestServer, type TestClient, waitForWarm } from "../helpers/mcp-client.js";
import { createTempVault, type VaultStructure } from "../helpers/vault.js";

const LINKS_FIXTURE: VaultStructure = {
	"refs.md": "# Refs\n\nSee [[A]] and [[B]] and [[C]] and [[D]] and [[E]].\n",
	// Targets exist so resolution succeeds.
	"A.md": "# A\n",
	"B.md": "# B\n",
	"C.md": "# C\n",
	"D.md": "# D\n",
	"E.md": "# E\n",
	// Backlink source — links into refs.md so incoming queries find it.
	"caller.md": "# caller\n\n[[refs]] also.\n",
	// File with no links — for empty-arrays case.
	"silent.md": "# silent\n\nno links here.\n",
	// Ambiguity setup: foo.md exists in two equal-depth dirs so `[[foo]]`
	// resolves to ambiguous (resolved=false). The `ambiguous.md` caller has
	// 5 such links. `direct.md` has one explicit `[[x/foo]]` that resolves
	// cleanly to x/foo.md. Querying incoming for x/foo.md exercises the
	// "many candidates discarded by resolveAndCheck" pagination path.
	"x/foo.md": "# x foo\n",
	"y/foo.md": "# y foo\n",
	"ambiguous.md": "# Ambiguous\n\n[[foo]] [[foo]] [[foo]] [[foo]] [[foo]]\n",
	"direct.md": "# Direct\n\n[[x/foo]]\n",
	// N6 fixture — exact-page-boundary on lookahead. `[[target]]` is
	// ambiguous (notes/target.md + n6-other/target.md), so 4 amb sources'
	// rows are pre-filter matches but discarded by resolveAndCheck. Two
	// valid sources use explicit `[[notes/target]]` so they resolve to
	// notes/target.md cleanly. Source-file alphabetical sort places amb
	// rows first (a-d), then the two valid rows (e, f). With pageSize:1,
	// SQL fetches 5 rows = a-d + e (5th = lookahead). A naive
	// implementation would stop at the lookahead and lose f.
	"notes/target.md": "# notes target\n",
	"n6-other/target.md": "# other target (sibling for ambig)\n",
	"n6-amb-a.md": "# A\n\n[[target]]\n",
	"n6-amb-b.md": "# B\n\n[[target]]\n",
	"n6-amb-c.md": "# C\n\n[[target]]\n",
	"n6-amb-d.md": "# D\n\n[[target]]\n",
	"n6-valid-e.md": "# E\n\n[[notes/target]]\n",
	"n6-valid-f.md": "# F\n\n[[notes/target]]\n",
	// N7 fixture — duplicate-heading sections in same file, each with a
	// first link. Per-section ordinals both = 1, so the cursor must
	// disambiguate via the wikilinks row id. Reused for M3 stable_id
	// narrowing precision: each section has a different stable_id, so
	// querying by either SID must surface only that section's link.
	"dup.md": "# A\n\n[[X]]\n\n# A\n\n[[Y]]\n",
	// M3 incoming-precision fixture: backlink targets `[[dup#A]]` (no way to
	// address the second `# A` via raw text). Resolver maps to the FIRST `# A`
	// per Obsidian first-match semantics → narrowing by sid_first surfaces
	// this row; narrowing by sid_second returns empty.
	"dup-caller.md": "# Caller\n\n[[dup#A]]\n",
	// `[[./refs]]` → outgoing resolver strips leading `./` and resolves to
	// refs.md, but raw_target persists verbatim — computeIncomingCandidates
	// must include `./refs` and `./refs.md` forms or the SQL prefilter
	// excludes this row.
	"dot-slash-caller.md": "# DSCaller\n\n[[./refs]]\n",
	// `extractWikilinks` canonicalizes raw_target at extraction time (trim +
	// collapse `\s*#\s*` → `#`), so these store as `refs` and `refs#Refs` and
	// the SQL prefilter LIKE matches the canonical candidates directly.
	"spaced-caller.md": "# SpacedCaller\n\n[[ refs ]] then [[refs #Refs]]\n",
	// Intra-file backlink: section A links to section B of the same file.
	// Same-file rows must flow through resolveAndCheck so section narrowing
	// can surface self-references.
	"intra-file.md": "# A\n\n[[intra-file#B]]\n\n# B\n\nbody\n",
	// Same-directory sibling reference: raw_target stores `./target`
	// verbatim. Outgoing resolves via Phase 0 source-relative; incoming
	// SQL prefilter must include the `./target` form.
	"nested-rel/sibling-caller.md": "# Caller\n\n[[./target]]\n",
	"nested-rel/target.md": "# Target\n",
	// Unicode case fold: raw_target stores `CAFÉ` verbatim; lc_raw_target
	// stores `café` (JS toLowerCase folds Unicode, SQLite LIKE folds only
	// ASCII). The incoming prefilter searches lc_raw_target.
	"unicode-caller.md": "# Caller\n\n[[CAFÉ]]\n",
	"Café.md": "# Cafe\n",
	// Same-file heading-only reference: raw_target stores `#B` (no filename
	// prefix). Distinct from `intra-file.md`'s `[[intra-file#B]]` whose
	// raw_target is `intra-file#B`. computeIncomingCandidates must emit an
	// empty `""` candidate so the SQL builder's `${c}#%` clause becomes
	// `LIKE '#%'` and pulls the row.
	"selflink.md": "# A\n\n[[#B]]\n\n# B\n\nbody\n",
	// Parent-relative reference one level up: raw_target stores `../parent-target`
	// verbatim. Phase 0 resolves it from `parent-rel/sub/`; the incoming
	// prefilter must include `../{base}` candidates so the row reaches
	// resolveAndCheck.
	"parent-rel/sub/caller.md": "# Caller\n\n[[../parent-target]]\n",
	"parent-rel/parent-target.md": "# Parent Target\n",
	// Phase 1.5 suffix-match (wikilinks.ts): `[[folder/note]]` resolves
	// to the unique path ending in `/folder/note`; raw_target stores
	// `folder/note` verbatim, so the incoming prefilter must enumerate
	// every path-suffix of the target.
	"projects/folder/note.md": "# Note\n",
	"suffix-caller.md": "# Suffix Caller\n\n[[folder/note]]\n",
	// Phase 0 with directory components: `[[../dir/target]]` resolves
	// against the source dir, raw_target persists verbatim. Candidate
	// set must emit `../dir/target` + extension variants. Two-level+
	// (`../../X`) are a documented limitation.
	"multi-rel/dir/target.md": "# Multi Rel Target\n",
	"multi-rel/other/caller.md": "# Multi Rel Caller\n\n[[../dir/target]]\n",
	// Resilient-target fixture for parse-failed incoming-only test:
	// well-formed at scan time, monkey-patched broken mid-test.
	"resilient.md": "# Resilient\n\n[[A]]\n",
	"resilient-caller.md": "# Caller\n\n[[resilient]]\n",
	// Path-policy guard fixtures — `direction:"in"` on a non-note path /
	// directory / hidden file must surface PATH_NOT_FOUND, not an empty
	// success (the AST-skip path bypasses `readNote`'s gates).
	"asset.png": "fake-png-bytes\n",
	".hidden.md": "# hidden\n\nshould reject by default.\n",
	// Outgoing-only file at exact page boundary: probe before sentinel
	// must skip emitting `nextCursor`.
	"outgoing-only.md": "# OO\n\n[[A]]\n",
	// One outgoing + one incoming counterpart: probe sees the candidate
	// row → sentinel must fire, follow-up returns the incoming row.
	"single-each.md": "# SE\n\n[[A]]\n",
	"single-each-caller.md": "# SECaller\n\n[[single-each]]\n",
	// Deep relative `../../../target`: source nested 3 levels below the
	// target's directory exercises `addPathVariants`'s multi-level
	// `../` enumeration.
	"deep/a/b/c/source.md": "# Deep Source\n\n[[../../../deep-target]]\n",
	"deep/deep-target.md": "# Deep Target\n",
	// Block-anchor backlinks under section narrowing: the caller links
	// to a block whose containing heading is computed via the queried
	// file's `blockIndex`.
	"block-target.md":
		"# Section One\n\nfirst body.\n\n# Section Two\n\nA paragraph block here. ^para-id\n\n# Section Three\n\nthird.\n",
	"block-caller.md": "# BC\n\n[[block-target#^para-id]]\n",
	// Exactly 2 valid backlinks for one target — pageSize=1 must paginate
	// without dropping the second row when the for-loop breaks mid-batch.
	"f1-target.md": "# F1 Target\n",
	"f1-source-a.md": "# A\n\n[[f1-target]]\n",
	"f1-source-b.md": "# B\n\n[[f1-target]]\n",
	// Duplicate-heading target with a block under the SECOND `# A`.
	// Narrowing by the second heading's stable_id must surface the row;
	// `headings.find(by-path)` would mis-attribute it to the first `# A`.
	"f4-dup-block.md": "# A\n\nfirst body\n\n# A\n\nsecond body. ^f4-block\n",
	"f4-block-caller.md": "# F4 Caller\n\n[[f4-dup-block#^f4-block]]\n",
	// Preamble-narrowing fixture: one link in preamble + one under
	// `# H`. `heading_path: []` must filter to the preamble link
	// alone (mirroring get_fragment's empty-path preamble anchor).
	"f1-preamble-source.md": "[[A]]\n\n# H\n\n[[B]]\n",
	// Unresolved-heading-narrowing fixture: a file-level `[[unresolved-target]]`
	// alongside `[[unresolved-target#Missing]]`. The latter resolves at
	// the file but not the heading — narrowing on `heading_path: []`
	// must surface only the true file-level link.
	"unresolved-target.md": "# Real\n\nbody\n",
	"unresolved-good-source.md": "[[unresolved-target]]\n",
	"unresolved-bad-source.md": "[[unresolved-target#Missing]]\n",
	// Redundant-dot relative wikilink fixture. Source writes
	// `[[./../target]]`; extractWikilinks must canonicalize to
	// `../target` so the SQL prefilter matches.
	"redundant-dot-target.md": "# Redundant Dot Target\n",
	"redundant-dot-rel/source.md": "# Caller\n\n[[./../redundant-dot-target]]\n",
	// Mid-incoming continuation: 2 incoming + 1 outgoing. `pageSize:1`
	// returns the first incoming with a `{phase:"in"}` cursor — the
	// outgoing phase has NOT been visited yet, so `finalize` must omit
	// `outgoing` (not advertise `outgoing:[]` to clients that stop on
	// empty pages).
	"mid-in-target.md": "# MIT\n\n[[A]]\n",
	"mid-in-source-a.md": "# MITa\n\n[[mid-in-target]]\n",
	"mid-in-source-b.md": "# MITb\n\n[[mid-in-target]]\n",
};

let vault: { path: string; cleanup: () => Promise<void> };
let conn: TestClient;

beforeAll(async () => {
	vault = await createTempVault(LINKS_FIXTURE);
	conn = await spawnTestServer(vault.path);
	await waitForWarm(conn.client);
}, 30_000);

afterAll(async () => {
	await conn.close();
	await vault.cleanup();
});

async function callLinks(args: Record<string, unknown>): Promise<GetLinksResult> {
	const result = await conn.client.callTool({ name: "get_links", arguments: args });
	expect(result.isError).toBeFalsy();
	return result.structuredContent as GetLinksResult;
}

describe("get_links — D34 outgoing pagination (5 links / pageSize 2)", () => {
	test("3 pages, no dupes, ascending link_ordinal 1..5", async () => {
		const seen: number[] = [];
		const collected: string[] = [];
		let cursor: string | undefined;
		let pages = 0;
		while (pages++ < 10) {
			const args: Record<string, unknown> = { file: "refs.md", direction: "out", pageSize: 2 };
			if (cursor) args.cursor = cursor;
			const out = await callLinks(args);
			const ord = (out.outgoing ?? []).map((o) => o.link_ordinal);
			const tgt = (out.outgoing ?? []).map((o) => o.raw_target);
			seen.push(...ord);
			collected.push(...tgt);
			cursor = out.nextCursor;
			if (!cursor) break;
		}
		expect(seen).toEqual([1, 2, 3, 4, 5]);
		expect(collected).toEqual(["A", "B", "C", "D", "E"]);
		expect(pages).toBe(3); // 2 + 2 + 1
	});

	test("each row carries resolved target_file when target exists", async () => {
		const out = await callLinks({ file: "refs.md", direction: "out", pageSize: 5 });
		const targets = (out.outgoing ?? []).map((o) => o.target_file);
		expect(targets).toEqual(["A.md", "B.md", "C.md", "D.md", "E.md"]);
	});
});

describe("get_links — ./-prefixed incoming candidates", () => {
	test("[[./refs]] in source surfaces as incoming on refs.md", async () => {
		// Outgoing resolution already strips leading `./`. Incoming back-
		// resolution must include the `./`-prefixed forms in the SQL pre-
		// filter — otherwise the wikilinks row (raw_target=`./refs`) is
		// excluded and the backlink is invisible.
		const out = await callLinks({ file: "refs.md", direction: "in" });
		const sources = (out.incoming ?? []).map((i) => i.source_file);
		expect(sources).toContain("dot-slash-caller.md");
	});
});

describe("get_links — whitespace canonicalization on incoming raw_target", () => {
	test("[[ refs ]] (surrounding whitespace) and [[refs #Refs]] (space before #) both surface as incoming", async () => {
		// `extractWikilinks` canonicalizes raw_target at extraction time so
		// the SQL prefilter LIKE matches `[[ Target ]]` (would store as
		// `" Target "` verbatim) and `[[Target #Heading]]` (verbatim has the
		// space before `#`) against canonical candidates without a per-row
		// UDF wrap.
		const out = await callLinks({ file: "refs.md", direction: "in" });
		const sourceTargets = (out.incoming ?? [])
			.filter((i) => i.source_file === "spaced-caller.md")
			.map((i) => i.raw_target);
		expect(sourceTargets).toContain("refs");
		expect(sourceTargets).toContain("refs#Refs");
	});
});

describe("get_links — incoming back-resolution", () => {
	test("links from caller.md surface as incoming on refs.md", async () => {
		const out = await callLinks({ file: "refs.md", direction: "in" });
		const sources = (out.incoming ?? []).map((i) => i.source_file);
		expect(sources).toContain("caller.md");
	});
});

describe("get_links — Unicode case-folded incoming", () => {
	test("[[CAFÉ]] in source surfaces as incoming on Café.md (Unicode case fold)", async () => {
		// SQLite LIKE folds only ASCII; the incoming prefilter must search
		// the JS-lowercased column (lc_raw_target) so non-ASCII case
		// variants resolve symmetrically with the outgoing resolver.
		const out = await callLinks({ file: "Café.md", direction: "in" });
		const sources = (out.incoming ?? []).map((i) => i.source_file);
		expect(sources).toContain("unicode-caller.md");
	});
});

describe("get_links — nested ./ outgoing + incoming", () => {
	test("[[./target]] from nested-rel/sibling-caller.md resolves to nested-rel/target.md", async () => {
		// Phase 0 (`./` and `../`) resolves against the source file's
		// directory, not vault root.
		const out = await callLinks({ file: "nested-rel/sibling-caller.md", direction: "out" });
		const resolved = (out.outgoing ?? []).map((o) => ({
			raw_target: o.raw_target,
			target_file: o.target_file,
		}));
		expect(resolved).toContainEqual({ raw_target: "./target", target_file: "nested-rel/target.md" });
	});

	test("get_links({file: nested-rel/target.md, direction: 'in'}) sees the [[./target]] sibling", async () => {
		// computeIncomingCandidates must include `./{base}` and
		// `./{base}.md` for same-directory sibling references; otherwise
		// the SQL prefilter excludes the row even with Phase 0 in place.
		const out = await callLinks({ file: "nested-rel/target.md", direction: "in" });
		const sources = (out.incoming ?? []).map((i) => i.source_file);
		expect(sources).toContain("nested-rel/sibling-caller.md");
	});
});

describe("get_links — same-file [[#B]] (no filename prefix)", () => {
	test("[[#B]] inside selflink.md surfaces as incoming on selflink.md", async () => {
		// `extractWikilinks` stores `raw_target="#B"` (file part empty).
		// computeIncomingCandidates emits a `""` candidate so the SQL
		// builder's `${c}#%` form becomes `LIKE '#%'` and pulls the row.
		// resolveAndCheck filters to the queried target.
		const out = await callLinks({ file: "selflink.md", direction: "in" });
		const sources = (out.incoming ?? []).map((i) => ({
			source_file: i.source_file,
			raw_target: i.raw_target,
		}));
		expect(sources).toContainEqual({ source_file: "selflink.md", raw_target: "#B" });
	});
});

describe("get_links — parent-relative [[../X]] incoming", () => {
	test("[[../parent-target]] from parent-rel/sub/caller.md surfaces on parent-rel/parent-target.md", async () => {
		// Phase 0 resolves `../parent-target` against `parent-rel/sub/`.
		// computeIncomingCandidates must emit `../{base}` so the SQL
		// prefilter fetches the row.
		const out = await callLinks({ file: "parent-rel/parent-target.md", direction: "in" });
		const sources = (out.incoming ?? []).map((i) => i.source_file);
		expect(sources).toContain("parent-rel/sub/caller.md");
	});
});

describe("get_links — Phase 1.5 multi-segment suffix incoming", () => {
	test("[[folder/note]] surfaces as incoming on projects/folder/note.md", async () => {
		// Phase 1.5 in wikilinks.ts resolves `[[folder/note]]` to the unique
		// path that ends with `/folder/note`. The incoming prefilter must
		// emit every path-suffix of the target (here: `folder/note`,
		// `folder/note.md`) so the SQL row reaches resolveAndCheck.
		const out = await callLinks({ file: "projects/folder/note.md", direction: "in" });
		const sources = (out.incoming ?? []).map((i) => ({
			source_file: i.source_file,
			raw_target: i.raw_target,
		}));
		expect(sources).toContainEqual({ source_file: "suffix-caller.md", raw_target: "folder/note" });
	});
});

describe("get_links — Phase 0 multi-segment relative incoming", () => {
	test("[[../dir/target]] from sibling-of-parent surfaces on multi-rel/dir/target.md", async () => {
		// One-level-up relatives with directory components: candidate set
		// must include `../dir/target` (one suffix level + ../ prefix).
		const out = await callLinks({ file: "multi-rel/dir/target.md", direction: "in" });
		const sources = (out.incoming ?? []).map((i) => ({
			source_file: i.source_file,
			raw_target: i.raw_target,
		}));
		expect(sources).toContainEqual({
			source_file: "multi-rel/other/caller.md",
			raw_target: "../dir/target",
		});
	});
});

describe("get_links — incoming-only on a malformed target", () => {
	// Unnarrowed `direction: "in"` is answered from the SQL wikilinks
	// table. The target file's AST is unused, so a transient parse error
	// (broken frontmatter, FILE_TOO_LARGE, encoding_failed) on the target
	// must NOT fail an otherwise-recoverable backlinks query.
	test("incoming-only succeeds when target is temporarily malformed", async () => {
		const { writeFile, readFile } = await import("node:fs/promises");
		const { join } = await import("node:path");
		const targetAbs = join(vault.path, "resilient.md");
		const original = await readFile(targetAbs, "utf8");
		try {
			await writeFile(targetAbs, "---\nbroken: [unclosed\n---\n# Resilient\n\n[[A]]\n", "utf8");
			const out = await callLinks({ file: "resilient.md", direction: "in" });
			const sources = (out.incoming ?? []).map((i) => i.source_file);
			expect(sources).toContain("resilient-caller.md");
		} finally {
			await writeFile(targetAbs, original, "utf8");
			// Watcher tick to re-index restored content; isolates later tests.
			await new Promise((r) => setTimeout(r, 200));
		}
	});

	test("unnarrowed direction:'out' also succeeds when target is temporarily malformed", async () => {
		// Outgoing rows come from the SQL wikilinks table; AST is consulted
		// only for narrowing. So an unindexable file still serves its
		// previously-indexed outgoing links on unnarrowed requests.
		const { writeFile, readFile } = await import("node:fs/promises");
		const { join } = await import("node:path");
		const targetAbs = join(vault.path, "resilient.md");
		const original = await readFile(targetAbs, "utf8");
		try {
			await writeFile(targetAbs, "---\nbroken: [unclosed\n---\n# Resilient\n\n[[A]]\n", "utf8");
			const out = await callLinks({ file: "resilient.md", direction: "out" });
			const targets = (out.outgoing ?? []).map((o) => o.raw_target);
			expect(targets).toContain("A");
		} finally {
			await writeFile(targetAbs, original, "utf8");
			// Watcher tick to re-index restored content; isolates later tests.
			await new Promise((r) => setTimeout(r, 200));
		}
	});

	test("narrowed direction:'out' still raises MARKDOWN_PARSE_ERROR (AST required for narrowing)", async () => {
		// Narrowing reads `parsed.headings` to map heading_path → slot,
		// so a malformed target propagates the parse error. Same contract
		// as `direction: "in"` with narrowing.
		const { writeFile, readFile } = await import("node:fs/promises");
		const { join } = await import("node:path");
		const targetAbs = join(vault.path, "resilient.md");
		const original = await readFile(targetAbs, "utf8");
		try {
			await writeFile(targetAbs, "---\nbroken: [unclosed\n---\n# Resilient\n\n[[A]]\n", "utf8");
			const result = await conn.client.callTool({
				name: "get_links",
				arguments: { file: "resilient.md", direction: "out", heading_path: ["Resilient"] },
			});
			expect(result.isError).toBe(true);
			const err = result.structuredContent as VaultError;
			expect(err.code).toBe("MARKDOWN_PARSE_ERROR");
		} finally {
			await writeFile(targetAbs, original, "utf8");
			await new Promise((r) => setTimeout(r, 200));
		}
	});
});

describe("get_links — intra-file backlinks", () => {
	test("[[note#B]] from section A surfaces as incoming when narrowing on B", async () => {
		// Same-file rows flow through resolveAndCheck. Section narrowing
		// is the canonical use case for intra-file backlinks.
		const out = await callLinks({
			file: "intra-file.md",
			heading_path: ["B"],
			direction: "in",
		});
		const sources = (out.incoming ?? []).map((i) => ({
			source_file: i.source_file,
			raw_target: i.raw_target,
		}));
		expect(sources).toContainEqual({ source_file: "intra-file.md", raw_target: "intra-file#B" });
	});
});

describe("get_links — narrowing", () => {
	test("heading_path miss returns empty arrays and no resolved_anchor", async () => {
		const out = await callLinks({
			file: "refs.md",
			heading_path: ["DoesNotExist"],
			direction: "both",
		});
		// Requested-direction signal is preserved: `direction: "both"` with
		// no results yields empty arrays for both, distinguishable from a
		// one-direction request where the unrequested side stays undefined.
		expect(out.outgoing).toEqual([]);
		expect(out.incoming).toEqual([]);
		expect(out.resolved_anchor).toBeUndefined();
	});

	test("heading_path match emits resolved_anchor and filters outgoing", async () => {
		const out = await callLinks({ file: "refs.md", heading_path: ["Refs"], direction: "out" });
		expect(out.resolved_anchor).toMatchObject({
			stable_id_status: "fresh",
			heading_path: ["Refs"],
		});
		expect(out.outgoing?.length).toBeGreaterThan(0);
	});

	test("unresolved heading link does NOT count as preamble backlink", async () => {
		// `[[unresolved-target#Missing]]` resolves at the file but not
		// the heading. The link is neither preamble nor a heading
		// match — it points at a section that doesn't exist. Without
		// the gate in `resolveAndCheck`, the `targetHeadingPath ===
		// undefined` branch would fold it into preamble narrowing
		// alongside true file-level links.
		const out = await callLinks({ file: "unresolved-target.md", direction: "in", heading_path: [] });
		const sources = (out.incoming ?? []).map((l) => l.source_file).sort();
		expect(sources).toEqual(["unresolved-good-source.md"]);
	});

	test("empty heading_path narrows outgoing to preamble", async () => {
		// `heading_path: []` is the preamble anchor (mirrors get_fragment).
		// A NO_NARROWING short-circuit on the empty array would surface
		// the whole-file's links instead of just the preamble's.
		const all = await callLinks({ file: "f1-preamble-source.md", direction: "out" });
		expect((all.outgoing ?? []).map((l) => l.raw_target).sort()).toEqual(["A", "B"]);

		const preamble = await callLinks({
			file: "f1-preamble-source.md",
			direction: "out",
			heading_path: [],
		});
		expect((preamble.outgoing ?? []).map((l) => l.raw_target)).toEqual(["A"]);
		expect(preamble.resolved_anchor).toMatchObject({
			stable_id_status: "fresh",
			heading_path: [],
		});

		const heading = await callLinks({
			file: "f1-preamble-source.md",
			direction: "out",
			heading_path: ["H"],
		});
		expect((heading.outgoing ?? []).map((l) => l.raw_target)).toEqual(["B"]);
	});
});

describe("get_links — silent file", () => {
	test("file with no links returns empty result", async () => {
		const out = await callLinks({ file: "silent.md", direction: "both" });
		expect(out.outgoing ?? []).toEqual([]);
		expect(out.incoming ?? []).toEqual([]);
	});
});

describe("get_links — outgoing in document order (D36)", () => {
	test("preamble link comes BEFORE heading link in unnarrowed outgoing", async () => {
		// f1-preamble-source.md content: `[[A]]\n\n# H\n\n[[B]]\n`.
		// Document order: A (preamble) → B (under # H). Pre-D36 the
		// JSON-lex ORDER BY collated `null` (preamble's heading_path) as
		// `''` and headings as `["H"]` — `'' < '["H"]'` so preamble
		// happened to come first by accident, but the example with two
		// heading-named sections (`# Z` followed by `# A`) returned A
		// before Z (JSON-lex), the reverse of document order. With D36,
		// rowid order IS document order across both shapes.
		const out = await callLinks({ file: "f1-preamble-source.md", direction: "out" });
		const targets = (out.outgoing ?? []).map((l) => l.raw_target);
		expect(targets).toEqual(["A", "B"]);
	});

	test("listOutgoingLinks returns rows in insert order (rowid ASC)", () => {
		// Direct unit test of the IndexHandle SQL: insert wikilinks in the
		// canonical reviewer scenario `# Z [[Y]] / # A [[X]]` — listOutgoing
		// must emit `Y, X` (document order via rowid) instead of the
		// pre-D36 JSON-lex `X, Y`.
		const opened = openSqlite({ dbPath: ":memory:" });
		const idx = createIndexHandle(opened.db, { includeHidden: false });
		try {
			idx.replaceFile({
				file: "src.md",
				mtime: 1,
				size: 64,
				fragments: [
					{
						anchor_kind: "heading",
						stable_id: "h:zzzzzzzzzzzzzz",
						heading_path_json: JSON.stringify(["Z"]),
						heading_text: "Z",
						structural_path: "h1[0]",
						range_start: 0,
						range_end: 32,
						body: "[[Y]]",
						code: "",
						headings: "Z",
					},
					{
						anchor_kind: "heading",
						stable_id: "h:aaaaaaaaaaaaaa",
						heading_path_json: JSON.stringify(["A"]),
						heading_text: "A",
						structural_path: "h1[1]",
						range_start: 32,
						range_end: 64,
						body: "[[X]]",
						code: "",
						headings: "A",
					},
				],
				links: [
					{
						source_heading_path_json: JSON.stringify(["Z"]),
						source_stable_id: "h:zzzzzzzzzzzzzz",
						source_anchor_kind: "heading",
						link_ordinal: 1,
						raw_target: "Y",
						is_embed: false,
						alias: null,
						link_text: "Y",
					},
					{
						source_heading_path_json: JSON.stringify(["A"]),
						source_stable_id: "h:aaaaaaaaaaaaaa",
						source_anchor_kind: "heading",
						link_ordinal: 1,
						raw_target: "X",
						is_embed: false,
						alias: null,
						link_text: "X",
					},
				],
				frontmatter: { created: null, updated: null, fields_json: "{}", tags: [] },
			});
			const rows = idx.listOutgoingLinks({ file: "src.md", pageSize: 10 });
			// Document order: Z's link (Y) first, then A's link (X).
			// Pre-D36 ORDER BY: COALESCE(["A"], '') < COALESCE(["Z"], '')
			// → X then Y, the reverse.
			expect(rows.map((r) => r.raw_target)).toEqual(["Y", "X"]);
		} finally {
			closeSqlite(opened.db);
		}
	});
});

describe("get_links — file-level backlinks under heading_path: []", () => {
	test("[[A]] backlink surfaces under heading_path: [] (preamble narrowing)", async () => {
		// File-level backlinks (`[[A]]` — no `#section`, no `^block`) have
		// `targetHeadingPath === undefined`. Preamble narrowing is the
		// closest semantic match; the resolveAndCheck fall-through must
		// accept these rows when `narrowing.stableIdStatus === "preamble"`.
		const incoming = await callLinks({
			file: "A.md",
			direction: "in",
			heading_path: [],
		});
		const sources = (incoming.incoming ?? []).map((r) => r.source_file).sort();
		expect(sources).toContain("refs.md");
	});

	test("[[A]] backlink does NOT surface under non-empty heading_path narrowing", async () => {
		// Heading-path narrowings (non-empty) require a section-anchored
		// link; file-level links don't address any specific section.
		const incoming = await callLinks({
			file: "A.md",
			direction: "in",
			heading_path: ["Refs"],
		});
		expect(incoming.incoming ?? []).toEqual([]);
	});

	test("unnarrowed incoming includes file-level backlinks (regression guard)", async () => {
		const incoming = await callLinks({ file: "A.md", direction: "in" });
		const sources = (incoming.incoming ?? []).map((r) => r.source_file);
		expect(sources).toContain("refs.md");
	});
});

describe("get_links — direction:both exact-page boundary", () => {
	test("pageSize=5 with 5 outgoing + 1 incoming surfaces incoming via cursor", async () => {
		// `pageSize: 5` makes outgoing fill the page exactly with no lookahead
		// row, so the boundary sentinel cursor is the only way to reach
		// incoming on a follow-up call.
		const allOut: number[] = [];
		const allIn: Array<{ source_file: string }> = [];
		let cursor: string | undefined;
		let pages = 0;
		while (pages++ < 4) {
			const args: Record<string, unknown> = { file: "refs.md", direction: "both", pageSize: 5 };
			if (cursor) args.cursor = cursor;
			const out = await callLinks(args);
			if (out.outgoing) allOut.push(...out.outgoing.map((o) => o.link_ordinal));
			if (out.incoming) allIn.push(...out.incoming.map((i) => ({ source_file: i.source_file })));
			cursor = out.nextCursor;
			if (!cursor) break;
		}
		expect(allOut).toEqual([1, 2, 3, 4, 5]);
		expect(allIn.map((i) => i.source_file)).toContain("caller.md");
		expect(pages).toBe(2);
	});
});

describe("get_links — incoming pagination over discarded candidates", () => {
	test("ambiguous-basename rows don't strand pagination on the valid hit", async () => {
		// `ambiguous.md` emits 5 `[[foo]]` rows that resolve to "ambiguous →
		// unresolved" (two equal-depth `foo.md` candidates). `direct.md`'s
		// `[[x/foo]]` resolves cleanly. With `pageSize: 1` + oversample=4 the
		// first batch contains only ambiguous rows; the cursor must advance
		// past them so the valid hit is reachable.
		const incoming: Array<{ source_file: string; raw_target: string }> = [];
		let cursor: string | undefined;
		let pages = 0;
		while (pages++ < 6) {
			const args: Record<string, unknown> = { file: "x/foo.md", direction: "in", pageSize: 1 };
			if (cursor) args.cursor = cursor;
			const out = await callLinks(args);
			if (out.incoming) {
				for (const i of out.incoming) incoming.push({ source_file: i.source_file, raw_target: i.raw_target });
			}
			cursor = out.nextCursor;
			if (!cursor) break;
		}
		expect(incoming).toHaveLength(1);
		expect(incoming[0]?.source_file).toBe("direct.md");
		expect(incoming[0]?.raw_target).toBe("x/foo");
	});
});

describe("get_links — N6 incoming cursor on exact-page lookahead boundary", () => {
	test("page-fill-on-last-row still emits cursor; both valid hits surface", async () => {
		// When the page fills exactly on the last (lookahead) row, the post-loop
		// cursor must still fire — the lookahead's existence implies more
		// candidates past the SQL window regardless of confirmed-count.
		const sourceFiles: string[] = [];
		let cursor: string | undefined;
		let pages = 0;
		while (pages++ < 10) {
			const args: Record<string, unknown> = { file: "notes/target.md", direction: "in", pageSize: 1 };
			if (cursor) args.cursor = cursor;
			const out = await callLinks(args);
			if (out.incoming) {
				for (const i of out.incoming) sourceFiles.push(i.source_file);
			}
			cursor = out.nextCursor;
			if (!cursor) break;
		}
		expect(sourceFiles).toEqual(["n6-valid-e.md", "n6-valid-f.md"]);
	});
});

describe("get_links — M3 stable_id narrowing precision", () => {
	test("outgoing: each duplicate-heading section returns only its own link", async () => {
		// Heading-path narrowing collapses both `# A` sections into one bucket;
		// stable_id is slot-precise.
		const outline = await conn.client.callTool({
			name: "get_file_outline",
			arguments: { file: "dup.md" },
		});
		const headings = (outline.structuredContent as { outline: Array<{ stable_id: string }> }).outline;
		expect(headings).toHaveLength(2);
		const sid1 = headings[0]?.stable_id;
		const sid2 = headings[1]?.stable_id;
		expect(sid1).toBeDefined();
		expect(sid2).toBeDefined();
		expect(sid1).not.toBe(sid2);

		const r1 = await callLinks({ file: "dup.md", direction: "out", stable_id: sid1 });
		expect((r1.outgoing ?? []).map((o) => o.raw_target)).toEqual(["X"]);

		const r2 = await callLinks({ file: "dup.md", direction: "out", stable_id: sid2 });
		expect((r2.outgoing ?? []).map((o) => o.raw_target)).toEqual(["Y"]);
	});

	test("incoming: only the first-match `# A` is reachable by `[[dup#A]]`", async () => {
		// Obsidian first-match semantics: `[[dup#A]]` resolves to the first `# A`
		// only. The resolver surfaces `targetStableId` so narrowing distinguishes
		// the two sections that share `heading_path: ["A"]`.
		const outline = await conn.client.callTool({
			name: "get_file_outline",
			arguments: { file: "dup.md" },
		});
		const headings = (outline.structuredContent as { outline: Array<{ stable_id: string }> }).outline;
		const sid1 = headings[0]?.stable_id;
		const sid2 = headings[1]?.stable_id;

		const r1 = await callLinks({ file: "dup.md", direction: "in", stable_id: sid1 });
		const sources1 = (r1.incoming ?? []).map((i) => i.source_file);
		expect(sources1).toContain("dup-caller.md");

		const r2 = await callLinks({ file: "dup.md", direction: "in", stable_id: sid2 });
		// Second `# A` is unreachable by raw text — only sid_first matches.
		expect(r2.incoming ?? []).toEqual([]);
	});

	test("incoming: source_stable_id surfaces on the response row", async () => {
		// Forward-looking field declared in types.ts:473 since W4. Schema V5
		// makes it real — every heading-section incoming link now carries
		// the precise source-section identifier.
		const out = await callLinks({ file: "refs.md", direction: "in" });
		const fromCaller = (out.incoming ?? []).find((i) => i.source_file === "caller.md");
		expect(fromCaller).toBeDefined();
		expect(fromCaller?.source_stable_id).toMatch(/^h:[0-9a-f]{14}$/);
	});
});

describe("get_links — N7 duplicate-heading cursor uniqueness", () => {
	test("two `# A` sections each with first link paginate without skipping", async () => {
		// Two `# A` sections both produce `link_ordinal=1` for their first link;
		// without the wikilinks-row `id` tiebreaker, cursor's `link_ordinal > 1`
		// skips the second section's first link entirely.
		const targets: string[] = [];
		let cursor: string | undefined;
		let pages = 0;
		while (pages++ < 4) {
			const args: Record<string, unknown> = { file: "dup.md", direction: "out", pageSize: 1 };
			if (cursor) args.cursor = cursor;
			const out = await callLinks(args);
			if (out.outgoing) {
				for (const o of out.outgoing) targets.push(o.raw_target);
			}
			cursor = out.nextCursor;
			if (!cursor) break;
		}
		expect(targets).toEqual(["X", "Y"]);
	});
});

describe("get_links — path-policy guards on direction:'in' AST skip", () => {
	// Unnarrowed `direction:"in"` answers from SQL without `readNote`, so the
	// extension / hidden / regular-file gates must run separately or asset
	// paths and hidden files leak as empty-success (and the existing-vs-
	// missing divergence lets agents probe for hidden-file existence).

	test("non-note extension → PATH_NOT_FOUND", async () => {
		const result = await conn.client.callTool({
			name: "get_links",
			arguments: { file: "asset.png", direction: "in" },
		});
		expect(result.isError).toBe(true);
		const err = result.structuredContent as VaultError;
		expect(err.code).toBe("PATH_NOT_FOUND");
	});

	test("directory path → PATH_NOT_FOUND", async () => {
		// `nested-rel` is implicitly a directory (populated by
		// `nested-rel/sibling-caller.md`). validatePath accepts directories;
		// the lstat gate is the only line of defense.
		const result = await conn.client.callTool({
			name: "get_links",
			arguments: { file: "nested-rel", direction: "in" },
		});
		expect(result.isError).toBe(true);
		const err = result.structuredContent as VaultError;
		expect(err.code).toBe("PATH_NOT_FOUND");
	});

	test("hidden file → PATH_NOT_FOUND", async () => {
		const result = await conn.client.callTool({
			name: "get_links",
			arguments: { file: ".hidden.md", direction: "in" },
		});
		expect(result.isError).toBe(true);
		const err = result.structuredContent as VaultError;
		expect(err.code).toBe("PATH_NOT_FOUND");
	});

	test("parse-failed valid note still recovers incoming via SQL", async () => {
		// Extension/hidden/regular-file pass; only the parse fails →
		// unnarrowed incoming still answers from the wikilinks table.
		const { writeFile, readFile } = await import("node:fs/promises");
		const { join } = await import("node:path");
		const targetAbs = join(vault.path, "resilient.md");
		const original = await readFile(targetAbs, "utf8");
		try {
			await writeFile(targetAbs, "---\nbroken: [unclosed\n---\n# Resilient\n\n[[A]]\n", "utf8");
			const out = await callLinks({ file: "resilient.md", direction: "in" });
			expect((out.incoming ?? []).map((i) => i.source_file)).toContain("resilient-caller.md");
		} finally {
			await writeFile(targetAbs, original, "utf8");
			await new Promise((r) => setTimeout(r, 200));
		}
	});
});

describe("get_links — outgoing probe before sentinel cursor", () => {
	test("outgoing-only file at exact page boundary emits NO nextCursor", async () => {
		// 0 incoming + 1 outgoing + pageSize:1 — incoming exhausts (empty),
		// then outgoing fills the page; with no remaining rows past the
		// outgoing window, no continuation cursor is needed.
		const out = await callLinks({ file: "outgoing-only.md", direction: "both", pageSize: 1 });
		expect(out.outgoing?.length).toBe(1);
		expect(out.nextCursor).toBeUndefined();
	});

	test("file with incoming + outgoing at exact boundary still emits cursor", async () => {
		// Brief contract: incoming exhausts first. Page 1 = 1 incoming
		// (filled exact), boundary probe sees outgoing has rows → emits
		// OUT_PHASE_START sentinel. Page 2 = 1 outgoing. The unvisited
		// outgoing phase must NOT advertise `outgoing: []` on page 1 —
		// that would let a client treat outgoing as exhausted before
		// following the cursor.
		const page1 = await callLinks({ file: "single-each.md", direction: "both", pageSize: 1 });
		expect(page1.incoming?.length).toBe(1);
		expect((page1.incoming ?? []).map((i) => i.source_file)).toContain("single-each-caller.md");
		expect(page1.nextCursor).toBeDefined();
		expect(page1.outgoing).toBeUndefined();
		const page2 = await callLinks({
			file: "single-each.md",
			direction: "both",
			pageSize: 1,
			cursor: page1.nextCursor,
		});
		expect(page2.outgoing?.length).toBe(1);
	});

	test("mid-incoming continuation cursor also omits unvisited outgoing", async () => {
		// 2 incoming + 1 outgoing, pageSize:1. Page 1 returns the first
		// incoming row + `{phase:"in", ...}` cursor (more incoming to
		// come); outgoing has NOT been visited yet. The previous gate
		// (which only fired for `phase:"out"`) would set `outgoing:[]`
		// here and let a client treat outgoing as exhausted before the
		// continuation cursor reaches the outgoing phase.
		const page1 = await callLinks({ file: "mid-in-target.md", direction: "both", pageSize: 1 });
		expect(page1.incoming?.length).toBe(1);
		expect(page1.nextCursor).toBeDefined();
		expect(page1.outgoing).toBeUndefined();

		// Page 2 may emit the second incoming + cursor or the outgoing
		// depending on the keyset boundary; only invariant is that all
		// three rows surface across the pagination chain (2 incoming +
		// 1 outgoing) without phantom `outgoing:[]` advertisements on
		// any unvisited-outgoing page.
		const seenIncoming = new Set<string>(page1.incoming?.map((i) => i.source_file) ?? []);
		let seenOutgoing = 0;
		let cursor = page1.nextCursor;
		let pages = 1;
		while (cursor && pages++ < 10) {
			const out: GetLinksResult = await callLinks({
				file: "mid-in-target.md",
				direction: "both",
				pageSize: 1,
				cursor,
			});
			for (const row of out.incoming ?? []) seenIncoming.add(row.source_file);
			for (const _ of out.outgoing ?? []) seenOutgoing++;
			// Every unvisited-outgoing page must omit `outgoing`. The only
			// page allowed to set `outgoing: []` is after outgoing has run
			// and emitted nothing — which doesn't happen for this fixture
			// (1 outgoing row exists).
			if (out.outgoing !== undefined && out.outgoing.length === 0) {
				throw new Error("outgoing: [] advertised before outgoing phase reached");
			}
			cursor = out.nextCursor;
		}
		expect([...seenIncoming].sort()).toEqual(["mid-in-source-a.md", "mid-in-source-b.md"]);
		expect(seenOutgoing).toBe(1);
	});
});

describe("get_links — multi-level `../` incoming candidates", () => {
	test("`[[../../../target]]` from a 3-levels-deep source surfaces in incoming", async () => {
		// `addPathVariants` enumerates `../` up to MAX_PATH_DEPTH so every
		// legal source location's relative-link form is in the prefilter.
		const out = await callLinks({ file: "deep/deep-target.md", direction: "in" });
		expect((out.incoming ?? []).map((i) => i.source_file)).toContain("deep/a/b/c/source.md");
	});
});

describe("get_links — block-anchor backlinks under section narrowing", () => {
	test("`[[target#^block-id]]` surfaces when narrowed to its containing heading", async () => {
		// `resolveAndCheck` maps block ID → containing heading via the
		// queried file's parsed `blockIndex` (block-anchor links don't
		// populate `targetHeadingPath` directly).
		const out = await callLinks({
			file: "block-target.md",
			direction: "in",
			heading_path: ["Section Two"],
		});
		expect((out.incoming ?? []).map((i) => i.source_file)).toContain("block-caller.md");
	});

	test("`[[target#^block-id]]` is excluded when narrowed to a different heading", async () => {
		const out = await callLinks({
			file: "block-target.md",
			direction: "in",
			heading_path: ["Section One"],
		});
		expect((out.incoming ?? []).map((i) => i.source_file)).not.toContain("block-caller.md");
	});

	test("block under the second of duplicate `# A` headings narrows by the right stable_id", async () => {
		// `f4-dup-block.md` has two `# A` headings with identical heading_path;
		// `^f4-block` lives under the SECOND one. Mapping block → containing
		// heading via `headings.find(by-path)` would always pick the first,
		// so narrowing by the second's id would drop the link. The block's
		// recorded `containing_stable_id` drives the comparison instead.
		const outline = await conn.client.callTool({
			name: "get_file_outline",
			arguments: { file: "f4-dup-block.md" },
		});
		const headings = (outline.structuredContent as { outline: Array<{ stable_id: string }> }).outline;
		expect(headings).toHaveLength(2);
		const sidFirst = headings[0]?.stable_id;
		const sidSecond = headings[1]?.stable_id;
		expect(sidFirst).not.toBe(sidSecond);

		const r1 = await callLinks({ file: "f4-dup-block.md", direction: "in", stable_id: sidFirst });
		expect((r1.incoming ?? []).map((i) => i.source_file)).not.toContain("f4-block-caller.md");

		const r2 = await callLinks({ file: "f4-dup-block.md", direction: "in", stable_id: sidSecond });
		expect((r2.incoming ?? []).map((i) => i.source_file)).toContain("f4-block-caller.md");
	});
});

describe("get_links — incoming page-fill mid-batch", () => {
	test("pageSize=1 with exactly 2 valid backlinks paginates without dropping the second", async () => {
		// `direction:"in"`, `pageSize:1`, target with 2 backlinks: SQL
		// returns 2 rows (oversample=4 → max 5), for-loop pushes row[0]
		// then breaks at row[1] because page filled. The `exhausted=true`
		// short-circuit must not fire when the for-loop broke mid-batch,
		// otherwise the cursor-emit is skipped and row[1] is dropped.
		// (Page count is loose: false-positive rows from other fixtures'
		// `[[#X]]` self-links share the empty `""` candidate prefix, so
		// the loop scans many rows per page. The invariant is no drop.)
		const collected: string[] = [];
		const seen = new Set<string>();
		let cursor: string | undefined;
		let pages = 0;
		while (pages++ < 200) {
			const args: Record<string, unknown> = { file: "f1-target.md", direction: "in", pageSize: 1 };
			if (cursor) args.cursor = cursor;
			const out = await callLinks(args);
			for (const row of out.incoming ?? []) {
				expect(seen.has(row.source_file)).toBe(false);
				seen.add(row.source_file);
				collected.push(row.source_file);
			}
			cursor = out.nextCursor;
			if (!cursor) break;
		}
		expect(collected.sort()).toEqual(["f1-source-a.md", "f1-source-b.md"]);
	});
});

describe("get_links — chunked candidate SQL handles >200 candidates", () => {
	test("listIncomingCandidates with 250 prefixes returns rows without SQLite expression-depth error", async () => {
		// 250 dummy prefixes plus one that matches a real wikilink row;
		// 250 > INCOMING_CANDIDATE_CHUNK_SIZE=200 forces the chunk path.
		// Real cases (15+-segment targets via addPathVariants) build OR
		// trees past SQLITE_MAX_EXPR_DEPTH=1000 — chunking + JS merge keep
		// each query under the cap.
		const opened = openSqlite({ dbPath: ":memory:" });
		const idx = createIndexHandle(opened.db, { includeHidden: false });
		try {
			idx.replaceFile({
				file: "src.md",
				mtime: 1,
				size: 16,
				fragments: [
					{
						anchor_kind: "file",
						stable_id: null,
						heading_path_json: null,
						heading_text: null,
						structural_path: null,
						range_start: 0,
						range_end: 16,
						body: "[[real-target]]",
						code: "",
						headings: "",
					},
				],
				links: [
					{
						source_heading_path_json: null,
						source_stable_id: null,
						source_anchor_kind: "file",
						link_ordinal: 1,
						raw_target: "real-target",
						is_embed: false,
						alias: null,
						link_text: "real-target",
					},
				],
				frontmatter: { created: null, updated: null, fields_json: "{}", tags: [] },
			});
			const prefixes: string[] = [];
			for (let i = 0; i < 249; i++) prefixes.push(`fake-${i}`);
			prefixes.push("real-target");
			const rows = idx.listIncomingCandidates({ candidatePrefixes: prefixes, pageSize: 50 });
			expect(rows.length).toBe(1);
			expect(rows[0]?.raw_target).toBe("real-target");
		} finally {
			closeSqlite(opened.db);
		}
	});
});

describe("get_links — warming gate", () => {
	// Direct-handler unit tests: integration tests can't reliably coerce the
	// `warming` state because the scanner finishes too quickly. Tests need a
	// real vault root because validatePath + readNote run BEFORE the gate;
	// a non-existent vaultRoot would surface as PATH_* and short-circuit the
	// gate logic under test.
	let gateVault: { path: string; cleanup: () => Promise<void> };
	let gateRoot: VaultRoot;

	beforeAll(async () => {
		gateVault = await createTempVault({ "any.md": "# Any\n" });
		gateRoot = await validateVaultRoot(gateVault.path);
	});

	afterAll(async () => {
		await gateVault.cleanup();
	});

	test("returns INDEX_WARMING when index state is warming", async () => {
		const opened = openSqlite({ dbPath: ":memory:" });
		const idx = createIndexHandle(opened.db, { includeHidden: false });
		try {
			idx.setStatus("warming");
			const input: GetLinksInput = { file: "any.md" };
			const result = await handleGetLinks(input, gateRoot, idx);
			expect(result.isError).toBe(true);
			const err = result.structuredContent as VaultError;
			expect(err.code).toBe("INDEX_WARMING");
		} finally {
			closeSqlite(opened.db);
		}
	});

	test("returns INDEX_WARMING when index state is cold", async () => {
		const opened = openSqlite({ dbPath: ":memory:" });
		const idx = createIndexHandle(opened.db, { includeHidden: false });
		try {
			const result = await handleGetLinks({ file: "any.md" }, gateRoot, idx);
			expect(result.isError).toBe(true);
			const err = result.structuredContent as VaultError;
			expect(err.code).toBe("INDEX_WARMING");
		} finally {
			closeSqlite(opened.db);
		}
	});

	test("invalid path returns PATH_OUTSIDE_VAULT during cold (validation precedes gate)", async () => {
		// Permanent input errors must surface as their own code instead of
		// being masked by the transient INDEX_WARMING — agents would
		// otherwise retry indefinitely against a permanently malformed path.
		const opened = openSqlite({ dbPath: ":memory:" });
		const idx = createIndexHandle(opened.db, { includeHidden: false });
		try {
			// Index is cold; a traversal path must still surface PATH_OUTSIDE_VAULT.
			const result = await handleGetLinks({ file: "../escape.md" }, gateRoot, idx);
			expect(result.isError).toBe(true);
			const err = result.structuredContent as VaultError;
			expect(err.code).toBe("PATH_OUTSIDE_VAULT");
		} finally {
			closeSqlite(opened.db);
		}
	});

	test("missing file returns PATH_NOT_FOUND during cold (validation precedes gate)", async () => {
		// Counter to the above: a path-shape-valid but FS-missing file likewise
		// surfaces as PATH_NOT_FOUND, not INDEX_WARMING.
		const opened = openSqlite({ dbPath: ":memory:" });
		const idx = createIndexHandle(opened.db, { includeHidden: false });
		try {
			const result = await handleGetLinks({ file: "ghost.md" }, gateRoot, idx);
			expect(result.isError).toBe(true);
			const err = result.structuredContent as VaultError;
			expect(err.code).toBe("PATH_NOT_FOUND");
		} finally {
			closeSqlite(opened.db);
		}
	});
});

describe("get_links — redundant-dot relative wikilink", () => {
	test("[[./../redundant-dot-target]] outgoing resolves to redundant-dot-target.md (canonical raw_target)", async () => {
		const out = await callLinks({ file: "redundant-dot-rel/source.md", direction: "out" });
		const resolved = (out.outgoing ?? []).map((o) => ({
			raw_target: o.raw_target,
			target_file: o.target_file,
		}));
		// Extraction collapses `./../X` to `../X`; outgoing resolution
		// against the canonical form still finds the target.
		expect(resolved).toContainEqual({
			raw_target: "../redundant-dot-target",
			target_file: "redundant-dot-target.md",
		});
	});

	test("get_links({file: redundant-dot-target.md, direction: 'in'}) sees the redundant-dot backlink", async () => {
		// computeIncomingCandidates emits `../redundant-dot-target` per
		// `addPathVariants`, matching the canonicalized stored raw_target.
		// Without canonicalization at extraction, the row would store
		// `./../redundant-dot-target` and the prefilter would miss it.
		const out = await callLinks({ file: "redundant-dot-target.md", direction: "in" });
		const sources = (out.incoming ?? []).map((i) => i.source_file);
		expect(sources).toContain("redundant-dot-rel/source.md");
	});
});

describe("get_links — non-default VAULT_EXTENSIONS in incoming candidates", () => {
	// VAULT_EXTENSIONS=md,mdx widens the predicate. computeIncomingCandidates
	// must iterate every configured extension; hardcoding `.md` would miss
	// `[[./target.mdx]]` siblings even though Phase 0 resolves them.
	let mdxVault: { path: string; cleanup: () => Promise<void> };
	let mdxConn: TestClient;

	beforeAll(async () => {
		mdxVault = await createTempVault({
			"notes/caller.md": "# Caller\n\n[[./target.mdx]]\n",
			"notes/target.mdx": "# Target MDX\n",
		});
		mdxConn = await spawnTestServer(mdxVault.path, { VAULT_EXTENSIONS: "md,mdx" });
		await waitForWarm(mdxConn.client);
	}, 30_000);

	afterAll(async () => {
		await mdxConn.close();
		await mdxVault.cleanup();
	});

	test("[[./target.mdx]] from sibling surfaces as incoming on notes/target.mdx", async () => {
		const r = await mdxConn.client.callTool({
			name: "get_links",
			arguments: { file: "notes/target.mdx", direction: "in" },
		});
		expect(r.isError).toBeFalsy();
		const out = r.structuredContent as GetLinksResult;
		const sources = (out.incoming ?? []).map((i) => ({
			source_file: i.source_file,
			raw_target: i.raw_target,
		}));
		expect(sources).toContainEqual({ source_file: "notes/caller.md", raw_target: "./target.mdx" });
	});
});
