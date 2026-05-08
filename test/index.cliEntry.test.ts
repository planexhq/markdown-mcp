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
	tmpDir = await mkdtemp(join(tmpdir(), "vault-mcp-cli-entry-"));
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

describe("CLI entry detection", () => {
	test("direct invocation of dist/index.js exits 2 with usage error when --vault is missing", () => {
		const { code, stderr } = runServer(SERVER_BIN);
		expect(code).toBe(2);
		expect(stderr).toContain("error: --vault <path> is required.");
	});

	test("invocation through a bin symlink matches direct-invocation behavior", async () => {
		// Reproduces the `npm`/`npx` install layout where
		// `node_modules/.bin/vault-mcp` is a symlink to `dist/index.js`.
		// Without realpath on both sides of the entry comparison,
		// `main()` never runs and the process exits 0 with empty stderr.
		const symlinkPath = join(tmpDir, "vault-mcp-bin");
		await symlink(SERVER_BIN, symlinkPath);

		const { code, stderr } = runServer(symlinkPath);
		expect(code).toBe(2);
		expect(stderr).toContain("error: --vault <path> is required.");
	});
});
