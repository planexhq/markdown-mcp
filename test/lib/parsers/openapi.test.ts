/**
 * OpenAPI synthesizer unit tests.
 *
 * Covers:
 *   - Detection: `openapi: "3.*"` → synthesize; `swagger: "2.0"` → opaque fallback.
 *   - Operation enumeration: sorted by path alphabetically, methods in
 *     canonical HTTP order. Non-method path-item keys (parameters, summary,
 *     servers) are skipped.
 *   - Stable ID format: `structuralPath` = `"op[<sha14>]"`, stable across
 *     path reorders (name-based slots).
 *   - Heading metadata: pathText = "GET /users", level=2, flat outline.
 *   - Preamble emission: info block → 1 preamble row; empty info → no preamble.
 *   - Frontmatter: entire top-level object exposed for nested-path filters.
 *   - Synthesized source content: prose + JSON fences positioned in excludedRanges.
 */

import { describe, expect, test } from "vitest";
import { isPlainObject } from "../../../src/lib/parser.js";
import { detectOpenApi } from "../../../src/lib/parsers/openapi.js";
import { parseYamlFile } from "../../../src/lib/parsers/yaml.js";

const isOperationHeading = (h: { structuralPath: string }): boolean => h.structuralPath.startsWith("op[");

const PETSTORE_YAML = `openapi: "3.0.3"
info:
  title: Petstore
  version: 1.0.0
  description: A sample Pet Store API.
tags:
  - name: pets
    description: Pet operations
paths:
  /pets:
    get:
      summary: List all pets
      description: Returns a paginated list of pets.
      operationId: listPets
      parameters:
        - name: limit
          in: query
          description: Max pets to return
          schema:
            type: integer
      responses:
        "200":
          description: A list of pets
        "401":
          description: Unauthorized
    post:
      summary: Create a pet
      description: Adds a new pet to the store.
      requestBody:
        description: Pet data
        content:
          application/json:
            schema:
              type: object
      responses:
        "201":
          description: Pet created
  /pets/{id}:
    get:
      summary: Get a pet by ID
      parameters:
        - name: id
          in: path
          required: true
          schema:
            type: string
      responses:
        "200":
          description: A pet
        "404":
          description: Not found
`;

describe("detectOpenApi", () => {
	test("returns true for openapi 3.0.x", () => {
		expect(detectOpenApi({ openapi: "3.0.3" })).toBe(true);
		expect(detectOpenApi({ openapi: "3.0.0", info: {} })).toBe(true);
	});

	test("returns true for openapi 3.1.x", () => {
		expect(detectOpenApi({ openapi: "3.1.0" })).toBe(true);
	});

	test("returns false for swagger 2.0", () => {
		expect(detectOpenApi({ swagger: "2.0" })).toBe(false);
	});

	test("returns false for openapi 2.0 (theoretical malformed)", () => {
		expect(detectOpenApi({ openapi: "2.0" })).toBe(false);
	});

	test("returns false for non-objects", () => {
		expect(detectOpenApi(null)).toBe(false);
		expect(detectOpenApi("hello")).toBe(false);
		expect(detectOpenApi(42)).toBe(false);
		expect(detectOpenApi([])).toBe(false);
	});

	test("returns false for openapi key with non-string value", () => {
		expect(detectOpenApi({ openapi: 3 })).toBe(false);
	});
});

describe("synthesizeOpenApiFile — operation enumeration", () => {
	test("enumerates all operations sorted by path + canonical method order", () => {
		const parsed = parseYamlFile(PETSTORE_YAML, "api/petstore.yaml");
		const operationTexts = parsed.headings.filter(isOperationHeading).map((h) => h.pathText);
		expect(operationTexts).toEqual(["GET /pets", "POST /pets", "GET /pets/{id}"]);
	});

	test("each operation gets one heading row at level 2", () => {
		const parsed = parseYamlFile(PETSTORE_YAML, "api/petstore.yaml");
		const operations = parsed.headings.filter(isOperationHeading);
		expect(operations.length).toBe(3);
		for (const h of operations) {
			expect(h.level).toBe(2);
			expect(h.headingPath.length).toBe(1);
		}
	});

	test("flat outline — every operation is a top-level node", () => {
		const parsed = parseYamlFile(PETSTORE_YAML, "api/petstore.yaml");
		// PETSTORE_YAML carries top-level `tags`, so the spec-metadata
		// catch-all adds a 4th top-level node alongside the 3 operations.
		expect(parsed.outline.length).toBe(4);
		for (const node of parsed.outline) {
			expect(node.children).toBeUndefined();
			expect(node.level).toBe(2);
		}
	});

	test("skips non-method keys on path-items (parameters, summary, servers)", () => {
		const yaml = `openapi: "3.0.0"
info: { title: T, version: "1" }
paths:
  /x:
    summary: shared summary
    parameters:
      - name: shared
        in: header
    get:
      responses: { "200": { description: ok } }
`;
		const parsed = parseYamlFile(yaml, "x.yaml");
		// Path-item `summary`/`parameters` reach FTS via the spec-metadata
		// catch-all; the operation loop itself still emits exactly one
		// heading (no Summary/Parameters headings per-operation).
		expect(parsed.headings.filter(isOperationHeading).map((h) => h.pathText)).toEqual(["GET /x"]);
	});

	test("path-item parameters are inherited by every operation (OpenAPI 3.x)", () => {
		// Path-level `id` applies to GET and DELETE; GET also declares its own
		// `expand` query param. Neither method redeclares `id`, so it must
		// flow into both the synthesized prose and the JSON fence.
		const yaml = `openapi: "3.0.0"
info: { title: T, version: "1" }
paths:
  /pets/{id}:
    parameters:
      - name: id
        in: path
        required: true
        description: pet identifier
    get:
      summary: Get pet
      parameters:
        - name: expand
          in: query
      responses: { "200": { description: ok } }
    delete:
      summary: Delete pet
      responses: { "204": { description: no content } }
`;
		const parsed = parseYamlFile(yaml, "pets.yaml");
		// Both operations carry the inherited `id` in their rendered prose.
		const get = parsed.headings.find((h) => h.pathText === "GET /pets/{id}");
		const del = parsed.headings.find((h) => h.pathText === "DELETE /pets/{id}");
		if (!get || !del) throw new Error("expected both GET and DELETE headings");
		const getBody = parsed.source.slice(get.bodyOffsetRange.start, get.bodyOffsetRange.end);
		const delBody = parsed.source.slice(del.bodyOffsetRange.start, del.bodyOffsetRange.end);
		expect(getBody).toContain("- id (path): pet identifier");
		expect(getBody).toContain("- expand (query)");
		expect(delBody).toContain("- id (path): pet identifier");
		// JSON fence carries the merged params — DELETE has only the inherited
		// `id`; GET has both with operation-level `expand` after `id`.
		const getJson = /```json\n([\s\S]*?)\n```/.exec(getBody)?.[1] ?? "";
		const delJson = /```json\n([\s\S]*?)\n```/.exec(delBody)?.[1] ?? "";
		const getOp = JSON.parse(getJson) as { parameters: Array<{ name: string; in: string }> };
		const delOp = JSON.parse(delJson) as { parameters: Array<{ name: string; in: string }> };
		expect(getOp.parameters.map((p) => `${p.in}:${p.name}`)).toEqual(["path:id", "query:expand"]);
		expect(delOp.parameters.map((p) => `${p.in}:${p.name}`)).toEqual(["path:id"]);
	});

	test("path-item $ref parameters survive merge even with op-level params", () => {
		// Path-level `$ref` carries no `name` field — `paramKey` returns null.
		// Naive override-by-(name, in) filtering would drop the reference
		// whenever the operation adds any concrete param; the synthesized
		// prose + JSON fence would then under-represent the operation.
		const yaml = `openapi: "3.0.0"
info: { title: T, version: "1" }
paths:
  /pets/{id}:
    parameters:
      - $ref: "#/components/parameters/PetId"
    get:
      parameters:
        - name: expand
          in: query
      responses: { "200": { description: ok } }
`;
		const parsed = parseYamlFile(yaml, "pets.yaml");
		const get = parsed.headings.find((h) => h.pathText === "GET /pets/{id}");
		if (!get) throw new Error("expected GET /pets/{id} heading");
		const getBody = parsed.source.slice(get.bodyOffsetRange.start, get.bodyOffsetRange.end);
		const getJson = /```json\n([\s\S]*?)\n```/.exec(getBody)?.[1] ?? "";
		const getOp = JSON.parse(getJson) as { parameters: Array<Record<string, unknown>> };
		expect(getOp.parameters).toHaveLength(2);
		expect(getOp.parameters[0]).toEqual({ $ref: "#/components/parameters/PetId" });
		expect(getOp.parameters[1]).toEqual({ name: "expand", in: "query" });
	});

	test("operation-level parameters override path-item by (name, in) pair", () => {
		// Path-level `id` (description: "pet identifier") overridden at the
		// operation level (description: "internal pet UUID"). Spec says
		// op-level wins by name+in match.
		const yaml = `openapi: "3.0.0"
info: { title: T, version: "1" }
paths:
  /pets/{id}:
    parameters:
      - name: id
        in: path
        description: pet identifier
    get:
      parameters:
        - name: id
          in: path
          description: internal pet UUID
      responses: { "200": { description: ok } }
`;
		const parsed = parseYamlFile(yaml, "pets.yaml");
		const get = parsed.headings.find((h) => h.pathText === "GET /pets/{id}");
		if (!get) throw new Error("expected GET /pets/{id} heading");
		const getBody = parsed.source.slice(get.bodyOffsetRange.start, get.bodyOffsetRange.end);
		expect(getBody).toContain("- id (path): internal pet UUID");
		expect(getBody).not.toContain("pet identifier");
		const getJson = /```json\n([\s\S]*?)\n```/.exec(getBody)?.[1] ?? "";
		const getOp = JSON.parse(getJson) as { parameters: Array<{ description: string }> };
		expect(getOp.parameters).toHaveLength(1);
		expect(getOp.parameters[0]?.description).toBe("internal pet UUID");
	});
});

describe("synthesizeOpenApiFile — stable IDs (name-based slots)", () => {
	test("structuralPath uses op[<sha14>] format (matches markdown stable_id width)", () => {
		const parsed = parseYamlFile(PETSTORE_YAML, "api/petstore.yaml");
		// Named singletons (Components, Spec metadata) carry literal slots
		// the sha14 format is operation-specific.
		const operations = parsed.headings.filter(isOperationHeading);
		expect(operations.length).toBeGreaterThan(0);
		for (const h of operations) {
			expect(h.structuralPath).toMatch(/^op\[[0-9a-f]{14}\]$/);
		}
	});

	test("stable_id survives path reorder (name-based slots, not sibling-index)", () => {
		// Same paths in two different lex orders — by-content stable_id should match.
		const yamlA = `openapi: "3.0.0"
info: { title: T, version: "1" }
paths:
  /apple:
    get: { responses: { "200": { description: ok } } }
  /banana:
    get: { responses: { "200": { description: ok } } }
`;
		const yamlB = `openapi: "3.0.0"
info: { title: T, version: "1" }
paths:
  /banana:
    get: { responses: { "200": { description: ok } } }
  /apple:
    get: { responses: { "200": { description: ok } } }
`;
		const parsedA = parseYamlFile(yamlA, "x.yaml");
		const parsedB = parseYamlFile(yamlB, "x.yaml");

		const idsA = new Map(parsedA.headings.map((h) => [h.pathText, h.stable_id]));
		const idsB = new Map(parsedB.headings.map((h) => [h.pathText, h.stable_id]));

		// Same operations → same IDs regardless of source order.
		expect(idsA.get("GET /apple")).toBe(idsB.get("GET /apple"));
		expect(idsA.get("GET /banana")).toBe(idsB.get("GET /banana"));
	});

	test("inserting a path between existing entries does NOT shift existing stable_ids", () => {
		const yamlBefore = `openapi: "3.0.0"
info: { title: T, version: "1" }
paths:
  /alpha:
    get: { responses: { "200": { description: ok } } }
  /gamma:
    get: { responses: { "200": { description: ok } } }
`;
		const yamlAfter = `openapi: "3.0.0"
info: { title: T, version: "1" }
paths:
  /alpha:
    get: { responses: { "200": { description: ok } } }
  /beta:
    get: { responses: { "200": { description: ok } } }
  /gamma:
    get: { responses: { "200": { description: ok } } }
`;
		const parsedBefore = parseYamlFile(yamlBefore, "x.yaml");
		const parsedAfter = parseYamlFile(yamlAfter, "x.yaml");

		const idBeforeAlpha = parsedBefore.headings.find((h) => h.pathText === "GET /alpha")?.stable_id;
		const idAfterAlpha = parsedAfter.headings.find((h) => h.pathText === "GET /alpha")?.stable_id;
		expect(idBeforeAlpha).toBeDefined();
		expect(idAfterAlpha).toBe(idBeforeAlpha);

		const idBeforeGamma = parsedBefore.headings.find((h) => h.pathText === "GET /gamma")?.stable_id;
		const idAfterGamma = parsedAfter.headings.find((h) => h.pathText === "GET /gamma")?.stable_id;
		expect(idAfterGamma).toBe(idBeforeGamma);
	});

	test("colliding slugs deduplicate within the file (github-slugger algorithm)", () => {
		// `pathToSlug` normalizes non-alnum to `-`, so `/pets/id` and
		// `/pets/{id}` both collapse to `get-pets-id`. Without per-file
		// dedup, `OutlineNode.anchor` stops being unique within the file
		// and clients caching by anchor would merge two different
		// operations. Markdown does the same dedup via `uniqueSlug`.
		const yaml = `openapi: "3.0.0"
info: { title: T, version: "1" }
paths:
  /pets/id:
    get: { responses: { "200": { description: ok } } }
  /pets/{id}:
    get: { responses: { "200": { description: ok } } }
`;
		const parsed = parseYamlFile(yaml, "x.yaml");
		const slugs = parsed.headings.map((h) => h.slug);
		expect(slugs).toEqual(["get-pets-id", "get-pets-id-1"]);
		expect(new Set(slugs).size).toBe(slugs.length);
		// Outline's `anchor` mirrors `HeadingMeta.slug`.
		const anchors = parsed.outline.map((n) => n.anchor);
		expect(anchors).toEqual(["get-pets-id", "get-pets-id-1"]);
	});

	test("rename `/users` → `/customers` retires the old stable_id", () => {
		const yamlBefore = `openapi: "3.0.0"
info: { title: T, version: "1" }
paths:
  /users:
    get: { responses: { "200": { description: ok } } }
`;
		const yamlAfter = `openapi: "3.0.0"
info: { title: T, version: "1" }
paths:
  /customers:
    get: { responses: { "200": { description: ok } } }
`;
		const parsedBefore = parseYamlFile(yamlBefore, "x.yaml");
		const parsedAfter = parseYamlFile(yamlAfter, "x.yaml");
		// Different paths → different stable_ids (rename IS a retirement).
		expect(parsedBefore.headings[0]?.stable_id).not.toBe(parsedAfter.headings[0]?.stable_id);
	});
});

