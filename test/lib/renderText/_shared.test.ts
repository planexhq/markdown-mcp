/**
 * Unit tests for the shared renderer helpers.
 *
 * Inline-fixture style: each test constructs a small typed input and
 * asserts the exact string output. Snapshot tests would obscure intent
 * (a single character drift looks identical to a real regression) for
 * pure-function rendering with narrow output.
 */

import { describe, expect, test } from "vitest";

import { FUZZY_ALGORITHM_ID } from "../../../src/lib/fuzzy.js";
import {
	formatCursor,
	formatFileHeading,
	formatHeadingPath,
	formatIncomingSource,
	formatMeta,
	formatOutgoingTarget,
	joinLines,
	sanitizePathForProse,
	singleLine,
} from "../../../src/lib/renderText/_shared.js";
import { QUERY_ALGORITHM_ID } from "../../../src/lib/search/sanitize.js";
import { BM25_SNIPPET_ALGORITHM_ID, FILTER_PREVIEW_ALGORITHM_ID } from "../../../src/lib/search/snippet.js";
import { TOKENIZER_HEURISTIC } from "../../../src/lib/tokenizer.js";
import type { MetaEnvelope } from "../../../src/types.js";

function baseMeta(overrides: Partial<MetaEnvelope> = {}): MetaEnvelope {
	return {
		request_id: "00000000-0000-0000-0000-000000000000",
		index_status: { state: "warm", files_indexed: 42 },
		...overrides,
	};
}

describe("formatHeadingPath", () => {
	test("empty array → empty string", () => {
		expect(formatHeadingPath([])).toBe("");
	});
	test("single segment", () => {
		expect(formatHeadingPath(["Auth"])).toBe("Auth");
	});
	test("multi segment joined with ›", () => {
		expect(formatHeadingPath(["Auth", "OAuth2", "Token Exchange"])).toBe("Auth › OAuth2 › Token Exchange");
	});
	test("control chars in segments → escaped (line-forgery defense)", () => {
		// Heading text comes from vault bodies, never sanitized upstream.
		// NEL renders as a newline in chat UIs / terminals that interpret
		// it — same forgery class `sanitizePathForProse` defends for paths.
		expect(formatHeadingPath(["H\u0085forged-label: data"])).toBe("H\\x85forged-label: data");
		expect(formatHeadingPath(["A", "B\u2028C"])).toBe("A › B\\u2028C");
		expect(formatHeadingPath(["A\tB", "C"])).toBe("A\\tB › C");
	});
	test("spaced separator inside a segment is backslash-escaped (round-trip safe)", () => {
		// Without the escape, `["Cost › Benefit"]` and `["Cost", "Benefit"]`
		// would render to identical bytes.
		expect(formatHeadingPath(["Cost › Benefit"])).toBe("Cost \\› Benefit");
		expect(formatHeadingPath(["A > B"])).toBe("A \\> B");
		// Bare `›` / `>` (no adjacent whitespace) stays unescaped — the
		// splitter requires `\s+[›>]\s+`, so `A›B` was never at risk.
		expect(formatHeadingPath(["A›B"])).toBe("A›B");
		expect(formatHeadingPath(["A>B"])).toBe("A>B");
	});
	test("literal backslashes in segment text are doubled (round-trip safe)", () => {
		// Doubling distinguishes literal `\›` in heading text from the
		// renderer-emitted separator escape `\›` — without it the parser
		// silently strips the user's backslash.
		expect(formatHeadingPath(["A\\B"])).toBe("A\\\\B");
		expect(formatHeadingPath(["C:\\Users\\Bob"])).toBe("C:\\\\Users\\\\Bob");
		// `>` preceded by `\` (not whitespace) doesn't match the separator-
		// escape regex, so only the backslash doubles.
		expect(formatHeadingPath(["Regex \\> Quantifier"])).toBe("Regex \\\\> Quantifier");
	});
	test("boundary-adjacent separator inside a segment is backslash-escaped", () => {
		// A `›`/`>` at the START or END of a segment finds its missing
		// whitespace from the joining `" › "`, so `["Cost ›", "Outer"]`
		// would otherwise render to `"Cost › › Outer"` — indistinguishable
		// from `["Cost", "Outer"]` after the parser's separator split.
		// `^`/`$` anchors close the boundary leak.
		expect(formatHeadingPath(["> operator"])).toBe("\\> operator");
		expect(formatHeadingPath(["Cost ›"])).toBe("Cost \\›");
		expect(formatHeadingPath([">"])).toBe("\\>");
		expect(formatHeadingPath(["›"])).toBe("\\›");
		expect(formatHeadingPath(["Parent", "> operator", "Child"])).toBe("Parent › \\> operator › Child");
		expect(formatHeadingPath(["Cost ›", "Outer"])).toBe("Cost \\› › Outer");
	});
	test("adjacent spaced separators each escape independently", () => {
		// A consuming `(^|\s)(...)(\s|$)` regex eats the shared whitespace
		// between two adjacent separators, leaving the second unescaped:
		// `["A > > B"]` would produce `"A \> > B"`, which the splitter then
		// false-splits on the bare ` > `, returning `["A >", "B"]`.
		// Zero-width lookbehind/lookahead lets each separator match
		// without competing for the shared trailing space.
		expect(formatHeadingPath(["A > > B"])).toBe("A \\> \\> B");
		expect(formatHeadingPath(["A › › B"])).toBe("A \\› \\› B");
		expect(formatHeadingPath(["> >"])).toBe("\\> \\>");
		expect(formatHeadingPath(["Parent", "A > > B", "Child"])).toBe("Parent › A \\> \\> B › Child");
		// Mixed boundary + interior in one segment.
		expect(formatHeadingPath(["› inner › end"])).toBe("\\› inner \\› end");
	});
});

