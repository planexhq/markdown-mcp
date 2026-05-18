/**
 * Tiebreaker mtime freshness contract for `inspectForeignSlot`.
 *
 * `readForeignRecord`'s retry chain can survive a peer's rm+wx
 * rotation and return a record whose underlying file's mtime differs
 * from the predecessor we initially probed. `weArrivedFirst` must
 * compare our wx-write against the mtime of the file we ACTUALLY
 * parsed, not the stale probe. Cross-platform: the wx-visibility-race
 * retry that exposes the staleness exists on every platform (the
 * dev/ino mismatch retry is Win32-only, but isn't the only path here).
 */

import type { Stats } from "node:fs";
import { mkdir, unlink, utimes, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const realFs = vi.hoisted(() => ({
	lstat: null as unknown as typeof import("node:fs/promises").lstat,
}));

vi.mock("node:fs/promises", async (importActual) => {
	const actual = await importActual<typeof import("node:fs/promises")>();
	realFs.lstat = actual.lstat;
	return {
		...actual,
		lstat: vi.fn(actual.lstat),
	};
});

import * as fsPromises from "node:fs/promises";

import {
	acquireServerLock,
	lockFileNameForPid,
	ServerLockConflictError,
	ServerLockUnknownPeerError,
} from "../../src/lib/serverLock.js";
import { findDeadPid } from "../helpers/findDeadPid.js";
import { indexDir, ownLockPath } from "../helpers/indexDir.js";
import { isBigIntLstat } from "../helpers/lstatOpts.js";
import { createTempVault } from "../helpers/vault.js";

const ENOENT_LSTAT = Object.assign(new Error("ENOENT: no such file"), { code: "ENOENT" });

/** Clone a real `Stats` with selected fields overridden; preserves
 *  prototype methods (`isFile`/etc) via `Object.create`. */
function withOverride(real: Stats, overrides: Partial<Pick<Stats, "mtimeMs" | "isFile">>): Stats {
	const wrapped = Object.create(Object.getPrototypeOf(real), Object.getOwnPropertyDescriptors(real)) as Stats;
	Object.assign(wrapped, overrides);
	return wrapped;
}

let vault: { path: string; cleanup: () => Promise<void> };
let foreignPath: string;

/**
 * Mock `fs.lstat` so the SECOND no-opts call at `foreignPath` produces
 * `secondCall(realStats)` (or rejects with an Error). First call and
 * any bigint calls pass through to real-FS. Returns a getter for the
 * no-opts-call count.
 */
function mockSecondForeignNoOptsLstat(secondCall: (real: Stats) => Stats | Error): () => number {
	let calls = 0;
	vi.mocked(fsPromises.lstat).mockImplementation(async (path, opts) => {
		if (path !== foreignPath) return realFs.lstat(path, opts as Parameters<typeof realFs.lstat>[1]);
		if (isBigIntLstat(opts)) return realFs.lstat(path, opts as Parameters<typeof realFs.lstat>[1]);
		calls += 1;
		const real = await realFs.lstat(path, opts as Parameters<typeof realFs.lstat>[1]);
		if (calls === 1) return real;
		const result = secondCall(real);
		if (result instanceof Error) return Promise.reject(result);
		return result;
	});
	return () => calls;
}

/**
 * Write a foreign lockfile at `<indexPath>/server-<pid>.lock` with
 * opposite-policy contents (includeHidden: true) and a backdated mtime,
 * so the tiebreaker would tip against us without the re-stat fix.
 */
async function writeBackdatedForeignLockfile(
	indexPath: string,
	pid: number,
	overrides: { hostname?: string } = {},
): Promise<string> {
	const path = join(indexPath, lockFileNameForPid(pid));
	await writeFile(
		path,
		`${JSON.stringify({ includeHidden: true, hostname: overrides.hostname ?? hostname(), vaultExtensions: ["md"] })}\n`,
	);
	const oldMtime = new Date(Date.now() - 60_000);
	await utimes(path, oldMtime, oldMtime);
	return path;
}

beforeEach(async () => {
	vault = await createTempVault({});
	const indexPath = indexDir(vault.path);
	await mkdir(indexPath, { recursive: true });
	foreignPath = await writeBackdatedForeignLockfile(indexPath, process.ppid);
	vi.mocked(fsPromises.lstat).mockImplementation(realFs.lstat);
});

afterEach(async () => {
	vi.mocked(fsPromises.lstat).mockReset();
	await unlink(foreignPath).catch(() => {});
	await vault.cleanup();
});

describe("inspectForeignSlot — tiebreaker freshness", () => {
	test("fresh mtime newer than ours → we win, no throw", async () => {
		const freshMtimeMs = Date.now() + 60_000;
		const calls = mockSecondForeignNoOptsLstat((real) => withOverride(real, { mtimeMs: freshMtimeMs }));

		const handle = await acquireServerLock({ indexDir: indexDir(vault.path), includeHidden: false });
		try {
			expect(calls()).toBe(2);
		} finally {
			await handle.release();
		}
	});

	test("foreign vanished after parsed record, persistent absent + alive PID → throws ServerLockUnknownPeerError", async () => {
		// Mock fires on every no-opts lstat call after the initial probe →
		// freshProbe + all 4 rotation retries see ENOENT. Persistent absent
		// with an alive PID (process.ppid is alive in vitest) fails closed
		// via `escalateUnparseableForeign` — silent return would let a
		// slow-rotation opposite-policy peer share the WAL once its wx
		// finally completes. Call count 6 = initial probe + freshProbe +
		// MAX_MISMATCH_RETRIES (4) loop iterations.
		const calls = mockSecondForeignNoOptsLstat(() => ENOENT_LSTAT);

		await expect(acquireServerLock({ indexDir: indexDir(vault.path), includeHidden: false })).rejects.toBeInstanceOf(
			ServerLockUnknownPeerError,
		);
		expect(calls()).toBe(6);
		// Our own slot was rolled back by acquireServerLock's catch path.
		await expect(fsPromises.lstat(ownLockPath(vault.path, process.pid))).rejects.toMatchObject({ code: "ENOENT" });
	});

	test("foreign vanished after parsed record + dead PID → fast-path silent return (skips rotation loop)", async () => {
		// Fast-path short-circuits before the 100 ms loop → 2 lstats
		// (initial probe + freshProbe), not 6.
		await unlink(foreignPath);
		foreignPath = await writeBackdatedForeignLockfile(indexDir(vault.path), findDeadPid());
		const calls = mockSecondForeignNoOptsLstat(() => ENOENT_LSTAT);

		const handle = await acquireServerLock({ indexDir: indexDir(vault.path), includeHidden: false });
		try {
			expect(calls()).toBe(2);
			await expect(fsPromises.lstat(ownLockPath(vault.path, process.pid))).resolves.toBeTruthy();
		} finally {
			await handle.release();
		}
	});

	test("foreign non-regular swap after successful parse → ServerLockUnknownPeerError (fail-closed)", async () => {
		// Round-33's "initial non-regular probe → skip silently" applies before
		// any parse. POST-parse, we already have evidence of a live peer with
		// a specific policy; a swap to directory/symlink (hostile vault, AV
		// scanner) loses that signal. Silent return would let an opposite-
		// policy peer share the WAL — mirror round-43's `acquireOwnSlot`
		// re-stat-before-rm fail-closed semantic for the foreign-slot path.
		const calls = mockSecondForeignNoOptsLstat((real) => withOverride(real, { isFile: () => false }));

		await expect(acquireServerLock({ indexDir: indexDir(vault.path), includeHidden: false })).rejects.toBeInstanceOf(
			ServerLockUnknownPeerError,
		);
		expect(calls()).toBe(2);
		// Our own slot was rolled back by acquireServerLock's catch path.
		await expect(fsPromises.lstat(ownLockPath(vault.path, process.pid))).rejects.toMatchObject({ code: "ENOENT" });
	});

	test("foreign absent at re-stat then regular after retry → re-read picks up rotated record", async () => {
		// Without the retry, an absent freshProbe would silently skip the
		// slot — a recycling peer mid rm→wx could share the WAL undetected.
		// Mock returns ENOENT once then real Stats; backdated foreign mtime
		// loses the tiebreaker → ServerLockConflictError thrown.
		// Call count 4 = initial probe + freshProbe (ENOENT) + retry-loop
		// iter 1 (regular) + post-reread refresh.
		let secondCallInvocations = 0;
		const calls = mockSecondForeignNoOptsLstat((real) => {
			secondCallInvocations += 1;
			return secondCallInvocations === 1 ? ENOENT_LSTAT : real;
		});

		await expect(acquireServerLock({ indexDir: indexDir(vault.path), includeHidden: false })).rejects.toBeInstanceOf(
			ServerLockConflictError,
		);
		expect(calls()).toBe(4);
	});

	test("rotation during reread → freshProbe refreshed → tiebreaker uses post-reread mtime", async () => {
		// Round-50 restats AFTER the initial readForeignRecord. The
		// absent-branch reread had the symmetric hole: readAndParseWithRetry
		// can sleep across yet another rotation, so the parsed record's
		// file may have a different mtime than the pre-reread freshProbe.
		// The new post-reread refresh closes the window.
		//
		// Mock sequence (no-opts lstats at foreignPath):
		//   1: initial probe → real backdated.
		//   2: freshProbe at line 620 → absent (enters absent branch).
		//   3: retry-loop iter 1 → regular with MAX_SAFE_INTEGER mtime
		//      (would let us win the tiebreaker if this were final).
		//   4: post-reread refresh (NEW) → regular with 0 mtime (older
		//      than our wx → tiebreaker says they arrived first → throw).
		// Without the refresh, freshProbe would still hold the MAX_SAFE
		// mtime and acquireServerLock would silently win.
		let calls = 0;
		vi.mocked(fsPromises.lstat).mockImplementation(async (path, opts) => {
			if (path !== foreignPath) return realFs.lstat(path, opts as Parameters<typeof realFs.lstat>[1]);
			if (isBigIntLstat(opts)) return realFs.lstat(path, opts as Parameters<typeof realFs.lstat>[1]);
			calls += 1;
			const real = await realFs.lstat(path, opts as Parameters<typeof realFs.lstat>[1]);
			if (calls === 1) return real;
			if (calls === 2) return Promise.reject(ENOENT_LSTAT);
			if (calls === 3) return withOverride(real, { mtimeMs: Number.MAX_SAFE_INTEGER });
			return withOverride(real, { mtimeMs: 0 });
		});

		await expect(acquireServerLock({ indexDir: indexDir(vault.path), includeHidden: false })).rejects.toBeInstanceOf(
			ServerLockConflictError,
		);
		expect(calls).toBe(4);
	});

	test("foreign-host lockfile vanished during rotation → log + silent return (hostname before fast-path)", async () => {
		// Round-32's "hostname check precedes PID-liveness" rule: a foreign-
		// host server's PID is normally ESRCH locally on shared NFS/SMB,
		// so the absent-branch dead-PID fast-path would silently absorb a
		// foreign-host rotation and lose the cross-host operator log. The
		// fix consults `otherRecord.hostname` before the `isProcessAlive`
		// short-circuit.
		//
		// Mock: 1 = real backdated (parsed by readForeignRecord); 2 = absent
		// (freshProbe lands in B's rm→wx gap). Foreign hostname triggers
		// the new log + return path. Call count 2 = initial probe +
		// freshProbe; no retry loop, no reread.
		await unlink(foreignPath);
		const indexPath = indexDir(vault.path);
		foreignPath = await writeBackdatedForeignLockfile(indexPath, process.ppid, { hostname: "alien-host" });

		const calls = mockSecondForeignNoOptsLstat(() => ENOENT_LSTAT);
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		const handle = await acquireServerLock({ indexDir: indexPath, includeHidden: false });
		try {
			expect(calls()).toBe(2);
			expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("foreign-host lockfile"));
			expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("vanished during rotation"));
			expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("hostname=alien-host"));
		} finally {
			errorSpy.mockRestore();
			await handle.release();
		}
	});

	test("post-reread freshProbe absent + alive PID → throws ServerLockUnknownPeerError", async () => {
		// Triple-rotation: reread parses a live peer's record, then the
		// refresh stat sees ENOENT — must fail closed, otherwise the
		// silent skip lets an opposite-policy peer share the WAL.
		//
		// Mock sequence (no-opts lstats at foreignPath):
		//   1: initial probe → real backdated (parsed by readForeignRecord).
		//   2: freshProbe at line 632 → ENOENT (enters absent branch).
		//   3: rotation retry-loop iter 1 → real (rotation completed).
		//   4: post-reread refresh → ENOENT.
		let calls = 0;
		vi.mocked(fsPromises.lstat).mockImplementation(async (path, opts) => {
			if (path !== foreignPath) return realFs.lstat(path, opts as Parameters<typeof realFs.lstat>[1]);
			if (isBigIntLstat(opts)) return realFs.lstat(path, opts as Parameters<typeof realFs.lstat>[1]);
			calls += 1;
			const real = await realFs.lstat(path, opts as Parameters<typeof realFs.lstat>[1]);
			if (calls === 1) return real;
			if (calls === 2) return Promise.reject(ENOENT_LSTAT);
			if (calls === 3) return real;
			return Promise.reject(ENOENT_LSTAT);
		});

		await expect(acquireServerLock({ indexDir: indexDir(vault.path), includeHidden: false })).rejects.toBeInstanceOf(
			ServerLockUnknownPeerError,
		);
		expect(calls).toBe(4);
		await expect(fsPromises.lstat(ownLockPath(vault.path, process.pid))).rejects.toMatchObject({ code: "ENOENT" });
	});
});
