/**
 * D32 confidence-gating tests for `stable-id-fuzzy-v1`.
 *
 * The reorder-without-rename counter-example is the load-bearing case:
 * lookup of stale_id_old_B must return Beta (text identity) rather
 * than Alpha (now occupying B's old structural slot).
 *
 * Rename-and-reorder (text_match empty) must return primary=null with
 * structural neighbors as candidates — the agent gets a HEADING_NOT_FOUND
 * with hints, not a confidently-wrong recovery.
 */

import { describe, expect, test } from "vitest";

import { FUZZY_ALGORITHM_ID, type HeadingHistoryRow, recoverStaleStableId } from "../../src/lib/fuzzy.js";
import type { HeadingMeta } from "../../src/lib/parser.js";

function makeHeading(args: {
	stable_id?: string;
	pathText: string;
	structuralPath: string;
	headingPath?: string[];
}): HeadingMeta {
	return {
		stable_id: args.stable_id ?? `h:${args.structuralPath.replace(/[^a-z0-9]/gi, "")}`.padEnd(16, "0").slice(0, 16),
		structuralPath: args.structuralPath,
		level: 2,
		pathText: args.pathText,
		displayText: args.pathText,
		slug: args.pathText.toLowerCase().replace(/\s+/g, "-"),
		headingPath: args.headingPath ?? [args.pathText],
		range: { start: 1, end: 1 },
		selectionRange: { start: 1, end: 1 },
		offsetRange: { start: 0, end: 0 },
		headingLineOffset: { start: 0, end: 0 },
		bodyOffsetRange: { start: 0, end: 0 },
		bodyTokensApprox: 0,
		descendantTokensApprox: 0,
		subheadings: 0,
		contentKinds: [],
		blockIds: [],
	};
}

function makeHistory(args: {
	last_heading_text: string;
	last_structural_path: string;
	stable_id?: string;
}): HeadingHistoryRow {
	return {
		file: "test.md",
		stable_id: args.stable_id ?? "h:00000000000000",
		last_heading_text: args.last_heading_text,
		last_heading_path_json: JSON.stringify([args.last_heading_text]),
		last_structural_path: args.last_structural_path,
		last_range_start: 0,
		last_range_end: 0,
		last_seen_mtime: 1000,
		retired_at_mtime: 2000,
	};
}

describe("recoverStaleStableId — rename-only", () => {
	test("text matches exact slot → primary recovered with high score", () => {
		const history = makeHistory({ last_heading_text: "Old Name", last_structural_path: "h2[1]" });
		const headings = [makeHeading({ pathText: "Old Name", structuralPath: "h2[1]" })];
		const result = recoverStaleStableId({ history, currentHeadings: headings });
		expect(result.primary).not.toBeNull();
		expect(result.primary?.heading.pathText).toBe("Old Name");
		expect(result.primary?.score).toBeGreaterThan(1.5);
	});
});

describe("recoverStaleStableId — reorder-without-rename counter-example", () => {
	test("lookup of stale_id_B returns Beta (text identity), NOT Alpha at B's old slot", () => {
		// Original: Page/[Alpha at h2[1], Beta at h2[2]]
		// After reorder: Page/[Beta at h2[1], Alpha at h2[2]]
		// History row was for Beta (text=Beta, struct=h2[2]).
		const history = makeHistory({ last_heading_text: "Beta", last_structural_path: "h2[2]" });
		const headings = [
			makeHeading({ pathText: "Beta", structuralPath: "h2[1]" }), // text matches; slot moved
			makeHeading({ pathText: "Alpha", structuralPath: "h2[2]" }), // slot matches; text differs
		];
		const result = recoverStaleStableId({ history, currentHeadings: headings });
		expect(result.primary).not.toBeNull();
		// Confidence-gating: primary MUST come from text_match (a sibling
		// reorder must NOT silently surface the heading now occupying the
		// old slot as the recovered target).
		expect(result.primary?.heading.pathText).toBe("Beta");
	});
});

describe("recoverStaleStableId — rename-and-reorder (text_match empty)", () => {
	test("text_match empty → primary=null + top-3 structural neighbors", () => {
		// History row was for "Old Beta" at h2[2]. After edits, Old Beta
		// is gone (renamed AND reordered), so text identity is unrecoverable.
		const history = makeHistory({ last_heading_text: "Old Beta", last_structural_path: "h2[2]" });
		const headings = [
			makeHeading({ pathText: "Some Other Heading", structuralPath: "h2[1]" }),
			makeHeading({ pathText: "Yet Another", structuralPath: "h2[2]" }),
			makeHeading({ pathText: "Third One", structuralPath: "h2[3]" }),
		];
		const result = recoverStaleStableId({ history, currentHeadings: headings });
		expect(result.primary).toBeNull();
		// Up to 3 structural-proximity neighbors. They all share h2[N] depth
		// so common-prefix ratio ranks them; we only assert the slot count.
		expect(result.others.length).toBeGreaterThan(0);
		expect(result.others.length).toBeLessThanOrEqual(3);
	});
});

describe("recoverStaleStableId — empty inputs", () => {
	test("no current headings → primary=null, others=[]", () => {
		const history = makeHistory({ last_heading_text: "Anything", last_structural_path: "h2[1]" });
		const result = recoverStaleStableId({ history, currentHeadings: [] });
		expect(result.primary).toBeNull();
		expect(result.others).toEqual([]);
	});
});

describe("recoverStaleStableId — multiple text matches", () => {
	test("highest-scoring text-match wins as primary; others returns remaining text-match candidates", () => {
		// Two headings with identical text under different parents — the
		// one whose structural path matches history wins.
		const history = makeHistory({ last_heading_text: "Notes", last_structural_path: "h1[1]/h2[1]" });
		const headings = [
			makeHeading({ pathText: "Notes", structuralPath: "h1[2]/h2[1]" }),
			makeHeading({ pathText: "Notes", structuralPath: "h1[1]/h2[1]" }),
			makeHeading({ pathText: "Other", structuralPath: "h1[3]/h2[1]" }),
		];
		const result = recoverStaleStableId({ history, currentHeadings: headings });
		expect(result.primary).not.toBeNull();
		expect(result.primary?.heading.structuralPath).toBe("h1[1]/h2[1]");
		// `others` should include the other "Notes" heading.
		const otherTexts = result.others.map((c) => c.heading.pathText);
		expect(otherTexts).toContain("Notes");
	});
});

describe("FUZZY_ALGORITHM_ID", () => {
	test("constant matches the published algorithm id", () => {
		expect(FUZZY_ALGORITHM_ID).toBe("stable-id-fuzzy-v1");
	});
});
