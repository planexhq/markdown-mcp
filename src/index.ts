#!/usr/bin/env node
/**
 * vault-mcp CLI entrypoint.
 *
 * Wires the configured `McpServer` to a `StdioServerTransport`. v1 is
 * stdio-only per D22; HTTP/SSE deferred. Additional CLI flags
 * (`--polling`, `--include-hidden`) land in W5.
 *
 * NEVER write to stdout from this process — stdout is the JSON-RPC
 * transport channel. All diagnostic logging goes to stderr (biome's
 * `noConsole` rule allows `console.error` and `console.warn`).
 */

import { parseArgs } from "node:util";

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { PathValidationError, type VaultRoot, validateVaultRoot } from "./lib/validatePath.js";
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

const USAGE = `vault-mcp ${process.env.npm_package_version ?? "1.0.0-w1"}

A read-only MCP server exposing a local markdown vault to AI agents.

Usage:
  vault-mcp --vault <path>

Options:
  --vault <path>   Absolute or relative path to the vault directory (required).
  -h, --help       Show this message.

The server speaks MCP over stdio. Connect from a compatible host
(Claude Desktop, Claude Code, Cursor, etc.).`;

function printValidationError(err: PathValidationError): void {
	console.error(`error: ${err.payload.message}`);
	if (err.payload.reason !== undefined) {
		console.error(`reason: ${String(err.payload.reason)}`);
	}
}

async function main(): Promise<void> {
	const args = parseCli(process.argv.slice(2));

	let vaultRoot: VaultRoot;
	try {
		vaultRoot = await validateVaultRoot(args.vault);
	} catch (err) {
		if (err instanceof PathValidationError) {
			printValidationError(err);
			process.exit(1);
		}
		throw err;
	}

	const server = createServer(vaultRoot);
	const transport = new StdioServerTransport();
	await server.connect(transport);
	console.error(`vault-mcp running on stdio (vault: ${vaultRoot.absolute})`);

	const shutdown = async (signal: string): Promise<void> => {
		console.error(`received ${signal}; shutting down.`);
		try {
			await server.close();
		} catch (err) {
			console.error(`error during shutdown: ${err instanceof Error ? err.message : String(err)}`);
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
