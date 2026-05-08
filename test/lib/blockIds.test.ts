/**
 * Block-ID extractor tests.
 *
 * Coverage: inline form, deferred form (lone-line), excluded ranges
 * (code blocks / inline code), first-match-wins on duplicates,
 * underscore rejection per Brief line 833.
 */

import { describe, expect, test } from "vitest";

import {
	type BlockableNodeRange,
	type ExcludedRange,
	extractBlockIds,
	stripBlockIdMarker,
} from "../../src/lib/blockIds.js";

function makeBlock(source: string, marker: string): BlockableNodeRange {
	const start = source.indexOf(marker);
	if (start < 0) throw new Error(`marker '${marker}' not found in source`);
	const end = start + marker.length;
	return {
		offsetStart: start,
		offsetEnd: end,
		trailingEdgeOffset: end,
		lineStart: 1 + countNewlines(source.slice(0, start)),
		lineEnd: 1 + countNewlines(source.slice(0, end)),
		inBlockquote: false,
	};
}

function countNewlines(text: string): number {
	let n = 0;
	for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
	return n;
}

describe("extractBlockIds", () => {
	test("inline form: text content ^my-id at end of paragraph", () => {
		const source = "First paragraph. ^alpha\n\nSecond paragraph.\n";
		const blocks = [makeBlock(source, "First paragraph. ^alpha"), makeBlock(source, "Second paragraph.")];
		const matches = extractBlockIds(source, blocks, []);
		expect(matches).toHaveLength(1);
		expect(matches[0]?.id).toBe("alpha");
	});

	test("deferred form: ^id alone on a line attributes to PREVIOUS block", () => {
		const source = "First paragraph.\n\n^beta\n\nSecond paragraph.\n";
		const firstBlock = makeBlock(source, "First paragraph.");
		const idBlock = makeBlock(source, "^beta");
		const secondBlock = makeBlock(source, "Second paragraph.");
		const matches = extractBlockIds(source, [firstBlock, idBlock, secondBlock], []);
		expect(matches).toHaveLength(1);
		expect(matches[0]?.id).toBe("beta");
		expect(matches[0]?.block.offsetStart).toBe(firstBlock.offsetStart);
	});

	test("excluded ranges suppress matches inside code blocks", () => {
		const source = "```\n^should-not-match\n```\n";
		// The fence content is a single block (the parser tracks it as a `code` node).
		const excluded: ExcludedRange = { offsetStart: 0, offsetEnd: source.length };
		const matches = extractBlockIds(source, [], [excluded]);
		expect(matches).toHaveLength(0);
	});

	test("rejects underscores per Brief line 833 (Obsidian-canonical)", () => {
		const source = "text ^foo_bar\n";
		const block = makeBlock(source, "text ^foo_bar");
		const matches = extractBlockIds(source, [block], []);
		expect(matches).toHaveLength(0);
	});

	test("accepts hyphens", () => {
		const source = "text ^foo-bar\n";
		const block = makeBlock(source, "text ^foo-bar");
		const matches = extractBlockIds(source, [block], []);
		expect(matches).toHaveLength(1);
		expect(matches[0]?.id).toBe("foo-bar");
	});

	test("multiple ids in one file are returned in source order", () => {
		const source = "p1 ^a\n\np2 ^b\n\np3 ^c\n";
		const blocks = [makeBlock(source, "p1 ^a"), makeBlock(source, "p2 ^b"), makeBlock(source, "p3 ^c")];
		const matches = extractBlockIds(source, blocks, []);
		expect(matches.map((m) => m.id)).toEqual(["a", "b", "c"]);
	});

	test("duplicate ids: returns BOTH occurrences (caller dedupes for blockIndex)", () => {
		const source = "p1 ^dupe\n\np2 ^dupe\n";
		const blocks = [makeBlock(source, "p1 ^dupe"), makeBlock(source, "p2 ^dupe")];
		const matches = extractBlockIds(source, blocks, []);
		expect(matches).toHaveLength(2);
		expect(matches.every((m) => m.id === "dupe")).toBe(true);
	});

	test("no blockable nodes → no matches", () => {
		const source = "^orphan\n";
		const matches = extractBlockIds(source, [], []);
		expect(matches).toHaveLength(0);
	});

	test("trailing-only: mid-paragraph ^id is rejected", () => {
		const source = "Use ^alpha as notation here.\n";
		const block = makeBlock(source, "Use ^alpha as notation here.");
		const matches = extractBlockIds(source, [block], []);
		expect(matches).toHaveLength(0);
	});

	test("trailing-only: ^id followed by trailing whitespace is accepted", () => {
		const source = "End of paragraph here ^valid-id  \n";
		const block = makeBlock(source, "End of paragraph here ^valid-id");
		const matches = extractBlockIds(source, [block], []);
		expect(matches).toHaveLength(1);
		expect(matches[0]?.id).toBe("valid-id");
	});

	test("trailing-only: ^id at start of paragraph (mid-paragraph) is rejected", () => {
		const source = "^lone-id at start of paragraph still has trailing text.\n";
		const block = makeBlock(source, "^lone-id at start of paragraph still has trailing text.");
		const matches = extractBlockIds(source, [block], []);
		expect(matches).toHaveLength(0);
	});

	test("trailing-only: deferred form (lone-line) still works", () => {
		const source = "First paragraph.\n\n^deferred-id\n\nSecond paragraph.\n";
		const firstBlock = makeBlock(source, "First paragraph.");
		const idBlock = makeBlock(source, "^deferred-id");
		const secondBlock = makeBlock(source, "Second paragraph.");
		const matches = extractBlockIds(source, [firstBlock, idBlock, secondBlock], []);
		expect(matches).toHaveLength(1);
		expect(matches[0]?.id).toBe("deferred-id");
		expect(matches[0]?.block.offsetStart).toBe(firstBlock.offsetStart);
	});

	test("orphan: lone ^id at note start (no preceding block) is rejected", () => {
		const source = "^orphan\n\nSome paragraph.\n";
		const idBlock = makeBlock(source, "^orphan");
		const para = makeBlock(source, "Some paragraph.");
		const matches = extractBlockIds(source, [idBlock, para], []);
		expect(matches).toHaveLength(0);
	});

	test("orphan: lone ^id with no prior blockable (e.g. after a heading) is rejected", () => {
		// Heading text is NOT in `blockableNodes` — only paragraph/listItem are.
		// So the lone-^id paragraph is the first (and only) blockable.
		const source = "# Heading\n\n^orphan-after-heading\n";
		const idBlock = makeBlock(source, "^orphan-after-heading");
		const matches = extractBlockIds(source, [idBlock], []);
		expect(matches).toHaveLength(0);
	});

	test("orphan: lone ^id separated from prior paragraph by a non-whitespace gap is rejected", () => {
		// The "code" sits between the paragraph and the lone-^id paragraph.
		// The code node isn't blockable, so the gap between para.offsetEnd and
		// the lone-^id paragraph contains non-whitespace — orphan.
		const source = "Para before fence.\n\n```\ncode\n```\n\n^after-fence\n";
		const para = makeBlock(source, "Para before fence.");
		const idBlock = makeBlock(source, "^after-fence");
		const matches = extractBlockIds(source, [para, idBlock], []);
		expect(matches).toHaveLength(0);
	});
});

describe("stripBlockIdMarker", () => {
	test("strips inline marker at end of paragraph", () => {
		expect(stripBlockIdMarker("body text ^foo", "foo")).toBe("body text");
	});

	test("strips deferred-form marker on its own line", () => {
		expect(stripBlockIdMarker("body line\n^foo", "foo")).toBe("body line");
	});

	test("returns trimEnd when no marker present", () => {
		expect(stripBlockIdMarker("body text\n", "missing")).toBe("body text");
	});

	test("does NOT match `^2` in `Value x^2` (no preceding whitespace)", () => {
		expect(stripBlockIdMarker("Value x^2", "2")).toBe("Value x^2");
	});

	test("strips the LAST occurrence when content has multiple matches", () => {
		// Embed expansion can splice content with the SAME blockId text
		// at end-of-line into the parent slice. The actual marker is
		// always at the end of the original block, so post-expansion the
		// last match is the one to strip — first-match would corrupt the
		// embedded text and leave the real marker.
		const raw = "see ^foo\nmiddle text\nactual block end ^foo";
		expect(stripBlockIdMarker(raw, "foo")).toBe("see ^foo\nmiddle text\nactual block end");
	});
});
