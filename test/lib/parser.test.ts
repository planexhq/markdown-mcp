/**
 * Parser edge-case tests — one row per Brief decision matrix line +
 * frontmatter parsing + AST node cap + structural_path + block-ID
 * extraction integration with the rest of the pipeline.
 *
 * Each test reads a fixture from `test/fixtures/vault/parser/` (created
 * to mirror the brief's matrix) and asserts the relevant invariant.
 * Fixtures are tiny so a failure points at one concept.
 */

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test, vi } from "vitest";

import { ParseError, parseFile } from "../../src/lib/parser.js";

const FIXTURES = fileURLToPath(new URL("../fixtures/vault/parser/", import.meta.url));

async function load(name: string): Promise<string> {
	return readFile(`${FIXTURES}${name}`, "utf-8");
}

describe("parser — heading edge cases (Brief decision matrix)", () => {
	test("# inside fenced code block is NOT parsed as a heading", async () => {
		const source = await load("code-fence-headings.md");
		const parsed = parseFile(source, "parser/code-fence-headings.md");
		const titles = parsed.headings.map((h) => h.pathText);
		expect(titles).toEqual(["Real Heading", "Another Real Heading"]);
	});

	test("setext H1/H2 parse identically to ATX", async () => {
		const source = await load("setext.md");
		const parsed = parseFile(source, "parser/setext.md");
		const levels = parsed.headings.map((h) => h.level);
		expect(levels).toEqual([1, 2]);
		expect(parsed.headings[0]?.pathText).toBe("Setext H1");
		expect(parsed.headings[1]?.pathText).toBe("Setext H2");
	});

	test("multiple H1s in one file are siblings under virtual root", async () => {
		const source = await load("multi-h1.md");
		const parsed = parseFile(source, "parser/multi-h1.md");
		// Top-level outline has two entries (the two H1s).
		expect(parsed.outline).toHaveLength(2);
		expect(parsed.outline[0]?.path).toBe("First H1");
		expect(parsed.outline[1]?.path).toBe("Second H1");
		// Each H1 has one H2 child; sibling-index is per-parent so both
		// produce structural_path `h1[N]/h2[1]` (different N).
		const firstChild = parsed.outline[0]?.children?.[0];
		const secondChild = parsed.outline[1]?.children?.[0];
		expect(firstChild?.path).toBe("Child of first H1");
		expect(secondChild?.path).toBe("Child of second H1");
		// stable_ids differ via D27 counterexample logic
		expect(firstChild?.stable_id).not.toBe(secondChild?.stable_id);
	});

	test("skipped levels: H1 → H3 makes H3's parent the H1", async () => {
		const source = await load("skipped-levels.md");
		const parsed = parseFile(source, "parser/skipped-levels.md");
		// Top-level outline: two H1s
		expect(parsed.outline).toHaveLength(2);
		const firstH1 = parsed.outline[0];
		expect(firstH1?.path).toBe("Top");
		// First H1 has the H3 as direct child (skipped H2).
		const firstChild = firstH1?.children?.[0];
		expect(firstChild?.path).toBe("Deep Child");
		expect(firstChild?.level).toBe(3);
		// H4 is grandchild via H3
		const grandchild = firstChild?.children?.[0];
		expect(grandchild?.path).toBe("Even deeper");
		expect(grandchild?.level).toBe(4);
	});

	test("inline formatting in heading: text preserves markers, path strips them", async () => {
		const source = await load("inline-formatting-heading.md");
		const parsed = parseFile(source, "parser/inline-formatting-heading.md");
		const first = parsed.headings[0];
		expect(first?.pathText).toBe("Bold with emphasis and code");
		expect(first?.displayText).toContain("**Bold**");
		expect(first?.displayText).toContain("`code`");
		// `displayText` MUST NOT include the leading `# ` ATX marker
		// (Brief decision matrix line 790, CommonMark §4.2).
		expect(first?.displayText.startsWith("#")).toBe(false);
		expect(first?.displayText).toBe("**Bold** with _emphasis_ and `code`");
	});

	test("ATX heading: displayText excludes # prefix and trailing ## markers", () => {
		const parsed = parseFile("# Hello **world**\n\nbody\n\n## Foo ##\n", "x.md");
		expect(parsed.headings[0]?.displayText).toBe("Hello **world**");
		expect(parsed.headings[1]?.displayText).toBe("Foo");
	});

	test("setext heading: displayText excludes the underline", () => {
		const parsed = parseFile("Setext H1\n=========\n\nbody\n", "x.md");
		expect(parsed.headings[0]?.displayText).toBe("Setext H1");
	});

	test("HTML in heading: path strips tags", async () => {
		const source = await load("html-heading.md");
		const parsed = parseFile(source, "parser/html-heading.md");
		const second = parsed.headings[1];
		expect(second?.pathText).toBe("HTML wrapped heading");
	});

	test("inline code with angle-bracket text in heading: path preserves the literal", async () => {
		// `<T>` inside inline code is NOT raw HTML — `mdastToString({includeHtml: false})`
		// gates only mdast `html` nodes; `inlineCode` keeps contributing its raw value.
		const source = await load("inline-code-heading.md");
		const parsed = parseFile(source, "parser/inline-code-heading.md");
		const second = parsed.headings[1];
		expect(second?.pathText).toBe("Use <T> for generics");
	});

	test("headings inside lists/blockquotes are EXCLUDED from outline", async () => {
		const source = await load("headings-in-list.md");
		const parsed = parseFile(source, "parser/headings-in-list.md");
		const titles = parsed.headings.map((h) => h.pathText);
		expect(titles).toEqual(["Real heading", "Another real heading"]);
	});

	test("ambiguous heading_path: two H1s with same text produce different stable_ids", async () => {
		const source = await load("ambiguous-headings.md");
		const parsed = parseFile(source, "parser/ambiguous-headings.md");
		expect(parsed.headings).toHaveLength(2);
		expect(parsed.headings[0]?.pathText).toBe("Auth");
		expect(parsed.headings[1]?.pathText).toBe("Auth");
		expect(parsed.headings[0]?.stable_id).not.toBe(parsed.headings[1]?.stable_id);
	});

	test("D27 counterexample: H2s under different H1s produce different stable_ids", async () => {
		const source = await load("d27-counterexample.md");
		const parsed = parseFile(source, "parser/d27-counterexample.md");
		const h2Children = parsed.headings.filter((h) => h.level === 2);
		expect(h2Children).toHaveLength(2);
		expect(h2Children[0]?.structuralPath).toBe("h1[1]/h2[1]");
		expect(h2Children[1]?.structuralPath).toBe("h1[2]/h2[1]");
		expect(h2Children[0]?.stable_id).not.toBe(h2Children[1]?.stable_id);
	});
});

