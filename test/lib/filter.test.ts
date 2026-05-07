/**
 * Filter compiler tests. Covers:
 *   - SQL injection probe (charset regex bites before SQL ever runs)
 *   - Tag prefix-match SQL (D30 Note 3c, ESCAPE '\')
 *   - Dotted-path JSON1 access (literal-dot escape)
 *   - Mixed-category rejection (D12 Note)
 *   - Filter-hash determinism (key reorder same; array reorder different)
 */

import { describe, expect, test } from "vitest";

import {
	compileFilter,
	ensureUtcOffset,
	FilterSyntaxError,
	hashFilter,
	normalizeDateBound,
	parseDottedPath,
	renderJsonPath,
} from "../../src/lib/filter.js";
import type { Filter } from "../../src/types.js";

describe("compileFilter — SQL injection probe", () => {
	test("malicious tag literal rejected at charset regex (never reaches SQL)", () => {
		const filter: Filter = { tags: { has: "x'; DROP TABLE fragments; --" } };
		expect(() => compileFilter(filter)).toThrowError(FilterSyntaxError);
	});

	test("dotted-path with control byte rejected", () => {
		const filter: Filter = { fields: { "a\u0001b": { eq: "x" } } };
		expect(() => compileFilter(filter)).toThrowError(FilterSyntaxError);
	});
});

describe("compileFilter — tag prefix SQL", () => {
	test("simple tag emits exact + LIKE prefix with ESCAPE '\\'", () => {
		const filter: Filter = { tags: { has: "api" } };
		const out = compileFilter(filter);
		expect(out).not.toBeNull();
		expect(out?.whereSql).toContain("ft.tag = :p0");
		expect(out?.whereSql).toContain("ft.tag LIKE :p1 ESCAPE '\\'");
		expect(out?.params.p0).toBe("api");
		expect(out?.params.p1).toBe("api/%");
	});

	test("tag with underscore escapes for LIKE", () => {
		const filter: Filter = { tags: { has: "api_v1" } };
		const out = compileFilter(filter);
		expect(out).not.toBeNull();
		// Lowercased + LIKE-escaped: `_` doubles to `\_` so the prefix
		// can't match `apixv1` (a single-char LIKE wildcard).
		expect(out?.params.p1).toBe("api\\_v1/%");
	});

	test("has_any compiles to OR group of tag clauses", () => {
		const filter: Filter = { tags: { has_any: ["api", "auth"] } };
		const out = compileFilter(filter);
		expect(out?.whereSql).toMatch(/EXISTS.*OR.*EXISTS/s);
	});

	test("empty has_any → vacuously false", () => {
		const filter: Filter = { tags: { has_any: [] } };
		const out = compileFilter(filter);
		expect(out?.whereSql).toContain("(1=0)");
	});
});

describe("compileFilter — fields[tag] scalar/array dispatch", () => {
	// json_each rejects scalar input ("malformed JSON"). The compiler
	// dispatches on json_type so YAML scalars (`aliases: foo`) and
	// arrays (`aliases: [foo, bar]`) both round-trip without crashing.

	test("has emits CASE json_type wrap with json_array fallback", () => {
		const filter: Filter = { fields: { aliases: { has: "foo" } } };
		const out = compileFilter(filter);
		expect(out).not.toBeNull();
		// Two-arg `json_type(JSON, PATH)` form — direct on column, not
		// on json_extract output (which would re-crash on scalar text).
		expect(out?.whereSql).toContain("CASE json_type(fm.fields_json, '$.\"aliases\"')");
		expect(out?.whereSql).toContain("WHEN 'array' THEN json_extract(fm.fields_json, '$.\"aliases\"')");
		expect(out?.whereSql).toContain("WHEN 'object' THEN json_array()");
		expect(out?.whereSql).toContain("WHEN 'null' THEN json_array()");
		expect(out?.whereSql).toContain("ELSE json_array(json_extract(fm.fields_json, '$.\"aliases\"'))");
		expect(out?.params.p0).toBe("foo");
	});

	test("has_any emits CASE wrap per branch", () => {
		const filter: Filter = { fields: { aliases: { has_any: ["foo", "bar"] } } };
		const out = compileFilter(filter);
		expect(out).not.toBeNull();
		// Two predicates joined by OR, each carrying its own CASE wrap.
		const matches = out?.whereSql.match(/CASE json_type/g) ?? [];
		expect(matches.length).toBe(2);
	});

	test("has_all emits CASE wrap per branch", () => {
		const filter: Filter = { fields: { aliases: { has_all: ["foo", "bar"] } } };
		const out = compileFilter(filter);
		expect(out).not.toBeNull();
		const matches = out?.whereSql.match(/CASE json_type/g) ?? [];
		expect(matches.length).toBe(2);
	});
});

