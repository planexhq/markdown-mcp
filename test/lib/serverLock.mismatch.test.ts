/**
 * Dev/ino mismatch fail-closed contract for `readAndParseWithRetry`.
 *
 * A peer's `acquireOwnSlot` rm+wx during the open window produces a
 * dev/ino mismatch. On slow AV/SMB storage, peer's rotation can outlast
 * a single 25 ms retry: the reprobe sees `"absent"` (rm done, wx
 * pending), and collapsing to `"absent"` would silent-skip via
 * `inspectForeignSlot` → opposite-policy peer shares the SQLite WAL →
 * corruption. The internal `"unparseable_mismatch"` sentinel applies a
 * longer retry budget (4 attempts × 25 ms = 100 ms); critically, an
 * absent reprobe AFTER a mismatch returns `"unparseable"` (not
 * `"absent"`) so the live-peer escalation in `inspectForeignSlot` runs.
 *
 * Win32-gated because the mismatch is only detectable when `preLstat`
 * runs (Win32-only branch in `readAndParse`); POSIX uses `O_NOFOLLOW`
 * natively and never compares inodes.
 */

import type { FileHandle } from "node:fs/promises";
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

import { readAndParseWithRetryForTesting } from "../../src/lib/serverLock.js";
import { makeBigIntStats } from "../helpers/bigintStats.js";
import { isBigIntLstat } from "../helpers/lstatOpts.js";
import { createTempVault } from "../helpers/vault.js";

const ENOENT_LSTAT = Object.assign(new Error("ENOENT: no such file"), { code: "ENOENT" });

const MISMATCH_BIGINT_STATS = makeBigIntStats({ isFile: true, ino: 999999999n, dev: 999999999n });

/**
 * Mutates an open FileHandle's `read` to return zero bytes — simulates
 * a peer's `wx`-write visibility race. `readAndParse` then sees an
 * empty buffer → `parseLockFile("")` returns null → `"unparseable"`.
 * `stat`/`close` stay on the real handle so dev/ino + post-open lstat
 * checks still pass against the on-disk file.
 */
function overrideHandleReadEmpty(handle: FileHandle): void {
	const wrapped = handle as unknown as {
		read: (buf: Buffer) => Promise<{ bytesRead: number; buffer: Buffer }>;
	};
	wrapped.read = async (buf) => ({ bytesRead: 0, buffer: buf });
}

let vault: { path: string; cleanup: () => Promise<void> };
let lockPath: string;

/** preLstat returns `MISMATCH_BIGINT_STATS` on its first bigint call at
 *  `lockPath`, real stats afterwards; no-opts lstats pass through.
 *  Returns a getter for the bigint-call count. */
function mockMismatchOnFirstBigIntLstat(): () => number {
	let preLstatCalls = 0;
	vi.mocked(fsPromises.lstat).mockImplementation((path, opts) => {
		if (path !== lockPath) return realFs.lstat(path, opts as Parameters<typeof realFs.lstat>[1]);
		if (!isBigIntLstat(opts)) return realFs.lstat(path, opts as Parameters<typeof realFs.lstat>[1]);
		preLstatCalls += 1;
		if (preLstatCalls === 1) return Promise.resolve(MISMATCH_BIGINT_STATS);
		return realFs.lstat(path, opts as Parameters<typeof realFs.lstat>[1]);
	});
	return () => preLstatCalls;
}

/** Real `fs.open` everywhere; at `lockPath`, wrap the returned handle's
 *  `read` to return 0 bytes when `predicate(openCallNumber)` is true.
 *  Returns a getter for the `lockPath`-open count. */
function mockOpenWithEmptyReadOn(predicate: (callNumber: number) => boolean): () => number {
	let openCalls = 0;
	vi.mocked(fsPromises.open).mockImplementation(async (path, ...rest) => {
		const handle = await realFs.open(path, ...(rest as Parameters<typeof realFs.open>));
		if (path !== lockPath) return handle;
		openCalls += 1;
		if (predicate(openCalls)) overrideHandleReadEmpty(handle);
		return handle;
	});
	return () => openCalls;
}

