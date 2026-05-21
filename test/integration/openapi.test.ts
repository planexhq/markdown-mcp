/**
 * Integration test — OpenAPI YAML end-to-end.
 *
 * Spins up a server against a vault containing a markdown note + a small
 * OpenAPI 3.x YAML file. Exercises every tool surface to confirm the
 * structured YAML pipeline works end-to-end:
 *
 *   - `get_vault_tree` lists the YAML file with a `resource_link` block.
 *   - `get_file_outline` returns one outline node per API operation.
 *   - `get_fragment` (file anchor) returns the synthesized prose rendering.
 *   - `get_fragment` (stable_id anchor) returns a specific operation section.
 *   - `get_metadata` returns the entire top-level OpenAPI object.
 *   - `search` matches operation summaries with BM25 ranking.
 *   - `search` with `filters.fields["info.version"].eq` filters via nested-path.
 *   - `get_links` returns empty outgoing/incoming for a YAML file (wikilinks-into-YAML deferred).
 *   - `note://api/petstore.yaml` returns literal on-disk bytes with `application/yaml` mimeType.
 *
 * Setup creates a tmpdir vault and launches the built dist server with
 * `VAULT_EXTENSIONS=md,yaml,yml` so the YAML file is admitted.
 */

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import type { GetFileOutlineResult, GetMetadataResult, GetVaultTreeResult, SearchOutput } from "../../src/types.js";
import { spawnTestServer, type TestClient, waitForWarm } from "../helpers/mcp-client.js";
import { createTempVault } from "../helpers/vault.js";

const PETSTORE_YAML = `openapi: "3.0.3"
info:
  title: Petstore
  version: 2.1.0
  description: A sample Pet Store API for integration testing.
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
      responses:
        "201":
          description: Pet created
`;

// Fixture exercising pollution defense, webhooks + prose enrichment,
// and operationId-keyed slot end-to-end via real MCP tool
// surfaces. Single spec keeps the setup simple; each test asserts on
// the relevant slice.
const EXTENDED_YAML = `openapi: "3.1.0"
info:
  title: Shipping API
  version: "3.0.0"
  description: Webhook + security demo.
paths:
  /v1/orders:
    get:
      summary: List orders
      operationId: listOrders
      deprecated: true
      externalDocs:
        description: Order schema reference
        url: https://example.com/docs/orders
      security:
        - oauth2: [read:orders]
      responses:
        "200":
          description: ok
webhooks:
  shipment.created:
    post:
      summary: Shipment created event
      operationId: notifyShipmentCreated
      responses:
        "200":
          description: ack
components:
  schemas:
    Order:
      type: object
      __proto__:
        leaked-via-prototype-pollution-attack: "should not appear in any FTS column"
      properties:
        id:
          type: string
`;

const MARKDOWN_NOTE = `---
title: Auth Overview
tags: [auth, internal]
---

# Auth Overview

See [[auth-details]] for more.
`;

let vault: { path: string; cleanup: () => Promise<void> };
let conn: TestClient;

beforeAll(async () => {
	vault = await createTempVault({
		api: {
			"petstore.yaml": PETSTORE_YAML,
			"shipping.yaml": EXTENDED_YAML,
		},
		notes: {
			"auth.md": MARKDOWN_NOTE,
		},
	});
	conn = await spawnTestServer(vault.path, { VAULT_EXTENSIONS: "md,yaml,yml" });
	await waitForWarm(conn.client);
}, 30_000);

afterAll(async () => {
	await conn.close();
	await vault.cleanup();
});

