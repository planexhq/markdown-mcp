/**
 * File watcher tests — exit criterion: editor atomic-rename saves
 * (`write tmp + rename`) propagate to the index.
 */

import { rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { createIndexHandle, type IndexHandle } from "../../src/lib/index/IndexHandle.js";
import { reindexOne, scanVault } from "../../src/lib/index/scanner.js";
import { closeSqlite, openSqlite } from "../../src/lib/index/sqlite.js";
import { type VaultRoot, validateVaultRoot } from "../../src/lib/validatePath.js";
import { startWatcher, toVaultRelative, type Watcher } from "../../src/lib/watcher.js";
import { WriteCoordinator } from "../../src/lib/writeCoordinator.js";
import { defer } from "../helpers/defer.js";
import { createTempVault } from "../helpers/vault.js";

interface Fixture {
	vaultRoot: VaultRoot;
	cleanupVault: () => Promise<void>;
	index: IndexHandle;
	closeDb: () => void;
	watcher: Watcher;
	closeWatcher: () => Promise<void>;
}

async function setup(): Promise<Fixture> {
	const v = await createTempVault({ "seed.md": "# Seed\n" });
	const vaultRoot = await validateVaultRoot(v.path);
	const opened = openSqlite({ dbPath: ":memory:" });
	const index = createIndexHandle(opened.db);
	index.setStatus("warming");
	const coordinator = new WriteCoordinator();
	await scanVault({ vaultRoot, index, coordinator, concurrency: 1 });
	const watcher = startWatcher({
		vaultRoot,
		index,
		coordinator,
		reindexFile: async (rel) => {
			await reindexOne(vaultRoot, index, rel);
		},
	});
	await watcher.ready();
	return {
		vaultRoot,
		cleanupVault: v.cleanup,
		index,
		closeDb: () => closeSqlite(opened.db),
		watcher,
		closeWatcher: () => watcher.close(),
	};
}

async function pollUntil<T>(predicate: () => T | undefined | null, timeoutMs = 3000, intervalMs = 50): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const value = predicate();
		if (value !== undefined && value !== null) return value;
		await new Promise((r) => setTimeout(r, intervalMs));
	}
	throw new Error(`pollUntil timed out after ${timeoutMs} ms`);
}

let fixture: Fixture;

beforeEach(async () => {
	fixture = await setup();
});

afterEach(async () => {
	await fixture.closeWatcher();
	fixture.closeDb();
	await fixture.cleanupVault();
});

describe("watcher — atomic-rename save (write tmp + rename)", () => {
	test("editor save via tmp file + rename triggers reindex", async () => {
		const target = "atomic.md";
		const targetAbs = join(fixture.vaultRoot.absolute, target);
		const tmpAbs = `${targetAbs}.tmp.swp`;

		// Editor pattern: write to tmp first, then rename atomically over
		// target. chokidar's `awaitWriteFinish` should coalesce the rename
		// into a single `add` (since the target didn't previously exist).
		await writeFile(tmpAbs, "# Atomic\n\n[[Seed]]\n", "utf8");
		await rename(tmpAbs, targetAbs);

		// Wait for the watcher to reindex.
		await pollUntil(() => (fixture.index.getFileMtime(target) !== null ? "indexed" : null), 5000);

		// Sanity: target file is on disk and has the expected content.
		const st = await stat(targetAbs);
		expect(st.isFile()).toBe(true);
	}, 10_000);

	test("update via tmp + rename refreshes existing index entry", async () => {
		const target = "evolves.md";
		const targetAbs = join(fixture.vaultRoot.absolute, target);
		const tmpAbs = `${targetAbs}.tmp.swp`;

		// Initial write (direct).
		await writeFile(targetAbs, "# Old\n", "utf8");
		const initialMtime = await pollUntil(() => fixture.index.getFileMtime(target), 5000);

		// Wait one ms tick to ensure mtime changes detectably.
		await new Promise((r) => setTimeout(r, 50));

		// Atomic rewrite.
		await writeFile(tmpAbs, "# New content\n\n[[Seed]] linked\n", "utf8");
		await rename(tmpAbs, targetAbs);

		const updatedMtime = await pollUntil(() => {
			const m = fixture.index.getFileMtime(target);
			return m !== null && m > initialMtime ? m : null;
		}, 5000);

		expect(updatedMtime).toBeGreaterThan(initialMtime);
	}, 10_000);

	test("unlink removes file from index", async () => {
		const target = "transient.md";
		const targetAbs = join(fixture.vaultRoot.absolute, target);

		await writeFile(targetAbs, "# Transient\n", "utf8");
		await pollUntil(() => fixture.index.getFileMtime(target), 5000);

		await rm(targetAbs);
		await pollUntil(() => (fixture.index.getFileMtime(target) === null ? "removed" : null), 5000);
	}, 10_000);
});

