import { describe, expect, test } from "vitest";

import { renderOutline } from "../../../src/lib/renderText/getFileOutline.js";
import { TOKENIZER_HEURISTIC } from "../../../src/lib/tokenizer.js";
import type { GetFileOutlineResult, MetaEnvelope, OutlineNode } from "../../../src/types.js";

function meta(overrides: Partial<MetaEnvelope> = {}): MetaEnvelope {
	return {
		request_id: "00000000-0000-0000-0000-000000000000",
		index_status: { state: "warm", files_indexed: 42 },
		tokenizer: TOKENIZER_HEURISTIC,
		...overrides,
	};
}

function leaf(args: {
	level: 1 | 2 | 3 | 4 | 5 | 6;
	text: string;
	path?: string;
	id: string;
	tok: number;
	startLine: number;
	endLine: number;
	contentKinds?: OutlineNode["contentKinds"];
}): OutlineNode {
	const pathText = args.path ?? args.text;
	return {
		level: args.level,
		text: args.text,
		path: pathText,
		stable_id: args.id,
		anchor: pathText.toLowerCase().replace(/\s+/g, "-"),
		range: { start: args.startLine, end: args.endLine },
		selectionRange: { start: args.startLine, end: args.startLine },
		bodyTokensApprox: args.tok,
		subheadings: 0,
		descendantTokensApprox: args.tok,
		...(args.contentKinds ? { contentKinds: args.contentKinds } : {}),
	};
}

