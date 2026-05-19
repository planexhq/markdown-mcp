/**
 * Per-process startup gate. Concurrent server processes with conflicting
 * `--include-hidden` flags must refuse before opening SQLite; same-policy
 * processes coexist via per-PID lockfiles. Symlink defense at the own-PID
 * slot refuses non-regular files (hostile vault); foreign non-regular
 * entries are logged + skipped (never touched).
 */

import { spawnSync } from "node:child_process";
import {
	lstat,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	stat,
	symlink,
	unlink,
	utimes,
	writeFile,
} from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
	acquireServerLock,
	LEGACY_LOCK_FILE_NAME,
	lockFileNameForPid,
	readAndParseForTesting,
	ServerLockConflictError,
	ServerLockExtensionConflictError,
	ServerLockFileNotRegularError,
	ServerLockHostCollisionError,
	ServerLockOwnSlotUnparseableError,
	ServerLockParserShapeConflictError,
	ServerLockUnknownPeerError,
} from "../src/lib/serverLock.js";
import { findDeadPid } from "./helpers/findDeadPid.js";
import { indexDir, ownLockPath } from "./helpers/indexDir.js";
import { SERVER_BIN, spawnAndWaitForStartup, spawnTestServer, waitForExit, waitForWarm } from "./helpers/mcp-client.js";
import { createTempVault, type VaultStructure } from "./helpers/vault.js";

const FIXTURE: VaultStructure = {
	"plain.md": "# Plain\n\nVisible note.\n",
};

let vault: { path: string; cleanup: () => Promise<void> };

beforeEach(async () => {
	vault = await createTempVault(FIXTURE);
});

afterEach(async () => {
	await vault.cleanup();
});

function spawnServerSync(vaultPath: string, extraArgs: string[]): { code: number | null; stderr: string } {
	const result = spawnSync(process.execPath, [SERVER_BIN, "--vault", vaultPath, ...extraArgs], {
		encoding: "utf8",
		timeout: 10_000,
	});
	return { code: result.status, stderr: result.stderr };
}

describe("server lockfile — conflict refusal", () => {
	test("different --include-hidden flags refuse the second arrival", async () => {
		const first = await spawnTestServer(vault.path, {}, ["--include-hidden"]);
		try {
			await waitForWarm(first.client);

			const { code, stderr } = spawnServerSync(vault.path, []);
			expect(code).toBe(1);
			expect(stderr).toContain("Another markdown-mcp server");
			expect(stderr).toContain("--include-hidden=true");
			expect(stderr).toContain("--include-hidden=false");
		} finally {
			await first.close();
		}
	}, 30_000);

	test("same --include-hidden lets both servers coexist with separate lockfiles", async () => {
		const first = await spawnTestServer(vault.path, {}, ["--include-hidden"]);
		try {
			await waitForWarm(first.client);

			const entriesAfterFirst = await readdir(indexDir(vault.path));
			const lockfilesAfterFirst = entriesAfterFirst.filter((n) => /^server-\d+\.lock$/.test(n));
			expect(lockfilesAfterFirst).toHaveLength(1);

			const second = await spawnTestServer(vault.path, {}, ["--include-hidden"]);
			try {
				await waitForWarm(second.client);

				const entries = await readdir(indexDir(vault.path));
				const lockfiles = entries.filter((n) => /^server-\d+\.lock$/.test(n));
				expect(lockfiles).toHaveLength(2);

				const probe = await second.client.callTool({ name: "search", arguments: { query: "Plain" } });
				expect(probe.isError).toBeFalsy();
			} finally {
				await second.close();
			}
		} finally {
			await first.close();
		}
	}, 30_000);

	test("opposite-policy arrival after one same-policy peer leaves is still gated", async () => {
		// First two servers coexist (same policy). When the original
		// owner shuts down, the second one's lockfile must still gate a
		// later opposite-policy arrival — addresses the legacy
		// attach-ownership hole.
		const first = await spawnTestServer(vault.path, {}, ["--include-hidden"]);
		const second = await spawnTestServer(vault.path, {}, ["--include-hidden"]);
		try {
			await waitForWarm(first.client);
			await waitForWarm(second.client);
			await first.close();

			const entries = await readdir(indexDir(vault.path));
			const lockfiles = entries.filter((n) => /^server-\d+\.lock$/.test(n));
			expect(lockfiles).toHaveLength(1);

			const { code, stderr } = spawnServerSync(vault.path, []);
			expect(code).toBe(1);
			expect(stderr).toContain("Another markdown-mcp server");
		} finally {
			await second.close();
		}
	}, 30_000);
});

