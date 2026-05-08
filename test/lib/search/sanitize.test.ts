/**
 * D23 query-sanitize-v1 contract tests. The 10-row corpus is locked
 * verbatim from `docs/DECISIONS.md` D23 — every row is a separate
 * test case so a regression names exactly the broken row.
 */

import { describe, expect, test } from "vitest";

import { QUERY_ALGORITHM_ID, type SanitizeOutcome, sanitizeQuery } from "../../../src/lib/search/sanitize.js";

interface Row {
	input: string;
	expectMatch?: string;
	expectKind: SanitizeOutcome["kind"];
	expectReason?: string;
}

const D23_CORPUS: ReadonlyArray<Row> = [
	{ input: "2 + 2", expectKind: "ok", expectMatch: '"2" "2"' },
	{ input: "OAuth2 vs SAML", expectKind: "ok", expectMatch: '"OAuth2" "vs" "SAML"' },
	{ input: '"exact phrase"', expectKind: "ok", expectMatch: '"exact phrase"' },
	{ input: "auth*", expectKind: "ok", expectMatch: '"auth"*' },
	{ input: "body:authentication", expectKind: "ok", expectMatch: '"body:authentication"' },
	{ input: "red AND blue", expectKind: "ok", expectMatch: '"red" "AND" "blue"' },
	{ input: '"multi-tenant"', expectKind: "ok", expectMatch: '"multi-tenant"' },
	{ input: "***", expectKind: "empty", expectReason: "all-punctuation" },
	{ input: "", expectKind: "empty", expectReason: "empty" },
];

describe("query-sanitize-v1 — D23 corpus", () => {
	test.each(D23_CORPUS)("sanitize($input) → $expectKind", ({ input, expectKind, expectMatch, expectReason }) => {
		const outcome = sanitizeQuery(input);
		expect(outcome.kind).toBe(expectKind);
		if (outcome.kind === "ok") expect(outcome.match).toBe(expectMatch);
		if (outcome.kind === "empty") expect(outcome.reason).toBe(expectReason);
	});

	test("10K-char input → reject(too_long)", () => {
		const outcome = sanitizeQuery("x".repeat(10_000));
		expect(outcome.kind).toBe("reject");
		if (outcome.kind === "reject") expect(outcome.reason).toBe("too_long");
	});
});

describe("query-sanitize-v1 — defensive", () => {
	test("control-char input → reject(control_chars)", () => {
		const outcome = sanitizeQuery("hello\u0001world");
		expect(outcome.kind).toBe("reject");
		if (outcome.kind === "reject") expect(outcome.reason).toBe("control_chars");
	});

	test("phrase with embedded quote uses doubled-quote escape", () => {
		const outcome = sanitizeQuery('"say ""hi""!"');
		expect(outcome.kind).toBe("ok");
		if (outcome.kind === "ok") expect(outcome.match).toBe('"say ""hi""!"');
	});

	test("prefix shorter than 3 chars falls through to quoted literal", () => {
		const outcome = sanitizeQuery("au*");
		expect(outcome.kind).toBe("ok");
		if (outcome.kind === "ok") expect(outcome.match).toBe('"au*"');
	});

	test("prefix with mixed punct falls through to quoted literal", () => {
		const outcome = sanitizeQuery("a.b*");
		expect(outcome.kind).toBe("ok");
		if (outcome.kind === "ok") expect(outcome.match).toBe('"a.b*"');
	});

	test("multiple tokens across different shapes are joined with single space (FTS5 implicit AND)", () => {
		const outcome = sanitizeQuery('hello "exact phrase" auth* world');
		expect(outcome.kind).toBe("ok");
		if (outcome.kind === "ok") expect(outcome.match).toBe('"hello" "exact phrase" "auth"* "world"');
	});

	test("only-punctuation tokens drop", () => {
		const outcome = sanitizeQuery("--- +++ ::");
		expect(outcome.kind).toBe("empty");
		if (outcome.kind === "empty") expect(outcome.reason).toBe("all-punctuation");
	});

	test("algorithm id constant", () => {
		expect(QUERY_ALGORITHM_ID).toBe("query-sanitize-v1");
	});
});

describe("query-sanitize-v1 — token shape carries prefix marker", () => {
	test("prefix token retains trailing `*` so the snippet matcher knows to do prefix-stem matching", () => {
		const outcome = sanitizeQuery("auth*");
		expect(outcome.kind).toBe("ok");
		if (outcome.kind === "ok") expect(outcome.tokens).toEqual(["auth*"]);
	});

	test("non-prefix token has no `*` marker", () => {
		const outcome = sanitizeQuery("auth");
		expect(outcome.kind).toBe("ok");
		if (outcome.kind === "ok") expect(outcome.tokens).toEqual(["auth"]);
	});

	test("phrase tokens never carry `*` (phrase queries are exact, not prefix)", () => {
		const outcome = sanitizeQuery('"hello world"');
		expect(outcome.kind).toBe("ok");
		if (outcome.kind === "ok") expect(outcome.tokens).toEqual(["hello", "world"]);
	});

	test("mixed prefix + bare emits the right shape per token", () => {
		const outcome = sanitizeQuery("auth* setup");
		expect(outcome.kind).toBe("ok");
		if (outcome.kind === "ok") expect(outcome.tokens).toEqual(["auth*", "setup"]);
	});

	test("invalid prefix (length < 3) falls through to a literal — token has no `*`", () => {
		const outcome = sanitizeQuery("au*");
		expect(outcome.kind).toBe("ok");
		// `au*` is force-quoted as a phrase literal `"au*"`; FTS5's
		// tokenizer strips `*` from phrase content, so the token used by
		// the snippet matcher is just "au" — and the `*`-marker
		// invariant ("trailing `*` on a token = prefix") stays unambiguous.
		if (outcome.kind === "ok") {
			expect(outcome.match).toBe('"au*"');
			expect(outcome.tokens).toEqual(["au"]);
		}
	});

	test("mixed-punct prefix (`a.b*`) falls through to literal — token has `*` stripped", () => {
		const outcome = sanitizeQuery("a.b*");
		expect(outcome.kind).toBe("ok");
		if (outcome.kind === "ok") {
			expect(outcome.match).toBe('"a.b*"');
			expect(outcome.tokens).toEqual(["a.b"]);
		}
	});

	test("phrase content with embedded `*` strips it from tokens — invariant: trailing `*` only ever signals prefix", () => {
		// FTS5 strips `*` from phrase content; tokens must too, or the
		// snippet matcher would mistake `foo*` for a prefix marker.
		const a = sanitizeQuery('"foo*bar"');
		expect(a.kind).toBe("ok");
		if (a.kind === "ok") expect(a.tokens).toEqual(["foobar"]);

		const b = sanitizeQuery('"foo*"');
		expect(b.kind).toBe("ok");
		if (b.kind === "ok") expect(b.tokens).toEqual(["foo"]);
	});
});
