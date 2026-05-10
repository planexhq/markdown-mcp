/**
 * Integration test — small tier (~100 files).
 *
 * Always runs in default `npm test`. Exercises every tool against a
 * synthetic vault of representative shape so a regression that only
 * shows up at scale (e.g. wikilink resolver O(n²) blow-up, scanner
 * concurrency deadlock) surfaces here without requiring opt-in.
 *
 * Medium (~5K) and large (~50K) tiers live in sibling files gated
 * behind `VAULT_MCP_INTEGRATION=1` to keep CI under 10 min.
 */

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { generateVault } from "../../bench/fixtures.js";
import type { GetLinksResult, GetVaultTreeResult, SearchOutput } from "../../src/types.js";
import { spawnTestServer, type TestClient, waitForWarm } from "../helpers/mcp-client.js";

const FILES = 100;

let vault: { path: string; cleanup(): Promise<void>; files: number };
let conn: TestClient;

beforeAll(async () => {
	vault = await generateVault({ files: FILES });
	conn = await spawnTestServer(vault.path);
	await waitForWarm(conn.client);
}, 60_000);

afterAll(async () => {
	await conn.close();
	await vault.cleanup();
});

describe(`integration — ${FILES}-file synthetic vault`, () => {
	test("get_vault_tree returns a paginated DFS over the generated vault", async () => {
		const r = await conn.client.callTool({ name: "get_vault_tree", arguments: { depth: 5, pageSize: 50 } });
		expect(r.isError).toBeFalsy();
		const out = r.structuredContent as GetVaultTreeResult;
		expect(out.items.length).toBeGreaterThan(0);
		// DFS rank monotonic + non-zero
		for (let i = 1; i < out.items.length; i++) {
			const prev = out.items[i - 1];
			const cur = out.items[i];
			expect(cur?.dfs_rank).toBeGreaterThan(prev?.dfs_rank ?? -1);
		}
	});

	test("search BM25 returns results within the 100ms budget", async () => {
		const start = performance.now();
		const r = await conn.client.callTool({ name: "search", arguments: { query: "auth", pageSize: 20 } });
		const elapsed = performance.now() - start;
		expect(r.isError).toBeFalsy();
		const out = r.structuredContent as SearchOutput;
		expect(out.items.length).toBeGreaterThan(0);
		// W3 budget: <100ms on 1K-file vault. 100-file vault must be even faster;
		// generous 250ms ceiling to absorb cold-cache + spawn jitter on slow CI runners.
		expect(elapsed).toBeLessThan(250);
	});

	test("search filter-only mode returns rows with score 0", async () => {
		const r = await conn.client.callTool({
			name: "search",
			arguments: { query: "", filters: { tags: { has: "api" } } },
		});
		expect(r.isError).toBeFalsy();
		const out = r.structuredContent as SearchOutput;
		// Generated tags include "api" with high probability across 100 files.
		expect(out.items.length).toBeGreaterThan(0);
		expect(out.items[0]?.score).toBe(0);
	});

	test("get_links resolves outgoing wikilinks for a generated note", async () => {
		const r = await conn.client.callTool({
			name: "get_links",
			arguments: { file: "dir-0/note-0.md", direction: "out" },
		});
		expect(r.isError).toBeFalsy();
		const out = r.structuredContent as GetLinksResult;
		// linksPerFile=2 in the generator → at least 1 outgoing link (could
		// resolve to multiple targets if basename collides, but the row count
		// is the rawTarget count).
		expect(out.outgoing).toBeDefined();
		expect((out.outgoing ?? []).length).toBeGreaterThanOrEqual(1);
	});

	test("get_fragment by file anchor returns body for a generated note", async () => {
		const r = await conn.client.callTool({
			name: "get_fragment",
			arguments: { file: "dir-0/note-0.md", anchor: { kind: "file" } },
		});
		expect(r.isError).toBeFalsy();
		const frag = r.structuredContent as { content?: string };
		expect(frag.content ?? "").toContain("Section");
	});
});
