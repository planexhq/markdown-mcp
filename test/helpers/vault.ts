/**
 * Test helpers for spinning up isolated vault directories.
 *
 * Used by `validatePath` unit tests (need a real FS root for lstat /
 * realpath / symlink detection) and by the MCP integration test (needs
 * a `--vault` argument).
 *
 * Tests should always call `cleanup()` from `afterEach` — vitest does
 * not clean tmpdir automatically.
 */

import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Recursive vault structure descriptor.
 *
 *   string  → file with that text content
 *   object  → directory whose entries are nested descriptors
 */
export type VaultStructure = {
	[name: string]: string | VaultStructure;
};

/**
 * Create a fresh temp directory and populate it with the described
 * structure. Returns the absolute path and a cleanup function that
 * recursively removes the temp directory.
 *
 * Caller responsibility: invoke `cleanup()` in `afterEach` (or similar).
 */
export async function createTempVault(
	structure: VaultStructure = {},
): Promise<{ path: string; cleanup: () => Promise<void> }> {
	const root = await mkdtemp(join(tmpdir(), "vault-mcp-test-"));
	await populate(root, structure);
	return {
		path: root,
		cleanup: async () => {
			await rm(root, { recursive: true, force: true });
		},
	};
}

async function populate(parent: string, structure: VaultStructure): Promise<void> {
	for (const [name, value] of Object.entries(structure)) {
		const full = join(parent, name);
		if (typeof value === "string") {
			await mkdir(dirname(full), { recursive: true });
			await writeFile(full, value, "utf8");
		} else {
			await mkdir(full, { recursive: true });
			await populate(full, value);
		}
	}
}

/**
 * Create a symlink at `linkPath` pointing to `target`. Used to build
 * symlink-rejection test fixtures. `target` may be absolute or relative
 * to `dirname(linkPath)`. Throws on Windows native — tests using this
 * should be skipped on Windows (W1 CI is macOS+Linux only).
 */
export async function createSymlink(target: string, linkPath: string): Promise<void> {
	await mkdir(dirname(linkPath), { recursive: true });
	await symlink(target, linkPath);
}

/**
 * Build a deeply-nested path with `depth` directory segments under
 * `root`. Returns the deepest path (without the trailing file).
 * Used for the depth-cap test (depth > 32 → TOO_DEEP).
 */
export function buildDeepPath(depth: number): string {
	return Array.from({ length: depth }, (_, i) => `d${i}`).join("/");
}

/**
 * Default vault structure used by W1 tests that need a non-empty fixture
 * but don't care about specific file contents. Reused across both the
 * `validatePath` unit tests and the MCP integration tests so any change
 * to the canonical W1 shape happens once.
 */
export const DEFAULT_VAULT_STRUCTURE: VaultStructure = {
	"foo.md": "# foo\n",
	sub: { "nested.md": "# nested\n" },
	// Percent-encoded URI test fixture: addressed via `note://unicode-%C3%A9.md`
	// to verify the resource handler decodes before path validation.
	"unicode-é.md": "# unicode\n",
};

/**
 * UUID v4 regex (RFC 4122 §4.4). Reused across test files to avoid
 * re-defining the same pattern in two places.
 */
export const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