describe("parser — frontmatter", () => {
	test("absent: hasFrontmatter false, frontmatter null", async () => {
		const parsed = parseFile("# Just a heading\n\nBody.\n", "no-fm.md");
		expect(parsed.hasFrontmatter).toBe(false);
		expect(parsed.frontmatter).toBeNull();
	});

	test("nested objects preserved (not flattened)", async () => {
		const source = await load("frontmatter-nested.md");
		const parsed = parseFile(source, "parser/frontmatter-nested.md");
		expect(parsed.hasFrontmatter).toBe(true);
		const md = parsed.frontmatter as Record<string, unknown>;
		const book = md["book"] as Record<string, unknown>;
		const author = book["author"] as Record<string, unknown>;
		expect(author["name"]).toBe("Jane Doe");
		expect(book["isbn"]).toBe("978-0-13-110362-7");
		expect(md["tags"]).toEqual(["api", "auth"]);
	});

	test("malformed YAML throws ParseError reason='syntax'", async () => {
		const source = await load("frontmatter-malformed.md");
		expect(() => parseFile(source, "parser/frontmatter-malformed.md")).toThrow(ParseError);
		try {
			parseFile(source, "parser/frontmatter-malformed.md");
		} catch (e) {
			expect(e).toBeInstanceOf(ParseError);
			if (e instanceof ParseError) {
				expect(e.reason).toBe("syntax");
			}
		}
	});

	test("frontmatter excluded from preamble — only via parsed.frontmatter", async () => {
		const source = "---\nfoo: 1\n---\n\nPreamble body.\n\n# Heading\n";
		const parsed = parseFile(source, "fm.md");
		expect(parsed.hasFrontmatter).toBe(true);
		expect(parsed.preamble).not.toBeNull();
		const preambleText = source.slice(parsed.preamble?.offsetRange.start ?? 0, parsed.preamble?.offsetRange.end ?? 0);
		expect(preambleText).not.toContain("foo: 1");
		expect(preambleText).toContain("Preamble body");
	});

	test("frontmatterEndOffset points just past the closing fence", () => {
		const source = "---\nfoo: 1\n---\nbody\n";
		const parsed = parseFile(source, "x.md");
		expect(parsed.frontmatterEndOffset).toBe(source.indexOf("body"));
		expect(source.slice(parsed.frontmatterEndOffset)).toBe("body\n");
	});

	test("frontmatterEndOffset is 0 when no frontmatter present", () => {
		const parsed = parseFile("# Hello\n\nbody\n", "x.md");
		expect(parsed.frontmatterEndOffset).toBe(0);
	});

	test("frontmatterEndOffset skips CRLF after closing fence (CRLF-authored notes)", () => {
		const source = "---\r\nfoo: 1\r\n---\r\nbody\r\n";
		const parsed = parseFile(source, "x.md");
		// Body must start cleanly at "body" — no stray leading "\r".
		expect(parsed.frontmatterEndOffset).toBe(source.indexOf("body"));
		expect(source.slice(parsed.frontmatterEndOffset)).toBe("body\r\n");
	});

	test("frontmatterEndOffset skips bare CR after closing fence (Mac-Classic-style notes)", () => {
		// Bare-CR EOL — micromark normalizes line endings to LF internally so
		// remark-frontmatter still recognizes the YAML block; the full parser
		// must advance past `\r` so the body slice doesn't begin with stray `\r`.
		const source = "---\rfoo: 1\r---\rbody\r";
		const parsed = parseFile(source, "x.md");
		expect(parsed.hasFrontmatter).toBe(true);
		expect(parsed.frontmatterEndOffset).toBe(source.indexOf("body"));
		expect(source.slice(parsed.frontmatterEndOffset)).toBe("body\r");
	});

	test("full and frontmatterOnly parsers agree on frontmatterEndOffset for bare-CR files", () => {
		// Cross-path consistency: regression guard for the
		// `consumeEol`-vs-inline-ladder divergence between the two extractors.
		const source = "---\rfoo: 1\r---\rbody\r";
		const full = parseFile(source, "x.md");
		const fast = parseFile(source, "x.md", { frontmatterOnly: true });
		expect(full.frontmatterEndOffset).toBe(fast.frontmatterEndOffset);
	});

	test("line counters reach EOF on bare-CR sources (heading range.end is not collapsed to 1)", () => {
		// Round 14 enabled bare-CR at the frontmatter layer; `countLines`
		// must agree so a heading's `range.end` reaches the body's last
		// line instead of collapsing to the heading's own line.
		const source = "# H\rbody line two\rbody line three\r";
		const parsed = parseFile(source, "bare-cr-lines.md");
		const heading = parsed.headings[0];
		expect(heading?.range.start).toBe(1);
		expect(heading?.range.end ?? 0).toBeGreaterThanOrEqual(3);
	});

	test("CRLF-authored note: preamble slice does not begin with stray \\r", () => {
		const source = "---\r\nfoo: 1\r\n---\r\nbody\r\n\r\n# H\r\n";
		const parsed = parseFile(source, "x.md");
		expect(parsed.preamble).not.toBeNull();
		const slice = source.slice(parsed.preamble?.offsetRange.start ?? 0, parsed.preamble?.offsetRange.end ?? 0);
		expect(slice.startsWith("\r")).toBe(false);
		expect(slice.startsWith("body")).toBe(true);
	});

	// Self-referential aliases produce circular structures (eemeli/yaml docs:
	// "Circular references are fully supported"); we route them as parse-time
	// syntax errors instead of letting JSON.stringify throw at envelope time.
	test.each([
		["seq", "---\na: &a [*a]\n---\n# H\n"],
		["map", "---\na: &a\n  b: *a\n---\n# H\n"],
	])("self-referential alias (%s) → ParseError reason='syntax'", (_, source) => {
		expect(() => parseFile(source, "x.md")).toThrow(ParseError);
		try {
			parseFile(source, "x.md");
		} catch (e) {
			if (e instanceof ParseError) expect(e.reason).toBe("syntax");
		}
	});

	test("non-circular alias still parses cleanly (regression)", () => {
		const source = "---\na: &x foo\nb: *x\n---\n# H\n";
		const parsed = parseFile(source, "x.md");
		expect(parsed.hasFrontmatter).toBe(true);
		const fm = parsed.frontmatter as Record<string, unknown>;
		expect(fm["a"]).toBe("foo");
		expect(fm["b"]).toBe("foo");
	});
});

