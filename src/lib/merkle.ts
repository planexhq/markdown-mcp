/**
 * Periodic reconciliation tick. Catches the cases the watcher misses:
 * unwatched FS edits (rare on macOS/Linux/Windows; possible on network
 * mounts), index corruption, and missed unlink events.
 *
 * v1 scope: set-diff + per-file mtime comparison, NOT a per-directory
 * Merkle hash. The exit criterion is "catches a manually-corrupted index
 * file" (IMPLEMENTATION_PLAN line 82) — set-diff via mtime is sufficient
 * and far simpler. Module name kept as `merkle.ts` for stability so a
 * future v1.x upgrade to true per-directory hashing is non-breaking.
 *
 * Sets `_meta.index_status.state = "reconciling"` while running. Reads
 * continue serving from the prior snapshot under WAL — `replaceFile`
 * commits per-file in atomic transactions, so a concurrent reader sees
 * either the old or the new state, never a half-update.
 */

import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

import { errorMessage, getErrnoCode, isVanishedErrno } from "./error.js";
import { isUnderFailedSubtree } from "./failedSubtrees.js";
import { isHiddenName, isIndexCachePath } from "./hiddenPath.js";
import type { IndexHandle } from "./index/IndexHandle.js";
import { confirmAndPrune, confirmPrune, type IndexOutcome } from "./index/scanner.js";
import { passesPathPolicy, type VaultRoot } from "./validatePath.js";
import { isParseablePath } from "./vaultExtensions.js";
import type { WriteCoordinator } from "./writeCoordinator.js";

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;
const REINDEX_BATCH = 16;
const STAT_BATCH = 64;

export interface MerkleTickOptions {
	vaultRoot: VaultRoot;
	index: IndexHandle;
	/**
	 * Per-file FIFO shared with watcher / scanner. Merkle's reindex AND
	 * remove paths route through here so concurrent watcher events on
	 * the same file order against this tick. A direct `reindexFile` call
	 * would race `replaceFile` against any in-flight watcher reindex
	 * without the last-stat-wins guarantee.
	 */
	coordinator: WriteCoordinator;
	/**
	 * Returns the per-file outcome so merkle can track parse_failed
	 * during reconcile. Without the outcome surfacing, a recovered
	 * subtree containing a malformed note would silently flip the
	 * warming index to warm despite missing its rows.
	 */
	reindexFile: (relpath: string) => Promise<IndexOutcome>;
	intervalMs?: number;
	includeHidden?: boolean;
}

export interface MerkleTickHandle {
	/**
	 * Stop the periodic timer AND wait for any in-flight tick to settle.
	 * Async so shutdown can `await merkleTick.stop()` and be sure no
	 * `replaceFile` or `removeFile` is still racing `closeSqlite`.
	 */
	stop(): Promise<void>;
	/** One-shot reconciliation pass. Used by tests; the timer calls this internally. */
	runOnce(): Promise<void>;
}