describe("formatCursor", () => {
	test("undefined → null (omit the line)", () => {
		expect(formatCursor(undefined)).toBeNull();
	});
	test("present → labeled line", () => {
		expect(formatCursor("eyJ2IjoxfQ==")).toBe("next: eyJ2IjoxfQ==");
	});
});

describe("formatMeta", () => {
	test("all-default meta → null (no trailing line)", () => {
		expect(formatMeta(baseMeta())).toBeNull();
	});
	test("warming state surfaces with file count", () => {
		const out = formatMeta(baseMeta({ index_status: { state: "warming", files_indexed: 7 } }));
		expect(out).toBe("meta: state=warming files=7");
	});
	test("non-default tokenizer surfaces", () => {
		const out = formatMeta(baseMeta({ tokenizer: "tiktoken/o200k_base" }));
		expect(out).toBe("meta: tokenizer=tiktoken/o200k_base");
	});
	test("default tokenizer is suppressed", () => {
		const out = formatMeta(baseMeta({ tokenizer: TOKENIZER_HEURISTIC }));
		expect(out).toBeNull();
	});
	test("query_note always surfaces", () => {
		const out = formatMeta(baseMeta({ query_note: "fallback-defanged", query_algorithm: QUERY_ALGORITHM_ID }));
		expect(out).toBe("meta: query=fallback-defanged");
	});
	test("fuzzy_algorithm always surfaces (only emitted on stale recovery)", () => {
		const out = formatMeta(baseMeta({ fuzzy_algorithm: FUZZY_ALGORITHM_ID }));
		expect(out).toBe(`meta: fuzzy=${FUZZY_ALGORITHM_ID}`);
	});
	test("default snippet/query algorithm suppressed; non-default surfaces", () => {
		const def = formatMeta(
			baseMeta({ snippet_algorithm: BM25_SNIPPET_ALGORITHM_ID, query_algorithm: QUERY_ALGORITHM_ID }),
		);
		expect(def).toBeNull();
		const nonDef = formatMeta(baseMeta({ snippet_algorithm: FILTER_PREVIEW_ALGORITHM_ID }));
		expect(nonDef).toBe(`meta: snippet=${FILTER_PREVIEW_ALGORITHM_ID}`);
	});
	test("multiple non-defaults joined with ` · `", () => {
		const out = formatMeta(
			baseMeta({
				index_status: { state: "warming", files_indexed: 3 },
				tokenizer: "tiktoken/o200k_base",
				fuzzy_algorithm: FUZZY_ALGORITHM_ID,
			}),
		);
		expect(out).toBe(`meta: state=warming files=3 · tokenizer=tiktoken/o200k_base · fuzzy=${FUZZY_ALGORITHM_ID}`);
	});
});

