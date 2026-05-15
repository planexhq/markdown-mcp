/**
 * Merkle reconciliation tests — exit criterion: catches a manually-
 * corrupted index file (mtime drift, vanished file, new file).
 */

import { chmod, rm, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { createIndexHandle, type IndexHandle } from "../../src/lib/index/IndexHandle.js";
import { reindexOne, scanVault } from "../../src/lib/index/scanner.js";
import { closeSqlite, openSqlite } from "../../src/lib/index/sqlite.js";
import { type MerkleTickHandle, startMerkleTick } from "../../src/lib/merkle.js";
import { type VaultRoot, validateVaultRoot } from "../../src/lib/validatePath.js";
import { WriteCoordinator } from "../../src/lib/writeCoordinator.js";
import { createTempVault, type VaultStructure } from "../helpers/vault.js";

interface Fixture {
	vaultRoot: VaultRoot;
	cleanupVault: () => Promise<void>;
	index: IndexHandle;
	closeDb: () => void;
	tick: MerkleTickHandle;
	dbAccess: { run: (sql: string, params?: Record<string, unknown>) => void };
}

async function setup(): Promise<Fixture> {
	const v = await createTempVault({
		"alpha.md": "# Alpha\n",
		"beta.md": "# Beta\n",
	});
	const vaultRoot = await validateVaultRoot(v.path);
	const opened = openSqlite({ dbPath: ":memory:" });
	const index = createIndexHandle(opened.db, { includeHidden: false });
	index.setStatus("warming");
	const coordinator = new WriteCoordinator();
	await scanVault({ vaultRoot, index, coordinator, concurrency: 1 });
	// Mirror `makeReindexCallback` from `src/index.ts`: clear pendingRetry
	// on successful reindex / vanish. Without this wrapping, the merkle
	// backstop pass would reindex pending entries but the bare outcome
	// wouldn't drain the set, masking the backstop's behavior.
	const tick = startMerkleTick({
		vaultRoot,
		index,
		coordinator,
		reindexFile: async (rel) => {
			const outcome = await reindexOne(vaultRoot, index, rel);
			if (outcome === "indexed" || outcome === "vanished") {
				index.clearPendingRetry(rel);
			}
			return outcome;
		},
		intervalMs: 60_000, // Long; tests call runOnce explicitly.
	});
	return {
		vaultRoot,
		cleanupVault: v.cleanup,
		index,
		closeDb: () => closeSqlite(opened.db),
		tick,
		dbAccess: {
			run: (sql, params) => {
				if (params) opened.db.prepare(sql).run(params);
				else opened.db.prepare(sql).run();
			},
		},
	};
}

let fixture: Fixture;

beforeEach(async () => {
	fixture = await setup();
});

afterEach(async () => {
	await fixture.tick.stop();
	fixture.closeDb();
	await fixture.cleanupVault();
});

describe("merkle — exit criterion: catches manually-corrupted index file", () => {
	test("staled mtime in fragments table → reindex on tick", async () => {
		const file = "alpha.md";
		// Manually corrupt: zero out fragments.mtime so it disagrees with
		// the on-disk file's actual mtime. Reconcile should detect drift
		// and reindex.
		fixture.dbAccess.run("UPDATE fragments SET mtime = 0 WHERE file = :file", { file });
		expect(fixture.index.getFileMtime(file)).toBe(0);

		await fixture.tick.runOnce();

		const restored = fixture.index.getFileMtime(file);
		expect(restored).not.toBe(0);
		const st = await stat(join(fixture.vaultRoot.absolute, file));
		expect(restored).toBeCloseTo(st.mtimeMs, -1); // within 0.5 ms
	});

	test("file added to disk while server idle → indexed on tick", async () => {
		const file = "newcomer.md";
		await writeFile(join(fixture.vaultRoot.absolute, file), "# Newcomer\n", "utf8");
		expect(fixture.index.getFileMtime(file)).toBeNull();

		await fixture.tick.runOnce();

		expect(fixture.index.getFileMtime(file)).not.toBeNull();
	});

	test("file removed from disk while server idle → dropped from index on tick", async () => {
		const file = "alpha.md";
		await rm(join(fixture.vaultRoot.absolute, file));
		expect(fixture.index.getFileMtime(file)).not.toBeNull();

		await fixture.tick.runOnce();

		expect(fixture.index.getFileMtime(file)).toBeNull();
	});

	test("on-disk mtime newer than indexed mtime → reindex on tick", async () => {
		const file = "beta.md";
		const beforeMtime = fixture.index.getFileMtime(file) ?? 0;
		// Bump on-disk mtime forward by 5 s.
		const newAtimeSec = Math.floor(Date.now() / 1000) + 5;
		await utimes(join(fixture.vaultRoot.absolute, file), newAtimeSec, newAtimeSec);

		await fixture.tick.runOnce();

		const afterMtime = fixture.index.getFileMtime(file) ?? 0;
		expect(afterMtime).toBeGreaterThan(beforeMtime);
	});
});

describe("merkle — N5 drift detection includes size", () => {
	test("size differs but mtime preserved (rsync -t scenario) → reindex on tick", async () => {
		// `rsync --times`/`cp -p`/FAT 2 s rounding can swap content while
		// preserving mtime; merkle must catch (mtime, size) drift, not
		// mtime alone — same skip key the scanner uses.
		const file = "alpha.md";
		const abs = join(fixture.vaultRoot.absolute, file);
		const stBefore = await stat(abs);
		const indexedSizeBefore = fixture.index.getFileMeta(file)?.size ?? null;
		expect(indexedSizeBefore).toBe(stBefore.size);

		// Write new content with a different size; then rewind mtime so the
		// merkle tick's mtime check would otherwise miss the drift.
		const newBody = `# Alpha\n\n${"x".repeat(stBefore.size + 100)}\n`;
		await writeFile(abs, newBody, "utf8");
		const mtimeSec = stBefore.mtimeMs / 1000;
		await utimes(abs, mtimeSec, mtimeSec);

		const stAfter = await stat(abs);
		expect(stAfter.size).not.toBe(stBefore.size);
		// Mtime must be back at the indexed value (within timestamp resolution)
		// so this test would pass pre-N5 only if the size check were active.
		expect(Math.abs(stAfter.mtimeMs - stBefore.mtimeMs)).toBeLessThan(1000);

		await fixture.tick.runOnce();

		const indexedSizeAfter = fixture.index.getFileMeta(file)?.size ?? null;
		expect(indexedSizeAfter).toBe(stAfter.size);
	});
});

describe("merkle — NULL size treated as drift (self-heal channel)", () => {
	test("file with size=NULL is reindexed even when mtime matches disk", async () => {
		// `fragments.size = NULL` is the runtime self-heal channel: any path
		// (corruption-recovery rebuild, manual index surgery) can NULL the
		// size to force a fresh re-parse on next reconcile. IndexHandle
		// .isFileUnchanged returns false for NULL size; merkle's drift
		// detection must mirror that, otherwise an interrupted self-heal
		// can finalize as warm with un-rewritten rows.
		const file = "alpha.md";
		const abs = join(fixture.vaultRoot.absolute, file);

		fixture.dbAccess.run("UPDATE fragments SET size = NULL WHERE file = :file", { file });
		expect(fixture.index.getFileMeta(file)?.size ?? null).toBeNull();
		const mtimeBefore = fixture.index.getFileMtime(file);
		expect(mtimeBefore).toBeGreaterThan(0);

		await fixture.tick.runOnce();

		const stAfter = await stat(abs);
		expect(fixture.index.getFileMeta(file)?.size ?? null).toBe(stAfter.size);
	});
});

describe("merkle — exact mtime comparison", () => {
	test("sub-ms mtime drift (delta < 0.5 ms) is detected and reindexed", async () => {
		const file = "alpha.md";
		const abs = join(fixture.vaultRoot.absolute, file);
		const indexedMtime = fixture.index.getFileMtime(file) ?? 0;
		expect(indexedMtime).toBeGreaterThan(0);

		const driftedMtime = indexedMtime + 0.2;
		fixture.dbAccess.run("UPDATE fragments SET mtime = :m WHERE file = :file", {
			m: driftedMtime,
			file,
		});
		expect(fixture.index.getFileMtime(file)).toBe(driftedMtime);

		await fixture.tick.runOnce();

		const after = fixture.index.getFileMtime(file) ?? 0;
		const st = await stat(abs);
		expect(after).toBe(st.mtimeMs);
		expect(after).not.toBe(driftedMtime);
	});
});

describe("merkle — pendingRetries lifecycle", () => {
	test("merkle removeFile drains pendingRetries when chokidar misses the unlink", async () => {
		const file = "alpha.md";
		// Single-file pendingRetries set so the boolean `hasPendingRetries`
		// flips on this entry's removal — without per-key inspection on
		// IndexHandle, this is the only observable signal that
		// `clearPendingRetry` ran inside the merkle remove path.
		fixture.index.addPendingRetry(file);
		expect(fixture.index.hasPendingRetries()).toBe(true);

		await rm(join(fixture.vaultRoot.absolute, file));
		await fixture.tick.runOnce();

		expect(fixture.index.getFileMtime(file)).toBeNull();
		expect(fixture.index.hasPendingRetries()).toBe(false);
	});

	test("pendingRetries on an in-sync indexed file are drained by the backstop pass", async () => {
		// Scanner's BUSY catch can race a peer's matching commit and leave
		// the file in pendingRetries; merkle's drift detector sees it as
		// in-sync (no drift) and would never reindex without this backstop.
		const file = "alpha.md";
		// File is indexed and on-disk (M, S) matches — no drift would fire.
		expect(fixture.index.getFileMtime(file)).not.toBeNull();
		fixture.index.addPendingRetry(file);
		expect(fixture.index.hasPendingRetries()).toBe(true);

		await fixture.tick.runOnce();

		expect(fixture.index.hasPendingRetries()).toBe(false);
	});
});

describe("merkle — state transitions", () => {
	test("warm → reconciling → warm during runOnce", async () => {
		fixture.index.setStatus("warm");
		expect(fixture.index.getStatus().state).toBe("warm");
		await fixture.tick.runOnce();
		// Tick is synchronous from caller's perspective once awaited;
		// final state is back to warm.
		expect(fixture.index.getStatus().state).toBe("warm");
	});
});

describe("merkle — warming → warm finalization", () => {
	interface NoScanFixture {
		index: IndexHandle;
		tick: MerkleTickHandle;
		vaultRoot: VaultRoot;
		cleanup: () => Promise<void>;
	}

	// Distinct from the file-level `setup()`: that helper calls
	// `scanVault`, which auto-finalizes a clean vault and defeats the
	// "warming index recovered by merkle" scenario. Here the index
	// starts empty + warming so merkle is the only finalization path.
	async function setupNoScan(structure: VaultStructure): Promise<NoScanFixture> {
		const v = await createTempVault(structure);
		const vaultRoot = await validateVaultRoot(v.path);
		const opened = openSqlite({ dbPath: ":memory:" });
		const index = createIndexHandle(opened.db, { includeHidden: false });
		index.setStatus("warming");
		const coordinator = new WriteCoordinator();
		const tick = startMerkleTick({
			vaultRoot,
			index,
			coordinator,
			reindexFile: async (rel) => {
				const outcome = await reindexOne(vaultRoot, index, rel);
				if (outcome === "indexed" || outcome === "vanished") {
					index.clearPendingRetry(rel);
				}
				return outcome;
			},
			intervalMs: 60_000,
		});
		return {
			index,
			tick,
			vaultRoot,
			cleanup: async () => {
				await tick.stop();
				closeSqlite(opened.db);
				await v.cleanup();
			},
		};
	}

	// A cold scan that hit EACCES on a subtree leaves state=warming
	// with empty pendingRetries (subtree failures aren't watcher-
	// recoverable, so scanner doesn't track them per-file). Merkle's
	// reindex callback (mimicked here) drains pendingRetries via
	// `clearPendingRetry` on successful reindex.
	test("clean reconcile from warming finalizes the index (warming → warm)", async () => {
		const f = await setupNoScan({ "alpha.md": "# Alpha\n", "beta.md": "# Beta\n" });
		try {
			expect(f.index.getStatus().state).toBe("warming");
			expect(f.index.getScanComplete()).toBe(false);
			expect(f.index.getEverComplete()).toBe(false);

			await f.tick.runOnce();

			// All flags flip per `markScanFinalized`: scan_complete,
			// ever_complete, status=warm.
			expect(f.index.getStatus().state).toBe("warm");
			expect(f.index.getScanComplete()).toBe(true);
			expect(f.index.getEverComplete()).toBe(true);
			expect(f.index.getFileMtime("alpha.md")).not.toBeNull();
			expect(f.index.getFileMtime("beta.md")).not.toBeNull();
		} finally {
			await f.cleanup();
		}
	});

	test("warming with non-empty pendingRetries does NOT finalize", async () => {
		const f = await setupNoScan({ "alpha.md": "# Alpha\n" });
		// Simulate a scanner per-file failure the watcher / merkle hasn't
		// yet recovered. Path doesn't exist on disk → merkle's reindex
		// can't drain it.
		f.index.addPendingRetry("unrecovered.md");
		try {
			await f.tick.runOnce();
			expect(f.index.getStatus().state).toBe("warming");
			expect(f.index.getScanComplete()).toBe(false);
			expect(f.index.getEverComplete()).toBe(false);
			expect(f.index.hasPendingRetries()).toBe(true);
		} finally {
			await f.cleanup();
		}
	});

	test("warming index whose pendingRetries drain via merkle's reindex finalizes", async () => {
		// Combined: warming start, pendingRetries seeded with a path that
		// DOES exist on disk. Merkle's reindex indexes it, clearPendingRetry
		// drains the set, the warming → warm finalization arc fires.
		const f = await setupNoScan({ "alpha.md": "# Alpha\n", "recovered.md": "# Recovered\n" });
		f.index.addPendingRetry("recovered.md");
		try {
			await f.tick.runOnce();
			expect(f.index.getStatus().state).toBe("warm");
			expect(f.index.hasPendingRetries()).toBe(false);
			expect(f.index.getScanComplete()).toBe(true);
		} finally {
			await f.cleanup();
		}
	});

	test("merkle-driven finalize clears sticky failedSubtreesPresent flag", async () => {
		// Subtree recovers between scanner pass and merkle reconcile; the
		// sticky flag (set by the prior scanner pass) must clear at
		// merkle's finalize. Pre-D40 it stayed set until process restart.
		const f = await setupNoScan({ "alpha.md": "# Alpha\n", "beta.md": "# Beta\n" });
		try {
			f.index.setFailedSubtreesPresent(true);
			expect(f.index.getStatus().degraded?.failed_subtrees_present).toBe(true);

			await f.tick.runOnce();

			expect(f.index.getStatus().state).toBe("warm");
			expect(f.index.getScanComplete()).toBe(true);
			expect(f.index.getStatus().degraded).toBeUndefined();
		} finally {
			await f.cleanup();
		}
	});

	test.skipIf(process.platform === "win32")(
		"merkle observes new EACCES subtree → failedSubtreesPresent surfaces (D41)",
		async () => {
			const f = await setupNoScan({
				"top.md": "# Top\n",
				locked: { "inside.md": "# Inside\n" },
			});
			const lockedDir = join(f.vaultRoot.absolute, "locked");
			const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
			try {
				await f.tick.runOnce();
				expect(f.index.getScanComplete()).toBe(true);
				expect(f.index.getDegradedSignals().failed_subtrees_present).toBe(false);

				await chmod(lockedDir, 0o000);
				try {
					await f.tick.runOnce();
					expect(f.index.getDegradedSignals().failed_subtrees_present).toBe(true);
					expect(f.index.getStatus().degraded?.failed_subtrees_present).toBe(true);
				} finally {
					await chmod(lockedDir, 0o755);
				}

				// Recovery clears via merkle's end-of-pass write — no
				// finalize fires (scan_complete already true), so D40's
				// markScanFinalized-side clear can't reach this path.
				await f.tick.runOnce();
				expect(f.index.getDegradedSignals().failed_subtrees_present).toBe(false);
				expect(f.index.getStatus().degraded).toBeUndefined();
			} finally {
				errSpy.mockRestore();
				await f.cleanup();
			}
		},
	);

	test("merkle clears failedSubtreesPresent when no finalize fires (warm + scan_complete=true)", async () => {
		// Cross-platform companion: warm index with scan_complete=true
		// means markScanFinalized is a no-op; flag must still clear.
		const f = await setupNoScan({ "alpha.md": "# Alpha\n", "beta.md": "# Beta\n" });
		try {
			await f.tick.runOnce();
			expect(f.index.getScanComplete()).toBe(true);
			f.index.setFailedSubtreesPresent(true);
			expect(f.index.getDegradedSignals().failed_subtrees_present).toBe(true);

			await f.tick.runOnce();

			expect(f.index.getDegradedSignals().failed_subtrees_present).toBe(false);
			expect(f.index.getStatus().degraded).toBeUndefined();
		} finally {
			await f.cleanup();
		}
	});

	test("per-file parse_failed during reconcile blocks finalization", async () => {
		// A reconcile that walks a recovered subtree containing a
		// malformed note must keep the warming gate engaged: the
		// per-pass `failedFiles` Set surfaces parse_failed outcomes
		// from the reindex callback.
		const f = await setupNoScan({
			"alpha.md": "# Alpha\n",
			"broken.md": "---\nbroken: [unclosed\n---\n# Broken\n",
		});
		try {
			expect(f.index.getStatus().state).toBe("warming");
			await f.tick.runOnce();
			expect(f.index.getStatus().state).toBe("warming");
			expect(f.index.getScanComplete()).toBe(false);
			expect(f.index.getFileMtime("alpha.md")).not.toBeNull();
		} finally {
			await f.cleanup();
		}
	});

	test("walk skips paths the scanner's policy rejects", async () => {
		// Without `classifyRelpathPolicy` / `isNonNfc` checks,
		// walkVaultMarkdown yields any markdown-like filename — but
		// scanner's walkVault skips policy-rejected paths, leaving merkle
		// to call reindexFile and trip parse_failed every tick.
		// `failedFiles` never drains and `scan_complete` stays false.
		// With the gate, merkle skips the path and only `good.md` ends
		// up in the indexed set.
		const f = await setupNoScan({
			"good.md": "# Good\n",
			"bad%20name.md": "# Encoded\n", // percent-encoded → classifyRelpathPolicy rejects
		});
		try {
			await f.tick.runOnce();
			expect(f.index.getFileMtime("good.md")).not.toBeNull();
			expect(f.index.getFileMtime("bad%20name.md")).toBeNull();
			// Multiple ticks must not accumulate failure noise — without
			// the gate, each tick parse_failed's the rejected path again.
			await f.tick.runOnce();
			expect(f.index.getStatus().state).toBe("warm");
			expect(f.index.getScanComplete()).toBe(true);
		} finally {
			await f.cleanup();
		}
	});

	test("warm restart with scan_complete=false finalizes on clean reconcile", async () => {
		// Warm-restart can land in `state=warm` (ever_complete=true serves
		// a usable prior FTS snapshot) AND `scan_complete=false` (interrupted
		// reconcile, schema-upgrade rescan, prior failed-subtree warm
		// restart per CLAUDE.md notes). The merkle finalization gate must
		// fire on `!getScanComplete()` rather than `current === "warming"`,
		// otherwise the warm → reconciling → warm cycle never calls
		// markScanFinalized and scan_complete stays false until restart.
		const f = await setupNoScan({ "alpha.md": "# Alpha\n", "beta.md": "# Beta\n" });
		try {
			// Drive the index into the "warm restart with scan_complete=false"
			// state via API: index files (so reconcile sees them on disk via
			// readdir AND in the indexed set), set status=warm, leave
			// scan_complete=false (default — never finalized in this setup).
			await f.tick.runOnce(); // first reconcile: indexes the files, finalizes (scan_complete=true)
			expect(f.index.getScanComplete()).toBe(true);
			// Simulate an interrupted reconcile that lost finalization:
			// scan_complete cleared, but status stays warm because
			// ever_complete=true serves a usable prior snapshot.
			f.index.setScanComplete(false);
			expect(f.index.getStatus().state).toBe("warm");
			expect(f.index.getScanComplete()).toBe(false);

			await f.tick.runOnce();

			// Clean reconcile re-flips the flag.
			expect(f.index.getStatus().state).toBe("warm");
			expect(f.index.getScanComplete()).toBe(true);
		} finally {
			await f.cleanup();
		}
	});
});
