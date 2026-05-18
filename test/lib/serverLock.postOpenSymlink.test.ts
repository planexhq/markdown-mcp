/**
 * `readAndParse` (in `src/lib/serverLock.ts`) runs a Win32-gated post-open
 * `lstat` AFTER the dev/ino check. The dev/ino check confirms the OPENED
 * handle matches preLstat's inode, but doesn't prove the PATH is still a
 * regular file — a rename-then-symlink-back race during the open window
 * produces a symlink whose target IS the original inode, so libuv (which
 * strips `O_NOFOLLOW` on Win32) follows the link and `handle.stat()`
 * resolves to the target's identity, which matches preLstat. The
 * no-symlink contract would be bypassed.
 *
 * Mirrors `openNoFollow`'s `!leafStat.isSymbolicLink()` + dev/ino-match
 * check: the path's post-open lstat must show a regular file AND its
 * inode/dev must match the opened handle's. Otherwise return
 * `"unparseable_mismatch"` so the existing retry chain handles it;
 * persistent mismatch escalates upstream to `ServerLockUnknownPeerError`
 * for alive PIDs.
 *
 * Win32-gated because the post-open lstat only runs when `process.platform
 * === "win32"`; POSIX is exempt (kernel-honored `O_NOFOLLOW` surfaces ELOOP
 * synchronously at the open).
 */

import type { BigIntStats } from "node:fs";
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

const ENOENT_LSTAT = Object.assign(new Error("ENOENT: no such file"), { code: "ENOENT" });

const SYMLINK_BIGINT_STATS = makeBigIntStats({ isSymbolicLink: true, ino: 0n, dev: 0n });

let vault: { path: string; cleanup: () => Promise<void> };
let lockPath: string;

beforeEach(async () => {
	vault = await createTempVault({});
	lockPath = join(vault.path, "server-1234.lock");
	// Real lockfile payload so the open + handle.stat read real bytes/inode;
	// the only failure injected per test is the post-open lstat.
	await writeFile(
		lockPath,
		`${JSON.stringify({ includeHidden: false, hostname: "test", vaultExtensions: ["md"] })}\n`,
		"utf-8",
	);
	vi.mocked(fsPromises.open).mockImplementation(realFs.open);
	vi.mocked(fsPromises.lstat).mockImplementation(realFs.lstat);
});

afterEach(async () => {
	vi.mocked(fsPromises.open).mockReset();
	vi.mocked(fsPromises.lstat).mockReset();
	await vault.cleanup();
});

/** Pass the first BigInt lstat at `lockPath` through to real FS (so `handle.stat()` matches preLstat); inject `secondCall` on the second. */
function mockSecondBigIntLstat(secondCall: BigIntStats | Error): void {
	let bigintCallCount = 0;
	vi.mocked(fsPromises.lstat).mockImplementation((path, opts) => {
		if (path !== lockPath) return realFs.lstat(path, opts as Parameters<typeof realFs.lstat>[1]);
		if (!isBigIntLstat(opts)) return realFs.lstat(path, opts as Parameters<typeof realFs.lstat>[1]);
		bigintCallCount += 1;
		if (bigintCallCount === 1) return realFs.lstat(path, opts as Parameters<typeof realFs.lstat>[1]);
		return secondCall instanceof Error ? Promise.reject(secondCall) : Promise.resolve(secondCall);
	});
}

describe("readAndParse — Win32 post-open path-stability check", () => {
	test.runIf(process.platform === "win32")(
		"post-open lstat sees symlink (rename-then-symlink-back) → unparseable",
		async () => {
			mockSecondBigIntLstat(SYMLINK_BIGINT_STATS);

			expect(await readAndParseForTesting(lockPath)).toBe("unparseable");
		},
	);

	test.runIf(process.platform === "win32")(
		"post-open lstat sees different regular inode (atomic-replace race) → unparseable",
		async () => {
			// Simulates a peer's rm+wx-recreate landing between handle.stat and the
			// post-open lstat: dev/ino-vs-preLstat passes (handle bound to old inode)
			// but path-vs-handle.stat mismatches.
			const differentInode = makeBigIntStats({ isFile: true, ino: 999999999n, dev: 999999999n });
			mockSecondBigIntLstat(differentInode);

			expect(await readAndParseForTesting(lockPath)).toBe("unparseable");
		},
	);

	test.runIf(process.platform === "win32")(
		"post-open lstat ENOENT (path rotated during read) → unparseable",
		async () => {
			// "unparseable" (not "absent") so inspectForeignSlot's live-peer
			// escalation runs — rotation mid-read is a fail-closed signal.
			mockSecondBigIntLstat(ENOENT_LSTAT);

			expect(await readAndParseForTesting(lockPath)).toBe("unparseable");
		},
	);

	test.runIf(process.platform === "win32")("post-open lstat sees stable regular file → parses record", async () => {
		// Happy-path regression guard: the new check must not reject a stable file.
		const result = await readAndParseForTesting(lockPath);
		expect(typeof result === "object" && result !== null && "includeHidden" in result).toBe(true);
	});

	test.runIf(process.platform !== "win32")("POSIX is exempt — post-open lstat does not run", async () => {
		const result = await readAndParseForTesting(lockPath);
		expect(typeof result === "object" && result !== null && "includeHidden" in result).toBe(true);
	});
});
