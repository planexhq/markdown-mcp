/**
 * Stdin-EOF mid-request must not truncate the response. The in-flight
 * drain in `tearDownAndExit` waits for outgoing `transport.send` to
 * fully resolve — including the SDK's wait on stdout's `drain` event
 * under backpressure — before `process.exit()` discards the buffer.
 *
 * Two scenarios exercise the fix:
 *   1. Small response, immediate EOF — the basic stdin-EOF race.
 *   2. Large response with the parent's stdout reader paused — forces
 *      `send` to await stdout drain. Without the transport-level
 *      tracking, the handler decrement fires before `send` blocks,
 *      `drain` returns `"drained"` prematurely, and `process.exit()`
 *      truncates the response.
 */

import { type ChildProcess, spawn } from "node:child_process";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { SERVER_BIN, waitForExit } from "./helpers/mcp-client.js";
import { createTempVault, type VaultStructure } from "./helpers/vault.js";

interface InitializedChild {
	child: ChildProcess;
	getStdout: () => string;
	getStderr: () => string;
}

/** Resolve when `getBuf()` contains `needle`, or reject after `timeoutMs`.
 * The timeout error appends the buffer's current value so the caller
 * sees what was accumulated when the wait gave up. */
function waitForSubstring(
	stream: NodeJS.ReadableStream | null | undefined,
	getBuf: () => string,
	needle: string,
	timeoutLabel: string,
	timeoutMs = 5000,
): Promise<void> {
	return new Promise((resolve, reject) => {
		const check = (): void => {
			if (!getBuf().includes(needle)) return;
			clearTimeout(timer);
			stream?.removeListener("data", check);
			resolve();
		};
		const timer = setTimeout(() => {
			stream?.removeListener("data", check);
			reject(new Error(`${timeoutLabel} (buffer tail: ${getBuf().slice(-200)})`));
		}, timeoutMs);
		stream?.on("data", check);
		check();
	});
}

/**
 * Spawn `dist/index.js --vault <vaultPath>`, perform a hand-rolled MCP
 * initialize handshake, send the `notifications/initialized` ack, and
 * return the child + buffer getters. Each test in this file diverges
 * after this point with its own request / shutdown sequence.
 */
async function spawnAndInitialize(vaultPath: string, clientName: string): Promise<InitializedChild> {
	const child = spawn(process.execPath, [SERVER_BIN, "--vault", vaultPath], {
		stdio: ["pipe", "pipe", "pipe"],
	});
	let stdoutBuf = "";
	let stderrBuf = "";
	child.stdout?.on("data", (chunk: Buffer) => {
		stdoutBuf += chunk.toString();
	});
	child.stderr?.on("data", (chunk: Buffer) => {
		stderrBuf += chunk.toString();
	});

	child.stdin?.write(
		`${JSON.stringify({
			jsonrpc: "2.0",
			id: 1,
			method: "initialize",
			params: {
				protocolVersion: "2025-06-18",
				capabilities: {},
				clientInfo: { name: clientName, version: "0.0.0" },
			},
		})}\n`,
	);

	await waitForSubstring(child.stdout, () => stdoutBuf, '"id":1', "timeout waiting for initialize response");

	child.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);

	return { child, getStdout: () => stdoutBuf, getStderr: () => stderrBuf };
}

/** ~200 headings — forces a non-trivial parse so the handler is still
 * running when stdin EOF lands a few ms after the request write. */
function buildLargeFile(): string {
	const sections: string[] = [];
	for (let i = 0; i < 200; i++) {
		sections.push(`# Section ${i}\n\nParagraph for section ${i}. Some body text to make parsing measurable.\n`);
	}
	return sections.join("\n");
}

/** ~150 KB of body content. The JSON-RPC response wrapping the file
 * fragment (content + structuredContent) lands above the kernel pipe
 * buffer (~64 KB on macOS/Linux), so pausing the parent's stdout
 * reader forces `stdout.write` to return false in the server and
 * `transport.send` to await the `drain` event. */
