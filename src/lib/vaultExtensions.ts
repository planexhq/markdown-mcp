/**
 * `VAULT_EXTENSIONS` predicate — single source of truth for "is this path
 * addressable as a parseable note." Brief lines 917-923 + CLAUDE.md round
 * 9 ("Single-predicate file-content surface"): the same predicate gates
 * `note://` Resource reads, `get_vault_tree` resource_link emission, and
 * direct-read tools (`get_file_outline`, `get_fragment`, `get_metadata`,
 * `get_links`).
 *
 * Default is `["md"]`. Configurable via env var `VAULT_EXTENSIONS=md,markdown,mdx`
 * (comma-separated, no leading dot). Comparison is case-insensitive.
 *
 * Env reads happen once per distinct env-value: a memoization key holds
 * the raw env string and only re-parses when it changes (so `vi.stubEnv`
 * between test cases still gets fresh results without re-importing).
 */

import { extname } from "node:path";

const DEFAULT_EXTENSIONS: ReadonlySet<string> = new Set(["md"]);

let cachedRawEnv: string | undefined;
let cachedExtensions: ReadonlySet<string> = DEFAULT_EXTENSIONS;

export function getVaultExtensions(): ReadonlySet<string> {
	const env = process.env.VAULT_EXTENSIONS;
	if (env === cachedRawEnv) return cachedExtensions;
	cachedRawEnv = env;
	if (!env || env.trim().length === 0) {
		cachedExtensions = DEFAULT_EXTENSIONS;
		return cachedExtensions;
	}
	const parts = env
		.split(",")
		.map((s) => s.trim().toLowerCase())
		.filter((s) => s.length > 0);
	cachedExtensions = parts.length > 0 ? new Set(parts) : DEFAULT_EXTENSIONS;
	return cachedExtensions;
}

/**
 * Returns true iff `relpath`'s extension matches one of the configured
 * vault extensions. Paths without any extension are NOT considered notes
 * (no "Makefile-style" notes); the optional `exts` arg lets tests pass an
 * explicit set without touching env state.
 */
export function isMarkdownPath(relpath: string, exts?: ReadonlySet<string>): boolean {
	const ext = extname(relpath).slice(1).toLowerCase();
	if (ext === "") return false;
	return (exts ?? getVaultExtensions()).has(ext);
}