describe("server lockfile — stale-PID cleanup", () => {
	test("dead-PID foreign slot is unlinked, current server starts", async () => {
		const deadPid = findDeadPid();
		const stalePath = join(indexDir(vault.path), lockFileNameForPid(deadPid));
		await mkdir(indexDir(vault.path), { recursive: true });
		await writeFile(stalePath, `${JSON.stringify({ includeHidden: true })}\n`);

		// Default policy contradicts the stale lock's policy: without the
		// staleness probe, this would refuse. Liveness probe sees ESRCH and
		// unlinks instead.
		const conn = await spawnTestServer(vault.path);
		try {
			await waitForWarm(conn.client);
			await expect(readFile(stalePath, "utf8")).rejects.toThrow(/ENOENT/);
		} finally {
			await conn.close();
		}
	}, 30_000);

	test("unparseable foreign-slot content from a live PID escalates to ServerLockUnknownPeerError", async () => {
		// A concurrent reader can land in the wx-write race window and see
		// an empty file from a real peer with an opposite policy. Falling
		// back to "assume same policy" would let opposite-policy peers
		// silently share the WAL; retry once after backoff, then escalate
		// to `ServerLockUnknownPeerError` if still unparseable.
		const liveOtherPid = process.ppid;
		const garbagePath = join(indexDir(vault.path), lockFileNameForPid(liveOtherPid));
		await mkdir(indexDir(vault.path), { recursive: true });
		await writeFile(garbagePath, "this is not valid json");

		await expect(
			acquireServerLock({ indexDir: indexDir(vault.path), includeHidden: false, parserShapeVersion: 0 }),
		).rejects.toBeInstanceOf(ServerLockUnknownPeerError);

		// Foreign lockfile is preserved (we never touch foreign content we
		// don't recognize as either parseable or stale).
		await expect(stat(garbagePath)).resolves.toBeTruthy();
		await unlink(garbagePath).catch(() => {});
	});

	test("retry recovers when foreign slot is populated mid-race", async () => {
		// Simulates the genuine wx-write race: peer A writes an empty
		// file first (open + create), peer B reads in that sub-ms window,
		// then peer A's write lands. Retry-after-backoff sees the now-
		// parseable content and treats it as same-policy coexistence.
		const liveOtherPid = process.ppid;
		const slotPath = join(indexDir(vault.path), lockFileNameForPid(liveOtherPid));
		await mkdir(indexDir(vault.path), { recursive: true });
		await writeFile(slotPath, "");
		// Populate the slot ~5 ms in, well before our 25 ms retry. Swallow
		// errors: if the test fails before the timer fires, the temp vault
		// may already be gone — don't surface that as an unhandled rejection.
		setTimeout(() => {
			writeFile(slotPath, `${JSON.stringify({ includeHidden: false, hostname: hostname() })}\n`).catch(() => {});
		}, 5);

		const handle = await acquireServerLock({
			indexDir: indexDir(vault.path),
			includeHidden: false,
			parserShapeVersion: 0,
		});
		try {
			// Race recovered; same-policy coexistence — no throw.
			expect(handle).toBeTruthy();
		} finally {
			await handle.release();
			await unlink(slotPath).catch(() => {});
		}
	});
});

describe("server lockfile — bounded foreign read", () => {
	test("oversized foreign-slot file is treated as unparseable", async () => {
		// A hostile or accidentally-large file at `server-<N>.lock` must
		// not be `readFile`'d in full — without the cap, the server would
		// allocate the file's full size before validation and could OOM.
		// Oversized content routes through the existing
		// `ServerLockUnknownPeerError` escalation for live peers.
		const liveOtherPid = process.ppid;
		const oversizedPath = join(indexDir(vault.path), lockFileNameForPid(liveOtherPid));
		await mkdir(indexDir(vault.path), { recursive: true });
		// 8 KB > 4 KB cap; the byte count beyond the cap is what's tested,
		// not the magnitude.
		const oversizedPayload = "x".repeat(8192);
		await writeFile(oversizedPath, oversizedPayload);

		await expect(
			acquireServerLock({ indexDir: indexDir(vault.path), includeHidden: false, parserShapeVersion: 0 }),
		).rejects.toBeInstanceOf(ServerLockUnknownPeerError);

		// Foreign slot left in place (we never unlink unparseable live-peer files).
		await expect(stat(oversizedPath)).resolves.toBeTruthy();
		await unlink(oversizedPath).catch(() => {});
	});
});

describe("server lockfile — foreign-host slot preserved when local PID is dead", () => {
	// Earlier `inspectForeignSlot` ran `isProcessAlive` before reading
	// the lockfile, so the foreign-host safeguard was only effective when
	// the foreign PID happened to collide with a live local process — the
	// rare case, not the common cross-host one. The existing "foreign-host
	// live-PID slot" test below uses `process.ppid` (locally alive), which
	// bypasses the buggy branch; these two cover the dead-PID branch.
	test("dead-local-PID foreign-hostname slot is left in place", async () => {
		const deadPid = findDeadPid();
		const foreignPath = join(indexDir(vault.path), lockFileNameForPid(deadPid));
		await mkdir(indexDir(vault.path), { recursive: true });
		await writeFile(foreignPath, `${JSON.stringify({ includeHidden: false, hostname: "foreign-host-xyz" })}\n`);

		const handle = await acquireServerLock({
			indexDir: indexDir(vault.path),
			includeHidden: true,
			parserShapeVersion: 0,
		});
		try {
			// Foreign-host signal short-circuits ahead of the liveness probe.
			await expect(stat(foreignPath)).resolves.toBeTruthy();
		} finally {
			await handle.release();
			await unlink(foreignPath).catch(() => {});
		}
	});

	test("dead-local-PID legacy slot (no hostname) is still unlinked", async () => {
		// Legacy compat: legacy lockfiles have no `hostname` field.
		// The same-host stale-PID cleanup must keep working for them or
		// dead-same-host predecessors accumulate orphans on upgraded systems.
		const deadPid = findDeadPid();
		const legacyPath = join(indexDir(vault.path), lockFileNameForPid(deadPid));
		await mkdir(indexDir(vault.path), { recursive: true });
		await writeFile(legacyPath, `${JSON.stringify({ includeHidden: false })}\n`);

		const handle = await acquireServerLock({
			indexDir: indexDir(vault.path),
			includeHidden: true,
			parserShapeVersion: 0,
		});
		try {
			await expect(stat(legacyPath)).rejects.toThrow(/ENOENT/);
		} finally {
			await handle.release();
		}
	});
});

