/**
 * Scanner errno-partition tests.
 *
 * Covers F2 (readdir) + F3 (stat) — only ENOENT/ENOTDIR mean "the path
 * vanished, prune its rows." Other errno values (EACCES, EBUSY, EMFILE,
 * EIO, …) preserve existing rows and leave `scan_complete = false` so
 * the next startup retries.
 *
 * Mocks `node:fs/promises` with a passthrough factory so tests can
 * inject errno on a per-path basis. Untouched fs methods (`rm`,
 * `writeFile`, …) flow through to the real implementations via the
 * spread; only `stat` and `readdir` carry overridable behavior.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// `vi.hoisted` shares state between the hoisted factory and the rest of
// the file — bare `let` declarations sit in TDZ when the factory runs.
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

import { createIndexHandle, type IndexHandle } from "../../../src/lib/index/IndexHandle.js";
import { scanVault } from "../../../src/lib/index/scanner.js";
import { closeSqlite, openSqlite } from "../../../src/lib/index/sqlite.js";
import { type VaultRoot, validateVaultRoot } from "../../../src/lib/validatePath.js";
import { createTempVault, type VaultStructure } from "../../helpers/vault.js";

interface Setup {
	vault: { path: string; cleanup: () => Promise<void> };
	opened: ReturnType<typeof openSqlite>;
	index: IndexHandle;
	vaultRoot: VaultRoot;
	teardown: () => Promise<void>;
}

const setups: Setup[] = [];

async function setup(structure: VaultStructure): Promise<Setup> {
	const vault = await createTempVault(structure);
	const opened = openSqlite({ dbPath: ":memory:" });
	const index = createIndexHandle(opened.db);
	// realpath the temp dir so indexOne's validatePath containment check
	// passes on macOS (/var/folders → /private/var/folders symlink).
	const vaultRoot: VaultRoot = await validateVaultRoot(vault.path);
	const s: Setup = {
		vault,
		opened,
		index,
		vaultRoot,
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

/**
 * Install a `stat` mock that throws `code` on paths matching `predicate`
 * and otherwise call-throughs to the real fs. Folds the repeated
 * `((path) => …) as typeof fsPromises.stat` cast into one place.
 */
function mockStatErrnoFor(predicate: (path: string) => boolean, code: string): void {
	vi.mocked(fsPromises.stat).mockImplementation(((path: import("node:fs").PathLike) => {
		if (typeof path === "string" && predicate(path)) return Promise.reject(makeFsError(code));
		return realFs.stat(path);
	}) as typeof fsPromises.stat);
}

/** Same shape as {@link mockStatErrnoFor} but for `readdir`. */
function mockReaddirErrnoFor(predicate: (path: string) => boolean, code: string): void {
	vi.mocked(fsPromises.readdir).mockImplementation(((path: import("node:fs").PathLike, opts?: unknown) => {
		if (typeof path === "string" && predicate(path)) return Promise.reject(makeFsError(code));
		return (realFs.readdir as (p: import("node:fs").PathLike, o?: unknown) => Promise<unknown>)(path, opts);
	}) as typeof fsPromises.readdir);
}

/** Same shape as {@link mockStatErrnoFor} but for `lstat`. */
function mockLstatErrnoFor(predicate: (path: string) => boolean, code: string): void {
	vi.mocked(fsPromises.lstat).mockImplementation(((path: import("node:fs").PathLike) => {
		if (typeof path === "string" && predicate(path)) return Promise.reject(makeFsError(code));
		return realFs.lstat(path);
	}) as typeof fsPromises.lstat);
}

/**
 * Install an `lstat` mock that returns a synthetic symlink Stats for paths
 * matching `predicate`. Used to simulate a parent-dir or leaf swapped to
 * a symlink between scans (validatePath rejects with SYMLINK_SEGMENT).
 */