describe("synthesizeOpenApiFile — preamble + frontmatter", () => {
	test("info block emits preamble row with title/version/description prose", () => {
		const parsed = parseYamlFile(PETSTORE_YAML, "api/petstore.yaml");
		const preamble = parsed.preamble;
		if (preamble === null) throw new Error("expected preamble to be present");
		const preambleSlice = parsed.source.slice(preamble.offsetRange.start, preamble.offsetRange.end);
		expect(preambleSlice).toContain("Petstore");
		expect(preambleSlice).toContain("1.0.0");
		expect(preambleSlice).toContain("A sample Pet Store API.");
		expect(preambleSlice).toContain("pets"); // tag name
	});

	test("missing info → no preamble row", () => {
		const yaml = `openapi: "3.0.0"
paths:
  /x:
    get: { responses: { "200": { description: ok } } }
`;
		const parsed = parseYamlFile(yaml, "x.yaml");
		expect(parsed.preamble).toBeNull();
	});

	test("frontmatter exposes entire top-level OpenAPI object (nested-path access)", () => {
		const parsed = parseYamlFile(PETSTORE_YAML, "api/petstore.yaml");
		expect(parsed.hasFrontmatter).toBe(true);
		const fm = parsed.frontmatter as Record<string, unknown>;
		expect(fm.openapi).toBe("3.0.3");
		const info = fm.info as Record<string, unknown>;
		expect(info.title).toBe("Petstore");
		expect(info.version).toBe("1.0.0");
		expect(fm.paths).toBeTruthy();
	});
});

describe("synthesizeOpenApiFile — synthesized source + excludedRanges", () => {
	test("synthesized source contains operation headings and prose", () => {
		const parsed = parseYamlFile(PETSTORE_YAML, "api/petstore.yaml");
		expect(parsed.source).toContain("## GET /pets\n");
		expect(parsed.source).toContain("## POST /pets\n");
		expect(parsed.source).toContain("## GET /pets/{id}\n");
		expect(parsed.source).toContain("List all pets");
		expect(parsed.source).toContain("Returns a paginated list of pets.");
		expect(parsed.source).toContain("Parameters:");
		expect(parsed.source).toContain("- limit (query): Max pets to return");
		expect(parsed.source).toContain("Responses:");
	});

	test("each operation has a JSON fence covered by excludedRanges", () => {
		const parsed = parseYamlFile(PETSTORE_YAML, "api/petstore.yaml");
		// 3 operations + 1 spec-metadata fence (top-level `tags`) = 4.
		expect(parsed.excludedRanges.length).toBe(4);
		for (const range of parsed.excludedRanges) {
			const slice = parsed.source.slice(range.offsetStart, range.offsetEnd);
			expect(slice.startsWith("```json")).toBe(true);
			expect(slice.endsWith("```\n\n")).toBe(true);
		}
	});

	test("heading offsetRange covers the operation section through next heading", () => {
		const parsed = parseYamlFile(PETSTORE_YAML, "api/petstore.yaml");
		for (let i = 0; i < parsed.headings.length; i++) {
			const h = parsed.headings[i];
			if (!h) continue;
			const next = parsed.headings[i + 1];
			if (next) {
				expect(h.offsetRange.end).toBe(next.offsetRange.start);
			} else {
				expect(h.offsetRange.end).toBe(parsed.source.length);
			}
			// Body offset starts after the heading line.
			expect(h.bodyOffsetRange.start).toBeGreaterThan(h.offsetRange.start);
			expect(h.bodyOffsetRange.end).toBe(h.offsetRange.end);
		}
	});

	test("kind: 'yaml' on every synthesized ParsedFile", () => {
		const parsed = parseYamlFile(PETSTORE_YAML, "api/petstore.yaml");
		expect(parsed.kind).toBe("yaml");
	});
});

describe("synthesizeOpenApiFile — edge cases", () => {
	test("empty paths → preamble only, 0 headings", () => {
		const yaml = `openapi: "3.0.0"
info:
  title: Empty
  version: "1"
paths: {}
`;
		const parsed = parseYamlFile(yaml, "x.yaml");
		expect(parsed.headings).toEqual([]);
		expect(parsed.preamble).toBeTruthy();
	});

	test("operation with no description/summary still emits", () => {
		const yaml = `openapi: "3.0.0"
info: { title: T, version: "1" }
paths:
  /x:
    get:
      responses:
        "200":
          description: ok
`;
		const parsed = parseYamlFile(yaml, "x.yaml");
		expect(parsed.headings.length).toBe(1);
		expect(parsed.headings[0]?.pathText).toBe("GET /x");
	});

	test("sparse openapi 3.x with no operations and no info → opaque fallback (no silent drop)", () => {
		const yaml = 'openapi: "3.0.0"\nfoo: bar\n';
		const parsed = parseYamlFile(yaml, "x.yaml");
		expect(parsed.headings).toEqual([]);
		expect(parsed.preamble?.offsetRange).toEqual({ start: 0, end: yaml.length });
		const fm = parsed.frontmatter as Record<string, unknown>;
		expect(fm.openapi).toBe("3.0.0");
		expect(fm.foo).toBe("bar");
	});

	test("swagger 2.0 falls through to opaque YAML emission", () => {
		const yaml = `swagger: "2.0"
info:
  title: Old
  version: "1"
paths:
  /x:
    get:
      responses:
        "200":
          description: ok
`;
		const parsed = parseYamlFile(yaml, "x.yaml");
		// Opaque emission — no synthesized operations.
		expect(parsed.headings).toEqual([]);
		// Opaque YAML now emits a whole-source preamble so
		// computeFileMetrics (scanner.ts) counts body tokens.
		expect(parsed.preamble?.offsetRange).toEqual({ start: 0, end: yaml.length });
		// But frontmatter still carries the whole document.
		const fm = parsed.frontmatter as Record<string, unknown>;
		expect(fm.swagger).toBe("2.0");
	});
});

describe("synthesizeOpenApiFile — components section", () => {
	test("components.schemas content appears in synthesized source (free-text searchable)", () => {
		// Without the Components section, `petCategory` lives only under
		// `components.schemas.Pet` — not in any synthesized operation — so
		// `search({query:"petCategory"})` would miss content present in the
		// YAML. Regression guard for the dedicated components fence.
		const yaml = `openapi: "3.0.0"
info: { title: T, version: "1" }
paths:
  /pets:
    get: { responses: { "200": { description: ok } } }
components:
  schemas:
    Pet:
      type: object
      properties:
        petCategory: { type: string }
        petName: { type: string }
`;
		const parsed = parseYamlFile(yaml, "x.yaml");
		expect(parsed.source).toContain("## Components\n");
		expect(parsed.source).toContain("petCategory");
		expect(parsed.source).toContain("petName");
	});

	test("Components heading has structuralPath 'components' (literal slot)", () => {
		const yaml = `openapi: "3.0.0"
info: { title: T, version: "1" }
paths: {}
components:
  schemas:
    Pet: { type: object }
`;
		const parsed = parseYamlFile(yaml, "x.yaml");
		const comp = parsed.headings.find((h) => h.pathText === "Components");
		if (!comp) throw new Error("expected Components heading");
		expect(comp.structuralPath).toBe("components");
		expect(comp.level).toBe(2);
		expect(comp.headingPath).toEqual(["Components"]);
	});

	test("components fence is in excludedRanges (routes to code FTS column)", () => {
		const yaml = `openapi: "3.0.0"
info: { title: T, version: "1" }
paths:
  /x:
    get: { responses: { "200": { description: ok } } }
components:
  schemas:
    Pet: { type: object }
`;
		const parsed = parseYamlFile(yaml, "x.yaml");
		// 1 operation fence + 1 components fence = 2 excluded ranges.
		expect(parsed.excludedRanges.length).toBe(2);
		const compRange = parsed.excludedRanges[1];
		if (!compRange) throw new Error("expected components excluded range");
		const slice = parsed.source.slice(compRange.offsetStart, compRange.offsetEnd);
		expect(slice.startsWith("```json")).toBe(true);
		expect(slice).toContain('"Pet"');
	});

	test("missing components → no Components heading", () => {
		const yaml = `openapi: "3.0.0"
info: { title: T, version: "1" }
paths:
  /x:
    get: { responses: { "200": { description: ok } } }
`;
		const parsed = parseYamlFile(yaml, "x.yaml");
		expect(parsed.headings.find((h) => h.pathText === "Components")).toBeUndefined();
		expect(parsed.source).not.toContain("## Components");
	});

	test("empty components {} → no Components heading", () => {
		const yaml = `openapi: "3.0.0"
info: { title: T, version: "1" }
paths: {}
components: {}
`;
		const parsed = parseYamlFile(yaml, "x.yaml");
		expect(parsed.headings.find((h) => h.pathText === "Components")).toBeUndefined();
	});

	test("oversized components → JSON fence truncates with elision text", () => {
		// 500 × ~270-byte schemas > 64 KiB fence cap — same cap as operations
		// (`stringifyJsonForFence` MAX_FENCE_JSON_BYTES).
		const big: Record<string, unknown> = {};
		for (let i = 0; i < 500; i++) {
			big[`Schema${i}`] = { type: "object", description: "x".repeat(200) };
		}
		const yaml = `openapi: "3.0.0"
info: { title: T, version: "1" }
paths: {}
components:
  schemas: ${JSON.stringify(big)}
`;
		const parsed = parseYamlFile(yaml, "x.yaml");
		const comp = parsed.headings.find((h) => h.pathText === "Components");
		if (!comp) throw new Error("expected Components heading");
		const body = parsed.source.slice(comp.bodyOffsetRange.start, comp.bodyOffsetRange.end);
		expect(body).toContain("truncated;");
		// Truncated payload is no longer valid JSON; the fence language
		// drops to `text` so agents calling `JSON.parse` on the fence
		// body don't fail.
		expect(body).toContain("```text\n");
		expect(body).not.toContain("```json\n");
	});
});