describe("server lockfile — hostname check", () => {
	test("foreign-host live-PID slot is logged + skipped, target left in place", async () => {
		// Cross-host NFS mount: a foreign-host markdown-mcp wrote the slot.
		// PID is meaningless locally; can't probe liveness via process.kill;
		// don't escalate (would block legit local startup if the PID
		// happens to match a local process) and don't unlink (might
		// belong to a live foreign-host owner).
		const liveOtherPid = process.ppid;
		const foreignPath = join(indexDir(vault.path), lockFileNameForPid(liveOtherPid));
		await mkdir(indexDir(vault.path), { recursive: true });
		await writeFile(foreignPath, `${JSON.stringify({ includeHidden: false, hostname: "foreign-host-xyz" })}\n`);

		const handle = await acquireServerLock({
			indexDir: indexDir(vault.path),
			includeHidden: true,
			parserShapeVersion: 0,
		});
		try {
			// Foreign-host slot is preserved (we never unlink slots we can't validate).
			await expect(stat(foreignPath)).resolves.toBeTruthy();
		} finally {
			await handle.release();
			await unlink(foreignPath).catch(() => {});
		}
	});

	test("legacy lockfile (no hostname field) is treated as same-host", async () => {
		// Legacy shape: parseable JSON without `hostname`.
		// The legacy-compat path must still gate cross-policy peers
		// because there's no signal that the writer was foreign-host.
		const liveOtherPid = process.ppid;
		const legacyShapePath = join(indexDir(vault.path), lockFileNameForPid(liveOtherPid));
		await mkdir(indexDir(vault.path), { recursive: true });
		await writeFile(legacyShapePath, `${JSON.stringify({ includeHidden: true })}\n`);

		// Opposite policy → same-host conflict (no hostname → assume local).
		const { code, stderr } = spawnServerSync(vault.path, []);
		expect(code).toBe(1);
		expect(stderr).toContain("Another markdown-mcp server");

		await unlink(legacyShapePath).catch(() => {});
	}, 30_000);
});

describe("server lockfile — own-slot PID-reuse recovery", () => {
	test("acquireServerLock takes over a stale regular-file at our own PID slot", async () => {
		const indexPath = indexDir(vault.path);
		await mkdir(indexPath, { recursive: true });
		const ourPath = ownLockPath(vault.path, process.pid);
		// Plant a leftover lockfile at our own PID slot (simulates a
		// previous markdown-mcp process with the same recycled PID that died
		// without cleanup).
		await writeFile(ourPath, `${JSON.stringify({ includeHidden: true })}\n`);

		const handle = await acquireServerLock({ indexDir: indexPath, includeHidden: false, parserShapeVersion: 0 });
		try {
			const after = await readFile(ourPath, "utf8");
			// Recovery overwrote with our policy (false), proving takeover.
			const parsed = JSON.parse(after) as { includeHidden: boolean };
			expect(parsed.includeHidden).toBe(false);
		} finally {
			await handle.release();
		}
	});
});

describe("server lockfile — symlink defense", () => {
	test("symlink at our own PID slot refuses startup without touching the target", async () => {
		const indexPath = indexDir(vault.path);
		await mkdir(indexPath, { recursive: true });
		const ourPath = ownLockPath(vault.path, process.pid);
		const targetPath = join(await mkdtemp(join(tmpdir(), "markdown-mcp-symlink-target-")), "sentinel.txt");
		const sentinel = "DO_NOT_OVERWRITE";
		await writeFile(targetPath, sentinel);
		await symlink(targetPath, ourPath);

		await expect(
			acquireServerLock({ indexDir: indexPath, includeHidden: false, parserShapeVersion: 0 }),
		).rejects.toBeInstanceOf(ServerLockFileNotRegularError);

		// Target untouched.
		expect(await readFile(targetPath, "utf8")).toBe(sentinel);
		await unlink(ourPath).catch(() => {});
		await unlink(targetPath).catch(() => {});
	});

	test("symlink at a foreign PID slot is logged + skipped (target unchanged)", async () => {
		const indexPath = indexDir(vault.path);
		await mkdir(indexPath, { recursive: true });
		// PID 1 (init) is reliably alive on POSIX, so the slot's lstat will
		// short-circuit on "non-regular" before any kill probe / read.
		const foreignPath = join(indexPath, lockFileNameForPid(1));
		const targetPath = join(await mkdtemp(join(tmpdir(), "markdown-mcp-symlink-target-")), "foreign-target.txt");
		const sentinel = "FOREIGN_DO_NOT_TOUCH";
		await writeFile(targetPath, sentinel);
		await symlink(targetPath, foreignPath);

		const handle = await acquireServerLock({ indexDir: indexPath, includeHidden: false, parserShapeVersion: 0 });
		try {
			expect(await readFile(targetPath, "utf8")).toBe(sentinel);
			// Foreign symlink left in place (we never touch foreign non-regular
			// entries).
			const st = await stat(foreignPath).catch(() => null);
			expect(st).not.toBeNull();
		} finally {
			await handle.release();
			await unlink(foreignPath).catch(() => {});
			await unlink(targetPath).catch(() => {});
		}
	});
});

