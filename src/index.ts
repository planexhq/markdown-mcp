#!/usr/bin/env node
/**
 * markdown-mcp CLI entrypoint. Stdio-only per D22.
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
import { PassThrough } from "node:stream";
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

import { errorMessage } from "./lib/error.js";
import { detectCaseInsensitiveFs } from "./lib/fsDetect.js";
import { INDEX_DIR_NAME, setFsCaseInsensitive } from "./lib/hiddenPath.js";
import { createIndexHandle, type IndexHandle } from "./lib/index/IndexHandle.js";
import { type IndexOutcome, reindexOne, type ScanResult, scanVault } from "./lib/index/scanner.js";
import { closeSqlite, detectPreW4Schema, openSqliteWithRecovery } from "./lib/index/sqlite.js";
import type { InflightTracker } from "./lib/inflightTracker.js";
import { type MerkleTickHandle, startMerkleTick } from "./lib/merkle.js";
import { setProseOnly } from "./lib/proseOnly.js";
import { acquireServerLock, ServerLockError, type ServerLockHandle } from "./lib/serverLock.js";
import { chooseStartupState, computePolicyMismatch } from "./lib/startup.js";
import {
	assertIndexFilesAreRegular,
	ensureIndexDirIsRealDir,
	PathValidationError,
	type VaultRoot,
	validateVaultRoot,
} from "./lib/validatePath.js";
import { getSortedVaultExtensions } from "./lib/vaultExtensions.js";
import { PACKAGE_VERSION } from "./lib/version.js";
import { startWatcher, type Watcher } from "./lib/watcher.js";
import { WriteCoordinator } from "./lib/writeCoordinator.js";
import { createServer, type ServerInstance } from "./server.js";

interface CliArgs {
	vault: string;
	polling: boolean;
	includeHidden: boolean;
	proseOnly: boolean;
}

function parseCli(argv: string[]): CliArgs {
	const { values } = parseArgs({
		args: argv,
		options: {
			vault: { type: "string" },
			polling: { type: "boolean" },
			"include-hidden": { type: "boolean" },
			"prose-only": { type: "boolean" },
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

	return {
		vault: values.vault,
		polling: values.polling === true,
		includeHidden: values["include-hidden"] === true,
		proseOnly: values["prose-only"] === true,
	};
}

const USAGE = `markdown-mcp ${PACKAGE_VERSION}

A read-only MCP server giving AI agents structured access to a local markdown vault.

Usage:
  markdown-mcp --vault <path> [--polling] [--include-hidden] [--prose-only]

Options:
  --vault <path>     Absolute or relative path to the vault directory (required).
  --polling          Force chokidar to use fs.stat polling instead of native
                     file-system events. Use on network mounts and platforms
                     where native events fire unreliably (~10x slower; only
                     enable when needed).
  --include-hidden   Include dot-prefixed files and directories on every
                     surface (tree, search, fragment, links, note://). Default
                     excludes them. All-or-nothing per server.
  --prose-only       Omit 'structuredContent' from every tool response;
                     'content[0].text' (LLM-readable prose) becomes the only
                     channel. For clients that don't decode structured output
                     and operators wanting smaller MCP frames. Errors render
                     a structured prose body so candidates / progress /
                     retry_after_ms stay surfaced. note:// is unaffected.
  -h, --help         Show this message.

The server speaks MCP over stdio. Connect from a compatible host
(Claude Desktop, Claude Code, Cursor, etc.).`;

const SHUTDOWN_DRAIN_MS = 5_000;
const DB_RELATIVE_PATH = `${INDEX_DIR_NAME}/index.sqlite3`;
const DRAIN_RETRY_PASSES = 3;

/**
 * Test-only env-var hooks + injection messages. Exported so tests
 * reference the same string literals — silent no-op typos broke
 * earlier rounds. Prod-inert: every read is gated on the value, so
 * unset is the same as absent.
 */
export const TEST_ENV = {
	STARTUP_DELAY_MS: "MARKDOWN_MCP_TEST_STARTUP_DELAY_MS",
	STARTUP_FAIL_AFTER_LOCK: "MARKDOWN_MCP_TEST_STARTUP_FAIL_AFTER_LOCK",
	FAIL_AFTER_LOCK_MESSAGE: "test-injection: post-lock startup",
	/** Pause inside `acquireServerLock`'s `onSlotCreated` callback so a signal can land between own-slot creation and reconcile return. */
	RECONCILE_DELAY_MS: "MARKDOWN_MCP_TEST_RECONCILE_DELAY_MS",
} as const;