function mockLstatSymlinkFor(predicate: (path: string) => boolean): void {
	vi.mocked(fsPromises.lstat).mockImplementation(((path: import("node:fs").PathLike) => {
		if (typeof path === "string" && predicate(path)) {
			return Promise.resolve({
				isSymbolicLink: () => true,
				isDirectory: () => false,
				isFile: () => false,
			} as unknown as import("node:fs").Stats);
		}
		return realFs.lstat(path);
	}) as typeof fsPromises.lstat);
}

beforeEach(() => {
	// Reinstall the call-through default; previous tests may have overridden.
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

describe("F3 — scanner stat errno partition", () => {
	test("ENOENT for a file → vanished → its rows pruned (regression guard)", async () => {
		const s = await setup({
			"a.md": "# A\n\nbody",
			"b.md": "# B\n\nbody",
		});
		// Initial clean scan populates both files.
		await scanVault({ vaultRoot: s.vaultRoot, index: s.index, concurrency: 1 });
		expect(s.index.listIndexedFiles().sort()).toEqual(["a.md", "b.md"]);

		// Make stat throw ENOENT for b.md only — simulates "file deleted
		// between walkVault and indexOne." readdir still lists b.md so it
		// reaches indexOne, which catches the stat error and returns
		// "vanished" → b.md is excluded from `stillOnDisk` → prune drops it.
		mockStatErrnoFor((p) => p.endsWith("b.md"), "ENOENT");

		// scan_complete must have been true coming in so skipUnchanged is
		// active for a.md (sanity check the test setup).
		expect(s.index.getScanComplete()).toBe(true);

		await scanVault({ vaultRoot: s.vaultRoot, index: s.index, concurrency: 1 });
		expect(s.index.listIndexedFiles()).toEqual(["a.md"]);
	});

	test("EACCES for a file → preserved → counts as skipped, rows kept", async () => {
		const s = await setup({
			"a.md": "# A\n\nbody",
			"b.md": "# B\n\nbody",
		});
		await scanVault({ vaultRoot: s.vaultRoot, index: s.index, concurrency: 1 });
		expect(s.index.listIndexedFiles().sort()).toEqual(["a.md", "b.md"]);

		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			mockStatErrnoFor((p) => p.endsWith("b.md"), "EACCES");

			const result = await scanVault({ vaultRoot: s.vaultRoot, index: s.index, concurrency: 1 });
			// b.md preserved (parse_failed routes through stillOnDisk).
			expect(s.index.listIndexedFiles().sort()).toEqual(["a.md", "b.md"]);
			expect(result.filesSkipped).toBeGreaterThan(0);

			const stderr = errSpy.mock.calls.flat().join("\n");
			expect(stderr).toMatch(/skipping b\.md \(stat: EACCES\)/);
		} finally {
			errSpy.mockRestore();
		}
	});
});

describe("F2 — scanner readdir errno partition", () => {
	test("ENOENT on a subtree → directory vanished → its rows pruned, scan_complete=true", async () => {
		const s = await setup({
			"a.md": "# A\n\nbody",
			sub: { "b.md": "# B\n\nbody" },
		});
		await scanVault({ vaultRoot: s.vaultRoot, index: s.index, concurrency: 1 });
		expect(s.index.listIndexedFiles().sort()).toEqual(["a.md", "sub/b.md"]);
		expect(s.index.getScanComplete()).toBe(true);

		// Make readdir on `sub/` throw ENOENT — simulating the directory
		// being deleted between scans. This is the legitimate "vanished"
		// path where pruning the subtree's rows is correct.
		mockReaddirErrnoFor((p) => p.endsWith("/sub"), "ENOENT");

		await scanVault({ vaultRoot: s.vaultRoot, index: s.index, concurrency: 1 });
		expect(s.index.listIndexedFiles()).toEqual(["a.md"]);
		expect(s.index.getScanComplete()).toBe(true);
	});

	test("EACCES on a subtree (warm restart) → rows preserved, scan_complete=false, state stays warm", async () => {
		const s = await setup({
			"a.md": "# A\n\nbody",
			sub: { "b.md": "# B\n\nbody" },
		});
		await scanVault({ vaultRoot: s.vaultRoot, index: s.index, concurrency: 1 });
		expect(s.index.listIndexedFiles().sort()).toEqual(["a.md", "sub/b.md"]);
		expect(s.index.getScanComplete()).toBe(true);
		expect(s.index.getStatus().state).toBe("warm");

		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			mockReaddirErrnoFor((p) => p.endsWith("/sub"), "EACCES");

			await scanVault({ vaultRoot: s.vaultRoot, index: s.index, concurrency: 1 });
			// `sub/b.md` preserved — readdir on `sub/` failed, so we don't
			// know whether the file is still there.
			expect(s.index.listIndexedFiles().sort()).toEqual(["a.md", "sub/b.md"]);
			// scan_complete must stay false so the next startup retries.
			expect(s.index.getScanComplete()).toBe(false);
			// Warm restart with failed subtree keeps state warm — the prior
			// snapshot in `fragments` is still consistent for vault-wide
			// reads; scan_complete=false handles the retry.
			expect(s.index.getStatus().state).toBe("warm");

			const stderr = errSpy.mock.calls.flat().join("\n");
			expect(stderr).toMatch(/skipping subtree sub \(readdir error: EACCES\)/);
		} finally {
			errSpy.mockRestore();
		}
	});

	test("EACCES on vault root (warm restart) → all rows preserved, scan_complete=false, state stays warm", async () => {
		const s = await setup({
			"a.md": "# A\n\nbody",
			sub: { "b.md": "# B\n\nbody" },
		});
		await scanVault({ vaultRoot: s.vaultRoot, index: s.index, concurrency: 1 });
		expect(s.index.listIndexedFiles().sort()).toEqual(["a.md", "sub/b.md"]);
		expect(s.index.getScanComplete()).toBe(true);
		expect(s.index.getStatus().state).toBe("warm");

		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			mockReaddirErrnoFor(() => true, "EACCES");

			await scanVault({ vaultRoot: s.vaultRoot, index: s.index, concurrency: 1 });
			// Every file under the vault root is preserved — `failedSubtrees`
			// has the empty-string sentinel (root-level failure).
			expect(s.index.listIndexedFiles().sort()).toEqual(["a.md", "sub/b.md"]);
			expect(s.index.getScanComplete()).toBe(false);
			expect(s.index.getStatus().state).toBe("warm");

			const stderr = errSpy.mock.calls.flat().join("\n");
			expect(stderr).toMatch(/skipping subtree \(vault root\) \(readdir error: EACCES\)/);
		} finally {
			errSpy.mockRestore();
		}
	});
});

