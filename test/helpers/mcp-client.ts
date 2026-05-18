/**
 * Test helper that spawns a built `markdown-mcp` server as a subprocess
 * and connects to it via the SDK's stdio client transport. Returns the
 * connected `Client` and a tear-down function.
 *
 * Builds against `dist/index.js` (run `npm run build` before tests). CI
 * runs `npm run build` ahead of `npm test` per the workflow.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
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
 * Pull `content[0].text` from a tool response with type guards. Used by
 * tests that need to assert against the prose channel directly (notably
 * `--prose-only` runs where `structuredContent` is omitted, and any
 * assertion that compares the rendered prose against expected substrings).
 */
export function firstText(content: unknown): string {
	const arr = content as Array<{ type: string; text?: string }> | undefined;
	const first = arr?.[0];
	if (!first || first.type !== "text" || typeof first.text !== "string") {
		throw new Error(`expected content[0] to be a text block, got: ${JSON.stringify(arr)}`);
	}
	return first.text;
}

/** Lines starting with `label: ` — line-forgery assertions check the
 * count to detect `\n`-forged labels in user-controlled error fields. */
export function labeledLines(text: string, label: string): string[] {
	return text.split("\n").filter((line) => line.startsWith(`${label}: `));
}

/**
 * Poll until the index reaches `warm`, or ~10s elapses. Tests run their
 * `beforeAll` setup against a fully populated index so vault-wide tools
 * (`search`, `get_links`, `get_vault_tree`) don't return partial counts
 * from a `warming` snapshot. The probe tool is `search` because it
 * surfaces `_meta.index_status` cheaply; the query string is irrelevant.
 */
export async function waitForWarm(client: Client, timeoutMs = 10_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	let lastState: string | undefined;
	while (Date.now() < deadline) {
		const r = await client.callTool({ name: "search", arguments: { query: "x" } });
		const meta = r._meta as MetaEnvelope | undefined;
		lastState = meta?.index_status?.state;
		if (lastState === "warm") return;
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	throw new Error(
		`waitForWarm: index did not reach 'warm' within ${timeoutMs} ms (last state=${lastState ?? "unknown"})`,
	);
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
export async function spawnTestServer(
	vaultPath: string,
	extraEnv: Record<string, string> = {},
	extraArgs: string[] = [],
): Promise<TestClient> {
	const env: Record<string, string> = {};
	for (const [k, v] of Object.entries(process.env)) {
		if (typeof v === "string") env[k] = v;
	}
	for (const [k, v] of Object.entries(extraEnv)) {
		env[k] = v;
	}
	const transport = new StdioClientTransport({
		command: process.execPath,
		args: [SERVER_BIN, "--vault", vaultPath, ...extraArgs],
		stderr: "pipe",
		env,
	});

	const client = new Client(
		{ name: "markdown-mcp-test-client", version: "1.0.0-w1" },
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

/**
 * Spawn a `markdown-mcp` server child WITHOUT the MCP handshake. Streams
 * stderr into a captured buffer; resolves once the "markdown-mcp running
 * on stdio" log line lands (proving `main()` finished startup —
 * lockfile written, SQLite opened, scanner kicked off). The caller
 * inspects the captured stderr and decides when to SIGTERM. Used by
 * tests that need to assert against startup log lines or observe
 * lockfile state pre/post-shutdown.
 */
export interface SpawnedServer {
	child: ChildProcess;
	getStderr(): string;
}

export interface SpawnAndWaitOptions {
	extraArgs?: string[];
	extraEnv?: Record<string, string>;
	/** Substring the spawned process logs to stderr once `waitFor` is reached. */
	waitFor: string;
	timeoutMs?: number;
}

/**
 * Spawn `markdown-mcp` and resolve once stderr contains `waitFor`. Single
 * stderr listener shared between buffer accumulation and trigger
 * detection — the `resolved` guard prevents double-resolve when the
 * trigger lands in a chunk that also contains later content.
 */
export async function spawnAndWaitForStderr(vaultPath: string, opts: SpawnAndWaitOptions): Promise<SpawnedServer> {
	const env: NodeJS.ProcessEnv = { ...process.env, ...opts.extraEnv };
	const child = spawn(process.execPath, [SERVER_BIN, "--vault", vaultPath, ...(opts.extraArgs ?? [])], {
		stdio: ["pipe", "pipe", "pipe"],
		env,
	});
	let stderr = "";
	await new Promise<void>((resolve, reject) => {
		const timer = setTimeout(
			() => reject(new Error(`timed out waiting for stderr "${opts.waitFor}"`)),
			opts.timeoutMs ?? 10_000,
		);
		let resolved = false;
		const onData = (chunk: Buffer): void => {
			stderr += chunk.toString();
			if (!resolved && stderr.includes(opts.waitFor)) {
				resolved = true;
				clearTimeout(timer);
				resolve();
			}
		};
		child.stderr?.on("data", onData);
		child.on("exit", () => {
			clearTimeout(timer);
			if (!resolved) reject(new Error(`child exited before stderr "${opts.waitFor}" arrived`));
		});
	});
	return {
		child,
		getStderr: () => stderr,
	};
}

export async function spawnAndWaitForStartup(
	vaultPath: string,
	extraArgs: string[] = [],
	timeoutMs = 10_000,
): Promise<SpawnedServer> {
	return spawnAndWaitForStderr(vaultPath, {
		extraArgs,
		waitFor: "markdown-mcp running on stdio",
		timeoutMs,
	});
}

/**
 * Await child exit and return the exit code (or null if killed via signal
 * without a code). Thin wrapper over `events.once` so callers don't need
 * to spell out the typed-tuple destructuring at every site.
 */
export async function waitForExit(child: ChildProcess): Promise<number | null> {
	const [code] = (await once(child, "exit")) as [number | null];
	return code;
}

/**
 * Cross-platform graceful-shutdown signal. POSIX: SIGTERM, routed
 * through the same teardown as stdin-EOF. Windows: `child.kill()`
 * ignores the signal name and force-terminates via `TerminateProcess`,
 * so we close stdin instead — the EOF path Claude Desktop uses to shut
 * the server down on Windows.
 */
export function gracefulShutdown(child: ChildProcess): void {
	if (process.platform === "win32") {
		// `?.` is defensive — every caller spawns with stdio: "pipe", so
		// in practice stdin is always defined.
		child.stdin?.end();
	} else {
		child.kill("SIGTERM");
	}
}