describe("parser — github-style slug deduplication", () => {
	test("duplicate headings get -1, -2 suffixes (1-indexed)", () => {
		const parsed = parseFile("# Auth\n\nA.\n\n# Auth\n\nB.\n\n# Auth\n\nC.\n", "x.md");
		expect(parsed.headings.map((h) => h.slug)).toEqual(["auth", "auth-1", "auth-2"]);
	});

	test("only collisions get suffix; unrelated slugs are independent", () => {
		const parsed = parseFile("# Foo\n\n# Bar\n\n# Foo\n", "x.md");
		expect(parsed.headings.map((h) => h.slug)).toEqual(["foo", "bar", "foo-1"]);
	});

	test("literal-collision edge case: # A, # A-1, # A → a, a-1, a-2", () => {
		// The literal "A-1" pre-claims `a-1`; the second `A` must skip past it
		// to `a-2`. Matches github-slugger.
		const parsed = parseFile("# A\n\n# A-1\n\n# A\n", "x.md");
		expect(parsed.headings.map((h) => h.slug)).toEqual(["a", "a-1", "a-2"]);
	});

	test("outline.anchor reflects deduplicated slugs", () => {
		const parsed = parseFile("# Auth\n\n# Auth\n", "x.md");
		expect(parsed.outline[0]?.anchor).toBe("auth");
		expect(parsed.outline[1]?.anchor).toBe("auth-1");
	});

	test("preserves Unicode letters: # Café → café (no accent stripping)", () => {
		const parsed = parseFile("# Café\n\nbody.\n", "x.md");
		expect(parsed.headings[0]?.slug).toBe("café");
	});

	test("preserves CJK: # 日本語入門 → 日本語入門", () => {
		const parsed = parseFile("# 日本語入門\n\nbody.\n", "x.md");
		expect(parsed.headings[0]?.slug).toBe("日本語入門");
	});

	test("preserves diaeresis: # naïve → naïve", () => {
		const parsed = parseFile("# naïve\n", "x.md");
		expect(parsed.headings[0]?.slug).toBe("naïve");
	});

	test("punctuation still stripped: # Hello, World! → hello-world", () => {
		const parsed = parseFile("# Hello, World!\n", "x.md");
		expect(parsed.headings[0]?.slug).toBe("hello-world");
	});

	test("dedup still works on Unicode bases: two # Café → café, café-1", () => {
		const parsed = parseFile("# Café\n\n# Café\n", "x.md");
		expect(parsed.headings.map((h) => h.slug)).toEqual(["café", "café-1"]);
	});

	test("preserves underscores: # foo_bar → foo_bar (matches GitHub permalink)", () => {
		const parsed = parseFile("# foo_bar\n", "x.md");
		expect(parsed.headings[0]?.slug).toBe("foo_bar");
	});

	test("# foo_bar and # foobar do NOT collide (underscore preserved)", () => {
		const parsed = parseFile("# foo_bar\n\n# foobar\n", "x.md");
		expect(parsed.headings.map((h) => h.slug)).toEqual(["foo_bar", "foobar"]);
	});

	test("dedup still works on underscored bases: two # foo_bar → foo_bar, foo_bar-1", () => {
		const parsed = parseFile("# foo_bar\n\n# foo_bar\n", "x.md");
		expect(parsed.headings.map((h) => h.slug)).toEqual(["foo_bar", "foo_bar-1"]);
	});

	test("per-space replacement: # A   B → a---b (matches github-slugger v2)", () => {
		// Multiple spaces become multiple hyphens, NOT collapsed to one.
		// github-slugger@2.0.0 uses /\u0020/g, not /\s+/g — verified empirically.
		const parsed = parseFile("# A   B\n", "x.md");
		expect(parsed.headings[0]?.slug).toBe("a---b");
	});

	test("single-space replacement still works: # A B C → a-b-c", () => {
		const parsed = parseFile("# A B C\n", "x.md");
		expect(parsed.headings[0]?.slug).toBe("a-b-c");
	});

	test("tab between words → single hyphen (`\\s`-aware replacement)", () => {
		// `\t` matches `\s` and is preserved by SLUG_STRIP_RE; the per-`\s`
		// hyphenate step turns each whitespace char into `-`. The earlier `/ /g`
		// only handled U+0020 and let raw tabs leak into the slug.
		const parsed = parseFile("# A\tB\n", "x.md");
		expect(parsed.headings[0]?.slug).toBe("a-b");
	});

	test("mixed tabs and spaces preserve per-char hyphen count", () => {
		const parsed = parseFile("# A B\tC  D\n", "x.md");
		expect(parsed.headings[0]?.slug).toBe("a-b-c--d");
	});
});

