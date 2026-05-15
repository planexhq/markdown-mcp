/**
 * Single source of truth for this package's version (D39).
 *
 * `process.env.npm_package_version` is set ONLY when the binary is launched
 * via `npm exec` / npm scripts from within this package's working directory;
 * every other launch mode silently produces the wrong value:
 *   - `node dist/index.js` → env var unset → falls back to a stub.
 *   - `npx markdown-mcp` from outside any package → env var unset.
 *   - `npm exec markdown-mcp` from a vault with its own package.json →
 *     env var inherits the CALLER'S version, not markdown-mcp's.
 *
 * Read from `package.json` instead. `src/lib/version.ts` → `dist/lib/version.js`;
 * `package.json` sits at the project root (two levels up from `dist/lib/`).
 * npm always tarballs `package.json` regardless of the `files` array, so the
 * lookup works both in-tree and post-install.
 *
 * `readFileSync` over the ESM JSON import (`import pkg from "../../package.json"
 * with { type: "json" }`) because the sync file read is bundler-agnostic and
 * unaffected by any future churn over the import-attribute syntax.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const pkgPath = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "package.json");
const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version: string };

export const PACKAGE_VERSION = pkg.version;