describe("server lockfile — legacy server.lock cleanup", () => {
	test("regular legacy server.lock is unlinked at startup", async () => {
		const indexPath = indexDir(vault.path);
		await mkdir(indexPath, { recursive: true });
		const legacyPath = join(indexPath, LEGACY_LOCK_FILE_NAME);
		await writeFile(legacyPath, "arbitrary legacy content");

		const handle = await acquireServerLock({ indexDir: indexPath, includeHidden: false, parserShapeVersion: 0 });
		try {
			await expect(readFile(legacyPath, "utf8")).rejects.toThrow(/ENOENT/);
			// Per-PID file present.
			await expect(stat(ownLockPath(vault.path, process.pid))).resolves.toBeTruthy();
		} finally {
			await handle.release();
		}
	});

	test("symlinked legacy server.lock is not followed (target preserved)", async () => {
		const indexPath = indexDir(vault.path);
		await mkdir(indexPath, { recursive: true });
		const legacyPath = join(indexPath, LEGACY_LOCK_FILE_NAME);
		const targetPath = join(await mkdtemp(join(tmpdir(), "markdown-mcp-symlink-target-")), "legacy-target.txt");
		const sentinel = "LEGACY_TARGET_INTACT";
		await writeFile(targetPath, sentinel);
		await symlink(targetPath, legacyPath);

		const handle = await acquireServerLock({ indexDir: indexPath, includeHidden: false, parserShapeVersion: 0 });
		try {
			// Target preserved (cleanup refuses to follow the symlink).
			expect(await readFile(targetPath, "utf8")).toBe(sentinel);
			// Symlink itself left in place (we don't unlink non-regular legacy
			// entries to avoid removing user-managed pointers).
			const lst = await stat(targetPath).catch(() => null);
			expect(lst).not.toBeNull();
		} finally {
			await handle.release();
			await unlink(legacyPath).catch(() => {});
			await unlink(targetPath).catch(() => {});
		}
	});
});

describe("server lockfile — shutdown cleanup", () => {
	test("SIGTERM unlinks our per-PID lockfile", async () => {
		const server = await spawnAndWaitForStartup(vault.path);
		try {
			const pid = server.child.pid;
			if (pid === undefined) throw new Error("child PID missing");
			const lockPath = ownLockPath(vault.path, pid);
			await expect(stat(lockPath)).resolves.toBeTruthy();

			server.child.kill("SIGTERM");
			await waitForExit(server.child);

			await expect(readFile(lockPath, "utf8")).rejects.toThrow(/ENOENT/);
		} finally {
			if (server.child.exitCode === null) server.child.kill("SIGKILL");
		}
	}, 30_000);
});

describe("server lockfile — legacy lockfile mixed-version interop", () => {
	test("dead-PID legacy server.lock is preserved (cannot distinguish stale-local from live-foreign); server starts cleanly via own per-PID slot", async () => {
		// Legacy lockfiles carry no hostname field. ESRCH locally can
		// mean "stale-local" OR "live foreign-host" (PIDs are per-host
		// on POSIX); rm-as-stale would clobber a live foreign-host's
		// lock and let both hosts write the WAL. Preserve, log, require
		// operator clean-up.
		const indexPath = indexDir(vault.path);
		await mkdir(indexPath, { recursive: true });
		const legacyPath = join(indexPath, LEGACY_LOCK_FILE_NAME);
		const deadPid = findDeadPid();
		await writeFile(legacyPath, `${JSON.stringify({ pid: deadPid, includeHidden: false })}\n`);

		const handle = await acquireServerLock({ indexDir: indexPath, includeHidden: true, parserShapeVersion: 0 });
		try {
			// Legacy file preserved (operator must rm manually).
			await expect(stat(legacyPath)).resolves.toBeTruthy();
			// Own per-PID slot acquired.
			await expect(stat(ownLockPath(vault.path, process.pid))).resolves.toBeTruthy();
		} finally {
			await handle.release();
			await unlink(legacyPath).catch(() => {});
		}
	});

	test("live-PID legacy server.lock with matching policy is preserved (coexists)", async () => {
		const indexPath = indexDir(vault.path);
		await mkdir(indexPath, { recursive: true });
		const legacyPath = join(indexPath, LEGACY_LOCK_FILE_NAME);
		// process.ppid is the vitest runner — reliably alive.
		await writeFile(legacyPath, `${JSON.stringify({ pid: process.ppid, includeHidden: false })}\n`);

		const handle = await acquireServerLock({ indexDir: indexPath, includeHidden: false, parserShapeVersion: 0 });
		try {
			// Legacy file preserved — the still-running legacy owner's
			// shutdown handler will clean it up.
			await expect(stat(legacyPath)).resolves.toBeTruthy();
		} finally {
			await handle.release();
			await unlink(legacyPath).catch(() => {});
		}
	});

	test("live-PID legacy server.lock with opposite policy refuses with ServerLockConflictError", async () => {
		const indexPath = indexDir(vault.path);
		await mkdir(indexPath, { recursive: true });
		const legacyPath = join(indexPath, LEGACY_LOCK_FILE_NAME);
		await writeFile(legacyPath, `${JSON.stringify({ pid: process.ppid, includeHidden: false })}\n`);

		await expect(
			acquireServerLock({ indexDir: indexPath, includeHidden: true, parserShapeVersion: 0 }),
		).rejects.toBeInstanceOf(ServerLockConflictError);
		// Legacy file preserved (we don't unlink a live owner's slot).
		await expect(stat(legacyPath)).resolves.toBeTruthy();
		await unlink(legacyPath).catch(() => {});
	});
});

