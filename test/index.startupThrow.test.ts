/**
 * A thrown error in the post-lock startup window (e.g.
 * `openSqliteWithRecovery` non-corruption errno, `server.connect`
 * throw) must still release the per-PID lockfile — the signal-handler
 * hoist closed the SIGTERM leak path; this test covers the parallel
 * thrown-error path.
 *
 * Uses the `VAULT_MCP_TEST_STARTUP_FAIL_AFTER_LOCK=1` env-var hook in
 * `src/index.ts` to deterministically throw immediately after the
 * lock + test-delay gate, before any other resources are populated.
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

let vault: { path: string; cleanup: () => Promise<void> };

beforeEach(async () => {
	vault = await createTempVault(FIXTURE);
});

afterEach(async () => {
	await vault.cleanup();
});

describe("startup throw after lock acquisition", () => {
	test("post-lock thrown error releases the lockfile and exits 1", async () => {
		const server = await spawnAndWaitForStderr(vault.path, {
			extraEnv: { [TEST_ENV.STARTUP_FAIL_AFTER_LOCK]: "1" },
			waitFor: TEST_ENV.FAIL_AFTER_LOCK_MESSAGE,
		});
		const pid = server.child.pid;
		if (pid === undefined) throw new Error("child PID missing");

		expect(await waitForExit(server.child)).toBe(1);

		await expect(stat(ownLockPath(vault.path, pid))).rejects.toThrow(/ENOENT/);
	}, 30_000);

	// After a startup-failure teardown, a fresh process with the opposite
	// --include-hidden must acquire cleanly — proves the catch path stops
	// writers before releasing the lock, not just releases the lock.
	test("opposite-policy second spawn after failed startup acquires cleanly", async () => {
		const first = await spawnAndWaitForStderr(vault.path, {
			extraEnv: { [TEST_ENV.STARTUP_FAIL_AFTER_LOCK]: "1" },
			waitFor: TEST_ENV.FAIL_AFTER_LOCK_MESSAGE,
		});
		expect(await waitForExit(first.child)).toBe(1);

		const second = await spawnAndWaitForStderr(vault.path, {
			extraArgs: ["--include-hidden"],
			waitFor: "vault-mcp running on stdio",
		});
		try {
			expect(second.child.pid).toBeDefined();
			await expect(stat(ownLockPath(vault.path, second.child.pid as number))).resolves.toBeTruthy();
		} finally {
			second.child.kill("SIGTERM");
			await waitForExit(second.child);
		}
	}, 30_000);
});
