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

// Mock-helper predicates throughout this file key on POSIX `/`-form paths
// (e.g. `p.endsWith("/sub/b.md")`, `p === `${root}/foo`). Each helper
// normalizes the live fs path through `toPosix` before invoking the
// predicate so the same fixture predicates work on Windows.
import { toPosix } from "../../../src/lib/pathPosix.js";

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
	const index = createIndexHandle(opened.db, { includeHidden: false });
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
	vi.mocked(fsPromises.stat).mockImplementation(((path: import("node:fs").PathLike, opts?: unknown) => {
		if (typeof path === "string" && predicate(toPosix(path))) return Promise.reject(makeFsError(code));
		return (realFs.stat as (p: import("node:fs").PathLike, o?: unknown) => Promise<unknown>)(path, opts);
	}) as typeof fsPromises.stat);
}

/** Same shape as {@link mockStatErrnoFor} but for `readdir`. */
function mockReaddirErrnoFor(predicate: (path: string) => boolean, code: string): void {
	vi.mocked(fsPromises.readdir).mockImplementation(((path: import("node:fs").PathLike, opts?: unknown) => {
		if (typeof path === "string" && predicate(toPosix(path))) return Promise.reject(makeFsError(code));
		return (realFs.readdir as (p: import("node:fs").PathLike, o?: unknown) => Promise<unknown>)(path, opts);
	}) as typeof fsPromises.readdir);
}

/** Filter directory entries by name, leaving the directory itself enumerable. */
function mockReaddirFilterEntry(filterName: string): void {
	vi.mocked(fsPromises.readdir).mockImplementation(((path: import("node:fs").PathLike, opts?: unknown) => {
		return (realFs.readdir as (p: import("node:fs").PathLike, o?: unknown) => Promise<unknown>)(path, opts).then(
			(out) => {
				const arr = out as Array<{ name: string } | string>;
				return arr.filter((e) => (typeof e === "string" ? e !== filterName : e.name !== filterName));
			},
		);
	}) as typeof fsPromises.readdir);
}

/** Same shape as {@link mockStatErrnoFor} but for `lstat`. */
function mockLstatErrnoFor(predicate: (path: string) => boolean, code: string): void {
	vi.mocked(fsPromises.lstat).mockImplementation(((path: import("node:fs").PathLike, opts?: unknown) => {
		if (typeof path === "string" && predicate(toPosix(path))) return Promise.reject(makeFsError(code));
		return (realFs.lstat as (p: import("node:fs").PathLike, o?: unknown) => Promise<unknown>)(path, opts);
	}) as typeof fsPromises.lstat);
}

/**
 * Install an `lstat` mock that returns a synthetic Stats of the requested
 * non-regular type for paths matching `predicate`. `"symlink"` simulates a
 * parent-dir or leaf swapped to a symlink (validatePath rejects with
 * SYMLINK_SEGMENT); `"directory"` simulates a file replaced by a directory
 * at the same path.
 */