export function startMerkleTick(opts: MerkleTickOptions): MerkleTickHandle {
	const { vaultRoot, index, coordinator, reindexFile, intervalMs = DEFAULT_INTERVAL_MS, includeHidden = false } = opts;
	let stopped = false;
	let inFlightPromise: Promise<void> | null = null;

	const runOnce = async (): Promise<void> => {
		if (stopped) return;
		if (inFlightPromise) return inFlightPromise;
		const started = index.getStatus().state;
		const work = (async () => {
			let result: ReconcileResult | null = null;
			try {
				if (started === "warm") {
					index.setStatus("reconciling");
				}
				result = await reconcile(vaultRoot, index, coordinator, reindexFile, includeHidden);
			} catch (err) {
				console.error(`markdown-mcp merkle: tick failed: ${errorMessage(err)}`);
			} finally {
				const current = index.getStatus().state;
				if (current === "reconciling") {
					index.setStatus("warm");
				}
				// Mirror scanner end-of-pass: clear/set so a recovered
				// subtree drops the degraded flag without a restart, and
				// a fresh EACCES surfaces without waiting for the next
				// cold scan. Skip on reconcile throw (`result === null`).
				if (result !== null) {
					index.setFailedSubtreesPresent(result.failedSubtrees.size > 0);
				}
				// Finalize whenever a clean pass discovered scan_complete is
				// still false. Two arcs hit this branch: (1) cold/warming →
				// warm (initial scan, or partial scan recovered by merkle);
				// (2) warm → reconciling → warm with scan_complete=false
				// (warm restart that lost finalization — interrupted
				// reconcile, prior failed-subtree warm restart). Without
				// this, arc-2 indices need a process restart to flip
				// scan_complete. markScanFinalized is idempotent on
				// already-finalized state.
				if (
					result !== null &&
					!index.getScanComplete() &&
					result.failedSubtrees.size === 0 &&
					result.failedFiles.size === 0 &&
					!index.hasPendingRetries()
				) {
					index.markScanFinalized();
					console.error("markdown-mcp merkle: index finalized after clean reconcile.");
				}
				inFlightPromise = null;
			}
		})();
		inFlightPromise = work;
		return work;
	};

	const handle = setInterval(() => {
		void runOnce();
	}, intervalMs);
	// Don't keep the event loop alive solely for the merkle tick; the MCP
	// stdio transport is what should hold the process open.
	if (typeof handle.unref === "function") handle.unref();

	return {
		stop: async () => {
			stopped = true;
			clearInterval(handle);
			// Settle any in-flight tick so a SIGTERM can't race
			// `replaceFile` against `closeSqlite`.
			if (inFlightPromise) await inFlightPromise;
		},
		runOnce,
	};
}

interface ReconcileResult {
	failedSubtrees: ReadonlySet<string>;
	failedFiles: ReadonlySet<string>;
}

/**
 * Walks the vault, partitions against the indexed set, and runs the
 * three reconcile passes (parse new, parse drifted, prune vanished).
 * Returns the per-pass failure sets:
 *   - `failedSubtrees`: subtree relpaths whose `readdir` failed with a
 *     non-deletion errno (EACCES, EMFILE, EIO, …).
 *   - `failedFiles`: relpaths whose reindex returned `parse_failed` or
 *     threw — `runOnce` gates warming → warm finalization on both being
 *     empty, so a partial recovery doesn't silently advertise as ready.
 */
async function reconcile(
	vaultRoot: VaultRoot,
	index: IndexHandle,
	coordinator: WriteCoordinator,
	reindexFile: (relpath: string) => Promise<IndexOutcome>,
	includeHidden: boolean,
): Promise<ReconcileResult> {
	const onDisk = new Set<string>();
	// Subtrees whose `readdir` failed with non-deletion errno (EACCES, EMFILE,
	// EIO, …). Files under these prefixes stay in the index — a transient
	// permission blip on a network mount must not silently drop valid rows.
	const failedSubtrees = new Set<string>();
	for await (const rel of walkVaultMarkdown(vaultRoot.absolute, "", includeHidden, failedSubtrees)) {
		onDisk.add(rel);
	}

	const indexed = new Set(index.listIndexedFiles());

	// Partition `indexed ∪ onDisk` into the three disjoint sets the
	// reconcile passes act on. Single iteration vs walking each side twice.
	const newFiles: string[] = [];
	const removalCandidates: string[] = [];
	const driftCandidates: string[] = [];
	for (const rel of onDisk) {
		if (indexed.has(rel)) driftCandidates.push(rel);
		else newFiles.push(rel);
	}
	for (const rel of indexed) {
		if (onDisk.has(rel)) continue;
		if (isUnderFailedSubtree(rel, failedSubtrees)) continue;
		removalCandidates.push(rel);
	}

	// Three passes act on disjoint relpaths. Parse work in step 1 (new)
	// and step 3 (drifted reindex) competes for CPU and shares the
	// scanner's `concurrency:4` budget — sequence those so combined
	// fanout stays at `REINDEX_BATCH=16`. Drift DETECTION (stat-only,
	// I/O-bound) doesn't compete with parses, so kick it off in parallel
	// with step 1's parses; await its result before the drift reindex
	// pass. Step 2 (prune) routes removeFile through the coordinator
	// alongside its lstat batches and overlaps independently.
	const failedFiles = new Set<string>();
	const driftedPromise = detectDrifted(driftCandidates, vaultRoot, index);
	const parsePasses = (async () => {
		await batchedReindex(newFiles, coordinator, reindexFile, "new", failedFiles);
		const drifted = await driftedPromise;
		await batchedReindex(drifted, coordinator, reindexFile, "drift", failedFiles);
		// Backstop the scanner BUSY race: pending entries whose row drift
		// detection now sees as in-sync are unreachable via the new/drifted/
		// removal partitions. Reindex once; re-BUSY stays pending and the
		// next tick retries.
		if (index.hasPendingRetries()) {
			const pending = index.pendingRetriesSnapshot();
			const newSet = new Set(newFiles);
			const driftedSet = new Set(drifted);
			const removalSet = new Set(removalCandidates);
			const pendingBackstop: string[] = [];
			for (const rel of pending) {
				if (!onDisk.has(rel)) continue;
				if (newSet.has(rel) || driftedSet.has(rel) || removalSet.has(rel)) continue;
				pendingBackstop.push(rel);
			}
			await batchedReindex(pendingBackstop, coordinator, reindexFile, "pending", failedFiles);
		}
	})();
	const prunePass = pruneVanished(removalCandidates, vaultRoot, coordinator, index, includeHidden);
	await Promise.all([parsePasses, prunePass]);
	return { failedSubtrees, failedFiles };
}

