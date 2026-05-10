/**
 * Startup check: a scan interrupted mid-flip + revert-restart must
 * force a cold rescan instead of treating the contaminated snapshot
 * as warm. The last-clean policy column only sees the most recent
 * cleanly-finalized state; this test injects the in-flight column +
 * restart and verifies the rebuild log fires.
 */

import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { closeSqlite, openSqlite } from "../src/lib/index/sqlite.js";
import { POLICY_MISMATCH_LOG_FRAGMENT } from "../src/lib/startup.js";
import { indexDir } from "./helpers/indexDir.js";
import { spawnAndWaitForStartup, waitForExit } from "./helpers/mcp-client.js";
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

function dbPath(vaultPath: string): string {
	return join(indexDir(vaultPath), "index.sqlite3");
}

interface InjectArgs {
	scanComplete: number;
	everComplete: number;
	includeHidden: number | null;
	inflightIncludeHidden: number | null;
}

function injectState(vaultPath: string, args: InjectArgs): void {
	const db = new Database(dbPath(vaultPath));
	try {
		db.prepare(
			`UPDATE index_meta
			 SET scan_complete = :scan_complete,
			     ever_complete = :ever_complete,
			     include_hidden = :include_hidden,
			     inflight_include_hidden = :inflight_include_hidden
			 WHERE id = 1`,
		).run({
			scan_complete: args.scanComplete,
			ever_complete: args.everComplete,
			include_hidden: args.includeHidden,
			inflight_include_hidden: args.inflightIncludeHidden,
		});
	} finally {
		db.close();
	}
}

async function captureStartupStderr(vaultPath: string, extraArgs: string[] = []): Promise<string> {
	const server = await spawnAndWaitForStartup(vaultPath, extraArgs);
	try {
		server.child.kill("SIGTERM");
		await waitForExit(server.child);
		return server.getStderr();
	} finally {
		if (server.child.exitCode === null) server.child.kill("SIGKILL");
	}
}

async function bootstrapSchema(vaultPath: string): Promise<void> {
	// In-process schema priming. `openSqlite` runs `runMigrationV1` which
	// creates `index_meta` + seeds the `id=1` row. Skips ~200 ms of full
	// server spawn per test — the spawned-server path adds no coverage that
	// the actual policy-flip restart spawn doesn't already exercise.
	await mkdir(indexDir(vaultPath), { recursive: true });
	const opened = openSqlite({ dbPath: dbPath(vaultPath) });
	closeSqlite(opened.db);
}

describe("startup policy-mismatch detection — interrupted-flip variant", () => {
	test("off→on→off revert (interrupted off→on flip, restart without flag) forces cold rescan", async () => {
		await bootstrapSchema(vault.path);

		// Simulate: a previous run with --include-hidden=true started a
		// rescan (setInflightIncludeHidden=1) and was SIGTERMed before
		// markScanFinalized cleared it. The clean-scan policy from before
		// the flip is still persisted as `include_hidden=0`.
		injectState(vault.path, {
			scanComplete: 0,
			everComplete: 1,
			includeHidden: 0,
			inflightIncludeHidden: 1,
		});

		// Restart WITHOUT the flag (revert). The interrupted-mismatch
		// signal forces cold rescan; everComplete alone would advertise
		// warm against a contaminated snapshot.
		const stderr = await captureStartupStderr(vault.path);
		expect(stderr).toContain(POLICY_MISMATCH_LOG_FRAGMENT);
	}, 30_000);

	test("on→off→on revert (interrupted on→off flip, restart with flag) forces cold rescan", async () => {
		await bootstrapSchema(vault.path);

		injectState(vault.path, {
			scanComplete: 0,
			everComplete: 1,
			includeHidden: 1,
			inflightIncludeHidden: 0,
		});

		const stderr = await captureStartupStderr(vault.path, ["--include-hidden"]);
		expect(stderr).toContain(POLICY_MISMATCH_LOG_FRAGMENT);
	}, 30_000);

	test("no-flip case (inflight matches args) stays warm — no over-fire", async () => {
		await bootstrapSchema(vault.path);

		// Same-policy interrupted reconcile must NOT escalate to a cold
		// rescan — it's a routine SIGTERM during reconcile, the prior
		// snapshot is still under the right policy.
		injectState(vault.path, {
			scanComplete: 0,
			everComplete: 1,
			includeHidden: 0,
			inflightIncludeHidden: 0,
		});

		const stderr = await captureStartupStderr(vault.path);
		expect(stderr).not.toContain(POLICY_MISMATCH_LOG_FRAGMENT);
	}, 30_000);

	test("legacy DB (inflight column NULL) under no-flip stays warm", async () => {
		await bootstrapSchema(vault.path);

		// Legacy upgrade: inflight column was never written, but no
		// last-clean mismatch either. Don't force cold rescan on every
		// upgrade — the last-clean check still catches genuine flips.
		injectState(vault.path, {
			scanComplete: 0,
			everComplete: 1,
			includeHidden: 0,
			inflightIncludeHidden: null,
		});

		const stderr = await captureStartupStderr(vault.path);
		expect(stderr).not.toContain(POLICY_MISMATCH_LOG_FRAGMENT);
	}, 30_000);
});
