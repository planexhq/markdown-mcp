/**
 * Type contract for vault-mcp.
 *
 * Source of truth: `docs/Design_Brief_v2.md` (lines cited per interface).
 * Cross-reference: `docs/DECISIONS.md` for ADR rationale.
 *
 * W1 scope: VaultError, ErrorCode, MetaEnvelope, IndexStatus, SafePath.
 * Tool I/O types (OutlineNode, Filter, Anchor, FragmentResult, SearchResult)
 * land in step 7 alongside `src/schemas.ts`.
 */

// ─── Error envelope (Brief lines 848–863) ──────────────────────────────────

/**
 * Stable error code union. Domain errors carry these via `structuredContent`
 * on a successful tool result with `isError: true` (D13 hybrid envelope).
 *
 * Codes are stable contract — never rename. Add new codes by appending.
 */
export type ErrorCode =
	| "PATH_NOT_FOUND"
	| "HEADING_NOT_FOUND"
	| "HEADING_AMBIGUOUS"
	| "PATH_OUTSIDE_VAULT"
	| "MARKDOWN_PARSE_ERROR"
	| "FILTER_SYNTAX_ERROR"
	| "INVALID_QUERY"
	| "CURSOR_INVALID"
	| "INDEX_WARMING"
	| "FILE_TOO_LARGE"
	| "INTERNAL_ERROR";

/**
 * Candidate carried on `HEADING_AMBIGUOUS` and stale-`stable_id` recovery
 * (D32). `score` is optional — present on fuzzy candidates, absent on
 * disambiguation candidates.
 */
export interface HeadingCandidate {
	stable_id: string;
	heading_path: string[];
	score?: number;
}

/**
 * Domain error payload. Lives inside `CallToolResult.structuredContent`
 * when a tool sets `isError: true` (D13).
 *
 * Per-code optional fields (Brief lines 870–881):
 * - `param`: Stripe-style "which input was bad"
 * - `candidates`: load-bearing for HEADING_AMBIGUOUS and stale-id recovery
 * - `retry_after_ms`: present on transient errors (INDEX_WARMING)
 * - `request_id`: ALWAYS present, AWS-style log correlation
 *
 * Code-specific structured fields (e.g. `requested_stable_id`,
 * `stable_id_status`, `reason`, `progress`, `limit_bytes`, `actual_bytes`)
 * extend this interface via index signature; constructors set them
 * conditionally per error code.
 */
export interface VaultError {
	code: ErrorCode;
	message: string;
	suggestion?: string;
	param?: string;
	candidates?: HeadingCandidate[];
	retry_after_ms?: number;
	request_id: string;
	[extra: string]: unknown;
}

// ─── Meta envelope (Brief lines 940–972, D17) ──────────────────────────────

/**
 * Index lifecycle state machine (Brief lines 932–936).
 *
 * - `cold`: no usable persisted index; vault-wide tools return INDEX_WARMING,
 *   bounded tools (outline/fragment/metadata) parse on demand.
 * - `warming`: queryable but counts may grow.
 * - `warm`: fully indexed; steady state.
 * - `reconciling`: diagnostic-only; reads continue on the prior snapshot.
 *
 * Transitions: `cold → warming → warm ⇄ reconciling`.
 */
export type IndexState = "cold" | "warming" | "warm" | "reconciling";

/**
 * Optional progress info on `INDEX_WARMING`. Phase ordering is
 * `scanning → parsing → fts_populating`.
 */
export interface IndexWarmingProgress {
	files_indexed: number;
	files_total_estimate: number;
	phase: "scanning" | "parsing" | "fts_populating";
}

/**
 * Index status visible on every `_meta` envelope.
 */
export interface IndexStatus {
	state: IndexState;
	files_indexed: number;
}

/**
 * `_meta` envelope appended to every tool response (D17).
 *
 * Per-tool field-presence (Brief lines 963–972):
 * - tokenizer: get_vault_tree, get_file_outline, get_fragment, search
 * - snippet_algorithm: search only
 * - query_algorithm: search only
 * - query_note: search only (optional)
 * - fuzzy_algorithm: get_fragment / get_links iff stale-id recovered
 *
 * `request_id` and `index_status` are present on EVERY response.
 */
export interface MetaEnvelope {
	request_id: string;
	index_status: IndexStatus;
	tokenizer?: string;
	snippet_algorithm?: string;
	query_algorithm?: string;
	query_note?: string;
	fuzzy_algorithm?: string;
	// MCP `_meta` is an extension point with reserved keys
	// (progressToken, etc.) — preserve index signature so the SDK's
	// CallToolResult type accepts our envelope without a cast.
	[extra: string]: unknown;
}

// ─── Path validation (Brief lines 686–763) ─────────────────────────────────

/**
 * Output of `validatePath(input, vaultRoot)`. All read paths in vault-mcp
 * flow through this interface (D8, D16 — single entry point).
 */