function mockLstatType(predicate: (path: string) => boolean, kind: "symlink" | "directory"): void {
	vi.mocked(fsPromises.lstat).mockImplementation(((path: import("node:fs").PathLike, opts?: unknown) => {
		if (typeof path === "string" && predicate(toPosix(path))) {
			return Promise.resolve({
				isSymbolicLink: () => kind === "symlink",
				isDirectory: () => kind === "directory",
				isFile: () => false,
			} as unknown as import("node:fs").Stats);
		}
		return (realFs.lstat as (p: import("node:fs").PathLike, o?: unknown) => Promise<unknown>)(path, opts);
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
		// `pruneVanishedFiles` uses lstat (not stat) to also detect file→
		// symlink/directory swaps, so mock both.
		mockStatErrnoFor((p) => p.endsWith("b.md"), "ENOENT");
		mockLstatErrnoFor((p) => p.endsWith("b.md"), "ENOENT");

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
		// path where pruning the subtree's rows is correct. The prune pass
		// stat-confirms before removing rows (defense against watcher race),
		// so the subtree files must also fail lstat (the prune pass uses
		// lstat to also catch non-regular swaps).
		mockReaddirErrnoFor((p) => p.endsWith("/sub"), "ENOENT");
		mockStatErrnoFor((p) => p.endsWith("/sub/b.md") || p.endsWith("/sub"), "ENOENT");
		mockLstatErrnoFor((p) => p.endsWith("/sub/b.md") || p.endsWith("/sub"), "ENOENT");

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
			// A partial-finish scan must NOT promote ever_complete.
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

		const fooAbs = `${toPosix(s.vaultRoot.absolute)}/foo`;
		mockLstatType((p) => p === fooAbs, "symlink");

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

		const fooAbs = `${toPosix(s.vaultRoot.absolute)}/foo`;
		mockLstatType((p) => p === fooAbs, "symlink");

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
		const aMdAbs = `${toPosix(s.vaultRoot.absolute)}/a.md`;
		mockLstatErrnoFor((p) => p === aMdAbs, "ENOENT");
		// Prune now stat-confirms before removing rows; if the file is
		// genuinely vanished, stat must also fail.
		mockStatErrnoFor((p) => p === aMdAbs, "ENOENT");

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

		const aMdAbs = `${toPosix(s.vaultRoot.absolute)}/a.md`;
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
		const aMdAbs = `${toPosix(s.vaultRoot.absolute)}/a.md`;
		mockLstatType((p) => p === aMdAbs, "symlink");

		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			await scanVault({ vaultRoot: s.vaultRoot, index: s.index, concurrency: 1 });
			// Row preserved (parse_failed → stillOnDisk).
			expect(s.index.listIndexedFiles()).toEqual(["a.md"]);
			// failedFiles increments → scan_complete stays false (retry signal).
			expect(s.index.getScanComplete()).toBe(false);
			// Warm restart with per-file failure stays warm: the prior
			// snapshot still serves vault-wide reads while the failure
			// retry signal lives on `scan_complete=false`.
			expect(s.index.getStatus().state).toBe("warm");
		} finally {
			errSpy.mockRestore();
		}
	});
});

describe("pruneVanishedFiles regular-file gate", () => {
	// `walkVault` only yields regular markdown files; if the on-disk
	// entity at an indexed path becomes a directory, symlink, FIFO, etc.,
	// a `stat()` that follows symlinks and doesn't gate on isFile would
	// preserve the row even though direct-read tools now reject the path.
	// `lstat()` + `!isFile()` closes the gap.

	test("file replaced by directory at same path → row pruned", async () => {
		const s = await setup({ "swap.md": "# Swap\n\nbody" });
		await scanVault({ vaultRoot: s.vaultRoot, index: s.index, concurrency: 1 });
		expect(s.index.listIndexedFiles()).toEqual(["swap.md"]);

		// walkVault yields directories into the recursion, not the file
		// emit — we filter the entry out so it's not enumerated, simulating
		// the readdir step seeing it as a non-yielding entity. lstat reports
		// the new on-disk type so the prune pass's `!isFile()` fires.
		mockReaddirFilterEntry("swap.md");
		const swapAbs = `${toPosix(s.vaultRoot.absolute)}/swap.md`;
		mockLstatType((p) => p === swapAbs, "directory");

		await scanVault({ vaultRoot: s.vaultRoot, index: s.index, concurrency: 1 });
		expect(s.index.listIndexedFiles()).toEqual([]);
	});

	test("file replaced by symlink at same path → row pruned", async () => {
		const s = await setup({ "swap.md": "# Swap\n\nbody" });
		await scanVault({ vaultRoot: s.vaultRoot, index: s.index, concurrency: 1 });
		expect(s.index.listIndexedFiles()).toEqual(["swap.md"]);

		mockReaddirFilterEntry("swap.md");
		const swapAbs = `${toPosix(s.vaultRoot.absolute)}/swap.md`;
		mockLstatType((p) => p === swapAbs, "symlink");

		await scanVault({ vaultRoot: s.vaultRoot, index: s.index, concurrency: 1 });
		expect(s.index.listIndexedFiles()).toEqual([]);
	});

	test("counter — regular file at indexed path is preserved (watcher-race tolerance)", async () => {
		// Mirror of N3: file IS still a regular markdown file but walkVault
		// missed enumerating it (e.g., readdir filtered or scan races a
		// concurrent write). lstat returns isFile=true → prune=false → row
		// stays — the regular-file gate must NOT regress this guarantee.
		const s = await setup({ "race.md": "# Race\n" });
		await scanVault({ vaultRoot: s.vaultRoot, index: s.index, concurrency: 1 });
		expect(s.index.listIndexedFiles()).toEqual(["race.md"]);

		mockReaddirFilterEntry("race.md");
		// No lstat mock — call-through to real fs returns isFile=true.

		await scanVault({ vaultRoot: s.vaultRoot, index: s.index, concurrency: 1 });
		expect(s.index.listIndexedFiles()).toEqual(["race.md"]);
	});
});

