/**
 * Test helper that spawns a built `vault-mcp` server as a subprocess
 * and connects to it via the SDK's stdio client transport. Returns the
 * connected `Client` and a tear-down function.
 *
 * Builds against `dist/index.js` (run `npm run build` before tests). CI
 * runs `npm run build` ahead of `npm test` per the workflow.
 */

import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import type { MetaEnvelope } from "../../src/types.js";

// `URL.pathname` keeps percent escapes (e.g. `%20`); `fileURLToPath`
// decodes them so checkout paths with spaces or non-ASCII still spawn.
const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
export const SERVER_BIN = join(REPO_ROOT, "dist/index.js");

export interface TestClient {
	client: Client;
	close: () => Promise<void>;
}

/**
 * Poll until the index reaches `warm`, or ~10s elapses. Tests run their
 * `beforeAll` setup against a fully populated index so vault-wide tools
 * (`search`, `get_links`, `get_vault_tree`) don't return partial counts
 * from a `warming` snapshot. The probe tool is `search` because it
 * surfaces `_meta.index_status` cheaply; the query string is irrelevant.
 */
export async function waitForWarm(client: Client): Promise<void> {
	for (let i = 0; i < 100; i++) {
		const r = await client.callTool({ name: "search", arguments: { query: "x" } });
		const meta = r._meta as MetaEnvelope | undefined;
		if (meta?.index_status?.state === "warm") return;
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
}

/**
 * Spawn `node dist/index.js --vault <vaultPath>`, perform the MCP
 * `initialize` handshake, and return a connected client. Caller must
 * `await close()` in `afterEach`.
 *
 * The server's stderr is piped to the parent's stderr so test failures
 * show server-side diagnostic output. `extraEnv` overlays onto the
 * inherited environment — callers like the mdx-extension test pass
 * `{ VAULT_EXTENSIONS: "md,mdx" }` so the spawned server reads the
 * widened predicate. PATH/HOME/etc. inherit from `process.env`.
 */
export async function spawnTestServer(vaultPath: string, extraEnv: Record<string, string> = {}): Promise<TestClient> {
	const env: Record<string, string> = {};
	for (const [k, v] of Object.entries(process.env)) {
		if (typeof v === "string") env[k] = v;
	}
	for (const [k, v] of Object.entries(extraEnv)) {
		env[k] = v;
	}
	const transport = new StdioClientTransport({
		command: process.execPath,
		args: [SERVER_BIN, "--vault", vaultPath],
		stderr: "pipe",
		env,
	});

	const client = new Client(
		{ name: "vault-mcp-test-client", version: "1.0.0-w1" },
		{
			capabilities: {},
		},
	);

	await client.connect(transport);

	return {
		client,
		close: async () => {
			await client.close();
		},
	};
}
