/**
 * Integration test — OpenAPI YAML end-to-end (D43, D44, D45, D46).
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
 *   - `search` with `filters.fields["info.version"].eq` filters via D30 nested-path.
 *   - `get_links` returns empty outgoing/incoming for a YAML file (D46 — wikilinks-into-YAML deferred).
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

describe("integration — OpenAPI YAML end-to-end (D43–D46)", () => {
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

	test("get_vault_tree emits a resource_link for the YAML file (D46)", async () => {
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

	test("search with fields['info.version'] filter matches via D30 nested-path access", async () => {
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

	test("get_links returns empty outgoing/incoming for a YAML file (D46)", async () => {
		const r = await conn.client.callTool({
			name: "get_links",
			arguments: { file: "api/petstore.yaml", direction: "both" },
		});
		expect(r.isError).toBeFalsy();
		const out = r.structuredContent as { outgoing?: unknown[]; incoming?: unknown[] };
		expect(out.outgoing ?? []).toEqual([]);
		expect(out.incoming ?? []).toEqual([]);
	});

	test("D46 — get_fragment on a YAML file returns empty outgoing_links / embeds", async () => {
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

	test("D46 — get_vault_tree resource_link emits application/yaml mimeType for YAML files", async () => {
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
