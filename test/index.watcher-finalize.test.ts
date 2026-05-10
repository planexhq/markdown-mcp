/**
 * Watcher-driven scan finalization.
 *
 * A parse-failed file on cold start leaves the index at `state=warming` +
 * `scan_complete=false`. The watcher's `reindexCallback` calls
 * `clearPendingRetry(rel)` on `indexed` / `vanished` outcomes; when the
 * set empties, `markScanFinalized()` flips state to `warm`. Without this
 * path, vault-wide tools (`search`, `get_links`, `get_vault_tree`) would
 * return INDEX_WARMING until process restart.
 */

import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

import { makeReindexCallback } from "../src/index.js";
import { createIndexHandle, type IndexHandle } from "../src/lib/index/IndexHandle.js";
import { type IndexOutcome, reindexOne, scanVault } from "../src/lib/index/scanner.js";
import { closeSqlite, openSqlite } from "../src/lib/index/sqlite.js";
import { FileTooLargeError } from "../src/lib/readNote.js";
import { type VaultRoot, validateVaultRoot } from "../src/lib/validatePath.js";
import { createTempVault, type VaultStructure } from "./helpers/vault.js";

interface Setup {
	vault: { path: string; cleanup: () => Promise<void> };
	opened: ReturnType<typeof openSqlite>;
	index: IndexHandle;
	vaultRoot: VaultRoot;
}

const setups: Setup[] = [];

async function setup(structure: VaultStructure): Promise<Setup> {
	const vault = await createTempVault(structure);
	const opened = openSqlite({ dbPath: ":memory:" });
	const index = createIndexHandle(opened.db, { includeHidden: false });
	const vaultRoot = await validateVaultRoot(vault.path);
	const s: Setup = { vault, opened, index, vaultRoot };
	setups.push(s);
	return s;
}

afterEach(async () => {
	while (setups.length > 0) {
		const s = setups.pop();
		if (!s) continue;
		closeSqlite(s.opened.db);
		await s.vault.cleanup();
	}
});

// Mirrors the production `reindexCallback` in `src/index.ts`. Kept inline
// so the test doesn't depend on bootstrapping the full CLI entrypoint.
async function watcherReindex(s: Setup, rel: string): Promise<{ outcome: IndexOutcome; finalized: boolean }> {
	const outcome = await reindexOne(s.vaultRoot, s.index, rel);
	if (outcome === "vanished") {
		s.index.removeFile(rel, Date.now());
	}
	const finalized = (outcome === "indexed" || outcome === "vanished") && s.index.clearPendingRetry(rel);
	return { outcome, finalized };
}

// Mirrors the production `onUnlink` handler in `src/lib/watcher.ts`. The
// production unlink path bypasses `reindexCallback` (no stat round-trip
// needed; the file is already gone) but MUST still call
// `clearPendingRetry` so a parse-failed file deleted by the user
// finalizes the scan instead of stranding pendingRetries forever.
function watcherUnlink(s: Setup, rel: string): { finalized: boolean } {
	s.index.removeFile(rel, Date.now());
	const finalized = s.index.clearPendingRetry(rel);
	return { finalized };
}

