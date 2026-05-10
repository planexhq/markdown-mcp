/**
 * One-time filesystem case-sensitivity probe used at server startup.
 *
 * `isIndexCachePath` needs different comparison semantics per FS: on
 * case-insensitive filesystems (macOS APFS, Windows NTFS default),
 * `.Vault-MCP/...` aliases to the server's lowercase cache on disk and
 * must be folded to lowercase before comparing or a mixed-case input
 * would slip past the cache-dir gate and leak the SQLite cache. On
 * case-sensitive filesystems (Linux ext4 / btrfs default), `.Vault-MCP/`
 * is a distinct inode and may be legitimate user content; byte-wise
 * compare preserves access.
 *
 * Probe creates a uniquely-named directory in lowercase at the vault
 * root and lstats the uppercase form: same-inode resolution →
 * case-insensitive, ENOENT → case-sensitive. The 64-bit random suffix
 * makes accidental collision with user content vanishingly unlikely;
 * the dir is removed before return.
 *
 * Falls back to `true` (case-insensitive) on any failure: a false
 * positive on a case-sensitive FS rejects access to a niche user dir
 * name (recoverable via rename) while a false negative on a case-
 * insensitive FS would leak the SQLite/WAL/SHM cache.
 */

import { randomBytes } from "node:crypto";
import { lstat, mkdir, rmdir } from "node:fs/promises";
import { join } from "node:path";

import { getErrnoCode } from "./error.js";

export async function detectCaseInsensitiveFs(vaultRoot: string): Promise<boolean> {
	const probeName = `.vault-mcp-case-probe-${randomBytes(8).toString("hex")}`;
	const lowerPath = join(vaultRoot, probeName);
	const upperPath = join(vaultRoot, probeName.toUpperCase());
	try {
		await mkdir(lowerPath);
	} catch {
		return true;
	}
	let caseInsensitive = true;
	try {
		await lstat(upperPath);
	} catch (err) {
		if (getErrnoCode(err) === "ENOENT") {
			caseInsensitive = false;
		}
	}
	await rmdir(lowerPath).catch(() => undefined);
	return caseInsensitive;
}