describe("singleLine", () => {
	test("collapses runs of whitespace to single space", () => {
		expect(singleLine("foo  \n  bar\t\tbaz")).toBe("foo bar baz");
	});
	test("trims leading and trailing whitespace", () => {
		expect(singleLine("  hello world  ")).toBe("hello world");
	});
	test("preserves markdown bold inside", () => {
		expect(singleLine("hello **world** today")).toBe("hello **world** today");
	});
	test("U+0085 NEL collapses to single space (line-forgery defense)", () => {
		// NEL is Cc, not in JavaScript regex `\s` per ECMA-262 — must
		// be added to the collapse set so clients that render NEL as
		// a newline don't see forged labeled lines.
		expect(singleLine("prefix\u0085forged-label: data")).toBe("prefix forged-label: data");
	});
	test("U+2028 LINE SEPARATOR collapses (already in \\s, explicit cover)", () => {
		expect(singleLine("a\u2028b")).toBe("a b");
	});
	test("mixed whitespace + NEL → single space", () => {
		expect(singleLine("a  \n\u0085  b")).toBe("a b");
	});
});

describe("sanitizePathForProse", () => {
	test("printable ASCII passes through unchanged", () => {
		expect(sanitizePathForProse("notes/auth.md")).toBe("notes/auth.md");
	});
	test("Unicode (incl. U+203A) passes through unchanged", () => {
		expect(sanitizePathForProse("notes › 测试.md")).toBe("notes › 测试.md");
	});
	test("newline → \\n (line-forgery defense)", () => {
		expect(sanitizePathForProse("foo\nnext: cursor.md")).toBe("foo\\nnext: cursor.md");
	});
	test("carriage return → \\r", () => {
		expect(sanitizePathForProse("foo\rbar.md")).toBe("foo\\rbar.md");
	});
	test("tab → \\t", () => {
		expect(sanitizePathForProse("\tnotes.md")).toBe("\\tnotes.md");
	});
	test("other C0 controls → \\xHH (zero-padded)", () => {
		expect(sanitizePathForProse("a\x07b.md")).toBe("a\\x07b.md");
		expect(sanitizePathForProse("a\x1Fb.md")).toBe("a\\x1fb.md");
	});
	test("NUL → \\x00", () => {
		expect(sanitizePathForProse("a\x00b.md")).toBe("a\\x00b.md");
	});
	test("DEL → \\x7f", () => {
		expect(sanitizePathForProse("a\x7Fb.md")).toBe("a\\x7fb.md");
	});
	test("multiple control chars escape independently", () => {
		expect(sanitizePathForProse("a\nb\rc\td.md")).toBe("a\\nb\\rc\\td.md");
	});
	test("C1 controls → \\xHH", () => {
		// 2-hex `\xHH` stays unambiguous through U+00FF.
		expect(sanitizePathForProse("a\u0085b.md")).toBe("a\\x85b.md"); // NEL
		expect(sanitizePathForProse("a\u009Fb.md")).toBe("a\\x9fb.md"); // APC
	});
	test("U+2028 LINE SEPARATOR → \\u2028 (line-forgery defense)", () => {
		// `\xHH` would emit `\x2028` (ambiguous — looks like `\x20` + "28");
		// the escape must widen to `\uHHHH` for codepoints > 0xFF.
		expect(sanitizePathForProse("foo\u2028next: forged.md")).toBe("foo\\u2028next: forged.md");
	});
	test("U+2029 PARAGRAPH SEPARATOR → \\u2029", () => {
		expect(sanitizePathForProse("foo\u2029bar.md")).toBe("foo\\u2029bar.md");
	});
});