describe("scanner end-state — failed subtrees gate `state`, not just `scan_complete`", () => {
	test("cold start + EACCES subtree → state stays `warming`, scan_complete=false", async () => {
		// Cold start: no prior snapshot. A failed subtree means the index is
		// silently partial; vault-wide search must NOT be advertised as warm.
		const s = await setup({
			"a.md": "# A\n\nbody",
			sub: { "b.md": "# B\n\nbody" },
		});
		expect(s.index.getStatus().state).toBe("cold");
		expect(s.index.getScanComplete()).toBe(false);

		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			mockReaddirErrnoFor((p) => p.endsWith("/sub"), "EACCES");
			await scanVault({ vaultRoot: s.vaultRoot, index: s.index, concurrency: 1 });

			// Bounded reads can still find `a.md` (the successful subtree got
			// indexed); vault-wide tools return INDEX_WARMING because state
			// stayed `warming`.
			expect(s.index.listIndexedFiles()).toEqual(["a.md"]);
			expect(s.index.getScanComplete()).toBe(false);
			expect(s.index.getStatus().state).toBe("warming");
			// Round-14: a partial-finish scan must NOT promote ever_complete.
			// Otherwise startup after restart would mark this state as warm.
			expect(s.index.getEverComplete()).toBe(false);
		} finally {
			errSpy.mockRestore();
		}
	});

	test("cold start + EACCES on vault root → state stays `warming`, no rows indexed", async () => {
		const s = await setup({ "a.md": "# A\n\nbody" });
		expect(s.index.getStatus().state).toBe("cold");

		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			mockReaddirErrnoFor(() => true, "EACCES");
			await scanVault({ vaultRoot: s.vaultRoot, index: s.index, concurrency: 1 });

			expect(s.index.listIndexedFiles()).toEqual([]);
			expect(s.index.getScanComplete()).toBe(false);
			expect(s.index.getStatus().state).toBe("warming");
		} finally {
			errSpy.mockRestore();
		}
	});

	test("clean cold start (no failures) → state flips to `warm`", async () => {
		const s = await setup({ "a.md": "# A\n\nbody" });
		expect(s.index.getStatus().state).toBe("cold");

		await scanVault({ vaultRoot: s.vaultRoot, index: s.index, concurrency: 1 });
		expect(s.index.getStatus().state).toBe("warm");
		expect(s.index.getScanComplete()).toBe(true);
		expect(s.index.getEverComplete()).toBe(true);
	});
});

