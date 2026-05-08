#!/usr/bin/env node
/**
 * vault-mcp CLI entrypoint. Stdio-only per D22.
 *
 * NEVER write to stdout — that's the JSON-RPC transport channel. All
 * diagnostic logging goes to stderr (biome's `noConsole` rule permits
 * `console.error` / `console.warn`).
 *
 * Async-reconcile startup: open SQLite + serve immediately. If the DB
 * preexisted → `warm` and search is ready. Else → `cold`, scanner runs
 * in the background; search returns `INDEX_WARMING` until done while
 * bounded tools (outline / fragment / metadata) work via on-demand
 * parse. SIGTERM/SIGINT aborts the scanner with a 5 s drain budget,
 * closes the server, and `wal_checkpoint(TRUNCATE)`s the DB.
 */

import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { errorMessage } from "./lib/error.js";
import { createIndexHandle, type IndexHandle } from "./lib/index/IndexHandle.js";
import { type IndexOutcome, reindexOne, type ScanResult, scanVault } from "./lib/index/scanner.js";
import { closeSqlite, detectPreW4Schema, openSqliteWithRecovery } from "./lib/index/sqlite.js";
import { type MerkleTickHandle, startMerkleTick } from "./lib/merkle.js";
import { chooseStartupState } from "./lib/startup.js";
import {
	assertIndexFilesAreRegular,
	ensureIndexDirIsRealDir,
	PathValidationError,
	type VaultRoot,
	validateVaultRoot,
} from "./lib/validatePath.js";
import { startWatcher, type Watcher } from "./lib/watcher.js";
import { WriteCoordinator } from "./lib/writeCoordinator.js";
import { createServer } from "./server.js";

interface CliArgs {
	vault: string;
}

function parseCli(argv: string[]): CliArgs {
	const { values } = parseArgs({
		args: argv,
		options: {
			vault: { type: "string" },
			help: { type: "boolean", short: "h" },
		},
		strict: true,
		allowPositionals: false,
	});

	if (values.help) {
		console.error(USAGE);
		process.exit(0);
	}

	if (typeof values.vault !== "string" || values.vault.length === 0) {
		console.error("error: --vault <path> is required.\n");
		console.error(USAGE);
		process.exit(2);
	}

	return { vault: values.vault };
}

const USAGE = `vault-mcp ${process.env.npm_package_version ?? "1.0.0-w4"}

A read-only MCP server exposing a local markdown vault to AI agents.

Usage:
  vault-mcp --vault <path>

Options:
  --vault <path>   Absolute or relative path to the vault directory (required).
  -h, --help       Show this message.

The server speaks MCP over stdio. Connect from a compatible host
(Claude Desktop, Claude Code, Cursor, etc.).`;

const SHUTDOWN_DRAIN_MS = 5_000;
const DB_RELATIVE_PATH = ".vault-mcp/index.sqlite3";
const DRAIN_RETRY_PASSES = 3;

function printValidationError(err: PathValidationError): void {
	console.error(`error: ${err.payload.message}`);
	if (err.payload.reason !== undefined) {
		console.error(`reason: ${String(err.payload.reason)}`);
	}
}

async function runOrExitOnPathError<T>(fn: () => Promise<T>): Promise<T> {
	try {
		return await fn();
	} catch (err) {
		if (err instanceof PathValidationError) {
			printValidationError(err);
			process.exit(1);
		}
		throw err;
	}
}

/**
 * Watcher / merkle reindex outcome handler. `reindexImpl` is dependency-
 * injected so unit tests can simulate FileTooLargeError / SqliteError /
 * other throws from `reindexOne` without staging an 11 MB file or a
 * corrupt DB on disk.
 *
 * Both the try-side outcome AND a thrown error route through the same
 * post-block. Without that, a throw would skip the
 * `addPendingRetry`-while-warming gate and the scan could finalize warm
 * with a known-on-disk file unindexed.
 */
