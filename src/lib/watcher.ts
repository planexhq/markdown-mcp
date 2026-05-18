/**
 * File watcher integration. Wraps chokidar v4 with the project's
 * file-validity predicates (hidden / VAULT_EXTENSIONS) and routes
 * `add`/`change` events to scanner.reindexOne, `unlink` events to
 * IndexHandle.removeFile.
 *
 * `awaitWriteFinish` (`stabilityThreshold: 100`, `pollInterval: 50`)
 * coalesces editor atomic-rename saves (vim's `.swp → rename`,
 * VS Code's `tmp → rename`) — chokidar fires a single `change` once
 * the file size stabilizes, so we never reindex a half-written file.
 *
 * `polling` and `includeHidden` are programmatic-only in W4. CLI flag
 * wiring lands in W5 per IMPLEMENTATION_PLAN line 94.
 */

import type { Stats } from "node:fs";
import { relative } from "node:path";

import { watch as chokidarWatch, type FSWatcher } from "chokidar";

import { errorMessage } from "./error.js";
import { isHiddenPath, isIndexCachePath, isNonNfc } from "./hiddenPath.js";
import type { IndexHandle } from "./index/IndexHandle.js";
import type { IndexOutcome } from "./index/scanner.js";
import { toPosix } from "./pathPosix.js";
import { classifyRelpathPolicy, type VaultRoot } from "./validatePath.js";
import { isMarkdownPath } from "./vaultExtensions.js";
import type { WriteCoordinator } from "./writeCoordinator.js";

const STABILITY_THRESHOLD_MS = 100;
const POLL_INTERVAL_MS = 50;
const POLLING_INTERVAL_MS = 1000;
const POLLING_BINARY_INTERVAL_MS = 1500;

export interface WatcherOptions {
	vaultRoot: VaultRoot;
	index: IndexHandle;
	/**
	 * Per-file FIFO shared with scanner / merkle so writes serialize
	 * across components. Watcher's reindex AND unlink both enqueue here:
	 * a synchronous unlink would race an in-flight reindex's
	 * `replaceFile` and resurrect the file's rows.
	 */
	coordinator: WriteCoordinator;
	/**
	 * Called on `add`/`change` events to reindex the affected file. Watcher
	 * itself discards the outcome (last-stat-wins via the coordinator), but
	 * the type matches merkle's signature so a single callback can be wired
	 * to both. See merkle's `MerkleTickOptions.reindexFile`.
	 */
	reindexFile: (relpath: string) => Promise<IndexOutcome>;
	polling?: boolean;
	includeHidden?: boolean;
}

export interface Watcher {
	/** Resolves when chokidar emits its initial `ready` event. */
	ready(): Promise<void>;
	close(): Promise<void>;
}

/**
 * Start watching the vault. Caller is responsible for `close()` on shutdown.
 *
 * The watcher does NOT change `index_status.state`: bumping the snapshot
 * via `replaceFile` is enough to invalidate cursors on the read path,
 * and reads continue serving from the prior snapshot under WAL while
 * the per-file reindex commits.
 */