describe("scanner end-state — `failedFiles` gate (per-file failure)", () => {
	test("cold start + EACCES on a file → state stays `warming`, scan_complete=false, ever_complete=false", async () => {
		// A file-level non-vanished error (EACCES/EMFILE/EIO) leaves the index
		// silently partial. The gate must NOT flip `scan_complete=true` or
		// `ever_complete` — a cold first scan that advertises itself as warm
		// would have agents trust a partial dataset.
		const s = await setup({
			"a.md": "# A\n\nbody",
			"b.md": "# B\n\nbody",
		});
		expect(s.index.getStatus().state).toBe("cold");
		expect(s.index.getScanComplete()).toBe(false);
		expect(s.index.getEverComplete()).toBe(false);

		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			mockStatErrnoFor((p) => p.endsWith("b.md"), "EACCES");
			await scanVault({ vaultRoot: s.vaultRoot, index: s.index, concurrency: 1 });

			expect(s.index.listIndexedFiles()).toEqual(["a.md"]);
			expect(s.index.getScanComplete()).toBe(false);
			expect(s.index.getStatus().state).toBe("warming");
			expect(s.index.getEverComplete()).toBe(false);
		} finally {
			errSpy.mockRestore();
		}
	});

	test("warm restart + EACCES on a file → state stays `warm`, scan_complete=false (retry signal)", async () => {
		// Warm restart with a per-file failure: the prior snapshot still
		// serves vault-wide reads consistently, so state stays `warm`. But
		// `scan_complete=false` so the next startup retries the failed file
		// rather than silently keeping it stale.
		const s = await setup({
			"a.md": "# A\n\nbody",
			"b.md": "# B\n\nbody",
		});
		await scanVault({ vaultRoot: s.vaultRoot, index: s.index, concurrency: 1 });
		expect(s.index.getStatus().state).toBe("warm");
		expect(s.index.getScanComplete()).toBe(true);
		expect(s.index.getEverComplete()).toBe(true);

		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			mockStatErrnoFor((p) => p.endsWith("b.md"), "EACCES");
			await scanVault({ vaultRoot: s.vaultRoot, index: s.index, concurrency: 1 });

			expect(s.index.listIndexedFiles().sort()).toEqual(["a.md", "b.md"]);
			expect(s.index.getScanComplete()).toBe(false);
			expect(s.index.getStatus().state).toBe("warm");
			// One-way latch is preserved across the failed reconcile.
			expect(s.index.getEverComplete()).toBe(true);
		} finally {
			errSpy.mockRestore();
		}
	});

	test("cold start + parse_failed file → state stays `warming`, scan_complete=false, ever_complete=false", async () => {
		// `parse_failed` outcome (broken YAML frontmatter) routes through the
		// same preserve-and-retry path as worker-catch failures; gate must
		// treat it as a failed file too.
		const s = await setup({
			"a.md": "# A\n\nbody",
			"b.md": "---\nbroken: [unclosed\n---\n# B\n",
		});
		expect(s.index.getStatus().state).toBe("cold");

		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			await scanVault({ vaultRoot: s.vaultRoot, index: s.index, concurrency: 1 });

			expect(s.index.listIndexedFiles()).toEqual(["a.md"]);
			expect(s.index.getScanComplete()).toBe(false);
			expect(s.index.getStatus().state).toBe("warming");
			expect(s.index.getEverComplete()).toBe(false);
		} finally {
			errSpy.mockRestore();
		}
	});
});