describe("scanVault — N3 watcher-race prune defense", () => {
	test("file on disk + indexed but missing from walkVault enumeration is preserved", async () => {
		// Watcher-vs-scan race: watcher add-event lands in the index between
		// walkVault's enumeration and the prune pass. The file is on disk +
		// indexed but absent from `stillOnDisk`; the stat-check is the only
		// thing keeping its row alive.
		const s = await setup({ "a.md": "# A\n", "race.md": "# Race\n" });
		await scanVault({ vaultRoot: s.vaultRoot, index: s.index, concurrency: 1 });
		expect(s.index.listIndexedFiles().sort()).toEqual(["a.md", "race.md"]);

		// Mock readdir to filter race.md out of the next walk → simulates the
		// scan having missed the watcher-added file. stat(race.md) still
		// succeeds (real fs), so the prune pass preserves the row.
		mockReaddirFilterEntry("race.md");

		await scanVault({ vaultRoot: s.vaultRoot, index: s.index, concurrency: 1 });
		expect(s.index.listIndexedFiles().sort()).toEqual(["a.md", "race.md"]);
	});
});

/**
 * Spy on `index.replaceFile` so a single targeted relpath throws a
 * synthetic SqliteError-shaped error with the given code/message; all
 * other relpaths fall through to the real method. Returns the spy so the
 * caller can `mockRestore()` in `finally`.
 */
function mockReplaceFileThrowFor(
	index: IndexHandle,
	file: string,
	code: string,
	message: string,
): ReturnType<typeof vi.spyOn> {
	const original = index.replaceFile.bind(index);
	const err: Error & { code?: string } = new Error(message);
	err.code = code;
	return vi.spyOn(index, "replaceFile").mockImplementation((args) => {
		if (args.file === file) throw err;
		return original(args);
	});
}

