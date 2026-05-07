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
import { createIndexHandle } from "./lib/index/IndexHandle.js";
import { type ScanResult, scanVault } from "./lib/index/scanner.js";
import { closeSqlite, openSqliteWithRecovery } from "./lib/index/sqlite.js";
import { chooseStartupState } from "./lib/startup.js";
import {
	assertIndexFilesAreRegular,
	ensureIndexDirIsRealDir,
	PathValidationError,
	type VaultRoot,
	validateVaultRoot,
} from "./lib/validatePath.js";
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

const USAGE = `vault-mcp ${process.env.npm_package_version ?? "1.0.0-w3"}

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

	const decision = chooseStartupState({
		preexisted: opened.preexisted,
		scanComplete: index.getScanComplete(),
		everComplete: index.getEverComplete(),
		fileCount: index.countFiles(),
	});
	index.setStatus(decision.state);
	if (decision.log !== null) console.error(decision.log);
	const scanController = new AbortController();
	const startedAt = Date.now();
	const scanInProgress = scanVault({
		vaultRoot,
		index,
		signal: scanController.signal,
		concurrency: 4,
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

	let shuttingDown = false;
	const shutdown = async (signal: string): Promise<void> => {
		if (shuttingDown) return;
		shuttingDown = true;
		console.error(`received ${signal}; shutting down.`);
		scanController.abort();
		try {
			const drained = await Promise.race([
				scanInProgress,
				new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), SHUTDOWN_DRAIN_MS)),
			]);
			if (drained === "timeout") {
				console.error("vault-mcp scanner: drain timeout (5 s); proceeding with shutdown.");
			}
		} catch (err) {
			console.error(`vault-mcp scanner: drain error: ${errorMessage(err)}`);
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

main().catch((err: unknown) => {
	console.error(`fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
	process.exit(1);
});