describe("server lockfile — legacy wx-race absorption", () => {
	test("empty legacy server.lock filled mid-retry absorbs the wx-write race and coexists", async () => {
		const indexPath = indexDir(vault.path);
		await mkdir(indexPath, { recursive: true });
		const legacyPath = join(indexPath, LEGACY_LOCK_FILE_NAME);
		await writeFile(legacyPath, "");

		// 12 ms sits inside the 25 ms reprobe window — matches the
		// reprobe non-regular test below (proven non-flaky on CI).
		const timer = setTimeout(() => {
			void writeFile(legacyPath, `${JSON.stringify({ pid: process.ppid, includeHidden: false })}\n`).catch(() => {});
		}, 12);

		try {
			const handle = await acquireServerLock({ indexDir: indexPath, includeHidden: false, parserShapeVersion: 0 });
			try {
				await expect(stat(legacyPath)).resolves.toBeTruthy();
			} finally {
				await handle.release();
			}
		} finally {
			clearTimeout(timer);
			await unlink(legacyPath).catch(() => {});
		}
	});

	test("empty legacy server.lock persistently unparseable after retry is unlinked", async () => {
		const indexPath = indexDir(vault.path);
		await mkdir(indexPath, { recursive: true });
		const legacyPath = join(indexPath, LEGACY_LOCK_FILE_NAME);
		await writeFile(legacyPath, "");

		const handle = await acquireServerLock({ indexDir: indexPath, includeHidden: false, parserShapeVersion: 0 });
		try {
			await expect(stat(legacyPath)).rejects.toThrow(/ENOENT/);
		} finally {
			await handle.release();
		}
	});
});

describe("server lockfile — readAndParse non-regular swap defense", () => {
	test("readAndParse on a symlink returns 'absent' without following the link", async () => {
		// Static symlinks are caught earlier by inspectForeignSlot's lstat
		// gate; readAndParse's hardened open defends a mid-flight TOCTOU
		// swap that can't be scheduled deterministically.
		const indexPath = indexDir(vault.path);
		await mkdir(indexPath, { recursive: true });
		const targetPath = join(indexPath, "secret.txt");
		const symlinkPath = join(indexPath, "link.lock");
		await writeFile(targetPath, "SECRET_CONTENT_THAT_MUST_NOT_LEAK\n");
		await symlink(targetPath, symlinkPath);

		const result = await readAndParseForTesting(symlinkPath);
		expect(result).toBe("absent");
		// Preserve user-placed pointers — "absent" must NOT unlink.
		await expect(stat(symlinkPath)).resolves.toBeTruthy();

		await Promise.all([unlink(symlinkPath).catch(() => {}), unlink(targetPath).catch(() => {})]);
	});

	test("readAndParse on a directory returns 'absent' via post-open fstat", async () => {
		const indexPath = indexDir(vault.path);
		await mkdir(indexPath, { recursive: true });
		const dirPath = join(indexPath, "subdir.lock");
		await mkdir(dirPath);

		const result = await readAndParseForTesting(dirPath);
		expect(result).toBe("absent");

		await rm(dirPath, { recursive: true, force: true });
	});
});

describe("server lockfile — own-slot foreign-host collision", () => {
	test("foreign-host lockfile at our PID slot throws ServerLockHostCollisionError and is preserved", async () => {
		// PIDs are per-host on POSIX; a shared-mount vault can hold
		// `server-<ourPID>.lock` for a foreign-host server. Unconditional
		// `rm` on EEXIST would orphan its lock and let both hosts write
		// the WAL — must refuse instead, mirroring inspectForeignSlot.
		const indexPath = indexDir(vault.path);
		await mkdir(indexPath, { recursive: true });
		const ownSlot = join(indexPath, lockFileNameForPid(process.pid));
		await writeFile(ownSlot, `${JSON.stringify({ includeHidden: false, hostname: "foreign-host-XYZ" })}\n`);

		await expect(
			acquireServerLock({ indexDir: indexPath, includeHidden: false, parserShapeVersion: 0 }),
		).rejects.toBeInstanceOf(ServerLockHostCollisionError);

		// Foreign-host lockfile must NOT be unlinked.
		const surviving = await readFile(ownSlot, "utf8");
		expect(surviving).toContain("foreign-host-XYZ");
		await unlink(ownSlot);
	});

	test("same-host lockfile at our PID slot is treated as a prior-us remnant and unlinked", async () => {
		const indexPath = indexDir(vault.path);
		await mkdir(indexPath, { recursive: true });
		const ownSlot = join(indexPath, lockFileNameForPid(process.pid));
		await writeFile(ownSlot, `${JSON.stringify({ includeHidden: false, hostname: hostname() })}\n`);

		const handle = await acquireServerLock({ indexDir: indexPath, includeHidden: false, parserShapeVersion: 0 });
		try {
			// Our fresh payload replaced the prior-us remnant.
			const fresh = await readFile(ownSlot, "utf8");
			expect(fresh).toContain(`"hostname":"${hostname()}"`);
		} finally {
			await handle.release();
		}
	});

	test("legacy no-hostname lockfile at our PID slot is treated as same-host previous-us and unlinked", async () => {
		const indexPath = indexDir(vault.path);
		await mkdir(indexPath, { recursive: true });
		const ownSlot = join(indexPath, lockFileNameForPid(process.pid));
		// Legacy shape: no hostname field. Treat as same-host (legacy
		// servers were single-host by design) and unlink.
		await writeFile(ownSlot, `${JSON.stringify({ includeHidden: false })}\n`);

		const handle = await acquireServerLock({ indexDir: indexPath, includeHidden: false, parserShapeVersion: 0 });
		try {
			const fresh = await readFile(ownSlot, "utf8");
			expect(fresh).toContain(`"hostname":"${hostname()}"`);
		} finally {
			await handle.release();
		}
	});
});

