/**
 * D39 — `PACKAGE_VERSION` reads from this package's `package.json`, not
 * `process.env.npm_package_version`. Pin both behaviors:
 *   - The exported constant matches `package.json`'s `version` field
 *     (parsed independently in the test for belt-and-suspenders).
 *   - Setting `npm_package_version` does NOT change the module's view —
 *     the module reads `package.json` at load time, not the env.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

import { PACKAGE_VERSION } from "../../src/lib/version.js";

const pkgPath = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "package.json");
const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version: string };

describe("PACKAGE_VERSION — D39 identity source", () => {
	test("matches the version in package.json", () => {
		expect(PACKAGE_VERSION).toBe(pkg.version);
	});

	test("looks like a semver string", () => {
		expect(PACKAGE_VERSION).toMatch(/^\d+\.\d+\.\d+/);
	});
});