export function startWatcher(opts: WatcherOptions): Watcher {
	const { vaultRoot, index, coordinator, reindexFile, polling = false, includeHidden = false } = opts;

	const fsWatcher: FSWatcher = chokidarWatch(vaultRoot.absolute, {
		// `false` so chokidar emits `add` for every file it discovers during
		// its initial crawl. The race we're closing: a file created between
		// chokidar.start and chokidar.ready, AFTER scanVault's walk passed
		// its directory but BEFORE chokidar's crawl reached it, was
		// suppressed under `true` and missed by both paths until merkle's
		// next reconcile (~5 min). With `false`, chokidar always emits;
		// scanner's mtime-skip in indexOne makes the duplicate enqueue a
		// stat-only no-op when scanner already indexed the same file.
		ignoreInitial: false,
		persistent: true,
		followSymlinks: false,
		usePolling: polling,
		interval: polling ? POLLING_INTERVAL_MS : 100,
		binaryInterval: polling ? POLLING_BINARY_INTERVAL_MS : 300,
		depth: 99,
		awaitWriteFinish: { stabilityThreshold: STABILITY_THRESHOLD_MS, pollInterval: POLL_INTERVAL_MS },
		ignored: (path, stats) => shouldIgnore(path, stats, vaultRoot, includeHidden),
	});

	const enqueueReindex = (rel: string): void => {
		void coordinator.enqueue(rel, async () => {
			try {
				await reindexFile(rel);
			} catch (err) {
				console.error(`markdown-mcp watcher: reindex failed for ${rel}: ${errorMessage(err)}`);
			}
		});
	};

	const onChange = (absPath: string): void => {
		const rel = toVaultRelative(vaultRoot, absPath);
		if (rel === null) return;
		enqueueReindex(rel);
	};

	const onUnlink = (absPath: string): void => {
		const rel = toVaultRelative(vaultRoot, absPath);
		if (rel === null) return;
		// Queue through the coordinator so any in-flight reindex for this
		// file commits BEFORE the removeFile. A synchronous unlink would
		// let a pending `replaceFile` resurrect rows for a path that no
		// longer exists on disk.
		void coordinator.enqueue(rel, async () => {
			try {
				index.removeFile(rel, Date.now());
				// Drain pendingRetries on user-delete (unlink bypasses
				// reindexCallback) so the scan finalizes instead of staying
				// at `warming` until process restart.
				if (index.clearPendingRetry(rel)) {
					console.error(`markdown-mcp: scan finalized after watcher unlink (via: ${rel})`);
				}
			} catch (err) {
				console.error(`markdown-mcp watcher: removeFile failed for ${rel}: ${errorMessage(err)}`);
			}
		});
	};

	fsWatcher.on("add", onChange);
	fsWatcher.on("change", onChange);
	fsWatcher.on("unlink", onUnlink);
	fsWatcher.on("error", (err) => {
		console.error(`markdown-mcp watcher: ${errorMessage(err)}`);
	});

	// Eager listener so chokidar's `ready` event is captured even if no
	// caller has awaited `ready()` yet — `once("ready", …)` attached lazily
	// would never fire for an event that already passed.
	let resolveReady: (() => void) | null = null;
	const readyPromise = new Promise<void>((resolve) => {
		resolveReady = resolve;
	});
	fsWatcher.on("ready", () => {
		resolveReady?.();
	});
	const ready = (): Promise<void> => readyPromise;

	return {
		ready,
		close: async () => {
			// chokidar only; bounded drain is in index.ts so it caps
			// scanner / merkle tasks on the shared coordinator too.
			await fsWatcher.close();
		},
	};
}

export function toVaultRelative(vaultRoot: VaultRoot, absPath: string): string | null {
	const rel = relative(vaultRoot.absolute, absPath);
	if (rel === "") return null;
	const posixRel = toPosix(rel);
	if (classifyRelpathPolicy(posixRel) !== null) return null;
	if (isNonNfc(posixRel)) return null;
	return posixRel;
}

/**
 * `ignored` callback. Filters: non-NFC paths, the markdown-mcp index dir,
 * hidden paths (when `includeHidden` is off), and non-markdown files.
 * Directories are ALWAYS traversable — chokidar passes `stats?.isFile()`
 * so dir entries pass the markdown filter (they don't have an extension
 * to match) and recursion proceeds.
 */
function shouldIgnore(
	absPath: string,
	stats: Stats | undefined,
	vaultRoot: VaultRoot,
	includeHidden: boolean,
): boolean {
	const rel = relative(vaultRoot.absolute, absPath);
	if (rel === "") return false;
	const posixRel = toPosix(rel);
	// Mirror scanner's walkVault + merkle's walk: a path validatePath would
	// reject must never reach reindexOne. Otherwise chokidar's startup `add`
	// for `bad%20name.md` produces parse_failed → addPendingRetry, but the
	// other walks skip the same path so the entry has no drain channel and
	// `state` stays at warming forever.
	if (classifyRelpathPolicy(posixRel) !== null) return true;
	if (isNonNfc(posixRel)) return true;
	if (isIndexCachePath(posixRel)) return true;
	if (!includeHidden && isHiddenPath(posixRel)) return true;
	if (stats?.isFile() && !isMarkdownPath(posixRel)) return true;
	return false;
}
