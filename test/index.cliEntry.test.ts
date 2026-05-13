/**
 * CLI entry detection through `node_modules/.bin` symlinks (`npm`/`npx`
 * install layout) and macOS `/tmp` realpath rewrites. Probes via a
 * no-arg invocation that should hit `parseCli`'s exit-2 path; without
 * realpath equality, the bootstrap silently exits 0.
 */

import { spawnSync } from "node:child_process";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { SERVER_BIN } from "./helpers/mcp-client.js";

let tmpDir: string;

beforeEach(async () => {
	tmpDir = await mkdtemp(join(tmpdir(), "markdown-mcp-cli-entry-"));
});

afterEach(async () => {
	await rm(tmpDir, { recursive: true, force: true });
});

function runServer(scriptPath: string): { code: number | null; stderr: string } {
	const result = spawnSync(process.execPath, [scriptPath], {
		encoding: "utf8",
		timeout: 5_000,
	});
	return { code: result.status, stderr: result.stderr };
}

function runServerWithArgs(scriptPath: string, args: string[]): { code: number | null; stderr: string } {
	const result = spawnSync(process.execPath, [scriptPath, ...args], {
		encoding: "utf8",
		timeout: 5_000,
	});
	return { code: result.status, stderr: result.stderr };
}

describe("CLI entry detection", () => {
	test("direct invocation of dist/index.js exits 2 with usage error when --vault is missing", () => {
		const { code, stderr } = runServer(SERVER_BIN);
		expect(code).toBe(2);
		expect(stderr).toContain("error: --vault <path> is required.");
	});

	test("invocation through a bin symlink matches direct-invocation behavior", async () => {
		// Reproduces the `npm`/`npx` install layout where
		// `node_modules/.bin/markdown-mcp` is a symlink to `dist/index.js`.
		// Without realpath on both sides of the entry comparison,
		// `main()` never runs and the process exits 0 with empty stderr.
		const symlinkPath = join(tmpDir, "markdown-mcp-bin");
		await symlink(SERVER_BIN, symlinkPath);

		const { code, stderr } = runServer(symlinkPath);
		expect(code).toBe(2);
		expect(stderr).toContain("error: --vault <path> is required.");
	});
});

describe("CLI flag parsing", () => {
	// `--help` exits 0 after printing USAGE; piggy-back on it to verify the
	// new flags appear in the help text without spinning up a real server.
	test("--help shows --polling and --include-hidden", () => {
		const result = spawnSync(process.execPath, [SERVER_BIN, "--help"], {
			encoding: "utf8",
			timeout: 5_000,
		});
		expect(result.status).toBe(0);
		expect(result.stderr).toContain("--polling");
		expect(result.stderr).toContain("--include-hidden");
	});

	test("--polling without --vault still requires --vault", () => {
		const { code, stderr } = runServerWithArgs(SERVER_BIN, ["--polling"]);
		expect(code).toBe(2);
		expect(stderr).toContain("error: --vault <path> is required.");
	});

	test("--include-hidden without --vault still requires --vault", () => {
		const { code, stderr } = runServerWithArgs(SERVER_BIN, ["--include-hidden"]);
		expect(code).toBe(2);
		expect(stderr).toContain("error: --vault <path> is required.");
	});

	test("unknown flag is rejected by parseArgs strict mode", () => {
		// `parseArgs({ strict: true })` throws on unknown options; the bootstrap's
		// `main().catch(...)` writes `fatal: ...` to stderr and exits 1. This
		// confirms the schema is closed — a typo like `--include_hidden` (snake)
		// won't silently no-op.
		const { code, stderr } = runServerWithArgs(SERVER_BIN, ["--vault", "/tmp/v", "--include_hidden"]);
		expect(code).toBe(1);
		expect(stderr).toContain("fatal:");
	});
});