describe("integration — OpenAPI YAML end-to-end", () => {
	test("get_vault_tree lists petstore.yaml as an indexed file", async () => {
		const r = await conn.client.callTool({ name: "get_vault_tree", arguments: { depth: 5, pageSize: 50 } });
		expect(r.isError).toBeFalsy();
		const out = r.structuredContent as GetVaultTreeResult;
		const yamlEntry = out.items.find((i) => i.path === "api/petstore.yaml");
		expect(yamlEntry).toBeDefined();
		expect(yamlEntry?.type).toBe("file");
		// 2 ops on /pets in this fixture (GET + POST).
		expect(yamlEntry?.subheadings).toBeGreaterThanOrEqual(2);
	});

	test("get_vault_tree emits a resource_link for the YAML file", async () => {
		const r = await conn.client.callTool({ name: "get_vault_tree", arguments: { depth: 5, pageSize: 50 } });
		expect(r.isError).toBeFalsy();
		const content = r.content as Array<{ type: string; uri?: string }>;
		const yamlLinks = content.filter((c) => c.type === "resource_link" && c.uri?.includes("petstore.yaml"));
		expect(yamlLinks.length).toBe(1);
	});

	test("get_file_outline returns one outline node per OpenAPI operation + spec metadata catch-all", async () => {
		const r = await conn.client.callTool({
			name: "get_file_outline",
			arguments: { file: "api/petstore.yaml" },
		});
		expect(r.isError).toBeFalsy();
		const out = r.structuredContent as GetFileOutlineResult;
		const texts = out.outline.map((n) => n.text);
		// Top-level `tags` in the fixture triggers the spec-metadata catch-all
		// so tag descriptions reach FTS via the `code` column.
		expect(texts).toEqual(["GET /pets", "POST /pets", "Spec metadata"]);
	});

	test("get_fragment by file anchor returns the synthesized prose rendering", async () => {
		const r = await conn.client.callTool({
			name: "get_fragment",
			arguments: { file: "api/petstore.yaml", anchor: { kind: "file" } },
		});
		expect(r.isError).toBeFalsy();
		const frag = r.structuredContent as { content?: string };
		// Synthesized source contains both the title preamble and operation headings.
		expect(frag.content ?? "").toContain("Petstore");
		expect(frag.content ?? "").toContain("## GET /pets");
		expect(frag.content ?? "").toContain("List all pets");
	});

	test("get_fragment by heading_path returns that operation's section", async () => {
		const r = await conn.client.callTool({
			name: "get_fragment",
			arguments: { file: "api/petstore.yaml", anchor: { kind: "heading_path", path: "GET /pets" } },
		});
		expect(r.isError).toBeFalsy();
		const frag = r.structuredContent as { content?: string };
		expect(frag.content ?? "").toContain("## GET /pets");
		expect(frag.content ?? "").toContain("List all pets");
		expect(frag.content ?? "").toContain("Returns a paginated list of pets.");
		// Should NOT contain the POST operation's prose.
		expect(frag.content ?? "").not.toContain("Create a pet");
	});

	test("get_metadata exposes the whole top-level OpenAPI object as metadata", async () => {
		const r = await conn.client.callTool({
			name: "get_metadata",
			arguments: { file: "api/petstore.yaml" },
		});
		expect(r.isError).toBeFalsy();
		const out = r.structuredContent as GetMetadataResult;
		expect(out.has_frontmatter).toBe(true);
		const meta = out.metadata as Record<string, unknown>;
		expect(meta.openapi).toBe("3.0.3");
		const info = meta.info as Record<string, unknown>;
		expect(info.title).toBe("Petstore");
		expect(info.version).toBe("2.1.0");
	});

	test("search returns OpenAPI operations with BM25 ranking", async () => {
		const r = await conn.client.callTool({
			name: "search",
			arguments: { query: "pets paginated", pageSize: 20 },
		});
		expect(r.isError).toBeFalsy();
		const out = r.structuredContent as SearchOutput;
		// One of the items should be the GET /pets operation.
		const petsHit = out.items.find(
			(i) => "heading_path" in i && Array.isArray(i.heading_path) && i.heading_path.includes("GET /pets"),
		);
		expect(petsHit).toBeDefined();
	});

	test("search with fields['info.version'] filter matches via nested-path access", async () => {
		const r = await conn.client.callTool({
			name: "search",
			arguments: {
				query: "",
				filters: { fields: { "info.version": { eq: "2.1.0" } } },
				pageSize: 20,
			},
		});
		expect(r.isError).toBeFalsy();
		const out = r.structuredContent as SearchOutput;
		// At least one row from petstore.yaml; the synthesized headings live
		// in that file and the filter matches its frontmatter.
		const petstoreHits = out.items.filter((i) => i.file === "api/petstore.yaml");
		expect(petstoreHits.length).toBeGreaterThan(0);
	});

	test("get_links returns empty outgoing/incoming for a YAML file", async () => {
		const r = await conn.client.callTool({
			name: "get_links",
			arguments: { file: "api/petstore.yaml", direction: "both" },
		});
		expect(r.isError).toBeFalsy();
		const out = r.structuredContent as { outgoing?: unknown[]; incoming?: unknown[] };
		expect(out.outgoing ?? []).toEqual([]);
		expect(out.incoming ?? []).toEqual([]);
	});

	test("get_fragment on a YAML file returns empty outgoing_links / embeds", async () => {
		// Scanner's `buildWikilinkRows` short-circuits at `parsed.kind === "yaml"`;
		// `get_fragment`'s read-time `buildLinksAndEmbeds` mirrors that gate so
		// phantom `[[X]]` text inside a YAML scalar doesn't surface as links.
		const r = await conn.client.callTool({
			name: "get_fragment",
			arguments: { file: "api/petstore.yaml", anchor: { kind: "file" } },
		});
		expect(r.isError).toBeFalsy();
		const frag = r.structuredContent as { outgoing_links?: unknown[]; embeds?: unknown[] };
		expect(frag.outgoing_links ?? []).toEqual([]);
		expect(frag.embeds ?? []).toEqual([]);
	});

	test("get_vault_tree resource_link emits application/yaml mimeType for YAML files", async () => {
		const r = await conn.client.callTool({ name: "get_vault_tree", arguments: { depth: 5, pageSize: 50 } });
		expect(r.isError).toBeFalsy();
		const content = r.content as Array<{ type: string; uri?: string; mimeType?: string }>;
		const yamlLink = content.find((c) => c.type === "resource_link" && c.uri?.includes("petstore.yaml"));
		expect(yamlLink?.mimeType).toBe("application/yaml");
		const mdLink = content.find((c) => c.type === "resource_link" && c.uri?.includes("auth.md"));
		expect(mdLink?.mimeType).toBe("text/markdown");
	});

	test("note://api/petstore.yaml returns literal on-disk YAML with application/yaml mimeType", async () => {
		const resource = await conn.client.readResource({ uri: "note://api/petstore.yaml" });
		const first = resource.contents[0] as { mimeType?: string; text?: string };
		expect(first.mimeType).toBe("application/yaml");
		// `text` is the LITERAL on-disk source (NOT the synthesized rendering).
		expect(first.text).toBe(PETSTORE_YAML);
	});

	test("note://notes/auth.md still returns text/markdown for markdown files", async () => {
		const resource = await conn.client.readResource({ uri: "note://notes/auth.md" });
		const first = resource.contents[0] as { mimeType?: string; text?: string };
		expect(first.mimeType).toBe("text/markdown");
		expect(first.text).toBe(MARKDOWN_NOTE);
	});
});

