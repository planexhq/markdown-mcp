/**
 * `reindexOne` skipUnchanged contract.
 *
 * chokidar's `ignoreInitial: false` emits one `add` per existing file
 * at startup. `reindexOne` short-circuits on `(mtime, size)` matches —
 * no `replaceFile`, no `bumpSnapshot`, no CURSOR_INVALID for in-flight
 * cursors. Real edits change mtime so the skip path won't fire.
 */

import { utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { createIndexHandle, type IndexHandle } from "../../src/lib/index/IndexHandle.js";
import { reindexOne, scanVault } from "../../src/lib/index/scanner.js";
import { closeSqlite, openSqlite } from "../../src/lib/index/sqlite.js";
import { type VaultRoot, validateVaultRoot } from "../../src/lib/validatePath.js";
import { createTempVault } from "../helpers/vault.js";

describe("reindexOne — skipUnchanged contract", () => {
	let vault: { path: string; cleanup: () => Promise<void> };
	let vaultRoot: VaultRoot;
	let index: IndexHandle;
	let closeDb: () => void;

	beforeEach(async () => {
		vault = await createTempVault({});
		vaultRoot = await validateVaultRoot(vault.path);
		const opened = openSqlite({ dbPath: ":memory:" });
		index = createIndexHandle(opened.db);
		closeDb = () => closeSqlite(opened.db);
	});

	afterEach(async () => {
		closeDb();
		await vault.cleanup();
	});

	test("unchanged file mtime-skips → no snapshot bump", async () => {
		// Replays a watcher `add` for an unchanged file. The (mtime, size)
		// skip path short-circuits before replaceFile so the snapshot
		// stays put and in-flight cursors don't invalidate.
		const target = "a.md";
		await writeFile(join(vault.path, target), "# A\n\nbody", "utf8");
		// Initial index via reindexOne (writes the row).
		await reindexOne(vaultRoot, index, target);
		const snapshotAfterInitial = index.getSnapshot();

		// Replay: simulate chokidar's startup `add` for the same unchanged
		// file. The mtime-skip path must NOT bump the snapshot.
		const outcome = await reindexOne(vaultRoot, index, target);
		expect(outcome).toBe("indexed");
		expect(index.getSnapshot()).toBe(snapshotAfterInitial);
	});

	test("real edit triggers reindex (mtime advances → no skip)", async () => {
		const target = "a.md";
		await writeFile(join(vault.path, target), "# A\n\nbody", "utf8");
		await reindexOne(vaultRoot, index, target);
		const snapshotBefore = index.getSnapshot();

		// Editor save: content + mtime change. utimes forces a strictly-
		// greater mtime regardless of timer resolution.
		await writeFile(join(vault.path, target), "# A\n\nedited\n", "utf8");
		const futureSec = Math.floor(Date.now() / 1000) + 60;
		await utimes(join(vault.path, target), futureSec, futureSec);
		const outcome = await reindexOne(vaultRoot, index, target);
		expect(outcome).toBe("indexed");
		expect(index.getSnapshot()).toBeGreaterThan(snapshotBefore);
	});

	test("new file (no row in index) is indexed despite skipUnchanged=true", async () => {
		// `isFileUnchanged` returns false when there's no row, so a fresh
		// file always indexes via the same reindexOne entry point.
		const target = "fresh.md";
		await writeFile(join(vault.path, target), "# Fresh\n", "utf8");
		const outcome = await reindexOne(vaultRoot, index, target);
		expect(outcome).toBe("indexed");
		expect(index.getFileMtime(target)).not.toBeNull();
	});

	test("warm-restart-style: scanVault then reindexOne replay leaves snapshot stable", async () => {
		// Warm restart: scanVault populates the index, then chokidar's
		// startup `add` flood drives reindexOne for every file. No replay
		// should bump snapshot.
		await writeFile(join(vault.path, "a.md"), "# A\n", "utf8");
		await writeFile(join(vault.path, "b.md"), "# B\n", "utf8");
		await writeFile(join(vault.path, "c.md"), "# C\n", "utf8");
		await scanVault({ vaultRoot, index, concurrency: 1 });
		const snapshotAfterScan = index.getSnapshot();

		for (const f of ["a.md", "b.md", "c.md"]) {
			await reindexOne(vaultRoot, index, f);
		}
		expect(index.getSnapshot()).toBe(snapshotAfterScan);
	});
});
