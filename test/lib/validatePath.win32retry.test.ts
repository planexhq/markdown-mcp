/**
 * `openNoFollow`'s Win32 branch: pre-open lstat closes the hang vector
 * for symlink leaves (libuv silently strips O_NOFOLLOW in `fs__open`,
 * so an open against a leaf-symlink would follow the link before the
 * post-open identity check fires); open-call vanish-retry recovers
 * from unlink-then-rename safe-saves while the final-attempt failure
 * propagates so truly-gone files still route through PATH_NOT_FOUND →
 * prune.
 *
 * Tests mock `fs.promises.open` and `fs.promises.lstat` to inject the
 * relevant errno / Stats patterns; isolated to a dedicated file so the
 * `validatePath.test.ts` real-FS tests don't need explicit `realFs.X`
 * pass-through in every `beforeEach`.
 */

import type { Stats } from "node:fs";
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

import { openNoFollow, validatePath, validateVaultRoot } from "../../src/lib/validatePath.js";
import { isBigIntLstat } from "../helpers/lstatOpts.js";
import { createTempVault } from "../helpers/vault.js";

let vault: { path: string; cleanup: () => Promise<void> };
let vaultRoot: { absolute: string };

beforeEach(async () => {
	vault = await createTempVault({});
	vaultRoot = await validateVaultRoot(vault.path);
	vi.mocked(fsPromises.open).mockImplementation(realFs.open);
	vi.mocked(fsPromises.lstat).mockImplementation(realFs.lstat);
});

afterEach(async () => {
	vi.mocked(fsPromises.open).mockReset();
	vi.mocked(fsPromises.lstat).mockReset();
	await vault.cleanup();
});

describe("openNoFollow — Win32 pre-open lstat + open vanish-retry", () => {
	test.runIf(process.platform === "win32")(
		"pre-open lstat sees symlink → throws SYMLINK_SEGMENT without invoking open()",
		async () => {
			// validatePath was already run successfully; between it and openNoFollow
			// the leaf was swapped to a symlink. Pre-open lstat must catch it before
			// libuv (which strips O_NOFOLLOW) opens the symlink target — a slow UNC
			// target would otherwise hang the server.
			await writeFile(join(vault.path, "note.md"), "# heading\n", "utf-8");
			const safe = await validatePath("note.md", vaultRoot);

			// Path-discriminated mocks: only the leaf's BigInt-mode lstat (the new
			// pre-open call) returns the synthetic symlink; segment-walk lstat from
			// validatePath has already run via beforeEach's pass-through and won't
			// re-execute here.
			vi.mocked(fsPromises.lstat).mockImplementation((path, opts) => {
				if (path === safe.absolute && isBigIntLstat(opts)) {
					return Promise.resolve({ isSymbolicLink: () => true } as unknown as Stats);
				}
				return realFs.lstat(path, opts as Parameters<typeof realFs.lstat>[1]);
			});

			await expect(openNoFollow(safe.absolute)).rejects.toMatchObject({
				payload: { code: "PATH_OUTSIDE_VAULT", reason: "SYMLINK_SEGMENT" },
			});
			// Hang-vector closure: open() must NOT have been called.
			expect(vi.mocked(fsPromises.open)).not.toHaveBeenCalled();
		},
	);

	test.runIf(process.platform === "win32")(
		"open() ENOENT once, then succeeds → returns handle (transient safe-save recovery)",
		async () => {
			// Cross-platform editor on Win32 doing unlink-then-rename: first open()
			// lands during the brief ENOENT window between unlink and rename. New
			// vanish-retry continues to the next iteration; second open() sees the
			// settled file and returns the handle.
			await writeFile(join(vault.path, "note.md"), "# heading\n", "utf-8");
			const safe = await validatePath("note.md", vaultRoot);

			const enoent = Object.assign(new Error("ENOENT: no such file or directory, open"), {
				code: "ENOENT",
			});
			let callCount = 0;
			vi.mocked(fsPromises.open).mockImplementation((path, flags) => {
				callCount += 1;
				if (callCount === 1) return Promise.reject(enoent);
				return realFs.open(path, flags as Parameters<typeof realFs.open>[1]);
			});

			const fh = await openNoFollow(safe.absolute);
			try {
				expect((await fh.stat()).isFile()).toBe(true);
			} finally {
				await fh.close();
			}
		},
	);

	test.runIf(process.platform === "win32")(
		"open() ENOENT persistently → throws ENOENT after exhausting retries (final-attempt propagates)",
		async () => {
			// Truly-vanished file: every retry's open() returns ENOENT. The
			// final-attempt gate must propagate the original ENOENT so readNote
			// converts to PATH_NOT_FOUND → scanner vanished → prune. Without the
			// gate, the bounded-retry loop falls through to the generic
			// "could not be opened without unresolved swap" SYMLINK_SEGMENT throw
			// which would route to parse_failed → preserve a row for a gone file.
			await writeFile(join(vault.path, "note.md"), "# heading\n", "utf-8");
			const safe = await validatePath("note.md", vaultRoot);

			const enoent = Object.assign(new Error("ENOENT: no such file or directory, open"), {
				code: "ENOENT",
			});
			vi.mocked(fsPromises.open).mockRejectedValue(enoent);

			await expect(openNoFollow(safe.absolute)).rejects.toMatchObject({ code: "ENOENT" });
		},
	);

	test.runIf(process.platform === "win32")(
		"vanish-retry sleeps between attempts (backoff covers AV/SMB safe-save rename windows)",
		async () => {
			// Back-to-back retries with a microsecond budget underestimate
			// AV/SMB unlink-then-rename latencies; a 25 ms sleep between
			// vanish attempts gives the rename a real chance to land
			// before propagating ENOENT. Assert >= 15 ms elapsed between
			// calls (25 ms target with generous CI tolerance).
			await writeFile(join(vault.path, "note.md"), "# heading\n", "utf-8");
			const safe = await validatePath("note.md", vaultRoot);

			const enoent = Object.assign(new Error("ENOENT: no such file or directory, open"), {
				code: "ENOENT",
			});
			const callTimes: number[] = [];
			vi.mocked(fsPromises.open).mockImplementation((path, flags) => {
				callTimes.push(Date.now());
				if (callTimes.length === 1) return Promise.reject(enoent);
				return realFs.open(path, flags as Parameters<typeof realFs.open>[1]);
			});

			const fh = await openNoFollow(safe.absolute);
			try {
				expect(callTimes.length).toBe(2);
				expect(callTimes[1] - callTimes[0]).toBeGreaterThanOrEqual(15);
			} finally {
				await fh.close();
			}
		},
	);
});