describe("parser — empty heading body has bodyTokensApprox: 0", () => {
	test("`# H\\n\\n## Child\\n` reports 0 tokens for H's empty body (no phantom token)", () => {
		const parsed = parseFile("# H\n\n## Child\n\nbody.\n", "x.md");
		expect(parsed.headings[0]?.bodyTokensApprox).toBe(0);
	});
});

describe("parser — VAULT_TOKENIZER fail-loud", () => {
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	test("unsupported VAULT_TOKENIZER throws on parse (no silent heuristic fallback)", () => {
		// Brief 807-815 mandates the configured tokenizer be honored. W2 ships
		// only the heuristic; setting an unsupported id surfaces an error rather
		// than silently producing wrong-but-confident token counts.
		vi.stubEnv("VAULT_TOKENIZER", "tiktoken/o200k_base");
		expect(() => parseFile("# H\n\nbody\n", "x.md")).toThrow(/not yet supported/);
	});
});

describe("parser — frontmatterOnly option", () => {
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	test("returns frontmatter and skips outline / token / block work", () => {
		const source = "---\ntitle: t\n---\n# Heading\n\nbody.\n\n^block-one\n";
		const parsed = parseFile(source, "x.md", { frontmatterOnly: true });
		expect(parsed.hasFrontmatter).toBe(true);
		expect(parsed.frontmatter).toEqual({ title: "t" });
		expect(parsed.headings).toEqual([]);
		expect(parsed.outline).toEqual([]);
		expect(parsed.blocks).toEqual([]);
		expect(parsed.blockIndex).toEqual({});
		expect(parsed.preamble).toBeNull();
	});

	test("succeeds when VAULT_TOKENIZER is unsupported (no body tokenization runs)", () => {
		vi.stubEnv("VAULT_TOKENIZER", "tiktoken/o200k_base");
		const parsed = parseFile("---\ntitle: t\n---\n# H\n\nbody.\n", "x.md", { frontmatterOnly: true });
		expect(parsed.frontmatter).toEqual({ title: "t" });
		expect(parsed.hasFrontmatter).toBe(true);
	});

	test("frontmatter-absent file: hasFrontmatter false, frontmatter null, no throws", () => {
		const parsed = parseFile("# H\n\nbody.\n", "x.md", { frontmatterOnly: true });
		expect(parsed.hasFrontmatter).toBe(false);
		expect(parsed.frontmatter).toBeNull();
		expect(parsed.headings).toEqual([]);
	});

	test("frontmatterOnly skips remark-parse: huge body does not trip ast_node_cap_exceeded", () => {
		// 60K paragraphs > the 50K AST cap. With frontmatterOnly: true the parse
		// never runs, so the cap never trips and the metadata read still succeeds.
		const body = "p\n\n".repeat(60_000);
		const source = `---\ntitle: t\n---\n${body}`;
		const parsed = parseFile(source, "x.md", { frontmatterOnly: true });
		expect(parsed.frontmatter).toEqual({ title: "t" });
		expect(parsed.hasFrontmatter).toBe(true);
	});

	test.each([
		{ name: "plain LF", source: "---\nkey: v\n---\nbody.\n" },
		{ name: "CRLF", source: "---\r\nkey: v\r\n---\r\nbody.\r\n" },
		{ name: "trailing whitespace on fences", source: "---  \nkey: v\n---\t\nbody.\n" },
		{ name: "fence at EOF (no body)", source: "---\nkey: v\n---" },
		{ name: "frontmatter-only file (no trailing newline)", source: "---\ntitle: only\n---\n" },
		{ name: "no opening fence", source: "# H\n\nbody.\n" },
		{ name: "opening fence without closing", source: "---\nkey: v\nbody.\n" },
		{ name: "opening with trailing content (`--- foo`)", source: "--- foo\nkey: v\n---\n" },
	])("frontmatter parity: $name (frontmatterOnly vs full parse)", ({ source }) => {
		// The fast path (direct fence scan) and the slow path (remark-frontmatter)
		// must agree on hasFrontmatter, frontmatter, and frontmatterEndOffset.
		const fast = parseFile(source, "x.md", { frontmatterOnly: true });
		const full = parseFile(source, "x.md");
		expect(fast.hasFrontmatter).toBe(full.hasFrontmatter);
		expect(fast.frontmatter).toEqual(full.frontmatter);
		expect(fast.frontmatterEndOffset).toBe(full.frontmatterEndOffset);
	});
});