describe("synthesizeOpenApiFile — spec metadata section", () => {
	test("non-rendered top-level fields (servers, externalDocs, security) reach source via spec-metadata", () => {
		// Without the spec-metadata catch-all, content under any top-level
		// key besides info/paths/components stays in frontmatter (for
		// nested-path filters) but drops from synthesized source, so
		// free-text search would miss it. Regression guard for the
		// catch-all fence.
		const yaml = `openapi: "3.0.0"
info: { title: T, version: "1" }
servers:
  - url: https://api.example.com
    description: Production
externalDocs:
  url: https://docs.example.com/api
  description: Full API reference
security:
  - bearerAuth: []
paths:
  /x:
    get: { responses: { "200": { description: ok } } }
`;
		const parsed = parseYamlFile(yaml, "x.yaml");
		expect(parsed.source).toContain("## Spec metadata\n");
		expect(parsed.source).toContain("api.example.com");
		expect(parsed.source).toContain("Production");
		expect(parsed.source).toContain("docs.example.com");
		expect(parsed.source).toContain("Full API reference");
		expect(parsed.source).toContain("bearerAuth");
	});

	test("tag descriptions land in source (preamble only carries names)", () => {
		const yaml = `openapi: "3.0.0"
info: { title: T, version: "1" }
tags:
  - name: pets
    description: Operations on pets and their breeds
paths:
  /x:
    get: { responses: { "200": { description: ok } } }
`;
		const parsed = parseYamlFile(yaml, "x.yaml");
		// Name still appears in the prose preamble (`renderPreamble`).
		expect(parsed.source).toContain("Tags: pets");
		// Description now lands via the spec-metadata JSON fence.
		expect(parsed.source).toContain("Operations on pets and their breeds");
	});

	test("Spec metadata heading has structuralPath 'spec_metadata' (literal slot)", () => {
		const yaml = `openapi: "3.0.0"
info: { title: T, version: "1" }
servers:
  - url: https://api.example.com
paths: {}
`;
		const parsed = parseYamlFile(yaml, "x.yaml");
		const meta = parsed.headings.find((h) => h.pathText === "Spec metadata");
		if (!meta) throw new Error("expected Spec metadata heading");
		expect(meta.structuralPath).toBe("spec_metadata");
		expect(meta.level).toBe(2);
		expect(meta.headingPath).toEqual(["Spec metadata"]);
	});

	test("spec-metadata fence is in excludedRanges (routes to code FTS column)", () => {
		const yaml = `openapi: "3.0.0"
info: { title: T, version: "1" }
servers:
  - url: https://api.example.com
paths: {}
`;
		const parsed = parseYamlFile(yaml, "x.yaml");
		// No operations, no components — only the spec-metadata fence.
		expect(parsed.excludedRanges.length).toBe(1);
		const range = parsed.excludedRanges[0];
		if (!range) throw new Error("expected spec-metadata excluded range");
		const slice = parsed.source.slice(range.offsetStart, range.offsetEnd);
		expect(slice.startsWith("```json")).toBe(true);
		expect(slice).toContain("api.example.com");
	});

	test("only info/paths/components present → no Spec metadata heading", () => {
		const yaml = `openapi: "3.0.0"
info: { title: T, version: "1" }
paths:
  /x:
    get: { responses: { "200": { description: ok } } }
components:
  schemas:
    X: { type: object }
`;
		const parsed = parseYamlFile(yaml, "x.yaml");
		expect(parsed.headings.find((h) => h.pathText === "Spec metadata")).toBeUndefined();
		expect(parsed.source).not.toContain("## Spec metadata");
	});

	test("spec metadata fence excludes info/paths/components subtrees (no duplication)", () => {
		// The catch-all must NOT redundantly include keys that already have
		// dedicated emission; otherwise the JSON fence balloons with the
		// entire info/paths/components subtree and operation/components
		// prose appears twice in `code`.
		const yaml = `openapi: "3.0.0"
info: { title: T, version: "1", description: SHOULD_NOT_DUPLICATE_INFO }
servers:
  - url: https://api.example.com
paths:
  /x:
    get: { summary: SHOULD_NOT_DUPLICATE_PATH, responses: { "200": { description: ok } } }
components:
  schemas:
    X: { description: SHOULD_NOT_DUPLICATE_COMPONENT }
`;
		const parsed = parseYamlFile(yaml, "x.yaml");
		const meta = parsed.headings.find((h) => h.pathText === "Spec metadata");
		if (!meta) throw new Error("expected Spec metadata heading");
		const body = parsed.source.slice(meta.bodyOffsetRange.start, meta.bodyOffsetRange.end);
		expect(body).toContain("api.example.com");
		expect(body).not.toContain("SHOULD_NOT_DUPLICATE_INFO");
		expect(body).not.toContain("SHOULD_NOT_DUPLICATE_PATH");
		expect(body).not.toContain("SHOULD_NOT_DUPLICATE_COMPONENT");
	});

	test("oversized spec metadata → JSON fence truncates with elision text", () => {
		// 500 × ~270-byte tag entries > 64 KiB cap (same cap as operations /
		// components via `stringifyJsonForFence`).
		const tags: Array<Record<string, unknown>> = [];
		for (let i = 0; i < 500; i++) {
			tags.push({ name: `tag${i}`, description: "x".repeat(200) });
		}
		const yaml = `openapi: "3.0.0"
info: { title: T, version: "1" }
paths: {}
tags: ${JSON.stringify(tags)}
`;
		const parsed = parseYamlFile(yaml, "x.yaml");
		const meta = parsed.headings.find((h) => h.pathText === "Spec metadata");
		if (!meta) throw new Error("expected Spec metadata heading");
		const body = parsed.source.slice(meta.bodyOffsetRange.start, meta.bodyOffsetRange.end);
		expect(body).toContain("truncated;");
		// Same correctness contract as the components-truncation test:
		// truncated payload drops to `text` so agents can't `JSON.parse`
		// invalid JSON.
		expect(body).toContain("```text\n");
		expect(body).not.toContain("```json\n");
	});

	test("info residuals reach source — license, contact, termsOfService, x-* extension", () => {
		// Without residual extraction the whole `info` subtree filters out of
		// the catch-all, so license / contact / termsOfService / extensions
		// are unreachable via free-text search even though frontmatter still
		// carries them. Regression guard against re-tightening the gate.
		const yaml = `openapi: "3.0.0"
info:
  title: T
  version: "1"
  description: prose
  termsOfService: https://example.com/terms
  contact:
    name: Support Team
    email: support@example.com
  license:
    name: Apache-2.0
    url: https://www.apache.org/licenses/LICENSE-2.0
  x-internal-id: api-platform-42
paths:
  /x:
    get: { responses: { "200": { description: ok } } }
`;
		const parsed = parseYamlFile(yaml, "x.yaml");
		const meta = parsed.headings.find((h) => h.pathText === "Spec metadata");
		if (!meta) throw new Error("expected Spec metadata heading");
		const body = parsed.source.slice(meta.bodyOffsetRange.start, meta.bodyOffsetRange.end);
		expect(body).toContain("Support Team");
		expect(body).toContain("support@example.com");
		expect(body).toContain("Apache-2.0");
		expect(body).toContain("example.com/terms");
		expect(body).toContain("api-platform-42");
		// title / version / description are already in the preamble — must
		// not duplicate via the residual.
		expect(body).not.toContain('"title"');
		expect(body).not.toContain('"version"');
		expect(body).not.toContain('"description":"prose"');
	});

	test("path-item residuals reach source — description, summary, servers, x-* extension", () => {
		// Without residual extraction the `paths` subtree filters wholesale;
		// path-item-level metadata (description / summary / servers / x-*)
		// then never reaches FTS. Regression guard against re-tightening.
		const yaml = `openapi: "3.0.0"
info: { title: T, version: "1" }
paths:
  /pets:
    summary: Pet collection endpoints
    description: All operations on the pet inventory
    servers:
      - url: https://pets.api.example.com
    x-rate-tier: premium
    get: { responses: { "200": { description: ok } } }
`;
		const parsed = parseYamlFile(yaml, "x.yaml");
		const meta = parsed.headings.find((h) => h.pathText === "Spec metadata");
		if (!meta) throw new Error("expected Spec metadata heading");
		const body = parsed.source.slice(meta.bodyOffsetRange.start, meta.bodyOffsetRange.end);
		expect(body).toContain("Pet collection endpoints");
		expect(body).toContain("All operations on the pet inventory");
		expect(body).toContain("pets.api.example.com");
		expect(body).toContain("premium");
		// Operation under /pets.get is already emitted with its own heading
		// + JSON fence — the path residual must strip method keys to avoid
		// duplication.
		expect(body).not.toContain('"get"');
		expect(body).not.toContain('"responses"');
	});

	test("paths.x-* (top-level paths extension) reaches source as-is", () => {
		// `paths` accepts ^x- extensions at the top level (non-object values).
		// `extractPathsResidual` preserves them verbatim so they reach FTS.
		const yaml = `openapi: "3.0.0"
info: { title: T, version: "1" }
paths:
  x-paths-policy: deprecated-v1
  /x:
    get: { responses: { "200": { description: ok } } }
`;
		const parsed = parseYamlFile(yaml, "x.yaml");
		const meta = parsed.headings.find((h) => h.pathText === "Spec metadata");
		if (!meta) throw new Error("expected Spec metadata heading");
		const body = parsed.source.slice(meta.bodyOffsetRange.start, meta.bodyOffsetRange.end);
		expect(body).toContain("deprecated-v1");
	});

	test("info with only rendered subfields → no `info` residual in spec-metadata", () => {
		// `info` has only title/version/description — all rendered in the
		// preamble. `extractInfoResidual` returns null so the catch-all
		// omits an empty `info: {}` payload.
		const yaml = `openapi: "3.0.0"
info: { title: T, version: "1", description: prose }
servers:
  - url: https://api.example.com
paths:
  /x:
    get: { responses: { "200": { description: ok } } }
`;
		const parsed = parseYamlFile(yaml, "x.yaml");
		const meta = parsed.headings.find((h) => h.pathText === "Spec metadata");
		if (!meta) throw new Error("expected Spec metadata heading");
		const body = parsed.source.slice(meta.bodyOffsetRange.start, meta.bodyOffsetRange.end);
		expect(body).toContain("api.example.com");
		expect(body).not.toContain('"info"');
	});

	test("paths with only operations → no `paths` residual in spec-metadata", () => {
		// Every path-item is operations-only. Each path's residual is null,
		// and the overall paths residual is null too — the catch-all omits
		// the `paths` key entirely.
		const yaml = `openapi: "3.0.0"
info: { title: T, version: "1" }
servers:
  - url: https://api.example.com
paths:
  /a:
    get: { responses: { "200": { description: ok } } }
  /b:
    post: { responses: { "201": { description: created } } }
`;
		const parsed = parseYamlFile(yaml, "x.yaml");
		const meta = parsed.headings.find((h) => h.pathText === "Spec metadata");
		if (!meta) throw new Error("expected Spec metadata heading");
		const body = parsed.source.slice(meta.bodyOffsetRange.start, meta.bodyOffsetRange.end);
		expect(body).toContain("api.example.com");
		expect(body).not.toContain('"paths"');
		expect(body).not.toContain('"/a"');
		expect(body).not.toContain('"/b"');
	});

	test("non-truncated fence keeps `json` language", () => {
		// Companion to the truncation tests: small payload should stay
		// tagged ```json so IDEs / agents recognize the format.
		const yaml = `openapi: "3.0.0"
info: { title: T, version: "1" }
servers:
  - url: https://api.example.com
paths: {}
`;
		const parsed = parseYamlFile(yaml, "x.yaml");
		const meta = parsed.headings.find((h) => h.pathText === "Spec metadata");
		if (!meta) throw new Error("expected Spec metadata heading");
		const body = parsed.source.slice(meta.bodyOffsetRange.start, meta.bodyOffsetRange.end);
		expect(body).toContain("```json\n");
		expect(body).not.toContain("```text\n");
	});
});

// ─────────────────────────────────────────────────────────────────────
// Webhooks (3.1) per-operation headings.
// ─────────────────────────────────────────────────────────────────────

const isWebhookHeading = (h: { structuralPath: string }): boolean => h.structuralPath.startsWith("webhook[");

describe("synthesizeOpenApiFile — webhooks (3.1)", () => {
	const WEBHOOK_YAML = `openapi: "3.1.0"
info:
  title: Shipping Events API
  version: "2.0"
paths:
  /orders:
    get:
      summary: List orders
      responses:
        "200":
          description: ok
webhooks:
  shipment.created:
    post:
      summary: A new shipment was created
      description: Sent when an order ships.
      requestBody:
        description: Shipment payload
      responses:
        "200":
          description: ack
  shipment.delivered:
    post:
      summary: Shipment delivered
      responses:
        "200":
          description: ack
    delete:
      summary: Cancel notification subscription
      responses:
        "204":
          description: gone
`;

	test("emits one heading per webhook (name × method) with webhook[...] slot prefix", () => {
		const parsed = parseYamlFile(WEBHOOK_YAML, "api/spec.yaml");
		const webhookHeadings = parsed.headings.filter(isWebhookHeading);
		// shipment.created has POST only; shipment.delivered has POST + DELETE
		// (canonical method order is get, put, post, delete, options, head,
		// patch, trace — POST precedes DELETE).
		expect(webhookHeadings.map((h) => h.pathText)).toEqual([
			"Webhook: shipment.created POST",
			"Webhook: shipment.delivered POST",
			"Webhook: shipment.delivered DELETE",
		]);
		for (const h of webhookHeadings) {
			expect(h.structuralPath).toMatch(/^webhook\[[0-9a-f]{14}\]$/);
			expect(h.level).toBe(2);
		}
	});

	test("webhook ops coexist with path ops; both addressable independently", () => {
		const parsed = parseYamlFile(WEBHOOK_YAML, "api/spec.yaml");
		const opHeadings = parsed.headings.filter((h) => h.structuralPath.startsWith("op["));
		const webhookHeadings = parsed.headings.filter(isWebhookHeading);
		expect(opHeadings.length).toBe(1);
		expect(webhookHeadings.length).toBe(3);
		const opIds = new Set([...opHeadings, ...webhookHeadings].map((h) => h.stable_id));
		// 4 sections → 4 distinct stable_ids; prefix disambiguator prevents collision.
		expect(opIds.size).toBe(4);
	});

	test("webhook prose body contains summary + description", () => {
		const parsed = parseYamlFile(WEBHOOK_YAML, "api/spec.yaml");
		const created = parsed.headings.find((h) => h.pathText === "Webhook: shipment.created POST");
		if (!created) throw new Error("expected shipment.created webhook heading");
		const body = parsed.source.slice(created.bodyOffsetRange.start, created.bodyOffsetRange.end);
		expect(body).toContain("Summary: A new shipment was created");
		expect(body).toContain("Sent when an order ships.");
	});

	test("webhook section is followed by JSON fence routed to excludedRanges", () => {
		const parsed = parseYamlFile(WEBHOOK_YAML, "api/spec.yaml");
		const created = parsed.headings.find((h) => h.pathText === "Webhook: shipment.created POST");
		if (!created) throw new Error("expected shipment.created webhook heading");
		const body = parsed.source.slice(created.bodyOffsetRange.start, created.bodyOffsetRange.end);
		expect(body).toContain("```json\n");
		// At least one excludedRange overlaps the webhook body range.
		const webhookExcluded = parsed.excludedRanges.filter(
			(r) => r.offsetStart >= created.bodyOffsetRange.start && r.offsetEnd <= created.bodyOffsetRange.end,
		);
		expect(webhookExcluded.length).toBeGreaterThan(0);
	});

	test("method-only webhooks contribute nothing to Spec metadata (no duplication with per-op sections)", () => {
		// WEBHOOK_YAML has no PathItem-level fields, so extractPathItemMapResidual
		// returns null per item — empty residual, no `webhooks` entry in the
		// catch-all fence even when it's emitted for other reasons.
		const parsed = parseYamlFile(WEBHOOK_YAML, "api/spec.yaml");
		const meta = parsed.headings.find((h) => h.pathText === "Spec metadata");
		if (meta) {
			const body = parsed.source.slice(meta.bodyOffsetRange.start, meta.bodyOffsetRange.end);
			expect(body).not.toContain("shipment.created");
			expect(body).not.toContain("shipment.delivered");
		}
	});

	test("webhook path-item-level parameters inherit into method operations", () => {
		// Mirrors the existing path-item param inheritance test for paths.
		const yaml = `openapi: "3.1.0"
info: { title: T, version: "1" }
paths: {}
webhooks:
  audit:
    parameters:
      - name: X-Source
        in: header
        description: Caller hint
    post:
      summary: Audit event
      responses:
        "200":
          description: ack
`;
		const parsed = parseYamlFile(yaml, "api/spec.yaml");
		const audit = parsed.headings.find((h) => h.pathText === "Webhook: audit POST");
		if (!audit) throw new Error("expected audit webhook heading");
		const body = parsed.source.slice(audit.bodyOffsetRange.start, audit.bodyOffsetRange.end);
		expect(body).toContain("- X-Source (header): Caller hint");
	});

	test("spec with webhooks ONLY (no paths) still synthesizes", () => {
		const yaml = `openapi: "3.1.0"
info: { title: T, version: "1" }
paths: {}
webhooks:
  ping:
    post:
      summary: Health ping
      responses:
        "200":
          description: pong
`;
		const parsed = parseYamlFile(yaml, "api/spec.yaml");
		// hasPrimaryContent OR's webhooks.length > 0 — file synthesizes
		// instead of falling back to opaque YAML.
		const headings = parsed.headings.filter(isWebhookHeading);
		expect(headings.length).toBe(1);
		expect(headings[0]?.pathText).toBe("Webhook: ping POST");
	});

	test("3.0 spec with no webhooks key is unchanged (no webhook headings)", () => {
		const parsed = parseYamlFile(PETSTORE_YAML, "api/spec.yaml");
		const webhooks = parsed.headings.filter(isWebhookHeading);
		expect(webhooks.length).toBe(0);
	});
});

