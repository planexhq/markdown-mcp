/**
 * Hidden-file policy is part of cache invalidation, not just walk-time
 * filtering. The same vault restarted under a different `--include-hidden`
 * setting MUST not leak rows from the prior session — otherwise the
 * documented "all-or-nothing per server" invariant (CLAUDE.md gotcha:
 * "Hidden files: all-or-nothing per-server") fails on policy toggle:
 * `walkVault` skips hidden entries on the new walk, but `confirmPrune`
 * (file physically exists) preserved them, and `IndexHandle.search*` /
 * `wikilinks` carry no hidden-row predicate so the old rows continued
 * to surface.
 *
 * Each test reuses ONE vault directory (so the SQLite DB at
 * `<vault>/.vault-mcp/index.sqlite3` is shared across the two server
 * lifecycles) — that's the whole point: verify the second server, with
 * a different policy, cleans up the first server's index.
 */

import { join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import type { GetLinksResult, GetVaultTreeResult, SearchOutput } from "../src/types.js";
import { spawnTestServer, waitForWarm } from "./helpers/mcp-client.js";
import { createTempVault, type VaultStructure } from "./helpers/vault.js";

/** Inspect the persisted `include_hidden` column without opening the
 * full index. Returns `null` for "never written" so we can distinguish
 * legacy/fresh from explicitly-false. */
function readPersistedIncludeHidden(vaultPath: string): number | null {
	const dbPath = join(vaultPath, ".vault-mcp", "index.sqlite3");
	const db = new Database(dbPath, { readonly: true });
	try {
		const row = db.prepare("SELECT include_hidden FROM index_meta WHERE id = 1").get() as
			| {
					include_hidden: number | null;
			  }
			| undefined;
		return row === undefined ? null : row.include_hidden;
	} finally {
		db.close();
	}
}

function setPersistedIncludeHidden(vaultPath: string, value: number | null): void {
	const dbPath = join(vaultPath, ".vault-mcp", "index.sqlite3");
	const db = new Database(dbPath);
	try {
		db.prepare("UPDATE index_meta SET include_hidden = ? WHERE id = 1").run(value);
	} finally {
		db.close();
	}
}

const FIXTURE: VaultStructure = {
	"plain.md": "# Plain\n\nVisible note.\n",
	// Hidden file links AT plain.md so plain's incoming should include
	// .secret.md in hidden-mode, then drop in default-mode.
	".secret.md": "# Secret\n\nHidden content with marker token: dotmarker. Refers [[plain]].\n",
};

let vault: { path: string; cleanup: () => Promise<void> };

beforeEach(async () => {
	vault = await createTempVault(FIXTURE);
});

afterEach(async () => {
	await vault.cleanup();
});

describe("hidden-row cache invalidation on policy flip", () => {
	test("default then --include-hidden: hidden rows added on rescan, not deferred to merkle", async () => {
		// Off→on direction: the startup policy-mismatch check forces
		// scan_complete=false + state=cold so the next scan walks every
		// file and hidden notes appear at first warm signal — not
		// deferred to the merkle tick (5-minute interval).
		const defaultConn = await spawnTestServer(vault.path);
		await waitForWarm(defaultConn.client);
		const baseline = await defaultConn.client.callTool({ name: "search", arguments: { query: "dotmarker" } });
		const baselineFiles = (baseline.structuredContent as SearchOutput).items.map((i) => i.file);
		expect(baselineFiles).not.toContain(".secret.md");
		await defaultConn.close();

		const hiddenConn = await spawnTestServer(vault.path, {}, ["--include-hidden"]);
		try {
			await waitForWarm(hiddenConn.client);
			const search = await hiddenConn.client.callTool({ name: "search", arguments: { query: "dotmarker" } });
			const files = (search.structuredContent as SearchOutput).items.map((i) => i.file);
			expect(files).toContain(".secret.md");
		} finally {
			await hiddenConn.close();
		}
	}, 30_000);

	test("clean warm finish persists current policy", async () => {
		// `markScanFinalized` must write `include_hidden=<current flag>`
		// atomically with `scan_complete=true`; otherwise next-startup
		// mismatch detection has no signal to compare against.
		const conn = await spawnTestServer(vault.path, {}, ["--include-hidden"]);
		await waitForWarm(conn.client);
		await conn.close();
		// Give the closeSqlite + wal_checkpoint a moment to flush.
		await new Promise((r) => setTimeout(r, 100));
		expect(readPersistedIncludeHidden(vault.path)).toBe(1);

		const conn2 = await spawnTestServer(vault.path);
		await waitForWarm(conn2.client);
		await conn2.close();
		await new Promise((r) => setTimeout(r, 100));
		expect(readPersistedIncludeHidden(vault.path)).toBe(0);
	}, 30_000);

	test("interrupted policy-flip rebuild preserves prior policy so next startup re-forces rescan", async () => {
		// SIGTERM mid-flip scenario: the persisted `include_hidden` must
		// describe the last clean finish (not the in-flight process), so
		// an interrupted rebuild still mismatches on the next startup and
		// re-arms cold rescan instead of advertising the pre-flip snapshot
		// as warm via the `(preexisted && everComplete)` branch.
		const hiddenConn = await spawnTestServer(vault.path, {}, ["--include-hidden"]);
		await waitForWarm(hiddenConn.client);
		await hiddenConn.close();
		await new Promise((r) => setTimeout(r, 100));
		expect(readPersistedIncludeHidden(vault.path)).toBe(1);

		// Approximate "SIGTERM mid-rebuild": flip scan_complete=0 on disk,
		// matching what `setScanComplete(false)` would do at the mismatch
		// branch. `markScanFinalized` never ran, so `include_hidden` stays
		// at 1 (the previous clean snapshot's policy).
		const db = new Database(join(vault.path, ".vault-mcp", "index.sqlite3"));
		try {
			db.prepare("UPDATE index_meta SET scan_complete = 0 WHERE id = 1").run();
		} finally {
			db.close();
		}

		const defaultConn = await spawnTestServer(vault.path);
		try {
			await waitForWarm(defaultConn.client);
			const search = await defaultConn.client.callTool({ name: "search", arguments: { query: "dotmarker" } });
			const files = (search.structuredContent as SearchOutput).items.map((i) => i.file);
			expect(files).not.toContain(".secret.md");
		} finally {
			await defaultConn.close();
		}
		await new Promise((r) => setTimeout(r, 100));
		expect(readPersistedIncludeHidden(vault.path)).toBe(0);
	}, 30_000);

	test("legacy NULL include_hidden + --include-hidden=on forces cold rescan", async () => {
		// Pre-W5 caches were always built under the default off policy, so
		// NULL must compare-as-`false` at the mismatch check — otherwise an
		// upgrader enters warm via `(preexisted && everComplete)` and
		// serves the visible-only snapshot until the merkle tick.
		const defaultConn = await spawnTestServer(vault.path);
		await waitForWarm(defaultConn.client);
		await defaultConn.close();
		await new Promise((r) => setTimeout(r, 100));
		// Force NULL to simulate a pre-W5 cache.
		setPersistedIncludeHidden(vault.path, null);
		expect(readPersistedIncludeHidden(vault.path)).toBeNull();

		const hiddenConn = await spawnTestServer(vault.path, {}, ["--include-hidden"]);
		try {
			await waitForWarm(hiddenConn.client);
			const search = await hiddenConn.client.callTool({ name: "search", arguments: { query: "dotmarker" } });
			const files = (search.structuredContent as SearchOutput).items.map((i) => i.file);
			expect(files).toContain(".secret.md");
		} finally {
			await hiddenConn.close();
		}
		await new Promise((r) => setTimeout(r, 100));
		expect(readPersistedIncludeHidden(vault.path)).toBe(1);
	}, 30_000);

	test("--include-hidden then default: hidden rows pruned from search/links/tree", async () => {
		// Pass 1: index everything including hidden. Confirm baseline that
		// the hidden row + its outgoing wikilink → plain.md exist.
		const hiddenConn = await spawnTestServer(vault.path, {}, ["--include-hidden"]);
		await waitForWarm(hiddenConn.client);
		const hiddenSearch = await hiddenConn.client.callTool({ name: "search", arguments: { query: "dotmarker" } });
		const hiddenFiles = (hiddenSearch.structuredContent as SearchOutput).items.map((i) => i.file);
		expect(hiddenFiles).toContain(".secret.md");
		const hiddenLinks = await hiddenConn.client.callTool({
			name: "get_links",
			arguments: { file: "plain.md", direction: "in" },
		});
		const hiddenInSources = ((hiddenLinks.structuredContent as GetLinksResult).incoming ?? []).map(
			(l) => l.source_file,
		);
		expect(hiddenInSources).toContain(".secret.md");
		await hiddenConn.close();

		// Pass 2: same vault, default policy. Reconcile must purge the hidden row.
		const defaultConn = await spawnTestServer(vault.path);
		try {
			await waitForWarm(defaultConn.client);
			const search = await defaultConn.client.callTool({
				name: "search",
				arguments: { query: "dotmarker" },
			});
			const files = (search.structuredContent as SearchOutput).items.map((i) => i.file);
			expect(files).not.toContain(".secret.md");

			const tree = await defaultConn.client.callTool({
				name: "get_vault_tree",
				arguments: { depth: 5, pageSize: 100 },
			});
			const treePaths = (tree.structuredContent as GetVaultTreeResult).items.map((i) => i.path);
			expect(treePaths).not.toContain(".secret.md");

			// `removeFile` cascades — pruning the hidden source file drops
			// its wikilinks rows in the same transaction.
			const links = await defaultConn.client.callTool({
				name: "get_links",
				arguments: { file: "plain.md", direction: "in" },
			});
			expect(links.isError).toBeFalsy();
			const inSources = ((links.structuredContent as GetLinksResult).incoming ?? []).map((l) => l.source_file);
			expect(inSources).not.toContain(".secret.md");
		} finally {
			await defaultConn.close();
		}
	}, 30_000);
});