describe("server lockfile — own-slot unparseable", () => {
	/**
	 * Plants `content` at the own-PID slot, expects acquireServerLock to
	 * reject with ServerLockOwnSlotUnparseableError, and asserts the file
	 * survives (rm would orphan a live foreign-host lock on shared mounts).
	 */
	async function expectOwnSlotUnparseable(content: string): Promise<void> {
		const indexPath = indexDir(vault.path);
		await mkdir(indexPath, { recursive: true });
		const ownSlot = join(indexPath, lockFileNameForPid(process.pid));
		await writeFile(ownSlot, content);

		await expect(
			acquireServerLock({ indexDir: indexPath, includeHidden: false, parserShapeVersion: 0 }),
		).rejects.toBeInstanceOf(ServerLockOwnSlotUnparseableError);

		await expect(stat(ownSlot)).resolves.toBeTruthy();
		await unlink(ownSlot);
	}

	test("empty own-slot file persists across retry → ServerLockOwnSlotUnparseableError, file preserved", async () => {
		// Persistent unparseable at our PID-named slot is ambiguous on
		// shared mounts (live foreign-host wx-write that never landed vs.
		// half-written prior-us); rm would orphan a live foreign lock.
		await expectOwnSlotUnparseable("");
	});

	test("invalid record shape at own-slot persists across retry → ServerLockOwnSlotUnparseableError", async () => {
		// Any unparseable content (including parseable-JSON with wrong
		// field type) triggers escalation — without `hostname` we can't
		// apply the cross-host defense.
		await expectOwnSlotUnparseable('{"includeHidden":"not-a-bool"}\n');
	});
});

describe("server lockfile — foreign-slot unparseable + ESRCH preserves", () => {
	test("unparseable foreign slot with ESRCH PID is preserved, acquire succeeds", async () => {
		// ESRCH locally is the NORMAL state for live foreign-host PIDs
		// (PIDs don't cross hosts on POSIX); without a hostname signal we
		// can't disambiguate stale-local from live-foreign. Preserve.
		const indexPath = indexDir(vault.path);
		await mkdir(indexPath, { recursive: true });
		const deadPid = 9999999;
		const foreignSlot = join(indexPath, lockFileNameForPid(deadPid));
		await writeFile(foreignSlot, "");

		const handle = await acquireServerLock({ indexDir: indexPath, includeHidden: false, parserShapeVersion: 0 });
		try {
			await expect(stat(ownLockPath(vault.path, process.pid))).resolves.toBeTruthy();
			await expect(stat(foreignSlot)).resolves.toBeTruthy();
		} finally {
			await handle.release();
			await unlink(foreignSlot);
		}
	});
});

describe("server lockfile — extension conflict", () => {
	test("opposite vaultExtensions on a live peer throws ServerLockExtensionConflictError", async () => {
		const indexPath = indexDir(vault.path);
		await mkdir(indexPath, { recursive: true });
		const liveSlot = join(indexPath, lockFileNameForPid(process.ppid));
		await writeFile(
			liveSlot,
			`${JSON.stringify({ includeHidden: false, hostname: hostname(), vaultExtensions: ["md", "mdx"] })}\n`,
		);

		await expect(
			acquireServerLock({ indexDir: indexPath, includeHidden: false, parserShapeVersion: 0 }),
		).rejects.toBeInstanceOf(ServerLockExtensionConflictError);

		// Foreign slot preserved (we don't unlink live peers).
		await expect(stat(liveSlot)).resolves.toBeTruthy();
		await unlink(liveSlot).catch(() => {});
	});

	test("matching vaultExtensions on a live peer coexists", async () => {
		const indexPath = indexDir(vault.path);
		await mkdir(indexPath, { recursive: true });
		const liveSlot = join(indexPath, lockFileNameForPid(process.ppid));
		await writeFile(
			liveSlot,
			`${JSON.stringify({ includeHidden: false, hostname: hostname(), vaultExtensions: ["md"] })}\n`,
		);

		const handle = await acquireServerLock({ indexDir: indexPath, includeHidden: false, parserShapeVersion: 0 });
		try {
			await expect(stat(liveSlot)).resolves.toBeTruthy();
		} finally {
			await handle.release();
			await unlink(liveSlot).catch(() => {});
		}
	});

	test("legacy lockfile (no vaultExtensions field) treated as default ['md'] — coexists with default-process", async () => {
		// Legacy lockfiles carry no `vaultExtensions`. Normalize to the
		// documented `vaultExtensions.ts` default; default-extension peer
		// coexists, non-default-extension peer would conflict.
		const indexPath = indexDir(vault.path);
		await mkdir(indexPath, { recursive: true });
		const liveSlot = join(indexPath, lockFileNameForPid(process.ppid));
		await writeFile(liveSlot, `${JSON.stringify({ includeHidden: false, hostname: hostname() })}\n`);

		const handle = await acquireServerLock({ indexDir: indexPath, includeHidden: false, parserShapeVersion: 0 });
		try {
			await expect(stat(liveSlot)).resolves.toBeTruthy();
		} finally {
			await handle.release();
			await unlink(liveSlot).catch(() => {});
		}
	});
});