// ─────────────────────────────────────────────────────────────────────
// Per-op prose enrichment (deprecated, externalDocs, security,
// servers, callbacks).
// ─────────────────────────────────────────────────────────────────────

describe("synthesizeOpenApiFile — per-op prose enrichment", () => {
	test("`deprecated: true` emits a Deprecated line", () => {
		const yaml = `openapi: "3.0.0"
info: { title: T, version: "1" }
paths:
  /old:
    get:
      summary: legacy
      deprecated: true
      responses: { "200": { description: ok } }
  /new:
    get:
      summary: shiny
      responses: { "200": { description: ok } }
`;
		const parsed = parseYamlFile(yaml, "spec.yaml");
		const old = parsed.headings.find((h) => h.pathText === "GET /old");
		const fresh = parsed.headings.find((h) => h.pathText === "GET /new");
		if (!old || !fresh) throw new Error("missing headings");
		const oldBody = parsed.source.slice(old.bodyOffsetRange.start, old.bodyOffsetRange.end);
		const newBody = parsed.source.slice(fresh.bodyOffsetRange.start, fresh.bodyOffsetRange.end);
		expect(oldBody).toContain("Deprecated: yes");
		expect(newBody).not.toContain("Deprecated:");
	});

	test("externalDocs emits description + URL", () => {
		const yaml = `openapi: "3.0.0"
info: { title: T, version: "1" }
paths:
  /x:
    get:
      summary: x
      externalDocs:
        description: Pet model reference
        url: https://example.com/docs/pets
      responses: { "200": { description: ok } }
`;
		const parsed = parseYamlFile(yaml, "spec.yaml");
		const x = parsed.headings.find((h) => h.pathText === "GET /x");
		if (!x) throw new Error("missing heading");
		const body = parsed.source.slice(x.bodyOffsetRange.start, x.bodyOffsetRange.end);
		expect(body).toContain("External docs: Pet model reference — https://example.com/docs/pets");
	});

	test("externalDocs with url only (no description) still emits", () => {
		const yaml = `openapi: "3.0.0"
info: { title: T, version: "1" }
paths:
  /x:
    get:
      summary: x
      externalDocs:
        url: https://example.com/raw
      responses: { "200": { description: ok } }
`;
		const parsed = parseYamlFile(yaml, "spec.yaml");
		const x = parsed.headings.find((h) => h.pathText === "GET /x");
		if (!x) throw new Error("missing heading");
		const body = parsed.source.slice(x.bodyOffsetRange.start, x.bodyOffsetRange.end);
		expect(body).toContain("External docs: https://example.com/raw");
	});

	test("security emits scheme + scope list", () => {
		const yaml = `openapi: "3.0.0"
info: { title: T, version: "1" }
paths:
  /x:
    get:
      summary: x
      security:
        - oauth2: [read:pets, write:pets]
        - apiKey: []
      responses: { "200": { description: ok } }
`;
		const parsed = parseYamlFile(yaml, "spec.yaml");
		const x = parsed.headings.find((h) => h.pathText === "GET /x");
		if (!x) throw new Error("missing heading");
		const body = parsed.source.slice(x.bodyOffsetRange.start, x.bodyOffsetRange.end);
		expect(body).toContain("Security: oauth2(read:pets, write:pets) | apiKey");
	});

	test("empty security requirement object renders as `none`", () => {
		// Per OpenAPI: `security: [{}]` means "no auth required" — override.
		const yaml = `openapi: "3.0.0"
info: { title: T, version: "1" }
paths:
  /public:
    get:
      summary: open
      security:
        - {}
      responses: { "200": { description: ok } }
`;
		const parsed = parseYamlFile(yaml, "spec.yaml");
		const op = parsed.headings.find((h) => h.pathText === "GET /public");
		if (!op) throw new Error("missing heading");
		const body = parsed.source.slice(op.bodyOffsetRange.start, op.bodyOffsetRange.end);
		expect(body).toContain("Security: none");
	});

	test("op-level servers[] emits URL list", () => {
		const yaml = `openapi: "3.0.0"
info: { title: T, version: "1" }
paths:
  /x:
    get:
      summary: x
      servers:
        - url: https://us.api.example.com
        - url: https://eu.api.example.com
      responses: { "200": { description: ok } }
`;
		const parsed = parseYamlFile(yaml, "spec.yaml");
		const x = parsed.headings.find((h) => h.pathText === "GET /x");
		if (!x) throw new Error("missing heading");
		const body = parsed.source.slice(x.bodyOffsetRange.start, x.bodyOffsetRange.end);
		expect(body).toContain("Servers: https://us.api.example.com, https://eu.api.example.com");
	});

	test("callbacks emits names only", () => {
		const yaml = `openapi: "3.0.0"
info: { title: T, version: "1" }
paths:
  /subscribe:
    post:
      summary: subscribe
      callbacks:
        onComplete: { "{$request.body#/url}": { post: { responses: { "200": { description: ok } } } } }
        onFailure: { "{$request.body#/url}": { post: { responses: { "200": { description: ok } } } } }
      responses: { "200": { description: ok } }
`;
		const parsed = parseYamlFile(yaml, "spec.yaml");
		const sub = parsed.headings.find((h) => h.pathText === "POST /subscribe");
		if (!sub) throw new Error("missing heading");
		const body = parsed.source.slice(sub.bodyOffsetRange.start, sub.bodyOffsetRange.end);
		expect(body).toContain("Callbacks: onComplete, onFailure");
	});

	test("absent enrichment fields emit nothing", () => {
		// Same as PETSTORE_YAML — verify no spurious "Deprecated:" / "External docs:" / etc.
		const parsed = parseYamlFile(PETSTORE_YAML, "spec.yaml");
		const get = parsed.headings.find((h) => h.pathText === "GET /pets");
		if (!get) throw new Error("missing heading");
		const body = parsed.source.slice(get.bodyOffsetRange.start, get.bodyOffsetRange.end);
		expect(body).not.toContain("Deprecated:");
		expect(body).not.toContain("External docs:");
		expect(body).not.toContain("Security:");
		expect(body).not.toContain("Servers:");
		expect(body).not.toContain("Callbacks:");
	});

	test("webhook ops receive the same prose enrichment via shared renderer", () => {
		const yaml = `openapi: "3.1.0"
info: { title: T, version: "1" }
paths: {}
webhooks:
  retired:
    post:
      summary: legacy hook
      deprecated: true
      responses: { "200": { description: ok } }
`;
		const parsed = parseYamlFile(yaml, "spec.yaml");
		const hook = parsed.headings.find((h) => h.pathText === "Webhook: retired POST");
		if (!hook) throw new Error("missing webhook heading");
		const body = parsed.source.slice(hook.bodyOffsetRange.start, hook.bodyOffsetRange.end);
		expect(body).toContain("Deprecated: yes");
	});

	test("inferContentKinds promotes to `list` when security/callbacks present", () => {
		const yaml = `openapi: "3.0.0"
info: { title: T, version: "1" }
paths:
  /x:
    get:
      summary: x
      security:
        - apiKey: []
      responses: { "200": { description: ok } }
`;
		const parsed = parseYamlFile(yaml, "spec.yaml");
		const x = parsed.headings.find((h) => h.pathText === "GET /x");
		if (!x) throw new Error("missing heading");
		expect(x.contentKinds).toContain("code");
		expect(x.contentKinds).toContain("list");
	});
});

// ─────────────────────────────────────────────────────────────────────
// operationId-keyed slot (auto-detect).
// ─────────────────────────────────────────────────────────────────────

