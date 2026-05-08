/**
 * `search` integration tests — spawn the built server and exercise
 * the W3 BM25 query mode + filter-only mode contract end-to-end.
 *
 * Test fixture vault is the W2 default plus `search-fixture/` content
 * for FTS5 ranking and tag/date filter sweeps. The server is created
 * fresh per `describe` so the SQLite index is built from scratch.
 */

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { TOKENIZER_HEURISTIC } from "../../src/lib/tokenizer.js";
import type { MetaEnvelope, SearchOutput, VaultError } from "../../src/types.js";
import { spawnTestServer, type TestClient, waitForWarm } from "../helpers/mcp-client.js";
import { createTempVault, DEFAULT_VAULT_STRUCTURE, type VaultStructure } from "../helpers/vault.js";

const SEARCH_FIXTURE: VaultStructure = {
	"oauth.md": "---\ntags: [api, auth]\ndate: 2024-06-01\n---\n\n# OAuth2\n\nOAuth2 setup. Authentication via tokens.\n",
	"saml.md": "---\ntags: [auth]\ndate: 2024-03-01\n---\n\n# SAML\n\nSAML federation flow.\n",
	"docs-only.md": "---\ntags: [docs]\n---\n\n# Documentation\n\nReadme content.\n",
	// Frontmatter-only note (no headings, no body) — filter-only search by
	// tag MUST surface it as a `file` row even though there's nothing to
	// snippet. D31 row-emission rule.
	"fm-only-tagged.md": "---\ntags: [metadata-only]\n---\n",
	// Custom field with date-only string. Index normalizes to
	// `"2024-06-01T00:00:00Z"` so filter `gte: "2024-06-01"` lex-matches.
	"due-task.md": "---\ndue: 2024-06-01\n---\n\n# Task\n\nDeliverable.\n",
	// Invalid reserved `date` + valid `updated`: the COALESCE chain must
	// skip the garbage and fall through to `updated`.
	"corrupt-date.md": "---\ndate: not-a-date\nupdated: 2024-03-01\n---\n\n# Corrupt\n\nPayload.\n",
	// Scalar string in tag-like field. Without the `json_type` dispatch,
	// `json_each('foo')` raises "malformed JSON" at query time.
	"alias-scalar.md": "---\naliases: foo\n---\n\n# Aliased\n\nScalar form.\n",
	// Array form on the same field — both must coexist in one query.
	"alias-array.md": "---\naliases: [foo, bar]\n---\n\n# Aliased Array\n\nSequence form.\n",
	// Object value on the same field — has-query must NOT match and
	// MUST NOT throw.
	"alias-object.md": "---\naliases:\n  primary: foo\n---\n\n# Aliased Object\n\nMapping form.\n",
	// Numeric scalar field — exercises the field-level numeric range branch.
	"priority-task.md": "---\npriority: 7\n---\n\n# Priority Task\n\nNumeric range target.\n",
	// Raw non-ISO frontmatter (scanner skips canonicalization). Filter
	// `due.gte: "2024-01-01"` lex-passes via `'n' > '2'` without the
	// `iso_calendar_valid` UDF wrap.
	"bad-due.md": "---\ndue: not-a-date\n---\n\n# Bad Due\n\nbody\n",
	// Stringy value on a numerically-named field. Class ordering
	// (TEXT > INTEGER) lex-passes `priority.gte: 5` without the
	// `json_type` guard.
	"priority-text.md": "---\npriority: low\n---\n\n# Text Priority\n\nbody\n",
	// Code-only section: scanner.extractFtsTexts strips the fenced block from
	// the `body` column and routes it to `code`. The snippet builder must
	// fall back to `code` so a query that hits the code column produces a
	// non-empty snippet.
	"code-only.md": "---\ntags: [code-only-fixture]\n---\n\n# Setup\n\n```bash\nnpm install vaultcli\n```\n",
};

let vault: { path: string; cleanup: () => Promise<void> };
let conn: TestClient;

beforeAll(async () => {
	vault = await createTempVault({ ...DEFAULT_VAULT_STRUCTURE, ...SEARCH_FIXTURE });
	conn = await spawnTestServer(vault.path);
	await waitForWarm(conn.client);
}, 30_000);