describe("compileFilter — reserved date COALESCE chain", () => {
	test("date.gte uses COALESCE with iso_calendar_valid UDF + updated/created/mtime ISO", () => {
		const filter: Filter = { date: { gte: "2024-01-01" } };
		const out = compileFilter(filter);
		// `iso_calendar_valid(json_extract(...))` UDF gates the chain so raw
		// frontmatter values that don't pass calendar validation (per brief
		// line 593) fall through to updated/created/mtime instead of being
		// lex-compared as bogus dates.
		expect(out?.whereSql).toContain("iso_calendar_valid(json_extract(fm.fields_json, '$.\"date\"'))");
		expect(out?.whereSql).toContain("fm.updated");
		expect(out?.whereSql).toContain("fm.created");
		expect(out?.whereSql).toContain("strftime('%Y-%m-%dT%H:%M:%SZ', f.mtime/1000, 'unixepoch')");
		// Date-only `gte` normalizes to start-of-day so lex-compare matches
		// the scanner's stored `2024-01-01T00:00:00Z` form.
		expect(out?.params.p0).toBe("2024-01-01T00:00:00Z");
	});
});

describe("compileFilter — date-only bound normalization (op-aware)", () => {
	test("gte → T00:00:00Z (start of day, inclusive)", () => {
		const out = compileFilter({ date: { gte: "2024-06-01" } });
		expect(out?.params.p0).toBe("2024-06-01T00:00:00Z");
	});

	test("lt → T00:00:00Z (start of day, exclusive)", () => {
		const out = compileFilter({ date: { lt: "2024-06-01" } });
		expect(out?.params.p0).toBe("2024-06-01T00:00:00Z");
	});

	test("lte → T23:59:59Z (end of day, inclusive)", () => {
		const out = compileFilter({ date: { lte: "2024-06-01" } });
		expect(out?.params.p0).toBe("2024-06-01T23:59:59Z");
	});

	test("gt → T23:59:59Z (end of day, exclusive)", () => {
		const out = compileFilter({ date: { gt: "2024-06-01" } });
		expect(out?.params.p0).toBe("2024-06-01T23:59:59Z");
	});

	test("full ISO datetime canonicalizes to UTC without millis", () => {
		const out = compileFilter({ date: { gte: "2024-06-01T10:00:00.500Z" } });
		expect(out?.params.p0).toBe("2024-06-01T10:00:00Z");
	});

	test("invalid date string → FilterSyntaxError", () => {
		expect(() => compileFilter({ date: { lte: "garbage" } })).toThrowError(FilterSyntaxError);
	});

	test("date-typed fields[name] follows same op-aware semantics", () => {
		const out = compileFilter({ fields: { created: { lte: "2024-06-01" } } });
		expect(out?.params.p0).toBe("2024-06-01T23:59:59Z");
	});

	test("non-ISO scalar gte (e.g. priority: '5') stays unchanged via scalar disambiguator", () => {
		// `gte: "5"` doesn't match ISO_LIKELY_RE, so disambiguator routes to
		// the scalar branch; date normalization MUST NOT touch it.
		const out = compileFilter({ fields: { priority: { gte: "5" } } });
		expect(out?.params.p0).toBe("5");
	});
});

