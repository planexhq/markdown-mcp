/**
 * Integration test — Prisma schema end-to-end.
 *
 * Spins up a server against a vault containing a markdown note + `.prisma`
 * files. Exercises every tool surface to confirm the structured Prisma
 * pipeline works end-to-end:
 *
 *   - `get_vault_tree` lists the `.prisma` file with a `text/x-prisma` resource_link.
 *   - `get_file_outline` returns one outline node per top-level PSL block.
 *   - `get_fragment` (file anchor) returns the synthesized prose rendering.
 *   - `get_fragment` (heading_path anchor) returns a specific block's section.
 *   - `get_fragment` (stable_id anchor) round-trips against the outline's IDs.
 *   - `get_metadata` returns the `{ datasource, generator }` frontmatter.
 *   - `search` matches block names with BM25 ranking on `body`.
 *   - `search` matches attribute names on the `code` FTS column.
 *   - `search` matches `///` doc-comment text in `body` weight.
 *   - `search` with `fields["datasource.db.provider"].eq` filter via nested-path.
 *   - `get_links` returns empty outgoing/incoming for a `.prisma` file (wikilink gate).
 *   - `note://schema.prisma` returns literal on-disk PSL with `text/x-prisma` mimeType.
 *   - Empty `.prisma` (only `//` comments) indexes opaquely (no headings).
 */

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import type { GetFileOutlineResult, GetMetadataResult, GetVaultTreeResult, SearchOutput } from "../../src/types.js";
import { spawnTestServer, type TestClient, waitForWarm } from "../helpers/mcp-client.js";
import { createTempVault } from "../helpers/vault.js";

const FULL_SCHEMA_PRISMA = `datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

generator client {
  provider = "prisma-client-js"
}

/// A registered user.
model User {
  id        Int      @id @default(autoincrement())
  /// User's email — must be unique.
  email     String   @unique
  name      String?
  role      Role     @default(USER)
  posts     Post[]
  createdAt DateTime @default(now())

  @@map("users")
  @@index([email])
}

model Post {
  id       Int    @id @default(autoincrement())
  title    String @db.VarChar(255)
  author   User   @relation(fields: [authorId], references: [id])
  authorId Int
}

enum Role {
  USER
  ADMIN
}
`;

const EMPTY_SCHEMA_PRISMA = `// just a regular comment
// nothing structured here
`;

const MARKDOWN_NOTE = `---
title: Auth Overview
---

# Auth Overview

See [[other-note]] for more.
`;

let vault: { path: string; cleanup: () => Promise<void> };
let conn: TestClient;

beforeAll(async () => {
	vault = await createTempVault({
		prisma: {
			"schema.prisma": FULL_SCHEMA_PRISMA,
			"empty.prisma": EMPTY_SCHEMA_PRISMA,
		},
		notes: {
			"auth.md": MARKDOWN_NOTE,
		},
	});
	conn = await spawnTestServer(vault.path, { VAULT_EXTENSIONS: "md,prisma" });
	await waitForWarm(conn.client);
}, 30_000);

afterAll(async () => {
	await conn.close();
	await vault.cleanup();
});