/**
 * Reindex a list of relpaths in fixed-size batches through the
 * coordinator. Used for both "new on disk" (step 1) and "mtime drift"
 * (step 3) — same shape, only the log label differs. Without batching, a
 * 100k-file drift wave (e.g. post-`rsync` of an old backup) would fan
 * out 100k parses simultaneously and saturate the event loop.
 *
 * `failedFiles` is an OUT param: parse_failed outcomes AND thrown errors
 * record the relpath so `runOnce` can keep state at `warming` until the
 * next reconcile fully recovers them.
 */
async function batchedReindex(
	files: ReadonlyArray<string>,
	coordinator: WriteCoordinator,
	reindexFile: (relpath: string) => Promise<IndexOutcome>,
	label: "new" | "drift" | "pending",
	failedFiles: Set<string>,
): Promise<void> {
	for (let i = 0; i < files.length; i += REINDEX_BATCH) {
		const batch = files.slice(i, i + REINDEX_BATCH);
		await Promise.all(
			batch.map(async (rel) => {
				try {
					const outcome = await coordinator.enqueue(rel, () => reindexFile(rel));
					if (outcome === "parse_failed") failedFiles.add(rel);
				} catch (err) {
					console.error(`markdown-mcp merkle: reindex ${label} ${rel}: ${errorMessage(err)}`);
					// Conservative: treat unknown errors as failures.
					failedFiles.add(rel);
				}
			}),
		);
	}
}

async function pruneVanished(
	removalCandidates: ReadonlyArray<string>,
	vaultRoot: VaultRoot,
	coordinator: WriteCoordinator,
	index: IndexHandle,
	includeHidden: boolean,
): Promise<void> {
	const retiredAt = Date.now();
	// Stat-confirm before pruning: `onDisk` was captured before `indexed`,
	// so a file added by the watcher between the two captures would
	// otherwise be removed despite still existing on disk.
	await confirmAndPrune(removalCandidates, vaultRoot, includeHidden, async (rel) => {
		await coordinator.enqueue(rel, async () => {
			// Re-confirm inside the coordinator window: the batched verdict is
			// up to N×lstat stale, and a watcher reindex of the same path
			// queues on this same coordinator key (FIFO-ordered ahead of this
			// task). Without the re-check, a recreated row is silently deleted.
			const stillStaleVerdict = await confirmPrune(rel, vaultRoot, includeHidden);
			if (!stillStaleVerdict) return;
			try {
				index.removeFile(rel, retiredAt);
				// Drain pendingRetries on a missed chokidar unlink — mirrors
				// watcher.ts's onUnlink path so `scan_complete` finalizes
				// without a process restart.
				if (index.clearPendingRetry(rel)) {
					console.error(`markdown-mcp: scan finalized after merkle reconcile (via: ${rel})`);
				}
			} catch (err) {
				console.error(`markdown-mcp merkle: removeFile ${rel}: ${errorMessage(err)}`);
			}
		});
	});
}

