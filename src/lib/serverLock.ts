/**
 * Process-exclusive startup gate. Concurrent server processes pointing
 * at the same vault with different `--include-hidden` flags share the
 * SQLite WAL; without a lock, process B's policy-mismatch-driven rescan
 * writes propagate into process A's snapshot reads, silently breaking
 * the all-or-nothing-per-server invariant before either the startup
 * mismatch check or atomic finalize gets a chance.
 *
 * Lockfile shape: one file per process at
 * `<indexDir>/server-<pid>.lock` containing a single JSON line
 * `{"includeHidden":<bool>}`. Each process owns exactly one file;
 * cleanup is per-file; no shared state, no ownership transfer, no
 * attach handle. Same-policy concurrent processes each have their own
 * file and coexist (SQLite WAL is multi-process safe under matching
 * policy); mismatched-policy second process exits with
 * {@link ServerLockConflictError} before opening SQLite.
 *
 * Symlink defense: own-slot EEXIST triggers `lstat` classification — a
 * non-regular file refuses startup ({@link ServerLockFileNotRegularError});
 * foreign-slot probes are lstat-gated (non-regular foreign files are
 * logged + skipped, never touched). Stale-PID cleanup: foreign-slot
 * entries whose PID is dead via `kill(pid, 0)` ESRCH are unlinked.
 *
 * Concurrency: own-slot `wx` happens BEFORE the conflict-scan readdir
 * so two simultaneously-starting peers each observe the other's slot
 * during their own scan (otherwise A's pre-wx readdir would miss B's
 * post-wx write). Cold path is 2 syscalls (`open` + `readdir`).
 */

