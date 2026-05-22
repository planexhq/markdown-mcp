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
 * D43 (Phase 1) — `getParserKind(relpath)` classifies a configured
 * extension as `"markdown"` (md, markdown, mdx) or `"yaml"` (yaml, yml).
 * Returns `null` when the extension isn't configured. The dispatcher
 * inside `parseFile` consults this to route to `parseMarkdownFile` vs
 * the YAML parser. D46 (Phase 4) split the markdown-vs-parseable
 * predicate into `isResolvableLinkTarget` (wikilink targets) and
 * `isParseablePath` (storage / direct-read addressability).
 *
 * Env reads happen once per distinct env-value: a memoization key holds
 * the raw env string and only re-parses when it changes (so `vi.stubEnv`
 * between test cases still gets fresh results without re-importing).
 */

import { extname } from "node:path";

export const DEFAULT_EXTENSIONS: ReadonlySet<string> = new Set(["md"]);

/** Markdown-family extensions — consumed by `getParserKind` for parser-routing classification. */
export const MARKDOWN_EXTENSIONS: ReadonlySet<string> = new Set(["md", "markdown", "mdx"]);

/** YAML-family extensions — consumed by `getParserKind` + `isResolvableLinkTarget`'s YAML gate. */
export const YAML_EXTENSIONS: ReadonlySet<string> = new Set(["yaml", "yml"]);

/** Prisma-family extensions — consumed by `getParserKind` + `isResolvableLinkTarget`'s non-markdown gate. */
export const PRISMA_EXTENSIONS: ReadonlySet<string> = new Set(["prisma"]);

/** Parser-kind discriminator. `null` = extension not addressable. */
export type ParserKind = "markdown" | "yaml" | "prisma";

let cachedRawEnv: string | undefined;
let cachedExtensions: ReadonlySet<string> = DEFAULT_EXTENSIONS;
let cachedSorted: ReadonlyArray<string> = Object.freeze([...DEFAULT_EXTENSIONS].sort());

export function getVaultExtensions(): ReadonlySet<string> {
	const env = process.env.VAULT_EXTENSIONS;
	if (env === cachedRawEnv) return cachedExtensions;
	cachedRawEnv = env;
	if (!env || env.trim().length === 0) {
		cachedExtensions = DEFAULT_EXTENSIONS;
	} else {
		const parts = env
			.split(",")
			.map((s) => s.trim().toLowerCase())
			.filter((s) => s.length > 0);
		cachedExtensions = parts.length > 0 ? new Set(parts) : DEFAULT_EXTENSIONS;
	}
	cachedSorted = Object.freeze([...cachedExtensions].sort());
	return cachedExtensions;
}

/**
 * Canonical sorted snapshot of `VAULT_EXTENSIONS` — single source for every
 * persistence + wire-format consumer (D47 `index_meta.vault_extensions`,
 * round-42 lockfile payload, `get_server_info.server.extensions`). Returns
 * the shared frozen array; wire-format callers that need a mutable
 * `string[]` copy at the boundary.
 */
export function getSortedVaultExtensions(): ReadonlyArray<string> {
	// Cache invalidation rides on `getVaultExtensions()` re-reading the env.
	getVaultExtensions();
	return cachedSorted;
}

/**
 * Returns true iff `relpath`'s extension matches one of the configured
 * vault extensions, regardless of family (markdown, YAML, or any future
 * parseable kind). Paths without any extension are NOT considered notes
 * (no "Makefile-style" notes); the optional `exts` arg lets tests pass an
 * explicit set without touching env state.
 *
 * D46 — this is the "addressable as a parseable note" gate used by:
 * scanner walk, watcher filter, merkle walk, `note://` Resource, tree
 * resource_link emission, direct-read tools.
 */
export function isParseablePath(relpath: string, exts?: ReadonlySet<string>): boolean {
	const ext = extname(relpath).slice(1).toLowerCase();
	if (ext === "") return false;
	return (exts ?? getVaultExtensions()).has(ext);
}

/**
 * Returns true iff `relpath`'s extension is configured AND is NOT in the
 * YAML family. D46 — the wikilink resolver (`wikilinks.ts` phases 0-3),
 * `stripMarkdownExt`, `buildEmbed` (markdown-target inlining), and the
 * snippet algorithm's markdown-bold highlights all gate on this
 * predicate. Wikilinks INTO YAML are deferred to v1.x — admitting them
 * would silently retarget `[[petstore]]` to `petstore.yaml` and write
 * outgoing-link rows pointing at YAML.
 *
 * Notably this admits NON-markdown-family configured extensions like
 * `.txt` (when a user opts into `VAULT_EXTENSIONS=md,txt`) — those
 * files don't get a real parser AST but the user explicitly asked for
 * them to be treated as parseable notes, so wikilink basename matching
 * applies.
 */
export function isResolvableLinkTarget(relpath: string, exts?: ReadonlySet<string>): boolean {
	const ext = extname(relpath).slice(1).toLowerCase();
	if (ext === "") return false;
	if (YAML_EXTENSIONS.has(ext)) return false;
	if (PRISMA_EXTENSIONS.has(ext)) return false;
	return (exts ?? getVaultExtensions()).has(ext);
}

/**
 * True iff `relpath` has an extension but is NOT a resolvable link target
 * (e.g. `.png`, `.pdf`, `.yaml`). Used by the embed resolver to route
 * non-markdown targets to `non_markdown_target` rendering. D46 — YAML
 * is admitted by `isParseablePath` (indexable) but NOT by
 * `isResolvableLinkTarget`, so YAML embed targets fall through this gate
 * alongside binary assets.
 */
export function isAssetPath(relpath: string, exts?: ReadonlySet<string>): boolean {
	return extname(relpath) !== "" && !isResolvableLinkTarget(relpath, exts);
}

/**
 * True iff `ext` (bare, no leading dot, lowercase) is configured AND
 * belongs to a wikilink-resolvable family. Same family rules as
 * `isResolvableLinkTarget` — YAML and Prisma are deferred — but
 * operates on bare extensions for callers that iterate
 * `getVaultExtensions()` to synthesize candidate filenames
 * (`wikilinks.ts:findFileWithVaultExt`, `getLinks.ts:computeIncomingCandidates`).
 */
export function isLinkableExtension(ext: string, exts?: ReadonlySet<string>): boolean {
	if (YAML_EXTENSIONS.has(ext)) return false;
	if (PRISMA_EXTENSIONS.has(ext)) return false;
	return (exts ?? getVaultExtensions()).has(ext);
}

/**
 * Classify `relpath`'s extension against the markdown and YAML families
 * (D43). Returns `null` if the extension is not configured in
 * `VAULT_EXTENSIONS` OR is configured but doesn't belong to a known
 * parser family (e.g. a user configuring `txt` — accepted by
 * `isParseablePath` for storage purposes but has no parser to dispatch
 * to, so `parseFile` would fall through to the markdown path).
 *
 * Tests that pass synthetic relpaths without extensions (e.g.
 * `"scratch"`) receive `null` — `parseFile` treats null as the legacy
 * markdown-default path so pre-D43 fixtures still work.
 */
export function getParserKind(relpath: string, exts?: ReadonlySet<string>): ParserKind | null {
	const ext = extname(relpath).slice(1).toLowerCase();
	if (ext === "") return null;
	const configured = exts ?? getVaultExtensions();
	if (!configured.has(ext)) return null;
	if (MARKDOWN_EXTENSIONS.has(ext)) return "markdown";
	if (YAML_EXTENSIONS.has(ext)) return "yaml";
	if (PRISMA_EXTENSIONS.has(ext)) return "prisma";
	return null;
}
