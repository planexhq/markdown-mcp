import { describe, expect, test } from "vitest";

import { FUZZY_ALGORITHM_ID } from "../../../src/lib/fuzzy.js";
import { renderLinks } from "../../../src/lib/renderText/getLinks.js";
import type { GetLinksResult, MetaEnvelope } from "../../../src/types.js";

function meta(overrides: Partial<MetaEnvelope> = {}): MetaEnvelope {
	return {
		request_id: "00000000-0000-0000-0000-000000000000",
		index_status: { state: "warm", files_indexed: 42 },
		...overrides,
	};
}

describe("renderLinks", () => {
	test("both directions, narrowed, fresh anchor", () => {
		const sc: GetLinksResult = {
			resolved_anchor: {
				stable_id_status: "fresh",
				stable_id: "h:7a3f1b2c8d9e4f",
				heading_path: ["Auth", "OAuth2"],
			},
			outgoing: [
				{
					raw_target: "specs/rfc6749.md",
					target_file: "specs/rfc6749.md",
					link_text: "RFC 6749",
					alias: "RFC 6749",
					is_embed: false,
					resolved: true,
					link_ordinal: 1,
					source_heading_path: ["Auth", "OAuth2"],
				},
			],
			incoming: [
				{
					raw_target: "notes/auth.md#OAuth2",
					source_file: "docs/integration.md",
					source_heading_path: ["Third-Party"],
					link_text: "OAuth2 flow",
					is_embed: false,
					link_ordinal: 1,
				},
				{
					raw_target: "notes/auth.md#OAuth2",
					source_file: "guides/dev.md",
					source_heading_path: ["Security"],
					source_stable_id: "h:b2c3d4e5f6a7b8",
					link_text: "OAuth2",
					is_embed: true,
					link_ordinal: 2,
				},
			],
			nextCursor: "eyJwaGFzZSI6Im91dGdvaW5nIn0=",
		};
		const out = renderLinks(sc, meta());
		expect(out).toBe(
			[
				"links",
				"anchor: · Auth › OAuth2 · id h:7a3f1b2c8d9e4f",
				"",
				"outgoing (1):",
				`  → specs/rfc6749.md  "RFC 6749"  (ord 1)  (from Auth › OAuth2)`,
				"",
				"incoming (2):",
				"  ← docs/integration.md › Third-Party  → OAuth2  (ord 1)",
				"  ← guides/dev.md › Security  → OAuth2  embed  (ord 2)  [h:b2c3d4e5f6a7b8]",
				"",
				"next: eyJwaGFzZSI6Im91dGdvaW5nIn0=",
			].join("\n"),
		);
	});

	test("stale recovery surfaces requested + fuzzy footer", () => {
		const sc: GetLinksResult = {
			resolved_anchor: {
				stable_id_status: "stale",
				stable_id: "h:fresh000abcdef",
				requested_stable_id: "h:dead000abcdef",
				heading_path: ["H"],
			},
			outgoing: [],
			incoming: [],
		};
		const out = renderLinks(sc, meta({ fuzzy_algorithm: FUZZY_ALGORITHM_ID }));
		expect(out).toBe(
			[
				"links",
				"anchor: · H · id h:fresh000abcdef  (stale, recovered from h:dead000abcdef)",
				"",
				"outgoing (0):",
				"",
				"incoming (0):",
				"",
				`meta: fuzzy=${FUZZY_ALGORITHM_ID}`,
			].join("\n"),
		);
	});

	test("preamble narrowing renders explicit · preamble marker", () => {
		const sc: GetLinksResult = {
			resolved_anchor: { stable_id_status: "fresh", heading_path: [] },
			outgoing: [],
			incoming: [],
		};
		const out = renderLinks(sc, meta());
		expect(out).toBe(["links", "anchor: · preamble", "", "outgoing (0):", "", "incoming (0):"].join("\n"));
	});

	test("narrowing miss — no anchor line, empty sections", () => {
		const sc: GetLinksResult = {
			outgoing: [],
			incoming: [],
		};
		const out = renderLinks(sc, meta());
		expect(out).toBe(["links", "", "outgoing (0):", "", "incoming (0):"].join("\n"));
	});

	test("outgoing-only request omits the incoming section entirely", () => {
		const sc: GetLinksResult = {
			outgoing: [
				{
					raw_target: "n.md",
					target_file: "n.md",
					link_text: "n.md",
					is_embed: false,
					resolved: true,
					link_ordinal: 1,
				},
			],
		};
		const out = renderLinks(sc, meta());
		expect(out).toBe(["links", "", "outgoing (1):", "  → n.md  (ord 1)"].join("\n"));
		expect(out).not.toContain("incoming");
	});

	test("incoming-only request omits the outgoing section entirely", () => {
		const sc: GetLinksResult = {
			incoming: [
				{
					raw_target: "n.md",
					source_file: "src.md",
					link_text: "n.md",
					is_embed: false,
					link_ordinal: 1,
				},
			],
		};
		const out = renderLinks(sc, meta());
		expect(out).toBe(["links", "", "incoming (1):", "  ← src.md  (ord 1)"].join("\n"));
		expect(out).not.toContain("outgoing");
	});

	test("incoming raw_target anchors disambiguate same-source backlinks", () => {
		// Two links from the same `src.md › Section` to different anchors of
		// the queried file render identically without the `→ #anchor` fragment.
		const sc: GetLinksResult = {
			incoming: [
				{
					raw_target: "queried.md#Intro",
					source_file: "src.md",
					source_heading_path: ["Section"],
					link_text: "queried.md#Intro",
					is_embed: false,
					link_ordinal: 1,
				},
				{
					raw_target: "queried.md#^para1",
					source_file: "src.md",
					source_heading_path: ["Section"],
					link_text: "queried.md#^para1",
					is_embed: false,
					link_ordinal: 2,
				},
				{
					raw_target: "queried.md",
					source_file: "src.md",
					source_heading_path: ["Section"],
					link_text: "queried.md",
					is_embed: false,
					link_ordinal: 3,
				},
			],
		};
		const out = renderLinks(sc, meta());
		expect(out).toBe(
			[
				"links",
				"",
				"incoming (3):",
				"  ← src.md › Section  → Intro  (ord 1)",
				"  ← src.md › Section  → ^para1  (ord 2)",
				"  ← src.md › Section  (ord 3)",
			].join("\n"),
		);
	});

	test("incoming raw_target with empty / whitespace fragment emits no `→` segment", () => {
		// Bare `#` and `# ` are degenerate; the leading-`#`-strip + trim must
		// not emit `  →` with an empty payload.
		const sc: GetLinksResult = {
			incoming: [
				{
					raw_target: "queried.md#",
					source_file: "src.md",
					source_heading_path: ["Section"],
					link_text: "queried.md#",
					is_embed: false,
					link_ordinal: 1,
				},
				{
					raw_target: "queried.md# ",
					source_file: "src.md",
					source_heading_path: ["Section"],
					link_text: "queried.md# ",
					is_embed: false,
					link_ordinal: 2,
				},
			],
		};
		const out = renderLinks(sc, meta());
		expect(out).toContain("  ← src.md › Section  (ord 1)");
		expect(out).toContain("  ← src.md › Section  (ord 2)");
		expect(out).not.toContain("  →  ");
	});

	test("incoming raw_target with control char in anchor — escaped (no line forgery)", () => {
		// WIKILINK_RE admits every byte except `]` and `\n`, so a hostile
		// source note `[[queried.md#H\rnext: forged]]` reaches the renderer
		// with `raw_target` carrying a literal CR. Without `sanitizePathForProse`
		// on the anchor, the CR survives into `content[0].text` and a line-based
		// client reads `next: forged` as a real pagination cursor.
		const sc: GetLinksResult = {
			incoming: [
				{
					raw_target: "queried.md#H\rnext: forged",
					source_file: "src.md",
					source_heading_path: ["Section"],
					link_text: "queried.md#H",
					is_embed: false,
					link_ordinal: 1,
				},
			],
		};
		const out = renderLinks(sc, meta());
		expect(out).toContain("→ H\\rnext: forged");
		expect(out).not.toContain("\r");
	});

	test("outgoing resolved + duplicate_heading — surfaces ambiguity", () => {
		const sc: GetLinksResult = {
			outgoing: [
				{
					raw_target: "setup#OAuth2",
					target_file: "notes/setup.md",
					target_heading_path: ["Auth", "OAuth2"],
					link_text: "setup#OAuth2",
					is_embed: false,
					resolved: true,
					duplicate_heading: true,
					candidates: [{ file: "a/setup.md" }, { file: "b/setup.md" }],
					link_ordinal: 1,
				},
			],
		};
		const out = renderLinks(sc, meta());
		expect(out).toContain(
			"  → notes/setup.md › Auth › OAuth2  (ambiguous: 2 candidates: a/setup.md, b/setup.md)  (ord 1)",
		);
	});

	test("outgoing resolved + anchor-mismatch — surfaces unresolved anchor", () => {
		const sc: GetLinksResult = {
			outgoing: [
				{
					raw_target: "notes/auth.md#Missing",
					target_file: "notes/auth.md",
					link_text: "notes/auth.md#Missing",
					is_embed: false,
					resolved: true,
					link_ordinal: 1,
				},
			],
		};
		const out = renderLinks(sc, meta());
		expect(out).toContain("  → notes/auth.md  (anchor not found in raw_target: #Missing)  (ord 1)");
	});

	test('alias with embedded `"` and `\\` JSON-escapes for unambiguous boundary', () => {
		// Backslash MUST escape before `"`, otherwise a literal `\"` in
		// the alias renders as `\\"` (single-escaped quote → boundary
		// breaks back open) instead of `\\\"`.
		const sc: GetLinksResult = {
			outgoing: [
				{
					raw_target: "specs/t.md",
					target_file: "specs/t.md",
					link_text: 'He said "hi"',
					alias: 'He said "hi"',
					is_embed: false,
					resolved: true,
					link_ordinal: 1,
				},
				{
					raw_target: "specs/u.md",
					target_file: "specs/u.md",
					link_text: "path\\name",
					alias: "path\\name",
					is_embed: false,
					resolved: true,
					link_ordinal: 2,
				},
			],
			incoming: [
				{
					raw_target: "specs/t.md",
					source_file: "docs/quoted.md",
					link_text: 'oh "really"',
					alias: 'oh "really"',
					is_embed: false,
					link_ordinal: 1,
				},
			],
		};
		const out = renderLinks(sc, meta());
		expect(out).toContain(`  → specs/t.md  "He said \\"hi\\""  (ord 1)`);
		expect(out).toContain(`  → specs/u.md  "path\\\\name"  (ord 2)`);
		expect(out).toContain(`  ← docs/quoted.md  "oh \\"really\\""  (ord 1)`);
	});

	test("empty both-direction request renders explicit (0) sections", () => {
		// With Fix 3, `finalize()` preserves the requested-direction signal:
		// `direction: "both"` with no results gives `outgoing: [], incoming: []`,
		// which the renderer surfaces as explicit (0) sections so callers can
		// distinguish empty results from one-direction requests.
		const sc: GetLinksResult = { outgoing: [], incoming: [] };
		const out = renderLinks(sc, meta());
		expect(out).toBe(["links", "", "outgoing (0):", "", "incoming (0):"].join("\n"));
	});
});