describe("watcher — ready() resolves even when called late", () => {
	test("ready() resolves after chokidar has already emitted ready", async () => {
		const v = await createTempVault({ "seed.md": "# Seed\n" });
		const vaultRoot = await validateVaultRoot(v.path);
		const opened = openSqlite({ dbPath: ":memory:" });
		const index = createIndexHandle(opened.db);
		index.setStatus("warming");

		const watcher = startWatcher({
			vaultRoot,
			index,
			coordinator: new WriteCoordinator(),
			reindexFile: async () => {},
		});
		try {
			// Sleep past chokidar's typical ready latency before calling
			// ready() so a lazy-listener implementation would hang here.
			await new Promise((r) => setTimeout(r, 250));

			const result = await Promise.race([
				watcher.ready().then(() => "ready" as const),
				new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 1000)),
			]);
			expect(result).toBe("ready");

			// Repeat call also resolves immediately.
			const second = await Promise.race([
				watcher.ready().then(() => "ready" as const),
				new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 1000)),
			]);
			expect(second).toBe("ready");
		} finally {
			await watcher.close();
			closeSqlite(opened.db);
			await v.cleanup();
		}
	}, 10_000);
});

describe("watcher — per-file reindex serialization", () => {
	test("rapid change events serialize: max 1 concurrent reindex per file", async () => {
		// Hold the FIRST reindex until released to prove the SECOND is queued.
		const v = await createTempVault({ "queue.md": "# initial\n" });
		const vaultRoot = await validateVaultRoot(v.path);
		const opened = openSqlite({ dbPath: ":memory:" });
		const index = createIndexHandle(opened.db);
		index.setStatus("warming");
		const coordinator = new WriteCoordinator();
		await scanVault({ vaultRoot, index, coordinator, concurrency: 1 });

		let activeCount = 0;
		let maxConcurrent = 0;
		const callOrder: number[] = [];
		const firstHeld = defer<void>();

		const watcher = startWatcher({
			vaultRoot,
			index,
			coordinator,
			reindexFile: async (rel) => {
				const callIndex = callOrder.length + 1;
				callOrder.push(callIndex);
				activeCount++;
				maxConcurrent = Math.max(maxConcurrent, activeCount);
				try {
					if (callIndex === 1) await firstHeld.promise;
					await reindexOne(vaultRoot, index, rel);
				} finally {
					activeCount--;
				}
			},
		});
		try {
			await watcher.ready();

			// First save → first event → reindexFile called → blocks on firstHeld.
			await writeFile(join(v.path, "queue.md"), "# v2 size\n", "utf8");
			await pollUntil(() => (callOrder.length >= 1 ? true : null), 5000);
			expect(activeCount).toBe(1);

			// Wait past stability threshold, then trigger a second save.
			await new Promise((r) => setTimeout(r, 250));
			await writeFile(join(v.path, "queue.md"), "# v3 different content payload\n", "utf8");

			// Give chokidar's awaitWriteFinish (100ms) + a buffer for the
			// event to fire and reach our queue. The second reindex must NOT
			// start while the first is still held.
			await new Promise((r) => setTimeout(r, 500));
			expect(callOrder.length).toBe(1);
			expect(activeCount).toBe(1);
			expect(maxConcurrent).toBe(1);

			// Release the first reindex → second should begin and complete.
			firstHeld.resolve();
			await pollUntil(() => (callOrder.length >= 2 ? true : null), 5000);
			// Final invariant: never two concurrent reindexes.
			expect(maxConcurrent).toBe(1);
		} finally {
			await watcher.close();
			closeSqlite(opened.db);
			await v.cleanup();
		}
	}, 15_000);
});

