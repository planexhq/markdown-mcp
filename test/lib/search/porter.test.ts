/**
 * Smoke tests for the hand-rolled Porter stemmer. Parity with FTS5's
 * `porter` tokenizer is approximate; these tests pin the canonical
 * cases that the snippet algorithm depends on.
 */

import { describe, expect, test } from "vitest";

import { porterStem } from "../../../src/lib/search/porter.js";

describe("porterStem — canonical pairs", () => {
	const PAIRS: Array<[string, string]> = [
		["running", "run"],
		["runs", "run"],
		["runner", "runner"],
		["authentication", "authent"],
		["authenticated", "authent"],
		["authentic", "authent"],
		["multitenant", "multiten"],
		["caresses", "caress"],
		["ponies", "poni"],
		["caress", "caress"],
		["cats", "cat"],
		["agreed", "agre"],
		["plastered", "plaster"],
		["sized", "size"],
		["meeting", "meet"],
		["bled", "bled"],
		["happy", "happi"],
		["sky", "sky"],
	];

	test.each(PAIRS)("stem(%s) → %s", (input, expected) => {
		expect(porterStem(input)).toBe(expected);
	});
});

describe("porterStem — degenerate inputs", () => {
	test("empty string returns empty", () => {
		expect(porterStem("")).toBe("");
	});

	test("very short word returns lowercased input", () => {
		expect(porterStem("a")).toBe("a");
		expect(porterStem("AT")).toBe("at");
	});
});