function buildHugeFile(): string {
	const para = `${"Lorem ipsum dolor sit amet, consectetur adipiscing elit. ".repeat(10)}\n\n`;
	return `# Huge\n\n${para.repeat(250)}`;
}

const FIXTURE: VaultStructure = {
	"large.md": buildLargeFile(),
	"huge.md": buildHugeFile(),
};

let vault: { path: string; cleanup: () => Promise<void> };

beforeEach(async () => {
	vault = await createTempVault(FIXTURE);
});

afterEach(async () => {
	await vault.cleanup();
});

describe("stdin-EOF during in-flight request", () => {
	test("tools/call response lands on stdout before child exits", async () => {
		const { child, getStdout, getStderr } = await spawnAndInitialize(vault.path, "stdin-eof-test");

		// Send the tools/call and immediately close stdin — the handler
		// is necessarily still running when EOF fires.
		child.stdin?.write(
			`${JSON.stringify({
				jsonrpc: "2.0",
				id: 2,
				method: "tools/call",
				params: {
					name: "get_fragment",
					arguments: {
						file: "large.md",
						anchor: { kind: "heading_path", path: ["Section 100"] },
					},
				},
			})}\n`,
		);
		child.stdin?.end();

		const exitCode = await Promise.race([
			waitForExit(child),
			new Promise<number>((_, reject) =>
				setTimeout(
					() =>
						reject(
							new Error(
								`child did not exit within 10s. stderr:\n${getStderr()}\nstdout (truncated):\n${getStdout().slice(0, 500)}`,
							),
						),
					10_000,
				),
			),
		]);
		expect(exitCode).toBe(0);

		const stdoutBuf = getStdout();
		expect(stdoutBuf).toContain('"id":1');
		expect(stdoutBuf).toContain('"id":2');

		const lines = stdoutBuf.split("\n").filter((line) => line.length > 0);
		const id2Line = lines.find((line) => line.includes('"id":2'));
		expect(id2Line).toBeDefined();
		const parsed = JSON.parse(id2Line ?? "");
		expect(parsed.id).toBe(2);
		expect(parsed.result?.content ?? parsed.error).toBeDefined();
	}, 30_000);

	test("backpressured large response is fully delivered before child exits", async () => {
		const { child, getStdout, getStderr } = await spawnAndInitialize(vault.path, "stdin-eof-bp-test");

		// Pause stdout BEFORE sending the tools/call. The response will
		// fill the parent's Readable buffer (~16 KB) and then the kernel
		// pipe (~64 KB) — at that point the server's stdout.write returns
		// false and `transport.send` awaits the `drain` event. Pre-fix,
		// the handler decrement fired before this wait; the drain
		// returned immediately and `process.exit()` truncated the queued
		// stdout buffer.
		child.stdout?.pause();

		child.stdin?.write(
			`${JSON.stringify({
				jsonrpc: "2.0",
				id: 2,
				method: "tools/call",
				params: {
					name: "get_fragment",
					arguments: { file: "huge.md", anchor: { kind: "file" } },
				},
			})}\n`,
		);
		child.stdin?.end();

		// Let the server's tearDownAndExit run while transport.send is
		// blocked on stdout drain.
		await new Promise((r) => setTimeout(r, 500));

		// Resume — the OS pipe drains, the server's send promise
		// resolves, the inflight counter hits zero, the drain resolves,
		// and the server proceeds to clean exit.
		child.stdout?.resume();

		const exitCode = await Promise.race([
			waitForExit(child),
			new Promise<number>((_, reject) =>
				setTimeout(
					() =>
						reject(
							new Error(
								`child did not exit within 15s. stderr:\n${getStderr()}\nstdout length: ${getStdout().length}`,
							),
						),
					15_000,
				),
			),
		]);
		expect(exitCode).toBe(0);

		const lines = getStdout().split("\n").filter((line) => line.length > 0);
		const id2Line = lines.find((line) => line.includes('"id":2'));
		expect(id2Line).toBeDefined();
		// Response must be large enough that we actually exercised
		// backpressure — sanity check.
		expect(id2Line && id2Line.length).toBeGreaterThan(80_000);
		const parsed = JSON.parse(id2Line ?? "");
		expect(parsed.id).toBe(2);
		expect(parsed.result?.content?.[0]?.text).toBeDefined();
	}, 30_000);

	test("SIGTERM mid-request: late client request is dropped, not raced to exit", async () => {
		const { child, getStdout, getStderr } = await spawnAndInitialize(vault.path, "sigterm-race-test");

		// Pause the parent's stdout reader so the upcoming response
		// backpressures inside the server's `transport.send`. This pins
		// the first request mid-flight and lets us deterministically
		// interleave a SIGTERM + late request before drain resolves.
		child.stdout?.pause();

		child.stdin?.write(
			`${JSON.stringify({
				jsonrpc: "2.0",
				id: 2,
				method: "tools/call",
				params: {
					name: "get_fragment",
					arguments: { file: "huge.md", anchor: { kind: "file" } },
				},
			})}\n`,
		);

		await new Promise((r) => setTimeout(r, 200));

		// SIGTERM → tearDownAndExit replaces transport.onmessage with a
		// no-op AND awaits drain (which is blocked by the backpressured
		// first send).
		child.kill("SIGTERM");

		// Wait until the child's SIGTERM handler has actually run.
		// `console.error(reason)` in tearDownAndExit fires immediately
		// before the onmessage override (no await between them), so by
		// the time we observe the log line on stderr the override has
		// landed. A fixed sleep wasn't deterministic enough under load.
		await waitForSubstring(child.stderr, getStderr, "received SIGTERM", "SIGTERM ack timeout");

		// Late request — must be dropped at the replaced onmessage.
		// Without the fix the SDK would dispatch it, the handler would
		// run, and its `transport.send` would race `process.exit()`.
		child.stdin?.write(
			`${JSON.stringify({
				jsonrpc: "2.0",
				id: 3,
				method: "tools/call",
				params: { name: "get_server_info", arguments: {} },
			})}\n`,
		);

		await new Promise((r) => setTimeout(r, 200));

		// Resume — the OS pipe drains, the first send resolves,
		// drain resolves, server proceeds to clean exit.
		child.stdout?.resume();

		const exitCode = await Promise.race([
			waitForExit(child),
			new Promise<number>((_, reject) =>
				setTimeout(
					() =>
						reject(
							new Error(
								`child did not exit within 15s. stderr:\n${getStderr()}\nstdout length: ${getStdout().length}`,
							),
						),
					15_000,
				),
			),
		]);
		expect(exitCode).toBe(0);

		const lines = getStdout().split("\n").filter((line) => line.length > 0);

		// First request (id:2) was in flight when SIGTERM landed — its
		// response must arrive intact via the drain.
		const id2Line = lines.find((line) => line.includes('"id":2'));
		expect(id2Line).toBeDefined();
		const id2Parsed = JSON.parse(id2Line ?? "");
		expect(id2Parsed.id).toBe(2);

		// Late request (id:3) must be silently dropped — no response
		// line in stdout. (If it were dispatched, the response would
		// either land here OR race process.exit and truncate — both
		// are wrong; the fix drops it at the onmessage layer.)
		const id3Line = lines.find((line) => line.includes('"id":3'));
		expect(id3Line).toBeUndefined();

		// Every emitted line must be a complete JSON object — guards
		// against truncation regardless of whether id:3 happened to
		// race in some flaky way.
		for (const line of lines) {
			expect(() => JSON.parse(line)).not.toThrow();
		}
	}, 30_000);
});
