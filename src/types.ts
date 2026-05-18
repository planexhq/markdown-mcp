/**
 * Type contract for markdown-mcp.
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
 * - `warming`: initial scan in progress; vault-wide tools also return
 *   INDEX_WARMING (the `progress.phase` payload was always designed for
 *   this), bounded reads parse on demand.
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
 * Current-scan degradation signals (D37). Surfaced inside
 * {@link IndexStatus.degraded} when one of the gates is set. Both fields
 * reflect the CURRENT scan only — `failed_subtrees_present` resets at
 * scanner start, `pending_retries` is the live in-memory set.
 */
export interface IndexDegraded {
	failed_subtrees_present: boolean;
	pending_retries: number;
}

/**
 * Index status visible on every `_meta` envelope.
 *
 * D37 adds two optional fields:
 * - `last_scan_finished_at`: ISO 8601 of the most recent clean finalize;
 *   omitted when never finalized (pre-upgrade caches, partial first scans).
 * - `degraded`: present only when a current-scan gate is set
 *   (`failed_subtrees_present` OR `pending_retries > 0`); omit-when-clean
 *   keeps the common case lean.
 */
export interface IndexStatus {
	state: IndexState;
	files_indexed: number;
	last_scan_finished_at?: string;
	degraded?: IndexDegraded;
}

/**
 * Atomic combined snapshot returned by `IndexHandle.getStatusSnapshot` (D39).
 * Extends {@link IndexStatus} with `ever_complete` so `get_server_info` can
 * pull all four persisted-or-in-memory fields in one prepared-statement read,
 * preventing the torn `{ever_complete: true, last_scan_finished_at: undefined}`
 * combination a same-policy multi-process peer's finalize could otherwise
 * surface between two separate SELECTs. NOT used as the `_meta.index_status`
 * wire shape — that stays on `IndexStatus` so `ever_complete` doesn't leak
 * onto every tool's envelope.
 */
export interface IndexStatusSnapshot extends IndexStatus {
	ever_complete: boolean;
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
 * Output of `validatePath(input, vaultRoot)`. All read paths in markdown-mcp
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
	| "CONTROL_CHAR"
	| "PERCENT_ENCODED"
	| "BACKSLASH"
	| "COLON"
	| "RESERVED_DEVICE_NAME"
	| "TRAILING_DOT_OR_SPACE"
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
	| "REALPATH_FAILED"
	| "INDEX_FILE_SYMLINK"
	| "INDEX_FILE_NOT_REGULAR";

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
	// Live on-disk byte count via `lstat` (mirror of
	// `get_fragment.file_size_bytes`' read-path source so the D37/D41
	// cross-check survives the watcher-lag window). Omitted for
	// directories, symlinks, and vanished-mid-walk files.
	size_bytes?: number;
}

export interface GetVaultTreeInput {
	path?: string | undefined;
	depth?: number | undefined;
	cursor?: string | undefined;
	pageSize?: number | undefined;
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
	/**
	 * stable_id of the containing heading, or null if the block sits in
	 * preamble (no enclosing heading). D27 stable_ids encode structural
	 * slot, so duplicate-heading files (`# A ... # A`) get distinct ids
	 * — without this field, narrowing-by-stable_id mis-attributes block
	 * links to the first match by heading_path.
	 */
	containing_stable_id: string | null;
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
	duplicate_heading?: boolean;
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
	// Byte-size of the WHOLE FILE this fragment belongs to, NOT
	// `Buffer.byteLength(content)` — `content` may be a sliced section.
	// Sourced from `readNote().sizeBytes` (D38): the raw read-window byte
	// count, NOT a re-encoding of the decoded source. The two differ by
	// the BOM length (3) for UTF-8 files with a leading BOM, because
	// `TextDecoder` strips the BOM during decode.
	file_size_bytes: number;
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
	has?: string | undefined;
	has_any?: string[] | undefined;
	has_all?: string[] | undefined;
}

export interface DateOps {
	gte?: string | undefined;
	lte?: string | undefined;
	gt?: string | undefined;
	lt?: string | undefined;
}

/**
 * `fields[name]` range bounds accept string OR number. Date-typed fields
 * use ISO strings; scalar fields use numbers. The compiler's disambiguator
 * (filter.ts) routes by value type at runtime.
 */
export interface FieldRangeOps {
	gte?: string | number | undefined;
	lte?: string | number | undefined;
	gt?: string | number | undefined;
	lt?: string | number | undefined;
}

export interface ScalarOps<T = unknown> {
	eq?: T | undefined;
	ne?: T | undefined;
	in?: T[] | undefined;
	nin?: T[] | undefined;
	contains?: string | undefined;
	is_empty?: boolean | undefined;
}

export type FieldOps = ScalarOps<unknown> | TagOps | DateOps | FieldRangeOps;

export interface Filter {
	tags?: TagOps | undefined;
	date?: DateOps | undefined;
	fields?: Record<string, FieldOps> | undefined;
	and?: Filter[] | undefined;
	or?: Filter[] | undefined;
	not?: Filter | undefined;
}

export interface SearchScope {
	path?: string | undefined;
}

export interface SearchInput {
	query: string;
	scope?: SearchScope | undefined;
	filters?: Filter | undefined;
	cursor?: string | undefined;
	pageSize?: number | undefined;
}

export type ScoreType = "bm25" | "filter" | "rrf" | "hybrid";
export type Retriever = "bm25" | "filter";

/** Discriminator for `SearchResult` and the `fragments.anchor_kind` column (D31). */
export type AnchorKind = "heading" | "preamble" | "file";

/** `search.scope.path` resolves to one of these per `fs.stat` classification. */
export type SearchScopeKind = "vault" | "subtree" | "file";

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

// ─── Links (Brief lines 312–372, D34) ──────────────────────────────────────

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
	direction?: LinkDirection | undefined;
	heading_path?: string | string[] | undefined;
	stable_id?: string | undefined;
	cursor?: string | undefined;
	pageSize?: number | undefined;
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

// ─── get_server_info (D37) ─────────────────────────────────────────────────

/**
 * Zero-input identity / health snapshot for AI-agent self-verification.
 * Always succeeds — does not gate on warm state because identity must be
 * queryable from the moment the server connects. Per D37, this tool is
 * metadata-only and counts toward the public surface as "7th tool" with
 * a deliberate exception to the 6-tools principle.
 */
export type GetServerInfoInput = Record<string, never> | undefined;

export interface ServerIdentity {
	name: string;
	version: string;
	mcp_protocol_version: string;
	started_at: string;
}

export interface VaultIdentity {
	root_hash: string;
	include_hidden: boolean;
	extensions: string[];
	case_insensitive_fs: boolean;
}

export interface IndexIdentity {
	schema_version: number;
	state: IndexState;
	files_indexed: number;
	ever_complete: boolean;
	last_scan_finished_at?: string;
	degraded?: IndexDegraded;
}

export interface AlgorithmIdentity {
	tokenizer: string;
	query_algorithm: string;
	snippet_algorithm_query: string;
	snippet_algorithm_filter: string;
	fuzzy_algorithm: string;
}

export interface CapabilitiesIdentity {
	tools: string[];
	resources: string[];
}

export interface GetServerInfoResult {
	server: ServerIdentity;
	vault: VaultIdentity;
	/** `null` when the server is running without an `IndexHandle` (W1
	 * stub / misconfig path); identity surfaces stay available. */
	index: IndexIdentity | null;
	algorithms: AlgorithmIdentity;
	capabilities: CapabilitiesIdentity;
}
