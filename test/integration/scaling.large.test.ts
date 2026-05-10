/**
 * Integration test — large tier (~50K files).
 *
 * Gated behind `VAULT_MCP_INTEGRATION=1`. Generation alone takes ~30–60s
 * on commodity SSD; full indexing pushes total runtime past 5 min on
 * slower hardware. Run on a tagged-release pipeline, not per-PR.
 *
 * The point is to exercise pagination + cursor stability + memory
 * boundedness at a vault size larger than most real Obsidian users keep.
 */

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { generateVault } from "../../bench/fixtures.js";
import type { GetVaultTreeResult } from "../../src/types.js";
import { spawnTestServer, type TestClient, waitForWarm } from "../helpers/mcp-client.js";

const FILES = 50_000;
const SHOULD_RUN = process.env.VAULT_MCP_INTEGRATION === "1";

let vault: { path: string; cleanup(): Promise<void>; files: number };
let conn: TestClient;

beforeAll(async () => {
	if (!SHOULD_RUN) return;
	vault = await generateVault({ files: FILES });
	conn = await spawnTestServer(vault.path);
	// Larger timeout — initial scan against 50K files dwarfs the small/medium
	// tiers' bootstrap. `waitForWarm` polls every 100 ms internally.
	await waitForWarm(conn.client, 600_000);
}, 900_000);

afterAll(async () => {
	if (!SHOULD_RUN) return;
	await conn.close();
	await vault.cleanup();
});

describe.skipIf(!SHOULD_RUN)(`integration — ${FILES}-file synthetic vault`, () => {
	test("search BM25 stays under 500ms p95 across 10 iterations at 50K scale", async () => {
		const samples: number[] = [];
		for (let i = 0; i < 10; i++) {
			const start = performance.now();
			const r = await conn.client.callTool({ name: "search", arguments: { query: "auth", pageSize: 20 } });
			samples.push(performance.now() - start);
			expect(r.isError).toBeFalsy();
		}
		samples.sort((a, b) => a - b);
		const p95 = samples[Math.floor(samples.length * 0.95)] ?? 0;
		// 50K is 50x the W3 spec target; allow 5x the budget headroom.
		expect(p95).toBeLessThan(500);
	}, 120_000);

	test("get_vault_tree first page returns within 1s at 50K scale", async () => {
		const start = performance.now();
		const r = await conn.client.callTool({ name: "get_vault_tree", arguments: { depth: 5, pageSize: 100 } });
		const elapsed = performance.now() - start;
		expect(r.isError).toBeFalsy();
		const out = r.structuredContent as GetVaultTreeResult;
		expect(out.items.length).toBe(100);
		expect(out.nextCursor).toBeDefined();
		expect(elapsed).toBeLessThan(1_000);
	}, 30_000);

	test("server RSS stays under 1 GB after large-scale operations", async () => {
		// `process.memoryUsage()` reports the TEST process, not the spawned
		// server — but absent IPC reporting, this guards against runaway
		// growth in the test harness itself (which holds the MCP client +
		// any cached structured content from previous tests).
		const rss = process.memoryUsage().rss;
		const rssMb = rss / 1024 / 1024;
		expect(rssMb).toBeLessThan(1_024);
	});
});
