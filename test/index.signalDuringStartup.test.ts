/**
 * SIGTERM during the startup window between lock-acquisition and the
 * rest of `main()` must still release the lockfile. Without the
 * signal-handler hoist, handlers would install at the end of `main()`,
 * so a signal arriving
 * during `openSqliteWithRecovery` / scanner setup / `server.connect`
 * default-exited Node without calling `lock.release()`, leaking
 * `server-<pid>.lock`. The orphan then composed with PID reuse to
 * surface bogus conflicts on the next start.
 *
 * Uses the `MARKDOWN_MCP_TEST_STARTUP_DELAY_MS` env-var hook in
 * `src/index.ts` to deterministically pause main() between lock
 * acquisition and the rest of startup.
 */

import { stat } from "node:fs/promises";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { TEST_ENV } from "../src/index.js";
import { ownLockPath } from "./helpers/indexDir.js";
import { spawnAndWaitForStderr, waitForExit } from "./helpers/mcp-client.js";
import { createTempVault, type VaultStructure } from "./helpers/vault.js";

const FIXTURE: VaultStructure = {
	"plain.md": "# Plain\n\nVisible note.\n",
};

const STARTUP_DELAY_MS = 500;

let vault: { path: string; cleanup: () => Promise<void> };

beforeEach(async () => {
	vault = await createTempVault(FIXTURE);
});

afterEach(async () => {
	await vault.cleanup();
});

describe("signal during startup", () => {
	test("SIGTERM after lock acquisition but before full startup unlinks the lockfile", async () => {
		const server = await spawnAndWaitForStderr(vault.path, {
			extraEnv: { [TEST_ENV.STARTUP_DELAY_MS]: String(STARTUP_DELAY_MS) },
			waitFor: `${TEST_ENV.STARTUP_DELAY_MS}=${STARTUP_DELAY_MS}`,
		});
		const pid = server.child.pid;
		if (pid === undefined) throw new Error("child PID missing");
		const lockPath = ownLockPath(vault.path, pid);
		// Lockfile exists in the pause window — proves we're past acquire.
		await expect(stat(lockPath)).resolves.toBeTruthy();

		server.child.kill("SIGTERM");
		await waitForExit(server.child);

		await expect(stat(lockPath)).rejects.toThrow(/ENOENT/);
	}, 30_000);
});