export interface SafePath {
	/** Raw user input, preserved for error messages and audit. */
	input: string;
	/** NFC-normalized form used for FS operations. */
	normalized: string;
	/**
	 * Validated absolute path inside the vault. NOT realpath-resolved on
	 * the leaf — the read site's `openNoFollow` performs `O_NOFOLLOW` on
	 * this path to refuse any post-validation leaf-symlink swap (D8 +
	 * THREAT_MODEL V1/V6 residual TOCTOU).
	 */
	absolute: string;
	/** Vault-relative form (POSIX slashes) for display / DB keys. */
	relative: string;
}

/**
 * Validation rejection reason — surfaced on `VaultError.reason` for
 * `PATH_OUTSIDE_VAULT` to help agents self-correct.
 */
export type PathRejectionReason =
	| "PATH_TOO_LONG"
	| "NULL_BYTE"
	| "PERCENT_ENCODED"
	| "BACKSLASH"
	| "ABSOLUTE_PATH"
	| "TRAVERSAL_SEGMENT"
	| "TOO_DEEP"
	| "EMPTY_PATH"
	| "SYMLINK_SEGMENT"
	| "OUTSIDE_VAULT"
	| "VAULT_ROOT_INACCESSIBLE"
	| "VAULT_ROOT_SYMLINK"
	| "VAULT_ROOT_NOT_DIRECTORY"
	| "STAT_FAILED"
	| "REALPATH_FAILED";

// ─── Range / shared (Brief lines 73–87) ────────────────────────────────────

/**
 * Inclusive line-number range (1-based) within a single file.
 */
export interface Range {
	start: number;
	end: number;
}

export type ContentKind = "code" | "table" | "image" | "list" | "math" | "callout";
export type HeadingLevel = 1 | 2 | 3 | 4 | 5 | 6;

// ─── Vault tree (Brief lines 36–61, D25 + D35) ─────────────────────────────

export type TreeItemType = "dir" | "file";

/**
 * One row of `get_vault_tree.items[]`. `dfs_rank` matches the cursor
 * `after_key` per D35 (snapshot-local strictly-increasing).
 */
export interface VaultTreeItem {
	id: string; // "t:" + sha1(relpath)[:14] (D25)
	type: TreeItemType;
	path: string;
	name: string;
	dfs_rank: number;
	children?: number; // dir only
	subheadings?: number; // file only
	bodyTokensApprox?: number; // file only
	descendantTokensApprox?: number; // file only
	contentKinds?: ContentKind[];
	mtime: number;
}

export interface GetVaultTreeInput {
	path?: string;
	depth?: number;
	cursor?: string;
	pageSize?: number;
}

export interface GetVaultTreeResult {
	items: VaultTreeItem[];
	nextCursor?: string;
}

// ─── File outline (Brief lines 62–91, D27) ─────────────────────────────────

/**
 * Heading-tree node. `stable_id` follows D27: hash of `relpath + ":" +
 * structural_path` where structural_path = `h{L1}[i1]/.../h{Ln}[in]`.
 */
export interface OutlineNode {
	level: HeadingLevel;
	text: string;
	path: string; // matchable, inline formatting stripped
	stable_id: string; // "h:" + 14 hex (D27 + D20)
	anchor: string; // GitHub-compatible slug
	range: Range;
	selectionRange: Range;
	bodyTokensApprox: number;
	subheadings: number;
	descendantTokensApprox: number;
	contentKinds?: ContentKind[];
	blockIds?: string[];
	children?: OutlineNode[];
}

export interface BlockIndexEntry {
	range: Range;
	heading_path: string[];
}

export interface GetFileOutlineInput {
	file: string;
}

export interface GetFileOutlineResult {
	outline: OutlineNode[];
	blockIndex: Record<string, BlockIndexEntry>;
}

// ─── Fragment (Brief lines 92–205, D29 + D32) ──────────────────────────────

export type Anchor =
	| { kind: "heading_path"; path: string | string[] }
	| { kind: "block"; id: string }
	| { kind: "file" };

export type ExpandEmbedsOption = boolean | { max_depth?: number | undefined };

export interface GetFragmentInput {
	file: string;
	anchor: Anchor;
	stable_id?: string | undefined;
	expand_embeds?: ExpandEmbedsOption | undefined;
}

export interface OutgoingLink {
	raw_target: string;
	target_file?: string;
	target_heading_path?: string[];
	target_block_id?: string;
	link_text: string;
	alias?: string;
	resolved: boolean;
	duplicate_heading?: boolean;
	candidates?: Array<{ file: string; heading_path?: string[] }>;
	link_ordinal: number;
}

export type EmbedKind = "note" | "image" | "pdf" | "media";

export type ExpansionError =
	| "unresolved_file"
	| "ambiguous_file"
	| "unresolved_heading"
	| "unresolved_block"
	| "non_markdown_target"
	| "cycle_detected"
	| "max_depth_exceeded";