describe("parser — block IDs", () => {
	test("inline + deferred forms both extracted; first-match-wins on duplicates", async () => {
		const source = await load("block-ids.md");
		const parsed = parseFile(source, "parser/block-ids.md");
		const ids = parsed.blocks.map((b) => b.id);
		expect(ids).toContain("inline-block");
		expect(ids).toContain("deferred-block");
		expect(ids).toContain("list-item-block");
		expect(ids).toContain("second-section-block");
		// ^should-not-be-extracted-from-code-block must NOT appear
		expect(ids).not.toContain("should-not-be-extracted-from-code-block");
		expect(ids).not.toContain("also-not-extracted-inline-code");
	});

	test("blockIndex first-match-wins for duplicates", async () => {
		const source = await load("duplicate-block-ids.md");
		const parsed = parseFile(source, "parser/duplicate-block-ids.md");
		const dupeEntry = parsed.blockIndex["dupe"];
		expect(dupeEntry).toBeDefined();
		// First occurrence is in the first section under "First section"
		expect(dupeEntry?.heading_path).toEqual(["First section"]);
		// Multiple matches surfaced in `blocks` list (caller can audit)
		const allDupes = parsed.blocks.filter((b) => b.id === "dupe");
		expect(allDupes.length).toBeGreaterThanOrEqual(2);
	});

	test("duplicate ^id is attached only to the first heading's blockIds (Brief line 90)", async () => {
		// First-match-wins applies to `blockIndex` AND each heading's
		// `outline.blockIds` — otherwise the outline advertises a marker
		// that `get_fragment` resolves to a different section's content.
		const source = await load("duplicate-block-ids.md");
		const parsed = parseFile(source, "parser/duplicate-block-ids.md");
		const first = parsed.headings.find((h) => h.displayText === "First section");
		const second = parsed.headings.find((h) => h.displayText === "Second section");
		expect(first?.blockIds).toContain("dupe");
		expect(second?.blockIds ?? []).not.toContain("dupe");
	});

	test("duplicate ^id with preamble first-occurrence is NOT advertised under later heading", () => {
		// First-match-wins must apply across preamble→heading drift, not just
		// cross-section drift. `blockIndex` resolves to the preamble; the
		// heading's `blockIds` must NOT advertise `dupe` either.
		const source = "Preamble paragraph. ^dupe\n\n# Section\n\nIn-section paragraph. ^dupe\n";
		const parsed = parseFile(source, "preamble-dupe.md");
		expect(parsed.blockIndex.dupe?.heading_path).toEqual([]);
		const section = parsed.headings.find((h) => h.displayText === "Section");
		expect(section?.blockIds ?? []).not.toContain("dupe");
	});

	test("block IDs map to containing heading", async () => {
		const source = await load("block-ids.md");
		const parsed = parseFile(source, "parser/block-ids.md");
		const inline = parsed.blocks.find((b) => b.id === "inline-block");
		expect(inline?.containingHeadingPath).toEqual(["Block IDs"]);
		const second = parsed.blocks.find((b) => b.id === "second-section-block");
		expect(second?.containingHeadingPath).toEqual(["Section two"]);
	});

	test("blockIndex stores IDs whose names shadow Object.prototype keys", () => {
		// `^constructor`, `^toString`, `^hasOwnProperty` are valid block-ID grammar
		// (`^[a-zA-Z0-9-]+`). The original `m.id in blockIndex` check would walk
		// the prototype chain and falsely report them as already-present, dropping
		// the first occurrence from the index.
		const source = "# H\n\nP. ^constructor\n\nQ. ^toString\n\nR. ^hasOwnProperty\n";
		const parsed = parseFile(source, "x.md");
		expect(Object.hasOwn(parsed.blockIndex, "constructor")).toBe(true);
		expect(Object.hasOwn(parsed.blockIndex, "toString")).toBe(true);
		expect(Object.hasOwn(parsed.blockIndex, "hasOwnProperty")).toBe(true);
		expect(parsed.blockIndex["constructor"]?.heading_path).toEqual(["H"]);
		expect(parsed.blockIndex["toString"]?.heading_path).toEqual(["H"]);
		expect(parsed.blockIndex["hasOwnProperty"]?.heading_path).toEqual(["H"]);
	});

	test("first-match-wins still applies for prototype-key block IDs", () => {
		const source = "# First\n\nP. ^constructor\n\n# Second\n\nQ. ^constructor\n";
		const parsed = parseFile(source, "x.md");
		// First occurrence is under `First`, not `Second`.
		expect(parsed.blockIndex["constructor"]?.heading_path).toEqual(["First"]);
		// Both occurrences still listed in `blocks`.
		const all = parsed.blocks.filter((b) => b.id === "constructor");
		expect(all.length).toBe(2);
	});

	test("listItem with nested sub-list: ^id at end of parent's text resolves", async () => {
		// mdast's listItem range covers the whole sub-tree, so `^p` would be
		// wrongly invalidated if the trailing-only check used `offsetEnd` instead
		// of the listItem's text edge (end of last non-list child).
		const source = await load("nested-list-block-ids.md");
		const parsed = parseFile(source, "parser/nested-list-block-ids.md");
		expect(parsed.blockIndex.p).toBeDefined();
		expect(parsed.blockIndex.s).toBeDefined();
		expect(parsed.blockIndex.i).toBeDefined();
	});
});

