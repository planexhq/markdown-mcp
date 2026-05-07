/**
 * Filter operator schema tests.
 *
 * `Filter.fields[name]` is a flat strict object containing all scalar/tag/date
 * operators. The handler does runtime disambiguation per D12 Note; mixed
 * categories surface as `FILTER_SYNTAX_ERROR` from the handler, NOT from the
 * schema. These tests pin (a) any combination of operators is accepted at the
 * schema layer, (b) unknown keys still reject.
 */

import { describe, expect, test } from "vitest";

import { GetFragmentSchema, GetMetadataSchema, SearchSchema } from "../src/schemas.js";

function parseFieldOps(input: unknown): unknown {
	return SearchSchema.parse({ query: "", filters: { fields: { name: input } } }).filters?.fields?.name;
}

describe("FieldOps schema (handler does runtime disambiguation)", () => {
	test("accepts tag-only input", () => {
		expect(parseFieldOps({ has: "alpha" })).toEqual({ has: "alpha" });
		expect(parseFieldOps({ has_any: ["a", "b"] })).toEqual({ has_any: ["a", "b"] });
		expect(parseFieldOps({ has_all: ["a", "b"] })).toEqual({ has_all: ["a", "b"] });
	});

	test("accepts date-only input", () => {
		expect(parseFieldOps({ gte: "2026-01-01" })).toEqual({ gte: "2026-01-01" });
		expect(parseFieldOps({ lte: "2026-12-31" })).toEqual({ lte: "2026-12-31" });
		expect(parseFieldOps({ gt: "2026-01-01", lt: "2026-12-31" })).toEqual({
			gt: "2026-01-01",
			lt: "2026-12-31",
		});
	});

	test("accepts numeric range bounds (scalar fields like `priority: 5`)", () => {
		// The compiler's disambiguator routes non-ISO `gte/lte/gt/lt` to the
		// scalar branch. The schema must let numbers through or the request
		// is rejected as InvalidParams before disambiguation runs.
		expect(parseFieldOps({ gte: 5 })).toEqual({ gte: 5 });
		expect(parseFieldOps({ lte: 10 })).toEqual({ lte: 10 });
		expect(parseFieldOps({ gt: 0, lt: 100 })).toEqual({ gt: 0, lt: 100 });
		expect(parseFieldOps({ gte: 1.5 })).toEqual({ gte: 1.5 });
	});

	test("accepts scalar-only input", () => {
		expect(parseFieldOps({ eq: 42 })).toEqual({ eq: 42 });
		expect(parseFieldOps({ in: ["x", "y"] })).toEqual({ in: ["x", "y"] });
		expect(parseFieldOps({ contains: "draft" })).toEqual({ contains: "draft" });
	});

	test("rejects unknown operator keys", () => {
		expect(() => parseFieldOps({ unknownOp: "x" })).toThrow();
	});

	test("accepts mixed-category inputs (handler surfaces FILTER_SYNTAX_ERROR)", () => {
		// Schema must stay permissive enough to let the handler emit the
		// documented `FILTER_SYNTAX_ERROR` domain envelope. Strict-mode
		// rejection at the schema layer would short-circuit that and return
		// a generic JSON-RPC error instead.
		expect(parseFieldOps({ has: "x", gte: "2026-01-01" })).toEqual({ has: "x", gte: "2026-01-01" });
	});

	test("accepts empty object (no constraint on this field)", () => {
		expect(parseFieldOps({})).toEqual({});
	});
});

describe("Top-level shape strict-mode (SDK boundary)", () => {
	test("rejects typo'd top-level key (e.g. `scpoe` for `scope`)", () => {
		expect(() => SearchSchema.parse({ query: "auth", scpoe: { path: "private" } })).toThrow();
	});
});

describe("SearchScope strict-mode", () => {
	test("rejects typo'd scope key (e.g. `pth` for `path`)", () => {
		expect(() => SearchSchema.parse({ query: "", scope: { pth: "notes" } })).toThrow();
	});
});