describe("scanVault — indexOne re-validates path before reading", () => {
	test("parent dir swapped to symlink between walkVault and indexOne → row preserved + log", async () => {
		// walkVault filters symlinks at readdir time but a parent-dir swap
		// after that would slip past `O_NOFOLLOW` (leaf-only). validatePath's
		// segment walk catches it. Pre-existing row from the previous clean
		// scan must survive — parse_failed routes through `stillOnDisk` so
		// the prune pass leaves it alone.
		const s = await setup({ foo: { "bar.md": "# Bar\n\nlegit content\n" } });
		await scanVault({ vaultRoot: s.vaultRoot, index: s.index, concurrency: 1 });
		expect(s.index.listIndexedFiles()).toEqual(["foo/bar.md"]);
		// Close the skipUnchanged gate so the second scan re-enters indexOne's
		// validatePath branch. `wasComplete` is captured from getScanComplete()
		// at scan start; flipping it false here forces full re-validation.
		s.index.setScanComplete(false);

		const fooAbs = `${s.vaultRoot.absolute}/foo`;
		mockLstatSymlinkFor((p) => p === fooAbs);

		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			const result = await scanVault({ vaultRoot: s.vaultRoot, index: s.index, concurrency: 1 });
			expect(result.aborted).toBe(false);
			expect(result.filesSkipped).toBeGreaterThanOrEqual(1);
			expect(s.index.listIndexedFiles()).toEqual(["foo/bar.md"]);
			const messages = errSpy.mock.calls.map((c) => String(c[0]));
			expect(messages.some((m) => m.includes("(validate:") && m.includes("SYMLINK_SEGMENT"))).toBe(true);
		} finally {
			errSpy.mockRestore();
		}
	});

	test("warm-reconcile fast path also validates — parent dir swap caught with scan_complete=true", async () => {
		const s = await setup({ foo: { "bar.md": "# Bar\n\nlegit content\n" } });
		await scanVault({ vaultRoot: s.vaultRoot, index: s.index, concurrency: 1 });
		expect(s.index.listIndexedFiles()).toEqual(["foo/bar.md"]);
		// Crucially: NOT calling setScanComplete(false). With scan_complete=true,
		// the (mtime, size) fast path is active (the real file's `stat` is
		// unchanged because the lstat mock only intercepts `lstat`; `stat`
		// still resolves the real inode). validatePath must fire FIRST so the
		// symlink check isn't bypassed.
		expect(s.index.getScanComplete()).toBe(true);

		const fooAbs = `${s.vaultRoot.absolute}/foo`;
		mockLstatSymlinkFor((p) => p === fooAbs);

		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			const result = await scanVault({ vaultRoot: s.vaultRoot, index: s.index, concurrency: 1 });
			expect(result.aborted).toBe(false);
			expect(result.filesSkipped).toBeGreaterThanOrEqual(1);
			// Row preserved — SYMLINK_SEGMENT routes parse_failed (transient
			// swap tolerance).
			expect(s.index.listIndexedFiles()).toEqual(["foo/bar.md"]);
			// validatePath log proves the segment walk fired even though the
			// fast path would otherwise have returned "indexed".
			const messages = errSpy.mock.calls.map((c) => String(c[0]));
			expect(messages.some((m) => m.includes("(validate:") && m.includes("SYMLINK_SEGMENT"))).toBe(true);
		} finally {
			errSpy.mockRestore();
		}
	});
});