describe("watcher — close() does not drain coordinator", () => {
	test("close returns while a same-coordinator task is still in flight", async () => {
		// watcher.close() stops chokidar only; the bounded drain lives in
		// index.ts under SHUTDOWN_DRAIN_MS. The coordinator is shared with
		// scanner / merkle, so an unbounded drain inside close() would
		// block past the timeout on a hung scanner read.
		const v = await createTempVault({ "hold.md": "# v1\n" });
		const vaultRoot = await validateVaultRoot(v.path);
		const opened = openSqlite({ dbPath: ":memory:" });
		const index = createIndexHandle(opened.db);
		index.setStatus("warming");
		const coordinator = new WriteCoordinator();
		await scanVault({ vaultRoot, index, coordinator, concurrency: 1 });

		const held = defer<void>();
		let taskCompleted = false;
		const taskPromise = coordinator.enqueue("hold.md", async () => {
			await held.promise;
			taskCompleted = true;
		});

		const watcher = startWatcher({
			vaultRoot,
			index,
			coordinator,
			reindexFile: async () => {
				/* no-op; this test exercises close(), not reindex */
			},
		});
		try {
			await watcher.ready();

			const closeStart = Date.now();
			await watcher.close();
			const closeMs = Date.now() - closeStart;

			// close() must return promptly. Draining the shared coordinator
			// inside close() would block on `held.promise` indefinitely;
			// the bounded drain lives in index.ts under SHUTDOWN_DRAIN_MS.
			// 1 s is a generous ceiling — the expected duration is just
			// chokidar's internal close.
			expect(closeMs).toBeLessThan(1000);
			expect(taskCompleted).toBe(false);
		} finally {
			// Release the held task so the test exits cleanly even on
			// assertion failure.
			held.resolve();
			await taskPromise;
			closeSqlite(opened.db);
			await v.cleanup();
		}
	}, 10_000);
});

describe("watcher — unlink queues behind in-flight reindex", () => {
	test("delete during pending reindex doesn't resurrect the file", async () => {
		// A synchronous onUnlink would call `removeFile` while the
		// reindex's parse was still in flight; the reindex's later
		// `replaceFile` then resurrects fragments for a path no longer on
		// disk. Routing onUnlink through the coordinator orders the
		// remove behind any pending reindex.
		const v = await createTempVault({ "ghost.md": "# v1\n" });
		const vaultRoot = await validateVaultRoot(v.path);
		const opened = openSqlite({ dbPath: ":memory:" });
		const index = createIndexHandle(opened.db);
		index.setStatus("warming");
		const coordinator = new WriteCoordinator();
		await scanVault({ vaultRoot, index, coordinator, concurrency: 1 });

		// Hold the first reindex so the delete event lands behind it.
		const heldReindex = defer<void>();
		let reindexCount = 0;

		const watcher = startWatcher({
			vaultRoot,
			index,
			coordinator,
			reindexFile: async (rel) => {
				reindexCount++;
				if (reindexCount === 1) await heldReindex.promise;
				await reindexOne(vaultRoot, index, rel);
			},
		});
		try {
			await watcher.ready();

			// Trigger reindex by saving (held inside reindexFile).
			await writeFile(join(v.path, "ghost.md"), "# v2 changed body\n", "utf8");
			await pollUntil(() => (reindexCount >= 1 ? true : null), 5000);

			// Delete the file while the held reindex blocks. The unlink
			// must queue behind the reindex via the coordinator.
			await rm(join(v.path, "ghost.md"));
			await new Promise((r) => setTimeout(r, 250));

			// File row may still exist (reindex still held). Release.
			heldReindex.resolve();

			// After both queued tasks settle, the file is gone from the index.
			await pollUntil(() => (index.getFileMtime("ghost.md") === null ? true : null), 5000);
			expect(index.getFileMtime("ghost.md")).toBeNull();
		} finally {
			await watcher.close();
			closeSqlite(opened.db);
			await v.cleanup();
		}
	}, 15_000);
});