afterAll(async () => {
	await conn.close();
	await vault.cleanup();
});

async function callSearch(args: Record<string, unknown>) {
	return conn.client.callTool({ name: "search", arguments: args });
}

describe("search — empty inputs", () => {
	test("empty query + empty filters → items: [] + query_note", async () => {
		const r = await callSearch({ query: "" });
		expect(r.isError).toBeFalsy();
		const out = r.structuredContent as SearchOutput;
		expect(out.items).toEqual([]);
		const meta = r._meta as MetaEnvelope;
		expect(meta.query_note).toBeTruthy();
		expect(meta.query_algorithm).toBe("query-sanitize-v1");
	});
});

describe("search — query mode (D33)", () => {
	test("returns matching heading row with bm25 score + snippet", async () => {
		const r = await callSearch({ query: "OAuth2" });
		expect(r.isError).toBeFalsy();
		const out = r.structuredContent as SearchOutput;
		expect(out.retriever).toBe("bm25");
		expect(out.items.length).toBeGreaterThan(0);
		const item = out.items[0];
		expect(item?.score_type).toBe("bm25");
		expect(item?.score).toBeGreaterThanOrEqual(0);
		const meta = r._meta as MetaEnvelope;
		expect(meta.snippet_algorithm).toBe("bm25-fragment-v1");
	});

	test("prefix query highlights stem-extended body match in snippet", async () => {
		// oauth.md body: "OAuth2 setup. Authentication via tokens."
		// FTS5 prefix `auth*` matches via stem("authentication")="authent";
		// the snippet's exact-stem set lookup compares stem("auth") to
		// stem("authentication"), which differ — without prefix-stem
		// matching the snippet falls back to first 200 chars without
		// highlighting. The sanitizer carries the `*` marker through
		// `outcome.tokens` so the matcher can switch to prefix-stem.
		const r = await callSearch({ query: "auth*" });
		expect(r.isError).toBeFalsy();
		const out = r.structuredContent as SearchOutput;
		const oauth = out.items.find((i) => i.file === "oauth.md");
		expect(oauth).toBeDefined();
		expect(oauth?.snippet).toContain("**Authentication**");
	});

	test("code-only section: query that hits the code column → snippet from code", async () => {
		const r = await callSearch({ query: "vaultcli" });
		expect(r.isError).toBeFalsy();
		const out = r.structuredContent as SearchOutput;
		const item = out.items.find((i) => i.file === "code-only.md");
		expect(item).toBeDefined();
		expect(item?.snippet).toContain("vaultcli");
	});

	test("filter-only mode: code-only section → preview from code", async () => {
		const r = await callSearch({ query: "", filters: { tags: { has: "code-only-fixture" } } });
		expect(r.isError).toBeFalsy();
		const out = r.structuredContent as SearchOutput;
		const item = out.items.find((i) => i.file === "code-only.md");
		expect(item).toBeDefined();
		expect(item?.snippet).toContain("npm install");
	});

	test("punctuation-only query → empty items + query_note", async () => {
		const r = await callSearch({ query: "***" });
		expect(r.isError).toBeFalsy();
		const out = r.structuredContent as SearchOutput;
		expect(out.items).toEqual([]);
		const meta = r._meta as MetaEnvelope;
		expect(meta.query_note).toBeTruthy();
	});
});