describe("synthesizeOpenApiFile — operationId-keyed slot", () => {
	test("op with unique operationId uses operationId-derived slot", () => {
		const yamlA = `openapi: "3.0.0"
info: { title: T, version: "1" }
paths:
  /v1/pets:
    get:
      operationId: listPets
      summary: list
      responses: { "200": { description: ok } }
`;
		const yamlB = `openapi: "3.0.0"
info: { title: T, version: "1" }
paths:
  /v2/animals:
    get:
      operationId: listPets
      summary: list
      responses: { "200": { description: ok } }
`;
		const parsedA = parseYamlFile(yamlA, "spec.yaml");
		const parsedB = parseYamlFile(yamlB, "spec.yaml");
		const slotA = parsedA.headings.filter(isOperationHeading)[0]?.structuralPath;
		const slotB = parsedB.headings.filter(isOperationHeading)[0]?.structuralPath;
		// Path differs but operationId is the same → slot survives the rename.
		expect(slotA).toBeDefined();
		expect(slotA).toBe(slotB);
	});

	test("op without operationId falls back to path-hash slot", () => {
		const yaml = `openapi: "3.0.0"
info: { title: T, version: "1" }
paths:
  /noop:
    get:
      summary: bare
      responses: { "200": { description: ok } }
`;
		const parsed = parseYamlFile(yaml, "spec.yaml");
		const slot = parsed.headings.filter(isOperationHeading)[0]?.structuralPath;
		expect(slot).toMatch(/^op\[[0-9a-f]{14}\]$/);
	});

	test("duplicate operationId across paths falls back to path-hash for both", () => {
		const yaml = `openapi: "3.0.0"
info: { title: T, version: "1" }
paths:
  /a:
    get:
      operationId: shared
      responses: { "200": { description: ok } }
  /b:
    get:
      operationId: shared
      responses: { "200": { description: ok } }
`;
		const parsed = parseYamlFile(yaml, "spec.yaml");
		const ops = parsed.headings.filter(isOperationHeading);
		expect(ops.length).toBe(2);
		// Both slots are distinct (different paths produce different hashes
		// when the operationId fallback fires for both).
		expect(ops[0]?.stable_id).not.toBe(ops[1]?.stable_id);
		// And the slots are NOT what you'd get from operationId hash —
		// they're heading-text hashes. Re-derive both schemes and assert
		// the slots are the heading-text variant.
		// (Indirect: simply asserting the duplicate doesn't override is
		// enough — if the duplicate-fallback didn't fire we'd get
		// identical slots which the prior expect catches.)
	});

	test("collision between path-op and webhook-op operationIds is detected across both pools", () => {
		const yaml = `openapi: "3.1.0"
info: { title: T, version: "1" }
paths:
  /pets:
    get:
      operationId: notify
      responses: { "200": { description: ok } }
webhooks:
  petCreated:
    post:
      operationId: notify
      responses: { "200": { description: ok } }
`;
		const parsed = parseYamlFile(yaml, "spec.yaml");
		const op = parsed.headings.find((h) => h.pathText === "GET /pets");
		const hook = parsed.headings.find((h) => h.pathText === "Webhook: petCreated POST");
		if (!op || !hook) throw new Error("missing headings");
		// Both fall back to heading-text hash because operationId collides
		// across pools. Slot prefix differs (`op[` vs `webhook[`) so they
		// remain distinguishable.
		expect(op.structuralPath.startsWith("op[")).toBe(true);
		expect(hook.structuralPath.startsWith("webhook[")).toBe(true);
		expect(op.stable_id).not.toBe(hook.stable_id);
	});

	test("operationId values matching singleton section names cannot collide with singleton stable_ids", () => {
		// Guard against any future stable-id normalization path that might
		// strip `op[...]`/`webhook[...]` wrappers before hashing.
		const yaml = `openapi: "3.1.0"
info: { title: T, version: "1" }
paths:
  /a:
    get:
      operationId: components
      responses: { "200": { description: ok } }
webhooks:
  audit:
    post:
      operationId: spec_metadata
      responses: { "200": { description: ok } }
components:
  schemas:
    Thing: { type: object }
x-extra: keep-spec-metadata
`;
		const parsed = parseYamlFile(yaml, "spec.yaml");
		const pathOp = parsed.headings.find((h) => h.pathText === "GET /a");
		const hookOp = parsed.headings.find((h) => h.pathText === "Webhook: audit POST");
		const components = parsed.headings.find((h) => h.pathText === "Components");
		const specMeta = parsed.headings.find((h) => h.pathText === "Spec metadata");
		if (!pathOp || !hookOp || !components || !specMeta) {
			throw new Error("missing expected headings");
		}

		expect(pathOp.structuralPath).toMatch(/^op\[[0-9a-f]{14}\]$/);
		expect(hookOp.structuralPath).toMatch(/^webhook\[[0-9a-f]{14}\]$/);
		expect(components.structuralPath).toBe("components");
		expect(specMeta.structuralPath).toBe("spec_metadata");

		expect(pathOp.stable_id).not.toBe(components.stable_id);
		expect(pathOp.stable_id).not.toBe(specMeta.stable_id);
		expect(hookOp.stable_id).not.toBe(components.stable_id);
		expect(hookOp.stable_id).not.toBe(specMeta.stable_id);
		expect(new Set(parsed.headings.map((h) => h.stable_id)).size).toBe(parsed.headings.length);
	});

	test("operationId rename retires the old slot (different stable_id)", () => {
		const before = `openapi: "3.0.0"
info: { title: T, version: "1" }
paths:
  /x:
    get:
      operationId: oldName
      responses: { "200": { description: ok } }
`;
		const after = `openapi: "3.0.0"
info: { title: T, version: "1" }
paths:
  /x:
    get:
      operationId: newName
      responses: { "200": { description: ok } }
`;
		const a = parseYamlFile(before, "spec.yaml");
		const b = parseYamlFile(after, "spec.yaml");
		expect(a.headings.filter(isOperationHeading)[0]?.stable_id).not.toBe(
			b.headings.filter(isOperationHeading)[0]?.stable_id,
		);
	});

	test("removing operationId reverts slot to path-hash", () => {
		const withId = `openapi: "3.0.0"
info: { title: T, version: "1" }
paths:
  /x:
    get:
      operationId: x
      responses: { "200": { description: ok } }
`;
		const withoutId = `openapi: "3.0.0"
info: { title: T, version: "1" }
paths:
  /x:
    get:
      responses: { "200": { description: ok } }
`;
		const a = parseYamlFile(withId, "spec.yaml");
		const b = parseYamlFile(withoutId, "spec.yaml");
		const aSlot = a.headings.filter(isOperationHeading)[0]?.structuralPath;
		const bSlot = b.headings.filter(isOperationHeading)[0]?.structuralPath;
		expect(aSlot).not.toBe(bSlot);
		// New slot must be the path-hash form (today's scheme), since
		// adding the operationId BACK should re-derive the same `aSlot`.
		const c = parseYamlFile(withId, "spec.yaml");
		expect(c.headings.filter(isOperationHeading)[0]?.structuralPath).toBe(aSlot);
	});

	test("operationId with exotic characters hashes cleanly (no validation regex)", () => {
		// Hash absorbs any input; no character class enforced.
		const yaml = `openapi: "3.0.0"
info: { title: T, version: "1" }
paths:
  /x:
    get:
      operationId: "weird id with spaces & symbols!"
      responses: { "200": { description: ok } }
`;
		const parsed = parseYamlFile(yaml, "spec.yaml");
		const slot = parsed.headings.filter(isOperationHeading)[0]?.structuralPath;
		expect(slot).toMatch(/^op\[[0-9a-f]{14}\]$/);
	});

	test("path renames preserve slot when operationId stays the same", () => {
		// The headline motivation: code-generated specs move paths
		// frequently while preserving operationId.
		const beforeMove = `openapi: "3.0.0"
info: { title: T, version: "1" }
paths:
  /v1/pets:
    get:
      operationId: listPets
      responses: { "200": { description: ok } }
`;
		const afterMove = `openapi: "3.0.0"
info: { title: T, version: "1" }
paths:
  /api/v2/pets:
    get:
      operationId: listPets
      responses: { "200": { description: ok } }
`;
		const a = parseYamlFile(beforeMove, "spec.yaml");
		const b = parseYamlFile(afterMove, "spec.yaml");
		expect(a.headings.filter(isOperationHeading)[0]?.stable_id).toBe(
			b.headings.filter(isOperationHeading)[0]?.stable_id,
		);
	});
});

// ─────────────────────────────────────────────────────────────────────
// Prototype-pollution defense parity with AsyncAPI.
// ─────────────────────────────────────────────────────────────────────

/** Extract the body of the first ```json fence in a heading body slice. */
const extractJsonFenceBody = (body: string): string => {
	const match = /```json\n([\s\S]*?)\n```/.exec(body);
	if (!match?.[1]) throw new Error("expected json fence in body");
	return match[1];
};

describe("synthesizeOpenApiFile — prototype-pollution defense", () => {
	test("__proto__ inside components subtree is stripped from the Components fence", () => {
		const yaml = `openapi: "3.0.0"
info: { title: T, version: "1" }
paths: {}
components:
  schemas:
    Pet:
      type: object
      __proto__:
        leaked: "should not appear"
      properties:
        name:
          type: string
`;
		const parsed = parseYamlFile(yaml, "spec.yaml");
		const components = parsed.headings.find((h) => h.pathText === "Components");
		if (!components) throw new Error("expected Components heading");
		const body = parsed.source.slice(components.bodyOffsetRange.start, components.bodyOffsetRange.end);
		expect(body).not.toContain("leaked");
		// Direct prototype check: parse the fence and verify no __proto__ own data anywhere.
		const obj = JSON.parse(extractJsonFenceBody(body));
		expect(Object.hasOwn(obj.schemas.Pet, "__proto__")).toBe(false);
	});

	test("__proto__ as a bucket KEY in components is dropped (bucket layer is spec-defined)", () => {
		// Bucket names are spec-defined (schemas, responses, parameters, …
		// + x-* extensions). `__proto__` is never legitimate here, so a
		// hostile YAML's `components.__proto__:` must not surface in the
		// fence. User-named __proto__ one layer deeper (schema/response
		// name) is still preserved — see the SCHEMA NAME test below.
		const yaml = `openapi: "3.0.0"
info: { title: T, version: "1" }
paths: {}
components:
  __proto__:
    leakBucket: SECURITY_PAYLOAD
  schemas:
    Pet: { type: object }
`;
		const parsed = parseYamlFile(yaml, "spec.yaml");
		const components = parsed.headings.find((h) => h.pathText === "Components");
		if (!components) throw new Error("expected Components heading");
		const body = parsed.source.slice(components.bodyOffsetRange.start, components.bodyOffsetRange.end);
		expect(body).not.toContain('"__proto__"');
		expect(body).not.toContain("SECURITY_PAYLOAD");
		const obj = JSON.parse(extractJsonFenceBody(body));
		expect(Object.hasOwn(obj, "__proto__")).toBe(false);
		expect(obj.schemas.Pet.type).toBe("object");
	});

	test("responses with yaml-parsed __proto__ key drops the bullet from body prose", () => {
		const yaml = `openapi: "3.0.0"
info: { title: T, version: "1" }
paths:
  /x:
    get:
      summary: responses proto smuggle
      responses:
        "200": { description: ok }
        __proto__:
          description: SECURITY_PAYLOAD
`;
		const parsed = parseYamlFile(yaml, "spec.yaml");
		const op = parsed.headings.find((h) => h.pathText === "GET /x");
		if (!op) throw new Error("missing GET /x heading");
		const body = parsed.source.slice(op.bodyOffsetRange.start, op.bodyOffsetRange.end);
		expect(body).toContain("- 200: ok");
		expect(body).not.toMatch(/^- __proto__/m);
		expect(body).not.toContain("SECURITY_PAYLOAD");
	});

	test("callbacks with yaml-parsed __proto__ key preserves the name in Callbacks: prose", () => {
		const yaml = `openapi: "3.0.0"
info: { title: T, version: "1" }
paths:
  /x:
    get:
      summary: callbacks proto smuggle
      responses: { "200": { description: ok } }
      callbacks:
        onTick:
          "{$request.body#/url}":
            post:
              responses: { "200": { description: ack } }
        __proto__:
          "{$request.body#/url}":
            post:
              responses: { "200": { description: ack } }
`;
		const parsed = parseYamlFile(yaml, "spec.yaml");
		const op = parsed.headings.find((h) => h.pathText === "GET /x");
		if (!op) throw new Error("missing GET /x heading");
		const body = parsed.source.slice(op.bodyOffsetRange.start, op.bodyOffsetRange.end);
		expect(body).toMatch(/Callbacks:[^\n]*__proto__/);
		expect(body).toContain("onTick");
	});

	test("nested __proto__ inside info residual is stripped via spec-metadata sanitize", () => {
		const yaml = `openapi: "3.0.0"
info:
  title: T
  version: "1"
  contact:
    __proto__:
      pwn: "x"
    name: API Support
paths: {}
`;
		const parsed = parseYamlFile(yaml, "spec.yaml");
		const meta = parsed.headings.find((h) => h.pathText === "Spec metadata");
		if (!meta) throw new Error("expected Spec metadata heading");
		const body = parsed.source.slice(meta.bodyOffsetRange.start, meta.bodyOffsetRange.end);
		const obj = JSON.parse(extractJsonFenceBody(body));
		expect(Object.hasOwn(obj.info.contact, "__proto__")).toBe(false);
		expect(obj.info.contact.name).toBe("API Support");
	});

	test("__proto__ inside an array element (extension) is stripped", () => {
		// Array-walk extension — RFC 7396 says arrays atomic for MERGE
		// but SANITIZE must walk into elements.
		const yaml = `openapi: "3.0.0"
info: { title: T, version: "1" }
paths: {}
x-extras:
  - normal: ok
  - __proto__: { leak: bad }
    label: second
`;
		const parsed = parseYamlFile(yaml, "spec.yaml");
		const meta = parsed.headings.find((h) => h.pathText === "Spec metadata");
		if (!meta) throw new Error("expected Spec metadata heading");
		const body = parsed.source.slice(meta.bodyOffsetRange.start, meta.bodyOffsetRange.end);
		const obj = JSON.parse(extractJsonFenceBody(body));
		expect(Object.hasOwn(obj["x-extras"][1], "__proto__")).toBe(false);
		expect(obj["x-extras"][1].label).toBe("second");
	});

	test("nested __proto__ inside paths residual is stripped", () => {
		const yaml = `openapi: "3.0.0"
info: { title: T, version: "1" }
paths:
  /x:
    summary: path-level summary
    __proto__:
      pwn: leaked
    get:
      responses: { "200": { description: ok } }
`;
		const parsed = parseYamlFile(yaml, "spec.yaml");
		const meta = parsed.headings.find((h) => h.pathText === "Spec metadata");
		if (!meta) throw new Error("expected Spec metadata heading");
		const body = parsed.source.slice(meta.bodyOffsetRange.start, meta.bodyOffsetRange.end);
		const obj = JSON.parse(extractJsonFenceBody(body));
		// paths residual lives at obj.paths["/x"]; __proto__ stripped, summary kept.
		expect(Object.hasOwn(obj.paths["/x"], "__proto__")).toBe(false);
		expect(obj.paths["/x"].summary).toBe("path-level summary");
	});

	test("`constructor` is NOT in DANGEROUS_KEYS — JSON schema vocab passes through", () => {
		const yaml = `openapi: "3.0.0"
info: { title: T, version: "1" }
paths: {}
components:
  schemas:
    Thing:
      type: object
      properties:
        constructor:
          type: string
`;
		const parsed = parseYamlFile(yaml, "spec.yaml");
		const components = parsed.headings.find((h) => h.pathText === "Components");
		if (!components) throw new Error("expected Components heading");
		const body = parsed.source.slice(components.bodyOffsetRange.start, components.bodyOffsetRange.end);
		expect(body).toContain('"constructor"');
		const obj = JSON.parse(extractJsonFenceBody(body));
		expect(obj.schemas.Thing.properties.constructor.type).toBe("string");
	});

	test("top-level __proto__ on the OpenAPI root is rejected from Spec metadata", () => {
		// `servers` forces a non-empty residual so the Spec metadata heading
		// always emits — keeps the assertions reachable.
		const yaml = `openapi: "3.0.0"
__proto__:
  leak: bad
info: { title: T, version: "1" }
paths: {}
servers:
  - url: https://example.com
`;
		const parsed = parseYamlFile(yaml, "spec.yaml");
		const meta = parsed.headings.find((h) => h.pathText === "Spec metadata");
		if (!meta) throw new Error("expected Spec metadata heading (servers forces a residual)");
		const body = parsed.source.slice(meta.bodyOffsetRange.start, meta.bodyOffsetRange.end);
		expect(body).not.toContain("__proto__");
		expect(body).not.toContain("leak");
		const obj = JSON.parse(extractJsonFenceBody(body));
		expect(Object.hasOwn(obj, "__proto__")).toBe(false);
		expect(obj.servers[0].url).toBe("https://example.com");
	});

	test("webhook literally named __proto__ (3.1) preserves PathItem-level fields in Spec metadata", () => {
		const yaml = `openapi: "3.1.0"
info: { title: T, version: "1" }
webhooks:
  __proto__:
    summary: "PathItem-level summary for __proto__ webhook"
    servers:
      - url: https://example.com
    post:
      summary: handler op
      responses: { "200": { description: ok } }
`;
		const parsed = parseYamlFile(yaml, "spec.yaml");
		// Per-op heading still emits (3.1+ gating not affected).
		const opHeading = parsed.headings.find((h) => h.pathText === "Webhook: __proto__ POST");
		expect(opHeading).toBeDefined();

		const meta = parsed.headings.find((h) => h.pathText === "Spec metadata");
		if (!meta) throw new Error("expected Spec metadata heading");
		const body = parsed.source.slice(meta.bodyOffsetRange.start, meta.bodyOffsetRange.end);
		expect(body).toContain("__proto__");
		expect(body).toContain("PathItem-level summary for __proto__ webhook");
		const obj = JSON.parse(extractJsonFenceBody(body));
		expect(Object.hasOwn(obj.webhooks, "__proto__")).toBe(true);
		expect(Object.hasOwn(obj.webhooks.__proto__, "summary")).toBe(true);
		// Canonical method `post` stripped by extractor (per-op section carries it).
		expect(Object.hasOwn(obj.webhooks.__proto__, "post")).toBe(false);
	});

	test("info-level __proto__ extension key (depth-1) is rejected by extractInfoResidual", () => {
		// Sister of the `info.contact.__proto__` test above (depth-2 via
		// `deepSanitize`); this one exercises the depth-1 key-layer gate.
		const yaml = `openapi: "3.0.0"
info:
  title: T
  version: "1"
  __proto__:
    pwn: true
  contact:
    name: API Support
paths: {}
`;
		const parsed = parseYamlFile(yaml, "spec.yaml");
		const meta = parsed.headings.find((h) => h.pathText === "Spec metadata");
		if (!meta) throw new Error("expected Spec metadata heading");
		const body = parsed.source.slice(meta.bodyOffsetRange.start, meta.bodyOffsetRange.end);
		const obj = JSON.parse(extractJsonFenceBody(body));
		expect(Object.hasOwn(obj.info, "__proto__")).toBe(false);
		expect(obj.info.contact.name).toBe("API Support");
	});

	test("3.0.x webhook content survives via deepSanitize'd Spec metadata", () => {
		const yaml = `openapi: "3.0.0"
info: { title: T, version: "1" }
paths:
  /ok: { get: { responses: { "200": { description: ok } } } }
webhooks:
  audit:
    summary: "wh-level summary preserved via spec-metadata"
    post:
      summary: must-stay-searchable
      responses: { "200": { description: ok } }
`;
		const parsed = parseYamlFile(yaml, "spec.yaml");
		// 3.0.x gate still firing — no Webhook: heading.
		expect(parsed.headings.find((h) => h.pathText.startsWith("Webhook:"))).toBeUndefined();
		const meta = parsed.headings.find((h) => h.pathText === "Spec metadata");
		if (!meta) throw new Error("expected Spec metadata heading");
		const body = parsed.source.slice(meta.bodyOffsetRange.start, meta.bodyOffsetRange.end);
		expect(body).toContain("audit");
		expect(body).toContain("wh-level summary preserved via spec-metadata");
		expect(body).toContain("must-stay-searchable");
	});
});