export function makeReindexCallback(
	vaultRoot: VaultRoot,
	index: IndexHandle,
	reindexImpl: (root: VaultRoot, idx: IndexHandle, rel: string) => Promise<IndexOutcome>,
): (rel: string) => Promise<IndexOutcome> {
	return async (rel: string): Promise<IndexOutcome> => {
		let outcome: IndexOutcome;
		try {
			outcome = await reindexImpl(vaultRoot, index, rel);
			if (outcome === "vanished") {
				// Race: file vanished between the watcher event / merkle reconcile
				// and `reindexOne`'s stat. The unlink-event path in watcher.ts
				// already calls `removeFile` directly, but missed events (and
				// merkleTick reconciles) can still flow through here — the prune
				// must happen or stale fragments/wikilinks linger.
				index.removeFile(rel, Date.now());
			}
		} catch (err) {
			console.error(`vault-mcp reindex: ${rel}: ${errorMessage(err)}`);
			// Surface unknown errors as parse_failed so merkle's reconcile
			// aggregates them and keeps the warming gate engaged.
			outcome = "parse_failed";
		}
		if (outcome === "indexed" || outcome === "vanished") {
			if (index.clearPendingRetry(rel)) {
				console.error(`vault-mcp: scan finalized after watcher recovery (via: ${rel})`);
			}
		} else if (outcome === "parse_failed") {
			// Gate on `scan_complete` not state: warm-restart's reconcile
			// keeps state=warm/reconciling while scan_complete=false, and
			// a watcher discovery in that window must arm finalization.
			// Post-warm parse failures (scan_complete=true) stay
			// user-error territory and don't re-flip state.
			if (!index.getScanComplete()) {
				index.addPendingRetry(rel);
			}
		}
		return outcome;
	};
}

