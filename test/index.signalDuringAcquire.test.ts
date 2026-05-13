/**
 * SIGTERM during `acquireServerLock`'s reconcile pass — between own-slot
 * creation and the function's return — must still release the lockfile.
 * Uses `MARKDOWN_MCP_TEST_RECONCILE_DELAY_MS` to deterministically pause
 * inside the `onSlotCreated` callback (mirror of `STARTUP_DELAY_MS` for
 * the post-acquire window covered by `index.signalDuringStartup`).
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

const RECONCILE_DELAY_MS = 500;

let vault: { path: string; cleanup: () => Promise<void> };

beforeEach(async () => {
	vault = await createTempVault(FIXTURE);
});

afterEach(async () => {
	await vault.cleanup();
});

describe("signal during acquire", () => {
	test("SIGTERM inside acquireServerLock's onSlotCreated pause unlinks the lockfile", async () => {
		const server = await spawnAndWaitForStderr(vault.path, {
			extraEnv: { [TEST_ENV.RECONCILE_DELAY_MS]: String(RECONCILE_DELAY_MS) },
			waitFor: `${TEST_ENV.RECONCILE_DELAY_MS}=${RECONCILE_DELAY_MS}`,
		});
		const pid = server.child.pid;
		if (pid === undefined) throw new Error("child PID missing");
		const lockPath = ownLockPath(vault.path, pid);
		// Lockfile exists during the acquire-window pause — proves the
		// own-slot is on disk and we're inside the callback.
		await expect(stat(lockPath)).resolves.toBeTruthy();

		server.child.kill("SIGTERM");
		await waitForExit(server.child);

		await expect(stat(lockPath)).rejects.toThrow(/ENOENT/);
	}, 30_000);
});