describe("synthesizeOpenApiFile — follow-up fixes", () => {
	test("webhook PathItem-level fields reach Spec metadata via the same residual path as `paths`", () => {
		const yaml = `openapi: "3.1.0"
info: { title: T, version: "1" }
paths: {}
webhooks:
  audit:
    summary: Audit channel
    description: Channel summary that should survive
    x-source: internal-bus
    post:
      summary: Audit event
      responses:
        "200":
          description: ack
`;
		const parsed = parseYamlFile(yaml, "api/spec.yaml");
		const meta = parsed.headings.find((h) => h.pathText === "Spec metadata");
		if (!meta) throw new Error("expected Spec metadata heading");
		const body = parsed.source.slice(meta.bodyOffsetRange.start, meta.bodyOffsetRange.end);
		const obj = JSON.parse(extractJsonFenceBody(body));
		expect(obj.webhooks.audit.summary).toBe("Audit channel");
		expect(obj.webhooks.audit.description).toBe("Channel summary that should survive");
		expect(obj.webhooks.audit["x-source"]).toBe("internal-bus");
		// Canonical method already rendered as its own webhook section.
		expect(Object.hasOwn(obj.webhooks.audit, "post")).toBe(false);
	});

	test("__proto__ as a SCHEMA NAME inside a components bucket is preserved as own data", () => {
		const yaml = `openapi: "3.0.0"
info: { title: T, version: "1" }
paths: {}
components:
  schemas:
    __proto__:
      type: object
      properties:
        ok: { type: boolean }
    Pet:
      type: object
`;
		const parsed = parseYamlFile(yaml, "spec.yaml");
		const components = parsed.headings.find((h) => h.pathText === "Components");
		if (!components) throw new Error("expected Components heading");
		const body = parsed.source.slice(components.bodyOffsetRange.start, components.bodyOffsetRange.end);
		expect(body).toContain('"__proto__"');
		const obj = JSON.parse(extractJsonFenceBody(body));
		// Referenceable via $ref like any other schema name.
		expect(Object.hasOwn(obj.schemas, "__proto__")).toBe(true);
		expect(obj.schemas.__proto__.type).toBe("object");
		expect(obj.schemas.Pet.type).toBe("object");
	});

	test("`security: []` is an OpenAPI no-auth override and emits `Security: none`", () => {
		const yaml = `openapi: "3.0.0"
info: { title: T, version: "1" }
security:
  - apiKey: []
paths:
  /public:
    get:
      summary: open
      security: []
      responses: { "200": { description: ok } }
`;
		const parsed = parseYamlFile(yaml, "spec.yaml");
		const op = parsed.headings.find((h) => h.pathText === "GET /public");
		if (!op) throw new Error("missing GET /public heading");
		const body = parsed.source.slice(op.bodyOffsetRange.start, op.bodyOffsetRange.end);
		expect(body).toContain("Security: none");
	});

	test("`security: []` still promotes `contentKinds` to `list` (parity with non-empty security)", () => {
		const yaml = `openapi: "3.0.0"
info: { title: T, version: "1" }
paths:
  /public:
    get:
      security: []
      responses: { "200": { description: ok } }
`;
		const parsed = parseYamlFile(yaml, "spec.yaml");
		const op = parsed.headings.find((h) => h.pathText === "GET /public");
		if (!op) throw new Error("missing GET /public heading");
		expect(op.contentKinds).toContain("list");
	});
});

describe("synthesizeOpenApiFile — per-op fence sanitization", () => {
	test("per-op fence strips user-named `__proto__` payloads nested in responses", () => {
		const yaml = `openapi: "3.0.0"
info: { title: T, version: "1" }
paths:
  /pets:
    get:
      summary: list
      responses:
        "200":
          description: ok
          __proto__:
            polluted: deep-leak
`;
		const parsed = parseYamlFile(yaml, "spec.yaml");
		const op = parsed.headings.find((h) => h.pathText === "GET /pets");
		if (!op) throw new Error("missing GET /pets heading");
		const body = parsed.source.slice(op.bodyOffsetRange.start, op.bodyOffsetRange.end);
		const fence = JSON.parse(extractJsonFenceBody(body));
		expect(Object.hasOwn(fence.responses["200"], "__proto__")).toBe(false);
		expect(body).not.toContain("deep-leak");
	});

	test("per-op fence strips `__proto__` nested in requestBody and parameters", () => {
		const yaml = `openapi: "3.0.0"
info: { title: T, version: "1" }
paths:
  /pets:
    post:
      summary: create
      requestBody:
        description: payload
        __proto__: { also: polluted-rb }
      parameters:
        - name: hint
          in: header
          __proto__: { sneaky: polluted-param }
      responses: { "200": { description: ok } }
`;
		const parsed = parseYamlFile(yaml, "spec.yaml");
		const op = parsed.headings.find((h) => h.pathText === "POST /pets");
		if (!op) throw new Error("missing POST /pets heading");
		const body = parsed.source.slice(op.bodyOffsetRange.start, op.bodyOffsetRange.end);
		const fence = JSON.parse(extractJsonFenceBody(body));
		expect(Object.hasOwn(fence.requestBody, "__proto__")).toBe(false);
		expect(Object.hasOwn(fence.parameters[0], "__proto__")).toBe(false);
		expect(body).not.toContain("polluted-rb");
		expect(body).not.toContain("polluted-param");
	});

	test("ordinary ops with no user-named `__proto__` are unaffected by per-op fence sanitization", () => {
		const yaml = `openapi: "3.0.0"
info: { title: T, version: "1" }
paths:
  /x:
    get:
      summary: ordinary
      responses: { "200": { description: ok } }
`;
		const parsed = parseYamlFile(yaml, "spec.yaml");
		const op = parsed.headings.find((h) => h.pathText === "GET /x");
		if (!op) throw new Error("missing GET /x heading");
		const body = parsed.source.slice(op.bodyOffsetRange.start, op.bodyOffsetRange.end);
		const fence = JSON.parse(extractJsonFenceBody(body));
		expect(fence.summary).toBe("ordinary");
		expect(fence.responses["200"].description).toBe("ok");
	});
});

describe("synthesizeOpenApiFile — top-level `security` inheritance", () => {
	test("op without `security` inherits non-empty top-level `security` and emits Security prose", () => {
		const yaml = `openapi: "3.0.0"
info: { title: T, version: "1" }
security:
  - bearerAuth: []
paths:
  /inherits:
    get:
      summary: inheriting op
      responses: { "200": { description: ok } }
`;
		const parsed = parseYamlFile(yaml, "spec.yaml");
		const op = parsed.headings.find((h) => h.pathText === "GET /inherits");
		if (!op) throw new Error("missing GET /inherits heading");
		const body = parsed.source.slice(op.bodyOffsetRange.start, op.bodyOffsetRange.end);
		expect(body).toContain("Security: bearerAuth");
		// Fence still shows on-disk truth: op has no `security` key.
		const fence = JSON.parse(extractJsonFenceBody(body));
		expect(Object.hasOwn(fence, "security")).toBe(false);
	});

	test("inherited security promotes op `contentKinds` to `list` (parity with explicit op-level)", () => {
		const yaml = `openapi: "3.0.0"
info: { title: T, version: "1" }
security:
  - bearerAuth: []
paths:
  /x:
    get:
      responses: { "200": { description: ok } }
`;
		const parsed = parseYamlFile(yaml, "spec.yaml");
		const op = parsed.headings.find((h) => h.pathText === "GET /x");
		if (!op) throw new Error("missing GET /x heading");
		expect(op.contentKinds).toContain("list");
	});

	test("top-level `security: []` propagates as `Security: none` for inheriting ops", () => {
		const yaml = `openapi: "3.0.0"
info: { title: T, version: "1" }
security: []
paths:
  /x:
    get:
      responses: { "200": { description: ok } }
`;
		const parsed = parseYamlFile(yaml, "spec.yaml");
		const op = parsed.headings.find((h) => h.pathText === "GET /x");
		if (!op) throw new Error("missing GET /x heading");
		const body = parsed.source.slice(op.bodyOffsetRange.start, op.bodyOffsetRange.end);
		expect(body).toContain("Security: none");
	});

	test("explicit op `security: []` overrides inherited non-empty top-level security", () => {
		const yaml = `openapi: "3.0.0"
info: { title: T, version: "1" }
security:
  - bearerAuth: []
paths:
  /authed:
    get:
      summary: protected
      responses: { "200": { description: ok } }
  /public:
    get:
      summary: explicit no-auth
      security: []
      responses: { "200": { description: ok } }
`;
		const parsed = parseYamlFile(yaml, "spec.yaml");
		const authed = parsed.headings.find((h) => h.pathText === "GET /authed");
		const pub = parsed.headings.find((h) => h.pathText === "GET /public");
		if (!authed || !pub) throw new Error("missing headings");
		const authedBody = parsed.source.slice(authed.bodyOffsetRange.start, authed.bodyOffsetRange.end);
		const pubBody = parsed.source.slice(pub.bodyOffsetRange.start, pub.bodyOffsetRange.end);
		expect(authedBody).toContain("Security: bearerAuth");
		expect(pubBody).toContain("Security: none");
		expect(pubBody).not.toContain("Security: bearerAuth");
	});

	test("no top-level and no op-level security emits no Security prose", () => {
		const yaml = `openapi: "3.0.0"
info: { title: T, version: "1" }
paths:
  /x:
    get:
      responses: { "200": { description: ok } }
`;
		const parsed = parseYamlFile(yaml, "spec.yaml");
		const op = parsed.headings.find((h) => h.pathText === "GET /x");
		if (!op) throw new Error("missing GET /x heading");
		const body = parsed.source.slice(op.bodyOffsetRange.start, op.bodyOffsetRange.end);
		expect(body).not.toContain("Security:");
	});
});