describe("scanVault — PATH_NOT_FOUND classification", () => {
	test("validatePath PATH_NOT_FOUND mid-warm-reconcile → vanished, row pruned", async () => {
		const s = await setup({
			"a.md": "# A\n\nbody",
			"b.md": "# B\n\nbody",
		});
		await scanVault({ vaultRoot: s.vaultRoot, index: s.index, concurrency: 1 });
		expect(s.index.listIndexedFiles().sort()).toEqual(["a.md", "b.md"]);
		expect(s.index.getScanComplete()).toBe(true);

		// Mock lstat to reject ENOENT for a.md leaf only. validatePath segment
		// walk hits ENOENT → throws PathValidationError(PATH_NOT_FOUND).
		const aMdAbs = `${s.vaultRoot.absolute}/a.md`;
		mockLstatErrnoFor((p) => p === aMdAbs, "ENOENT");

		await scanVault({ vaultRoot: s.vaultRoot, index: s.index, concurrency: 1 });
		// "vanished" outcome: a.md excluded from stillOnDisk → prune pass
		// removes the row.
		expect(s.index.listIndexedFiles()).toEqual(["b.md"]);
		// No failedFiles increment, scan_complete still flips true.
		expect(s.index.getScanComplete()).toBe(true);
		expect(s.index.getStatus().state).toBe("warm");
	});

	test("cold first scan with one PATH_NOT_FOUND disappearance → state flips warm", async () => {
		// Regression for the prior bug where a single mid-scan disappearance
		// inflated failedFiles=1 → state stuck at `warming` for the rest of
		// the process → vault-wide search returned INDEX_WARMING.
		const s = await setup({
			"a.md": "# A\n\nbody",
			"b.md": "# B\n\nbody",
		});
		expect(s.index.getStatus().state).toBe("cold");

		const aMdAbs = `${s.vaultRoot.absolute}/a.md`;
		mockLstatErrnoFor((p) => p === aMdAbs, "ENOENT");

		await scanVault({ vaultRoot: s.vaultRoot, index: s.index, concurrency: 1 });
		expect(s.index.listIndexedFiles()).toEqual(["b.md"]);
		expect(s.index.getScanComplete()).toBe(true);
		expect(s.index.getStatus().state).toBe("warm");
		expect(s.index.getEverComplete()).toBe(true);
	});

	test("non-PATH_NOT_FOUND PathValidationError preserves rows (regression)", async () => {
		// SYMLINK_SEGMENT and other PATH_OUTSIDE_VAULT reasons must keep
		// routing to parse_failed so transient swaps don't nuke valid rows
		// from the prior clean scan. Only PATH_NOT_FOUND (file genuinely
		// gone) should prune.
		const s = await setup({ "a.md": "# A\n\nbody" });
		await scanVault({ vaultRoot: s.vaultRoot, index: s.index, concurrency: 1 });
		expect(s.index.listIndexedFiles()).toEqual(["a.md"]);
		expect(s.index.getScanComplete()).toBe(true);

		// Leaf swapped to symlink between scans → SYMLINK_SEGMENT.
		const aMdAbs = `${s.vaultRoot.absolute}/a.md`;
		mockLstatSymlinkFor((p) => p === aMdAbs);

		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			await scanVault({ vaultRoot: s.vaultRoot, index: s.index, concurrency: 1 });
			// Row preserved (parse_failed → stillOnDisk).
			expect(s.index.listIndexedFiles()).toEqual(["a.md"]);
			// failedFiles increments → scan_complete stays false (retry signal).
			expect(s.index.getScanComplete()).toBe(false);
			// Warm restart with per-file failure stays warm (round-17 contract).
			expect(s.index.getStatus().state).toBe("warm");
		} finally {
			errSpy.mockRestore();
		}
	});
});
