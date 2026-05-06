/**
 * D27 structural_path + stable_id contract tests.
 *
 * The D27 counterexample is the load-bearing test: under the pre-D27
 * `occurrence_index_at_level` formula, two H2s under different H1 parents
 * collided. The test pins that the new full-ancestor-chain formula
 * produces distinct hashes for those two headings.
 */

import { describe, expect, test } from "vitest";

import { buildStructuralPath, stableId } from "../../src/lib/structuralPath.js";

describe("buildStructuralPath", () => {
	test("emits h{level}[index]/... for nested chains", () => {
		expect(
			buildStructuralPath([
				{ level: 1, siblingIndex: 1 },
				{ level: 2, siblingIndex: 1 },
				{ level: 3, siblingIndex: 2 },
			]),
		).toBe("h1[1]/h2[1]/h3[2]");
	});

	test("single-segment chain (top-level heading)", () => {
		expect(buildStructuralPath([{ level: 1, siblingIndex: 1 }])).toBe("h1[1]");
	});

	test("empty ancestor chain → empty string", () => {
		expect(buildStructuralPath([])).toBe("");
	});
});

describe("stableId", () => {
	test("produces 'h:' + 14 hex chars (D20)", () => {
		const id = stableId("notes/auth.md", "h1[1]");
		expect(id).toMatch(/^h:[0-9a-f]{14}$/);
	});

	test("D27 counterexample: two H2s under different H1s produce DIFFERENT stable_ids", () => {
		// Pre-D27 formula: both `h2[1]` (occurrence-index 1 at level 2 within file).
		// D27 formula: full ancestor chain disambiguates.
		const path1 = buildStructuralPath([
			{ level: 1, siblingIndex: 1 },
			{ level: 2, siblingIndex: 1 },
		]);
		const path2 = buildStructuralPath([
			{ level: 1, siblingIndex: 2 },
			{ level: 2, siblingIndex: 1 },
		]);
		expect(path1).not.toBe(path2); // structural paths differ by construction
		const id1 = stableId("page.md", path1);
		const id2 = stableId("page.md", path2);
		expect(id1).not.toBe(id2); // therefore hashes differ
	});

	test("same input → same id (deterministic)", () => {
		const a = stableId("page.md", "h1[1]/h2[1]");
		const b = stableId("page.md", "h1[1]/h2[1]");
		expect(a).toBe(b);
	});

	test("different relpath → different id (relpath enters the hash)", () => {
		const a = stableId("page-a.md", "h1[1]");
		const b = stableId("page-b.md", "h1[1]");
		expect(a).not.toBe(b);
	});

	test("rename-only stability: text doesn't enter the hash, so renaming is invisible", () => {
		// The hash input is `relpath + ":" + structural_path`. structural_path
		// has no text. Renaming a heading produces the SAME stable_id.
		const before = stableId("page.md", "h1[1]/h2[1]");
		const after = stableId("page.md", "h1[1]/h2[1]");
		expect(before).toBe(after);
	});
});