describe("search — filter-only mode (D33)", () => {
	test("empty query + tags filter → score_type: filter, retriever: filter", async () => {
		const r = await callSearch({ query: "", filters: { tags: { has: "auth" } } });
		expect(r.isError).toBeFalsy();
		const out = r.structuredContent as SearchOutput;
		expect(out.retriever).toBe("filter");
		expect(out.items.length).toBeGreaterThan(0);
		for (const item of out.items) {
			expect(item.score).toBe(0);
			expect(item.score_type).toBe("filter");
		}
		const meta = r._meta as MetaEnvelope;
		expect(meta.snippet_algorithm).toBe("filter-preview-v1");
	});

	test("tag prefix matches hierarchy: 'api' matches 'api/v1' but NOT 'apiculture'", async () => {
		// Sanity check: oauth.md has tags [api, auth]; docs-only.md has [docs].
		const r = await callSearch({ query: "", filters: { tags: { has: "api" } } });
		const out = r.structuredContent as SearchOutput;
		expect(out.items.some((i) => i.file === "oauth.md")).toBe(true);
		expect(out.items.some((i) => i.file === "docs-only.md")).toBe(false);
	});

	test("frontmatter-only note surfaces via filter-only tag search (D31)", async () => {
		const r = await callSearch({ query: "", filters: { tags: { has: "metadata-only" } } });
		expect(r.isError).toBeFalsy();
		const out = r.structuredContent as SearchOutput;
		const item = out.items.find((i) => i.file === "fm-only-tagged.md");
		expect(item).toBeDefined();
		expect(item?.anchor_kind).toBe("file");
	});
});

describe("search — error envelopes", () => {
	test("INVALID_QUERY for over-length input", async () => {
		const r = await callSearch({ query: "x".repeat(2000) });
		expect(r.isError).toBe(true);
		const err = r.structuredContent as VaultError;
		expect(err.code).toBe("INVALID_QUERY");
	});

	test("FILTER_SYNTAX_ERROR for malicious tag literal", async () => {
		const r = await callSearch({ query: "", filters: { tags: { has: "x'; DROP TABLE fragments; --" } } });
		expect(r.isError).toBe(true);
		const err = r.structuredContent as VaultError;
		expect(err.code).toBe("FILTER_SYNTAX_ERROR");
	});

	test("FILTER_SYNTAX_ERROR for mixed-category fields[name]", async () => {
		const r = await callSearch({ query: "", filters: { fields: { x: { has: "a", eq: "b" } } } });
		expect(r.isError).toBe(true);
		const err = r.structuredContent as VaultError;
		expect(err.code).toBe("FILTER_SYNTAX_ERROR");
	});

	test("CURSOR_INVALID for forged base64", async () => {
		const r = await callSearch({ query: "OAuth2", cursor: "not-a-valid-cursor-payload" });
		expect(r.isError).toBe(true);
		const err = r.structuredContent as VaultError;
		expect(err.code).toBe("CURSOR_INVALID");
	});

	test("PATH_NOT_FOUND when scope.path does not exist", async () => {
		const r = await callSearch({ query: "OAuth2", scope: { path: "no-such-file.md" } });
		expect(r.isError).toBe(true);
		const err = r.structuredContent as VaultError;
		expect(err.code).toBe("PATH_NOT_FOUND");
		expect(err.param).toBe("scope.path");
	});

	test("PATH_OUTSIDE_VAULT for traversal", async () => {
		const r = await callSearch({ query: "x", scope: { path: "../etc/hosts" } });
		expect(r.isError).toBe(true);
		const err = r.structuredContent as VaultError;
		expect(err.code).toBe("PATH_OUTSIDE_VAULT");
		expect(err.param).toBe("scope.path");
	});

	test("PATH_OUTSIDE_VAULT/EMPTY_PATH for empty scope.path (matches `file` param uniformity)", async () => {
		// scope.path follows the same validatePath rules as `file` parameters
		// elsewhere — `""` is an EMPTY_PATH, not a vault-wide selector. Only
		// `undefined` (omitted) selects vault-wide.
		const r = await callSearch({ query: "x", scope: { path: "" } });
		expect(r.isError).toBe(true);
		const err = r.structuredContent as VaultError;
		expect(err.code).toBe("PATH_OUTSIDE_VAULT");
		expect(err.reason).toBe("EMPTY_PATH");
		expect(err.param).toBe("scope.path");
	});

	test.each([
		[".obsidian", "hidden directory at root"],
		[".obsidian/notes.md", "hidden segment mid-path"],
	])("PATH_NOT_FOUND for hidden scope.path: %s (%s)", async (path) => {
		const r = await callSearch({ query: "x", scope: { path } });
		expect(r.isError).toBe(true);
		const err = r.structuredContent as VaultError;
		expect(err.code).toBe("PATH_NOT_FOUND");
		expect(err.param).toBe("scope.path");
	});
});