describe("synthesizeOpenApiFile — 3.1+ webhook gating", () => {
	test("3.0.x spec with a `webhooks` block emits no webhook headings", () => {
		const yaml = `openapi: "3.0.0"
info: { title: ThreeZero, version: "1" }
paths:
  /ok: { get: { responses: { "200": { description: ok } } } }
webhooks:
  shouldNotHeading:
    post:
      summary: not a real webhook on 3.0
      responses: { "200": { description: ok } }
`;
		const parsed = parseYamlFile(yaml, "api/spec.yaml");
		expect(parsed.headings.filter(isWebhookHeading).length).toBe(0);
		// Content still reachable via spec-metadata catch-all so the
		// 3.0 webhooks data isn't entirely dropped from FTS.
		const meta = parsed.headings.find((h) => h.pathText === "Spec metadata");
		if (!meta) throw new Error("expected Spec metadata heading");
		const body = parsed.source.slice(meta.bodyOffsetRange.start, meta.bodyOffsetRange.end);
		expect(body).toContain("shouldNotHeading");
	});

	test("3.0.3 spec with `webhooks` also gates (any 3.0.x version)", () => {
		const yaml = `openapi: "3.0.3"
info: { title: T, version: "1" }
paths: {}
webhooks:
  audit:
    post:
      summary: x
      responses: { "200": { description: ok } }
`;
		const parsed = parseYamlFile(yaml, "api/spec.yaml");
		expect(parsed.headings.filter(isWebhookHeading).length).toBe(0);
	});

	test("3.1.0 spec with `webhooks` synthesizes headings (gate doesn't fire)", () => {
		const yaml = `openapi: "3.1.0"
info: { title: T, version: "1" }
paths: {}
webhooks:
  audit:
    post:
      summary: real webhook
      responses: { "200": { description: ok } }
`;
		const parsed = parseYamlFile(yaml, "api/spec.yaml");
		const webhooks = parsed.headings.filter(isWebhookHeading);
		expect(webhooks.length).toBe(1);
		expect(webhooks[0]?.pathText).toBe("Webhook: audit POST");
	});
});

