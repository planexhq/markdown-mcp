/**
 * Zod input schemas for the 6 MCP tools.
 *
 * Reasons this lives in its own file (per Plan-agent guidance):
 * - Six tools' schemas with discriminated unions and recursive `Filter`
 *   add up to >300 LOC; `server.ts` should be wiring only.
 * - Test code can validate fixtures against the schemas directly.
 *
 * Exported as `z.strictObject(...)` ZodObjects, NOT raw shapes. The SDK
 * auto-wraps a raw shape with default Zod `.strip()` behavior, which silently
 * drops typo'd top-level keys (`scpoe` for `scope` etc.) and turns a
 * constrained search into an unconstrained one. Strict ZodObjects pass through
 * the SDK unchanged.
 */

import { z } from "zod";

import { MAX_PATH_DEPTH } from "./lib/limits.js";

// ─── Reusable primitives ───────────────────────────────────────────────────

// Path-domain rejections live in `validatePath` so every caller produces
// the same `VaultError` envelope. Schema must stay permissive.
const FilePath = z.string().describe("Vault-relative path with forward slashes (e.g., 'notes/auth.md').");

const StableId = z
	.string()
	.regex(/^h:[0-9a-f]{14}$/i, "stable_id must be 'h:' followed by 14 hex chars.")
	.describe("Heading stable_id from get_file_outline.");

const HeadingPathInput = z
	.union([z.string().describe("'A > B' string form."), z.array(z.string().min(1)).describe("Canonical string[] form.")])
	.describe("Heading path: 'A > B' string OR string[] (array form is unambiguous).");

const Cursor = z.string().describe("Opaque pagination cursor; pass next page's nextCursor verbatim.");

// Schema permissive: any positive int. Per Brief line 445 + D26, the
// 200 cap is server-side silent-clamp, NOT a schema-layer reject —
// matches the `query` length pattern below.
const PageSize = z.number().int().min(1).describe("Page size; default 50, server silently clamps above 200.");

const Depth = z.number().int().min(0).max(MAX_PATH_DEPTH).describe(`Tree depth (0–${MAX_PATH_DEPTH}; default 2).`);

// ─── get_vault_tree ────────────────────────────────────────────────────────

export const GetVaultTreeSchema = z.strictObject({
	path: FilePath.optional(),
	depth: Depth.optional(),
	cursor: Cursor.optional(),
	pageSize: PageSize.optional(),
});

// ─── get_file_outline ──────────────────────────────────────────────────────

export const GetFileOutlineSchema = z.strictObject({
	file: FilePath,
});

// ─── get_fragment ──────────────────────────────────────────────────────────

const HeadingPathAnchor = z.strictObject({
	kind: z.literal("heading_path"),
	path: HeadingPathInput,
});

const BlockAnchor = z.strictObject({
	kind: z.literal("block"),
	id: z.string().min(1).describe("Block ID without the leading caret."),
});

const FileAnchor = z.strictObject({
	kind: z.literal("file"),
});

const Anchor = z.discriminatedUnion("kind", [HeadingPathAnchor, BlockAnchor, FileAnchor]);

// `false` means "do not expand"; `max_depth > 10` is clamped (not
// rejected) server-side, so schema must accept any positive integer.
// strictObject on the object branch so a typo'd `maxDepth` surfaces
// InvalidParams instead of silently falling through to default depth 10.
const ExpandEmbedsOption = z.union([
	z.boolean().describe("true = expand with default max_depth 10; false = do not expand."),
	z
		.strictObject({
			max_depth: z.number().int().min(1).optional().describe("1+; values >10 clamped server-side."),
		})
		.describe("Object form for explicit max_depth control."),
]);

export const GetFragmentSchema = z.strictObject({
	file: FilePath,
	anchor: Anchor,
	stable_id: StableId.optional(),
	expand_embeds: ExpandEmbedsOption.optional(),
});

// ─── Filter (shared between search.filters) ────────────────────────────────

const TagOps = z.strictObject({
	has: z.string().optional(),
	has_any: z.array(z.string()).optional(),
	has_all: z.array(z.string()).optional(),
});

const IsoDate = z.string().describe("ISO 8601 date or datetime string (UTC default).");

// Top-level `filter.date` is the reserved-date COALESCE chain — chronological
// only, so range bounds stay string-only.
const DateOps = z.strictObject({
	gte: IsoDate.optional(),
	lte: IsoDate.optional(),
	gt: IsoDate.optional(),
	lt: IsoDate.optional(),
});