export interface Embed {
	raw_target: string;
	target_file?: string;
	target_heading_path?: string[];
	target_block_id?: string;
	kind: EmbedKind;
	resolved: boolean;
	candidates?: Array<{ file: string; heading_path?: string[] }>;
	expanded: boolean;
	expanded_content?: string;
	expansion_error?: ExpansionError;
}

export interface FragmentCommon {
	file: string;
	content: string;
	bodyTokensApprox: number;
	outgoing_links: OutgoingLink[];
	embeds: Embed[];
}

export type StableIdStatus = "fresh" | "stale";

export interface FuzzyCandidate {
	stable_id: string;
	heading_path: string[];
	score: number;
}

export interface HeadingFragment extends FragmentCommon {
	anchor_kind: "heading";
	stable_id: string;
	stable_id_status: StableIdStatus;
	requested_stable_id?: string;
	fuzzy_candidates?: FuzzyCandidate[];
	heading_path: string[];
	slug_path: string;
	level: HeadingLevel;
}

export interface PreambleFragment extends FragmentCommon {
	anchor_kind: "preamble";
}

export interface BlockFragment extends FragmentCommon {
	anchor_kind: "block";
	block_id: string;
	containing_heading_path: string[];
	containing_stable_id?: string;
}

export interface FileFragment extends FragmentCommon {
	anchor_kind: "file";
}

export type FragmentResult = HeadingFragment | PreambleFragment | BlockFragment | FileFragment;

// ─── Search (Brief lines 206–299, D31 + D33) ───────────────────────────────

export interface TagOps {
	has?: string;
	has_any?: string[];
	has_all?: string[];
}

export interface DateOps {
	gte?: string;
	lte?: string;
	gt?: string;
	lt?: string;
}

export interface ScalarOps<T = unknown> {
	eq?: T;
	ne?: T;
	in?: T[];
	nin?: T[];
	contains?: string;
	is_empty?: boolean;
}

export type FieldOps = ScalarOps<unknown> | TagOps | DateOps;

export interface Filter {
	tags?: TagOps;
	date?: DateOps;
	fields?: Record<string, FieldOps>;
	and?: Filter[];
	or?: Filter[];
	not?: Filter;
}

export interface SearchScope {
	path?: string;
}

export interface SearchInput {
	query: string;
	scope?: SearchScope;
	filters?: Filter;
	cursor?: string;
	pageSize?: number;
}

export type ScoreType = "bm25" | "filter" | "rrf" | "hybrid";
export type Retriever = "bm25" | "filter";

export interface SearchResultCommon {
	file: string;
	snippet: string;
	score: number;
	score_type: ScoreType;
	score_breakdown?: { bm25?: number; semantic?: number };
}

export interface HeadingSearchResult extends SearchResultCommon {
	anchor_kind: "heading";
	heading_path: string[];
	stable_id: string;
}

export interface PreambleSearchResult extends SearchResultCommon {
	anchor_kind: "preamble";
}

export interface FileSearchResult extends SearchResultCommon {
	anchor_kind: "file";
}

export type SearchResult = HeadingSearchResult | PreambleSearchResult | FileSearchResult;

export interface SearchOutput {
	items: SearchResult[];
	nextCursor?: string;
	retriever: Retriever;
}

// ─── Metadata (Brief lines 301–310) ────────────────────────────────────────

export interface GetMetadataInput {
	file: string;
}

export interface GetMetadataResult {
	metadata: Record<string, unknown>;
	has_frontmatter: boolean;
}

// ─── Links (Brief lines 312–372, D34 + round-9 cursor rename) ──────────────

export type LinkDirection = "in" | "out" | "both";

export interface IncomingLink {
	raw_target: string;
	source_file: string;
	source_heading_path?: string[];
	source_stable_id?: string;
	link_text: string;
	alias?: string;
	is_embed: boolean;
	link_ordinal: number;
}

export interface OutgoingLinkRow {
	raw_target: string;
	source_heading_path?: string[];
	target_file?: string;
	target_heading_path?: string[];
	target_block_id?: string;
	link_text: string;
	alias?: string;
	is_embed: boolean;
	resolved: boolean;
	duplicate_heading?: boolean;
	candidates?: Array<{ file: string; heading_path?: string[] }>;
	link_ordinal: number;
}

export interface ResolvedAnchor {
	stable_id_status: StableIdStatus;
	stable_id?: string;
	requested_stable_id?: string;
	heading_path?: string[];
}

export interface GetLinksInput {
	file: string;
	direction?: LinkDirection;
	heading_path?: string | string[];
	stable_id?: string;
	cursor?: string;
	pageSize?: number;
}

export interface GetLinksResult {
	incoming?: IncomingLink[];
	outgoing?: OutgoingLinkRow[];
	resolved_anchor?: ResolvedAnchor;
	nextCursor?: string;
}

// ─── Resource: note://{path} (Brief lines 376–415) ─────────────────────────

export interface NoteResourceContent {
	uri: string;
	mimeType: "text/markdown";
	text: string;
}

export interface NoteResourceResult {
	contents: [NoteResourceContent];
}
