/**
 * Integration test — medium tier (~5K files).
 *
 * Gated behind `MARKDOWN_MCP_INTEGRATION=1` so default `npm test` stays
 * under 10 min on commodity CI. Generation + indexing of 5K files
 * takes ~30s on a fast machine.
 *
 * Asserts the W3 search-latency budget at 5x the spec scale.
 */

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { generateVault } from "../../bench/fixtures.js";
import type { GetVaultTreeResult, SearchOutput } from "../../src/types.js";
import { spawnTestServer, type TestClient, waitForWarm } from "../helpers/mcp-client.js";

const FILES = 5_000;
const SHOULD_RUN = process.env.MARKDOWN_MCP_INTEGRATION === "1";

let vault: { path: string; cleanup(): Promise<void>; files: number };
let conn: TestClient;

beforeAll(async () => {
	if (!SHOULD_RUN) return;
	vault = await generateVault({ files: FILES });
	conn = await spawnTestServer(vault.path);
	await waitForWarm(conn.client, 240_000);
}, 300_000);

afterAll(async () => {
	if (!SHOULD_RUN) return;
	await conn.close();
	await vault.cleanup();
});

describe.skipIf(!SHOULD_RUN)(`integration — ${FILES}-file synthetic vault`, () => {
	test("search BM25 stays under 200ms p95 across 20 iterations at 5K scale", async () => {
		const samples: number[] = [];
		for (let i = 0; i < 20; i++) {
			const start = performance.now();
			const r = await conn.client.callTool({ name: "search", arguments: { query: "auth", pageSize: 20 } });
			samples.push(performance.now() - start);
			expect(r.isError).toBeFalsy();
		}
		samples.sort((a, b) => a - b);
		const p95 = samples[Math.floor(samples.length * 0.95)] ?? 0;
		expect(p95).toBeLessThan(200);
	}, 60_000);

	test("get_vault_tree paginates a 5K-file vault correctly", async () => {
		let cursor: string | undefined;
		let totalItems = 0;
		let pages = 0;
		let lastDfsRank = 0;
		const seen = new Set<string>();
		// Cap pages defensively — if pagination loops, we want a fast failure.
		while (pages < 200) {
			const args: Record<string, unknown> = { depth: 5, pageSize: 100 };
			if (cursor !== undefined) args.cursor = cursor;
			const r = await conn.client.callTool({ name: "get_vault_tree", arguments: args });
			expect(r.isError).toBeFalsy();
			const out = r.structuredContent as GetVaultTreeResult;
			for (const item of out.items) {
				expect(item.dfs_rank).toBeGreaterThan(lastDfsRank);
				lastDfsRank = item.dfs_rank;
				expect(seen.has(item.path)).toBe(false);
				seen.add(item.path);
			}
			totalItems += out.items.length;
			pages++;
			if (!out.nextCursor) break;
			cursor = out.nextCursor;
		}
		expect(totalItems).toBeGreaterThan(FILES); // dirs + files
	}, 120_000);

	test("search filter-only mode at 5K scale returns matched rows", async () => {
		const start = performance.now();
		const r = await conn.client.callTool({
			name: "search",
			arguments: { query: "", filters: { tags: { has: "api" } }, pageSize: 50 },
		});
		const elapsed = performance.now() - start;
		expect(r.isError).toBeFalsy();
		const out = r.structuredContent as SearchOutput;
		expect(out.items.length).toBeGreaterThan(0);
		expect(out.items[0]?.score).toBe(0);
		// Filter-only is unindexed-FTS — should be FAST (no MATCH op).
		expect(elapsed).toBeLessThan(200);
	}, 30_000);
});
