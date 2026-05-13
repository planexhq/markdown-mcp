/**
 * `detectCaseInsensitiveFs` probe — startup gate that distinguishes
 * macOS APFS / Windows NTFS (case-insensitive default) from Linux ext4 /
 * btrfs (case-sensitive default) so `isIndexCachePath` preserves user
 * `.Markdown-MCP/` access on case-sensitive FS while still folding mixed-
 * case agent input to the cache on case-insensitive FS.
 */

import { lstat } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { detectCaseInsensitiveFs } from "../../src/lib/fsDetect.js";
import { createTempVault } from "../helpers/vault.js";

describe("detectCaseInsensitiveFs", () => {
	let vault: Awaited<ReturnType<typeof createTempVault>>;

	beforeEach(async () => {
		vault = await createTempVault();
	});

	afterEach(async () => {
		await vault.cleanup();
	});

	test("returns platform-expected verdict on the host FS", async () => {
		const result = await detectCaseInsensitiveFs(vault.path);
		if (process.platform === "darwin" || process.platform === "win32") {
			// macOS APFS + Windows NTFS default to case-insensitive. CI
			// runners that override this (e.g. mac with HFSX case-sensitive
			// volume) would invert the assertion — re-run with a default-
			// formatted volume.
			expect(result).toBe(true);
		} else if (process.platform === "linux") {
			// ext4 + btrfs default to case-sensitive.
			expect(result).toBe(false);
		} else {
			// Other platforms (freebsd/openbsd/aix/sunos): default to the
			// safer case-insensitive fallback on any probe failure, but
			// don't assert a specific verdict since FS varies.
			expect(typeof result).toBe("boolean");
		}
	});

	test("probe directory is cleaned up before return", async () => {
		await detectCaseInsensitiveFs(vault.path);
		// No probe dirs should remain. We can't predict the random suffix
		// from outside; just verify the vault root has no `.markdown-mcp-
		// case-probe-*` entries.
		const { readdir } = await import("node:fs/promises");
		const entries = await readdir(vault.path);
		const leftover = entries.filter((name) => name.startsWith(".markdown-mcp-case-probe-"));
		expect(leftover).toEqual([]);
	});

	test("returns true (safer fallback) when mkdir fails", async () => {
		// Probe against a non-existent directory: mkdir fails with ENOENT,
		// the function must fall back to the safer case-insensitive verdict.
		const result = await detectCaseInsensitiveFs(join(vault.path, "does-not-exist"));
		expect(result).toBe(true);
	});

	test("uppercase variant resolves through the probe on case-insensitive FS", async () => {
		// Sanity: confirm the lstat-uppercase trick the probe relies on
		// actually works on the host FS. If `process.platform === "linux"`
		// (case-sensitive), skip — the test would assert ENOENT which is
		// the probe's case-sensitive signal.
		if (process.platform !== "darwin" && process.platform !== "win32") return;
		const { mkdir, rmdir } = await import("node:fs/promises");
		const probe = join(vault.path, ".markdown-mcp-case-probe-aliassanity");
		await mkdir(probe);
		try {
			const upperStat = await lstat(probe.toUpperCase());
			expect(upperStat.isDirectory()).toBe(true);
		} finally {
			await rmdir(probe).catch(() => undefined);
		}
	});
});
