/**
 * `get_links` incoming-scan two-tier cap.
 *
 * Soft cap fires only when ≥1 row confirmed; absolute ceiling (5×)
 * bounds runaway scans on 100%-false-positive vaults. Without the
 * soft-cap gate, the loop could exit with `inRows: []` plus a cursor
 * — clients stopping on empty pages would silently miss real
 * backlinks past a false-positive cluster.
 */

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import type { GetLinksResult } from "../../src/types.js";
import { spawnTestServer, type TestClient, waitForWarm } from "../helpers/mcp-client.js";
import { createTempVault, type VaultStructure } from "../helpers/vault.js";

// Build a source file with many self-links followed by one real
// backlink. Self-links all match the empty "" candidate's LIKE '#%'
// branch (false positives for `target.md`); the real backlink
// resolves cleanly. Without the soft-cap gate, the loop would exit
// before reaching the real backlink.
function buildFixture(): VaultStructure {
	const lines: string[] = ["# Source\n"];
	for (let i = 1; i <= 500; i++) {
		lines.push(`[[#anchor-${i}]]\n`);
	}
	lines.push("\n[[target]]\n");
	return {
		"target.md": "# Target\n",
		"selflinks.md": lines.join(""),
	};
}

let vault: { path: string; cleanup: () => Promise<void> };
let conn: TestClient;

beforeAll(async () => {
	vault = await createTempVault(buildFixture());
	conn = await spawnTestServer(vault.path);
	await waitForWarm(conn.client);
}, 30_000);

afterAll(async () => {
	await conn.close();
	await vault.cleanup();
});

describe("get_links — incoming scan past false-positive cluster", () => {
	test("real backlink past 500 self-links is reachable in one page", async () => {
		const result = await conn.client.callTool({
			name: "get_links",
			arguments: { file: "target.md", direction: "in", pageSize: 50 },
		});
		expect(result.isError).toBeFalsy();
		const body = result.structuredContent as GetLinksResult;
		const sources = (body.incoming ?? []).map((i) => i.source_file);
		expect(sources).toContain("selflinks.md");
	});
});