describe("parser — math contentKind", () => {
	test("inline math ($x$) emits contentKinds=['math']", () => {
		const parsed = parseFile("# H\n\nThe equation $E = mc^2$ is famous.\n", "x.md");
		expect(parsed.headings[0]?.contentKinds).toContain("math");
	});

	test("display math ($$...$$) emits contentKinds=['math']", () => {
		const parsed = parseFile("# H\n\nDisplay:\n\n$$\n\\int_0^1 x\\,dx\n$$\n", "x.md");
		expect(parsed.headings[0]?.contentKinds).toContain("math");
	});

	test("section without math omits math from contentKinds", () => {
		const parsed = parseFile("# H\n\nNo equations here.\n", "x.md");
		expect(parsed.headings[0]?.contentKinds).not.toContain("math");
	});

	test("mixed math + code emits both contentKinds", () => {
		const parsed = parseFile("# H\n\n$x$\n\n```\nfn();\n```\n", "x.md");
		expect(parsed.headings[0]?.contentKinds).toContain("math");
		expect(parsed.headings[0]?.contentKinds).toContain("code");
	});
});

describe("parser — AST node cap", () => {
	// Exercise the cap via a low test override on a small input. The
	// production-cap value (50 000) is enforced identically; testing it
	// against a real 50K+ corpus would needlessly slow the suite.
	test("ast_node_cap_exceeded fires when nodeCount > cap", () => {
		const source = "# A\n\n## B\n\n### C\n";
		expect(() => parseFile(source, "x.md", { maxAstNodes: 1 })).toThrow(ParseError);
		try {
			parseFile(source, "x.md", { maxAstNodes: 1 });
		} catch (e) {
			if (e instanceof ParseError) expect(e.reason).toBe("ast_node_cap_exceeded");
		}
	});

	test("ast_node_cap_exceeded message names the actual node count and cap", () => {
		try {
			parseFile("# A\n\n## B\n\n### C\n", "x.md", { maxAstNodes: 2 });
			throw new Error("expected ParseError");
		} catch (e) {
			if (e instanceof ParseError) {
				expect(e.message).toMatch(/AST nodes.*cap/);
			}
		}
	});

	test("does not throw under cap", () => {
		expect(() => parseFile("# A\n", "x.md", { maxAstNodes: 100 })).not.toThrow();
	});
});