describe("ensureUtcOffset — host-TZ neutralization", () => {
	test("appends Z to timezone-less datetime", () => {
		expect(ensureUtcOffset("2024-06-01T10:00:00")).toBe("2024-06-01T10:00:00Z");
	});

	test("appends Z to space-separator datetime", () => {
		expect(ensureUtcOffset("2024-06-01 10:00:00")).toBe("2024-06-01 10:00:00Z");
	});

	test("preserves explicit Z", () => {
		expect(ensureUtcOffset("2024-06-01T10:00:00Z")).toBe("2024-06-01T10:00:00Z");
	});

	test("preserves explicit numeric offset", () => {
		expect(ensureUtcOffset("2024-06-01T10:00:00+05:30")).toBe("2024-06-01T10:00:00+05:30");
	});

	test("preserves negative offset", () => {
		expect(ensureUtcOffset("2024-06-01T10:00:00-04:00")).toBe("2024-06-01T10:00:00-04:00");
	});

	test("preserves compact offset (no colon)", () => {
		expect(ensureUtcOffset("2024-06-01T10:00:00+0530")).toBe("2024-06-01T10:00:00+0530");
	});
});

describe("normalizeDateBound — timezone handling", () => {
	test("explicit Z round-trips identically", () => {
		expect(normalizeDateBound("2024-06-01T10:00:00Z", "gte")).toBe("2024-06-01T10:00:00Z");
	});

	test("explicit +05:30 offset canonicalizes to UTC", () => {
		expect(normalizeDateBound("2024-06-01T10:00:00+05:30", "gte")).toBe("2024-06-01T04:30:00Z");
	});

	test("explicit -04:00 offset canonicalizes to UTC", () => {
		expect(normalizeDateBound("2024-06-01T10:00:00-04:00", "gte")).toBe("2024-06-01T14:00:00Z");
	});

	test("trailing millis stripped on canonical emit", () => {
		expect(normalizeDateBound("2024-06-01T10:00:00.500Z", "gte")).toBe("2024-06-01T10:00:00Z");
	});

	test("invalid datetime returns null", () => {
		expect(normalizeDateBound("not-a-date", "gte")).toBeNull();
	});
});

describe("normalizeDateBound — calendar + ISO-shape validation", () => {
	test.each([
		["2024-02-30", "Feb 30 (date-only)"],
		["2024-13-01", "month 13 (date-only)"],
		["2024-01-32", "day 32 (date-only)"],
		["2024-02-30T00:00:00Z", "Feb 30 (datetime form)"],
		["1", "non-ISO single digit '1' (Date.parse leniency)"],
		["now", "non-ISO 'now'"],
	])("%s rejected — %s", (input) => {
		expect(normalizeDateBound(input, "gte")).toBeNull();
	});

	test("clean date-only still works (regression guard)", () => {
		expect(normalizeDateBound("2024-06-01", "gte")).toBe("2024-06-01T00:00:00Z");
		expect(normalizeDateBound("2024-06-01", "lte")).toBe("2024-06-01T23:59:59Z");
	});

	test("clean ISO datetime still works (regression guard)", () => {
		expect(normalizeDateBound("2024-06-01T12:34:56Z", "gte")).toBe("2024-06-01T12:34:56Z");
	});

	test("compileFilter wires rejection to FILTER_SYNTAX_ERROR", () => {
		expect(() => compileFilter({ date: { gte: "2024-02-30" } })).toThrowError(FilterSyntaxError);
		expect(() => compileFilter({ date: { gte: "1" } })).toThrowError(FilterSyntaxError);
	});
});

