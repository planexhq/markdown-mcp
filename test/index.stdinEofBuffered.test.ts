/**
 * If a client writes a valid `initialize` request then closes its
 * write end BEFORE `server.connect()` runs (cold start, or the test-
 * injected startup delay), the buffered bytes must NOT be dropped by
 * the stdin-EOF shutdown path. The fix: `process.stdin`'s `'end'`
 * listener checks the proxy's `readableLength`; if non-zero, it
 * defers shutdown to the proxy's own `'end'` event (which only fires
 * after the transport has consumed every buffered byte).
 */

import { spawn } from "node:child_process";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { TEST_ENV } from "../src/index.js";
import { SERVER_BIN, waitForExit } from "./helpers/mcp-client.js";
import { createTempVault, type VaultStructure } from "./helpers/vault.js";

const FIXTURE: VaultStructure = {
	"plain.md": "# Plain\n\nVisible note.\n",
};

const STARTUP_DELAY_MS = 1000;

let vault: { path: string; cleanup: () => Promise<void> };

beforeEach(async () => {
	vault = await createTempVault(FIXTURE);
});

afterEach(async () => {
	await vault.cleanup();
});

describe("stdin-EOF with buffered request", () => {
	test("initialize sent before server.connect is still handled", async () => {
		const child = spawn(process.execPath, [SERVER_BIN, "--vault", vault.path], {
			stdio: ["pipe", "pipe", "pipe"],
			env: { ...process.env, [TEST_ENV.STARTUP_DELAY_MS]: String(STARTUP_DELAY_MS) },
		});

		let stdoutBuf = "";
		let stderrBuf = "";
		child.stdout?.on("data", (chunk: Buffer) => {
			stdoutBuf += chunk.toString();
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			stderrBuf += chunk.toString();
		});

		// Write initialize + close stdin BEFORE the child has reached
		// `server.connect`. The startup delay guarantees the child is
		// still in the post-lock pause when stdin EOFs.
		child.stdin?.write(
			`${JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "initialize",
				params: {
					protocolVersion: "2025-06-18",
					capabilities: {},
					clientInfo: { name: "buffered-init-test", version: "0.0.0" },
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
								`child did not exit within 15s. stderr:\n${stderrBuf}\nstdout:\n${stdoutBuf.slice(0, 500)}`,
							),
						),
					15_000,
				),
			),
		]);
		expect(exitCode).toBe(0);

		// Initialize response (id:1) must land on stdout — the regression
		// dropped it because shutdown fired before the transport consumed
		// the proxy buffer.
		expect(stdoutBuf).toContain('"id":1');
		const lines = stdoutBuf.split("\n").filter((line) => line.length > 0);
		const id1Line = lines.find((line) => line.includes('"id":1'));
		expect(id1Line).toBeDefined();
		const parsed = JSON.parse(id1Line ?? "");
		expect(parsed.id).toBe(1);
		expect(parsed.result?.protocolVersion).toBeDefined();
	}, 30_000);
});
