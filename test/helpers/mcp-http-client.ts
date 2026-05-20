/**
 * Test helper that spawns a built `markdown-mcp` server in HTTP mode and
 * connects to it via the SDK's `StreamableHTTPClientTransport`. Mirrors
 * `mcp-client.ts` but for the `--transport http` path.
 *
 * The server is spawned with `--port 0` so the OS picks a free port; the
 * helper reuses `spawnAndWaitForStderr` (stdio harness) to wait for the
 * startup log line, then regex-extracts the OS-assigned port from the
 * captured stderr. Caller must `await close()` (closes the SDK client
 * and SIGTERMs the subprocess).
 */

import type { ChildProcess } from "node:child_process";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { type SpawnedServer, spawnAndWaitForStderr } from "./mcp-client.js";

/**
 * Send SIGTERM, then SIGKILL if the child hasn't exited within 6 s.
 * No-op when the child has already exited. Used by both the connect-
 * failure cleanup path and the public `close()` so the SIGTERM→SIGKILL
 * escalation isn't duplicated.
 */
async function terminateChild(child: ChildProcess): Promise<void> {
	if (child.exitCode !== null) return;
	child.kill("SIGTERM");
	await new Promise<void>((resolve) => {
		// Capture the timer so the exit listener can cancel it. Without
		// this, a fast-exiting child still keeps a pending 6 s timer in
		// the event loop, delaying test process teardown by that much.
		const timer = setTimeout(() => {
			if (child.exitCode === null) child.kill("SIGKILL");
			resolve();
		}, 6_000);
		child.once("exit", () => {
			clearTimeout(timer);
			resolve();
		});
	});
}

export interface HttpTestClient extends SpawnedServer {
	client: Client;
	port: number;
	/** `http://127.0.0.1:<port>/mcp` — useful for raw `fetch` tests that
	 *  bypass the SDK client. Bind is always 127.0.0.1 (HTTP harness default). */
	endpoint: string;
	close: () => Promise<void>;
}

export interface SpawnHttpServerOptions {
	/** Bearer token; populates `MCP_AUTH_TOKEN` env var AND the client's
	 *  `Authorization: Bearer <token>` header. Tests that assert auth
	 *  rejection set this on the server but pass a different value (or
	 *  none) on the client side. */
	authToken?: string;
	/** Token actually sent by the client. Defaults to {@link authToken}
	 *  when omitted — set to `null` to spawn a server with auth but a
	 *  client without. */
	clientAuthToken?: string | null;
	extraArgs?: string[];
	extraEnv?: Record<string, string>;
	timeoutMs?: number;
}

/**
 * Spawn `node dist/index.js --vault <vault> --transport http --port 0`,
 * wait for the startup log line, extract the OS-assigned port, then
 * connect a `StreamableHTTPClientTransport` against it. Resolves the
 * connected client + the resolved port for test assertions.
 */
export async function spawnHttpTestServer(
	vaultPath: string,
	opts: SpawnHttpServerOptions = {},
): Promise<HttpTestClient> {
	const extraEnv: Record<string, string> = { ...(opts.extraEnv ?? {}) };
	if (opts.authToken !== undefined) extraEnv.MCP_AUTH_TOKEN = opts.authToken;

	const spawned = await spawnAndWaitForStderr(vaultPath, {
		extraArgs: ["--transport", "http", "--port", "0", ...(opts.extraArgs ?? [])],
		extraEnv,
		// When no token is requested, strip any inherited `MCP_AUTH_TOKEN`
		// so a developer/CI shell with the var set doesn't silently spawn
		// an auth-required server and break un-authed tests with a 401.
		...(opts.authToken === undefined && { clearEnv: ["MCP_AUTH_TOKEN"] }),
		waitFor: "running on http://",
		...(opts.timeoutMs !== undefined && { timeoutMs: opts.timeoutMs }),
	});

	// Accept both `http://127.0.0.1:<port>` and `http://[::1]:<port>` shapes
	// so future IPv6 tests parse cleanly without a regex change.
	const match = /running on http:\/\/(?:\[[^\]]+\]|[^\s:]+):(\d+)/.exec(spawned.getStderr());
	if (!match) {
		spawned.child.kill("SIGTERM");
		throw new Error(`HTTP startup log lacked port; got:\n${spawned.getStderr()}`);
	}
	const port = Number.parseInt(match[1] ?? "0", 10);
	const endpoint = `http://127.0.0.1:${port}/mcp`;

	// `clientAuthToken === null` means "spawn a server with auth, but send
	// no client header" — distinct from "no token configured anywhere"
	// (both undefined). String values are used as-is.
	const clientAuth = opts.clientAuthToken === null ? undefined : (opts.clientAuthToken ?? opts.authToken);
	const requestInit: RequestInit =
		clientAuth !== undefined ? { headers: { Authorization: `Bearer ${clientAuth}` } } : {};

	const transport = new StreamableHTTPClientTransport(new URL(endpoint), {
		requestInit,
	});
	const client = new Client({ name: "markdown-mcp-http-test-client", version: "1.0.0" }, { capabilities: {} });
	try {
		await client.connect(transport);
	} catch (err) {
		// Bearer-auth rejection tests rely on this throwing; without
		// cleanup the spawned child keeps listening on the loopback
		// port and holding the temp vault open until OS reap.
		await terminateChild(spawned.child);
		throw err;
	}

	return {
		client,
		port,
		endpoint,
		child: spawned.child,
		getStderr: spawned.getStderr,
		close: async () => {
			try {
				await client.close();
			} catch {
				// Client may already be torn down by the time the test closes.
			}
			await terminateChild(spawned.child);
		},
	};
}