describe("compileFilter — dotted-path access", () => {
	test("parseDottedPath splits on un-escaped `.`", () => {
		expect(parseDottedPath("book.author.name", "fields")).toEqual(["book", "author", "name"]);
	});

	test("literal-dot via \\\\. preserves the dot inside one segment", () => {
		expect(parseDottedPath("v1\\.0\\.0", "fields")).toEqual(["v1.0.0"]);
	});

	test("rejects empty segment", () => {
		expect(() => parseDottedPath("a..b", "fields")).toThrowError(FilterSyntaxError);
	});

	test('renderJsonPath emits `$."a"."b"` shape', () => {
		expect(renderJsonPath(["book", "author"])).toBe('$."book"."author"');
	});

	test("nested fields[name] compiles to json_extract", () => {
		const filter: Filter = { fields: { "book.author.name": { eq: "Jane" } } };
		const out = compileFilter(filter);
		expect(out?.whereSql).toContain('json_extract(fm.fields_json, \'$."book"."author"."name"\')');
		expect(out?.params.p0).toBe("Jane");
	});
});

describe("compileFilter — mixed-category rejection", () => {
	test("tag-op + scalar-op on same field → FilterSyntaxError", () => {
		const filter: Filter = { fields: { mixed: { has: "x", eq: "y" } } };
		expect(() => compileFilter(filter)).toThrowError(FilterSyntaxError);
	});

	test("tag-op + ISO-date-op on same field → FilterSyntaxError", () => {
		const filter: Filter = { fields: { mixed: { has: "x", gte: "2024-01-01" } } };
		expect(() => compileFilter(filter)).toThrowError(FilterSyntaxError);
	});

	test("non-ISO gte values are scalar comparisons (not date)", () => {
		// Numeric range like a `priority` field — no ISO content, no
		// COALESCE chain, just plain `>=` against the json_extract.
		const filter: Filter = { fields: { priority: { gte: "5" } } };
		expect(() => compileFilter(filter)).not.toThrow();
	});
});