async function main(): Promise<void> {
	const args = parseCli(process.argv.slice(2));

	const vaultRoot: VaultRoot = await runOrExitOnPathError(() => validateVaultRoot(args.vault));

	const dbPath = join(vaultRoot.absolute, DB_RELATIVE_PATH);
	const dbDir = dirname(dbPath);
	await runOrExitOnPathError(() => ensureIndexDirIsRealDir(dbDir));
	await mkdir(dbDir, { recursive: true });
	await runOrExitOnPathError(() => assertIndexFilesAreRegular(dbPath));
	const opened = await openSqliteWithRecovery({ dbPath });
	const index = createIndexHandle(opened.db);

	// Pre-W4 guard: rebuild `wikilinks` + `file_metrics` rows that
	// migrated-as-empty would otherwise stay empty under warm reconcile's
	// skip-unchanged fast path. See CLAUDE.md "Pre-W4 schema migration
	// guard" gotcha.
	if (detectPreW4Schema(opened.db)) {
		console.error(
			"vault-mcp index: pre-W4 schema detected (fragments populated; file_metrics empty); forcing full rescan.",
		);
		index.setScanComplete(false);
	}

	const decision = chooseStartupState({
		preexisted: opened.preexisted,
		scanComplete: index.getScanComplete(),
		everComplete: index.getEverComplete(),
		fileCount: index.countFiles(),
	});
	index.setStatus(decision.state);
	if (decision.log !== null) console.error(decision.log);
	const coordinator = new WriteCoordinator();
	const scanController = new AbortController();

	const reindexCallback = makeReindexCallback(vaultRoot, index, reindexOne);

	// Watcher starts before scanVault so a user edit during the scan
	// has an observer; the shared coordinator's per-file FIFO + per-task
	// stat-at-start gives last-stat-wins. Without this, edits during a
	// cold scan are invisible until the +5 min merkle tick.
	let watcher: Watcher | null = null;
	try {
		watcher = startWatcher({ vaultRoot, index, coordinator, reindexFile: reindexCallback });
	} catch (err) {
		console.error(`vault-mcp watcher: failed to start: ${errorMessage(err)}`);
	}

	// See CLAUDE.md "Scanner finalize race" gotcha. `coordinator.drain`
	// is single-pass; the bounded loop catches tasks enqueued during a
	// prior pass's await.
	const preFinalize = async (): Promise<void> => {
		if (watcher !== null) {
			try {
				await watcher.ready();
			} catch (err) {
				console.error(`vault-mcp scanner preFinalize: watcher.ready failed: ${errorMessage(err)}`);
			}
		}
		for (let i = 0; i < DRAIN_RETRY_PASSES; i++) {
			await coordinator.drain();
			if (!coordinator.hasActiveChains()) break;
		}
	};

	const startedAt = Date.now();
	const scanInProgress = scanVault({
		vaultRoot,
		index,
		coordinator,
		signal: scanController.signal,
		concurrency: 4,
		preFinalize,
		onProgress: (p) => {
			if (p.files_indexed % 100 === 0 && p.files_indexed > 0) {
				console.error(`vault-mcp scanner: ${p.files_indexed}/${p.files_total_estimate} (${p.phase})`);
			}
		},
	})
		.then((result) => {
			const elapsed = Date.now() - startedAt;
			console.error(
				`vault-mcp scanner: done in ${elapsed} ms (indexed=${result.filesIndexed} skipped=${result.filesSkipped} aborted=${result.aborted})`,
			);
			return result;
		})
		.catch((err: unknown) => {
			console.error(`vault-mcp scanner: failed: ${errorMessage(err)}`);
			return { filesIndexed: 0, filesSkipped: 0, aborted: false } satisfies ScanResult;
		});

	const server = createServer(vaultRoot, index);
	const transport = new StdioServerTransport();
	await server.connect(transport);
	console.error(`vault-mcp running on stdio (vault: ${vaultRoot.absolute}, db: ${dbPath})`);

	let merkleTick: MerkleTickHandle | null = null;
	let shuttingDown = false;
	// Merkle defers until scan drains: a periodic walk during initial
	// enumeration would compete with scanner's own walk for I/O and
	// produce duplicate work.
	scanInProgress
		.then(() => {
			if (shuttingDown) return;
			try {
				merkleTick = startMerkleTick({ vaultRoot, index, coordinator, reindexFile: reindexCallback });
			} catch (err) {
				console.error(`vault-mcp merkle: failed to start: ${errorMessage(err)}`);
			}
		})
		.catch((err: unknown) => {
			console.error(`vault-mcp startup: deferred chain failed: ${errorMessage(err)}`);
		});

	const shutdown = async (signal: string): Promise<void> => {
		if (shuttingDown) return;
		shuttingDown = true;
		console.error(`received ${signal}; shutting down.`);
		scanController.abort();
		// Two-phase drain: stop event producers (chokidar, merkle interval,
		// scanner) FIRST, then drain the coordinator. WriteCoordinator.drain
		// is a single-pass snapshot (writeCoordinator.ts:32-39) — running it
		// in parallel with watcher.close() lets a chokidar event mid-shutdown
		// enqueue a task AFTER the snapshot, racing closeSqlite. Phase order
		// guarantees the snapshot covers every chain. Both phases share the
		// SHUTDOWN_DRAIN_MS budget via a running clock.
		const startTime = Date.now();
		const remaining = (): number => Math.max(0, SHUTDOWN_DRAIN_MS - (Date.now() - startTime));
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			const producerStops = Promise.allSettled([
				merkleTick?.stop() ?? Promise.resolve(),
				watcher?.close() ?? Promise.resolve(),
				scanInProgress,
			]);
			const stopResult = await Promise.race([
				producerStops,
				new Promise<"timeout">((resolve) => {
					timer = setTimeout(() => resolve("timeout"), remaining());
				}),
			]);
			if (timer) clearTimeout(timer);
			timer = undefined;

			if (stopResult === "timeout") {
				console.error("vault-mcp: shutdown drain timeout (5 s) while stopping producers; proceeding with close.");
			} else {
				const labels = ["merkle stop", "watcher close", "scan"] as const;
				for (let i = 0; i < stopResult.length; i++) {
					const r = stopResult[i];
					if (r && r.status === "rejected") {
						console.error(`vault-mcp ${labels[i]}: ${errorMessage(r.reason)}`);
					}
				}
				const drainResult = await Promise.race([
					coordinator.drain().then(() => "drained" as const),
					new Promise<"timeout">((resolve) => {
						timer = setTimeout(() => resolve("timeout"), remaining());
					}),
				]);
				if (timer) clearTimeout(timer);
				timer = undefined;
				if (drainResult === "timeout") {
					console.error("vault-mcp: shutdown drain timeout while draining coordinator; proceeding with close.");
				}
			}
		} catch (err) {
			console.error(`vault-mcp: drain error: ${errorMessage(err)}`);
		} finally {
			if (timer) clearTimeout(timer);
		}
		try {
			await server.close();
		} catch (err) {
			console.error(`error during shutdown: ${errorMessage(err)}`);
		}
		try {
			closeSqlite(opened.db);
		} catch (err) {
			console.error(`error closing db: ${errorMessage(err)}`);
		}
		process.exit(0);
	};
	process.on("SIGTERM", () => {
		void shutdown("SIGTERM");
	});
	process.on("SIGINT", () => {
		void shutdown("SIGINT");
	});
}

// Gate `main()` on direct CLI invocation so programmatic importers
// (test files, future embedders) can pull in `makeReindexCallback`
// without triggering the bootstrap. Both sides resolve to realpath
// because Node ESM resolves `import.meta.url` against the realpath
// while `process.argv[1]` retains the typed-in path — npm bin
// symlinks and macOS /tmp → /private/tmp rewrites otherwise break
// the equality. (Node 22.18+ would let us use `import.meta.main`;
// package floor is 22.0.)
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

function realpathOrSelf(p: string): string {
	try {
		return realpathSync(p);
	} catch {
		return p;
	}
}

const argv1 = process.argv[1];
const isCliEntry = argv1 !== undefined && realpathOrSelf(argv1) === realpathOrSelf(fileURLToPath(import.meta.url));
if (isCliEntry) {
	main().catch((err: unknown) => {
		console.error(`fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
		process.exit(1);
	});
}
