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

// `URL.pathname` keeps percent escapes (e.g. `%20`); `fileURLToPath`
// decodes them so checkout paths with spaces or non-ASCII still spawn.
const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
export const SERVER_BIN = join(REPO_ROOT, "dist/index.js");

export interface TestClient {
	client: Client;
	close: () => Promise<void>;
}

/**
 * Spawn `node dist/index.js --vault <vaultPath>`, perform the MCP
 * `initialize` handshake, and return a connected client. Caller must
 * `await close()` in `afterEach`.
 *
 * The server's stderr is piped to the parent's stderr so test failures
 * show server-side diagnostic output.
 */
export async function spawnTestServer(vaultPath: string): Promise<TestClient> {
	const transport = new StdioClientTransport({
		command: process.execPath,
		args: [SERVER_BIN, "--vault", vaultPath],
		stderr: "pipe",
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
