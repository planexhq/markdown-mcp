/**
 * D43 — YAML parser unit tests (Phase 2 opaque emission).
 *
 * Covers:
 *   - Plain-object top-level → `frontmatter` populated, single file-row
 *     emission downstream (verified by `frontmatterEndOffset=0`,
 *     empty headings/blocks/preamble).
 *   - Scalar / array top-level → `frontmatter = null` (per Brief: frontmatter
 *     is `Record<string, unknown>`); whole source still indexable as body.
 *   - Empty source / empty document → `hasFrontmatter=false`, `frontmatter=null`.
 *   - Malformed YAML → `ParseError(reason: "syntax", format: "yaml")` with
 *     line/column when the underlying YAMLParseError carries them.
 *   - Node-count cap → `ast_node_cap_exceeded` for pathological inputs.
 *   - `kind: "yaml"` stamp on every successful return.
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import * as yamlMod from "yaml";

import { ParseError, parseFile } from "../../../src/lib/parser.js";
import { parseYamlFile } from "../../../src/lib/parsers/yaml.js";

vi.mock("yaml", async (importOriginal) => {
	const actual = await importOriginal<typeof import("yaml")>();
	return { ...actual };
});

// File-scope cleanup — defends every describe block against env-stub
// leakage, not just the dispatch tests that explicitly use `vi.stubEnv`.
afterEach(() => {
	vi.unstubAllEnvs();
});

describe("parseYamlFile — opaque emission", () => {
	test("plain-object top-level populates frontmatter; emits opaque file", () => {
		const source = "name: petstore\nversion: 1.0.0\ntags:\n  - api\n  - rest\n";
		const parsed = parseYamlFile(source, "api/petstore.yaml");
		expect(parsed.kind).toBe("yaml");
		expect(parsed.hasFrontmatter).toBe(true);
		expect(parsed.frontmatter).toEqual({
			name: "petstore",
			version: "1.0.0",
			tags: ["api", "rest"],
		});
		expect(parsed.frontmatterEndOffset).toBe(0);
		expect(parsed.outline).toEqual([]);
		expect(parsed.headings).toEqual([]);
		expect(parsed.blocks).toEqual([]);
		// Preamble covers the whole source so computeFileMetrics (scanner.ts)
		// counts body tokens for non-OpenAPI YAML files. Markdown's
		// headingless-file invariant applied to YAML. The trailing `\n`
		// after `- rest` opens line 6 — matches countLines's CommonMark
		// §2.3 line-counting semantics.
		expect(parsed.preamble).toEqual({
			range: { start: 1, end: 6 },
			offsetRange: { start: 0, end: source.length },
			contentKinds: [],
		});
		expect(parsed.excludedRanges).toEqual([]);
		// `source` preserved verbatim so `note://` returns literal bytes.
		expect(parsed.source).toBe(source);
		expect(parsed.relpath).toBe("api/petstore.yaml");
	});

	test("nested dotted-path frontmatter is filterable via D30", () => {
		const source = `openapi: "3.0.3"
info:
  title: Petstore
  version: 1.0.0
  contact:
    email: api@example.com
`;
		const parsed = parseYamlFile(source, "api/petstore.yaml");
		expect(parsed.frontmatter).toBeTruthy();
		// D30 nested-path access compiles `fields["info.contact.email"]`
		// to `json_extract($."info"."contact"."email")` — the stored shape
		// must be a JS-native nested object for that path to resolve.
		const fm = parsed.frontmatter as Record<string, unknown>;
		const info = fm.info as Record<string, unknown>;
		const contact = info.contact as Record<string, unknown>;
		expect(contact.email).toBe("api@example.com");
	});

	test("scalar top-level → frontmatter=null, opaque body still indexable", () => {
		const source = "42\n";
		const parsed = parseYamlFile(source, "configs/scalar.yaml");
		expect(parsed.frontmatter).toBeNull();
		expect(parsed.hasFrontmatter).toBe(false);
		// frontmatterEndOffset=0 means the file-row range covers the whole
		// source so the literal `42` is still searchable.
		expect(parsed.frontmatterEndOffset).toBe(0);
	});

	test("array top-level → frontmatter=null per Brief Record<string,unknown> contract", () => {
		const source = "- alpha\n- beta\n- gamma\n";
		const parsed = parseYamlFile(source, "configs/list.yaml");
		expect(parsed.frontmatter).toBeNull();
		expect(parsed.hasFrontmatter).toBe(false);
	});

	test("empty source → hasFrontmatter=false", () => {
		const parsed = parseYamlFile("", "configs/empty.yaml");
		expect(parsed.frontmatter).toBeNull();
		expect(parsed.hasFrontmatter).toBe(false);
	});

	test("empty mapping {} → hasFrontmatter=false (no keys)", () => {
		const parsed = parseYamlFile("{}\n", "configs/empty-map.yaml");
		expect(parsed.frontmatter).toEqual({});
		expect(parsed.hasFrontmatter).toBe(false);
	});

	test("Date scalar top-level → frontmatter=null", () => {
		// yaml@2 parses `!!timestamp` as a Date instance; Date isn't a
		// `Record<string, unknown>`.
		const source = "!!timestamp 2024-01-01T00:00:00Z\n";
		const parsed = parseYamlFile(source, "configs/timestamp.yaml");
		expect(parsed.frontmatter).toBeNull();
		expect(parsed.hasFrontmatter).toBe(false);
	});

	test("flat map under the AST cap parses cleanly", () => {
		// 60 scalar children + 1 parent = 61 nodes against a cap of 100;
		// each node must contribute exactly once.
		const lines: string[] = [];
		for (let i = 0; i < 60; i++) lines.push(`k${i}: ${i}`);
		const body = `${lines.join("\n")}\n`;
		const parsed = parseYamlFile(body, "configs/wide.yaml", { maxAstNodes: 100 });
		const fm = parsed.frontmatter as Record<string, unknown>;
		expect(fm).toBeTruthy();
		expect(Object.keys(fm).length).toBe(60);
	});
});

describe("parseYamlFile — error routing (D45)", () => {
	const CAP_PATH_CASES = [
		{ variant: "default path", opts: {} },
		{ variant: "frontmatterOnly path", opts: { frontmatterOnly: true } },
	] as const;

	test("malformed YAML (unclosed flow) throws ParseError(format='yaml', reason='syntax')", () => {
		// Unclosed flow sequence — `yaml@2.x` raises YAMLParseError with linePos.
		const source = "items: [a, b, c\nmore: stuff\n";
		try {
			parseYamlFile(source, "configs/malformed.yaml");
			throw new Error("expected throw");
		} catch (err) {
			expect(err).toBeInstanceOf(ParseError);
			const pe = err as ParseError;
			expect(pe.reason).toBe("syntax");
			expect(pe.format).toBe("yaml");
			// `extractYamlErrorPos` wires through the 1-based line position.
			expect(pe.line).toBeGreaterThanOrEqual(1);
		}
	});

	test.each(CAP_PATH_CASES)("ast_node_cap_exceeded fires for over-cap node count on $variant", ({ opts }) => {
		// Build a flat flow-array with > MAX_AST_NODES entries so the
		// walker's flat path trips the cap. Construct in JS then YAML-stringify
		// so we don't depend on whitespace handling.
		const items: string[] = [];
		for (let i = 0; i < 60_001; i++) items.push(`a${i}`);
		const body = `items: [${items.join(",")}]\n`;
		try {
			parseYamlFile(body, "configs/huge.yaml", opts);
			throw new Error("expected throw");
		} catch (err) {
			expect(err).toBeInstanceOf(ParseError);
			const pe = err as ParseError;
			expect(pe.reason).toBe("ast_node_cap_exceeded");
			expect(pe.format).toBe("yaml");
		}
	});

	test("ParseFileOptions.maxAstNodes override is honored (symmetric with markdown)", () => {
		// Markdown threads `options.maxAstNodes ?? MAX_AST_NODES`; YAML must
		// too, otherwise tests (and any caller-tunable throttling) silently
		// fall back to the default 50K cap for `.yaml`/`.yml` files.
		try {
			parseYamlFile("a: 1\nb: 2\nc: 3\n", "configs/tiny.yaml", { maxAstNodes: 1 });
			throw new Error("expected throw");
		} catch (err) {
			expect(err).toBeInstanceOf(ParseError);
			const pe = err as ParseError;
			expect(pe.reason).toBe("ast_node_cap_exceeded");
			expect(pe.format).toBe("yaml");
			expect(pe.message).toContain("exceeding the 1 cap");
		}
	});

	test.each(CAP_PATH_CASES)("ast_node_cap_exceeded fires for pathological nesting depth on $variant", ({ opts }) => {
		// 300-deep truly-nested mapping exceeds MAX_YAML_DEPTH (256). Each
		// level adds 2 spaces of indent — yaml.parse handles arbitrary
		// depth, the cap fires in our walker.
		let body = "";
		for (let i = 0; i < 300; i++) body += `${"  ".repeat(i)}x:\n`;
		body += `${"  ".repeat(300)}end\n`;
		try {
			parseYamlFile(body, "configs/deep.yaml", opts);
			throw new Error("expected throw");
		} catch (err) {
			expect(err).toBeInstanceOf(ParseError);
			const pe = err as ParseError;
			expect(pe.reason).toBe("ast_node_cap_exceeded");
			expect(pe.format).toBe("yaml");
		}
	});

	test("RangeError from parseYAML is reclassified to ast_node_cap_exceeded", () => {
		const spy = vi.spyOn(yamlMod, "parse").mockImplementationOnce(() => {
			throw new RangeError("Maximum call stack size exceeded");
		});
		try {
			parseYamlFile("a: 1\n", "configs/range-error.yaml");
			throw new Error("expected throw");
		} catch (err) {
			expect(err).toBeInstanceOf(ParseError);
			const pe = err as ParseError;
			expect(pe.reason).toBe("ast_node_cap_exceeded");
			expect(pe.format).toBe("yaml");
			expect(pe.message).toContain("recursion limit");
		} finally {
			spy.mockRestore();
		}
	});

	test("RangeError from normalizeForJson is reclassified to ast_node_cap_exceeded", () => {
		// Real YAML can't reliably overflow normalize without overflowing
		// parseYAML first (similar stack budgets), so feed normalize a
		// pre-built deeply nested object via the parse spy.
		let deep: unknown = { leaf: true };
		for (let i = 0; i < 20_000; i++) deep = { x: deep };
		const spy = vi.spyOn(yamlMod, "parse").mockImplementationOnce(() => deep);
		try {
			parseYamlFile("a: 1\n", "configs/normalize-overflow.yaml");
			throw new Error("expected throw");
		} catch (err) {
			expect(err).toBeInstanceOf(ParseError);
			const pe = err as ParseError;
			expect(pe.reason).toBe("ast_node_cap_exceeded");
			expect(pe.format).toBe("yaml");
			expect(pe.message).toContain("recursion limit");
		} finally {
			spy.mockRestore();
		}
	});
});

describe("parseYamlFile — dispatch via parseFile (D43)", () => {
	test(".yaml extension routes to YAML parser when VAULT_EXTENSIONS admits it", () => {
		// `getVaultExtensions` caches by raw env value; `vi.stubEnv` mutates
		// it so the next read sees the new value (no module re-import needed).
		vi.stubEnv("VAULT_EXTENSIONS", "md,yaml");
		const parsed = parseFile("hello: world\n", "test.yaml");
		expect(parsed.kind).toBe("yaml");
		expect(parsed.frontmatter).toEqual({ hello: "world" });
	});

	test(".yml extension also routes to YAML parser", () => {
		vi.stubEnv("VAULT_EXTENSIONS", "md,yml");
		const parsed = parseFile("foo: bar\n", "test.yml");
		expect(parsed.kind).toBe("yaml");
		expect(parsed.frontmatter).toEqual({ foo: "bar" });
	});

	test(".md extension still routes to markdown parser", () => {
		// No env stub: default extensions only include md.
		const parsed = parseFile("# Hello\n\nbody.\n", "note.md");
		expect(parsed.kind).toBe("markdown");
		expect(parsed.headings.length).toBe(1);
		expect(parsed.headings[0]?.pathText).toBe("Hello");
	});

	test("relpath without extension defaults to markdown (pre-D43 contract)", () => {
		const parsed = parseFile("# Heading\n", "scratch");
		expect(parsed.kind).toBe("markdown");
		expect(parsed.headings.length).toBe(1);
	});
});
