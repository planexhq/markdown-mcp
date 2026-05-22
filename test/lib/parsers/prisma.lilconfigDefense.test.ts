/**
 * Verifies the lilconfig-stub defense in `getPinnedPrismaAst`.
 *
 * `@mrleebo/prisma-ast`'s module-load constructs `defaultParser` via
 * `getConfig() → lilconfigSync('prisma-ast').search()`, which walks from
 * cwd toward root and `require()`s any `.prisma-astrc.{js,cjs}` /
 * `prisma-ast.config.{js,cjs}` it finds. The synthesizer pre-stubs
 * lilconfig in the shared module cache BEFORE the package require, so the
 * search returns null and no JavaScript is executed.
 *
 * Tested via subprocess because the package is already loaded in this
 * Vitest worker by the time the unit tests run (`prisma.test.ts` has a
 * static `import { getSchema } from "@mrleebo/prisma-ast"`); only a fresh
 * Node process honestly exercises the "first require" code path.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { REPO_ROOT } from "../../helpers/mcp-client.js";

const COMPILED_PRISMA = join(REPO_ROOT, "dist/lib/parsers/prisma.js");

describe("getPinnedPrismaAst — lilconfig RCE defense", () => {
	let tempDir: string;
	let markerPath: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "prisma-lilconfig-"));
		markerPath = join(tempDir, "rce-marker.txt");
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	function runWithConfig(configName: string): {
		stdout: string;
		stderr: string;
		code: number | null;
		markerExists: boolean;
	} {
		const markerLiteral = JSON.stringify(markerPath);
		const configBody = `const fs = require("fs"); fs.writeFileSync(${markerLiteral}, "rce"); module.exports = { parser: { nodeLocationTracking: "none" } };`;
		writeFileSync(join(tempDir, configName), configBody);
		const compiledLiteral = JSON.stringify(COMPILED_PRISMA);
		const script = `import(${compiledLiteral}).then(m => { m.parsePrismaFile("model X {\\n  id Int @id\\n}\\n", "schema.prisma"); console.log("OK"); }).catch(err => { console.error(err && err.message ? err.message : String(err)); process.exit(1); });`;
		const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
			cwd: tempDir,
			encoding: "utf8",
			timeout: 10_000,
		});
		return {
			stdout: result.stdout,
			stderr: result.stderr,
			code: result.status,
			markerExists: existsSync(markerPath),
		};
	}

	test(".prisma-astrc.js in cwd does NOT execute", () => {
		const result = runWithConfig(".prisma-astrc.js");
		expect(result.code).toBe(0);
		expect(result.stdout).toMatch(/OK/);
		expect(result.markerExists).toBe(false);
	});

	test(".prisma-astrc.cjs in cwd does NOT execute", () => {
		const result = runWithConfig(".prisma-astrc.cjs");
		expect(result.code).toBe(0);
		expect(result.stdout).toMatch(/OK/);
		expect(result.markerExists).toBe(false);
	});

	test("prisma-ast.config.js in cwd does NOT execute", () => {
		const result = runWithConfig("prisma-ast.config.js");
		expect(result.code).toBe(0);
		expect(result.stdout).toMatch(/OK/);
		expect(result.markerExists).toBe(false);
	});
});
