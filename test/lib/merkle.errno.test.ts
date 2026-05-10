/**
 * Merkle errno-partition tests.
 *
 * Mirror of scanner.errno.test.ts but for the periodic reconcile path:
 * only ENOENT/ENOTDIR mean "the subtree vanished, prune its rows."
 * Other errno (EACCES, EMFILE, EIO, …) preserve existing rows so a
 * transient permission blip on a network mount doesn't silently drop
 * valid notes from search/links.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const realFs = vi.hoisted(() => ({
	stat: null as unknown as typeof import("node:fs/promises").stat,
	readdir: null as unknown as typeof import("node:fs/promises").readdir,
	lstat: null as unknown as typeof import("node:fs/promises").lstat,
}));

vi.mock("node:fs/promises", async (importActual) => {
	const actual = await importActual<typeof import("node:fs/promises")>();
	realFs.stat = actual.stat;
	realFs.readdir = actual.readdir;
	realFs.lstat = actual.lstat;
	return {
		...actual,
		stat: vi.fn(actual.stat),
		readdir: vi.fn(actual.readdir),
		lstat: vi.fn(actual.lstat),
	};
});

import * as fsPromises from "node:fs/promises";

import { createIndexHandle, type IndexHandle } from "../../src/lib/index/IndexHandle.js";
import { reindexOne, scanVault } from "../../src/lib/index/scanner.js";
import { closeSqlite, openSqlite } from "../../src/lib/index/sqlite.js";
import { startMerkleTick } from "../../src/lib/merkle.js";
import { type VaultRoot, validateVaultRoot } from "../../src/lib/validatePath.js";
import { WriteCoordinator } from "../../src/lib/writeCoordinator.js";
import { createTempVault, type VaultStructure } from "../helpers/vault.js";

interface Setup {
	vault: { path: string; cleanup: () => Promise<void> };
	opened: ReturnType<typeof openSqlite>;
	index: IndexHandle;
	vaultRoot: VaultRoot;
	coordinator: WriteCoordinator;
	teardown: () => Promise<void>;
}

const setups: Setup[] = [];

async function setup(structure: VaultStructure): Promise<Setup> {
	const vault = await createTempVault(structure);
	const opened = openSqlite({ dbPath: ":memory:" });
	const index = createIndexHandle(opened.db, { includeHidden: false });
	const vaultRoot = await validateVaultRoot(vault.path);
	// Populate index via a clean scan so the merkle tick has something to
	// preserve / prune. Scanner uses the real fs (mocks installed AFTER setup).
	const coordinator = new WriteCoordinator();
	await scanVault({ vaultRoot, index, coordinator, concurrency: 1 });
	const s: Setup = {
		vault,
		opened,
		index,
		vaultRoot,
		coordinator,
		teardown: async () => {
			closeSqlite(opened.db);
			await vault.cleanup();
		},
	};
	setups.push(s);
	return s;
}

function makeFsError(code: string): NodeJS.ErrnoException {
	const err: NodeJS.ErrnoException = new Error(`synthetic ${code}`);
	err.code = code;
	return err;
}

function mockReaddirErrnoFor(predicate: (path: string) => boolean, code: string): void {
	vi.mocked(fsPromises.readdir).mockImplementation(((path: import("node:fs").PathLike, opts?: unknown) => {
		if (typeof path === "string" && predicate(path)) return Promise.reject(makeFsError(code));
		return (realFs.readdir as (p: import("node:fs").PathLike, o?: unknown) => Promise<unknown>)(path, opts);
	}) as typeof fsPromises.readdir);
}

function mockStatErrnoFor(predicate: (path: string) => boolean, code: string): void {
	vi.mocked(fsPromises.stat).mockImplementation(((path: import("node:fs").PathLike) => {
		if (typeof path === "string" && predicate(path)) return Promise.reject(makeFsError(code));
		return realFs.stat(path);
	}) as typeof fsPromises.stat);
}

/**
 * For ENOENT/ENOTDIR readdir failures, the prune pass's stat-confirm
 * (`confirmPrune` → `lstat`) needs to see a matching errno on children
 * inside the vanished subtree to mirror the real-world cascade. Without
 * this, the test mocks readdir as ENOENT but leaves lstat live, so the
 * stat-confirm finds a still-present file on disk and refuses to prune.
 */
function mockLstatErrnoFor(predicate: (path: string) => boolean, code: string): void {
	vi.mocked(fsPromises.lstat).mockImplementation(((path: import("node:fs").PathLike, opts?: unknown) => {
		if (typeof path === "string" && predicate(path)) return Promise.reject(makeFsError(code));
		return (realFs.lstat as (p: import("node:fs").PathLike, o?: unknown) => Promise<unknown>)(path, opts);
	}) as typeof fsPromises.lstat);
}