import { type BigIntStats, constants as fsConstants, type Stats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { lstat, open, readdir, rm, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { getErrnoCode, isVanishedErrno } from "./error.js";
import { DEFAULT_EXTENSIONS, getVaultExtensions } from "./vaultExtensions.js";

/** Backoff before retrying an unparseable foreign-slot read; absorbs the wx-write race. */
const UNPARSEABLE_RETRY_DELAY_MS = 25;

/**
 * Maximum rotation retries — gates two consumers that both absorb a
 * peer's `acquireOwnSlot` rm→wx rotation on AV/SMB-latent storage:
 *   - `readAndParseWithRetry`'s dev/ino mismatch budget. A single
 *     25 ms retry collapses to `"absent"` when the peer's rm-then-wx
 *     is slower than that, and silent skip lets an opposite-policy
 *     peer share the WAL → corruption.
 *   - `inspectForeignSlot`'s post-read freshProbe absent loop. The
 *     same under-budget hazard applies for the same storage class;
 *     reusing this constant keeps the rotation-window guarantee in
 *     one place.
 * Four rotation attempts × 25 ms = 100 ms total budget. The content-
 * unparseable budget (1 retry) stays separate so genuine corruption
 * isn't masked.
 */
const MAX_MISMATCH_RETRIES = 4;

/**
 * Bounded foreign-slot read. Legitimate lockfiles are ~30–80 bytes
 * (one JSON line with `includeHidden` + `hostname`); 4 KB absorbs any
 * future field additions with comical headroom. A hostile or accidental
 * giant file at `server-<N>.lock` would otherwise allocate its full size
 * via `readFile` and could OOM the server before validation. Reads beyond
 * the cap return `"unparseable"` and route through the existing escalation.
 */
const MAX_LOCKFILE_BYTES = 4096;

const ESRCH_PRESERVE_SUFFIX =
	"ESRCH locally; cannot distinguish stale-local from live-foreign without hostname signal. " +
	"Leaving in place; remove manually if you're certain it's stale.";

export interface ServerLockOptions {
	indexDir: string;
	includeHidden: boolean;
	/**
	 * Fires once the own-PID slot file is on disk, before the foreign-slot
	 * reconcile pass; lets the caller publish the handle to its shutdown
	 * path so a signal landing during reconcile's (≥25 ms) unparseable
	 * retry still releases the lockfile. Awaited inside acquireServerLock's
	 * existing try block — a throw from the callback rm's the slot.
	 * Release is idempotent on ENOENT, so double-release (shutdown +
	 * catch-path rm) is safe.
	 */
	onSlotCreated?: (handle: ServerLockHandle) => void | Promise<void>;
}

export interface ServerLockHandle {
	release(): Promise<void>;
}

/**
 * Common ancestor for every lock-acquisition refusal. Callers
 * (`index.ts:runOrExitOnLockConflict`) catch the base class so adding a
 * new refusal reason can't silently skip the friendly exit-1 path —
 * compare to pre-base enumerations like
 * `err instanceof ServerLockConflictError || err instanceof ...`,
 * which once missed `ServerLockHostCollisionError` and let it propagate
 * as an unhandled throw with a stack trace.
 */
export class ServerLockError extends Error {
	constructor(message: string, name: string) {
		super(message);
		this.name = name;
	}
}

export class ServerLockConflictError extends ServerLockError {
	constructor(conflictPid: number, conflictPolicy: boolean, requestedPolicy: boolean) {
		super(
			`Another markdown-mcp server (PID ${conflictPid}) is running on this vault with ` +
				`--include-hidden=${conflictPolicy}. This process requested --include-hidden=${requestedPolicy}. ` +
				`Stop the other server or match its flag.`,
			"ServerLockConflictError",
		);
	}
}

export class ServerLockFileNotRegularError extends ServerLockError {
	constructor(path: string, kind: string) {
		super(
			`Server lockfile ${path} is not a regular file (${kind}); refusing to overwrite.`,
			"ServerLockFileNotRegularError",
		);
	}
}

/**
 * A live peer holds a lockfile we can't parse even after a retry that
 * overshoots the wx-write race by 2-3 orders of magnitude. Either the
 * file is genuinely corrupted, written by a future format version, or a
 * hostile planted opaque junk. We can't validate the peer's policy, so
 * we refuse to coexist rather than fall back to "assume same policy"
 * (which would let opposite-policy peers silently share a WAL on the
 * wx-write race window).
 */
export class ServerLockUnknownPeerError extends ServerLockError {
	constructor(pid: number, path: string) {
		super(
			`Another markdown-mcp server (PID ${pid}) is running on this vault but its lockfile at ${path} ` +
				`is unparseable. Stop the other server, or remove the lockfile if you're certain the process has exited.`,
			"ServerLockUnknownPeerError",
		);
	}
}

/**
 * Foreign host owns our PID-named slot. PIDs are per-host on POSIX, so on
 * a shared mount a foreign-host markdown-mcp can hold `server-<ourPID>.lock`
 * while still alive on its host. Unlinking would orphan its lock and let
 * both hosts write the WAL — refuse to start instead. Symmetric with
 * `inspectForeignSlot`'s hostname-precedes-PID-liveness rule.
 */
export class ServerLockHostCollisionError extends ServerLockError {
	constructor(path: string, foreignHostname: string) {
		super(
			`Another markdown-mcp server (PID ${process.pid} on host ${foreignHostname}) ` +
				`holds the lockfile at ${path}. Cross-host mounts are not supported. ` +
				`Stop the other server, or remove the lockfile if you're certain the holder has exited.`,
			"ServerLockHostCollisionError",
		);
	}
}

/**
 * Our PID-named slot is persistently unparseable after the wx-write race
 * retry. Without a parseable `hostname` we can't apply the cross-host
 * collision defense, so we refuse to overwrite — a foreign-host peer
 * (PID collision across hosts) may legitimately hold the slot.
 */
export class ServerLockOwnSlotUnparseableError extends ServerLockError {
	constructor(path: string) {
		super(
			`Another markdown-mcp server may be holding the lockfile at ${path} (our PID ${process.pid}); ` +
				`its content is unparseable, so we can't verify whether it's a foreign-host peer mid-startup. ` +
				`Refusing to overwrite. Remove the lockfile manually if you're certain no other server holds it.`,
			"ServerLockOwnSlotUnparseableError",
		);
	}
}

/**
 * Live peer indexes a different file-extension set. Shared WAL with
 * divergent `VAULT_EXTENSIONS` envs would let each peer's prune drop
 * the other peer's rows on every reconcile — oscillation.
 */
export class ServerLockExtensionConflictError extends ServerLockError {
	constructor(conflictPid: number, conflictExts: ReadonlyArray<string>, requestedExts: ReadonlyArray<string>) {
		super(
			`Another markdown-mcp server (PID ${conflictPid}) is running on this vault with ` +
				`VAULT_EXTENSIONS=${conflictExts.join(",")}. This process has VAULT_EXTENSIONS=${requestedExts.join(",")}. ` +
				`Stop the other server or match the env.`,
			"ServerLockExtensionConflictError",
		);
	}
}

const LOCK_FILE_PREFIX = "server-";
const LOCK_FILE_SUFFIX = ".lock";
const LOCK_NAME_RE = /^server-(\d+)\.lock$/;
/** Legacy single-file lockfile path; cleaned up at startup. */
export const LEGACY_LOCK_FILE_NAME = "server.lock";

/** POSIX `pid_t` is signed int32; above this Node's `process.kill` rejects. */
const POSIX_PID_MAX = 0x7fff_ffff;
/** Win32 PIDs are `DWORD` (unsigned int32); values above this can't exist. */
const WIN32_PID_MAX = 0xffff_ffff;

/**
 * Filename + body-parse gate for foreign lockfiles. Win32 accepts the
 * full `DWORD` range (legitimate high PIDs still flow through
 * `inspectForeignSlot`'s fail-closed PID-probe path); values above
 * {@link WIN32_PID_MAX} can't be real PIDs so a planted bogus filename
 * reads as "no peer" instead of blocking startup. POSIX caps at
 * {@link POSIX_PID_MAX} (round-42's silent-skip for impossible PIDs).
 */
function isAcceptableLockSlotPid(n: number): boolean {
	if (!Number.isInteger(n) || n <= 0) return false;
	if (process.platform === "win32") return n <= WIN32_PID_MAX;
	return n <= POSIX_PID_MAX;
}

export function lockFileNameForPid(pid: number): string {
	return `${LOCK_FILE_PREFIX}${pid}${LOCK_FILE_SUFFIX}`;
}

interface LockFileRecord {
	includeHidden: boolean;
	/** Absent in legacy lockfiles (pre-hostname field) → treat as same-host. */
	hostname?: string;
	/**
	 * Set only for legacy lockfiles, which stored the writer's PID in
	 * the file body because they didn't encode it in the filename.
	 * Current per-PID files carry the PID in the filename and leave
	 * this field absent.
	 */
	pid?: number;
	/** Sorted lowercase extensions (no leading dot). Absent in legacy
	 *  lockfiles; {@link recordExts} normalizes the missing case. */
	vaultExtensions?: ReadonlyArray<string>;
}

/** Sorted form of {@link DEFAULT_EXTENSIONS} for the legacy-record fallback. */
const LEGACY_LOCK_DEFAULT_EXTS: ReadonlyArray<string> = [...DEFAULT_EXTENSIONS].sort();

function parseLockFile(text: string): LockFileRecord | null {
	try {
		const parsed: unknown = JSON.parse(text);
		if (typeof parsed !== "object" || parsed === null) return null;
		const obj = parsed as { includeHidden?: unknown; hostname?: unknown; pid?: unknown; vaultExtensions?: unknown };
		if (typeof obj.includeHidden !== "boolean") return null;
		const record: LockFileRecord = { includeHidden: obj.includeHidden };
		if (typeof obj.hostname === "string") record.hostname = obj.hostname;
		if (typeof obj.pid === "number" && isAcceptableLockSlotPid(obj.pid)) {
			record.pid = obj.pid;
		}
		if (Array.isArray(obj.vaultExtensions) && obj.vaultExtensions.every((s) => typeof s === "string")) {
			record.vaultExtensions = obj.vaultExtensions as ReadonlyArray<string>;
		}
		return record;
	} catch {
		return null;
	}
}

/** Normalize legacy/missing field to the default — see {@link LockFileRecord.vaultExtensions}. */
function recordExts(record: LockFileRecord): ReadonlyArray<string> {
	return record.vaultExtensions ?? LEGACY_LOCK_DEFAULT_EXTS;
}

/** Set-equality. `parseLockFile` doesn't re-sort on read, so an externally
 *  written or manually-edited lockfile may carry unsorted lists. */
function extensionsMatch(a: ReadonlyArray<string>, b: ReadonlyArray<string>): boolean {
	if (a.length !== b.length) return false;
	const ax = [...a].sort();
	const bx = [...b].sort();
	return ax.every((v, i) => v === bx[i]);
}

/**
 * Returns the foreign hostname when `record` was written on a different
 * host than ours; `null` for same-host or legacy (no `hostname` field).
 * Centralizes the "absent hostname = treat as same-host" legacy-compat
 * rule for callers that need to refuse / skip foreign-host lockfiles.
 */
function foreignHostnameOf(record: LockFileRecord): string | null {
	if (record.hostname === undefined) return null;
	return record.hostname === hostname() ? null : record.hostname;
}

/**
 * POSIX `kill(pid, 0)` is the standard liveness probe — sends no
 * signal, only runs the permission check. ESRCH = dead. Anything else
 * (alive, EPERM foreign owner, unexpected errno) treats as alive:
 * refusing to overwrite is safer than stomping a foreign-user server.
 *
 * `pid === process.pid` is reachable only via a foreign filename slot
 * `server-<ourpid>.lock` left by a same-PID predecessor (PID reuse from
 * a previous markdown-mcp process). Treat as stale: we own this PID for
 * the lifetime of this process, so anyone else's claim against it is
 * already settled.
 */
function isProcessAlive(pid: number): boolean {
	if (pid === process.pid) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return getErrnoCode(err) !== "ESRCH";
	}
}

/**
 * Simultaneous-start tiebreaker: older lockfile mtime wins. Equal mtimes
 * (FAT/exFAT 2 s, sub-µs NVMe ties) fall through to lower-PID-wins.
 *
 * Residual: a wall-clock backstep (NTP step adjustment) between two
 * wx-writes inverts the natural ordering — both peers think they won.
 * Vanishingly rare under `chronyd` slewing or after the initial NTP sync.
 */
function weArrivedFirst(ourMtimeMs: number, otherMtimeMs: number, otherPid: number): boolean {
	if (ourMtimeMs < otherMtimeMs) return true;
	if (ourMtimeMs > otherMtimeMs) return false;
	return process.pid < otherPid;
}

function logTiebreakerWin(otherPath: string, otherPid: number, conflictAttr: string): void {
	console.error(
		`markdown-mcp serverLock: conflicting peer at ${otherPath} (PID ${otherPid}, ${conflictAttr}) ` +
			`arrived after us; continuing. Peer will observe our older mtime and exit.`,
	);
}

/**
 * Unparseable foreign content with a known PID: a live PID is either a
 * live local peer or a PID-collision foreign peer; both warrant refusal.
 * Dead PIDs on shared mounts can't be safely distinguished from a live
 * foreign-host owner with the same numeric PID, so preserve the slot for
 * operator inspection.
 */
function escalateUnparseableForeign(otherPath: string, otherPid: number, contextSuffix: string = ""): void {
	if (isProcessAlive(otherPid)) {
		throw new ServerLockUnknownPeerError(otherPid, otherPath);
	}
	console.error(
		`markdown-mcp serverLock: unparseable foreign slot at ${otherPath} (PID ${otherPid})${contextSuffix} ${ESRCH_PRESERVE_SUFFIX}`,
	);
}

/**
 * Cross-host lockfiles share a single log shape: PIDs can't cross hosts,
 * so liveness is un-probeable; we don't unlink (might be a live foreign
 * owner) and don't escalate (might collide with an unrelated local PID).
 * `contextSuffix` distinguishes the rotation case ("vanished during
 * rotation") from the stable-file case.
 */
function logForeignHostLeftInPlace(otherPath: string, foreignHostname: string, contextSuffix: string = ""): void {
	console.error(
		`markdown-mcp serverLock: foreign-host lockfile at ${otherPath} (hostname=${foreignHostname})${contextSuffix}; ` +
			`cross-host mounts are not supported, leaving in place.`,
	);
}

type EntryKind = "symlink" | "directory" | "fifo" | "block-device" | "char-device" | "socket" | "non-regular";

function kindOf(st: Stats | BigIntStats): EntryKind {
	if (st.isSymbolicLink()) return "symlink";
	if (st.isDirectory()) return "directory";
	if (st.isFIFO()) return "fifo";
	if (st.isBlockDevice()) return "block-device";
	if (st.isCharacterDevice()) return "char-device";
	if (st.isSocket()) return "socket";
	return "non-regular";
}

type StatResult = { kind: "absent" } | { kind: "regular"; stats: Stats } | { kind: "non-regular"; stats: Stats };

async function statEntry(path: string): Promise<StatResult> {
	try {
		const stats = await lstat(path);
		if (stats.isFile()) return { kind: "regular", stats };
		return { kind: "non-regular", stats };
	} catch (err) {
		if (getErrnoCode(err) === "ENOENT") return { kind: "absent" };
		throw err;
	}
}

/**
 * Caller MUST NOT proceed to open the SQLite cache when this throws
 * {@link ServerLockConflictError} or {@link ServerLockFileNotRegularError}
 * — the conflict means another process owns the policy view, and the
 * not-regular error means a hostile vault planted a non-regular file at
 * our lockfile path.
 */
export async function acquireServerLock(opts: ServerLockOptions): Promise<ServerLockHandle> {
	const ourPath = join(opts.indexDir, lockFileNameForPid(process.pid));
	const ourExts = [...getVaultExtensions()].sort();
	const payload = `${JSON.stringify({
		includeHidden: opts.includeHidden,
		hostname: hostname(),
		vaultExtensions: ourExts,
	})}\n`;

	await acquireOwnSlot(ourPath, payload);

	const handle: ServerLockHandle = {
		release: async () => {
			await rm(ourPath, { force: true });
		},
	};

	// Conflict scan must run AFTER our wx — a concurrent peer's wx may
	// land between our hypothetical pre-wx readdir and our own write,
	// leaving its slot unseen. Single readdir handles both legacy
	// cleanup and foreign-PID scan. `onSlotCreated` fires first so the
	// caller publishes the handle before reconcile's potential sleep.
	try {
		// ENOENT here (our slot vanished between wx and lstat — hostile
		// env) routes through the existing rm + throw path.
		const ourMtimeMs = (await lstat(ourPath)).mtimeMs;
		if (opts.onSlotCreated) await opts.onSlotCreated(handle);
		await reconcileIndexDir(opts.indexDir, opts.includeHidden, ourExts, ourPath, ourMtimeMs);
	} catch (err) {
		await rm(ourPath, { force: true });
		throw err;
	}

	return handle;
}

/**
 * Atomic create at the own-PID slot. Cold path: 1 syscall (`open`).
 * PID-reuse path: `open` (EEXIST) → `lstat` → `readAndParseWithRetry` →
 * `lstat` → `unlink` → `open`. Hostile pre-plant path: `open` (EEXIST) →
 * `lstat` → throw. The EEXIST → lstat classification is the only retry
 * trigger; a second EEXIST after we unlinked our own slot signals a
 * genuinely racing peer (impossible by PID uniqueness) and propagates as
 * a hard error.
 */
async function acquireOwnSlot(ourPath: string, payload: string): Promise<void> {
	try {
		await writeFile(ourPath, payload, { flag: "wx" });
		return;
	} catch (err) {
		if (getErrnoCode(err) !== "EEXIST") throw err;
	}
	const probe = await statEntry(ourPath);
	if (probe.kind === "non-regular") {
		throw new ServerLockFileNotRegularError(ourPath, kindOf(probe.stats));
	}
	if (probe.kind === "regular") {
		// Read BEFORE unlinking: a foreign-host server on a shared mount can
		// hold our PID-named slot; rm'ing on observed-unparseable would
		// orphan a live foreign-host lock during the wx-write visibility
		// window. Retry absorbs the race; persistent unparseable is
		// ambiguous (refuse rather than rm).
		const record = await readAndParseWithRetry(ourPath, "own-slot collision");
		if (record === "unparseable") {
			throw new ServerLockOwnSlotUnparseableError(ourPath);
		}
		if (record !== "absent") {
			const foreign = foreignHostnameOf(record);
			if (foreign !== null) {
				throw new ServerLockHostCollisionError(ourPath, foreign);
			}
		}
		// Re-stat before rm to detect a non-regular swap during the
		// readAndParseWithRetry window. The initial lstat above confirmed
		// regular at EEXIST time; a hostile swap during either the
		// first-read `O_NOFOLLOW` open (ELOOP/ENXIO → "absent") or the
		// 25 ms retry sleep (reprobe non-regular → "absent") would
		// otherwise fall through to the rm and bypass
		// `ServerLockFileNotRegularError`. Residual sub-ms TOCTOU between
		// this probe and the rm is accepted — mirrors the first lstat's
		// existing window.
		const repostProbe = await statEntry(ourPath);
		if (repostProbe.kind === "non-regular") {
			throw new ServerLockFileNotRegularError(ourPath, kindOf(repostProbe.stats));
		}
		// Same-host or legacy no-hostname is a prior-us remnant —
		// `isProcessAlive(process.pid)` is false by the line-161 invariant.
		try {
			await rm(ourPath, { force: true });
		} catch (err) {
			// Hostile swap may have landed between repostProbe and rm: `rm`
			// without `recursive: true` rejects a directory with EISDIR
			// (Node-docs behavior). Re-route through the same defense the
			// upstream probes use so the race surfaces as a typed domain
			// error instead of a raw fs SystemError. Windows is more
			// timing-prone here than POSIX (coarser timer resolution +
			// slower mkdir), but the race is platform-agnostic.
			const recheck = await statEntry(ourPath);
			if (recheck.kind === "non-regular") {
				throw new ServerLockFileNotRegularError(ourPath, kindOf(recheck.stats));
			}
			if (recheck.kind !== "absent") throw err;
		}
	}
	// kind === "absent" reached only if something unlinked our slot
	// between our EEXIST and our lstat — race-tolerant retry.
	await writeFile(ourPath, payload, { flag: "wx" });
}

/**
 * Single readdir pass: legacy `server.lock` cleanup AND foreign per-PID
 * slot inspection share the same enumeration.
 */
async function reconcileIndexDir(
	indexDir: string,
	ourPolicy: boolean,
	ourExts: ReadonlyArray<string>,
	ourPath: string,
	ourMtimeMs: number,
): Promise<void> {
	let entries: string[];
	try {
		entries = await readdir(indexDir);
	} catch (err) {
		if (getErrnoCode(err) === "ENOENT") return;
		throw err;
	}
	for (const name of entries) {
		if (name === LEGACY_LOCK_FILE_NAME) {
			await cleanupLegacyEntry(join(indexDir, name), ourPolicy, ourExts);
			continue;
		}
		const m = LOCK_NAME_RE.exec(name);
		if (m === null) continue;
		const otherPath = join(indexDir, name);
		if (otherPath === ourPath) continue;
		const otherPid = Number.parseInt(m[1] ?? "0", 10);
		if (!isAcceptableLockSlotPid(otherPid)) continue;
		await inspectForeignSlot(otherPath, otherPid, ourPolicy, ourExts, ourMtimeMs);
	}
}

async function cleanupLegacyEntry(
	legacyPath: string,
	ourPolicy: boolean,
	ourExts: ReadonlyArray<string>,
): Promise<void> {
	const probe = await statEntry(legacyPath);
	if (probe.kind === "absent") return;
	if (probe.kind === "non-regular") {
		// `unlink` doesn't follow symlinks, but we still refuse to remove
		// non-regular legacy entries — they could be user-managed pointers
		// the operator deliberately placed.
		console.error(
			`markdown-mcp serverLock: leaving non-regular legacy entry at ${legacyPath} (${kindOf(probe.stats)})`,
		);
		return;
	}

	// Legacy owners don't scan per-PID slots, so we detect their liveness
	// ourselves — otherwise a still-running legacy server keeps its WAL
	// handle alongside ours under a possibly-conflicting policy.
	const record = await readAndParseWithRetry(legacyPath, "legacy lockfile");
	if (record === "absent") return;
	if (record === "unparseable" || record.pid === undefined) {
		// Persistent after retry: legacy files always carried a PID, so
		// this can't be a future-format peer — genuinely corrupted or
		// PID-less.
		await rm(legacyPath, { force: true });
		return;
	}

	if (!isProcessAlive(record.pid)) {
		console.error(
			`markdown-mcp serverLock: legacy lockfile at ${legacyPath} (PID ${record.pid}) ${ESRCH_PRESERVE_SUFFIX}`,
		);
		return;
	}

	if (record.includeHidden !== ourPolicy) {
		throw new ServerLockConflictError(record.pid, record.includeHidden, ourPolicy);
	}

	const theirExts = recordExts(record);
	if (!extensionsMatch(theirExts, ourExts)) {
		throw new ServerLockExtensionConflictError(record.pid, theirExts, ourExts);
	}

	// Same-policy live legacy owner: leave the file alone, its
	// shutdown handler will unlink it.
	console.error(
		`markdown-mcp serverLock: legacy lock at ${legacyPath} (PID ${record.pid}) running with matching policy; coexisting.`,
	);
}

async function inspectForeignSlot(
	otherPath: string,
	otherPid: number,
	ourPolicy: boolean,
	ourExts: ReadonlyArray<string>,
	ourMtimeMs: number,
): Promise<void> {
	const probe = await statEntry(otherPath);
	if (probe.kind === "absent") return;
	if (probe.kind === "non-regular") {
		// Foreign non-regular entries we don't touch; the own-PID slot is
		// the only one we hard-refuse on. A hostile vault planting weird
		// names at random PID slots doesn't compromise our own slot.
		console.error(
			`markdown-mcp serverLock: ignoring non-regular foreign entry at ${otherPath} (${kindOf(probe.stats)})`,
		);
		return;
	}
	// Read the lockfile BEFORE probing PID liveness. PIDs are per-host on
	// POSIX, so a foreign-host server's PID is rarely alive locally; an
	// ESRCH-then-unlink ordered before the hostname read would clobber
	// foreign-host slots whenever their PIDs aren't in use locally — the
	// common case for cross-host mounts.
	let otherRecord = await readForeignRecord(otherPath, otherPid);
	if (otherRecord === "absent") return;
	if (otherRecord === "unparseable") {
		escalateUnparseableForeign(otherPath, otherPid);
		return;
	}

	// Re-stat so the tiebreaker uses the mtime of the file `readForeignRecord`
	// actually parsed: its retry chain can survive a peer's rm+wx rotation
	// and return the rotated successor, so the initial `probe` may reflect
	// the predecessor. Comparing our wx-write against the stale mtime would
	// let a younger peer wrongly force us out.
	let freshProbe = await statEntry(otherPath);
	if (freshProbe.kind === "absent") {
		// Round-32's "hostname check precedes PID-liveness" rule: foreign-host
		// PIDs are normally ESRCH locally on shared NFS/SMB mounts, so the
		// dead-PID fast-path below would silently absorb the foreign-host
		// rotation case and lose the operator log emitted by the post-reread
		// cross-host branch. `readForeignRecord` already gave us a parsed
		// record whose hostname we can consult.
		const earlyForeignHostname = foreignHostnameOf(otherRecord);
		if (earlyForeignHostname !== null) {
			logForeignHostLeftInPlace(otherPath, earlyForeignHostname, " vanished during rotation");
			return;
		}
		// Same-host (or legacy no-hostname): dead PID can't be mid-rotation;
		// skip the 100 ms wait. The exhaustion path below reaches the same
		// outcome via `escalateUnparseableForeign`'s alive/dead dispatch.
		if (!isProcessAlive(otherPid)) return;
		// Otherwise a PID-recycling peer's `acquireOwnSlot` rm→wx may be
		// mid-rotation. Reuse the rotation budget (see {@link MAX_MISMATCH_RETRIES}).
		for (let i = 0; i < MAX_MISMATCH_RETRIES; i++) {
			await sleep(UNPARSEABLE_RETRY_DELAY_MS);
			freshProbe = await statEntry(otherPath);
			if (freshProbe.kind !== "absent") break;
		}
		if (freshProbe.kind === "absent") {
			// Persistent absent + budget exhausted: predecessor either
			// finished exiting (PID now dead) OR a slow-rotation owner
			// exists at the recycled PID (alive). Fail closed via the alive/
			// dead dispatch — silent return would let an opposite-policy
			// peer share the WAL once its wx finally completes.
			escalateUnparseableForeign(otherPath, otherPid, " after persistent absent reprobes");
			return;
		}
		if (freshProbe.kind === "non-regular") {
			console.error(
				`markdown-mcp serverLock: foreign slot at ${otherPath} (PID ${otherPid}) became ${kindOf(freshProbe.stats)} after rotation; skipping.`,
			);
			return;
		}
		const reread = await readForeignRecord(otherPath, otherPid);
		if (reread === "absent") return;
		if (reread === "unparseable") {
			escalateUnparseableForeign(otherPath, otherPid, " after rotation");
			return;
		}
		otherRecord = reread;
		// `readAndParseWithRetry` can sleep across a second rotation while
		// completing the reread, leaving `freshProbe.stats` stale relative
		// to the file we parsed. Refresh so the tiebreaker compares against
		// the parsed record's actual mtime.
		freshProbe = await statEntry(otherPath);
	}
	if (freshProbe.kind === "absent") {
		// Parsed peer + no fresh mtime → can't tiebreak; fail closed instead
		// of silent return (would let opposite-policy peer share the WAL).
		escalateUnparseableForeign(otherPath, otherPid, " after reread freshProbe vanished");
		return;
	}
	if (freshProbe.kind === "non-regular") {
		// Post-parse TOCTOU swap loses the parsed policy/extension signal;
		// silent return would let an opposite-policy peer share the WAL.
		// Round-43 precedent (`acquireOwnSlot` re-stat-before-rm).
		console.error(
			`markdown-mcp serverLock: foreign slot at ${otherPath} (PID ${otherPid}) swapped to ${kindOf(freshProbe.stats)} ` +
				`after successful parse; refusing to coexist.`,
		);
		throw new ServerLockUnknownPeerError(otherPid, otherPath);
	}
	const otherMtimeMs = freshProbe.stats.mtimeMs;

	// Cross-host mounts aren't supported (SQLite WAL is already
	// single-host); `process.kill(pid, 0)` can't validate a foreign-host
	// PID, so leave the slot alone — don't unlink (might belong to a
	// live foreign-host owner), don't escalate (might collide with an
	// unrelated local PID). Operators see the log line.
	const foreignHostname = foreignHostnameOf(otherRecord);
	if (foreignHostname !== null) {
		logForeignHostLeftInPlace(otherPath, foreignHostname);
		return;
	}

	// Same-host (or legacy no-hostname): NOW the PID probe is meaningful.
	if (!isProcessAlive(otherPid)) {
		await rm(otherPath, { force: true });
		return;
	}

	if (otherRecord.includeHidden !== ourPolicy) {
		if (weArrivedFirst(ourMtimeMs, otherMtimeMs, otherPid)) {
			logTiebreakerWin(otherPath, otherPid, `--include-hidden=${otherRecord.includeHidden}`);
			return;
		}
		throw new ServerLockConflictError(otherPid, otherRecord.includeHidden, ourPolicy);
	}

	const theirExts = recordExts(otherRecord);
	if (!extensionsMatch(theirExts, ourExts)) {
		if (weArrivedFirst(ourMtimeMs, otherMtimeMs, otherPid)) {
			logTiebreakerWin(otherPath, otherPid, `VAULT_EXTENSIONS=${theirExts.join(",")}`);
			return;
		}
		throw new ServerLockExtensionConflictError(otherPid, theirExts, ourExts);
	}
}

/**
 * Absorbs the `fs.writeFile(wx)` content-visibility race: `open` →
 * `write` → `close` leaves the file visible empty between syscalls 1
 * and 2 (sub-ms window for ~30-byte payloads). Pre-fix logic fell back
 * to "assume same policy", letting opposite-policy peers silently
 * coexist on the WAL. Retry once after a backoff that overshoots the
 * race by 2-3 orders of magnitude; persistent unparseable content
 * escalates via the caller ({@link ServerLockUnknownPeerError} for
 * foreign per-PID slots, `rm` for legacy lockfiles).
 *
 * Reprobe stats AFTER the sleep so a TOCTOU swap to symlink/FIFO during
 * the backoff routes through `"absent"` (skip slot, don't `rm` —
 * `"unparseable"` + dead-PID would destroy a deliberate operator-placed
 * pointer). The initial open is hardened separately in `readAndParse`.
 *
 * Two independent retry budgets — neither steals slots from the other:
 *   - Content-unparseable (wx visibility race): 1 retry / 2 reads max.
 *     Genuine content corruption shouldn't be masked further.
 *   - Dev/ino mismatch: up to {@link MAX_MISMATCH_RETRIES} retries (1
 *     initial + 4 retries = 5 reads max). Slow AV/SMB rm+wx peer
 *     rotation can exceed a single 25 ms window.
 *
 * Worst-case combined budget: 1 unparseable + 5 mismatch = 6 reads /
 * 5 sleeps / 125 ms. Bounded.
 *
 * Once a mismatch has been observed, a subsequent absent reprobe is
 * treated as rotation-in-progress (returns `"unparseable"`) so
 * `inspectForeignSlot` escalates via the live-peer path.
 */
async function readAndParseWithRetry(
	path: string,
	contextLog: string,
): Promise<LockFileRecord | "absent" | "unparseable"> {
	let mismatchSeen = 0;
	let unparseableSeen = 0;
	for (;;) {
		const result = await readAndParse(path);
		if (result === "absent") return mismatchSeen > 0 ? "unparseable" : "absent";
		if (result !== "unparseable" && result !== "unparseable_mismatch") return result;
		if (result === "unparseable_mismatch") mismatchSeen += 1;
		else unparseableSeen += 1;
		if (mismatchSeen > MAX_MISMATCH_RETRIES || unparseableSeen > 1) return "unparseable";
		console.error(
			`markdown-mcp serverLock: ${result} ${contextLog} at ${path}; retrying after ${UNPARSEABLE_RETRY_DELAY_MS} ms.`,
		);
		await sleep(UNPARSEABLE_RETRY_DELAY_MS);
		const reprobe = await statEntry(path);
		if (reprobe.kind === "absent") return mismatchSeen > 0 ? "unparseable" : "absent";
		if (reprobe.kind === "non-regular") {
			console.error(
				`markdown-mcp serverLock: ${contextLog} at ${path} became ${kindOf(reprobe.stats)} during retry; skipping.`,
			);
			return "absent";
		}
	}
}

async function readForeignRecord(
	otherPath: string,
	otherPid: number,
): Promise<LockFileRecord | "absent" | "unparseable"> {
	return readAndParseWithRetry(otherPath, `lockfile from live PID ${otherPid}`);
}

/**
 * @internal Test-only re-export of {@link readAndParse}. Production
 * callers reach it via `readAndParseWithRetry`. Tests need direct
 * invocation because `inspectForeignSlot`'s lstat gates a static
 * non-regular path before {@link readAndParse} runs, so the defense
 * can't be exercised through the public API.
 */
export async function readAndParseForTesting(otherPath: string): Promise<LockFileRecord | "absent" | "unparseable"> {
	const result = await readAndParse(otherPath);
	return result === "unparseable_mismatch" ? "unparseable" : result;
}

/**
 * @internal Test-only re-export of {@link readAndParseWithRetry}. The
 * mismatch-fail-closed contract lives in this retry orchestrator and
 * can't be exercised through the public API without spinning up a full
 * foreign-slot scenario.
 */
export async function readAndParseWithRetryForTesting(
	otherPath: string,
	contextLog: string,
): Promise<LockFileRecord | "absent" | "unparseable"> {
	return readAndParseWithRetry(otherPath, contextLog);
}

/**
 * Defensive open against a TOCTOU swap between `inspectForeignSlot`'s
 * lstat and this read. Without `O_NOFOLLOW | O_NONBLOCK` a plain `open`
 * would follow a swapped-in symlink (info leak via the 4 KB cap) or
 * block on a swapped-in FIFO (startup DoS). ELOOP (symlink) and ENXIO
 * (FIFO without writer) route to `"absent"` — skip slot, don't unlink
 * (might be a deliberate operator-placed pointer), mirroring the
 * reprobe non-regular branch. Post-open `fstat` catches the FIFO-with-
 * writer case where `O_NONBLOCK` returns a usable handle delivering
 * writer-controlled bytes.
 *
 * Windows: pre-open `lstat` + post-open dev/ino compare substitutes for
 * the stripped `O_NOFOLLOW` (see `openNoFollow` for the symmetric defense).
 * A dev/ino mismatch (peer's rm+wx during the open window) returns the
 * internal `"unparseable_mismatch"` sentinel so {@link readAndParseWithRetry}
 * can apply a longer retry budget AND fail closed if the path subsequently
 * vanishes during rotation — silent skip would let an opposite-policy peer
 * share the SQLite WAL. A post-open `lstat` then mirrors
 * `openNoFollow`'s `!leafStat.isSymbolicLink()` + dev/ino-match check —
 * closes the rename-then-symlink-back-to-same-inode contract gap (dev/ino
 * vs preLstat alone misses it because the symlink target IS the original
 * inode, so `handle.stat()` matches preLstat despite the path being a
 * symlink).
 */
async function readAndParse(
	otherPath: string,
): Promise<LockFileRecord | "absent" | "unparseable" | "unparseable_mismatch"> {
	// `bigint: true` so the dev/ino compare keeps full 64-bit precision —
	// see `openNoFollow` in `validatePath.ts` for the rationale.
	let preLstat: BigIntStats | null = null;
	if (process.platform === "win32") {
		try {
			preLstat = await lstat(otherPath, { bigint: true });
		} catch (err) {
			const code = getErrnoCode(err);
			if (code === "ENOENT" || code === "ENOTDIR") return "absent";
			throw err;
		}
		// Windows `fs.open(O_RDONLY)` fails before returning a handle for ANY
		// non-regular target (symlink → EACCES/ELOOP, directory → EISDIR,
		// FIFO/device → varying errno); the post-open `handle.stat()` skip
		// path below never runs. Catch all non-regular kinds here so the
		// foreign slot is skipped gracefully (mirrors POSIX behavior where
		// `open` on a directory succeeds and `handle.stat().isFile()` rejects).
		if (!preLstat.isFile()) {
			console.error(
				`markdown-mcp serverLock: foreign slot at ${otherPath} non-regular at open (lstat: ${kindOf(preLstat)}); skipping.`,
			);
			return "absent";
		}
	}
	let handle: FileHandle | null = null;
	try {
		handle = await open(otherPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
	} catch (err) {
		const code = getErrnoCode(err);
		if (code === "ENOENT" || code === "ENOTDIR") {
			// preLstat saw the file → vanish is peer rotation, not absence.
			// Trigger dev/ino retry instead of silent "absent" (would let
			// opposite-policy peer share the WAL when wx lands).
			if (preLstat !== null) {
				console.error(
					`markdown-mcp serverLock: foreign slot at ${otherPath} vanished between preLstat and open (${code}); treating as unparseable_mismatch to trigger retry.`,
				);
				return "unparseable_mismatch";
			}
			return "absent";
		}
		// ELOOP (symlink at leaf, blocked by O_NOFOLLOW) and ENXIO (FIFO with
		// no writer, surfaced by O_NONBLOCK) cannot come from a regular file.
		if (code === "ELOOP" || code === "ENXIO") {
			console.error(`markdown-mcp serverLock: foreign slot at ${otherPath} non-regular at open (${code}); skipping.`);
			return "absent";
		}
		// EISDIR/EACCES are ambiguous on Win32 (libuv junction/dir-symlink
		// quirk vs ACL deny / share-lock on a regular file). Post-error
		// lstat fails closed when inconclusive.
		if (code === "EISDIR" || code === "EACCES") {
			let postStat: Stats;
			try {
				postStat = await lstat(otherPath);
			} catch (lstatErr) {
				if (isVanishedErrno(lstatErr)) {
					return "absent";
				}
				throw err;
			}
			if (!postStat.isFile()) {
				console.error(`markdown-mcp serverLock: foreign slot at ${otherPath} non-regular at open (${code}); skipping.`);
				return "absent";
			}
		}
		throw err;
	}
	try {
		const st = await handle.stat({ bigint: true });
		if (!st.isFile()) {
			console.error(`markdown-mcp serverLock: foreign slot at ${otherPath} not a regular file post-open; skipping.`);
			return "absent";
		}
		if (preLstat !== null && (st.ino !== preLstat.ino || st.dev !== preLstat.dev)) {
			// File got recreated between preLstat and open() — most commonly
			// a peer's `acquireOwnSlot` rm+wx after PID reuse.
			// Returning "absent" would silently miss the new owner's lockfile
			// and let an opposite-policy peer share the WAL. The dedicated
			// `unparseable_mismatch` sentinel triggers the longer retry budget
			// in `readAndParseWithRetry` AND forces an absent reprobe to
			// escalate (rotation-in-progress, not a genuine vanish).
			console.error(
				`markdown-mcp serverLock: foreign slot at ${otherPath} swapped during open (dev/ino mismatch); treating as unparseable_mismatch to trigger retry.`,
			);
			return "unparseable_mismatch";
		}
		// POSIX exempt: kernel-honored O_NOFOLLOW surfaces ELOOP at the
		// open, so the path-stability gap (see function doc) only exists
		// on Win32 where libuv strips the flag.
		if (process.platform === "win32") {
			let postLstat: BigIntStats;
			try {
				postLstat = await lstat(otherPath, { bigint: true });
			} catch (err) {
				if (isVanishedErrno(err)) return "unparseable_mismatch";
				throw err;
			}
			if (st.ino !== postLstat.ino || st.dev !== postLstat.dev || !postLstat.isFile()) {
				console.error(
					`markdown-mcp serverLock: foreign slot at ${otherPath} unstable post-open ` +
						`(kind=${kindOf(postLstat)}, handle ${st.ino}/${st.dev} vs path ${postLstat.ino}/${postLstat.dev}); ` +
						`treating as unparseable_mismatch.`,
				);
				return "unparseable_mismatch";
			}
		}
		const buf = Buffer.alloc(MAX_LOCKFILE_BYTES + 1);
		const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
		if (bytesRead > MAX_LOCKFILE_BYTES) return "unparseable";
		const text = buf.subarray(0, bytesRead).toString("utf8");
		return parseLockFile(text) ?? "unparseable";
	} finally {
		await handle.close();
	}
}