/**
 * Detect which `driftCandidates` have drifted via `(mtime, size)`
 * comparison. Stat-only — no parse, no write — so it can run alongside
 * parse-heavy work without competing for CPU. NULL `size` is the
 * runtime self-heal marker; treated as drift to force reindex.
 */
async function detectDrifted(
	driftCandidates: ReadonlyArray<string>,
	vaultRoot: VaultRoot,
	index: IndexHandle,
): Promise<string[]> {
	const drifted: string[] = [];
	for (let i = 0; i < driftCandidates.length; i += STAT_BATCH) {
		const batch = driftCandidates.slice(i, i + STAT_BATCH);
		const results = await Promise.all(
			batch.map(async (rel) => {
				const meta = index.getFileMeta(rel);
				if (meta === null) return null;
				try {
					const st = await stat(join(vaultRoot.absolute, rel));
					// Exact compare matches scanner's `isFileUnchanged`.
					// A tolerance band would let sub-ms edits with same
					// size hide stale rows until a larger drift fires.
					// NULL size = self-heal marker (corruption-recovery
					// residue or manual surgery) → must reindex; mirror
					// of `IndexHandle.isFileUnchanged`'s `row.size === null
					// → return false` rule.
					const mtimeDrift = st.mtimeMs !== meta.mtime;
					const sizeDrift = meta.size === null || st.size !== meta.size;
					return mtimeDrift || sizeDrift ? rel : null;
				} catch {
					// Stat failures route through reindex: ENOENT → vanished
					// (removeFile clears orphan); other errno → parse_failed
					// (failedFiles blocks finalize). Returning null here would
					// let finalize fire over un-recovered rows.
					return rel;
				}
			}),
		);
		for (const r of results) {
			if (r !== null) drifted.push(r);
		}
	}
	return drifted;
}

/**
 * `failedSubtrees` is an OUT param: subtrees whose `readdir` raised a
 * non-deletion errno are added (the empty string represents the vault
 * root). The caller threads this Set into the prune pass to skip removals
 * for files under unenumerated prefixes — matches scanner.ts:243-269.
 */
async function* walkVaultMarkdown(
	root: string,
	relParent: string,
	includeHidden: boolean,
	failedSubtrees: Set<string>,
): AsyncGenerator<string> {
	const dirAbs = relParent ? join(root, relParent) : root;
	let entries: import("node:fs").Dirent[];
	try {
		entries = (await readdir(dirAbs, { withFileTypes: true, encoding: "utf8" })) as import("node:fs").Dirent[];
	} catch (err) {
		// ENOENT/ENOTDIR: directory genuinely vanished → existing rows under
		// this prefix should be pruned (file is gone). Other errno (EACCES,
		// EMFILE, EIO, …): we can't enumerate, but files may still exist;
		// preserve their rows so a transient blip doesn't drop search hits.
		if (isVanishedErrno(err)) return;
		console.error(
			`markdown-mcp merkle: skipping subtree ${relParent || "(vault root)"} (readdir error: ${getErrnoCode(err) ?? "unknown"})`,
		);
		failedSubtrees.add(relParent);
		return;
	}
	for (const entry of entries) {
		const name = entry.name;
		if (!includeHidden && isHiddenName(name)) continue;
		const childRel = relParent ? `${relParent}/${name}` : name;
		// Server's own cache dir is excluded regardless of `--include-hidden`
		// (mirrors `scanner.ts:walkVault` and `watcher.ts:shouldIgnore`).
		if (isIndexCachePath(childRel)) continue;
		if (entry.isSymbolicLink()) continue;
		if (entry.isDirectory()) {
			yield* walkVaultMarkdown(root, childRel, includeHidden, failedSubtrees);
			continue;
		}
		if (!entry.isFile()) continue;
		if (!isParseablePath(childRel)) continue;
		// Skip non-addressable paths so reindex doesn't trip parse_failed
		// every tick and wedge scan_complete=false.
		if (!passesPathPolicy(childRel)) continue;
		yield childRel;
	}
}
