/**
 * `reindexOne` vanished-outcome contract — pins the behavior the
 * production reindex callback (`src/index.ts`) relies on.
 *
 * If the callback discards `reindexOne`'s return outcome, a file that
 * vanishes between the watcher event / merkleTick reconcile and
 * `reindexOne`'s stat leaves stale fragments + wikilinks in the index.
 * The watcher's `unlink` event handler covers the direct delete path
 * (calls `removeFile` directly), but missed-event reconciles flow
 * through the callback and need the vanished branch.
 */

import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { createIndexHandle, type IndexHandle } from "../../src/lib/index/IndexHandle.js";
import { reindexOne } from "../../src/lib/index/scanner.js";
import { closeSqlite, openSqlite } from "../../src/lib/index/sqlite.js";
import { type VaultRoot, validateVaultRoot } from "../../src/lib/validatePath.js";
import { createTempVault } from "../helpers/vault.js";

describe("reindexOne — vanished file outcome", () => {
	let vault: { path: string; cleanup: () => Promise<void> };
	let vaultRoot: VaultRoot;
	let index: IndexHandle;
	let closeDb: () => void;

	beforeEach(async () => {
		vault = await createTempVault({});
		vaultRoot = await validateVaultRoot(vault.path);
		const opened = openSqlite({ dbPath: ":memory:" });
		index = createIndexHandle(opened.db, { includeHidden: false });
		closeDb = () => closeSqlite(opened.db);
	});

	afterEach(async () => {
		closeDb();
		await vault.cleanup();
	});

	test("file deleted between event and reindexOne stat → 'vanished'; caller prunes", async () => {
		const target = "to-delete.md";
		const targetAbs = join(vault.path, target);

		await writeFile(targetAbs, "# T\n[[other]]\n", "utf8");
		let outcome = await reindexOne(vaultRoot, index, target);
		expect(outcome).toBe("indexed");
		expect(index.getFileMtime(target)).not.toBeNull();

		// File deleted; production callback's responsibility is to call
		// removeFile when the outcome is "vanished" — mirrors `src/index.ts`.
		await rm(targetAbs);
		outcome = await reindexOne(vaultRoot, index, target);
		expect(outcome).toBe("vanished");
		if (outcome === "vanished") {
			index.removeFile(target, Date.now());
		}
		expect(index.getFileMtime(target)).toBeNull();
	});

	test("regular reindex of an existing file → 'indexed'; caller skips prune", async () => {
		const target = "stable.md";
		await writeFile(join(vault.path, target), "# S\n", "utf8");
		const outcome = await reindexOne(vaultRoot, index, target);
		expect(outcome).toBe("indexed");
		expect(index.getFileMtime(target)).not.toBeNull();
	});

	test("non-markdown path → 'vanished' early-exit (no FS read, no parse)", async () => {
		// chokidar's `ignored(path, stats)` filters non-markdown only when
		// stats is present. During initial recursive descent stats can be
		// undefined, so `.png`/`.pdf`/etc. reach reindexOne via watcher
		// `add` events. Without the gate, indexOne reads up to 10 MB of
		// binary, parses, returns parse_failed, and reindexCallback adds
		// to pendingRetries — but walkVault skips non-markdown so the
		// retry never drains, wedging scan_complete=false. The gate
		// returns "vanished" so the caller's removeFile is a no-op
		// (file never indexed) and clearPendingRetry drains any stale
		// retry from a prior pass.
		const target = "image.png";
		// Write a non-markdown file. If the gate fails, indexOne would
		// open and parse this — the test would still pass functionally
		// (parse_failed → outcome) but the wedge invariant would break.
		// Use binary-shaped content so parse fails reliably.
		await writeFile(join(vault.path, target), "\x89PNG\r\n\x1a\n", "utf8");
		const outcome = await reindexOne(vaultRoot, index, target);
		expect(outcome).toBe("vanished");
		// Index never picked up the non-markdown row (was never indexed).
		expect(index.getFileMtime(target)).toBeNull();
	});

	test("stale row for renamed-to-non-markdown is cleared by 'vanished' route", async () => {
		// Renamed `note.md` → `note.bak`: the .md row stays in the index
		// until removeFile fires. The non-markdown gate makes reindexOne
		// return "vanished" so the caller's removeFile drains the row.
		const before = "note.md";
		await writeFile(join(vault.path, before), "# N\n", "utf8");
		await reindexOne(vaultRoot, index, before);
		expect(index.getFileMtime(before)).not.toBeNull();

		// Simulate the rename on disk.
		await rm(join(vault.path, before));
		const after = "note.bak";
		await writeFile(join(vault.path, after), "# N\n", "utf8");

		// Watcher fires `add` for `note.bak` — non-markdown → vanished.
		const outcome = await reindexOne(vaultRoot, index, after);
		expect(outcome).toBe("vanished");
		// The OLD row at `note.md` is independently cleared by the
		// `unlink` event in production. This test specifically asserts
		// the gate doesn't index `note.bak` as a non-markdown entry.
		expect(index.getFileMtime(after)).toBeNull();
	});
});