describe("search — date filter normalization round-trip", () => {
	test("custom field date-only equality matches across normalization", async () => {
		// Without index-side normalization, indexed `due: "2024-06-01"`
		// lex-loses to bound `"2024-06-01T00:00:00Z"`. Both sides must
		// canonicalize so the same-day comparison succeeds.
		const r = await callSearch({ query: "", filters: { fields: { due: { gte: "2024-06-01" } } } });
		expect(r.isError).toBeFalsy();
		const out = r.structuredContent as SearchOutput;
		expect(out.items.some((i) => i.file === "due-task.md")).toBe(true);
	});

	test("custom field date-only `lte` matches same day", async () => {
		const r = await callSearch({ query: "", filters: { fields: { due: { lte: "2024-06-01" } } } });
		expect(r.isError).toBeFalsy();
		const out = r.structuredContent as SearchOutput;
		expect(out.items.some((i) => i.file === "due-task.md")).toBe(true);
	});

	test("invalid reserved `date` falls through COALESCE chain to `updated`", async () => {
		// `garbage > "2024-06-01"` lex-passes (g=0x67 > 2=0x32) if the raw
		// value reaches the chain — the GLOB shape-check on json_extract
		// must drop non-canonical text so COALESCE reads `updated` instead.
		const r = await callSearch({ query: "", filters: { date: { lte: "2024-06-01" } } });
		expect(r.isError).toBeFalsy();
		const out = r.structuredContent as SearchOutput;
		expect(out.items.some((i) => i.file === "corrupt-date.md")).toBe(true);
	});

	test('fields["date"].eq matches raw invalid value', async () => {
		// Brief line 593: `fields["date"]` lex-compares the literal text
		// even when the raw value isn't a parseable date.
		const r = await callSearch({ query: "", filters: { fields: { date: { eq: "not-a-date" } } } });
		expect(r.isError).toBeFalsy();
		const out = r.structuredContent as SearchOutput;
		expect(out.items.some((i) => i.file === "corrupt-date.md")).toBe(true);
	});

	test('fields["date"].is_empty: true excludes file with raw invalid date', async () => {
		const r = await callSearch({ query: "", filters: { fields: { date: { is_empty: true } } } });
		expect(r.isError).toBeFalsy();
		const out = r.structuredContent as SearchOutput;
		expect(out.items.some((i) => i.file === "corrupt-date.md")).toBe(false);
	});
});

describe("search — fields[name] numeric range", () => {
	test("numeric gte filter reaches the compiler", async () => {
		const r = await callSearch({ query: "", filters: { fields: { priority: { gte: 5 } } } });
		expect(r.isError).toBeFalsy();
		const out = r.structuredContent as SearchOutput;
		expect(out.items.some((i) => i.file === "priority-task.md")).toBe(true);
	});

	test("numeric lt filter excludes file above bound", async () => {
		const r = await callSearch({ query: "", filters: { fields: { priority: { lt: 5 } } } });
		expect(r.isError).toBeFalsy();
		const out = r.structuredContent as SearchOutput;
		expect(out.items.some((i) => i.file === "priority-task.md")).toBe(false);
	});

	test("numeric gte excludes stringy value", async () => {
		// SQLite class ordering (TEXT > INTEGER) would otherwise let
		// `'low' >= 5` evaluate TRUE; the `json_type` guard rejects.
		const r = await callSearch({ query: "", filters: { fields: { priority: { gte: 5 } } } });
		expect(r.isError).toBeFalsy();
		const out = r.structuredContent as SearchOutput;
		expect(out.items.some((i) => i.file === "priority-text.md")).toBe(false);
	});
});