beforeEach(() => {
	vi.mocked(fsPromises.stat).mockImplementation(realFs.stat);
	vi.mocked(fsPromises.readdir).mockImplementation(realFs.readdir);
	vi.mocked(fsPromises.lstat).mockImplementation(realFs.lstat);
});

afterEach(async () => {
	while (setups.length > 0) {
		const s = setups.pop();
		if (s) await s.teardown();
	}
	vi.mocked(fsPromises.stat).mockReset();
	vi.mocked(fsPromises.readdir).mockReset();
	vi.mocked(fsPromises.lstat).mockReset();
	vi.mocked(fsPromises.stat).mockImplementation(realFs.stat);
	vi.mocked(fsPromises.readdir).mockImplementation(realFs.readdir);
	vi.mocked(fsPromises.lstat).mockImplementation(realFs.lstat);
});

describe("merkle — readdir errno partition", () => {
	test("EACCES on subtree readdir → indexed rows preserved", async () => {
		// Swallowing readdir errors with a bare `return` would leave the
		// subdir files out of the `onDisk` set on EACCES, so step 2
		// drops every indexed row under subdir/. The fix tracks the
		// subtree in `failedSubtrees` and the prune pass skips it.
		const s = await setup({
			"top.md": "# top\n",
			subdir: { "inner.md": "# inner\n" },
		});
		expect(s.index.listIndexedFiles().sort()).toEqual(["subdir/inner.md", "top.md"]);

		mockReaddirErrnoFor((p) => p.endsWith("/subdir"), "EACCES");

		const tick = startMerkleTick({
			vaultRoot: s.vaultRoot,
			index: s.index,
			coordinator: s.coordinator,
			reindexFile: async (rel) => {
				await reindexOne(s.vaultRoot, s.index, rel);
			},
			intervalMs: 60_000,
		});
		try {
			await tick.runOnce();
		} finally {
			await tick.stop();
		}

		// subdir/inner.md must still be in the index — readdir failed transiently
		// and nuking the row would have made backlinks/search miss it until the
		// next watcher event.
		expect(s.index.listIndexedFiles().sort()).toEqual(["subdir/inner.md", "top.md"]);
	});

	test("ENOENT on subtree readdir → indexed rows pruned (counter-test)", async () => {
		// Errno partition: ENOENT/ENOTDIR mean "this subtree genuinely
		// vanished" — pruning is correct. Without this counter-test, a fix
		// that conservatively preserved rows on ALL readdir errors would pass
		// the EACCES case but break legitimate subtree-deletion handling.
		const s = await setup({
			"top.md": "# top\n",
			subdir: { "inner.md": "# inner\n" },
		});
		expect(s.index.listIndexedFiles().sort()).toEqual(["subdir/inner.md", "top.md"]);

		mockReaddirErrnoFor((p) => p.endsWith("/subdir"), "ENOENT");
		// Real-world cascade: when readdir(subdir) returns ENOENT, lstat
		// on a child path inside also returns ENOENT (the parent is gone).
		// Mirror that so `confirmPrune`'s stat gate matches reality.
		mockLstatErrnoFor((p) => p.includes("/subdir/"), "ENOENT");

		const tick = startMerkleTick({
			vaultRoot: s.vaultRoot,
			index: s.index,
			coordinator: s.coordinator,
			reindexFile: async (rel) => {
				await reindexOne(s.vaultRoot, s.index, rel);
			},
			intervalMs: 60_000,
		});
		try {
			await tick.runOnce();
		} finally {
			await tick.stop();
		}

		expect(s.index.listIndexedFiles().sort()).toEqual(["top.md"]);
	});

	test("EACCES on vault root → all indexed rows preserved", async () => {
		// Empty-string prefix in failedSubtrees represents the vault root
		// itself; isUnderFailedSubtree short-circuits to true so the prune
		// pass skips every indexed file.
		const s = await setup({
			"a.md": "# a\n",
			"b.md": "# b\n",
		});
		expect(s.index.listIndexedFiles().sort()).toEqual(["a.md", "b.md"]);

		mockReaddirErrnoFor((p) => p === s.vaultRoot.absolute, "EACCES");

		const tick = startMerkleTick({
			vaultRoot: s.vaultRoot,
			index: s.index,
			coordinator: s.coordinator,
			reindexFile: async (rel) => {
				await reindexOne(s.vaultRoot, s.index, rel);
			},
			intervalMs: 60_000,
		});
		try {
			await tick.runOnce();
		} finally {
			await tick.stop();
		}

		expect(s.index.listIndexedFiles().sort()).toEqual(["a.md", "b.md"]);
	});
});