/** Real `fs.open` everywhere; at `lockPath`, reject with ENOENT when
 *  `predicate(openCallNumber)` is true (simulates the rm side of a
 *  peer's rm+wx rotation landing between preLstat and open). Returns a
 *  getter for the `lockPath`-open count. */
function mockOpenThrowsEnoentOn(predicate: (callNumber: number) => boolean): () => number {
	let openCalls = 0;
	vi.mocked(fsPromises.open).mockImplementation(async (path, ...rest) => {
		if (path !== lockPath) return realFs.open(path, ...(rest as Parameters<typeof realFs.open>));
		openCalls += 1;
		if (predicate(openCalls)) return Promise.reject(ENOENT_LSTAT);
		return realFs.open(path, ...(rest as Parameters<typeof realFs.open>));
	});
	return () => openCalls;
}

beforeEach(async () => {
	vault = await createTempVault({});
	lockPath = join(vault.path, "server-1234.lock");
	// Real lockfile payload — second-attempt success path needs a parseable record.
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

describe("readAndParseWithRetry — dev/ino mismatch fail-closed", () => {
	test.runIf(process.platform === "win32")(
		"mismatch then reprobe absent → unparseable (fail closed, escalates live-peer)",
		async () => {
			// preLstat returns synthetic mismatched inode → readAndParse returns
			// "unparseable_mismatch". Sleep 25 ms; reprobe via fs.lstat (no opts)
			// returns ENOENT → statEntry "absent". Must return "unparseable" (not
			// "absent") so inspectForeignSlot escalates via the live-peer path
			// rather than silent-skipping into WAL corruption.
			vi.mocked(fsPromises.lstat).mockImplementation((path, opts) => {
				if (path !== lockPath) return realFs.lstat(path, opts as Parameters<typeof realFs.lstat>[1]);
				if (isBigIntLstat(opts)) return Promise.resolve(MISMATCH_BIGINT_STATS);
				return Promise.reject(ENOENT_LSTAT);
			});

			expect(await readAndParseWithRetryForTesting(lockPath, "test")).toBe("unparseable");
		},
	);

	test.runIf(process.platform === "win32")(
		"mismatch then reprobe regular then stable second read → returns record",
		async () => {
			// preLstat is mismatched only on attempt 0; reprobe sees regular,
			// next readAndParse matches handle.stat() and parses cleanly.
			const preLstatCalls = mockMismatchOnFirstBigIntLstat();

			const result = await readAndParseWithRetryForTesting(lockPath, "test");
			expect(typeof result === "object" && result !== null && "includeHidden" in result).toBe(true);
			expect(preLstatCalls()).toBeGreaterThanOrEqual(2);
		},
	);

	test.runIf(process.platform === "win32")(
		"mismatch then content-unparseable then stable read → returns record (independent budgets)",
		async () => {
			// Mixed sequence — content-unparseable budget must not be exhausted
			// by a preceding mismatch; the third attempt's real read parses.
			mockMismatchOnFirstBigIntLstat();
			const openCalls = mockOpenWithEmptyReadOn((n) => n === 2);

			const result = await readAndParseWithRetryForTesting(lockPath, "test");
			expect(typeof result === "object" && result !== null && "includeHidden" in result).toBe(true);
			expect(openCalls()).toBe(3);
		},
	);

	test.runIf(process.platform === "win32")(
		"mismatch then two content-unparseable reads → unparseable (content budget exhausted)",
		async () => {
			// Content budget is 1 retry (2 empty reads → exhausted) regardless
			// of prior mismatches; mismatch budget doesn't extend content.
			mockMismatchOnFirstBigIntLstat();
			const openCalls = mockOpenWithEmptyReadOn((n) => n >= 2);

			expect(await readAndParseWithRetryForTesting(lockPath, "test")).toBe("unparseable");
			expect(openCalls()).toBe(3);
		},
	);

	test.runIf(process.platform === "win32")("persistent mismatch (exhausts retries) → unparseable", async () => {
		// Every preLstat returns mismatched inode → 1 + MAX_MISMATCH_RETRIES
		// attempts all see mismatch → loop exits → returns "unparseable" so
		// inspectForeignSlot's live-peer path escalates to ServerLockUnknownPeerError.
		let preLstatCalls = 0;
		vi.mocked(fsPromises.lstat).mockImplementation((path, opts) => {
			if (path !== lockPath) return realFs.lstat(path, opts as Parameters<typeof realFs.lstat>[1]);
			if (isBigIntLstat(opts)) {
				preLstatCalls += 1;
				return Promise.resolve(MISMATCH_BIGINT_STATS);
			}
			return realFs.lstat(path, opts as Parameters<typeof realFs.lstat>[1]);
		});

		expect(await readAndParseWithRetryForTesting(lockPath, "test")).toBe("unparseable");
		// 1 initial + 4 mismatch retries = 5 attempts
		expect(preLstatCalls).toBe(5);
	});

	test.runIf(process.platform === "win32")(
		"content-unparseable then full mismatch budget → unparseable (truly independent budgets)",
		async () => {
			// One wx-visibility empty read at attempt 0, then five mismatch
			// reads (1 initial + MAX_MISMATCH_RETRIES). If the budgets
			// shared a total-attempts cap, the unparseable would steal a
			// mismatch slot and exhaustion would fire at attempt 4 (5
			// opens). With independent counters, exhaustion fires when
			// `mismatchSeen > 4`, allowing the full mismatch budget after
			// the unparseable → 6 opens.
			let bigIntLstatCalls = 0;
			vi.mocked(fsPromises.lstat).mockImplementation((path, opts) => {
				if (path !== lockPath) return realFs.lstat(path, opts as Parameters<typeof realFs.lstat>[1]);
				if (!isBigIntLstat(opts)) return realFs.lstat(path, opts as Parameters<typeof realFs.lstat>[1]);
				bigIntLstatCalls += 1;
				// Attempt 0 reads cleanly: `readAndParse` issues TWO bigint
				// lstats per clean attempt — the pre-open `preLstat` and the
				// post-open `postLstat` — so both (calls 1-2) must return real
				// stats, else the post-open dev/ino check misfires as a
				// mismatch. Attempts 1-5 mismatch at `preLstat` and return
				// before the post-open lstat → one bigint lstat each (calls 3-7).
				if (bigIntLstatCalls <= 2) return realFs.lstat(path, opts as Parameters<typeof realFs.lstat>[1]);
				return Promise.resolve(MISMATCH_BIGINT_STATS);
			});
			const openCalls = mockOpenWithEmptyReadOn((n) => n === 1);

			expect(await readAndParseWithRetryForTesting(lockPath, "test")).toBe("unparseable");
			expect(openCalls()).toBe(6);
		},
	);

	test.runIf(process.platform === "win32")(
		"open ENOENT after preLstat success → unparseable_mismatch routes to retry (rotation-aware)",
		async () => {
			// preLstat saw the file, then open() throws ENOENT — peer's rm+wx
			// rotation in our lstat→open window. Retry budget must absorb it
			// (silent "absent" would let opposite-policy peer share the WAL).
			const openCalls = mockOpenThrowsEnoentOn((n) => n === 1);

			const result = await readAndParseWithRetryForTesting(lockPath, "test");
			expect(typeof result === "object" && result !== null && "includeHidden" in result).toBe(true);
			expect(openCalls()).toBe(2);
		},
	);

	test.runIf(process.platform === "win32")(
		"persistent open ENOENT after preLstat exhausts mismatch budget → unparseable",
		async () => {
			// Every open() throws ENOENT → "unparseable_mismatch" each
			// iteration. 1 + MAX_MISMATCH_RETRIES (4) attempts before
			// exhaustion. Returning "unparseable" (not "absent") drives the
			// live-peer escalation in inspectForeignSlot.
			const openCalls = mockOpenThrowsEnoentOn(() => true);

			expect(await readAndParseWithRetryForTesting(lockPath, "test")).toBe("unparseable");
			expect(openCalls()).toBe(5);
		},
	);
});