describe("Filter object strict-mode", () => {
	test("rejects typo'd top-level filter key", () => {
		expect(() => SearchSchema.parse({ query: "", filters: { tagz: { has: "api" } } })).toThrow();
	});

	test("rejects typo nested under and/or", () => {
		expect(() => SearchSchema.parse({ query: "", filters: { and: [{ tagz: { has: "x" } }] } })).toThrow();
	});

	test("accepts well-formed nested filters", () => {
		const out = SearchSchema.parse({
			query: "",
			filters: { and: [{ tags: { has: "api" } }, { date: { gte: "2026-01-01" } }] },
		});
		expect(out.filters?.and).toHaveLength(2);
	});

	test("top-level filter.date rejects numeric range bound", () => {
		// Top-level `filter.date` is the reserved-date COALESCE chain —
		// chronological only, so it stays string-only at the schema layer.
		// Numeric widening only applies to `fields[name]` ranges.
		expect(() => SearchSchema.parse({ query: "", filters: { date: { gte: 5 } } })).toThrow();
	});
});

describe("FilePath schema permissiveness", () => {
	test("accepts empty string", () => {
		expect(() => GetMetadataSchema.parse({ file: "" })).not.toThrow();
	});

	test("accepts path longer than MAX_PATH_LENGTH", () => {
		expect(() => GetMetadataSchema.parse({ file: "x".repeat(2000) })).not.toThrow();
	});
});

describe("ExpandEmbedsOption", () => {
	test("accepts true", () => {
		expect(() =>
			GetFragmentSchema.parse({ file: "x.md", anchor: { kind: "file" }, expand_embeds: true }),
		).not.toThrow();
	});

	test("accepts false (do not expand)", () => {
		expect(() =>
			GetFragmentSchema.parse({ file: "x.md", anchor: { kind: "file" }, expand_embeds: false }),
		).not.toThrow();
	});

	test("accepts max_depth above 10 (handler clamps)", () => {
		expect(() =>
			GetFragmentSchema.parse({
				file: "x.md",
				anchor: { kind: "file" },
				expand_embeds: { max_depth: 100 },
			}),
		).not.toThrow();
	});

	test("rejects typo'd `maxDepth` (object branch is strict)", () => {
		// Without strict mode, `maxDepth` would silently strip and the
		// request would fall through to default depth 10 instead of
		// surfacing InvalidParams.
		expect(() =>
			GetFragmentSchema.parse({
				file: "x.md",
				anchor: { kind: "file" },
				expand_embeds: { maxDepth: 5 },
			}),
		).toThrow();
	});
});

describe("Anchor strict-mode (nested unknown keys reject)", () => {
	// Without strict mode on each arm, `FileAnchor` would silently broaden
	// `{kind:"file", path:[...]}` to a whole-file read; the heading_path
	// and block arms would silently strip typo'd keys.
	test.each([
		{ label: "FileAnchor + spurious path", anchor: { kind: "file", path: ["A"] } },
		{ label: "HeadingPathAnchor + extra key", anchor: { kind: "heading_path", path: ["A"], extra: "x" } },
		{ label: "BlockAnchor + extra key", anchor: { kind: "block", id: "abc", extra: "x" } },
	])("rejects $label", ({ anchor }) => {
		expect(() => GetFragmentSchema.parse({ file: "x.md", anchor })).toThrow();
	});
});

describe("PageSize schema permissiveness (handler clamps at MAX_PAGE_SIZE)", () => {
	test("accepts pageSize above MAX_PAGE_SIZE (handler will silent-clamp)", () => {
		// Brief line 445 + D26: schema-layer reject would surface
		// InvalidParams instead of the documented silent-clamp behavior.
		expect(() => SearchSchema.parse({ query: "x", pageSize: 10000 })).not.toThrow();
	});

	test("rejects pageSize 0 (clearly invalid input, not 'too big')", () => {
		expect(() => SearchSchema.parse({ query: "x", pageSize: 0 })).toThrow();
	});

	test("rejects negative pageSize", () => {
		expect(() => SearchSchema.parse({ query: "x", pageSize: -1 })).toThrow();
	});
});

describe("Search query schema permissiveness", () => {
	test("accepts long query (handler emits INVALID_QUERY)", () => {
		expect(() => SearchSchema.parse({ query: "x".repeat(2000) })).not.toThrow();
	});

	test("accepts empty query (D23 filter-only mode)", () => {
		expect(() => SearchSchema.parse({ query: "" })).not.toThrow();
	});
});