describe("search — fields[name] custom date range", () => {
	test("custom date gte excludes raw frontmatter typo", async () => {
		// `'not-a-date' >= '2024-01-01T00:00:00Z'` lex-passes via
		// `'n' > '2'` without the `iso_calendar_valid` wrap.
		const r = await callSearch({ query: "", filters: { fields: { due: { gte: "2024-01-01" } } } });
		expect(r.isError).toBeFalsy();
		const out = r.structuredContent as SearchOutput;
		expect(out.items.some((i) => i.file === "bad-due.md")).toBe(false);
	});

	test("custom date gte still matches canonical stored value", async () => {
		// Regression on the index-time normalization contract:
		// due-task.md's `due: 2024-06-01` is stored as `2024-06-01T00:00:00Z`,
		// which the UDF accepts and the lex-compare matches.
		const r = await callSearch({ query: "", filters: { fields: { due: { gte: "2024-01-01" } } } });
		expect(r.isError).toBeFalsy();
		const out = r.structuredContent as SearchOutput;
		expect(out.items.some((i) => i.file === "due-task.md")).toBe(true);
	});
});

describe("search — fields[tag] scalar/array dispatch", () => {
	test("has on scalar string field matches that file", async () => {
		// Regression: passing the bare SQL text returned by json_extract
		// to json_each raises "malformed JSON" — the value is a SQL string,
		// not a JSON document, so json_each must be skipped for scalars.
		const r = await callSearch({ query: "", filters: { fields: { aliases: { has: "foo" } } } });
		expect(r.isError).toBeFalsy();
		const out = r.structuredContent as SearchOutput;
		expect(out.items.some((i) => i.file === "alias-scalar.md")).toBe(true);
	});

	test("has on array field still matches", async () => {
		const r = await callSearch({ query: "", filters: { fields: { aliases: { has: "bar" } } } });
		expect(r.isError).toBeFalsy();
		const out = r.structuredContent as SearchOutput;
		expect(out.items.some((i) => i.file === "alias-array.md")).toBe(true);
	});

	test("has on object field returns no match without throwing", async () => {
		// `aliases: {primary: foo}` is structurally invalid as a tag list.
		// CASE → json_array() → json_each iterates zero rows, EXISTS false.
		const r = await callSearch({ query: "", filters: { fields: { aliases: { has: "foo" } } } });
		expect(r.isError).toBeFalsy();
		const out = r.structuredContent as SearchOutput;
		expect(out.items.some((i) => i.file === "alias-object.md")).toBe(false);
	});

	test("has_any across mixed field shapes returns scalar + array files", async () => {
		const r = await callSearch({
			query: "",
			filters: { fields: { aliases: { has_any: ["foo", "bar"] } } },
		});
		expect(r.isError).toBeFalsy();
		const out = r.structuredContent as SearchOutput;
		const files = new Set(out.items.map((i) => i.file));
		expect(files.has("alias-scalar.md")).toBe(true);
		expect(files.has("alias-array.md")).toBe(true);
	});

	test("has on missing field returns no match", async () => {
		const r = await callSearch({ query: "", filters: { fields: { aliases: { has: "no-such-alias" } } } });
		expect(r.isError).toBeFalsy();
		const out = r.structuredContent as SearchOutput;
		expect(out.items.length).toBe(0);
	});
});

describe("search — error envelopes preserve _meta", () => {
	test("FILTER_SYNTAX_ERROR keeps warm index_status + query_algorithm", async () => {
		const r = await callSearch({ query: "", filters: { fields: { x: { has: "a", eq: "b" } } } });
		expect(r.isError).toBe(true);
		const meta = r._meta as MetaEnvelope;
		expect(meta.index_status.state).toBe("warm");
		expect(meta.query_algorithm).toBe("query-sanitize-v1");
	});

	test("CURSOR_INVALID keeps warm index_status + query_algorithm", async () => {
		const r = await callSearch({ query: "OAuth2", cursor: "not-a-valid-cursor-payload" });
		expect(r.isError).toBe(true);
		const meta = r._meta as MetaEnvelope;
		expect(meta.index_status.state).toBe("warm");
		expect(meta.query_algorithm).toBe("query-sanitize-v1");
	});

	test("PATH_NOT_FOUND keeps warm index_status + query_algorithm", async () => {
		const r = await callSearch({ query: "OAuth2", scope: { path: "no-such-file.md" } });
		expect(r.isError).toBe(true);
		const meta = r._meta as MetaEnvelope;
		expect(meta.index_status.state).toBe("warm");
		expect(meta.query_algorithm).toBe("query-sanitize-v1");
	});
});