describe("compileFilter — and/or/not", () => {
	test("and: [] → vacuously TRUE", () => {
		const out = compileFilter({ and: [] });
		expect(out).toBeNull(); // empty filter → null
	});

	test("top-level or: [] → compiles to (1=0)", () => {
		const out = compileFilter({ or: [] });
		expect(out).not.toBeNull();
		expect(out?.whereSql).toBe("(1=0)");
	});

	test("top-level or: [] AND tags: → (1=0) AND tag predicate", () => {
		const out = compileFilter({ or: [], tags: { has: "api" } });
		expect(out).not.toBeNull();
		expect(out?.whereSql).toMatch(/\(1=0\)/);
		expect(out?.whereSql).toMatch(/frontmatter_tags/);
	});

	test("top-level not: { or: [] } → NOT (1=0)", () => {
		const out = compileFilter({ not: { or: [] } });
		expect(out).not.toBeNull();
		expect(out?.whereSql).toMatch(/^NOT \(/);
		expect(out?.whereSql).toMatch(/\(1=0\)/);
	});

	test("top-level not: { and: [] } → NOT ((1=1))", () => {
		const out = compileFilter({ not: { and: [] } });
		expect(out).not.toBeNull();
		expect(out?.whereSql).toMatch(/^NOT \(/);
		expect(out?.whereSql).toMatch(/\(1=1\)/);
	});

	test("top-level not: {} → NOT ((1=1))", () => {
		const out = compileFilter({ not: {} });
		expect(out).not.toBeNull();
		expect(out?.whereSql).toMatch(/^NOT \(/);
		expect(out?.whereSql).toMatch(/\(1=1\)/);
	});

	test("double-NOT { not: { not: { or: [] } } } → NOT (NOT ((1=0)))", () => {
		const out = compileFilter({ not: { not: { or: [] } } });
		expect(out).not.toBeNull();
		expect(out?.whereSql).toMatch(/^NOT \(NOT \(/);
		expect(out?.whereSql).toMatch(/\(1=0\)/);
	});

	test("nested and: [{ or: [] }] still → (1=0)", () => {
		const out = compileFilter({ and: [{ or: [] }] });
		expect(out).not.toBeNull();
		expect(out?.whereSql).toMatch(/\(1=0\)/);
	});

	test("not wraps inner expr", () => {
		const out = compileFilter({ not: { tags: { has: "api" } } });
		expect(out?.whereSql).toMatch(/^NOT \(/);
	});
});

describe("hashFilter — determinism", () => {
	test("key reorder yields same hash", () => {
		const a: Filter = { tags: { has: "api" }, date: { gte: "2024-01-01" } };
		const b: Filter = { date: { gte: "2024-01-01" }, tags: { has: "api" } };
		expect(hashFilter(a)).toBe(hashFilter(b));
	});

	test("array reorder yields different hash", () => {
		const a: Filter = { and: [{ tags: { has: "api" } }, { tags: { has: "auth" } }] };
		const b: Filter = { and: [{ tags: { has: "auth" } }, { tags: { has: "api" } }] };
		expect(hashFilter(a)).not.toBe(hashFilter(b));
	});

	test("empty/null filter hashes to empty string", () => {
		expect(hashFilter(undefined)).toBe("");
		expect(hashFilter(null)).toBe("");
		expect(hashFilter({})).toBe("");
	});

	test("non-empty filter hashes to 40-char hex", () => {
		const h = hashFilter({ tags: { has: "api" } });
		expect(h).toMatch(/^[0-9a-f]{40}$/);
	});
});

describe("compileFilter — empty handling", () => {
	test("undefined → null", () => {
		expect(compileFilter(undefined)).toBeNull();
	});

	test("empty object → null", () => {
		expect(compileFilter({})).toBeNull();
	});
});

describe("compileFilter — null scalar comparisons", () => {
	test("eq: null compiles to IS NULL (not = NULL)", () => {
		const out = compileFilter({ fields: { x: { eq: null } } });
		expect(out).not.toBeNull();
		expect(out?.whereSql).toMatch(/IS NULL/);
		expect(out?.whereSql).not.toMatch(/=\s*:p/);
	});

	test("ne: null compiles to IS NOT NULL", () => {
		const out = compileFilter({ fields: { x: { ne: null } } });
		expect(out).not.toBeNull();
		expect(out?.whereSql).toMatch(/IS NOT NULL/);
	});

	test("eq: 'value' (non-null) still compiles to = with bound parameter", () => {
		const out = compileFilter({ fields: { x: { eq: "value" } } });
		expect(out?.whereSql).toMatch(/=\s*:p/);
		expect(Object.values(out?.params ?? {})).toContain("value");
	});
});

describe("compileFilter — non-ISO range ops on custom fields", () => {
	test("numeric gte routes to scalar path with bound param (not vacuous TRUE)", () => {
		const out = compileFilter({ fields: { priority: { gte: 5 } } });
		expect(out).not.toBeNull();
		expect(out?.whereSql).not.toBe("(1=1)");
		expect(out?.whereSql).toMatch(/>=\s*:p/);
		expect(Object.values(out?.params ?? {})).toContain(5);
	});

	test("string-numeric gte (non-ISO) compiles to >= bound param", () => {
		const out = compileFilter({ fields: { priority: { gte: "5" } } });
		expect(out?.whereSql).toMatch(/>=\s*:p/);
		expect(Object.values(out?.params ?? {})).toContain("5");
	});

	test("ISO-string gte still routes to date branch (chain expr)", () => {
		const out = compileFilter({ fields: { created: { gte: "2024-06-01T00:00:00Z" } } });
		expect(out?.whereSql).toMatch(/>=\s*:p/);
		// Date branch uses json_extract on the field expression (not the
		// reserved COALESCE chain — that's only the top-level `date` filter).
		expect(out?.whereSql).toMatch(/json_extract/);
	});

	test("mixed eq + gte on a single scalar field both apply", () => {
		const out = compileFilter({ fields: { priority: { gte: 1, eq: 5 } } });
		expect(out?.whereSql).toMatch(/>=/);
		expect(out?.whereSql).toMatch(/=\s*:p/);
	});
});

describe("compileFilter — typed-comparison guards on custom fields (round 20)", () => {
	// Without these guards SQLite's heterogeneous storage-class lex order
	// (TEXT > INTEGER) lets stringy frontmatter values satisfy numeric
	// ranges, and raw frontmatter date typos lex-pass canonical ISO bounds.

	test("custom date range wraps json_extract with iso_calendar_valid UDF", () => {
		const out = compileFilter({ fields: { due: { gte: "2024-01-01" } } });
		expect(out?.whereSql).toContain("iso_calendar_valid(json_extract(fm.fields_json, '$.\"due\"'))");
		expect(out?.params.p0).toBe("2024-01-01T00:00:00Z");
	});

	test("numeric range gates with json_type IN ('integer','real')", () => {
		const out = compileFilter({ fields: { priority: { gte: 5 } } });
		expect(out?.whereSql).toContain("json_type(fm.fields_json, '$.\"priority\"') IN ('integer','real')");
		expect(out?.whereSql).toMatch(/>=\s*:p/);
		expect(Object.values(out?.params ?? {})).toContain(5);
	});

	test("string-operand range stays unguarded (text-vs-text byte order)", () => {
		const out = compileFilter({ fields: { version: { gte: "v1" } } });
		expect(out?.whereSql).not.toContain("json_type");
		expect(out?.whereSql).toMatch(/>=\s*:p/);
	});

	test("mixed eq + gte: guard fires only for the numeric range, not eq", () => {
		const out = compileFilter({ fields: { priority: { gte: 1, eq: 5 } } });
		// eq compiles to bare `expr = :p` — no type guard (storage-class
		// equality is strict, false positives don't happen for `=`).
		expect(out?.whereSql).toMatch(/json_extract\(fm\.fields_json, '\$\."priority"'\) = :p/);
		// gte gets the guard.
		const guardCount = (
			out?.whereSql.match(/json_type\(fm\.fields_json, '\$\."priority"'\) IN \('integer','real'\)/g) ?? []
		).length;
		expect(guardCount).toBe(1);
	});

	test("dotted-path numeric range guards on the deepest segment", () => {
		const out = compileFilter({ fields: { "meta.score": { gte: 5 } } });
		expect(out?.whereSql).toContain("json_type(fm.fields_json, '$.\"meta\".\"score\"') IN ('integer','real')");
	});
});

describe("compileFilter — null in in/nin lists (three-valued logic)", () => {
	// SQL `expr = NULL` is always UNKNOWN, so binding `null` directly into
	// IN/NOT IN matches nothing for `in` and excludes every row for `nin` —
	// opposite of intent. The compiler partitions `null` out and emits
	// `IS NULL` / `IS NOT NULL` clauses instead.

	test("in: [null] compiles to expr IS NULL with no bound params", () => {
		const out = compileFilter({ fields: { x: { in: [null] } } });
		expect(out).not.toBeNull();
		expect(out?.whereSql).toMatch(/IS NULL\)?$/);
		expect(out?.whereSql).not.toMatch(/IN \(/);
		expect(Object.keys(out?.params ?? {})).toHaveLength(0);
	});

	test("nin: [null] compiles to expr IS NOT NULL with no bound params", () => {
		const out = compileFilter({ fields: { x: { nin: [null] } } });
		expect(out).not.toBeNull();
		expect(out?.whereSql).toMatch(/IS NOT NULL\)?$/);
		expect(out?.whereSql).not.toMatch(/NOT IN \(/);
		expect(Object.keys(out?.params ?? {})).toHaveLength(0);
	});

	test("in: ['a', null] compiles to (expr IS NULL OR expr IN (:p0))", () => {
		const out = compileFilter({ fields: { x: { in: ["a", null] } } });
		expect(out).not.toBeNull();
		expect(out?.whereSql).toMatch(/IS NULL OR.*IN \(:p0\)/);
		expect(out?.params.p0).toBe("a");
	});

	test("nin: ['a', null] compiles to (expr IS NOT NULL AND expr NOT IN (:p0))", () => {
		const out = compileFilter({ fields: { x: { nin: ["a", null] } } });
		expect(out).not.toBeNull();
		expect(out?.whereSql).toMatch(/IS NOT NULL AND.*NOT IN \(:p0\)/);
		expect(out?.params.p0).toBe("a");
	});

	test("in: ['a', 'b'] (no null) keeps existing form: expr IN (:p0, :p1)", () => {
		const out = compileFilter({ fields: { x: { in: ["a", "b"] } } });
		expect(out?.whereSql).toMatch(/IN \(:p0, :p1\)/);
		expect(out?.whereSql).not.toMatch(/IS NULL/);
		expect(out?.params.p0).toBe("a");
		expect(out?.params.p1).toBe("b");
	});

	test("nin: ['a', 'b'] (no null) keeps existing form: (expr IS NULL OR expr NOT IN (:p0, :p1))", () => {
		// Asymmetry: absence of `null` in the list preserves NULL rows in
		// the result, matching SQL's intuition that `expr NOT IN ('a')`
		// passes through NULLs without explicit handling.
		const out = compileFilter({ fields: { x: { nin: ["a", "b"] } } });
		expect(out?.whereSql).toMatch(/IS NULL OR.*NOT IN \(:p0, :p1\)/);
		expect(out?.params.p0).toBe("a");
		expect(out?.params.p1).toBe("b");
	});
});

describe("compileFilter — ISO-likely scalar operand canonicalization", () => {
	test("eq: '2024-06-01' canonicalizes to '2024-06-01T00:00:00Z'", () => {
		// Mirrors scanner-side normalization so frontmatter `due: 2024-06-01`
		// (stored canonical) lex-matches the agent's date-only filter.
		const out = compileFilter({ fields: { due: { eq: "2024-06-01" } } });
		expect(out?.params.p0).toBe("2024-06-01T00:00:00Z");
	});

	test("ne: '2024-06-01' canonicalizes", () => {
		const out = compileFilter({ fields: { due: { ne: "2024-06-01" } } });
		expect(out?.params.p0).toBe("2024-06-01T00:00:00Z");
	});

	test("in: ['2024-06-01', '2024-07-01'] canonicalizes both", () => {
		const out = compileFilter({ fields: { due: { in: ["2024-06-01", "2024-07-01"] } } });
		expect(out?.params.p0).toBe("2024-06-01T00:00:00Z");
		expect(out?.params.p1).toBe("2024-07-01T00:00:00Z");
	});

	test("nin: ['2024-06-01'] canonicalizes", () => {
		const out = compileFilter({ fields: { due: { nin: ["2024-06-01"] } } });
		// nin without null wraps in (expr IS NULL OR expr NOT IN (...)) — the
		// canonicalized value still binds at p0.
		expect(out?.params.p0).toBe("2024-06-01T00:00:00Z");
	});

	test("full ISO datetime canonicalizes (millis stripped, UTC)", () => {
		const out = compileFilter({ fields: { due: { eq: "2024-06-01T12:34:56.789Z" } } });
		expect(out?.params.p0).toBe("2024-06-01T12:34:56Z");
	});

	test("non-ISO string binds raw (regression guard)", () => {
		const out = compileFilter({ fields: { x: { eq: "hello" } } });
		expect(out?.params.p0).toBe("hello");
	});

	test("ISO-shaped but calendar-invalid string binds raw (no FilterSyntaxError)", () => {
		// "2024-13-99" matches ISO_LIKELY_RE shape but isCalendarDate rejects.
		// Falls through to raw bind so user gets a defensible (likely empty)
		// query result rather than an error.
		const out = compileFilter({ fields: { x: { eq: "2024-13-99" } } });
		expect(out?.params.p0).toBe("2024-13-99");
	});

	test("numeric scalar untouched (regression guard)", () => {
		const out = compileFilter({ fields: { priority: { eq: 5 } } });
		expect(out?.params.p0).toBe(5);
	});

	test("non-ISO substring (`contains`) binds raw with %…% wildcards", () => {
		// `contains` doesn't go through bindScalar; canonicalization mustn't
		// touch its LIKE pattern (substring `%2024-06-01%` still matches a
		// canonicalized stored value via wildcard expansion).
		const out = compileFilter({ fields: { x: { contains: "2024-06-01" } } });
		expect(out?.params.p0).toBe("%2024-06-01%");
	});
});
