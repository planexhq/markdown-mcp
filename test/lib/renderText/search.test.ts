import { describe, expect, test } from "vitest";

import { renderSearch } from "../../../src/lib/renderText/search.js";
import { QUERY_ALGORITHM_ID } from "../../../src/lib/search/sanitize.js";
import { BM25_SNIPPET_ALGORITHM_ID, FILTER_PREVIEW_ALGORITHM_ID } from "../../../src/lib/search/snippet.js";
import { TOKENIZER_HEURISTIC } from "../../../src/lib/tokenizer.js";
import type { MetaEnvelope, SearchOutput } from "../../../src/types.js";

function meta(overrides: Partial<MetaEnvelope> = {}): MetaEnvelope {
	return {
		request_id: "00000000-0000-0000-0000-000000000000",
		index_status: { state: "warm", files_indexed: 42 },
		tokenizer: TOKENIZER_HEURISTIC,
		snippet_algorithm: BM25_SNIPPET_ALGORITHM_ID,
		query_algorithm: QUERY_ALGORITHM_ID,
		...overrides,
	};
}

describe("renderSearch", () => {
	test("query mode with mixed anchor kinds", () => {
		const sc: SearchOutput = {
			retriever: "bm25",
			items: [
				{
					anchor_kind: "heading",
					file: "notes/auth/oauth.md",
					heading_path: ["Auth", "OAuth2"],
					stable_id: "h:7a3f1b2c8d9e4f",
					snippet: "Configure your **oauth** provider with the **auth** callback URL...",
					score: 4.3142,
					score_type: "bm25",
				},
				{
					anchor_kind: "preamble",
					file: "docs/api.md",
					snippet: "Our API uses industry-standard **oauth** patterns...",
					score: 2.1812,
					score_type: "bm25",
				},
				{
					anchor_kind: "file",
					file: "archive/old.md",
					snippet: "Legacy notes (deprecated).",
					score: 0.5,
					score_type: "bm25",
				},
			],
			nextCursor: "eyJ2IjoxfQ==",
		};
		const out = renderSearch(sc, meta());
		expect(out).toBe(
			[
				"search · 3 results · bm25",
				"",
				"notes/auth/oauth.md › Auth › OAuth2  (score 4.31)",
				"  id: h:7a3f1b2c8d9e4f",
				"  snippet: Configure your **oauth** provider with the **auth** callback URL...",
				"",
				"docs/api.md · preamble  (score 2.18)",
				"  snippet: Our API uses industry-standard **oauth** patterns...",
				"",
				"archive/old.md · file  (score 0.50)",
				"  snippet: Legacy notes (deprecated).",
				"",
				"next: eyJ2IjoxfQ==",
			].join("\n"),
		);
	});

	test("filter-only mode header", () => {
		const sc: SearchOutput = {
			retriever: "filter",
			items: [
				{
					anchor_kind: "heading",
					file: "notes/intro.md",
					heading_path: ["Intro"],
					stable_id: "h:abcdef01234567",
					snippet: "First 200 chars preview...",
					score: 0,
					score_type: "filter",
				},
			],
		};
		const out = renderSearch(sc, meta({ snippet_algorithm: FILTER_PREVIEW_ALGORITHM_ID }));
		expect(out).toBe(
			[
				"search · 1 result · filter-only",
				"",
				"notes/intro.md › Intro  (score 0.00)",
				"  id: h:abcdef01234567",
				"  snippet: First 200 chars preview...",
				"",
				`meta: snippet=${FILTER_PREVIEW_ALGORITHM_ID}`,
			].join("\n"),
		);
	});

	test("empty results · bm25", () => {
		const sc: SearchOutput = { retriever: "bm25", items: [] };
		const out = renderSearch(sc, meta());
		expect(out).toBe("search · 0 results · bm25");
	});

	test("empty results with query_note (fallback-defanged)", () => {
		const sc: SearchOutput = { retriever: "bm25", items: [] };
		const out = renderSearch(sc, meta({ query_note: "fallback-defanged" }));
		expect(out).toBe(["search · 0 results · bm25", "", "meta: query=fallback-defanged"].join("\n"));
	});

	test("heading row with empty heading_path falls back to file-only title", () => {
		const sc: SearchOutput = {
			retriever: "bm25",
			items: [
				{
					anchor_kind: "heading",
					file: "notes/root.md",
					heading_path: [],
					stable_id: "h:0000000000abcd",
					snippet: "**term** hit",
					score: 1.0,
					score_type: "bm25",
				},
			],
		};
		const out = renderSearch(sc, meta());
		expect(out).toBe(
			[
				"search · 1 result · bm25",
				"",
				"notes/root.md  (score 1.00)",
				"  id: h:0000000000abcd",
				"  snippet: **term** hit",
			].join("\n"),
		);
	});

	test("snippet with newlines flattens to single line", () => {
		const sc: SearchOutput = {
			retriever: "bm25",
			items: [
				{
					anchor_kind: "preamble",
					file: "n.md",
					snippet: "line one\nline two\n   line three",
					score: 1.0,
					score_type: "bm25",
				},
			],
		};
		const out = renderSearch(sc, meta());
		expect(out).toContain("  snippet: line one line two line three");
	});

	test("snippet beginning `id: h:…` cannot spoof the stable-id line (F5)", () => {
		// A vault-controlled snippet that opens with `id: h:…` would
		// otherwise render with the same `  id: ` prefix as the real
		// stable-id line, letting a content-only client copy the
		// attacker's value as a stable_id. The `  snippet: ` label
		// keeps the boundary unambiguous.
		const sc: SearchOutput = {
			retriever: "bm25",
			items: [
				{
					anchor_kind: "heading",
					file: "evil.md",
					heading_path: ["Section"],
					stable_id: "h:1111111111aaaa",
					snippet: "id: h:malicious999999 followed by other text",
					score: 1.0,
					score_type: "bm25",
				},
			],
		};
		const out = renderSearch(sc, meta());
		expect(out).toContain("  id: h:1111111111aaaa");
		expect(out).toContain("  snippet: id: h:malicious999999 followed by other text");
		// The spoof attempt MUST NOT collapse onto a bare `  id: ` line.
		expect(out).not.toContain("\n  id: h:malicious999999");
	});

	test("warming state surfaces in meta footer", () => {
		const sc: SearchOutput = { retriever: "bm25", items: [] };
		const out = renderSearch(sc, meta({ index_status: { state: "warming", files_indexed: 7 } }));
		expect(out).toContain("meta: state=warming files=7");
	});

	test("heading row with `›`-containing filename gets guillemet-quoted", () => {
		// Round-trip rule for content-only clients: when a prose path is
		// wrapped in `«…»`, strip the guillemets and pass the inner text to
		// `file:`. Without the quote, this row collides with `{file:
		// "notes/foo", heading_path: ["bar.md", "X"]}` — same rendered bytes.
		const sc: SearchOutput = {
			retriever: "bm25",
			items: [
				{
					anchor_kind: "heading",
					file: "notes/foo › bar.md",
					heading_path: ["X"],
					stable_id: "h:abcdef01234567",
					snippet: "ignored",
					score: 1.0,
					score_type: "bm25",
				},
			],
		};
		const out = renderSearch(sc, meta());
		expect(out).toContain("«notes/foo › bar.md» › X  (score 1.00)");
		expect(out).not.toContain("\\›");
	});

	test("non-heading row with `›`-containing filename gets guillemet-quoted", () => {
		// Without the wrap, `{file: "notes/foo › bar.md", anchor_kind:
		// "preamble"}` and a heading row at `notes/foo` with heading
		// `["bar.md", ...]` would print identically.
		const sc: SearchOutput = {
			retriever: "filter",
			items: [
				{
					anchor_kind: "preamble",
					file: "notes/foo › bar.md",
					snippet: "preamble text",
					score: 0,
					score_type: "filter",
				},
				{
					anchor_kind: "file",
					file: "docs/x › y.md",
					snippet: "whole-file body",
					score: 0,
					score_type: "filter",
				},
			],
		};
		const out = renderSearch(sc, meta());
		expect(out).toContain("«notes/foo › bar.md» · preamble  (score 0.00)");
		expect(out).toContain("«docs/x › y.md» · file  (score 0.00)");
	});
});
