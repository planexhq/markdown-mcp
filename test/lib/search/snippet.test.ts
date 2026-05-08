/**
 * Snippet tests: bm25-fragment-v1 + filter-preview-v1.
 */

import { describe, expect, test } from "vitest";

import {
	BM25_SNIPPET_ALGORITHM_ID,
	buildBm25Snippet,
	buildFilterPreview,
	FILTER_PREVIEW_ALGORITHM_ID,
	SNIPPET_BUDGET,
	SNIPPET_HARD_CAP,
} from "../../../src/lib/search/snippet.js";

describe("bm25-fragment-v1 — basic", () => {
	test("zero matches → first 200 chars of body, no highlights", () => {
		const body = "Some text without any of the query terms in it.";
		const out = buildBm25Snippet({ body, code: "", terms: ["nonexistent"] });
		expect(out).not.toContain("**");
		expect(out.length).toBeLessThanOrEqual(SNIPPET_HARD_CAP);
	});

	test("empty body + empty code → empty string", () => {
		expect(buildBm25Snippet({ body: "", code: "", terms: ["x"] })).toBe("");
	});

	test("empty terms → first 200 chars (degraded)", () => {
		const body = "hello world from the void";
		const out = buildBm25Snippet({ body, code: "", terms: [] });
		expect(out).toContain("hello");
		expect(out).not.toContain("**");
	});

	test("short body with match → whole sentence with highlights", () => {
		const body = "The authentication flow is documented here.";
		const out = buildBm25Snippet({ body, code: "", terms: ["authentication"] });
		expect(out).toContain("**authentication**");
	});

	test("stem-aware: 'running' query highlights 'runs' in body", () => {
		const body = "The script runs each hour without supervision.";
		const out = buildBm25Snippet({ body, code: "", terms: ["running"] });
		expect(out).toContain("**runs**");
	});
});

describe("bm25-fragment-v1 — windowed selection", () => {
	test("body > 200 chars with single match → 200-char window centered on match", () => {
		// 400-char body with one match in the middle.
		const filler = "x ".repeat(100);
		const body = `${filler}target ${filler}`;
		const out = buildBm25Snippet({ body, code: "", terms: ["target"] });
		expect(out.length).toBeLessThanOrEqual(SNIPPET_HARD_CAP);
		expect(out).toContain("**target**");
	});

	test("hard cap enforced at 220 chars", () => {
		const body = `${"lorem ipsum ".repeat(50)}needle ${"lorem ipsum ".repeat(50)}`;
		const out = buildBm25Snippet({ body, code: "", terms: ["needle"] });
		expect(out.length).toBeLessThanOrEqual(SNIPPET_HARD_CAP);
	});
});

describe("bm25-fragment-v1 — body→code fallback", () => {
	test("term-empty body, term-rich code → snippet from code with highlight", () => {
		// Code-only section: scanner.extractFtsTexts strips fenced code from
		// `body` and routes it to `code`. A query that hits the code column
		// would otherwise produce an empty snippet.
		const out = buildBm25Snippet({ body: "", code: "npm install vaultcli\n", terms: ["vaultcli"] });
		expect(out).toContain("**vaultcli**");
	});

	test("body matches → body wins even when code also matches (BM25 weight preference)", () => {
		// BM25 weights body=2.0, code=0.5. Snippet preference mirrors that.
		const out = buildBm25Snippet({
			body: "The vaultcli tool is documented here.",
			code: "npm install vaultcli\n",
			terms: ["vaultcli"],
		});
		expect(out).toContain("documented");
		expect(out).not.toContain("npm install");
	});

	test("body has prose but no match, code has match → snippet from code", () => {
		const out = buildBm25Snippet({
			body: "Setup instructions follow.",
			code: "npm install zyngar\n",
			terms: ["zyngar"],
		});
		expect(out).toContain("**zyngar**");
	});

	test("neither column matches, body has content → first 200 chars of body", () => {
		const out = buildBm25Snippet({
			body: "Heading only hit on this section.",
			code: "ls -la",
			terms: ["nomatch"],
		});
		expect(out).toContain("Heading only");
		expect(out).not.toContain("**");
	});

	test("neither column matches, body empty, code non-empty → first 200 chars of code", () => {
		const out = buildBm25Snippet({
			body: "",
			code: "ls -la\ncat /tmp/foo",
			terms: ["nomatch"],
		});
		expect(out.length).toBeGreaterThan(0);
		expect(out).not.toContain("**");
	});
});

