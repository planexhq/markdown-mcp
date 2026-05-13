/**
 * Hard caps for markdown-mcp inputs.
 *
 * Centralized so consumers (validatePath in W1; parser, FTS, scanner in
 * W2+) all reference the same constants. Drift between callers is the
 * commonest source of "the brief says 32 but the code says 31" bugs.
 *
 * Source: Brief lines 686–763 (input validation), Brief operational
 * concerns (file size cap), DECISIONS D8/D22 (security model).
 */

/** Maximum length of any path input string. Brief line 689. */
export const MAX_PATH_LENGTH = 1024;

/**
 * Maximum nested-segment depth. Inputs beyond this depth are rejected as
 * `PATH_OUTSIDE_VAULT` with reason `TOO_DEEP` — both a DoS guard and a
 * sanity bound on legitimate vault layout. Brief line 695.
 */
export const MAX_PATH_DEPTH = 32;

/**
 * Maximum file size for a single read. Files exceeding this cap return
 * `FILE_TOO_LARGE`. Enforced in W2 alongside the parser; W1 does not
 * read file contents. 10 MiB.
 */
export const MAX_FILE_BYTES = 10 * 1024 * 1024;

/**
 * Maximum AST nodes per parse. Files producing larger trees return
 * `MARKDOWN_PARSE_ERROR` with `reason: "ast_node_cap_exceeded"`. Enforced
 * in W2.
 */
export const MAX_AST_NODES = 50_000;

/**
 * Maximum length of a search `query` string. Inputs beyond this cap
 * return `INVALID_QUERY` with `reason: "too_long"`. Enforced in W3.
 */
export const MAX_QUERY_LENGTH = 1024;

/**
 * Minimum MCP protocol version per D22. Server rejects Initialize from
 * clients requesting any version below this. Lex-compare works on the
 * `YYYY-MM-DD` ISO format used by all SDK-supported versions.
 */
export const MIN_PROTOCOL_VERSION = "2025-06-18";

/** Default `pageSize` when client omits it. Brief line 1060 + D26. */
export const DEFAULT_PAGE_SIZE = 50;

/**
 * Hard cap on `pageSize`. Brief line 445 + line 1061 + D26: server
 * silently clamps larger requests rather than rejecting at the schema
 * layer. Schema stays permissive (consistent with the `query` length
 * pattern); per-tool handlers (W3+) clamp to this value.
 */
export const MAX_PAGE_SIZE = 200;

/**
 * Shared `pageSize` clamp used by every paginated tool handler (search,
 * get_links, get_vault_tree). Non-finite / negative / zero → default;
 * otherwise floor + clamp to MAX. Mirrors the Brief's "silent clamp"
 * contract so a `pageSize: 1000` request returns 200 rows rather than
 * an `InvalidParams` error.
 */
export function clampPageSize(input: number | undefined): number {
	if (input === undefined || !Number.isFinite(input)) return DEFAULT_PAGE_SIZE;
	const n = Math.floor(input);
	if (n < 1) return DEFAULT_PAGE_SIZE;
	return Math.min(n, MAX_PAGE_SIZE);
}