describe("watcher — toVaultRelative escape gate admits legal `..*` filenames", () => {
	// Predicate-level test: full integration via chokidar is gated by
	// the hidden-file plumbing (any `..*` filename is hidden by
	// isHiddenName, and readNote refuses hidden paths even when watcher
	// admits them — separate include-hidden plumbing scope). Verify
	// the predicate directly so the escape-gate is regression-guarded.
	const root = { absolute: "/vault", real: "/vault" } as VaultRoot;

	test("legal `..draft.md` filename is admitted (not dropped as escape)", () => {
		expect(toVaultRelative(root, "/vault/..draft.md")).toBe("..draft.md");
	});

	test("legal `..notes/x.md` subtree is admitted", () => {
		expect(toVaultRelative(root, "/vault/..notes/x.md")).toBe("..notes/x.md");
	});

	test("genuine escape `../escape.md` is rejected", () => {
		expect(toVaultRelative(root, "/escape.md")).toBeNull();
	});

	test("`..` exact (vault root traversal) is rejected", () => {
		expect(toVaultRelative(root, "/")).toBeNull();
	});

	test("absolute path outside vault is rejected", () => {
		expect(toVaultRelative(root, "/etc/passwd")).toBeNull();
	});
});

describe("watcher — toVaultRelative path-policy gate", () => {
	// `classifyRelpathPolicy` adds PERCENT_ENCODED, BACKSLASH, NULL_BYTE,
	// PATH_TOO_LONG, TOO_DEEP rejections to the watcher predicate. Without
	// these, chokidar's startup `add` for a policy-violating path reaches
	// reindexOne → validatePath rejects → outcome parse_failed → enters
	// pendingRetries with no drain channel (scanner & merkle's walks skip
	// the same path).
	const root = { absolute: "/vault", real: "/vault" } as VaultRoot;

	test("percent-encoded path is rejected", () => {
		expect(toVaultRelative(root, "/vault/bad%20name.md")).toBeNull();
	});

	test("null-byte path is rejected", () => {
		expect(toVaultRelative(root, "/vault/bad\x00.md")).toBeNull();
	});

	test("path exceeding MAX_PATH_DEPTH (32) is rejected", () => {
		const deep = `/vault/${Array.from({ length: 33 }, (_, i) => `d${i}`).join("/")}/leaf.md`;
		expect(toVaultRelative(root, deep)).toBeNull();
	});

	test("ordinary nested path within depth cap still admitted", () => {
		expect(toVaultRelative(root, "/vault/a/b/c.md")).toBe("a/b/c.md");
	});

	test.skipIf(process.platform === "win32")(
		"POSIX literal-backslash filename is rejected as BACKSLASH (not silently rewritten)",
		() => {
			// POSIX allows `\` in filenames; the watcher must NOT silently
			// rewrite `\` → `/` before `classifyRelpathPolicy` because that
			// would let a real file `foo\bar.md` collide with the unrelated
			// note `foo/bar.md` and bypass the BACKSLASH policy gate.
			expect(toVaultRelative(root, "/vault/foo\\bar.md")).toBeNull();
		},
	);
});

describe("watcher — ignoreInitial: false emits add for pre-existing files", () => {
	test("file present at watcher start triggers reindex callback", async () => {
		// `ignoreInitial: true` would suppress `add` events for files
		// chokidar discovers during its initial crawl. A file created
		// AFTER scanner walks its dir but BEFORE chokidar's `ready` is
		// then invisible until the merkle reconcile. With `false`,
		// chokidar always emits — the duplicate enqueue (scanner already
		// indexed it) is harmless because indexOne's mtime-skip makes
		// it a no-op.
		const v = await createTempVault({ "preexisting.md": "# Hi\n" });
		const vaultRoot = await validateVaultRoot(v.path);
		const opened = openSqlite({ dbPath: ":memory:" });
		const index = createIndexHandle(opened.db);
		index.setStatus("warming");
		const coordinator = new WriteCoordinator();

		// Don't scanVault first — we want to observe chokidar's own
		// initial-crawl add event for the pre-existing file.
		const seen = new Set<string>();
		const watcher = startWatcher({
			vaultRoot,
			index,
			coordinator,
			reindexFile: async (rel) => {
				seen.add(rel);
				await reindexOne(vaultRoot, index, rel);
			},
		});
		try {
			await watcher.ready();
			await pollUntil(() => (seen.has("preexisting.md") ? true : null), 5000);
			expect(seen.has("preexisting.md")).toBe(true);
		} finally {
			await watcher.close();
			closeSqlite(opened.db);
			await v.cleanup();
		}
	}, 10_000);
});