describe("filter-preview-v1", () => {
	test("strips leading whitespace + first 200 chars", () => {
		const body = "  \n\n  Some content here that should appear without leading whitespace.";
		const out = buildFilterPreview({ body, code: "" });
		expect(out.startsWith("Some")).toBe(true);
		expect(out.length).toBeLessThanOrEqual(SNIPPET_HARD_CAP);
	});

	test("empty body + empty code → empty string", () => {
		expect(buildFilterPreview({ body: "", code: "" })).toBe("");
	});

	test("empty body, code non-empty → preview from code", () => {
		const out = buildFilterPreview({ body: "", code: "npm install vault-mcp" });
		expect(out).toContain("npm install");
	});

	test("whitespace-only body, code non-empty → preview from code", () => {
		const out = buildFilterPreview({ body: "   \n\n  ", code: "ls -la" });
		expect(out).toContain("ls -la");
	});

	test("body non-empty wins over code", () => {
		const out = buildFilterPreview({ body: "prose text", code: "ls -la" });
		expect(out).toContain("prose text");
		expect(out).not.toContain("ls");
	});

	test("never adds highlights", () => {
		const body = "foo bar baz with terms that won't be highlighted";
		const out = buildFilterPreview({ body, code: "" });
		expect(out).not.toContain("**");
	});

	test("snippet budget honored", () => {
		const body = "x ".repeat(500);
		const out = buildFilterPreview({ body, code: "" });
		expect(out.length).toBeLessThanOrEqual(SNIPPET_HARD_CAP);
		expect(out.length).toBeGreaterThan(0);
	});
});

describe("bm25-fragment-v1 — prefix-stem matching", () => {
	test("prefix `auth*` highlights body word `Authentication` (porter stem differs from `auth`)", () => {
		// stem("auth")="auth" vs stem("authentication")="authent" — an
		// exact-stem-set lookup misses. FTS5 prefix-matches the row but
		// the snippet falls back to first 200 chars without highlighting
		// unless the matcher is also prefix-stem-aware.
		const body = "OAuth2 setup. Authentication via tokens.";
		const out = buildBm25Snippet({ body, code: "", terms: ["auth*"] });
		expect(out).toContain("**Authentication**");
	});

	test("prefix `edit*` highlights multiple body stems sharing the prefix", () => {
		// Single sentence so the best-sentence picker doesn't drop matches.
		const body = "The editor stays calm while Editing continues and Edit works fine.";
		const out = buildBm25Snippet({ body, code: "", terms: ["edit*"] });
		expect(out).toContain("**editor**");
		expect(out).toContain("**Editing**");
		expect(out).toContain("**Edit**");
	});

	test("prefix `editing*` is equivalent to `edit*` (mirrors FTS5 stemming both sides)", () => {
		// porterStem("editing") = "edit"; matcher prefix-matches body
		// stems starting with "edit" — same set as `edit*`.
		const body = "The editor edits while Editing continues.";
		const out = buildBm25Snippet({ body, code: "", terms: ["editing*"] });
		expect(out).toContain("**editor**");
		expect(out).toContain("**Editing**");
	});

	test("non-prefix term `running` keeps exact-stem semantics — does NOT over-match `runner` / `rung`", () => {
		// `running` stems to `run`; `runs` stems to `run` (match);
		// `runner` stems to `runner`, `rung` stems to `rung` (no match).
		const body = "The runner sees rungs as runs continue.";
		const out = buildBm25Snippet({ body, code: "", terms: ["running"] });
		expect(out).toContain("**runs**");
		expect(out).not.toContain("**runner**");
		expect(out).not.toContain("**rungs**");
	});

	test("prefix and exact terms coexist on one query", () => {
		// Both matches inside one sentence so pickBestSentence keeps both.
		const body = "Authentication is used and Setup stays minimal.";
		const out = buildBm25Snippet({ body, code: "", terms: ["auth*", "setup"] });
		expect(out).toContain("**Authentication**");
		expect(out).toContain("**Setup**");
	});

	test("bare `*` token (no word) stems to empty string and contributes no matches", () => {
		// Defensive: `stemTerms` skips zero-length stems. The sanitizer
		// would already reject `*` as `null` before this path, but the
		// snippet builder shouldn't crash if a caller supplies one.
		const body = "Just plain text with nothing special.";
		const out = buildBm25Snippet({ body, code: "", terms: ["*"] });
		expect(out).not.toContain("**");
	});

	test("prefix matches in code column when body has no match", () => {
		const out = buildBm25Snippet({
			body: "",
			code: "npm install authenticator-cli\n",
			terms: ["auth*"],
		});
		expect(out).toContain("**authenticator**");
	});
});

describe("algorithm-id constants", () => {
	test("bm25-fragment-v1 / filter-preview-v1", () => {
		expect(BM25_SNIPPET_ALGORITHM_ID).toBe("bm25-fragment-v1");
		expect(FILTER_PREVIEW_ALGORITHM_ID).toBe("filter-preview-v1");
		expect(SNIPPET_BUDGET).toBe(200);
		expect(SNIPPET_HARD_CAP).toBe(220);
	});
});