describe("watcher-driven scan finalization", () => {
	test("cold-start: one parse-failed file → fix → state warm + scan_complete", async () => {
		const broken = "broken.md";
		const good = "good.md";
		const s = await setup({
			[broken]: "---\nbroken: [unclosed\n---\n",
			[good]: "# good\n",
		});
		s.index.setStatus("cold");
		const result = await scanVault({ vaultRoot: s.vaultRoot, index: s.index, concurrency: 2 });
		expect(result.aborted).toBe(false);
		// Cold start + per-file failure → state stays warming, scan_complete
		// stays false, pendingRetries holds the broken file.
		expect(s.index.getStatus().state).toBe("warming");
		expect(s.index.getScanComplete()).toBe(false);
		expect(s.index.hasPendingRetries()).toBe(true);

		// Fix the file on disk and trigger a watcher-driven reindex.
		await writeFile(join(s.vault.path, broken), "# now valid\n", "utf8");
		const r = await watcherReindex(s, broken);
		expect(r.outcome).toBe("indexed");
		expect(r.finalized).toBe(true);
		expect(s.index.getStatus().state).toBe("warm");
		expect(s.index.getScanComplete()).toBe(true);
		expect(s.index.getEverComplete()).toBe(true);
		expect(s.index.hasPendingRetries()).toBe(false);
	});

	test("warm-restart with failed file: fix → scan_complete=true; state stays warm", async () => {
		// First scan: clean. State becomes warm + ever_complete.
		const broken = "broken.md";
		const s = await setup({ "good.md": "# good\n" });
		s.index.setStatus("cold");
		await scanVault({ vaultRoot: s.vaultRoot, index: s.index });
		expect(s.index.getStatus().state).toBe("warm");
		expect(s.index.getEverComplete()).toBe(true);

		// Introduce a broken file and re-run scan (warm-restart path).
		await writeFile(join(s.vault.path, broken), "---\nbroken: [unclosed\n---\n", "utf8");
		await scanVault({ vaultRoot: s.vaultRoot, index: s.index });
		// Warm restart with failed file: state stays warm, scan_complete
		// false, pendingRetries holds the broken file.
		expect(s.index.getStatus().state).toBe("warm");
		expect(s.index.getScanComplete()).toBe(false);
		expect(s.index.hasPendingRetries()).toBe(true);

		// Fix the file. Finalize: scan_complete=true, state still warm.
		await writeFile(join(s.vault.path, broken), "# now valid\n", "utf8");
		const r = await watcherReindex(s, broken);
		expect(r.finalized).toBe(true);
		expect(s.index.getStatus().state).toBe("warm");
		expect(s.index.getScanComplete()).toBe(true);
	});

	test("two failed files: fix one → not finalized; fix the other → finalized", async () => {
		const a = "a.md";
		const b = "b.md";
		const s = await setup({
			[a]: "---\nbroken_a: [unclosed\n---\n",
			[b]: "---\nbroken_b: [unclosed\n---\n",
		});
		s.index.setStatus("cold");
		await scanVault({ vaultRoot: s.vaultRoot, index: s.index });
		expect(s.index.hasPendingRetries()).toBe(true);
		expect(s.index.getStatus().state).toBe("warming");

		await writeFile(join(s.vault.path, a), "# a\n", "utf8");
		const r1 = await watcherReindex(s, a);
		expect(r1.finalized).toBe(false);
		expect(s.index.hasPendingRetries()).toBe(true);
		expect(s.index.getStatus().state).toBe("warming");

		await writeFile(join(s.vault.path, b), "# b\n", "utf8");
		const r2 = await watcherReindex(s, b);
		expect(r2.finalized).toBe(true);
		expect(s.index.hasPendingRetries()).toBe(false);
		expect(s.index.getStatus().state).toBe("warm");
		expect(s.index.getScanComplete()).toBe(true);
	});

	test("vanished file (user deletes instead of fixing) also finalizes", async () => {
		const broken = "broken.md";
		const s = await setup({
			[broken]: "---\nbroken: [unclosed\n---\n",
			"good.md": "# good\n",
		});
		s.index.setStatus("cold");
		await scanVault({ vaultRoot: s.vaultRoot, index: s.index });
		expect(s.index.hasPendingRetries()).toBe(true);

		// User deletes the broken file. reindexOne returns "vanished";
		// the watcher path calls removeFile + clearPendingRetry.
		await rm(join(s.vault.path, broken));
		const r = await watcherReindex(s, broken);
		expect(r.outcome).toBe("vanished");
		expect(r.finalized).toBe(true);
		expect(s.index.getStatus().state).toBe("warm");
		expect(s.index.getScanComplete()).toBe(true);
	});

	test("parse_failed reindex does NOT clear (file still broken)", async () => {
		const broken = "broken.md";
		const s = await setup({
			[broken]: "---\nbroken: [unclosed\n---\n",
			"good.md": "# good\n",
		});
		s.index.setStatus("cold");
		await scanVault({ vaultRoot: s.vaultRoot, index: s.index });
		expect(s.index.hasPendingRetries()).toBe(true);

		// User edits the file but YAML is still broken — reindex returns
		// "parse_failed". clearPendingRetry must NOT fire.
		await writeFile(join(s.vault.path, broken), "---\nstill: [broken\n---\n", "utf8");
		const r = await watcherReindex(s, broken);
		expect(r.outcome).toBe("parse_failed");
		expect(r.finalized).toBe(false);
		expect(s.index.hasPendingRetries()).toBe(true);
		expect(s.index.getStatus().state).toBe("warming");
	});

	test("clearPendingRetry on a non-tracked file is a no-op", async () => {
		const s = await setup({ "a.md": "# a\n" });
		s.index.setStatus("cold");
		await scanVault({ vaultRoot: s.vaultRoot, index: s.index });
		// Clean scan → state warm, no pending retries.
		expect(s.index.hasPendingRetries()).toBe(false);

		// Watcher fires for a routine change — clearPendingRetry is called
		// for every successful reindex but most calls miss the set.
		expect(s.index.clearPendingRetry("a.md")).toBe(false);
		expect(s.index.getStatus().state).toBe("warm");
	});

	test("watcher unlink path finalizes scan when last failed file is deleted", async () => {
		// User-driven recovery: instead of fixing the broken file, the user
		// deletes it. Production `onUnlink` calls `removeFile` directly
		// (no stat round-trip) and MUST also call `clearPendingRetry` —
		// without it, the retry set never drains and vault-wide tools
		// return INDEX_WARMING until restart.
		const broken = "broken.md";
		const s = await setup({
			[broken]: "---\nbroken: [unclosed\n---\n",
			"good.md": "# good\n",
		});
		s.index.setStatus("cold");
		await scanVault({ vaultRoot: s.vaultRoot, index: s.index });
		expect(s.index.hasPendingRetries()).toBe(true);
		expect(s.index.getStatus().state).toBe("warming");

		// Delete the broken file; mimic chokidar's unlink event delivery.
		await rm(join(s.vault.path, broken));
		const r = watcherUnlink(s, broken);
		expect(r.finalized).toBe(true);
		expect(s.index.hasPendingRetries()).toBe(false);
		expect(s.index.getStatus().state).toBe("warm");
		expect(s.index.getScanComplete()).toBe(true);
	});

	test("watcher unlink with two failed files: delete one, fix the other", async () => {
		// Mixed recovery paths: one file deleted (unlink path),
		// one fixed (reindex path). Both must contribute to draining
		// pendingRetries; finalize when the set empties.
		const a = "a.md";
		const b = "b.md";
		const s = await setup({
			[a]: "---\nbroken_a: [unclosed\n---\n",
			[b]: "---\nbroken_b: [unclosed\n---\n",
		});
		s.index.setStatus("cold");
		await scanVault({ vaultRoot: s.vaultRoot, index: s.index });
		expect(s.index.hasPendingRetries()).toBe(true);

		// Delete a; pendingRetries still holds b → not finalized.
		await rm(join(s.vault.path, a));
		const r1 = watcherUnlink(s, a);
		expect(r1.finalized).toBe(false);
		expect(s.index.hasPendingRetries()).toBe(true);
		expect(s.index.getStatus().state).toBe("warming");

		// Fix b → finalized.
		await writeFile(join(s.vault.path, b), "# b\n", "utf8");
		const r2 = await watcherReindex(s, b);
		expect(r2.finalized).toBe(true);
		expect(s.index.getStatus().state).toBe("warm");
	});
});

