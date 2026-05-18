import { describe, expect, test } from "vitest";
import { parse as yamlParse } from "yaml";

import { renderMetadata } from "../../../src/lib/renderText/getMetadata.js";
import type { GetMetadataResult, MetaEnvelope } from "../../../src/types.js";

function meta(overrides: Partial<MetaEnvelope> = {}): MetaEnvelope {
	return {
		request_id: "00000000-0000-0000-0000-000000000000",
		index_status: { state: "warm", files_indexed: 42 },
		...overrides,
	};
}

describe("renderMetadata", () => {
	test("scalar + array + nested frontmatter", () => {
		const sc: GetMetadataResult = {
			has_frontmatter: true,
			metadata: {
				title: "Project Alpha",
				status: "active",
				tags: ["api", "internal"],
				nested: { estimate: 5, complete: false },
			},
		};
		const out = renderMetadata(sc, meta());
		expect(out).toBe(
			[
				"# metadata · has frontmatter",
				"",
				"title: Project Alpha",
				"status: active",
				"tags:",
				"  - api",
				"  - internal",
				"nested:",
				"  estimate: 5",
				"  complete: false",
			].join("\n"),
		);
	});

	test("no frontmatter — header only", () => {
		const sc: GetMetadataResult = { has_frontmatter: false, metadata: {} };
		const out = renderMetadata(sc, meta());
		expect(out).toBe("# metadata · no frontmatter");
	});

	test("has_frontmatter:true with empty metadata still prints header only", () => {
		const sc: GetMetadataResult = { has_frontmatter: true, metadata: {} };
		const out = renderMetadata(sc, meta());
		expect(out).toBe("# metadata · has frontmatter");
	});

	test("Date value renders as ISO string", () => {
		const sc: GetMetadataResult = {
			has_frontmatter: true,
			metadata: { due: new Date("2026-06-01T00:00:00Z") },
		};
		const out = renderMetadata(sc, meta());
		expect(out).toContain("due: 2026-06-01T00:00:00.000Z");
	});

	test("block-scalar trailing newlines preserved (was lost via .trimEnd)", () => {
		// Old `.trimEnd()` stripped all trailing whitespace from yaml.stringify
		// output, defeating `|+` block-scalar preservation: a value like
		// `"foo\n\n\n"` round-tripped through the prose channel as `"foo\n"`
		// (or `"foo"` when the marker was eaten too). `.replace(/\n$/, "")`
		// peels only the one trailing newline yaml uses as line-end, so the
		// `|+` marker + most value newlines survive.
		const sc: GetMetadataResult = {
			has_frontmatter: true,
			metadata: { note: "foo\n\n\n" },
		};
		const out = renderMetadata(sc, meta());
		expect(out).toContain("note: |+");
		const yamlStart = out.indexOf("note: |+");
		const yamlPortion = out.slice(yamlStart);
		// 3 trailing newlines in → 2 round-trip out (N→N-1 trade-off
		// documented in the source comment). Old `.trimEnd()` produced 1.
		expect(yamlParse(yamlPortion)).toEqual({ note: "foo\n\n" });
	});

	test("plain scalar values: no behavior change vs prior .trimEnd", () => {
		// Common case: no block scalars in the output; the regex strips the
		// same one trailing `\n` that `.trimEnd()` did. Locks in the
		// no-regression contract for scalars/arrays/nested.
		const sc: GetMetadataResult = {
			has_frontmatter: true,
			metadata: { title: "Project Beta", count: 7 },
		};
		const out = renderMetadata(sc, meta());
		expect(out).toBe(["# metadata · has frontmatter", "", "title: Project Beta", "count: 7"].join("\n"));
	});

	test("meta line surfaces non-default as YAML comment (no synthetic key on reparse)", () => {
		const sc: GetMetadataResult = { has_frontmatter: false, metadata: {} };
		const out = renderMetadata(sc, meta({ index_status: { state: "warming", files_indexed: 3 } }));
		expect(out).toBe(["# metadata · no frontmatter", "", "# meta: state=warming files=3"].join("\n"));
	});

	test("block-scalar value + non-default meta footer round-trips perfectly (no N+1 inflation)", () => {
		// Locks in the `|+` reparse fix at `getMetadata.ts`: with the footer
		// present and yaml ending in `\n`, the conditional separator skip
		// keeps `"foo\n\n"` from inflating to `"foo\n\n\n"` on agent reparse.
		const sc: GetMetadataResult = {
			has_frontmatter: true,
			metadata: { note: "foo\n\n" },
		};
		const out = renderMetadata(sc, meta({ index_status: { state: "warming", files_indexed: 3 } }));
		expect(out).toContain("note: |+");
		expect(out).toContain("# meta: state=warming files=3");
		const yamlStart = out.indexOf("note: |+");
		const yamlPortion = out.slice(yamlStart);
		expect(yamlParse(yamlPortion)).toEqual({ note: "foo\n\n" });
	});

	test("meta footer does not shadow a real user `meta:` frontmatter field on yaml reparse", () => {
		// Pre-fix: bare `meta: state=warming` footer parsed as a synthetic key
		// when an agent reparsed `content[0].text` as YAML, AND a real user
		// `meta:` field would collide (yaml.parse takes the last-defined value
		// silently). `# `-prefixed footer parses as a comment and round-trips
		// the user's frontmatter cleanly.
		const sc: GetMetadataResult = {
			has_frontmatter: true,
			metadata: { meta: "user's real meta value", title: "Note A" },
		};
		const out = renderMetadata(sc, meta({ index_status: { state: "warming", files_indexed: 3 } }));
		// Slice the YAML payload (everything after the header + blank line).
		const lines = out.split("\n");
		const yamlPortion = lines.slice(2).join("\n");
		expect(yamlParse(yamlPortion)).toEqual({ meta: "user's real meta value", title: "Note A" });
	});

	test("yaml-hostile control chars (U+0085/U+2028/U+2029) substituted with reversible `<U+HHHH>` markers", () => {
		// yaml.stringify emits these chars LITERALLY in every scalar style
		// (verified empirically against yaml@2.8.4) because Node's
		// JSON.stringify — which the lib's doubleQuotedString uses — doesn't
		// escape them. Many chat/terminal UIs render them as line breaks; a
		// hostile vault could otherwise forge a `next: <opaque>` or
		// `# meta: state=warm` line in `content[0].text`. Marker carries no
		// YAML semantics in any scalar style (angle brackets aren't reserved
		// in plain or double-quoted strings), so it round-trips through
		// yaml.parse verbatim and is recoverable by pattern match.
		const sc: GetMetadataResult = {
			has_frontmatter: true,
			metadata: {
				title: "a\u0085forged",
				note: "x\u2028y",
				para: "p\u2029q",
				"key\u2028forged": "value",
			},
		};
		const out = renderMetadata(sc, meta());
		expect(out).not.toContain("\u0085");
		expect(out).not.toContain("\u2028");
		expect(out).not.toContain("\u2029");
		expect(out).toContain("title: a<U+0085>forged");
		expect(out).toContain("note: x<U+2028>y");
		expect(out).toContain("para: p<U+2029>q");
		expect(out).toContain("key<U+2028>forged: value");
	});

	test("distinct hostile codepoints in keys do not collapse to the same sanitized name", () => {
		// Strip-walker overwrites on duplicate sanitized keys; non-injective
		// substitution would silently drop one of N values. Distinct
		// codepoints must produce distinct markers.
		const sc: GetMetadataResult = {
			has_frontmatter: true,
			metadata: {
				"key\u0085A": "first",
				"key\u2028A": "second",
				"key\u2029A": "third",
			},
		};
		const out = renderMetadata(sc, meta());
		expect(out).toContain("key<U+0085>A: first");
		expect(out).toContain("key<U+2028>A: second");
		expect(out).toContain("key<U+2029>A: third");
	});

	test("literal `<U+HHHH>` text in key does not collide with a real hostile-codepoint key", () => {
		// Literal `<U+2028>` text and real U+2028 char would otherwise both
		// sanitize to `key<U+2028>A`; the strip-walker's
		// `out[safeYamlString(k)] = …` would overwrite one. Pre-escaping
		// `<U+` → `\<U+` keeps literal and substituted namespaces disjoint.
		const sc: GetMetadataResult = {
			has_frontmatter: true,
			metadata: {
				"key<U+2028>A": "literal",
				"key\u2028A": "hostile",
			},
		};
		const out = renderMetadata(sc, meta());
		expect(out).toContain("key\\<U+2028>A: literal");
		expect(out).toContain("key<U+2028>A: hostile");
	});

	test("user-defined `__proto__:` key survives the strip-walker (own property, not prototype setter)", () => {
		// Construct via null-proto + bracket assignment so `__proto__`
		// lands as an own property — the `{__proto__: X}` literal sets
		// the LITERAL's prototype (never an own property), so `Object.
		// assign` from such a literal would see no `__proto__` to copy.
		const metadata: Record<string, unknown> = Object.create(null);
		metadata.__proto__ = { tags: ["injected"] };
		metadata.ok = "fine";
		const sc: GetMetadataResult = { has_frontmatter: true, metadata };
		const out = renderMetadata(sc, meta());
		expect(out).toContain("__proto__:");
		expect(out).toContain("ok: fine");
		const parsed = yamlParse(out) as Record<string, unknown>;
		expect(Object.hasOwn(parsed, "__proto__")).toBe(true);
		expect((parsed as { __proto__: { tags: string[] } }).__proto__).toEqual({ tags: ["injected"] });
		expect(parsed.ok).toBe("fine");
	});

	test("whole `content[0].text` reparses as YAML in every shape (header is `# `-prefixed)", () => {
		// `# ` prefix on header + footer is the contract: `yaml.parse(out)`
		// returns the canonical frontmatter mapping (or null for the
		// no-frontmatter case). Without the header prefix, the renderer's
		// status line parses as an implicit-key scalar and collides with
		// the frontmatter mapping below.
		const withFm: GetMetadataResult = {
			has_frontmatter: true,
			metadata: { title: "Note", count: 7 },
		};
		expect(yamlParse(renderMetadata(withFm, meta()))).toEqual({ title: "Note", count: 7 });
		const warming = meta({ index_status: { state: "warming", files_indexed: 3 } });
		expect(yamlParse(renderMetadata(withFm, warming))).toEqual({ title: "Note", count: 7 });

		const noFm: GetMetadataResult = { has_frontmatter: false, metadata: {} };
		expect(yamlParse(renderMetadata(noFm, meta()))).toBeNull();
		expect(yamlParse(renderMetadata(noFm, warming))).toBeNull();
	});
});
