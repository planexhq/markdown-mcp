/**
 * Integration tests for the HTTP transport.
 *
 * End-to-end: spawn `node dist/index.js --transport http --port 0`, connect
 * via the SDK's `StreamableHTTPClientTransport`, exercise:
 *   - identity (`get_server_info` reports `transport: "http"` + resolved
 *     `bind_address`/`port`)
 *   - tool dispatch over HTTP (`get_vault_tree` against a small vault)
 *   - multi-session multiplexing (two concurrent clients share one warm index)
 *   - bearer auth (server with `MCP_AUTH_TOKEN`: 401 without, 401 wrong, 200 right)
 *   - SIGTERM clean drain (process exits within the 5 s budget)
 *
 * `EADDRINUSE` is exercised in the CLI unit test layer (port flag validation
 * doesn't cover the bind-time race) — TODO for v1.3 if a real-world report
 * lands.
 */

import { readdir } from "node:fs/promises";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { getErrnoCode } from "../../src/lib/error.js";
import { indexDir } from "../helpers/indexDir.js";
import { waitForWarm } from "../helpers/mcp-client.js";
import { spawnHttpTestServer } from "../helpers/mcp-http-client.js";
import { createTempVault } from "../helpers/vault.js";

const FIXTURE: Record<string, string> = {
	"alpha.md": "# Alpha\n\nFirst note.\n",
	"beta.md": "# Beta\n\nSecond note.\n",
};