describe("server lockfile — bogus PID filename gate", () => {
	test("server-<INT32_MAX+1>.lock with opposite-policy content is skipped, not treated as live peer", async () => {
		// Filename encodes a PID outside POSIX `pid_t` (signed int32). Without
		// the gate, `process.kill(pid, 0)` throws `RangeError` →
		// `isProcessAlive` (non-ESRCH → alive) reads the planted opposite-
		// policy file as a live peer and blocks startup indefinitely.
		const indexPath = indexDir(vault.path);
		await mkdir(indexPath, { recursive: true });
		const bogusPath = join(indexPath, "server-2147483648.lock");
		await writeFile(
			bogusPath,
			`${JSON.stringify({ includeHidden: true, hostname: hostname(), vaultExtensions: ["md"] })}\n`,
		);

		const handle = await acquireServerLock({ indexDir: indexPath, includeHidden: false, parserShapeVersion: 0 });
		try {
			// Bogus file preserved (don't unlink anything we can't verify).
			await expect(stat(bogusPath)).resolves.toBeTruthy();
			await expect(stat(ownLockPath(vault.path, process.pid))).resolves.toBeTruthy();
		} finally {
			await handle.release();
			await unlink(bogusPath).catch(() => {});
		}
	});
});

describe("server lockfile — reprobe non-regular guard", () => {
	test("foreign slot swapped to a directory during the 25 ms retry is skipped, not opened", async () => {
		// Plant unparseable content at a live foreign slot, then swap the
		// file for a directory mid-backoff. Directory is the most
		// deterministic non-regular choice for a single-process test —
		// symlink/FIFO swaps are harder to schedule reliably.
		const indexPath = indexDir(vault.path);
		await mkdir(indexPath, { recursive: true });
		const slotPath = join(indexPath, lockFileNameForPid(process.ppid));
		await writeFile(slotPath, ""); // empty → unparseable on first read
		// Swap to directory ~12 ms in (between the 0 ms unparseable-read and
		// the 25 ms reprobe). 5 ms was tight enough on slow CI that GC /
		// scheduler delay could push the mkdir past the reprobe — the
		// reprobe would then see "absent" (a valid skip path) instead of
		// "non-regular" (the targeted branch), silently losing coverage.
		const timer = setTimeout(() => {
			void (async () => {
				try {
					await unlink(slotPath);
					await mkdir(slotPath);
				} catch {
					/* test may already have torn down */
				}
			})();
		}, 12);

		try {
			// Acquire succeeds because reprobe → non-regular → "absent" →
			// inspectForeignSlot skips. No throw, no block.
			const handle = await acquireServerLock({ indexDir: indexPath, includeHidden: false, parserShapeVersion: 0 });
			await handle.release();
		} finally {
			clearTimeout(timer);
			// `rm` with `recursive: true` handles both file and directory leftovers.
			await rm(slotPath, { recursive: true, force: true });
		}
	});

	test("own slot swapped to a directory during the 25 ms retry throws ServerLockFileNotRegularError", async () => {
		// Symmetric to the foreign-slot test above, but the verdict is the
		// opposite: a non-regular swap at OUR PID's slot is unambiguously
		// hostile (operator has no reason to place a pointer at the exact
		// process.pid filename), so refuse-to-start. Without the post-call
		// lstat in acquireOwnSlot, the swap routes through "absent" (either
		// via readAndParse's ELOOP/ENXIO catch or via readAndParseWithRetry's
		// reprobe non-regular branch) and acquireOwnSlot would unlink the
		// non-regular file + wx-write fresh — silently bypassing the
		// ServerLockFileNotRegularError hardening.
		const indexPath = indexDir(vault.path);
		await mkdir(indexPath, { recursive: true });
		const slotPath = join(indexPath, lockFileNameForPid(process.pid));
		await writeFile(slotPath, ""); // empty → unparseable on first read
		// Same 12 ms timing as the foreign-slot reprobe test (proven
		// non-flaky on CI).
		const timer = setTimeout(() => {
			void (async () => {
				try {
					await unlink(slotPath);
					await mkdir(slotPath);
				} catch {
					/* test may already have torn down */
				}
			})();
		}, 12);

		try {
			await expect(
				acquireServerLock({ indexDir: indexPath, includeHidden: false, parserShapeVersion: 0 }),
			).rejects.toBeInstanceOf(ServerLockFileNotRegularError);
		} finally {
			clearTimeout(timer);
			await rm(slotPath, { recursive: true, force: true });
		}
	});
});