describe("synthesizeOpenApiFile — op-level sanitization + heading-line normalization", () => {
	test("per-op fence strips `__proto__` at the Operation Object depth-0 layer", () => {
		const yaml = `openapi: "3.0.0"
info: { title: T, version: "1" }
paths:
  /x:
    get:
      summary: op with depth-0 proto smuggled
      __proto__:
        leaked: from-op
      responses: { "200": { description: ok } }
`;
		const parsed = parseYamlFile(yaml, "spec.yaml");
		const op = parsed.headings.find((h) => h.pathText === "GET /x");
		if (!op) throw new Error("missing GET /x heading");
		const body = parsed.source.slice(op.bodyOffsetRange.start, op.bodyOffsetRange.end);
		const fence = JSON.parse(extractJsonFenceBody(body));
		expect(Object.hasOwn(fence, "__proto__")).toBe(false);
		expect(body).not.toContain("from-op");
		expect(fence.summary).toBe("op with depth-0 proto smuggled");
	});

	test("op-level `security: [{__proto__: [scope]}]` renders the __proto__ scheme name in prose", () => {
		const yaml = `openapi: "3.0.0"
info: { title: T, version: "1" }
paths:
  /x:
    get:
      summary: proto-named scheme reference
      security:
        - __proto__: ["scope1"]
      responses: { "200": { description: ok } }
`;
		const parsed = parseYamlFile(yaml, "spec.yaml");
		const op = parsed.headings.find((h) => h.pathText === "GET /x");
		if (!op) throw new Error("missing GET /x heading");
		const body = parsed.source.slice(op.bodyOffsetRange.start, op.bodyOffsetRange.end);
		expect(body).toContain("Security: __proto__(scope1)");
		expect(body).not.toContain("Security: none");
	});

	test("top-level `security: [{__proto__: [...]}]` inherited by ops emits the __proto__ scheme name", () => {
		const yaml = `openapi: "3.0.0"
info: { title: T, version: "1" }
security:
  - __proto__: ["scope1"]
paths:
  /x:
    get:
      summary: inherits top security
      responses: { "200": { description: ok } }
`;
		const parsed = parseYamlFile(yaml, "spec.yaml");
		const op = parsed.headings.find((h) => h.pathText === "GET /x");
		if (!op) throw new Error("missing GET /x heading");
		const body = parsed.source.slice(op.bodyOffsetRange.start, op.bodyOffsetRange.end);
		expect(body).toContain("Security: __proto__(scope1)");
		expect(body).not.toContain("Security: none");
	});

	test("security entry mixing `__proto__` with a legitimate scheme renders BOTH on the Security: line", () => {
		const yaml = `openapi: "3.0.0"
info: { title: T, version: "1" }
paths:
  /x:
    get:
      summary: mixed
      security:
        - __proto__: ["scope1"]
          normal_scheme: ["read"]
      responses: { "200": { description: ok } }
`;
		const parsed = parseYamlFile(yaml, "spec.yaml");
		const op = parsed.headings.find((h) => h.pathText === "GET /x");
		if (!op) throw new Error("missing GET /x heading");
		const body = parsed.source.slice(op.bodyOffsetRange.start, op.bodyOffsetRange.end);
		expect(body).toMatch(/Security: __proto__\(scope1\), normal_scheme\(read\)/);
	});

	test("components.securitySchemes.__proto__ + op security reference: preserved consistently across Components fence, operation prose, AND operation JSON fence", () => {
		const yaml = `openapi: "3.1.0"
info: { title: T, version: "1" }
components:
  securitySchemes:
    __proto__:
      type: oauth2
      flows:
        clientCredentials:
          tokenUrl: https://example.com/token
          scopes:
            "read:pets": "Read access"
paths:
  /x:
    get:
      summary: protected by proto-named scheme
      security:
        - __proto__: ["read:pets"]
      responses: { "200": { description: ok } }
`;
		const parsed = parseYamlFile(yaml, "spec.yaml");

		const components = parsed.headings.find((h) => h.pathText === "Components");
		if (!components) throw new Error("expected Components heading");
		const componentsBody = parsed.source.slice(components.bodyOffsetRange.start, components.bodyOffsetRange.end);
		const componentsObj = JSON.parse(extractJsonFenceBody(componentsBody));
		expect(Object.hasOwn(componentsObj.securitySchemes, "__proto__")).toBe(true);
		expect(componentsObj.securitySchemes.__proto__.type).toBe("oauth2");

		const op = parsed.headings.find((h) => h.pathText === "GET /x");
		if (!op) throw new Error("missing GET /x heading");
		const opBody = parsed.source.slice(op.bodyOffsetRange.start, op.bodyOffsetRange.end);
		expect(opBody).toContain("Security: __proto__(read:pets)");

		const opObj = JSON.parse(extractJsonFenceBody(opBody));
		expect(Array.isArray(opObj.security)).toBe(true);
		expect(opObj.security.length).toBe(1);
		expect(Object.hasOwn(opObj.security[0], "__proto__")).toBe(true);
		expect(opObj.security[0].__proto__).toEqual(["read:pets"]);
	});

	test("op.callbacks.__proto__ preserves the identifier in both prose AND operation JSON fence", () => {
		const yaml = `openapi: "3.0.0"
info: { title: T, version: "1" }
paths:
  /x:
    get:
      summary: proto-named callback
      callbacks:
        __proto__:
          "{$request.body#/url}":
            post:
              responses: { "200": { description: ack } }
        legitCallback:
          "{$request.body#/url}":
            post:
              responses: { "200": { description: ack } }
      responses: { "200": { description: ok } }
`;
		const parsed = parseYamlFile(yaml, "spec.yaml");
		const op = parsed.headings.find((h) => h.pathText === "GET /x");
		if (!op) throw new Error("missing GET /x heading");
		const body = parsed.source.slice(op.bodyOffsetRange.start, op.bodyOffsetRange.end);
		expect(body).toMatch(/Callbacks:[^\n]*__proto__/);
		expect(body).toContain("legitCallback");

		const opObj = JSON.parse(extractJsonFenceBody(body));
		expect(Object.hasOwn(opObj.callbacks, "__proto__")).toBe(true);
		expect(Object.hasOwn(opObj.callbacks.__proto__, "{$request.body#/url}")).toBe(true);
		expect(Object.hasOwn(opObj.callbacks, "legitCallback")).toBe(true);
	});

	test("op.callbacks.<name>.__proto__ (proto-named expression key under a legit callback) is preserved in the operation JSON fence", () => {
		const yaml = `openapi: "3.0.0"
info: { title: T, version: "1" }
paths:
  /x:
    get:
      summary: proto-named expression
      callbacks:
        onTick:
          __proto__:
            post:
              responses: { "200": { description: ack } }
      responses: { "200": { description: ok } }
`;
		const parsed = parseYamlFile(yaml, "spec.yaml");
		const op = parsed.headings.find((h) => h.pathText === "GET /x");
		if (!op) throw new Error("missing GET /x heading");
		const body = parsed.source.slice(op.bodyOffsetRange.start, op.bodyOffsetRange.end);
		const opObj = JSON.parse(extractJsonFenceBody(body));
		expect(Object.hasOwn(opObj.callbacks, "onTick")).toBe(true);
		expect(Object.hasOwn(opObj.callbacks.onTick, "__proto__")).toBe(true);
		expect(Object.hasOwn(opObj.callbacks.onTick.__proto__, "post")).toBe(true);
	});

	test("op-level __proto__ key (depth 0 of the Operation Object) is still stripped from the operation JSON fence", () => {
		const yaml = `openapi: "3.0.0"
info: { title: T, version: "1" }
paths:
  /x:
    get:
      summary: legit summary
      __proto__:
        pwn: bad
      responses: { "200": { description: ok } }
`;
		const parsed = parseYamlFile(yaml, "spec.yaml");
		const op = parsed.headings.find((h) => h.pathText === "GET /x");
		if (!op) throw new Error("missing GET /x heading");
		const body = parsed.source.slice(op.bodyOffsetRange.start, op.bodyOffsetRange.end);
		const opObj = JSON.parse(extractJsonFenceBody(body));
		expect(opObj.summary).toBe("legit summary");
		expect(Object.hasOwn(opObj, "__proto__")).toBe(false);
	});

	test("root `security: [{__proto__: [scope]}]` preserves the user-named scheme reference in the Spec metadata fence", () => {
		const yaml = `openapi: "3.1.0"
info: { title: T, version: "1" }
components:
  securitySchemes:
    __proto__:
      type: oauth2
      flows:
        clientCredentials:
          tokenUrl: https://example.com/token
          scopes:
            "read:pets": "Read access"
security:
  - __proto__: ["read:pets"]
paths:
  /x:
    get:
      summary: anchor op
      responses: { "200": { description: ok } }
`;
		const parsed = parseYamlFile(yaml, "spec.yaml");
		const meta = parsed.headings.find((h) => h.pathText === "Spec metadata");
		if (!meta) throw new Error("expected Spec metadata heading");
		const body = parsed.source.slice(meta.bodyOffsetRange.start, meta.bodyOffsetRange.end);
		const metaObj = JSON.parse(extractJsonFenceBody(body));
		expect(Array.isArray(metaObj.security)).toBe(true);
		expect(metaObj.security.length).toBe(1);
		expect(Object.hasOwn(metaObj.security[0], "__proto__")).toBe(true);
		expect(metaObj.security[0].__proto__).toEqual(["read:pets"]);
	});

	test("root `security: [{__proto__: [scope]}]` with no operations still surfaces the scheme reference in the Spec metadata fence (FTS coverage)", () => {
		// Without operations the requirement reaches FTS ONLY via the metadata
		// fence — a spec that declares auth at the root with no path/webhook
		// operations to inherit it must not lose the scheme name from search.
		const yaml = `openapi: "3.1.0"
info: { title: T, version: "1", description: anchor }
components:
  securitySchemes:
    __proto__:
      type: oauth2
      flows:
        clientCredentials:
          tokenUrl: https://example.com/token
          scopes:
            "read:pets": "Read access"
security:
  - __proto__: ["read:pets"]
`;
		const parsed = parseYamlFile(yaml, "spec.yaml");
		const meta = parsed.headings.find((h) => h.pathText === "Spec metadata");
		if (!meta) throw new Error("expected Spec metadata heading");
		const body = parsed.source.slice(meta.bodyOffsetRange.start, meta.bodyOffsetRange.end);
		expect(body).toContain("__proto__");
		expect(body).toContain("read:pets");
		const metaObj = JSON.parse(extractJsonFenceBody(body));
		expect(Object.hasOwn(metaObj.security[0], "__proto__")).toBe(true);
		expect(metaObj.security[0].__proto__).toEqual(["read:pets"]);
	});

	test("3.1 `webhooks: []` (mid-edit array draft) survives in the Spec metadata fence (symmetric with 3.0.x)", () => {
		const yaml = `openapi: "3.1.0"
info: { title: T, version: "1" }
webhooks: []
paths:
  /x:
    get:
      summary: anchor op
      responses: { "200": { description: ok } }
`;
		const parsed = parseYamlFile(yaml, "spec.yaml");
		const meta = parsed.headings.find((h) => h.pathText === "Spec metadata");
		if (!meta) throw new Error("expected Spec metadata heading");
		const body = parsed.source.slice(meta.bodyOffsetRange.start, meta.bodyOffsetRange.end);
		const metaObj = JSON.parse(extractJsonFenceBody(body));
		expect(Object.hasOwn(metaObj, "webhooks")).toBe(true);
		expect(metaObj.webhooks).toEqual([]);
	});

	test('3.1 `webhooks: "TODO"` (mid-edit scalar draft) survives in the Spec metadata fence (symmetric with 3.0.x)', () => {
		const yaml = `openapi: "3.1.0"
info: { title: T, version: "1" }
webhooks: "TODO"
paths:
  /x:
    get:
      summary: anchor op
      responses: { "200": { description: ok } }
`;
		const parsed = parseYamlFile(yaml, "spec.yaml");
		const meta = parsed.headings.find((h) => h.pathText === "Spec metadata");
		if (!meta) throw new Error("expected Spec metadata heading");
		const body = parsed.source.slice(meta.bodyOffsetRange.start, meta.bodyOffsetRange.end);
		const metaObj = JSON.parse(extractJsonFenceBody(body));
		expect(metaObj.webhooks).toBe("TODO");
	});

	test("3.1 `webhooks: null` stays omitted from the Spec metadata fence (both branches drop null — regression guard)", () => {
		// `tags: [...]` forces the metadata fence to emit; without an
		// independent non-rendered root key the fence wouldn't exist at all
		// and the omission of `webhooks` would be undetectable.
		const yaml = `openapi: "3.1.0"
info: { title: T, version: "1" }
webhooks: ~
tags: [{ name: anchor }]
paths:
  /x:
    get:
      summary: anchor op
      responses: { "200": { description: ok } }
`;
		const parsed = parseYamlFile(yaml, "spec.yaml");
		const meta = parsed.headings.find((h) => h.pathText === "Spec metadata");
		if (!meta) throw new Error("expected Spec metadata heading");
		const body = parsed.source.slice(meta.bodyOffsetRange.start, meta.bodyOffsetRange.end);
		const metaObj = JSON.parse(extractJsonFenceBody(body));
		expect(Object.hasOwn(metaObj, "webhooks")).toBe(false);
		expect(metaObj.tags).toEqual([{ name: "anchor" }]);
	});

	test('3.1 `webhooks.<name>.<method>: "TODO"` (mid-edit scalar draft at method key) survives in the Spec metadata fence', () => {
		// `enumeratePathItems` skips non-plain-object method values, so the
		// webhook section never emits — the residual extractor must mirror
		// that gate or the draft text disappears from FTS entirely.
		const yaml = `openapi: "3.1.0"
info: { title: T, version: "1" }
webhooks:
  cron:
    post: "TODO-webhook-draft"
    description: webhook still being authored
paths:
  /x:
    get:
      summary: anchor op
      responses: { "200": { description: ok } }
`;
		const parsed = parseYamlFile(yaml, "spec.yaml");
		const meta = parsed.headings.find((h) => h.pathText === "Spec metadata");
		if (!meta) throw new Error("expected Spec metadata heading");
		const body = parsed.source.slice(meta.bodyOffsetRange.start, meta.bodyOffsetRange.end);
		const metaObj = JSON.parse(extractJsonFenceBody(body));
		expect(metaObj.webhooks.cron.post).toBe("TODO-webhook-draft");
		expect(metaObj.webhooks.cron.description).toBe("webhook still being authored");
		const webhookHeadings = parsed.headings.filter(isWebhookHeading);
		expect(webhookHeadings.length).toBe(0);
	});

	test("3.1 `webhooks.<name>.<method>: []` (mid-edit array draft at method key) survives in the Spec metadata fence", () => {
		const yaml = `openapi: "3.1.0"
info: { title: T, version: "1" }
webhooks:
  cron:
    post: []
paths:
  /x:
    get:
      summary: anchor op
      responses: { "200": { description: ok } }
`;
		const parsed = parseYamlFile(yaml, "spec.yaml");
		const meta = parsed.headings.find((h) => h.pathText === "Spec metadata");
		if (!meta) throw new Error("expected Spec metadata heading");
		const body = parsed.source.slice(meta.bodyOffsetRange.start, meta.bodyOffsetRange.end);
		const metaObj = JSON.parse(extractJsonFenceBody(body));
		expect(metaObj.webhooks.cron.post).toEqual([]);
	});

	test("`paths.<path>.<method>: <scalar>` (mid-edit draft at path-level method key) survives in the Spec metadata fence", () => {
		// `extractPathItemMapResidual` is shared between the `paths` and `webhooks`
		// callsites, so the same gate must hold at the `paths` layer — a draft
		// `paths./x.put: "WIP"` should reach the residual fence even on 3.0.x
		// where `webhooks` is not a spec construct at all.
		const yaml = `openapi: "3.0.3"
info: { title: T, version: "1" }
paths:
  /x:
    summary: path-level summary
    put: "WIP-paths-draft"
    get:
      summary: anchor op
      responses: { "200": { description: ok } }
`;
		const parsed = parseYamlFile(yaml, "spec.yaml");
		const meta = parsed.headings.find((h) => h.pathText === "Spec metadata");
		if (!meta) throw new Error("expected Spec metadata heading");
		const body = parsed.source.slice(meta.bodyOffsetRange.start, meta.bodyOffsetRange.end);
		const metaObj = JSON.parse(extractJsonFenceBody(body));
		expect(metaObj.paths["/x"].put).toBe("WIP-paths-draft");
		expect(metaObj.paths["/x"].summary).toBe("path-level summary");
		expect(Object.hasOwn(metaObj.paths["/x"], "get")).toBe(false);
	});

	test("webhook name carrying `\\n## injected` produces a single `## Webhook:` line in the source", () => {
		const yaml = `openapi: "3.1.0"
info: { title: T, version: "1" }
paths: {}
webhooks:
  "ws\\n## injected":
    post:
      summary: name-injection target
      responses: { "200": { description: ok } }
`;
		const parsed = parseYamlFile(yaml, "spec.yaml");
		const webhookHeadings = parsed.headings.filter(isWebhookHeading);
		expect(webhookHeadings.length).toBe(1);
		const webhook = webhookHeadings[0];
		if (!webhook) throw new Error("missing webhook heading");
		expect(webhook.displayText).toContain("\n## injected");
		const matches = parsed.source.match(/^## Webhook:/gm);
		expect(matches?.length).toBe(1);
	});

	test("path string carrying `\\n` collapses safely in the synthesized heading line", () => {
		// Path keys can't legitimately carry `\n` per RFC 3986 but malformed
		// YAML can; the heading-line normalize keeps the source single-`##`.
		const yaml = `openapi: "3.0.0"
info: { title: T, version: "1" }
paths:
  "/safe\\npath":
    get:
      summary: x
      responses: { "200": { description: ok } }
`;
		const parsed = parseYamlFile(yaml, "spec.yaml");
		const ops = parsed.headings.filter(isOperationHeading);
		expect(ops.length).toBe(1);
		const op = ops[0];
		if (!op) throw new Error("missing operation heading");
		expect(op.pathText).toBe("GET /safe path");
		// Fixture has only the canonical `get` method (stripped from residual)
		// and no other top-level keys, so the spec-metadata residual is empty
		// and only one `## ` line emits.
		const matches = parsed.source.match(/^## /gm);
		expect(matches?.length).toBe(1);
	});

	test("prose identifier interpolations collapse embedded newlines (parity with AsyncAPI)", () => {
		// Every user-controlled identifier in `renderOperationProse` carries the
		// `\n## phantom-*` payload. A correct synthesizer collapses each via
		// `normalizeHeadingText`, leaving the body with exactly ONE `## ` line
		// (the operation heading itself) and embedding the payloads inline as
		// single-line text. Mirrors asyncapi.ts's already-correct policy.
		const yaml = `openapi: "3.1.0"
info: { title: T, version: "1" }
paths:
  /x:
    get:
      summary: "ok\\n## phantom-summary"
      operationId: "getX\\n## phantom-opid"
      parameters:
        - name: "q\\n## phantom-param"
          in: query
      responses:
        "200":
          description: "ok\\n## phantom-resp"
      requestBody:
        description: "body\\n## phantom-reqbody"
      tags:
        - "tag1\\n## phantom-tag"
      externalDocs:
        description: "see docs\\n## phantom-extdocs"
        url: "https://example.com/docs"
      security:
        - "oauth\\n## phantom-scheme":
            - "read:pets\\n## phantom-scope"
      servers:
        - url: "https://example.com\\n## phantom-server"
      callbacks:
        "onTick\\n## phantom-callback":
          "{$request.body#/url}":
            post:
              responses: { "200": { description: ack } }
`;
		const parsed = parseYamlFile(yaml, "spec.yaml");
		const op = parsed.headings.find((h) => h.pathText === "GET /x");
		if (!op) throw new Error("missing GET /x heading");
		const body = parsed.source.slice(op.bodyOffsetRange.start, op.bodyOffsetRange.end);
		// No phantom `##` lines in the body (the heading line itself sits in
		// `headingLineOffset`, not in `bodyOffsetRange`).
		expect(body).not.toMatch(/^## phantom-/m);
		expect(body.match(/^## /gm)).toBeNull();
		// Each payload still searchable inline (collapsed onto its parent line).
		expect(body).toContain("phantom-summary");
		expect(body).toContain("phantom-opid");
		expect(body).toContain("phantom-param");
		expect(body).toContain("phantom-resp");
		expect(body).toContain("phantom-reqbody");
		expect(body).toContain("phantom-tag");
		expect(body).toContain("phantom-extdocs");
		expect(body).toContain("phantom-scheme");
		expect(body).toContain("phantom-scope");
		expect(body).toContain("phantom-server");
		expect(body).toContain("phantom-callback");
	});

	test("paths.__proto__ is dropped from the Spec metadata fence (paths layer is spec-defined)", () => {
		// OpenAPI 3.x: paths keys MUST begin with `/`, so `__proto__` is
		// structurally invalid at this layer. `extractPathItemMapResidual`
		// filters it out when called with `filterDangerousOuterKey = true`.
		const yaml = `openapi: "3.0.0"
info: { title: T, version: "1" }
servers:
  - url: https://api.example.com
paths:
  /x:
    get:
      summary: legit
      description: legit-path-survives
      responses: { "200": { description: ok } }
  __proto__:
    summary: PAYLOAD-paths-proto
`;
		const parsed = parseYamlFile(yaml, "spec.yaml");
		// Legitimate path /x still emits its operation section.
		const op = parsed.headings.find((h) => h.pathText === "GET /x");
		expect(op).toBeDefined();
		const meta = parsed.headings.find((h) => h.pathText === "Spec metadata");
		if (!meta) throw new Error("expected Spec metadata heading");
		const body = parsed.source.slice(meta.bodyOffsetRange.start, meta.bodyOffsetRange.end);
		const obj = JSON.parse(extractJsonFenceBody(body));
		// `paths` residual: legit /x has no residual (operations-only); proto is
		// filtered. Net: no `paths` key in the spec-metadata residual.
		expect(Object.hasOwn(obj, "paths")).toBe(false);
		expect(body).not.toContain("PAYLOAD-paths-proto");
	});

	test("webhooks.__proto__ stays preserved in the Spec metadata fence (webhook names are user-named)", () => {
		// OpenAPI 3.1: webhooks keys are unconstrained user-chosen strings, so
		// a webhook literally named `__proto__` is legal-but-weird user content.
		// `extractPathItemMapResidual` preserves it via `safeSet` when called
		// with `filterDangerousOuterKey = false`. The proto-named webhook has
		// only PathItem-level fields (summary + description) and no method, so
		// it contributes nothing to the heading enumeration but its residual
		// fields must still reach the spec-metadata fence.
		const yaml = `openapi: "3.1.0"
info: { title: T, version: "1" }
servers:
  - url: https://api.example.com
paths: {}
webhooks:
  tickEvent:
    post:
      summary: legit-webhook
      responses: { "200": { description: ack } }
  __proto__:
    summary: webhook-named-proto
    description: user-content-named-proto
`;
		const parsed = parseYamlFile(yaml, "spec.yaml");
		const meta = parsed.headings.find((h) => h.pathText === "Spec metadata");
		if (!meta) throw new Error("expected Spec metadata heading");
		const body = parsed.source.slice(meta.bodyOffsetRange.start, meta.bodyOffsetRange.end);
		const obj = JSON.parse(extractJsonFenceBody(body));
		// Webhook residual: tickEvent is operations-only (no residual); proto
		// has path-item-level `summary` + `description` (residual fields).
		// Net: webhooks contains `__proto__` as own-data with the residual.
		expect(isPlainObject(obj.webhooks)).toBe(true);
		const wh = obj.webhooks as Record<string, unknown>;
		expect(Object.hasOwn(wh, "__proto__")).toBe(true);
		expect(Object.hasOwn(wh, "tickEvent")).toBe(false);
		const protoResidual = wh.__proto__;
		expect(isPlainObject(protoResidual)).toBe(true);
		expect((protoResidual as Record<string, unknown>).summary).toBe("webhook-named-proto");
	});
});