describe("formatOutgoingTarget", () => {
	test("resolved file-only", () => {
		expect(
			formatOutgoingTarget({
				raw_target: "[[notes/setup.md]]",
				target_file: "notes/setup.md",
				resolved: true,
			}),
		).toBe("notes/setup.md");
	});
	test("resolved with heading path", () => {
		expect(
			formatOutgoingTarget({
				raw_target: "[[notes/auth.md#OAuth2]]",
				target_file: "notes/auth.md",
				target_heading_path: ["Auth", "OAuth2"],
				resolved: true,
			}),
		).toBe("notes/auth.md › Auth › OAuth2");
	});
	test("resolved with block id", () => {
		expect(
			formatOutgoingTarget({
				raw_target: "[[notes/refs.md#^abc]]",
				target_file: "notes/refs.md",
				target_block_id: "abc",
				resolved: true,
			}),
		).toBe("notes/refs.md ^abc");
	});
	test("resolved with block id on `›`-bearing file → guillemet-quoted file", () => {
		// `{file: "a › b.md", block: "c"}` and `{file: "a", heading_path:
		// ["b.md ^c"]}` would both render as `a › b.md ^c` without the
		// wrap — content-only clients can't recover which is which.
		expect(
			formatOutgoingTarget({
				raw_target: "[[a › b.md#^c]]",
				target_file: "a › b.md",
				target_block_id: "c",
				resolved: true,
			}),
		).toBe("«a › b.md» ^c");
	});
	test("resolved with hostile block id → escaped (line-forgery defense)", () => {
		// `parseTarget` (wikilinks.ts) does `fragment.slice(1).trim()` with no
		// `[a-zA-Z0-9_-]+` grammar enforcement; a hostile wikilink like
		// `[[t#^id\u0085forged]]` would otherwise render the NEL verbatim and
		// chat UIs would display a forged labeled line.
		const out = formatOutgoingTarget({
			raw_target: "[[notes/refs.md#^id\u0085forged]]",
			target_file: "notes/refs.md",
			target_block_id: "id\u0085forged",
			resolved: true,
		});
		expect(out).toBe("notes/refs.md ^id\\x85forged");
		expect(out).not.toContain("\u0085");
	});
	test("unresolved → labeled raw_target", () => {
		expect(
			formatOutgoingTarget({
				raw_target: "[[missing]]",
				resolved: false,
			}),
		).toBe("[[missing]]  (unresolved)");
	});
	test("unresolved ambiguous — inline candidate paths", () => {
		expect(
			formatOutgoingTarget({
				raw_target: "[[notes]]",
				resolved: false,
				candidates: [{ file: "a/notes.md" }, { file: "b/notes.md" }, { file: "c/notes.md" }],
			}),
		).toBe("[[notes]]  (ambiguous: a/notes.md, b/notes.md, c/notes.md)");
	});
	test("unresolved ambiguous — every candidate inlined (no truncation)", () => {
		// Earlier cap (3 + `+N more`) hid candidates from content-only
		// clients because `OutgoingLink` has no `target_stable_id`
		// fallback in the schema — the prose IS the only address channel.
		expect(
			formatOutgoingTarget({
				raw_target: "[[foo]]",
				resolved: false,
				candidates: [
					{ file: "a/foo.md" },
					{ file: "b/foo.md" },
					{ file: "c/foo.md" },
					{ file: "d/foo.md" },
					{ file: "e/foo.md" },
				],
			}),
		).toBe("[[foo]]  (ambiguous: a/foo.md, b/foo.md, c/foo.md, d/foo.md, e/foo.md)");
	});
	test("unresolved ambiguous — candidate heading_path inlined", () => {
		expect(
			formatOutgoingTarget({
				raw_target: "[[notes#Section]]",
				resolved: false,
				candidates: [
					{ file: "a/notes.md", heading_path: ["Section"] },
					{ file: "b/notes.md", heading_path: ["Section"] },
				],
			}),
		).toBe("[[notes#Section]]  (ambiguous: a/notes.md › Section, b/notes.md › Section)");
	});
	test("resolved with duplicate_heading — surfaces ambiguity + candidate heading paths", () => {
		// Real `resolveHeading` populates each candidate with the disambiguating
		// `heading_path`. Same-file duplicate-heading candidates would otherwise
		// render as `target.md, target.md` — useless to the agent.
		expect(
			formatOutgoingTarget({
				raw_target: "[[setup#OAuth2]]",
				target_file: "notes/setup.md",
				target_heading_path: ["Auth", "OAuth2"],
				resolved: true,
				duplicate_heading: true,
				candidates: [
					{ file: "notes/setup.md", heading_path: ["Auth", "OAuth2"] },
					{ file: "notes/setup.md", heading_path: ["Marketing", "OAuth2"] },
				],
			}),
		).toBe(
			"notes/setup.md › Auth › OAuth2  (ambiguous: 2 candidates: notes/setup.md › Auth › OAuth2, notes/setup.md › Marketing › OAuth2)",
		);
	});
	test("resolved with duplicate_heading and no candidate list — bare marker", () => {
		expect(
			formatOutgoingTarget({
				raw_target: "[[setup#OAuth2]]",
				target_file: "notes/setup.md",
				target_heading_path: ["Auth", "OAuth2"],
				resolved: true,
				duplicate_heading: true,
			}),
		).toBe("notes/setup.md › Auth › OAuth2  (duplicate heading)");
	});
	test("resolved + anchor-mismatch — surfaces the unresolved anchor", () => {
		expect(
			formatOutgoingTarget({
				raw_target: "notes/auth.md#Missing",
				target_file: "notes/auth.md",
				resolved: true,
			}),
		).toBe("notes/auth.md  (anchor not found in raw_target: #Missing)");
	});
	test("resolved + anchor-mismatch with intra-file `#`", () => {
		expect(
			formatOutgoingTarget({
				raw_target: "#StillMissing",
				target_file: "notes/self.md",
				resolved: true,
			}),
		).toBe("notes/self.md  (anchor not found in raw_target: #StillMissing)");
	});
	test("resolved + empty fragment (`note#`) → no anchor-not-found warning", () => {
		// `[[note#]]` / `[[note # ]]` collapse to `note#` via
		// `extractWikilinks`' `\s*#\s*` → `#` rule; `parseTarget` treats
		// the empty fragment as a file-only link. The warning would
		// misreport a structurally-resolved file as missing its anchor.
		expect(
			formatOutgoingTarget({
				raw_target: "notes/auth.md#",
				target_file: "notes/auth.md",
				resolved: true,
			}),
		).toBe("notes/auth.md");
	});
	test("comma-bearing candidate filename wraps inside the inline ambiguous list", () => {
		// Without the wrap, `formatCandidateList` joins with `", "` and
		// `a, b.md` collides with the separator — content-only clients
		// can't recover boundaries in the exact disambiguation moment
		// they need them.
		expect(
			formatOutgoingTarget({
				raw_target: "[[notes]]",
				resolved: false,
				candidates: [{ file: "a, b.md" }, { file: "c.md" }],
			}),
		).toBe("[[notes]]  (ambiguous: «a, b.md», c.md)");
	});
	test("comma-bearing heading segment in candidate wraps the candidate", () => {
		expect(
			formatOutgoingTarget({
				raw_target: "[[notes#Section]]",
				resolved: false,
				candidates: [
					{ file: "a/notes.md", heading_path: ["Auth, OAuth"] },
					{ file: "b/notes.md", heading_path: ["Section"] },
				],
			}),
		).toBe("[[notes#Section]]  (ambiguous: «a/notes.md › Auth, OAuth», b/notes.md › Section)");
	});
});