describe("makeReindexCallback — thrown errors join warming gate", () => {
	test("FileTooLargeError thrown by reindexOne adds to pendingRetries during warming", async () => {
		// FileTooLargeError thrown by reindexOne mid-scan must add the
		// path to pendingRetries so the warming gate keeps the scan
		// from finalizing warm with the file unindexed. Both try-side
		// and catch-side outcomes route through the same post-block.
		const s = await setup({ "x.md": "# x\n" });
		s.index.setStatus("warming");
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			const stub = vi.fn(async () => {
				throw new FileTooLargeError("big.md", 10_485_760, 12_000_000);
			});
			const cb = makeReindexCallback(s.vaultRoot, s.index, stub);
			const outcome = await cb("big.md");
			expect(outcome).toBe("parse_failed");
			expect(s.index.hasPendingRetries()).toBe(true);
			expect(s.index.pendingRetriesSnapshot()).toContain("big.md");
		} finally {
			errSpy.mockRestore();
		}
	});

	test("thrown error in warm + scan_complete state does NOT add to pendingRetries (post-warm user error)", async () => {
		// Post-warm parse failures are routine user errors (typos in
		// frontmatter, etc.) and shouldn't re-flip state. The gate is
		// `!getScanComplete()`, so the scan must be fully finalized
		// (state=warm AND scan_complete=true) to assert the suppression —
		// `setStatus("warm")` alone leaves scan_complete=false (the
		// warm-restart-with-failures arc), which DOES arm the gate.
		const s = await setup({ "x.md": "# x\n" });
		s.index.setStatus("warming");
		s.index.markScanFinalized(); // sets scan_complete=true + state=warm
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			const stub = vi.fn(async () => {
				throw new Error("synthetic");
			});
			const cb = makeReindexCallback(s.vaultRoot, s.index, stub);
			const outcome = await cb("big.md");
			expect(outcome).toBe("parse_failed");
			expect(s.index.hasPendingRetries()).toBe(false);
		} finally {
			errSpy.mockRestore();
		}
	});

	test("parse_failed during reconciling state arms pendingRetries", async () => {
		// Warm-restart's scanVault flips state to `reconciling` while
		// keeping scan_complete=false. A watcher `add` event in that
		// window for a file that fails to parse must arm the
		// finalization gate (failedSubtrees + failedFiles +
		// pendingRetries), or `markScanFinalized` fires over an
		// unindexed file. Gate is `!getScanComplete()` to cover both
		// warming AND reconciling-with-incomplete-scan windows.
		const s = await setup({ "x.md": "# x\n" });
		s.index.setStatus("warm"); // pre-existing warm state from prior session
		s.index.setStatus("reconciling"); // scanVault transition
		expect(s.index.getScanComplete()).toBe(false);
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			const stub = vi.fn(async () => {
				throw new Error("malformed yaml");
			});
			const cb = makeReindexCallback(s.vaultRoot, s.index, stub);
			const outcome = await cb("malformed.md");
			expect(outcome).toBe("parse_failed");
			expect(s.index.hasPendingRetries()).toBe(true);
			expect(s.index.pendingRetriesSnapshot()).toContain("malformed.md");
		} finally {
			errSpy.mockRestore();
		}
	});

	test("parse_failed during warm + scan_complete=true does NOT arm pendingRetries", async () => {
		// Counter to the new gate — once scan_complete=true, watcher
		// parse failures are user errors and don't re-flip state.
		const s = await setup({ "x.md": "# x\n" });
		s.index.setStatus("warming");
		s.index.markScanFinalized();
		expect(s.index.getScanComplete()).toBe(true);
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			const stub = vi.fn(async () => {
				throw new Error("malformed yaml");
			});
			const cb = makeReindexCallback(s.vaultRoot, s.index, stub);
			const outcome = await cb("malformed.md");
			expect(outcome).toBe("parse_failed");
			expect(s.index.hasPendingRetries()).toBe(false);
		} finally {
			errSpy.mockRestore();
		}
	});

	test("indexed outcome via stub clears prior pending retry", async () => {
		// Sanity: makeReindexCallback's indexed/vanished branch still
		// drains pendingRetries via clearPendingRetry.
		const s = await setup({ "x.md": "# x\n" });
		s.index.setStatus("warming");
		s.index.addPendingRetry("x.md");
		const stub = vi.fn(async (): Promise<IndexOutcome> => "indexed");
		const cb = makeReindexCallback(s.vaultRoot, s.index, stub);
		const outcome = await cb("x.md");
		expect(outcome).toBe("indexed");
		expect(s.index.hasPendingRetries()).toBe(false);
		expect(s.index.getStatus().state).toBe("warm");
	});
});