describe("integration — Prisma schema end-to-end", () => {
	test("get_vault_tree lists schema.prisma as an indexed file", async () => {
		const r = await conn.client.callTool({ name: "get_vault_tree", arguments: { depth: 5, pageSize: 50 } });
		expect(r.isError).toBeFalsy();
		const out = r.structuredContent as GetVaultTreeResult;
		const entry = out.items.find((i) => i.path === "prisma/schema.prisma");
		expect(entry).toBeDefined();
		expect(entry?.type).toBe("file");
		// 1 datasource + 1 generator + 2 models + 1 enum = 5 top-level blocks.
		expect(entry?.subheadings).toBeGreaterThanOrEqual(5);
	});

	test("get_vault_tree emits a resource_link with text/x-prisma for the Prisma file", async () => {
		const r = await conn.client.callTool({ name: "get_vault_tree", arguments: { depth: 5, pageSize: 50 } });
		expect(r.isError).toBeFalsy();
		const content = r.content as Array<{ type: string; uri?: string; mimeType?: string }>;
		const link = content.find((c) => c.type === "resource_link" && c.uri?.includes("schema.prisma"));
		expect(link).toBeDefined();
		expect(link?.mimeType).toBe("text/x-prisma");
	});

	test("get_file_outline returns one outline node per top-level block", async () => {
		const r = await conn.client.callTool({
			name: "get_file_outline",
			arguments: { file: "prisma/schema.prisma" },
		});
		expect(r.isError).toBeFalsy();
		const out = r.structuredContent as GetFileOutlineResult;
		const texts = out.outline.map((n) => n.text);
		// Source-order: datasource → generator → model User → model Post → enum Role.
		expect(texts).toEqual(["datasource db", "generator client", "model User", "model Post", "enum Role"]);
	});

	test("get_fragment by file anchor returns the synthesized prose rendering", async () => {
		const r = await conn.client.callTool({
			name: "get_fragment",
			arguments: { file: "prisma/schema.prisma", anchor: { kind: "file" } },
		});
		expect(r.isError).toBeFalsy();
		const frag = r.structuredContent as { content?: string };
		expect(frag.content ?? "").toContain("## datasource db");
		expect(frag.content ?? "").toContain("## model User");
		expect(frag.content ?? "").toContain("A registered user.");
		expect(frag.content ?? "").toContain("Table: users");
		expect(frag.content ?? "").toContain("Fields:");
	});

	test("get_fragment by heading_path returns that block's section", async () => {
		const r = await conn.client.callTool({
			name: "get_fragment",
			arguments: {
				file: "prisma/schema.prisma",
				anchor: { kind: "heading_path", path: "model User" },
			},
		});
		expect(r.isError).toBeFalsy();
		const frag = r.structuredContent as { content?: string };
		expect(frag.content ?? "").toContain("## model User");
		expect(frag.content ?? "").toContain("A registered user.");
		expect(frag.content ?? "").toContain("email: String @unique — User's email");
		// Should NOT contain the Post model's body.
		expect(frag.content ?? "").not.toContain("authorId");
	});

	test("get_fragment narrows to a section via stable_id companion field", async () => {
		const outlineResult = await conn.client.callTool({
			name: "get_file_outline",
			arguments: { file: "prisma/schema.prisma" },
		});
		const outline = outlineResult.structuredContent as GetFileOutlineResult;
		const userNode = outline.outline.find((n) => n.text === "model User");
		expect(userNode?.stable_id).toBeDefined();
		expect(userNode!.stable_id).toMatch(/^h:[0-9a-f]{14}$/);

		// Per GetFragmentSchema, `stable_id` is a top-level companion to `anchor`,
		// not an anchor kind. Pair with a heading_path anchor + the stable_id
		// for disambiguation (or stale-id recovery).
		const r = await conn.client.callTool({
			name: "get_fragment",
			arguments: {
				file: "prisma/schema.prisma",
				anchor: { kind: "heading_path", path: "model User" },
				stable_id: userNode!.stable_id,
			},
		});
		expect(r.isError).toBeFalsy();
		const frag = r.structuredContent as { content?: string };
		expect(frag.content ?? "").toContain("## model User");
	});

	test("get_metadata exposes the `{ datasource, generator }` frontmatter", async () => {
		const r = await conn.client.callTool({
			name: "get_metadata",
			arguments: { file: "prisma/schema.prisma" },
		});
		expect(r.isError).toBeFalsy();
		const out = r.structuredContent as GetMetadataResult;
		expect(out.has_frontmatter).toBe(true);
		const meta = out.metadata as Record<string, unknown>;
		const datasource = meta.datasource as Record<string, Record<string, unknown>>;
		expect(datasource.db?.provider).toBe("postgresql");
		const generator = meta.generator as Record<string, Record<string, unknown>>;
		expect(generator.client?.provider).toBe("prisma-client-js");
	});

	test("search returns Prisma blocks by name with BM25 body weight", async () => {
		const r = await conn.client.callTool({
			name: "search",
			arguments: { query: "registered user", pageSize: 20 },
		});
		expect(r.isError).toBeFalsy();
		const out = r.structuredContent as SearchOutput;
		const hit = out.items.find(
			(i) => "heading_path" in i && Array.isArray(i.heading_path) && i.heading_path.includes("model User"),
		);
		expect(hit).toBeDefined();
	});

	test("search matches attribute names on the code FTS column", async () => {
		const r = await conn.client.callTool({
			name: "search",
			arguments: { query: "VarChar", pageSize: 20 },
		});
		expect(r.isError).toBeFalsy();
		const out = r.structuredContent as SearchOutput;
		const hits = out.items.filter((i) => i.file === "prisma/schema.prisma");
		expect(hits.length).toBeGreaterThan(0);
	});

	test("search with fields['datasource.db.provider'] filter matches via nested-path access", async () => {
		const r = await conn.client.callTool({
			name: "search",
			arguments: {
				query: "",
				filters: { fields: { "datasource.db.provider": { eq: "postgresql" } } },
				pageSize: 20,
			},
		});
		expect(r.isError).toBeFalsy();
		const out = r.structuredContent as SearchOutput;
		const hits = out.items.filter((i) => i.file === "prisma/schema.prisma");
		expect(hits.length).toBeGreaterThan(0);
	});

	test("get_links returns empty outgoing/incoming for a .prisma file (wikilink gate)", async () => {
		const r = await conn.client.callTool({
			name: "get_links",
			arguments: { file: "prisma/schema.prisma", direction: "both" },
		});
		expect(r.isError).toBeFalsy();
		const out = r.structuredContent as { outgoing?: unknown[]; incoming?: unknown[] };
		expect(out.outgoing ?? []).toEqual([]);
		expect(out.incoming ?? []).toEqual([]);
	});

	test("get_fragment on a .prisma file returns empty outgoing_links / embeds (wikilink gate)", async () => {
		const r = await conn.client.callTool({
			name: "get_fragment",
			arguments: { file: "prisma/schema.prisma", anchor: { kind: "file" } },
		});
		expect(r.isError).toBeFalsy();
		const frag = r.structuredContent as { outgoing_links?: unknown[]; embeds?: unknown[] };
		expect(frag.outgoing_links ?? []).toEqual([]);
		expect(frag.embeds ?? []).toEqual([]);
	});

	test("note://prisma/schema.prisma returns literal on-disk PSL with text/x-prisma mimeType", async () => {
		const resource = await conn.client.readResource({ uri: "note://prisma/schema.prisma" });
		const first = resource.contents[0] as { mimeType?: string; text?: string };
		expect(first.mimeType).toBe("text/x-prisma");
		// `text` is the LITERAL on-disk source (NOT the synthesized rendering).
		expect(first.text).toBe(FULL_SCHEMA_PRISMA);
	});

	test("note://notes/auth.md still returns text/markdown for markdown files", async () => {
		const resource = await conn.client.readResource({ uri: "note://notes/auth.md" });
		const first = resource.contents[0] as { mimeType?: string; text?: string };
		expect(first.mimeType).toBe("text/markdown");
		expect(first.text).toBe(MARKDOWN_NOTE);
	});

	test("empty .prisma (only // comments) indexes opaquely (no headings)", async () => {
		const r = await conn.client.callTool({
			name: "get_file_outline",
			arguments: { file: "prisma/empty.prisma" },
		});
		expect(r.isError).toBeFalsy();
		const out = r.structuredContent as GetFileOutlineResult;
		expect(out.outline).toEqual([]);
	});
});