describe("formatIncomingSource", () => {
	test("file-level source", () => {
		expect(formatIncomingSource({ source_file: "docs/api.md" })).toBe("docs/api.md");
	});
	test("section-level source", () => {
		expect(formatIncomingSource({ source_file: "docs/api.md", source_heading_path: ["Endpoints", "Auth"] })).toBe(
			"docs/api.md › Endpoints › Auth",
		);
	});
	test("file-level source with `›`-bearing path → guillemet-quoted", () => {
		// Without the wrap, `{source_file: "a › b.md"}` collides with
		// `{source_file: "a", source_heading_path: ["b.md"]}` on bytes.
		expect(formatIncomingSource({ source_file: "a › b.md" })).toBe("«a › b.md»");
	});
});

describe("formatFileHeading", () => {
	test("common case — no quote, no escape", () => {
		expect(formatFileHeading("notes/auth.md", ["Auth", "OAuth2"])).toBe("notes/auth.md › Auth › OAuth2");
	});
	test("file contains ` › ` AND empty heading_path → still guillemet-quoted", () => {
		// `{file: "notes/foo › bar.md"}` and `{file: "notes/foo",
		// heading_path: ["bar.md"]}` both bottom out at the same bytes
		// without the wrap; the trailing block-id (` ^id`) or anchor
		// suffix in callers like `formatOutgoingTarget` widens the
		// ambiguity surface further. Single rule: wrap whenever file
		// contains the separator.
		expect(formatFileHeading("notes/foo › bar.md", [])).toBe("«notes/foo › bar.md»");
		expect(formatFileHeading("notes/foo › bar.md", undefined)).toBe("«notes/foo › bar.md»");
	});
	test("file contains ` › ` AND non-empty heading_path → guillemet-quoted", () => {
		// Without the quote, `{file: "notes/foo › bar.md", heading_path:
		// ["X"]}` and `{file: "notes/foo", heading_path: ["bar.md", "X"]}`
		// render identically; content-only clients can't tell where the
		// path ends.
		expect(formatFileHeading("notes/foo › bar.md", ["X"])).toBe("«notes/foo › bar.md» › X");
		expect(formatFileHeading("notes/setup.md › extra.md", ["Auth", "OAuth2"])).toBe(
			"«notes/setup.md › extra.md» › Auth › OAuth2",
		);
	});
	test("bare `›` (no space-adjacency) does NOT trigger the quote", () => {
		// The collision is on the literal ` › ` (space-aposh-space) sequence;
		// `foo›bar.md` doesn't contain it so no ambiguity arises.
		expect(formatFileHeading("notes/foo›bar.md", ["X"])).toBe("notes/foo›bar.md › X");
	});
	test("`, ` substring wraps in `«…»` (candidate-list fence)", () => {
		// `formatCandidateList` joins with `", "`; a filename or heading
		// containing the same substring would split into spurious extra
		// candidates without the wrap.
		expect(formatFileHeading("a, b.md")).toBe("«a, b.md»");
		expect(formatFileHeading("notes/auth.md", ["Auth, OAuth"])).toBe("«notes/auth.md › Auth, OAuth»");
	});
	test("bare `,` (no space-adjacency) does NOT trigger the wrap", () => {
		// `a,b.md` doesn't collide with the `", "` join — splitter still
		// recovers it cleanly. Wrap only fires on the exact substring.
		expect(formatFileHeading("a,b.md")).toBe("a,b.md");
	});
	test("no fence in output → no wrap (regression guard)", () => {
		expect(formatFileHeading("notes/auth.md")).toBe("notes/auth.md");
		expect(formatFileHeading("notes/auth.md", ["Section"])).toBe("notes/auth.md › Section");
	});
});

describe("joinLines", () => {
	test("omits only null and undefined; preserves empty strings as blank lines", () => {
		expect(joinLines(["a", null, "b", undefined, "", "c"])).toBe("a\nb\n\nc");
	});
	test("empty input → empty string", () => {
		expect(joinLines([])).toBe("");
	});
});