describe("server lockfile — simultaneous-start tiebreaker", () => {
	test("conflicting peer with newer mtime → we win, no throw", async () => {
		// Without the tiebreaker, both peers throw and both exit — neither comes up.
		const indexPath = indexDir(vault.path);
		await mkdir(indexPath, { recursive: true });
		const foreignPath = join(indexPath, lockFileNameForPid(process.ppid));
		await writeFile(
			foreignPath,
			`${JSON.stringify({
				includeHidden: true, // opposite of ours
				hostname: hostname(),
				vaultExtensions: ["md"],
			})}\n`,
		);
		// Foreign mtime in the future — we (now-mtime) are older → win.
		const future = new Date(Date.now() + 60_000);
		await utimes(foreignPath, future, future);

		const handle = await acquireServerLock({ indexDir: indexPath, includeHidden: false, parserShapeVersion: 0 });
		try {
			const ourPath = ownLockPath(vault.path, process.pid);
			await expect(lstat(ourPath)).resolves.toBeTruthy();
			await expect(lstat(foreignPath)).resolves.toBeTruthy();
		} finally {
			await handle.release();
			await unlink(foreignPath).catch(() => {});
		}
	});

	test("conflicting peer with older mtime → we lose, throw", async () => {
		const indexPath = indexDir(vault.path);
		await mkdir(indexPath, { recursive: true });
		const foreignPath = join(indexPath, lockFileNameForPid(process.ppid));
		await writeFile(
			foreignPath,
			`${JSON.stringify({
				includeHidden: true,
				hostname: hostname(),
				vaultExtensions: ["md"],
			})}\n`,
		);
		// Foreign mtime in the past — foreign is older → foreign wins.
		const past = new Date(Date.now() - 60_000);
		await utimes(foreignPath, past, past);

		await expect(
			acquireServerLock({ indexDir: indexPath, includeHidden: false, parserShapeVersion: 0 }),
		).rejects.toBeInstanceOf(ServerLockConflictError);

		// Our slot cleaned up by acquireServerLock's catch.
		const ourPath = ownLockPath(vault.path, process.pid);
		await expect(lstat(ourPath)).rejects.toThrow(/ENOENT/);

		// Foreign slot preserved (we don't touch live peers' lockfiles).
		await expect(lstat(foreignPath)).resolves.toBeTruthy();
		await unlink(foreignPath).catch(() => {});
	});
});

describe("server lockfile — parser-shape conflict", () => {
	test("lock record persists parserShapeVersion", async () => {
		const indexPath = indexDir(vault.path);
		await mkdir(indexPath, { recursive: true });
		const handle = await acquireServerLock({ indexDir: indexPath, includeHidden: false, parserShapeVersion: 42 });
		try {
			const ownSlot = ownLockPath(vault.path, process.pid);
			const record = await readAndParseForTesting(ownSlot);
			expect(record).not.toBe("absent");
			expect(record).not.toBe("unparseable");
			if (record === "absent" || record === "unparseable") return;
			expect(record.parserShapeVersion).toBe(42);
		} finally {
			await handle.release();
		}
	});

	test("mismatched parserShapeVersion on a live peer throws ServerLockParserShapeConflictError", async () => {
		const indexPath = indexDir(vault.path);
		await mkdir(indexPath, { recursive: true });
		const liveSlot = join(indexPath, lockFileNameForPid(process.ppid));
		await writeFile(
			liveSlot,
			`${JSON.stringify({
				includeHidden: false,
				hostname: hostname(),
				vaultExtensions: ["md"],
				parserShapeVersion: 9,
			})}\n`,
		);

		await expect(
			acquireServerLock({ indexDir: indexPath, includeHidden: false, parserShapeVersion: 10 }),
		).rejects.toBeInstanceOf(ServerLockParserShapeConflictError);

		await expect(stat(liveSlot)).resolves.toBeTruthy();
		await unlink(liveSlot).catch(() => {});
	});

	test("legacy lockfile (no parserShapeVersion field) treated as 0; conflicts with a non-zero binary", async () => {
		const indexPath = indexDir(vault.path);
		await mkdir(indexPath, { recursive: true });
		const liveSlot = join(indexPath, lockFileNameForPid(process.ppid));
		// Pre-stamp lock record without the field.
		await writeFile(
			liveSlot,
			`${JSON.stringify({ includeHidden: false, hostname: hostname(), vaultExtensions: ["md"] })}\n`,
		);

		await expect(
			acquireServerLock({ indexDir: indexPath, includeHidden: false, parserShapeVersion: 10 }),
		).rejects.toBeInstanceOf(ServerLockParserShapeConflictError);

		await unlink(liveSlot).catch(() => {});
	});

	test("matching parserShapeVersion on a live peer coexists", async () => {
		const indexPath = indexDir(vault.path);
		await mkdir(indexPath, { recursive: true });
		const liveSlot = join(indexPath, lockFileNameForPid(process.ppid));
		await writeFile(
			liveSlot,
			`${JSON.stringify({
				includeHidden: false,
				hostname: hostname(),
				vaultExtensions: ["md"],
				parserShapeVersion: 10,
			})}\n`,
		);

		const handle = await acquireServerLock({ indexDir: indexPath, includeHidden: false, parserShapeVersion: 10 });
		try {
			await expect(stat(liveSlot)).resolves.toBeTruthy();
		} finally {
			await handle.release();
			await unlink(liveSlot).catch(() => {});
		}
	});
});