// `fields[name]` range ops accept string OR number — date-typed fields use
// ISO strings; scalar fields (e.g. `priority: 5`) use numbers. Compiler's
// disambiguator routes by value type per D12 Note.
const FieldRangeOps = z.strictObject({
	gte: z.union([z.string(), z.number()]).optional(),
	lte: z.union([z.string(), z.number()]).optional(),
	gt: z.union([z.string(), z.number()]).optional(),
	lt: z.union([z.string(), z.number()]).optional(),
});

const ScalarOps = z.strictObject({
	eq: z.unknown().optional(),
	ne: z.unknown().optional(),
	in: z.array(z.unknown()).optional(),
	nin: z.array(z.unknown()).optional(),
	contains: z.string().optional(),
	is_empty: z.boolean().optional(),
});

// Flat strict — accepts any combination of scalar/tag/date operators and
// rejects unknown keys. The handler does runtime disambiguation per D12 Note
// (`has*` → tag, ISO `gte/lte/gt/lt` → date, else scalar; mixed categories
// surface as the FILTER_SYNTAX_ERROR domain envelope, which the schema must
// stay permissive enough to allow through).
const FieldOps = z.strictObject({
	...ScalarOps.shape,
	...TagOps.shape,
	...FieldRangeOps.shape,
});

// Recursive Filter via z.lazy. The explicit `| undefined` on optional
// fields satisfies the project's `exactOptionalPropertyTypes: true`
// because Zod's inferred output makes optional fields `T | undefined`.
type FilterShape = {
	tags?: z.infer<typeof TagOps> | undefined;
	date?: z.infer<typeof DateOps> | undefined;
	fields?: Record<string, z.infer<typeof FieldOps>> | undefined;
	and?: FilterShape[] | undefined;
	or?: FilterShape[] | undefined;
	not?: FilterShape | undefined;
};

// Unknown keys must reject — a typo'd filter key shouldn't silently
// turn a constrained search into an unconstrained one.
const Filter: z.ZodType<FilterShape> = z.lazy(() =>
	z.strictObject({
		tags: TagOps.optional(),
		date: DateOps.optional(),
		fields: z.record(z.string(), FieldOps).optional(),
		and: z.array(Filter).optional(),
		or: z.array(Filter).optional(),
		not: Filter.optional(),
	}),
);

// ─── search ────────────────────────────────────────────────────────────────

const SearchScope = z.strictObject({
	path: FilePath.optional(),
});

export const SearchSchema = z.strictObject({
	// Length cap lives in the handler so over-length queries surface
	// `INVALID_QUERY` instead of a schema-layer InvalidParams.
	query: z.string().describe("Free-text search query."),
	scope: SearchScope.optional(),
	filters: Filter.optional(),
	cursor: Cursor.optional(),
	pageSize: PageSize.optional(),
});

// ─── get_metadata ──────────────────────────────────────────────────────────

export const GetMetadataSchema = z.strictObject({
	file: FilePath,
});

// ─── get_links ─────────────────────────────────────────────────────────────

export const GetLinksSchema = z.strictObject({
	file: FilePath,
	direction: z.enum(["in", "out", "both"]).optional(),
	heading_path: HeadingPathInput.optional(),
	stable_id: StableId.optional(),
	cursor: Cursor.optional(),
	pageSize: PageSize.optional(),
});

// ─── Tool descriptions (used at registration time) ─────────────────────────

export const TOOL_DESCRIPTIONS = {
	get_vault_tree:
		"Folder + file tree rooted at `path` (default vault root) up to `depth` levels (default 2). Paginated; markdown-extension files emit MCP resource_link blocks for note:// attach.",
	get_file_outline: "Heading tree + flat block-ID index for one file. No body text. Not paginated.",
	get_fragment:
		"Returns the raw markdown content of a specific heading section, block, or whole file. Optional embed expansion.",
	search:
		"BM25 full-text search across the vault, with optional metadata filters (tags / date / arbitrary frontmatter fields). Empty query + filters = filter-only mode.",
	get_metadata: "Parsed YAML frontmatter for a single file as JSON; nested objects preserved.",
	get_links:
		"Backlinks (incoming) + forward links (outgoing) for a file or specific section. `direction: in|out|both` (default both); narrow by `heading_path` or `stable_id`.",
} as const satisfies Record<string, string>;