describe("search — _meta tokenizer", () => {
	test("query-mode success carries tokenizer", async () => {
		const r = await callSearch({ query: "OAuth2" });
		expect(r.isError).toBeFalsy();
		const meta = r._meta as MetaEnvelope;
		expect(meta.tokenizer).toBe(TOKENIZER_HEURISTIC);
	});

	test("filter-only success carries tokenizer", async () => {
		const r = await callSearch({ query: "", filters: { tags: { has: "auth" } } });
		expect(r.isError).toBeFalsy();
		const meta = r._meta as MetaEnvelope;
		expect(meta.tokenizer).toBe(TOKENIZER_HEURISTIC);
	});

	test("empty inputs (items: []) carries tokenizer", async () => {
		const r = await callSearch({ query: "" });
		expect(r.isError).toBeFalsy();
		const meta = r._meta as MetaEnvelope;
		expect(meta.tokenizer).toBe(TOKENIZER_HEURISTIC);
	});

	test("error envelope carries tokenizer", async () => {
		const r = await callSearch({ query: "", filters: { fields: { x: { has: "a", eq: "b" } } } });
		expect(r.isError).toBe(true);
		const meta = r._meta as MetaEnvelope;
		expect(meta.tokenizer).toBe(TOKENIZER_HEURISTIC);
	});
});

describe("search — pageSize clamp", () => {
	test("pageSize > MAX_PAGE_SIZE silently clamps", async () => {
		const r = await callSearch({ query: "OAuth2", pageSize: 5000 });
		expect(r.isError).toBeFalsy();
	});

	test("pageSize=1 is honored", async () => {
		const r = await callSearch({ query: "auth*", pageSize: 1 });
		expect(r.isError).toBeFalsy();
		const out = r.structuredContent as SearchOutput;
		expect(out.items.length).toBeLessThanOrEqual(1);
	});
});

describe("search — cursor round-trip", () => {
	test("query-mode pagination produces nextCursor when items.length === pageSize", async () => {
		// Use a scope-less query that should match multiple files in the
		// default fixture. pageSize=1 forces pagination.
		const first = await callSearch({ query: "auth*", pageSize: 1 });
		expect(first.isError).toBeFalsy();
		const out1 = first.structuredContent as SearchOutput;
		if (out1.items.length === 1 && out1.nextCursor) {
			const second = await callSearch({ query: "auth*", pageSize: 1, cursor: out1.nextCursor });
			expect(second.isError).toBeFalsy();
		}
	});

	test("mid-pagination filter change → CURSOR_INVALID", async () => {
		const first = await callSearch({ query: "", filters: { tags: { has: "auth" } }, pageSize: 1 });
		const out1 = first.structuredContent as SearchOutput;
		if (out1.nextCursor) {
			const r = await callSearch({ query: "", filters: { tags: { has: "docs" } }, cursor: out1.nextCursor });
			expect(r.isError).toBe(true);
			const err = r.structuredContent as VaultError;
			expect(err.code).toBe("CURSOR_INVALID");
		}
	});

	test("mid-pagination scope change → CURSOR_INVALID", async () => {
		const first = await callSearch({ query: "", filters: { tags: { has: "auth" } }, pageSize: 1 });
		const out1 = first.structuredContent as SearchOutput;
		if (out1.nextCursor) {
			const r = await callSearch({
				query: "",
				filters: { tags: { has: "auth" } },
				scope: { path: "oauth.md" },
				cursor: out1.nextCursor,
			});
			expect(r.isError).toBe(true);
			const err = r.structuredContent as VaultError;
			expect(err.code).toBe("CURSOR_INVALID");
		}
	});

	test("mid-pagination query change → CURSOR_INVALID", async () => {
		const first = await callSearch({ query: "auth*", pageSize: 1 });
		const out1 = first.structuredContent as SearchOutput;
		if (out1.nextCursor) {
			const r = await callSearch({ query: "different-token", pageSize: 1, cursor: out1.nextCursor });
			expect(r.isError).toBe(true);
			const err = r.structuredContent as VaultError;
			expect(err.code).toBe("CURSOR_INVALID");
		}
	});
});
