/**
 * D44 — OpenAPI synthesizer unit tests.
 *
 * Covers:
 *   - Detection: `openapi: "3.*"` → synthesize; `swagger: "2.0"` → opaque fallback.
 *   - Operation enumeration: sorted by path alphabetically, methods in
 *     canonical HTTP order. Non-method path-item keys (parameters, summary,
 *     servers) are skipped.
 *   - Stable ID format: `structuralPath` = `"op[<sha14>]"`, stable across
 *     path reorders (name-based slots — D44 rationale).
 *   - Heading metadata: pathText = "GET /users", level=2, flat outline.
 *   - Preamble emission: info block → 1 preamble row; empty info → no preamble.
 *   - Frontmatter: entire top-level object exposed for D30 nested-path filters.
 *   - Synthesized source content: prose + JSON fences positioned in excludedRanges.
 */

import { describe, expect, test } from "vitest";
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

describe("synthesizeOpenApiFile — stable IDs (D44 name-based slots)", () => {
	test("structuralPath uses op[<sha14>] format (matches markdown stable_id width)", () => {
		const parsed = parseYamlFile(PETSTORE_YAML, "api/petstore.yaml");
		// Named singletons (Components, Spec metadata) carry literal slots
		// per D44 — the sha14 format is operation-specific.
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

	test("rename `/users` → `/customers` retires the old stable_id (D32 semantics)", () => {
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

	test("frontmatter exposes entire top-level OpenAPI object (D30 nested-path access)", () => {
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
		// key besides info/paths/components stays in frontmatter (for D30
		// filters) but drops from synthesized source, so free-text search
		// would miss it. Regression guard for the catch-all fence.
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