describe("scanVault — SQLITE_BUSY tolerance", () => {
	test("SQLITE_BUSY for un-indexed file → pendingRetry, scan_complete stays false", async () => {
		// SQLite WAL's write lock is database-wide, so a BUSY on our
		// replaceFile may be contention on an unrelated file. When our row
		// is missing, silently skipping would advertise vault-wide search
		// as warm with a hole; routing to pendingRetry blocks finalize
		// until merkle's newFiles set-diff reindexes the missing row.
		const s = await setup({ "a.md": "# A\n\nbody", "b.md": "# B\n\nbody" });
		const replaceFileSpy = mockReplaceFileThrowFor(s.index, "b.md", "SQLITE_BUSY", "database is locked");

		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			const result = await scanVault({ vaultRoot: s.vaultRoot, index: s.index, concurrency: 1 });
			expect(s.index.listIndexedFiles()).toEqual(["a.md"]);
			expect(result.filesIndexed).toBe(1);
			expect(result.filesSkipped).toBe(1);

			expect(s.index.hasPendingRetries()).toBe(true);
			expect(s.index.getScanComplete()).toBe(false);

			const stderr = errSpy.mock.calls.flat().join("\n");
			expect(stderr).toMatch(/SQLITE_BUSY.*deferring to merkle reconcile/);
		} finally {
			errSpy.mockRestore();
			replaceFileSpy.mockRestore();
		}
	});

	test("SQLITE_BUSY where peer committed matching row → silent skip, scan_complete=true", async () => {
		// When the indexed row's (mtime, size) matches on-disk after our
		// BUSY, a peer wrote our file during the wait. PendingRetry-ing
		// here would wedge finalize forever because merkle's drift detector
		// can't trigger reindex on a matching row.
		const s = await setup({ "a.md": "# A\n\nbody", "b.md": "# B\n\nbody" });
		await scanVault({ vaultRoot: s.vaultRoot, index: s.index, concurrency: 1 });
		expect(s.index.listIndexedFiles().sort()).toEqual(["a.md", "b.md"]);
		expect(s.index.getScanComplete()).toBe(true);

		// b.md: scanner's pre-write isFileUnchanged returns false (force
		// the write); indexOne's post-BUSY re-check returns true (silent
		// skip). The `bMdCalls` assertion below pins this ordering so a
		// future refactor that drops the re-check fails loudly.
		const realIsFileUnchanged = s.index.isFileUnchanged.bind(s.index);
		let bMdCalls = 0;
		const isFileUnchangedSpy = vi.spyOn(s.index, "isFileUnchanged").mockImplementation((args) => {
			if (args.file !== "b.md") return realIsFileUnchanged(args);
			bMdCalls++;
			return bMdCalls > 1;
		});
		const replaceFileSpy = mockReplaceFileThrowFor(s.index, "b.md", "SQLITE_BUSY", "database is locked");

		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			await scanVault({ vaultRoot: s.vaultRoot, index: s.index, concurrency: 1 });
			expect(s.index.listIndexedFiles().sort()).toEqual(["a.md", "b.md"]);
			expect(s.index.hasPendingRetries()).toBe(false);
			expect(s.index.getScanComplete()).toBe(true);
			expect(bMdCalls).toBe(2);
		} finally {
			errSpy.mockRestore();
			replaceFileSpy.mockRestore();
			isFileUnchangedSpy.mockRestore();
		}
	});

	test("SQLITE_BUSY_SNAPSHOT routes the same way as SQLITE_BUSY", async () => {
		// WAL surfaces lock contention as SQLITE_BUSY_SNAPSHOT too; both
		// codes must hit the BUSY catch.
		const s = await setup({ "a.md": "# A\n", "b.md": "# B\n" });
		const replaceFileSpy = mockReplaceFileThrowFor(s.index, "b.md", "SQLITE_BUSY_SNAPSHOT", "snapshot busy");

		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			await scanVault({ vaultRoot: s.vaultRoot, index: s.index, concurrency: 1 });
			expect(s.index.hasPendingRetries()).toBe(true);
			expect(s.index.getScanComplete()).toBe(false);
		} finally {
			errSpy.mockRestore();
			replaceFileSpy.mockRestore();
		}
	});

	test("non-BUSY SqliteError still pendingRetries (regression guard)", async () => {
		// Only SQLITE_BUSY{,_SNAPSHOT} routes through the indexOne BUSY
		// catch; other codes (SQLITE_CORRUPT, SQLITE_FULL, …) must reach
		// the worker catch's addPendingRetry path.
		const s = await setup({ "a.md": "# A\n", "b.md": "# B\n" });
		const replaceFileSpy = mockReplaceFileThrowFor(s.index, "b.md", "SQLITE_FULL", "disk full");

		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			await scanVault({ vaultRoot: s.vaultRoot, index: s.index, concurrency: 1 });
			expect(s.index.hasPendingRetries()).toBe(true);
			expect(s.index.getScanComplete()).toBe(false);
		} finally {
			errSpy.mockRestore();
			replaceFileSpy.mockRestore();
		}
	});
});