describe("merkle — stat errno during drift detection", () => {
	test("EACCES on a NULL-size file → routed through reindex; failedFiles armed; finalize blocked", async () => {
		// `fragments.size = NULL` is the self-heal marker. When merkle's
		// drift detection stats the file and gets EACCES (permission blip on
		// a network mount, e.g.), the catch must route the rel through
		// reindex — `batchedReindex` re-stats inside `indexOne`, hits the
		// same EACCES, returns parse_failed, and adds to failedFiles. The
		// clean-finalize gate then sees failedFiles.size > 0 and skips
		// markScanFinalized over the un-recovered self-heal marker.
		const s = await setup({
			"a.md": "# A\n\nbody",
			"b.md": "# B\n\nbody",
		});
		// Force `scan_complete=false` so the finalize path is the one being
		// guarded; without it, the gate is `!getScanComplete()` so the test
		// can't observe whether it would fire.
		s.index.setScanComplete(false);
		// Self-heal marker: NULL size on b.md.
		s.opened.db.prepare("UPDATE fragments SET size = NULL WHERE file = :file").run({ file: "b.md" });
		expect(s.index.getFileStats("b.md")?.size ?? null).toBeNull();

		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			mockStatErrnoFor((p) => p.endsWith("b.md"), "EACCES");

			const tick = startMerkleTick({
				vaultRoot: s.vaultRoot,
				index: s.index,
				coordinator: s.coordinator,
				reindexFile: async (rel) => reindexOne(s.vaultRoot, s.index, rel),
				intervalMs: 60_000,
			});
			try {
				await tick.runOnce();
			} finally {
				await tick.stop();
			}

			// finalize blocked — failedFiles armed via parse_failed.
			expect(s.index.getScanComplete()).toBe(false);
			// b.md row preserved (not pruned) because indexOne returned
			// parse_failed not vanished.
			expect(s.index.listIndexedFiles().sort()).toEqual(["a.md", "b.md"]);
		} finally {
			errSpy.mockRestore();
		}
	});

	test("ENOENT on a stat-failure during drift detection → vanished routes prune the row", async () => {
		// Counter-test: ENOENT during drift detection means the file
		// disappeared mid-tick (between walkVaultMarkdown and
		// detectDrifted). The catch routes the rel through reindex →
		// indexOne maps ENOENT to "vanished" → removeFile clears the
		// row. Same outcome class as scanner.ts's `indexOne` ENOENT
		// branch — would otherwise leave an orphan until next walk cycle.
		const s = await setup({
			"a.md": "# A\n\nbody",
			"b.md": "# B\n\nbody",
		});
		s.index.setScanComplete(false);
		s.opened.db.prepare("UPDATE fragments SET size = NULL WHERE file = :file").run({ file: "b.md" });

		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			// stat AND lstat must both ENOENT — `confirmPrune` falls back on
			// lstat and would otherwise resurrect the row.
			mockStatErrnoFor((p) => p.endsWith("b.md"), "ENOENT");
			vi.mocked(fsPromises.lstat).mockImplementation(((path: import("node:fs").PathLike) => {
				if (typeof path === "string" && path.endsWith("b.md")) return Promise.reject(makeFsError("ENOENT"));
				return realFs.lstat(path);
			}) as typeof fsPromises.lstat);

			const tick = startMerkleTick({
				vaultRoot: s.vaultRoot,
				index: s.index,
				coordinator: s.coordinator,
				// Mirror production `reindexCallback`: vanished outcome → caller
				// removes the row. Without this, the test asserts on bare
				// reindexOne semantics which don't include the removeFile
				// step. Tests in merkle.test.ts that exercise rm() use the
				// scan-time prune pass which independently handles disk-deleted
				// files; that path doesn't apply here because b.md is "on disk"
				// per readdir but stat is the one mocked.
				reindexFile: async (rel) => {
					const outcome = await reindexOne(s.vaultRoot, s.index, rel);
					if (outcome === "vanished") s.index.removeFile(rel, Date.now());
					return outcome;
				},
				intervalMs: 60_000,
			});
			try {
				await tick.runOnce();
			} finally {
				await tick.stop();
			}

			// b.md pruned (vanished route).
			expect(s.index.listIndexedFiles().sort()).toEqual(["a.md"]);
		} finally {
			errSpy.mockRestore();
		}
	});
});
