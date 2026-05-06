/**
 * `isHiddenPath` predicate — any dot-prefixed segment makes the path hidden.
 * Mirrors the brief's "policy-excluded by default" surface (Brief line 928).
 */

import { describe, expect, test } from "vitest";

import { isHiddenPath } from "../../src/lib/hiddenPath.js";

describe("isHiddenPath", () => {
	test("dot-prefixed top-level directory → hidden", () => {
		expect(isHiddenPath(".obsidian/config.md")).toBe(true);
		expect(isHiddenPath(".git/HEAD.md")).toBe(true);
	});

	test("dot-prefixed file in normal directory → hidden", () => {
		expect(isHiddenPath("notes/.private.md")).toBe(true);
	});

	test("any dot-prefixed segment counts (deeply nested)", () => {
		expect(isHiddenPath(".foo/bar/baz.md")).toBe(true);
		expect(isHiddenPath("foo/.bar/baz.md")).toBe(true);
		expect(isHiddenPath("foo/bar/.baz.md")).toBe(true);
	});

	test("non-hidden paths → false", () => {
		expect(isHiddenPath("notes/foo.md")).toBe(false);
		expect(isHiddenPath("foo.md")).toBe(false);
		expect(isHiddenPath("a/b/c/d.md")).toBe(false);
	});

	test("dots inside a segment (not at the start) → not hidden", () => {
		// `topic.v1` is a normal directory name with a dot in the middle —
		// not the same as a leading-dot hidden marker.
		expect(isHiddenPath("topic.v1/note.md")).toBe(false);
		expect(isHiddenPath("notes/v1.0.md")).toBe(false);
	});
});