describe("parser — outline structure", () => {
	test("no headings + body: outline empty, preamble spans entire body", () => {
		const source = "Just body text.\n";
		const parsed = parseFile(source, "x.md");
		expect(parsed.outline).toHaveLength(0);
		expect(parsed.headings).toHaveLength(0);
		expect(parsed.preamble).not.toBeNull();
		expect(parsed.preamble?.offsetRange.start).toBe(0);
		expect(parsed.preamble?.offsetRange.end).toBe(source.length);
	});

	test("no headings + frontmatter + body: preamble skips frontmatter", () => {
		const source = "---\nfoo: 1\n---\n\nbody only.\n";
		const parsed = parseFile(source, "x.md");
		expect(parsed.headings).toHaveLength(0);
		expect(parsed.preamble).not.toBeNull();
		const text = source.slice(parsed.preamble?.offsetRange.start ?? 0, parsed.preamble?.offsetRange.end ?? 0);
		expect(text).not.toContain("foo: 1");
		expect(text).toContain("body only.");
	});

	test("no headings, no body: preamble null", () => {
		const parsed = parseFile("", "x.md");
		expect(parsed.preamble).toBeNull();
	});

	test("frontmatter only, whitespace body: preamble null", () => {
		const parsed = parseFile("---\nfoo: 1\n---\n\n   \n", "x.md");
		expect(parsed.preamble).toBeNull();
	});

	test("subheadings count is direct children, not all descendants", () => {
		const parsed = parseFile("# A\n\n## B\n\n### C\n\n## D\n", "x.md");
		const a = parsed.outline[0];
		expect(a?.subheadings).toBe(2); // B and D, not C
		const b = a?.children?.[0];
		expect(b?.subheadings).toBe(1); // just C
	});

	test("descendantTokensApprox is bottom-up sum", () => {
		const parsed = parseFile("# A\n\n## B\n\nbody of B.\n\n## D\n\nbody of D.\n", "x.md");
		const a = parsed.outline[0];
		const b = a?.children?.[0];
		const d = a?.children?.[1];
		expect(a?.descendantTokensApprox).toBeGreaterThanOrEqual(
			(b?.descendantTokensApprox ?? 0) + (d?.descendantTokensApprox ?? 0),
		);
	});
});

describe("parser — content kinds", () => {
	test("image inside top-level paragraph → contentKinds includes 'image'", () => {
		const parsed = parseFile("# Section\n\n![alt](pic.png)\n", "x.md");
		expect(parsed.headings[0]?.contentKinds).toContain("image");
	});

	test("image inside text paragraph → contentKinds includes 'image'", () => {
		const parsed = parseFile("# Section\n\nIntro text with ![alt](pic.png) embedded.\n", "x.md");
		expect(parsed.headings[0]?.contentKinds).toContain("image");
	});

	test("code block inside blockquote → contentKinds includes 'code'", () => {
		const parsed = parseFile("# Section\n\n> ```\n> code\n> ```\n", "x.md");
		expect(parsed.headings[0]?.contentKinds).toContain("code");
	});

	test("Obsidian callout still detected via blockquote scan", () => {
		const parsed = parseFile("# Section\n\n> [!note]\n> Body of callout.\n", "x.md");
		expect(parsed.headings[0]?.contentKinds).toContain("callout");
	});
});
