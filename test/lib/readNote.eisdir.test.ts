/**
 * Windows `fs.open(O_RDONLY)` on a directory throws `EISDIR` BEFORE returning a
 * handle, so the post-open `fh.stat().isFile()` check in `readSource` never
 * runs. POSIX `open(O_RDONLY)` on a directory succeeds and the existing
 * post-open check catches it as "not a regular file". `readNote.ts`'s
 * open-catch translates `EISDIR` to `PATH_NOT_FOUND` for cross-platform parity.
 *
 * This file mocks `fs.promises.open` to inject a synthetic `EISDIR` error so
 * POSIX CI can verify the translation branch directly (the natural POSIX
 * `open(directory)` path doesn't reach the `EISDIR` translation — it's caught
 * earlier by the post-open `isFile()` check in `readSource`). The first test
 * below is POSIX-only: on Win32 the EISDIR disambiguation branch runs a
 * post-error lstat that sees the real (regular) file on disk and rethrows the
 * original EISDIR rather than routing to PATH_NOT_FOUND. The dedicated
 * Win32-gated tests further down cover the disambiguation cases (symlink,
 * regular, inconclusive lstat).
 *
 * The natural directory-swap path is covered by `readNote.test.ts`'s
 * "directory path → PathValidationError PATH_NOT_FOUND" test.
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

import { readNote } from "../../src/lib/readNote.js";
import { validatePath, validateVaultRoot } from "../../src/lib/validatePath.js";
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

describe("readSource open-catch — non-regular open errno translation (Windows-swap parity)", () => {
	test.runIf(process.platform !== "win32")(
		"EISDIR from fs.open() on POSIX → PathValidationError(PATH_NOT_FOUND)",
		async () => {
			// Real file on disk + mocked EISDIR simulates a Windows dir-swap.
			// POSIX-only: Win32 EISDIR with a regular post-error lstat rethrows
			// the original EISDIR (preserves rows); the disambiguation cases
			// are covered by the Win32-gated tests below.
			await writeFile(join(vault.path, "swapped.md"), "# heading\n", "utf-8");
			const safe = await validatePath("swapped.md", vaultRoot);

			const eisdir = Object.assign(new Error("EISDIR: illegal operation on a directory, open"), {
				code: "EISDIR",
			});
			vi.mocked(fsPromises.open).mockRejectedValueOnce(eisdir);

			await expect(readNote(safe)).rejects.toMatchObject({
				payload: {
					code: "PATH_NOT_FOUND",
					param: "file",
					message: expect.stringContaining("not a regular file"),
				},
			});
		},
	);

	test.runIf(process.platform === "win32")(
		"EISDIR from fs.open() on Win32 with symlink post-lstat → PathValidationError(SYMLINK_SEGMENT)",
		async () => {
			// Win32 dir-symlink/junction swap surfaces as EISDIR (libuv quirk —
			// see readNote.ts). Post-error lstat reveals the symlink → must
			// route SYMLINK_SEGMENT (preserves rows) rather than PATH_NOT_FOUND.
			await writeFile(join(vault.path, "swapped.md"), "# heading\n", "utf-8");
			const safe = await validatePath("swapped.md", vaultRoot);

			const eisdir = Object.assign(new Error("EISDIR: illegal operation on a directory, open"), {
				code: "EISDIR",
			});
			vi.mocked(fsPromises.open).mockRejectedValueOnce(eisdir);
			vi.mocked(fsPromises.lstat).mockImplementation((path, opts) => {
				if (path === safe.absolute && !isBigIntLstat(opts)) {
					return Promise.resolve({ isFile: () => false, isSymbolicLink: () => true } as unknown as Stats);
				}
				return realFs.lstat(path, opts as Parameters<typeof realFs.lstat>[1]);
			});

			await expect(readNote(safe)).rejects.toMatchObject({
				payload: {
					code: "PATH_OUTSIDE_VAULT",
					param: "file",
					reason: "SYMLINK_SEGMENT",
					message: expect.stringContaining("symlink"),
				},
			});
		},
	);

	test.runIf(process.platform === "win32")(
		"EISDIR from fs.open() on Win32 with regular post-lstat → propagates cause (preserves rows)",
		async () => {
			// Unusual race-back-to-regular: open() saw EISDIR (e.g. a transient
			// dir-symlink swap) but post-error lstat now shows a regular file.
			// Propagate the original EISDIR so scanner's parse_failed preserves
			// rows rather than the disambiguation falling through to the POSIX
			// EISDIR check and routing to PATH_NOT_FOUND.
			await writeFile(join(vault.path, "raced.md"), "# heading\n", "utf-8");
			const safe = await validatePath("raced.md", vaultRoot);

			const eisdir = Object.assign(new Error("EISDIR: illegal operation on a directory, open"), {
				code: "EISDIR",
			});
			vi.mocked(fsPromises.open).mockRejectedValueOnce(eisdir);
			// Default beforeEach impl passes through to realFs.lstat, which
			// returns regular Stats for the on-disk file.

			await expect(readNote(safe)).rejects.toMatchObject({ code: "EISDIR" });
		},
	);

	test.runIf(process.platform === "win32")(
		"EISDIR from fs.open() + EACCES from fs.lstat() on Win32 → propagates cause (preserves rows)",
		async () => {
			// Inconclusive lstat (e.g. ACL deny on the leaf so neither open nor
			// lstat can classify it) — propagate the original EISDIR so scanner's
			// parse_failed preserves rows for a still-existing file.
			await writeFile(join(vault.path, "denied.md"), "# heading\n", "utf-8");
			const safe = await validatePath("denied.md", vaultRoot);

			const eisdirOpen = Object.assign(new Error("EISDIR: illegal operation on a directory, open"), {
				code: "EISDIR",
			});
			const eaccesLstat = Object.assign(new Error("EACCES: permission denied, lstat"), {
				code: "EACCES",
			});
			vi.mocked(fsPromises.open).mockRejectedValueOnce(eisdirOpen);
			vi.mocked(fsPromises.lstat).mockImplementation((path, opts) => {
				if (path === safe.absolute && !isBigIntLstat(opts)) return Promise.reject(eaccesLstat);
				return realFs.lstat(path, opts as Parameters<typeof realFs.lstat>[1]);
			});

			await expect(readNote(safe)).rejects.toMatchObject({ code: "EISDIR" });
		},
	);

	test.runIf(process.platform === "win32")(
		"EACCES from fs.open() on Win32 with non-regular post-lstat → PathValidationError(PATH_NOT_FOUND)",
		async () => {
			await writeFile(join(vault.path, "swapped.md"), "# heading\n", "utf-8");
			const safe = await validatePath("swapped.md", vaultRoot);

			const eacces = Object.assign(new Error("EACCES: permission denied, open"), {
				code: "EACCES",
			});
			vi.mocked(fsPromises.open).mockRejectedValueOnce(eacces);
			// Path-discriminated so validatePath's segment-walk lstats still
			// pass through to real impl; only the disambiguation call for the
			// leaf returns synthetic non-regular stats. BigInt calls (the new
			// openNoFollow pre-open + post-open identity checks) also pass
			// through so they see the real regular file.
			vi.mocked(fsPromises.lstat).mockImplementation((path, opts) => {
				if (path === safe.absolute && !isBigIntLstat(opts)) {
					return Promise.resolve({ isFile: () => false, isSymbolicLink: () => false } as unknown as Stats);
				}
				return realFs.lstat(path, opts as Parameters<typeof realFs.lstat>[1]);
			});

			await expect(readNote(safe)).rejects.toMatchObject({
				payload: {
					code: "PATH_NOT_FOUND",
					param: "file",
					message: expect.stringContaining("not a regular file"),
				},
			});
		},
	);

	test.runIf(process.platform === "win32")(
		"EACCES from fs.open() on Win32 with regular post-lstat → propagates cause (preserves rows)",
		async () => {
			await writeFile(join(vault.path, "perm-denied.md"), "# heading\n", "utf-8");
			const safe = await validatePath("perm-denied.md", vaultRoot);

			const eacces = Object.assign(new Error("EACCES: permission denied, open"), {
				code: "EACCES",
			});
			vi.mocked(fsPromises.open).mockRejectedValueOnce(eacces);
			// Default beforeEach impl passes through to realFs.lstat, which
			// returns a regular Stats for the on-disk file → simulates the
			// ACL-denied / share-locked-regular case.

			await expect(readNote(safe)).rejects.toMatchObject({ code: "EACCES" });
		},
	);

	test.runIf(process.platform === "win32")(
		"EACCES from fs.open() on Win32 with symlink post-lstat → PathValidationError(SYMLINK_SEGMENT)",
		async () => {
			// Win32 libuv junction/dir-symlink quirk emits EACCES at open();
			// post-error lstat reveals the symlink. Must mirror POSIX ELOOP
			// routing (SYMLINK_SEGMENT preserves rows via scanner parse_failed)
			// rather than PATH_NOT_FOUND (which would prune).
			await writeFile(join(vault.path, "swapped.md"), "# heading\n", "utf-8");
			const safe = await validatePath("swapped.md", vaultRoot);

			const eacces = Object.assign(new Error("EACCES: permission denied, open"), {
				code: "EACCES",
			});
			vi.mocked(fsPromises.open).mockRejectedValueOnce(eacces);
			vi.mocked(fsPromises.lstat).mockImplementation((path, opts) => {
				if (path === safe.absolute && !isBigIntLstat(opts)) {
					return Promise.resolve({ isFile: () => false, isSymbolicLink: () => true } as unknown as Stats);
				}
				return realFs.lstat(path, opts as Parameters<typeof realFs.lstat>[1]);
			});

			await expect(readNote(safe)).rejects.toMatchObject({
				payload: {
					code: "PATH_OUTSIDE_VAULT",
					param: "file",
					reason: "SYMLINK_SEGMENT",
					message: expect.stringContaining("symlink"),
				},
			});
		},
	);

	test.runIf(process.platform === "win32")(
		"EACCES from fs.open() + EACCES from fs.lstat() on Win32 → propagates cause (preserves rows)",
		async () => {
			// Realistic shared-cause case: ACL deny or share-lock denies both
			// open AND the follow-up lstat. Inconclusive lstat must NOT route
			// to PATH_NOT_FOUND (would prune rows for a still-existing file);
			// propagate the original EACCES so scanner's parse_failed preserves.
			await writeFile(join(vault.path, "perm-denied.md"), "# heading\n", "utf-8");
			const safe = await validatePath("perm-denied.md", vaultRoot);

			const eaccesOpen = Object.assign(new Error("EACCES: permission denied, open"), {
				code: "EACCES",
			});
			const eaccesLstat = Object.assign(new Error("EACCES: permission denied, lstat"), {
				code: "EACCES",
			});
			vi.mocked(fsPromises.open).mockRejectedValueOnce(eaccesOpen);
			vi.mocked(fsPromises.lstat).mockImplementation((path, opts) => {
				if (path === safe.absolute && !isBigIntLstat(opts)) return Promise.reject(eaccesLstat);
				return realFs.lstat(path, opts as Parameters<typeof realFs.lstat>[1]);
			});

			await expect(readNote(safe)).rejects.toMatchObject({ code: "EACCES" });
		},
	);

	test.runIf(process.platform !== "win32")(
		"EACCES from fs.open() on POSIX is NOT remapped (genuine permission denied)",
		async () => {
			// Regression guard: POSIX EACCES means real permission denied and
			// must NOT be remapped to PATH_NOT_FOUND — only Win32 gets the
			// libuv junction-quirk treatment.
			await writeFile(join(vault.path, "perm-denied.md"), "# heading\n", "utf-8");
			const safe = await validatePath("perm-denied.md", vaultRoot);

			const eacces = Object.assign(new Error("EACCES: permission denied, open"), {
				code: "EACCES",
			});
			vi.mocked(fsPromises.open).mockRejectedValueOnce(eacces);

			await expect(readNote(safe)).rejects.toMatchObject({ code: "EACCES" });
		},
	);
});