describe("scanVault — BUSY silent-skip unconditional on (mtime, size) match", () => {
	test("forced rescan + prior row + matching (mtime,size) + BUSY → silent skip (rsync-t residual accepted)", async () => {
		// Routing this scenario to pendingRetry would defend against the
		// rsync-t case, but merkle drift can't repair it (gates on
		// (mtime, size) too), so the scan would wedge until process
		// restart — vault-wide tools stuck at INDEX_WARMING.
		// Unconditional silent-skip accepts the rsync-t residual and
		// defers to `last_body_simhash` (D32 Note).
		const s = await setup({ "a.md": "# A\n\nbody", "b.md": "# B\n\nbody" });
		await scanVault({ vaultRoot: s.vaultRoot, index: s.index, concurrency: 1 });
		expect(s.index.listIndexedFiles().sort()).toEqual(["a.md", "b.md"]);
		expect(s.index.getScanComplete()).toBe(true);

		// Force the next scan to skipUnchanged=false (pre-W4 migration /
		// policy-flip rescan path).
		s.index.setScanComplete(false);

		// Mock isFileUnchanged for b.md to return true unconditionally —
		// emulates the post-BUSY case where disk's (mtime, size) match
		// the indexed row (peer-committed-for-us OR rsync-t residual; we
		// can't distinguish without content-hash detection).
		const realIsFileUnchanged = s.index.isFileUnchanged.bind(s.index);
		const isFileUnchangedSpy = vi.spyOn(s.index, "isFileUnchanged").mockImplementation((args) => {
			if (args.file !== "b.md") return realIsFileUnchanged(args);
			return true;
		});
		const replaceFileSpy = mockReplaceFileThrowFor(s.index, "b.md", "SQLITE_BUSY", "database is locked");

		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			await scanVault({ vaultRoot: s.vaultRoot, index: s.index, concurrency: 1 });
			// b.md silent-skipped → no pendingRetry, scan_complete fires.
			expect(s.index.hasPendingRetries()).toBe(false);
			expect(s.index.getScanComplete()).toBe(true);
		} finally {
			errSpy.mockRestore();
			replaceFileSpy.mockRestore();
			isFileUnchangedSpy.mockRestore();
		}
	});

	test("cold start + no prior row + BUSY + peer-committed matching → silent skip preserved", async () => {
		// Post-BUSY (mtime, size) match on a cold-start file means a
		// peer committed the row → silent skip safe.
		const s = await setup({ "a.md": "# A\n\nbody", "b.md": "# B\n\nbody" });
		expect(s.index.getScanComplete()).toBe(false);
		const realIsFileUnchanged = s.index.isFileUnchanged.bind(s.index);
		const isFileUnchangedSpy = vi.spyOn(s.index, "isFileUnchanged").mockImplementation((args) => {
			if (args.file !== "b.md") return realIsFileUnchanged(args);
			return true;
		});
		const replaceFileSpy = mockReplaceFileThrowFor(s.index, "b.md", "SQLITE_BUSY", "database is locked");

		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			await scanVault({ vaultRoot: s.vaultRoot, index: s.index, concurrency: 1 });
			// b.md treated as "indexed" via silent skip — no pendingRetry,
			// scan_complete advances to true.
			expect(s.index.hasPendingRetries()).toBe(false);
			expect(s.index.getScanComplete()).toBe(true);
		} finally {
			errSpy.mockRestore();
			replaceFileSpy.mockRestore();
			isFileUnchangedSpy.mockRestore();
		}
	});
});