describe("HTTP transport", () => {
	let cleanups: Array<() => Promise<void>> = [];

	beforeEach(() => {
		cleanups = [];
	});

	afterEach(async () => {
		for (const cleanup of cleanups.reverse()) {
			try {
				await cleanup();
			} catch {
				// best-effort
			}
		}
		cleanups = [];
	});

	test("get_server_info reports transport + bind_address + port", async () => {
		const vault = await createTempVault(FIXTURE);
		cleanups.push(vault.cleanup);
		const harness = await spawnHttpTestServer(vault.path);
		cleanups.push(harness.close);

		const res = await harness.client.callTool({ name: "get_server_info", arguments: {} });
		const structured = res.structuredContent as
			| {
					server: { transport: string; bind_address?: string; port?: number };
			  }
			| undefined;
		expect(structured?.server.transport).toBe("http");
		expect(structured?.server.bind_address).toBe("127.0.0.1");
		expect(structured?.server.port).toBe(harness.port);
	});

	test("tool dispatch works over HTTP", async () => {
		const vault = await createTempVault(FIXTURE);
		cleanups.push(vault.cleanup);
		const harness = await spawnHttpTestServer(vault.path);
		cleanups.push(harness.close);

		// Vault-wide tools return INDEX_WARMING until the cold scan
		// drains; wait for warm before asserting tree contents.
		await waitForWarm(harness.client);

		const res = await harness.client.callTool({ name: "get_vault_tree", arguments: {} });
		const structured = res.structuredContent as { items?: Array<{ path: string }> } | undefined;
		const paths = (structured?.items ?? []).map((it) => it.path);
		expect(paths).toContain("alpha.md");
		expect(paths).toContain("beta.md");
	});

	test("two concurrent clients share one warm index", async () => {
		const vault = await createTempVault(FIXTURE);
		cleanups.push(vault.cleanup);
		const harness = await spawnHttpTestServer(vault.path);
		cleanups.push(harness.close);

		// First client (already connected by spawnHttpTestServer). Open a
		// second client against the same port. Both should see the same
		// `files_indexed` from the shared IndexHandle.
		const second = new Client({ name: "second-test-client", version: "1.0.0" }, { capabilities: {} });
		const secondTransport = new StreamableHTTPClientTransport(new URL(harness.endpoint));
		await second.connect(secondTransport);
		cleanups.push(async () => {
			await second.close();
		});

		// Wait for warm so both `get_server_info` snapshots read identical
		// `files_indexed` — without this, the cold scan finishing between
		// the two concurrent calls could surface different intermediate
		// counts.
		await waitForWarm(harness.client);

		const [a, b] = await Promise.all([
			harness.client.callTool({ name: "get_server_info", arguments: {} }),
			second.callTool({ name: "get_server_info", arguments: {} }),
		]);
		const aIndex = (a.structuredContent as { index?: { files_indexed: number } } | undefined)?.index;
		const bIndex = (b.structuredContent as { index?: { files_indexed: number } } | undefined)?.index;
		expect(aIndex?.files_indexed).toBeGreaterThan(0);
		expect(bIndex?.files_indexed).toBe(aIndex?.files_indexed);
	});

	describe("bearer auth via MCP_AUTH_TOKEN", () => {
		test("rejects requests without Authorization header (401)", async () => {
			const vault = await createTempVault(FIXTURE);
			cleanups.push(vault.cleanup);
			// Server gets the token; client gets nothing → expect connect failure.
			await expect(
				spawnHttpTestServer(vault.path, {
					authToken: "supersecret",
					clientAuthToken: null,
				}),
			).rejects.toThrow();
		});

		test("rejects requests with wrong token (401)", async () => {
			const vault = await createTempVault(FIXTURE);
			cleanups.push(vault.cleanup);
			await expect(
				spawnHttpTestServer(vault.path, {
					authToken: "supersecret",
					clientAuthToken: "different",
				}),
			).rejects.toThrow();
		});

		test("accepts requests with correct token", async () => {
			const vault = await createTempVault(FIXTURE);
			cleanups.push(vault.cleanup);
			const harness = await spawnHttpTestServer(vault.path, { authToken: "supersecret" });
			cleanups.push(harness.close);
			const res = await harness.client.callTool({ name: "get_server_info", arguments: {} });
			expect(res.structuredContent).toBeDefined();
		});

		test("empty MCP_AUTH_TOKEN exits before resource acquisition", async () => {
			// `MCP_AUTH_TOKEN=` silently locks out every client (authMatches
			// rejects empty presented tokens). The guard must fire pre-
			// resource so exitWithUsage's process.exit(2) doesn't bypass
			// tearDownAndExit and leak lockfile + SQLite WAL/shm.
			const vault = await createTempVault(FIXTURE);
			cleanups.push(vault.cleanup);
			await expect(spawnHttpTestServer(vault.path, { authToken: "" })).rejects.toThrow();

			const entries = await readdir(indexDir(vault.path)).catch((err: unknown) => {
				// Narrow to ENOENT — EACCES/EIO would otherwise masquerade as test pass.
				if (getErrnoCode(err) === "ENOENT") return [] as string[];
				throw err;
			});
			const lockFiles = entries.filter((e) => /^server-\d+\.lock$/.test(e));
			const sqliteFiles = entries.filter((e) => e.startsWith("index.sqlite3"));
			expect(lockFiles).toEqual([]);
			expect(sqliteFiles).toEqual([]);
		});
	});

	describe("malformed initialize handling", () => {
		// These cases bypass the SDK client (which always sends Requests with
		// an `id` and never sends a Mcp-Session-Id alongside initialize) and
		// post raw JSON via `fetch` so we can exercise the router's gates.

		const INIT_PARAMS = {
			protocolVersion: "2025-06-18",
			capabilities: {},
			clientInfo: { name: "raw-test-client", version: "0" },
		};
		const BASE_HEADERS = {
			"Content-Type": "application/json",
			Accept: "application/json, text/event-stream",
		};

		test("rejects initialize NOTIFICATION (no id) with 400 and does not leak a session", async () => {
			const vault = await createTempVault(FIXTURE);
			cleanups.push(vault.cleanup);
			const harness = await spawnHttpTestServer(vault.path);
			cleanups.push(harness.close);
			const notification = { jsonrpc: "2.0", method: "initialize", params: INIT_PARAMS };

			const res = await fetch(harness.endpoint, {
				method: "POST",
				headers: BASE_HEADERS,
				body: JSON.stringify(notification),
			});
			expect(res.status).toBe(400);
			expect(res.headers.get("mcp-session-id")).toBeNull();

			// Prove no leaked state: the SDK client connected by
			// spawnHttpTestServer can still issue tool calls normally. A
			// leaked McpServer/transport pair would surface as 5xx on
			// subsequent traffic.
			const followUp = await harness.client.callTool({ name: "get_server_info", arguments: {} });
			expect(followUp.structuredContent).toBeDefined();
		});

		test("rejects initialize WITH stale Mcp-Session-Id with 404", async () => {
			const vault = await createTempVault(FIXTURE);
			cleanups.push(vault.cleanup);
			const harness = await spawnHttpTestServer(vault.path);
			cleanups.push(harness.close);
			const staleId = "bogus-stale-uuid-deadbeef";
			const request = { jsonrpc: "2.0", id: 1, method: "initialize", params: INIT_PARAMS };

			const res = await fetch(harness.endpoint, {
				method: "POST",
				headers: { ...BASE_HEADERS, "Mcp-Session-Id": staleId },
				body: JSON.stringify(request),
			});
			expect(res.status).toBe(404);
			const body = (await res.json()) as { error?: { message?: string } };
			expect(body.error?.message).toContain(staleId);
			expect(res.headers.get("mcp-session-id")).toBeNull();
		});
	});

	describe("idle-timeout reclamation", () => {
		// SDK fires `_onsessionclosed` ONLY on explicit DELETE /mcp; TCP
		// disconnect leaves the session map entry intact for process
		// lifetime. The sweep periodically reclaims sessions idle longer
		// than `MCP_HTTP_SESSION_IDLE_MS` (default 30 min, test override
		// 1 s + 200 ms sweep cadence).

		test("session reclaimed after idle window elapses", async () => {
			const vault = await createTempVault(FIXTURE);
			cleanups.push(vault.cleanup);
			const harness = await spawnHttpTestServer(vault.path, {
				extraEnv: {
					MCP_HTTP_SESSION_IDLE_MS: "1000",
					MCP_HTTP_SESSION_SWEEP_MS: "200",
				},
			});
			cleanups.push(harness.close);

			// Prove the session is alive.
			const first = await harness.client.callTool({ name: "get_server_info", arguments: {} });
			expect(first.structuredContent).toBeDefined();

			// Wait long enough for idle (1 s) + at least one sweep tick (200 ms)
			// + slack to land. Sweep stderr line is the canonical observable.
			await new Promise<void>((resolve) => setTimeout(resolve, 1_800));

			const stderr = harness.getStderr();
			expect(stderr).toMatch(/session closing [0-9a-f-]+ \(idle-timeout\)/);
		}, 15_000);

		test("active session is NOT reclaimed mid-flight", async () => {
			// Touch-on-dispatch keeps the timestamp fresh; a session
			// making requests faster than the idle window should never
			// be swept.
			const vault = await createTempVault(FIXTURE);
			cleanups.push(vault.cleanup);
			const harness = await spawnHttpTestServer(vault.path, {
				extraEnv: {
					MCP_HTTP_SESSION_IDLE_MS: "1000",
					MCP_HTTP_SESSION_SWEEP_MS: "200",
				},
			});
			cleanups.push(harness.close);

			// Issue a call every 400 ms over 1.6 s — total elapsed exceeds
			// idle window (1 s) but no inter-call gap does. Sweep must
			// never fire because lastTouchedAt is refreshed each iteration.
			for (let i = 0; i < 4; i++) {
				const res = await harness.client.callTool({ name: "get_server_info", arguments: {} });
				expect(res.structuredContent).toBeDefined();
				await new Promise<void>((resolve) => setTimeout(resolve, 400));
			}

			const stderr = harness.getStderr();
			// Scope the negative-match to the idle-timeout reason: shutdown
			// reclaims fire in afterEach (`session closing X (shutdown)`)
			// and would false-positive a bare /session closing/ pattern.
			expect(stderr).not.toMatch(/session closing .* \(idle-timeout\)/);
		}, 15_000);
	});

	test("SIGTERM drains cleanly within the 5 s budget", async () => {
		const vault = await createTempVault(FIXTURE);
		cleanups.push(vault.cleanup);
		const harness = await spawnHttpTestServer(vault.path);

		// Smoke a tool call to prove the server is fully up, then SIGTERM
		// and assert the child exits within 6 s (5 s drain + 1 s slack).
		await harness.client.callTool({ name: "get_server_info", arguments: {} });

		const startedAt = Date.now();
		const exited = new Promise<number | null>((resolve) => {
			harness.child.once("exit", (code) => resolve(code));
		});
		harness.child.kill("SIGTERM");
		const exitCode = await Promise.race([
			exited,
			new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 6_000)),
		]);
		const elapsed = Date.now() - startedAt;
		expect(exitCode).not.toBe("timeout");
		expect(exitCode).toBe(0);
		expect(elapsed).toBeLessThan(6_000);
		// Don't double-close — harness.close would try to kill an already-dead child.
	}, 30_000);
});