describe("integration — OpenAPI Tier 1 bundle", () => {
	test("get_file_outline exposes webhook nodes at level 2", async () => {
		const r = await conn.client.callTool({
			name: "get_file_outline",
			arguments: { file: "api/shipping.yaml" },
		});
		expect(r.isError).toBeFalsy();
		const out = r.structuredContent as GetFileOutlineResult;
		const texts = out.outline.map((n) => n.text);
		// One path op + one webhook op + Components catch-all.
		expect(texts).toContain("GET /v1/orders");
		expect(texts).toContain("Webhook: shipment.created POST");
		expect(texts).toContain("Components");
	});

	test("get_fragment resolves a webhook by heading_path", async () => {
		const r = await conn.client.callTool({
			name: "get_fragment",
			arguments: {
				file: "api/shipping.yaml",
				anchor: { kind: "heading_path", path: "Webhook: shipment.created POST" },
			},
		});
		expect(r.isError).toBeFalsy();
		const frag = r.structuredContent as { content?: string };
		expect(frag.content ?? "").toContain("Webhook: shipment.created POST");
		expect(frag.content ?? "").toContain("Shipment created event");
	});

	test("search('Deprecated') finds the op via new prose body weight", async () => {
		const r = await conn.client.callTool({
			name: "search",
			arguments: { query: "Deprecated", pageSize: 20 },
		});
		expect(r.isError).toBeFalsy();
		const out = r.structuredContent as SearchOutput;
		const hit = out.items.find(
			(i) => "heading_path" in i && Array.isArray(i.heading_path) && i.heading_path.includes("GET /v1/orders"),
		);
		expect(hit).toBeDefined();
	});

	test("operationId-keyed slot survives heading_path drift via stable_id round-trip", async () => {
		// Fetch outline → capture stable_id derived from operationId →
		// re-fetch fragment via that stable_id → confirm the same op.
		const outline = await conn.client.callTool({
			name: "get_file_outline",
			arguments: { file: "api/shipping.yaml" },
		});
		const out = outline.structuredContent as GetFileOutlineResult;
		const opNode = out.outline.find((n) => n.text === "GET /v1/orders");
		expect(opNode?.stable_id).toBeDefined();
		if (!opNode?.stable_id) throw new Error("missing stable_id");
		// `stable_id` is a top-level field on get_fragment; `anchor` is required
		// even when stable_id is present (stable_id wins per Brief line 116).
		const frag = await conn.client.callTool({
			name: "get_fragment",
			arguments: {
				file: "api/shipping.yaml",
				anchor: { kind: "heading_path", path: ["GET /v1/orders"] },
				stable_id: opNode.stable_id,
			},
		});
		expect(frag.isError).toBeFalsy();
		const body = frag.structuredContent as { content?: string };
		expect(body.content ?? "").toContain("List orders");
	});

	test("pollution-defense — __proto__ injection does NOT reach FTS", async () => {
		// The marker text lives only inside `components.schemas.Order.__proto__.leaked-...`.
		// sanitizeNested strips that key before JSON.stringify routes the
		// Components fence into the `code` FTS column. So search for the
		// marker text must return zero hits from this file.
		const r = await conn.client.callTool({
			name: "search",
			arguments: { query: "should not appear", pageSize: 20 },
		});
		expect(r.isError).toBeFalsy();
		const out = r.structuredContent as SearchOutput;
		const shippingHit = out.items.find((i) => i.file === "api/shipping.yaml");
		expect(shippingHit).toBeUndefined();
	});

	test("pollution-defense — Components fence body has no own __proto__ key after JSON.parse", async () => {
		// Read the Components fragment directly and parse its JSON fence.
		const r = await conn.client.callTool({
			name: "get_fragment",
			arguments: { file: "api/shipping.yaml", anchor: { kind: "heading_path", path: "Components" } },
		});
		expect(r.isError).toBeFalsy();
		const frag = r.structuredContent as { content?: string };
		const fenceMatch = /```json\n([\s\S]*?)\n```/.exec(frag.content ?? "");
		if (!fenceMatch?.[1]) throw new Error("expected json fence in Components fragment");
		const obj = JSON.parse(fenceMatch[1]);
		expect(Object.hasOwn(obj.schemas.Order, "__proto__")).toBe(false);
		// Legitimate sibling field still present.
		expect(obj.schemas.Order.properties.id.type).toBe("string");
	});
});