describe("renderOutline", () => {
	test("nested tree with descendant totals + block index", () => {
		const setup = leaf({ level: 3, text: "Setup", id: "h:1111111111aaaa", tok: 120, startLine: 16, endLine: 28 });
		const oauth: OutlineNode = {
			...leaf({ level: 2, text: "OAuth2", id: "h:def000000000aa", tok: 222, startLine: 14, endLine: 45 }),
			subheadings: 1,
			descendantTokensApprox: 342,
			children: [setup],
		};
		const saml = leaf({ level: 2, text: "SAML", id: "h:2222222222bbbb", tok: 210, startLine: 46, endLine: 70 });
		const auth: OutlineNode = {
			...leaf({ level: 1, text: "Auth", id: "h:abc000000000bb", tok: 50, startLine: 12, endLine: 98 }),
			subheadings: 2,
			descendantTokensApprox: 1240,
			children: [oauth, saml],
		};
		const sc: GetFileOutlineResult = {
			outline: [auth],
			blockIndex: {
				intro: { range: { start: 3, end: 8 }, heading_path: [], containing_stable_id: null },
				example: {
					range: { start: 20, end: 25 },
					heading_path: ["Auth", "OAuth2", "Setup"],
					containing_stable_id: "h:1111111111aaaa",
				},
			},
		};
		const out = renderOutline(sc, meta());
		expect(out).toBe(
			[
				"outline · 4 headings, 2 blocks",
				"",
				"# Auth  (~50 tok body, ~1240 tok total, id: h:abc000000000bb, L12-L98)",
				"  ## OAuth2  (~222 tok body, ~342 tok total, id: h:def000000000aa, L14-L45)",
				"    ### Setup  (~120 tok, id: h:1111111111aaaa, L16-L28)",
				"  ## SAML  (~210 tok, id: h:2222222222bbbb, L46-L70)",
				"",
				"blocks:",
				"  ^intro  (L3-L8, preamble)",
				"  ^example  (L20-L25, Auth › OAuth2 › Setup, id: h:1111111111aaaa)",
			].join("\n"),
		);
	});

	test("contentKinds surfaces inline", () => {
		const node = leaf({
			level: 1,
			text: "Code Snippets",
			id: "h:c0deabcd1234ef",
			tok: 50,
			startLine: 1,
			endLine: 30,
			contentKinds: ["code", "table"],
		});
		const sc: GetFileOutlineResult = { outline: [node], blockIndex: {} };
		const out = renderOutline(sc, meta());
		expect(out).toBe(
			[
				"outline · 1 heading, 0 blocks",
				"",
				"# Code Snippets  (~50 tok, id: h:c0deabcd1234ef, L1-L30 · contains: code, table)",
			].join("\n"),
		);
	});

	test("empty outline", () => {
		const sc: GetFileOutlineResult = { outline: [], blockIndex: {} };
		const out = renderOutline(sc, meta());
		expect(out).toBe("outline · 0 headings, 0 blocks");
	});

	test("blocks only (preamble file)", () => {
		const sc: GetFileOutlineResult = {
			outline: [],
			blockIndex: {
				note: { range: { start: 1, end: 4 }, heading_path: [], containing_stable_id: null },
			},
		};
		const out = renderOutline(sc, meta());
		expect(out).toBe(["outline · 0 headings, 1 block", "", "blocks:", "  ^note  (L1-L4, preamble)"].join("\n"));
	});

	test("duplicate-heading blocks emit distinct container ids", () => {
		// Two `# A` sections share heading_path but D27 gives them distinct
		// stable_ids — the container-id suffix is the only disambiguator.
		const sc: GetFileOutlineResult = {
			outline: [],
			blockIndex: {
				first: {
					range: { start: 5, end: 8 },
					heading_path: ["A"],
					containing_stable_id: "h:aaaaaaaaaaaaaa",
				},
				second: {
					range: { start: 15, end: 18 },
					heading_path: ["A"],
					containing_stable_id: "h:bbbbbbbbbbbbbb",
				},
			},
		};
		const out = renderOutline(sc, meta());
		expect(out).toContain("  ^first  (L5-L8, A, id: h:aaaaaaaaaaaaaa)");
		expect(out).toContain("  ^second  (L15-L18, A, id: h:bbbbbbbbbbbbbb)");
	});

	test("multi-line setext heading: rendered row uses normalized path (single line)", () => {
		// Parser produces `displayText: "Heading\nthat spans"` (preserves the
		// soft-break newline for setext headings) and `pathText: "Heading that spans"`
		// (normalized via `normalizeHeadingText` — markup stripped, whitespace
		// collapsed). The renderer reads `path` so the id/range suffix stays
		// attached to the title.
		const setext: OutlineNode = leaf({
			level: 2,
			text: "Heading\nthat spans",
			path: "Heading that spans",
			id: "h:5e7e7e7e7e7e7e",
			tok: 30,
			startLine: 5,
			endLine: 10,
		});
		const sc: GetFileOutlineResult = { outline: [setext], blockIndex: {} };
		const out = renderOutline(sc, meta());
		expect(out).toBe(
			["outline · 1 heading, 0 blocks", "", "## Heading that spans  (~30 tok, id: h:5e7e7e7e7e7e7e, L5-L10)"].join(
				"\n",
			),
		);
	});

	test("control chars in heading title → escaped (line-forgery defense)", () => {
		// `node.path` is parser-normalized but `\s+`-class whitespace-collapse
		// misses Cc-category controls (U+0085 NEL most notably). Without the
		// renderer-side escape, the outline row would render as two lines in
		// a NEL-interpreting chat UI, forging a labeled `forged:` second line
		// in front of the real `id:`/range suffix. Same forgery class
		// `formatHeadingPath` defends against for its segments.
		const hostile: OutlineNode = leaf({
			level: 1,
			text: "H\u0085forged",
			path: "H\u0085forged",
			id: "h:f01ed1ed1ed1ed",
			tok: 5,
			startLine: 1,
			endLine: 2,
		});
		const sc: GetFileOutlineResult = { outline: [hostile], blockIndex: {} };
		const out = renderOutline(sc, meta());
		expect(out).toBe(
			["outline · 1 heading, 0 blocks", "", "# H\\x85forged  (~5 tok, id: h:f01ed1ed1ed1ed, L1-L2)"].join("\n"),
		);
		expect(out).not.toContain("\u0085");
	});

	test("formatted heading: row uses normalized path (markup stripped)", () => {
		// Real parser: `displayText = "Use \`<T>\`"` (preserves inline code),
		// `pathText = "Use <T>"` (markup-stripped via `mdastToString({includeHtml: false})`).
		// An agent copying the rendered title needs the path form to round-trip
		// through `heading_path` matching — the matcher expects `Use <T>`, not
		// the raw markdown.
		const formatted: OutlineNode = leaf({
			level: 1,
			text: "Use `<T>`",
			path: "Use <T>",
			id: "h:f0779a7ed1eaaa",
			tok: 40,
			startLine: 1,
			endLine: 12,
		});
		const sc: GetFileOutlineResult = { outline: [formatted], blockIndex: {} };
		const out = renderOutline(sc, meta());
		expect(out).toBe(
			["outline · 1 heading, 0 blocks", "", "# Use <T>  (~40 tok, id: h:f0779a7ed1eaaa, L1-L12)"].join("\n"),
		);
	});

	test("heading with separator-shape text is backslash-escaped", () => {
		// Without the escape, `normalizeHeadingPath` would false-split
		// `Cost › Benefit` into `["Cost", "Benefit"]` when an agent copies
		// the rendered leaf back as a string-form `heading_path`.
		const collide: OutlineNode = leaf({
			level: 2,
			text: "Cost › Benefit",
			path: "Cost › Benefit",
			id: "h:cccccccccccccc",
			tok: 20,
			startLine: 5,
			endLine: 10,
		});
		const ascii: OutlineNode = leaf({
			level: 2,
			text: "A > B",
			path: "A > B",
			id: "h:aaaaaaaaaaaaaa",
			tok: 15,
			startLine: 12,
			endLine: 18,
		});
		const sc: GetFileOutlineResult = { outline: [collide, ascii], blockIndex: {} };
		const out = renderOutline(sc, meta());
		expect(out).toBe(
			[
				"outline · 2 headings, 0 blocks",
				"",
				"## Cost \\› Benefit  (~20 tok, id: h:cccccccccccccc, L5-L10)",
				"## A \\> B  (~15 tok, id: h:aaaaaaaaaaaaaa, L12-L18)",
			].join("\n"),
		);
	});

	test("heading with separator at segment boundary is backslash-escaped", () => {
		// Boundary `›` / `>` (segment-start or segment-end) finds its
		// missing whitespace from the joiner ` › ` when this leaf is
		// composed back into a multi-segment heading_path — without
		// the `^`/`$` anchors, an agent copying `# > operator` back
		// would lex it as `["", "operator"]` after the false-split.
		const startSep: OutlineNode = leaf({
			level: 1,
			text: "> operator",
			path: "> operator",
			id: "h:1111111111aaaa",
			tok: 8,
			startLine: 1,
			endLine: 4,
		});
		const endSep: OutlineNode = leaf({
			level: 1,
			text: "Cost ›",
			path: "Cost ›",
			id: "h:2222222222bbbb",
			tok: 6,
			startLine: 5,
			endLine: 9,
		});
		const sc: GetFileOutlineResult = { outline: [startSep, endSep], blockIndex: {} };
		const out = renderOutline(sc, meta());
		expect(out).toBe(
			[
				"outline · 2 headings, 0 blocks",
				"",
				"# \\> operator  (~8 tok, id: h:1111111111aaaa, L1-L4)",
				"# Cost \\›  (~6 tok, id: h:2222222222bbbb, L5-L9)",
			].join("\n"),
		);
	});
});
