/**
 * Stdin-EOF during the pre-`server.connect` startup window (lock
 * acquisition, SQLite open, scanner setup, the test-injected startup
 * delay) must trigger shutdown promptly. `process.stdin` is paused by
 * default and only emits `'end'` after consumption; the SDK transport
 * doesn't attach a data listener until `server.connect` runs, well
 * after lock acquisition. The fix pipes `process.stdin` to a
 * PassThrough at the top of `main()` so EOF reaches the `'end'`
 * listener immediately. Repro uses `MARKDOWN_MCP_TEST_STARTUP_DELAY_MS`
 * to extend the startup window and asserts the child exits much
 * sooner than the delay would otherwise force.
 */

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { TEST_ENV } from "../src/index.js";
import { spawnAndWaitForStderr, waitForExit } from "./helpers/mcp-client.js";
import { createTempVault, type VaultStructure } from "./helpers/vault.js";

const FIXTURE: VaultStructure = {
	"plain.md": "# Plain\n\nVisible note.\n",
};

const STARTUP_DELAY_MS = 1500;

let vault: { path: string; cleanup: () => Promise<void> };

beforeEach(async () => {
	vault = await createTempVault(FIXTURE);
});

afterEach(async () => {
	await vault.cleanup();
});

describe("stdin-EOF during startup", () => {
	test("stdin close during startup-delay triggers prompt shutdown", async () => {
		const server = await spawnAndWaitForStderr(vault.path, {
			extraEnv: { [TEST_ENV.STARTUP_DELAY_MS]: String(STARTUP_DELAY_MS) },
			waitFor: `${TEST_ENV.STARTUP_DELAY_MS}=${STARTUP_DELAY_MS}`,
		});

		// At this point the child has logged the pause line; it's
		// definitely inside the startup-delay `sleep(...)` call.
		const closedAt = Date.now();
		server.child.stdin?.end();

		const exitCode = await waitForExit(server.child);
		const elapsed = Date.now() - closedAt;

		expect(exitCode).toBe(0);
		// Without the pipe fix, the child would have completed the full
		// 1.5 s delay before `transport.start()` resumed stdin and
		// surfaced the EOF. With the fix, EOF reaches the `'end'`
		// listener within ms; threshold leaves generous CI headroom but
		// still rejects the broken behavior.
		expect(elapsed).toBeLessThan(STARTUP_DELAY_MS - 300);
	}, 30_000);
});