/**
 * JSON-RPC message-shape predicates for the inflight tracker hooks.
 * The SDK exports zod-backed `isJSONRPC*` helpers, but every send /
 * onmessage call would pay a full schema parse — overkill when the
 * transport only ever produces SDK-shaped messages. The shape checks
 * are sufficient to disambiguate request / response / notification.
 */
function isJsonRpcRequestShape(msg: unknown): boolean {
	return typeof msg === "object" && msg !== null && "id" in msg && "method" in msg;
}
function isJsonRpcResponseShape(msg: unknown): boolean {
	return typeof msg === "object" && msg !== null && "id" in msg && ("result" in msg || "error" in msg);
}

function printValidationError(err: PathValidationError): void {
	console.error(`error: ${err.payload.message}`);
	if (err.payload.reason !== undefined) {
		console.error(`reason: ${String(err.payload.reason)}`);
	}
}

/**
 * Best-effort teardown for a nullable resource. Skips on `null`, logs +
 * swallows errors so one failure doesn't abort the rest of the cleanup
 * chain. Shared by `shutdown()` (signal path; exits 0) and main's
 * post-lock catch (throw path; exits 1) so the two stay in sync as
 * resources are added.
 */
async function releaseIfPresent<T>(
	holder: T | null,
	label: string,
	release: (h: T) => Promise<void> | void,
): Promise<void> {
	if (holder === null) return;
	try {
		await release(holder);
	} catch (err) {
		console.error(`${label}: ${errorMessage(err)}`);
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

async function runOrExitOnLockConflict<T>(fn: () => Promise<T>): Promise<T> {
	try {
		return await fn();
	} catch (err) {
		if (err instanceof ServerLockError) {
			console.error(`error: ${err.message}`);
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
			console.error(`markdown-mcp reindex: ${rel}: ${errorMessage(err)}`);
			// Surface unknown errors as parse_failed so merkle's reconcile
			// aggregates them and keeps the warming gate engaged.
			outcome = "parse_failed";
		}
		if (outcome === "indexed" || outcome === "vanished") {
			if (index.clearPendingRetry(rel)) {
				console.error(`markdown-mcp: scan finalized after watcher recovery (via: ${rel})`);
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

	// Probe FS case-sensitivity before any code path consults
	// `isIndexCachePath` so the predicate uses byte-wise compare on
	// case-sensitive FS (preserving access to a legitimate `.Markdown-MCP/`
	// user directory) and case-fold on case-insensitive FS (where the
	// variant aliases to the cache and must be rejected).
	setFsCaseInsensitive(await detectCaseInsensitiveFs(vaultRoot.absolute));

	setProseOnly(args.proseOnly);

	const dbPath = join(vaultRoot.absolute, DB_RELATIVE_PATH);
	const dbDir = dirname(dbPath);
	await runOrExitOnPathError(() => ensureIndexDirIsRealDir(dbDir));
	await mkdir(dbDir, { recursive: true });
	await runOrExitOnPathError(() => assertIndexFilesAreRegular(dbPath));

	// Holders populated as startup progresses; `shutdown()` null-guards
	// each. Lets signal handlers be installed BEFORE `acquireServerLock`
	// so a SIGTERM during SQLite open / scanner setup / `server.connect`
	// releases the lockfile instead of leaking it via Node's default-exit
	// path.
	let lockHandle: ServerLockHandle | null = null;
	let openedDb: Awaited<ReturnType<typeof openSqliteWithRecovery>> | null = null;
	let coordinator: WriteCoordinator | null = null;
	let scanController: AbortController | null = null;
	let scanInProgress: Promise<ScanResult> | null = null;
	let watcher: Watcher | null = null;
	let merkleTick: MerkleTickHandle | null = null;
	let server: ServerInstance["server"] | null = null;
	let inflight: InflightTracker | null = null;
	let transport: Transport | null = null;
	let shuttingDown = false;

	// Order is load-bearing: drain in-flight handlers → stop producers →
	// drain coordinator → close server → close DB → release lock.
	// Releasing earlier opens a window for a concurrent opposite-policy
	// peer to acquire the lock and start writing the WAL we still hold.
	// `shuttingDown` guards double-call (signal during catch-path
	// teardown).
	const tearDownAndExit = async (reason: string, exitCode: number): Promise<void> => {
		if (shuttingDown) return;
		shuttingDown = true;
		console.error(reason);
		scanController?.abort();
		// Stop dispatching new RPC requests so they don't race the
		// later `server.close()` / `process.exit()` sequence. On signal-
		// driven shutdowns (SIGTERM / SIGINT / SIGHUP) stdin stays open
		// and a host can deliver a request between the drain's
		// count-to-zero observation and the final exit; without this
		// override the SDK's chained dispatcher would still call the
		// handler, the transport.send would race process.exit, and the
		// late response would be truncated. In-flight requests (already
		// past dispatch) are unaffected — they live in the SDK's
		// `_onrequest` promise chain, not gated by onmessage — so the
		// drain still completes them honestly.
		if (transport !== null) transport.onmessage = () => {};
		// Three-phase drain: (1) wait for outstanding MCP request handlers
		// so their responses land on stdout BEFORE `server.close()` + the
		// final `process.exit()` discard a partial stdout buffer — the
		// race that triggers when a client half-closes stdin while a big
		// `tools/call` is still mid-response. (2) Stop event producers
		// (chokidar, merkle interval, scanner). (3) Drain the
		// WriteCoordinator. WriteCoordinator.drain is a single-pass
		// snapshot — running it in parallel with watcher.close() lets a
		// chokidar event mid-shutdown enqueue a task AFTER the snapshot.
		// Phase order guarantees the snapshot covers every chain. All
		// three phases share the SHUTDOWN_DRAIN_MS budget via a running
		// clock.
		const startTime = Date.now();
		const remaining = (): number => Math.max(0, SHUTDOWN_DRAIN_MS - (Date.now() - startTime));
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			if (inflight !== null) {
				const inflightResult = await inflight.drain(remaining());
				if (inflightResult === "timeout") {
					console.error(
						`markdown-mcp: tearDown drain timeout while waiting for ${inflight.size()} in-flight request(s); proceeding with close.`,
					);
				}
			}
			const producerStops = Promise.allSettled([
				merkleTick?.stop() ?? Promise.resolve(),
				watcher?.close() ?? Promise.resolve(),
				scanInProgress ?? Promise.resolve(),
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
				console.error("markdown-mcp: tearDown drain timeout (5 s) while stopping producers; proceeding with close.");
			} else {
				const labels = ["merkle stop", "watcher close", "scan"] as const;
				for (let i = 0; i < stopResult.length; i++) {
					const r = stopResult[i];
					if (r && r.status === "rejected") {
						console.error(`markdown-mcp ${labels[i]}: ${errorMessage(r.reason)}`);
					}
				}
				if (coordinator !== null) {
					const drainResult = await Promise.race([
						coordinator.drain().then(() => "drained" as const),
						new Promise<"timeout">((resolve) => {
							timer = setTimeout(() => resolve("timeout"), remaining());
						}),
					]);
					if (timer) clearTimeout(timer);
					timer = undefined;
					if (drainResult === "timeout") {
						console.error("markdown-mcp: tearDown drain timeout while draining coordinator; proceeding with close.");
					}
				}
			}
		} catch (err) {
			console.error(`markdown-mcp: drain error: ${errorMessage(err)}`);
		} finally {
			if (timer) clearTimeout(timer);
		}
		await releaseIfPresent(server, "error during teardown", (s) => s.close());
		await releaseIfPresent(openedDb, "error closing db", (o) => closeSqlite(o.db));
		await releaseIfPresent(lockHandle, "error releasing server lock", (lh) => lh.release());
		process.exit(exitCode);
	};

	const shutdown = (signal: string): Promise<void> => tearDownAndExit(`received ${signal}; shutting down.`, 0);

	process.on("SIGTERM", () => {
		void shutdown("SIGTERM");
	});
	process.on("SIGINT", () => {
		void shutdown("SIGINT");
	});
	process.on("SIGHUP", () => {
		void shutdown("SIGHUP");
	});
	// PassThrough holder, populated AFTER lock acquisition. See the
	// `process.stdin.pipe(...)` site below for why the pipe doesn't run
	// pre-lock: spawnSync-style invocations close their pipe immediately,
	// which would race the lock-conflict error path and let the child
	// exit cleanly without surfacing the conflict.
	let stdinProxy: PassThrough | null = null;

	// Acquire BEFORE opening SQLite: a conflicting concurrent process must
	// not see our policy mismatch driving its own WAL writes, and we must
	// not see theirs. Same-policy concurrent processes are accepted (SQLite
	// WAL is multi-process safe under matching policy). `onSlotCreated`
	// publishes the handle before reconcile's (≥25 ms) unparseable-retry
	// sleep so a signal in that window finds `lockHandle` non-null.
	lockHandle = await runOrExitOnLockConflict(() =>
		acquireServerLock({
			indexDir: dbDir,
			includeHidden: args.includeHidden,
			onSlotCreated: async (h) => {
				lockHandle = h;
				const delay = Number.parseInt(process.env[TEST_ENV.RECONCILE_DELAY_MS] ?? "0", 10);
				if (delay > 0) {
					console.error(`markdown-mcp: ${TEST_ENV.RECONCILE_DELAY_MS}=${delay}; pausing.`);
					await sleep(delay);
				}
			},
		}),
	);

	try {
		// Pipe `process.stdin` to a PassThrough so EOF is detectable
		// during the post-lock startup window (SQLite open, scanner
		// setup, the test-injected startup delay). `process.stdin` is
		// paused by default; its `'end'` event only fires after the
		// stream is read past EOF, and the SDK transport doesn't attach
		// its data listener until `transport.start()` runs inside
		// `server.connect()` — well after this point. Without the pipe,
		// a client that closes stdin during startup is not noticed
		// until startup completes; the server keeps holding the lock
		// and running scanner work after the session is already gone.
		//
		// The pipe runs AFTER `acquireServerLock` so spawnSync-style
		// invocations (whose pipe stdin is at EOF from the start) still
		// surface lock conflicts as exit 1 via `runOrExitOnLockConflict`
		// before the stdin-EOF shutdown path can race them.
		stdinProxy = new PassThrough();
		const proxy = stdinProxy;
		// Forward stdin/proxy stream errors through the shutdown path
		// instead of letting Node's default unhandled-'error' behavior
		// terminate the process abruptly. The SDK transport attaches its
		// own error listener on `stdinProxy` only after `server.connect`
		// runs; before that, an error here (or one forwarded from
		// `process.stdin` via `pipe`'s onerror) would crash the process
		// per EventEmitter semantics. Listeners on both streams are
		// needed because `pipe`'s internal onerror destroys `dest` with
		// the error when `dest` has no other error listener — emitting
		// a fresh 'error' on `stdinProxy` that we must also catch.
		const onStdinStreamError = (err: unknown): void => {
			console.error(`markdown-mcp: stdin stream error: ${errorMessage(err)}`);
			void shutdown("STDIN_ERROR");
		};
		process.stdin.once("error", onStdinStreamError);
		proxy.once("error", onStdinStreamError);
		process.stdin.once("end", () => {
			// If the proxy has buffered bytes when `process.stdin` EOFs,
			// the client sent valid request(s) (e.g. `initialize`) then
			// closed stdin to signal "done sending." Defer shutdown to
			// the proxy's own `'end'` — the transport (when `server.
			// connect` runs) consumes the buffer, the wrapped
			// `transport.send` resolves into `inflight.exit()`, and the
			// proxy emits `'end'` once its writable side is closed AND
			// its readable buffer is drained. Without this branch the
			// buffered payload would be dropped: shutdown would fire
			// before `server.connect` ever attached a data listener.
			// Empty buffer at EOF → the original prompt-shutdown case
			// (client gave up without sending anything).
			if (proxy.readableLength === 0) {
				void shutdown("STDIN_EOF");
				return;
			}
			proxy.once("end", () => {
				void shutdown("STDIN_EOF");
			});
		});
		process.stdin.pipe(stdinProxy);

		// Test-only deterministic pause between lock-acquisition and the rest
		// of startup. The `index.signalDuringStartup` test uses it to SIGTERM
		// during the protected window and verify the lockfile is cleaned up.
		const startupDelayMs = Number.parseInt(process.env[TEST_ENV.STARTUP_DELAY_MS] ?? "0", 10);
		if (startupDelayMs > 0) {
			console.error(`markdown-mcp: ${TEST_ENV.STARTUP_DELAY_MS}=${startupDelayMs}; pausing.`);
			await sleep(startupDelayMs);
		}

		// Test-only fault injection: lets `test/index.startupThrow.test.ts`
		// verify the catch releases the lockfile when post-lock startup throws.
		if (process.env[TEST_ENV.STARTUP_FAIL_AFTER_LOCK] === "1") {
			throw new Error(TEST_ENV.FAIL_AFTER_LOCK_MESSAGE);
		}

		openedDb = await openSqliteWithRecovery({ dbPath });
		// Non-null view for downstream code; `openedDb` (`T | null`) stays as
		// the holder `shutdown()` reads.
		const opened = openedDb;
		// D47 — canonicalize the running VAULT_EXTENSIONS once (sorted
		// lowercase comma-joined). Passed to `createIndexHandle` so
		// `markScanFinalized` persists this exact string and to
		// `computePolicyMismatch` so the disk-vs-running comparison uses
		// byte-equal canonical forms.
		const vaultExtensionsSnapshot = getSortedVaultExtensions().join(",");
		const index = createIndexHandle(opened.db, {
			includeHidden: args.includeHidden,
			vaultExtensions: vaultExtensionsSnapshot,
		});

		index.sweepIndexCacheRows();

		// Pre-W4 guard: rebuild `wikilinks` + `file_metrics` rows that
		// migrated-as-empty would otherwise stay empty under warm reconcile's
		// skip-unchanged fast path. See CLAUDE.md "Pre-W4 schema migration
		// guard" gotcha.
		if (detectPreW4Schema(opened.db)) {
			console.error(
				"markdown-mcp index: pre-W4 schema detected (fragments populated; file_metrics empty); forcing full rescan.",
			);
			index.setScanComplete(false);
		}

		// Policy flip invalidates row population (off→on undercounts; on→off
		// serves stale hidden rows). `computePolicyMismatch` collapses two
		// signals into one boolean: last-clean mismatch AND interrupted-
		// scan mismatch. See {@link computePolicyMismatch}.
		const scanComplete = index.getScanComplete();
		const policyMismatch = computePolicyMismatch({
			preexisted: opened.preexisted,
			scanComplete,
			includeHiddenPolicy: index.getIncludeHiddenPolicy(),
			inflightIncludeHidden: index.getInflightIncludeHidden(),
			argIncludeHidden: args.includeHidden,
			vaultExtensionsPolicy: index.getVaultExtensionsPolicy(),
			argVaultExtensions: vaultExtensionsSnapshot,
		});
		const decision = chooseStartupState({
			preexisted: opened.preexisted,
			scanComplete,
			everComplete: index.getEverComplete(),
			fileCount: index.countFiles(),
			policyMismatch,
		});
		if (policyMismatch) {
			// Defeats warm-reconcile's (mtime, size) skip so the walk
			// re-enumerates hidden files (off→on adds rows; on→off relies
			// on `confirmPrune` which fires regardless).
			index.setScanComplete(false);
		}
		index.setStatus(decision.state);
		if (decision.log !== null) console.error(decision.log);
		coordinator = new WriteCoordinator();
		scanController = new AbortController();
		// Non-null aliases for closure capture: `preFinalize` and the
		// deferred merkle `.then` can't narrow the `T | null` holders across
		// the async boundary.
		const coordinatorRef = coordinator;
		const scanControllerRef = scanController;

		const reindexCallback = makeReindexCallback(vaultRoot, index, (root, idx, rel) =>
			reindexOne(root, idx, rel, args.includeHidden),
		);

		// Watcher starts before scanVault so a user edit during the scan
		// has an observer; the shared coordinator's per-file FIFO + per-task
		// stat-at-start gives last-stat-wins. Without this, edits during a
		// cold scan are invisible until the +5 min merkle tick.
		try {
			watcher = startWatcher({
				vaultRoot,
				index,
				coordinator: coordinatorRef,
				reindexFile: reindexCallback,
				polling: args.polling,
				includeHidden: args.includeHidden,
			});
		} catch (err) {
			console.error(`markdown-mcp watcher: failed to start: ${errorMessage(err)}`);
		}

		// See CLAUDE.md "Scanner finalize race" gotcha. `coordinator.drain`
		// is single-pass; the bounded loop catches tasks enqueued during a
		// prior pass's await.
		const preFinalize = async (): Promise<void> => {
			if (watcher !== null) {
				try {
					await watcher.ready();
				} catch (err) {
					console.error(`markdown-mcp scanner preFinalize: watcher.ready failed: ${errorMessage(err)}`);
				}
			}
			for (let i = 0; i < DRAIN_RETRY_PASSES; i++) {
				await coordinatorRef.drain();
				if (!coordinatorRef.hasActiveChains()) break;
			}
		};

		const startedAt = Date.now();
		scanInProgress = scanVault({
			vaultRoot,
			index,
			coordinator: coordinatorRef,
			signal: scanControllerRef.signal,
			concurrency: 4,
			preFinalize,
			includeHidden: args.includeHidden,
			onProgress: (p) => {
				if (p.files_indexed % 100 === 0 && p.files_indexed > 0) {
					console.error(`markdown-mcp scanner: ${p.files_indexed}/${p.files_total_estimate} (${p.phase})`);
				}
			},
		})
			.then((result) => {
				const elapsed = Date.now() - startedAt;
				console.error(
					`markdown-mcp scanner: done in ${elapsed} ms (indexed=${result.filesIndexed} skipped=${result.filesSkipped} aborted=${result.aborted})`,
				);
				return result;
			})
			.catch((err: unknown) => {
				console.error(`markdown-mcp scanner: failed: ${errorMessage(err)}`);
				return { filesIndexed: 0, filesSkipped: 0, aborted: false } satisfies ScanResult;
			});

		const instance = createServer(vaultRoot, index, {
			includeHidden: args.includeHidden,
		});
		server = instance.server;
		inflight = instance.inflight;
		// `stdinProxy` is the post-lock-acquire pipe target (see top of
		// try block). The transport reads from it instead of
		// `process.stdin` so early-startup EOF detection on `process.stdin`
		// works without the transport stealing data from it.
		if (stdinProxy === null) throw new Error("stdinProxy must be initialized before connecting the transport.");
		transport = new StdioServerTransport(stdinProxy);

		// Wire the inflight counter at the transport boundary so the
		// teardown drain spans the full request lifecycle, including the
		// SDK's `await transport.send(response)` step. Tracking the
		// handler promise alone left a window where `count === 0` between
		// `handler(request)` resolving and `transport.send(response)`
		// awaiting stdout drain — a large or backpressured reply was lost
		// to `process.exit()`. See `lib/inflightTracker.ts` for the
		// invariant.
		//
		// Both hooks are installed BEFORE `server.connect`: the SDK's
		// `connect` captures the existing `transport.onmessage` and
		// chain-calls it before its own dispatch (`protocol.js:234-249`),
		// so our `enter()` fires before the SDK invokes the request
		// handler. `transport.send` is read fresh on every send call, so
		// our wrapper is used for all outgoing messages.
		const originalSend = transport.send.bind(transport);
		transport.send = async (message) => {
			try {
				await originalSend(message);
			} finally {
				if (isJsonRpcResponseShape(message)) instance.inflight.exit();
			}
		};
		transport.onmessage = (message) => {
			if (isJsonRpcRequestShape(message)) instance.inflight.enter();
		};

		await server.connect(transport);
		console.error(`markdown-mcp running on stdio (vault: ${vaultRoot.absolute}, db: ${dbPath})`);

		// Merkle defers until scan drains: a periodic walk during initial
		// enumeration would compete with scanner's own walk for I/O and
		// produce duplicate work.
		scanInProgress
			.then(() => {
				if (shuttingDown) return;
				try {
					merkleTick = startMerkleTick({
						vaultRoot,
						index,
						coordinator: coordinatorRef,
						reindexFile: reindexCallback,
						includeHidden: args.includeHidden,
					});
				} catch (err) {
					console.error(`markdown-mcp merkle: failed to start: ${errorMessage(err)}`);
				}
			})
			.catch((err: unknown) => {
				console.error(`markdown-mcp startup: deferred chain failed: ${errorMessage(err)}`);
			});
	} catch (err) {
		// `tearDownAndExit` calls `process.exit(1)` so we never return;
		// the trailing throw is unreachable (kept for type-narrowing).
		console.error(`markdown-mcp: startup failure: ${errorMessage(err)}`);
		await tearDownAndExit("markdown-mcp: startup failure; tearing down.", 1);
		throw err;
	}
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
