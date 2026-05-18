/**
 * `readAndParse` (in `src/lib/serverLock.ts`) catches `open()` errors and
 * disambiguates ambiguous errno (EISDIR/EACCES) via a post-error `lstat`
 * to distinguish a real swap (skip → `"absent"`) from a genuine perm
 * denial on a regular file (fail-closed → `throw err`).
 * The catch also gates on lstat's own errno: ENOENT/ENOTDIR → `"absent"`
 * (file genuinely vanished), every other lstat failure → fail-closed.
 *
 * The dev/ino mismatch check between `preLstat` (Win32-only) and
 * `handle.stat()` returns `"unparseable"` so the existing retry/escalation
 * chain (`readAndParseWithRetry` → `inspectForeignSlot`) handles both the
 * legitimate-recreate case (peer's `acquireOwnSlot` rm+wx) and the
 * hostile-swap case (persistent mismatch → `ServerLockUnknownPeerError`).
 *
 * These tests mock `fs.promises.open` and `fs.promises.lstat` to inject
 * the relevant errno / Stats patterns; the serverLock.test.ts file uses
 * real-FS exclusively, so a separate file keeps the mock-injection scope
 * tight (every real-FS test in serverLock.test.ts would otherwise need
 * to `mockImplementation(realFs.X)` in its own `beforeEach`).
 */

import type { BigIntStats, Stats } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const realFs = vi.hoisted(() => ({
	open: null as unknown as typeof import("node:fs/promises").open,
	lstat: null as unknown as typeof import("node:fs/promises").lstat,
}));

vi.mock("node:fs/promises", async (importActual) => {
	const actual = await importActual<typeof import("node:fs/promises")>();
	realFs.open = actual.open;
	realFs.lstat = actual.lstat;
	return {
		...actual,
		open: vi.fn(actual.open),
		lstat: vi.fn(actual.lstat),
	};
});

import * as fsPromises from "node:fs/promises";

import { readAndParseForTesting } from "../../src/lib/serverLock.js";
import { makeBigIntStats } from "../helpers/bigintStats.js";
import { isBigIntLstat } from "../helpers/lstatOpts.js";
import { createTempVault } from "../helpers/vault.js";

const EACCES_OPEN = Object.assign(new Error("EACCES: permission denied, open"), { code: "EACCES" });
const EACCES_LSTAT = Object.assign(new Error("EACCES: permission denied, lstat"), { code: "EACCES" });
const ENOENT_LSTAT = Object.assign(new Error("ENOENT: no such file"), { code: "ENOENT" });

const DEFAULT_PRELSTAT_BIGINT = makeBigIntStats({ isFile: true });

const NON_REGULAR_STATS = {
	isFile: () => false,
	isSymbolicLink: () => false,
} as unknown as Stats;

let vault: { path: string; cleanup: () => Promise<void> };
let lockPath: string;

/**
 * Path-discriminated lstat mock. Off-leaf paths pass through to real impl
 * so validatePath-style segment walks aren't disturbed. At `lockPath`,
 * `bigint:true` calls (the Win32 preLstat) return `args.bigint` or the
 * default regular-file Stats; bare calls (post-error disambiguation)
 * resolve with `args.plain` (or reject if it's an Error). `plain` absent
 * passes through too — the dev/ino mismatch test never reaches the
 * disambiguation lstat because `open()` succeeds.
 */
function mockLeafLstat(args: { bigint?: BigIntStats; plain?: Stats | Error }): void {
	const bigintValue = args.bigint ?? DEFAULT_PRELSTAT_BIGINT;
	vi.mocked(fsPromises.lstat).mockImplementation((path, opts) => {
		if (path !== lockPath) return realFs.lstat(path, opts as Parameters<typeof realFs.lstat>[1]);
		if (isBigIntLstat(opts)) return Promise.resolve(bigintValue);
		if (args.plain === undefined) return realFs.lstat(path, opts as Parameters<typeof realFs.lstat>[1]);
		return args.plain instanceof Error ? Promise.reject(args.plain) : Promise.resolve(args.plain);
	});
}

beforeEach(async () => {
	vault = await createTempVault({});
	lockPath = join(vault.path, "server-1234.lock");
	// Content irrelevant: 3 tests mock fs.open (file never read); the
	// dev/ino test reads handle.stat() inode/dev only, never the bytes.
	await writeFile(lockPath, "", "utf-8");
	vi.mocked(fsPromises.open).mockImplementation(realFs.open);
	vi.mocked(fsPromises.lstat).mockImplementation(realFs.lstat);
});

afterEach(async () => {
	vi.mocked(fsPromises.open).mockReset();
	vi.mocked(fsPromises.lstat).mockReset();
	await vault.cleanup();
});

describe("readAndParse — post-error lstat disambiguation", () => {
	test("EACCES from fs.open() + EACCES from fs.lstat() → throws (fail-closed for unverifiable peer)", async () => {
		// Realistic shared-cause case: ACL deny or share-lock denies BOTH
		// open AND the follow-up lstat. Fail-closed contract: refuse to
		// coexist with a peer whose policy we can't verify.
		vi.mocked(fsPromises.open).mockRejectedValueOnce(EACCES_OPEN);
		mockLeafLstat({ plain: EACCES_LSTAT });

		await expect(readAndParseForTesting(lockPath)).rejects.toMatchObject({ code: "EACCES" });
	});

	test("EACCES from fs.open() + non-regular from fs.lstat() → returns absent (real swap)", async () => {
		// Win32 libuv junction/dir-symlink quirk: open() emits EACCES on a
		// non-regular target. Post-error lstat reveals the non-regular file
		// → skip the slot (matches the pre-open preLstat `isFile()` skip
		// behavior on Win32).
		vi.mocked(fsPromises.open).mockRejectedValueOnce(EACCES_OPEN);
		mockLeafLstat({ plain: NON_REGULAR_STATS });

		expect(await readAndParseForTesting(lockPath)).toBe("absent");
	});

	test("EACCES from fs.open() + ENOENT from fs.lstat() → returns absent (file genuinely vanished)", async () => {
		// Race between open(EACCES) and lstat: file unlinked between the
		// two calls. ENOENT from lstat is unambiguous evidence of vanish.
		vi.mocked(fsPromises.open).mockRejectedValueOnce(EACCES_OPEN);
		mockLeafLstat({ plain: ENOENT_LSTAT });

		expect(await readAndParseForTesting(lockPath)).toBe("absent");
	});
});

describe("readAndParse — dev/ino mismatch", () => {
	test.runIf(process.platform === "win32")(
		"dev/ino mismatch between preLstat and handle.stat() → returns unparseable (triggers retry)",
		async () => {
			// On Win32, `acquireOwnSlot` legitimately rm+wx-recreates a stale
			// PID-reused slot. Our `readAndParse` may lstat the old inode
			// (preLstat) and open the new inode — dev/ino mismatch. Pre-fix,
			// this returned "absent" → silently missed live peer → opposite-
			// policy WAL corruption. Post-fix, returns "unparseable" so the
			// existing retry chain (readAndParseWithRetry) handles it: second
			// attempt sees the stable inode and parses cleanly; persistent
			// mismatch escalates upstream to ServerLockUnknownPeerError.
			mockLeafLstat({
				bigint: makeBigIntStats({ isFile: true, ino: 999999999n, dev: 999999999n }),
			});
			// fs.open uses real impl; handle.stat() returns the real on-disk
			// inode (definitely not 999999999n) → mismatch detected.

			expect(await readAndParseForTesting(lockPath)).toBe("unparseable");
		},
	);
});
