/**
 * Prisma schema (PSL) synthesizer.
 *
 * Each top-level block — `model`, `enum`, `view`, `type`, `datasource`,
 * `generator` — emits one `HeadingMeta`. `structuralPath = "<kind>[<sha14(name)>]"`
 * is kind-prefixed so `model User` and `enum User` produce distinct
 * `stable_id`s. Heading text is `<kind> <name>` matching PSL source syntax.
 *
 * Prose body per block: leading `///` doc-comment paragraph, fields/enum
 * values/assignments as bullet lists, plus a compact JSON fence carrying the
 * full AST subtree (64 KiB cap, `json` → `text` language swap on truncation,
 * `__proto__` keys filtered via the shared `jsonSanitizeReplacer`).
 *
 * `frontmatter` = `{ datasource: {<name>: assignments}, generator: {<name>: assignments} }`
 * so nested-path filters (`fields["datasource.db.provider"].eq`) work.
 *
 * `note://schema.prisma` returns LITERAL on-disk bytes (`text/x-prisma`);
 * `get_fragment` returns the synthesized prose. Wikilinks INTO `.prisma`
 * are deferred via `isResolvableLinkTarget` gate.
 */

import { createRequire } from "node:module";

import type { ContentKind, HeadingLevel } from "../../types.js";
import type { ExcludedRange } from "../blockIds.js";
import { errorMessage } from "../error.js";
import { MAX_AST_NODES } from "../limits.js";
import {
	annotateDescendantTokens,
	buildOutlineTree,
	countLines,
	createSlugDedup,
	type HeadingMeta,
	isPlainObject,
	normalizeHeadingText,
	type OffsetRange,
	type ParsedFile,
	ParseError,
	type ParseFileOptions,
} from "../parser.js";
import { sha1HexN, stableId } from "../structuralPath.js";
import { estimateTokens } from "../tokenizer.js";
import {
	computeLineRange,
	computeLineStarts,
	DANGEROUS_KEYS,
	deepSanitize,
	hasFrontmatterKeys,
	jsonSanitizeReplacer,
	kebabSlug,
	stringifyJsonForFence,
} from "./shared.js";

const INDEXABLE_KINDS: ReadonlySet<string> = new Set(["model", "enum", "view", "type", "datasource", "generator"]);
/** Blocks that carry a `properties[]` field list (model/view/type). Enum and datasource/generator dispatch by direct equality. */
const MODEL_LIKE_KINDS: ReadonlySet<string> = new Set(["model", "view", "type"]);

const DOC_COMMENT_PREFIX = "///";

// ─── Public surface ────────────────────────────────────────────────────────

/**
 * Returns true iff `schema` is the shape `getSchema` produces AND has at
 * least one indexable top-level block. Empty schemas (only `Break` / `//`
 * comments, no blocks AND no `///` docs) return false so the dispatcher
 * falls through to an empty-but-valid `ParsedFile`.
 */
export function detectPrisma(schema: unknown): schema is PrismaSchema {
	if (!isPlainObject(schema)) return false;
	const list = schema.list;
	if (!Array.isArray(list)) return false;
	for (const entry of list) {
		if (!isPlainObject(entry)) continue;
		const t = entry.type;
		if (typeof t === "string" && INDEXABLE_KINDS.has(t)) return true;
		if (t === "comment" && isDocCommentText(entry.text)) return true;
	}
	return false;
}

/**
 * Parse `source` as a Prisma schema. Hard caps: file size enforced by the
 * scanner BEFORE parsing (`FILE_TOO_LARGE`); AST node count via
 * `MAX_AST_NODES` after parse (`PRISMA_PARSE_ERROR.reason =
 * "ast_node_cap_exceeded"`). Syntax errors carry `line` / `column` extracted
 * from chevrotain's token info.
 */
export function parsePrismaFile(source: string, relpath: string, options: ParseFileOptions = {}): ParsedFile {
	const { schema, blockComments } = parsePrismaSource(source);
	enforceNodeCap(schema, options.maxAstNodes ?? MAX_AST_NODES);
	if (!detectPrisma(schema) && blockComments.length === 0) {
		return buildOpaqueFile(source, relpath, null, false, /* withBodyPreamble */ true);
	}
	if (options.frontmatterOnly) {
		// `frontmatterOnly` callers (currently `get_metadata`) read only
		// `frontmatter`/`hasFrontmatter`. Skip heading synthesis — it would
		// invoke `estimateTokens`, which throws on any non-default
		// `VAULT_TOKENIZER` even though no token field is returned.
		const { blocks } = enumerateSchema(schema, []);
		const frontmatter = buildFrontmatter(blocks);
		return buildOpaqueFile(source, relpath, frontmatter, hasFrontmatterKeys(frontmatter), /* withBodyPreamble */ false);
	}
	const synthesized = synthesizePrismaFile(schema, relpath, blockComments);
	return synthesized ?? buildOpaqueFile(source, relpath, null, false, /* withBodyPreamble */ true);
}

/**
 * Synthesize a `ParsedFile` from an already-parsed PSL `Schema`. Exposed
 * for unit tests; production callers use `parsePrismaFile`. Returns `null`
 * when the schema has zero indexable blocks AND no floating notes — caller
 * falls back to opaque emission so a sparse PSL file stays searchable.
 *
 * `blockComments` carries `/* ... * /` runs that `parsePrismaSource`
 * pre-strips before passing source to `getSchema` (the upstream lexer
 * rejects block comments outright). Each comment surfaces in the
 * `## Schema notes` floating section. Per Prisma's PSL grammar block
 * comments "attach to AST nodes", but `prisma-ast` discards the
 * attachment — re-attaching would require correlating pre-strip offsets
 * to post-strip AST node positions and is deferred to v1.x.
 */
export function synthesizePrismaFile(
	schema: PrismaSchema,
	relpath: string,
	blockComments: ReadonlyArray<string> = [],
): ParsedFile | null {
	const { blocks, floating } = enumerateSchema(schema, blockComments);
	if (blocks.length === 0 && floating.length === 0) return null;

	const built = buildSynthesizedSource(blocks, floating);
	const lineStarts = computeLineStarts(built.source);
	const dedupSlug = createSlugDedup();
	const headings = built.sections.map((sec) => buildHeadingMeta(sec, relpath, built.source, lineStarts, dedupSlug));
	const outline = buildOutlineTree(headings);
	annotateDescendantTokens(outline, headings);
	const frontmatter = buildFrontmatter(blocks);

	return {
		kind: "prisma",
		relpath,
		source: built.source,
		hasFrontmatter: hasFrontmatterKeys(frontmatter),
		frontmatter,
		frontmatterEndOffset: 0,
		outline,
		blockIndex: {},
		headings,
		blocks: [],
		preamble: null,
		excludedRanges: built.excludedRanges,
	};
}

// ─── AST types (mirror of @mrleebo/prisma-ast shape we depend on) ─────────

/** Top-level schema returned by `getSchema`. */
export interface PrismaSchema {
	type: "schema";
	list: SchemaEntry[];
}

/** Discriminated union of entries in `schema.list`. */
type SchemaEntry = PrismaBlock | CommentEntry | BreakEntry | UnknownEntry;
type PrismaBlock = ModelLikeBlock | EnumBlock | ConfigBlock;

interface ModelLikeBlock {
	type: "model" | "view" | "type";
	name: string;
	properties?: ModelProperty[];
}

interface EnumBlock {
	type: "enum";
	name: string;
	enumerators?: EnumProperty[];
}

interface ConfigBlock {
	type: "datasource" | "generator";
	name: string;
	assignments?: Assignment[];
}

interface CommentEntry {
	type: "comment";
	text: string;
}

interface BreakEntry {
	type: "break";
}

interface UnknownEntry {
	type: string;
	[k: string]: unknown;
}

type ModelProperty = FieldNode | AttributeNode | CommentEntry | BreakEntry | UnknownEntry;
type EnumProperty = EnumeratorNode | AttributeNode | CommentEntry | BreakEntry | UnknownEntry;

interface FieldNode {
	type: "field";
	name: string;
	fieldType: string | FuncNode;
	array?: boolean;
	optional?: boolean;
	attributes?: AttributeNode[];
	comment?: string;
}

interface EnumeratorNode {
	type: "enumerator";
	name: string;
	attributes?: AttributeNode[];
	comment?: string;
}

interface AttributeNode {
	type: "attribute";
	kind: "field" | "object" | "view" | "type";
	name: string;
	group?: string;
	args?: AttributeArg[];
}

interface AttributeArg {
	type: "attributeArgument";
	value: unknown;
}

interface FuncNode {
	type: "function";
	name: string;
	params?: unknown[];
}

interface Assignment {
	type: "assignment";
	key: string;
	value: unknown;
}

// ─── Block enumeration ─────────────────────────────────────────────────────

interface BlockEntry {
	block: PrismaBlock;
	leadingDocs: string[];
}

interface SchemaEnumeration {
	blocks: BlockEntry[];
	floating: string[];
}

/**
 * Single forward pass partitioning `schema.list` into indexable blocks
 * (with their leading `///` doc comments attached) and free-floating
 * comments destined for the `## Schema notes` catch-all.
 *
 * Attachment rule: `///` Comments accumulate in `pendingDocs` until the
 * next indexable block consumes them. Any other entry — `//` Comment,
 * non-block typed entry, or shape-bad — is a barrier: pendingDocs flush
 * to `floating` because nothing absorbed them. `Break` entries do not
 * reset the accumulator (matches Prisma's own formatter, where blank
 * lines between a doc and a block don't break attachment). Bare `//`
 * Comments are dropped.
 *
 * `blockComments` carries the pre-stripped `/* * /` runs supplied by
 * `parsePrismaSource`; they're appended to `floating` after the
 * in-source `///` docs (re-attachment to AST nodes is deferred — see
 * `synthesizePrismaFile`).
 */
function enumerateSchema(schema: PrismaSchema, blockComments: ReadonlyArray<string>): SchemaEnumeration {
	const blocks: BlockEntry[] = [];
	const floating: string[] = [];
	let pendingDocs: string[] = [];

	const flushPending = (): void => {
		if (pendingDocs.length === 0) return;
		for (const doc of pendingDocs) floating.push(doc);
		pendingDocs = [];
	};

	for (const entry of schema.list) {
		if (!isPlainObject(entry)) {
			flushPending();
			continue;
		}
		if (entry.type === "break") continue;
		if (entry.type === "comment") {
			const doc = readDocCommentText(entry);
			if (doc !== null) {
				pendingDocs.push(doc);
				continue;
			}
			flushPending();
			continue;
		}
		if (typeof entry.type === "string" && INDEXABLE_KINDS.has(entry.type)) {
			blocks.push({ block: entry as unknown as PrismaBlock, leadingDocs: pendingDocs });
			pendingDocs = [];
			continue;
		}
		flushPending();
	}
	flushPending();
	for (const bc of blockComments) {
		if (bc.length > 0) floating.push(bc);
	}
	return { blocks, floating };
}

function isDocCommentText(text: unknown): text is string {
	return typeof text === "string" && text.startsWith(DOC_COMMENT_PREFIX);
}

/**
 * Returns the stripped body of a `///` doc comment when `entry` is a
 * Comment node with `///`-prefixed text; null otherwise. Folds the
 * type-check + cast + strip into one call so AST-walk sites stay free of
 * `as unknown as CommentEntry` noise.
 */
function readDocCommentText(entry: Record<string, unknown>): string | null {
	if (entry.type !== "comment") return null;
	const text = entry.text;
	if (typeof text !== "string" || !text.startsWith(DOC_COMMENT_PREFIX)) return null;
	return text.slice(DOC_COMMENT_PREFIX.length).trim();
}

/**
 * Trailing-comment extractor for `field.comment` / `enumerator.comment`.
 * `@mrleebo/prisma-ast` populates `.comment` with the verbatim source for
 * BOTH `// note` and `/// note` trailing forms — accepting either would
 * surface bare `//` comments (contradicting the documented drop policy)
 * AND render the literal `///` prefix in the bullet output. Filter to
 * `///`-only and strip the prefix.
 */
function readTrailingDoc(comment: unknown): string | null {
	if (typeof comment !== "string" || !comment.startsWith(DOC_COMMENT_PREFIX)) return null;
	return comment.slice(DOC_COMMENT_PREFIX.length).trim();
}

// ─── Source synthesis ──────────────────────────────────────────────────────

interface SynthSection {
	headingText: string;
	structuralSlot: string;
	baseSlug: string;
	contentKinds: ContentKind[];
	rangeStart: number;
	rangeEnd: number;
	headingLineEnd: number;
	headingLineEndChar: number;
}

interface SynthesisResult {
	source: string;
	sections: SynthSection[];
	excludedRanges: ExcludedRange[];
}

function buildSynthesizedSource(blocks: ReadonlyArray<BlockEntry>, floating: ReadonlyArray<string>): SynthesisResult {
	const chunks: string[] = [];
	let offset = 0;
	const excludedRanges: ExcludedRange[] = [];
	const sections: SynthSection[] = [];
	// `@mrleebo/prisma-ast` is a lenient AST parser — block-name uniqueness is
	// a Prisma-compiler semantic check, not a lexer rule. A schema with two
	// `model User { ... }` blocks (mid-rename, draft, paste) reaches us with
	// both blocks. Without disambiguation, both sections would emit the same
	// `<kind>[<sha14(name)>]` slot → identical stable_id → SQLite UNIQUE on
	// `fragments(file, stable_id)` rejects the second write and the file
	// wedges into a `parse_failed` retry loop. The `#N` suffix is reserved by
	// construction (PSL identifiers can't contain `#`), keeps unique-name
	// schemas byte-for-byte stable, and lets the standard stale_id fuzzy path
	// recover when the user fixes the duplication.
	const seenSlots = new Map<string, number>();

	const emit = (s: string): void => {
		chunks.push(s);
		offset += s.length;
	};

	for (const entry of blocks) {
		const sectionStart = offset;
		const kind = entry.block.type;
		const name = entry.block.name;
		const rawHeadingText = `${kind} ${name}`;
		const headingLine = `## ${normalizeHeadingText(rawHeadingText)}\n`;
		const headingLineEndChar = offset + headingLine.length - 1;
		emit(headingLine);
		emit("\n");
		const headingLineEnd = offset;

		const hasListItems = renderBlockProse(entry, emit);

		const fenceStart = offset;
		const fence = stringifyJsonForFence(
			stripBareCommentsFromBlock(entry.block),
			`Prisma ${kind}`,
			(msg) => ParseError.prisma("syntax", msg),
			jsonSanitizeReplacer,
		);
		emit(`\`\`\`${fence.language}\n`);
		emit(`${fence.body}\n`);
		emit("```\n\n");
		excludedRanges.push({ offsetStart: fenceStart, offsetEnd: offset });

		const baseSlot = `${kind}[${sha1HexN(name, 14)}]`;
		const ordinal = (seenSlots.get(baseSlot) ?? 0) + 1;
		seenSlots.set(baseSlot, ordinal);
		const structuralSlot = ordinal === 1 ? baseSlot : `${baseSlot}#${ordinal}`;

		const contentKinds: ContentKind[] = hasListItems ? ["code", "list"] : ["code"];
		sections.push({
			headingText: rawHeadingText,
			structuralSlot,
			baseSlug: kebabSlug(`${kind}-${name}`, "block"),
			contentKinds,
			rangeStart: sectionStart,
			rangeEnd: offset,
			headingLineEnd,
			headingLineEndChar,
		});
	}

	if (floating.length > 0) {
		const sectionStart = offset;
		const rawHeadingText = "Schema notes";
		const headingLine = `## ${rawHeadingText}\n`;
		const headingLineEndChar = offset + headingLine.length - 1;
		emit(headingLine);
		emit("\n");
		const headingLineEnd = offset;
		for (const doc of floating) {
			emit(`${doc}\n\n`);
		}
		sections.push({
			headingText: rawHeadingText,
			structuralSlot: "schema_notes",
			baseSlug: "schema-notes",
			contentKinds: [],
			rangeStart: sectionStart,
			rangeEnd: offset,
			headingLineEnd,
			headingLineEndChar,
		});
	}

	return { source: chunks.join(""), sections, excludedRanges };
}

// ─── Prose rendering ───────────────────────────────────────────────────────

/**
 * Renders the block's prose body (doc comments + fields/values/settings +
 * block attributes) and returns whether the block produced any list-like
 * content. The boolean drives `contentKinds: ["code", "list"]` vs `["code"]`
 * at the call site — avoids a separate walk of `properties[]` / `enumerators[]`
 * / `assignments[]` just to compute that flag.
 */
function renderBlockProse(entry: BlockEntry, emit: (s: string) => void): boolean {
	if (entry.leadingDocs.length > 0) {
		for (const doc of entry.leadingDocs) emit(`${doc}\n`);
		emit("\n");
	}
	const kind = entry.block.type;
	if (MODEL_LIKE_KINDS.has(kind)) return renderModelLikeProse(entry.block as ModelLikeBlock, emit);
	if (kind === "enum") return renderEnumProse(entry.block as EnumBlock, emit);
	return renderConfigProse(entry.block as ConfigBlock, emit);
}

function renderModelLikeProse(block: ModelLikeBlock, emit: (s: string) => void): boolean {
	const props = Array.isArray(block.properties) ? block.properties : [];
	const { fields, blockAttrs, tableName, trailingDocs } = analyzeModelLikeProperties(props);

	// `@@map` → `Table:` line so agents bridging to raw SQL can find the
	// underlying table name without parsing the JSON fence.
	if (tableName !== null) emit(`Table: ${tableName}\n\n`);

	if (fields.length > 0) {
		emit("Fields:\n");
		for (const { node, doc } of fields) emit(`- ${formatFieldBullet(node, doc)}\n`);
		emit("\n");
	}

	if (blockAttrs.length > 0) {
		emit("Block attributes:\n");
		for (const { node, doc } of blockAttrs) emit(`- ${formatAttributeBullet(node, doc)}\n`);
		emit("\n");
	}

	if (trailingDocs.length > 0) {
		emit("Notes:\n");
		for (const d of trailingDocs) emit(`- ${d}\n`);
		emit("\n");
	}

	return fields.length > 0 || blockAttrs.length > 0 || trailingDocs.length > 0;
}

function renderEnumProse(block: EnumBlock, emit: (s: string) => void): boolean {
	const props = Array.isArray(block.enumerators) ? block.enumerators : [];
	const { values, blockAttrs, trailingDocs } = analyzeEnumEnumerators(props);

	if (values.length > 0) {
		emit("Values:\n");
		for (const { node, doc } of values) emit(`- ${formatEnumValueBullet(node, doc)}\n`);
		emit("\n");
	}

	if (blockAttrs.length > 0) {
		emit("Block attributes:\n");
		for (const { node, doc } of blockAttrs) emit(`- ${formatAttributeBullet(node, doc)}\n`);
		emit("\n");
	}

	if (trailingDocs.length > 0) {
		emit("Notes:\n");
		for (const d of trailingDocs) emit(`- ${d}\n`);
		emit("\n");
	}

	return values.length > 0 || blockAttrs.length > 0 || trailingDocs.length > 0;
}

function renderConfigProse(block: ConfigBlock, emit: (s: string) => void): boolean {
	const assignments = Array.isArray(block.assignments) ? block.assignments : [];
	if (assignments.length === 0) return false;
	emit("Settings:\n");
	for (const a of assignments) {
		if (!isPlainObject(a) || a.type !== "assignment" || typeof a.key !== "string") continue;
		emit(`- ${a.key} = ${formatValueForProse(a.value)}\n`);
	}
	emit("\n");
	return true;
}

interface AttachedNode<T> {
	node: T;
	doc: string | null;
}

/**
 * Single forward pass over `properties[]` / `enumerators[]`: accumulates
 * preceding `///` doc comments, attaches them to the next node whose
 * `entry.type === valueType` OR to the next block-level attribute
 * (joining multiple lines with a space, mirroring field-bullet style),
 * and invokes `onBlockAttribute` for each block-level attribute (model
 * uses this to capture `@@map`).
 *
 * Attachment precedence on value nodes: preceding `///` wins; if absent,
 * trailing `///` on the value node (`field.comment` / `enumerator.comment`)
 * is used. Bare `//` trailing comments are dropped by `readTrailingDoc`.
 *
 * Orphan `///` runs — docs preceding a barrier (malformed entry, unknown
 * typed entry) OR sitting at end-of-block with no consumer — drain into
 * `trailingDocs` instead of being silently discarded. Callers surface them
 * as a per-block `Notes:` sub-section so body-weighted FTS search can find
 * them.
 */
function analyzeNodesWithDocs<T>(
	props: ReadonlyArray<unknown>,
	valueType: string,
	onBlockAttribute: (attr: AttributeNode) => void,
): { entries: AttachedNode<T>[]; blockAttrs: AttachedNode<AttributeNode>[]; trailingDocs: string[] } {
	const entries: AttachedNode<T>[] = [];
	const blockAttrs: AttachedNode<AttributeNode>[] = [];
	const trailingDocs: string[] = [];
	let pendingDocs: string[] = [];

	const flushPending = (): void => {
		if (pendingDocs.length === 0) return;
		for (const d of pendingDocs) trailingDocs.push(d);
		pendingDocs = [];
	};

	/** Joins + consumes `pendingDocs`. Returns null when empty so callers can `?? trailing`. */
	const takePendingDoc = (): string | null => {
		if (pendingDocs.length === 0) return null;
		const joined = pendingDocs.join(" ");
		pendingDocs = [];
		return joined;
	};

	for (const p of props) {
		if (!isPlainObject(p)) {
			flushPending();
			continue;
		}
		const doc = readDocCommentText(p);
		if (doc !== null) {
			pendingDocs.push(doc);
			continue;
		}
		if (p.type === "break") continue;
		if (p.type === valueType) {
			const preceding = takePendingDoc();
			const trailing = readTrailingDoc((p as { comment?: unknown }).comment);
			entries.push({ node: p as unknown as T, doc: preceding ?? trailing });
			continue;
		}
		if (p.type === "attribute") {
			const a = p as unknown as AttributeNode;
			if (a.kind !== "field") {
				blockAttrs.push({ node: a, doc: takePendingDoc() });
				onBlockAttribute(a);
				continue;
			}
		}
		flushPending();
	}
	flushPending();
	return { entries, blockAttrs, trailingDocs };
}

/** `model`/`view`/`type` properties: delegates to `analyzeNodesWithDocs` and additionally captures `@@map("X")` as `tableName`. */
function analyzeModelLikeProperties(props: ReadonlyArray<ModelProperty>): {
	fields: AttachedNode<FieldNode>[];
	blockAttrs: AttachedNode<AttributeNode>[];
	tableName: string | null;
	trailingDocs: string[];
} {
	let tableName: string | null = null;
	const { entries, blockAttrs, trailingDocs } = analyzeNodesWithDocs<FieldNode>(props, "field", (a) => {
		if (tableName !== null || a.name !== "map") return;
		const first = Array.isArray(a.args) ? a.args[0] : undefined;
		if (!first || !isPlainObject(first)) return;
		// Positional `@@map("X")` → `first.value` is the quoted string.
		// Named `@@map(name: "X")` → `first.value` is { type: "keyValue", key, value }.
		const raw = first.value;
		if (typeof raw === "string") {
			tableName = stripQuotes(raw);
		} else if (isPlainObject(raw) && raw.type === "keyValue" && raw.key === "name" && typeof raw.value === "string") {
			tableName = stripQuotes(raw.value);
		}
	});
	return { fields: entries, blockAttrs, tableName, trailingDocs };
}

/** `enum` enumerators: thin wrapper around `analyzeNodesWithDocs` with no attribute side-effects. */
function analyzeEnumEnumerators(props: ReadonlyArray<EnumProperty>): {
	values: AttachedNode<EnumeratorNode>[];
	blockAttrs: AttachedNode<AttributeNode>[];
	trailingDocs: string[];
} {
	const { entries, blockAttrs, trailingDocs } = analyzeNodesWithDocs<EnumeratorNode>(props, "enumerator", () => {});
	return { values: entries, blockAttrs, trailingDocs };
}

function formatFieldBullet(field: FieldNode, doc: string | null): string {
	const typeStr = formatFieldType(field);
	const attrs = Array.isArray(field.attributes) ? field.attributes.map(formatAttributeProse).filter(Boolean) : [];
	const attrSuffix = attrs.length > 0 ? ` ${attrs.join(" ")}` : "";
	return withDocSuffix(`${field.name}: ${typeStr}${attrSuffix}`, doc);
}

function formatEnumValueBullet(node: EnumeratorNode, doc: string | null): string {
	const attrs = Array.isArray(node.attributes) ? node.attributes.map(formatAttributeProse).filter(Boolean) : [];
	const attrSuffix = attrs.length > 0 ? ` ${attrs.join(" ")}` : "";
	return withDocSuffix(`${node.name}${attrSuffix}`, doc);
}

/** Appends `— doc` to `base` when `doc` is non-null. Single source for the `///`-attachment em-dash convention shared by field, enum value, and block-attribute bullets. */
function withDocSuffix(base: string, doc: string | null): string {
	return doc !== null ? `${base} — ${doc}` : base;
}

function formatFieldType(field: FieldNode): string {
	let base: string;
	if (typeof field.fieldType === "string") base = field.fieldType;
	else if (isPlainObject(field.fieldType) && field.fieldType.type === "function")
		base = formatFunc(field.fieldType, true);
	else base = "Unknown";
	if (field.array === true) base = `${base}[]`;
	if (field.optional === true) base = `${base}?`;
	return base;
}

function formatAttributeProse(attr: AttributeNode): string {
	const prefix = attr.kind === "field" ? "@" : "@@";
	const groupPart = attr.group ? `${attr.group}.` : "";
	const argsPart =
		Array.isArray(attr.args) && attr.args.length > 0 ? `(${attr.args.map(formatAttributeArg).join(", ")})` : "";
	return `${prefix}${groupPart}${attr.name}${argsPart}`;
}

function formatAttributeBullet(attr: AttributeNode, doc: string | null): string {
	return withDocSuffix(formatAttributeProse(attr), doc);
}

/**
 * Returns a copy of `block` with bare `//` comments removed from
 * `properties[]` / `enumerators[]` / `assignments[]` AND from trailing
 * `field.comment` / `enumerator.comment` strings. `///` doc comments are
 * preserved.
 *
 * Why: `enumerateSchema`'s policy ("Bare `//` Comments are dropped") and
 * `analyzeNodesWithDocs` both correctly filter bare comments out of the
 * rendered prose, but the JSON fence consumes the raw block subtree.
 * Without this pre-walk, `// secret` text inside a block body — or a
 * trailing `// hint` on a field — surfaces verbatim in the fence body,
 * which is `code`-FTS-indexed AND get_fragment-visible.
 *
 * Replacer-based filtering can't drop array entries cleanly (returning
 * undefined from a JSON.stringify replacer for an array element produces
 * a literal `null` in the output), so we allocate a sanitized copy.
 */
function stripBareCommentsFromBlock(block: PrismaBlock): unknown {
	const out: Record<string, unknown> = { ...block };
	for (const key of ["properties", "enumerators", "assignments"] as const) {
		const arr = out[key];
		if (Array.isArray(arr)) out[key] = stripBareCommentsFromChildren(arr);
	}
	return out;
}

function stripBareCommentsFromChildren(items: ReadonlyArray<unknown>): unknown[] {
	const cleaned: unknown[] = [];
	for (const item of items) {
		if (!isPlainObject(item)) {
			cleaned.push(item);
			continue;
		}
		if (item.type === "comment" && !isDocCommentText(item.text)) continue;
		if (
			(item.type === "field" || item.type === "enumerator") &&
			typeof item.comment === "string" &&
			!item.comment.startsWith(DOC_COMMENT_PREFIX)
		) {
			const { comment: _drop, ...rest } = item;
			cleaned.push(rest);
			continue;
		}
		cleaned.push(item);
	}
	return cleaned;
}

function formatAttributeArg(arg: AttributeArg): string {
	if (!isPlainObject(arg)) return String(arg);
	// Attribute and function args: preserve string-literal quotes so
	// `@default("USER")` (string) stays distinguishable from `@default(USER)`
	// (enum-value reference) in synthesized prose. Settings prose stays at
	// the default (strip) — no enum-vs-string ambiguity there. Field-type
	// prose makes its own preserve choice at `formatFieldType` because
	// `Unsupported("X")` is mandatory PSL syntax.
	return formatValueForProse(arg.value, true);
}

function formatValueForProse(value: unknown, preserveQuotes = false): string {
	if (value === null || value === undefined) return String(value);
	if (typeof value === "string") return preserveQuotes ? value : stripQuotes(value);
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	if (Array.isArray(value)) return `[${value.map((v) => formatValueForProse(v, preserveQuotes)).join(", ")}]`;
	if (isPlainObject(value)) {
		const t = value.type;
		if (t === "function") return formatFunc(value as unknown as FuncNode, preserveQuotes);
		if (t === "array") {
			const args = Array.isArray((value as { args?: unknown[] }).args) ? (value as { args: unknown[] }).args : [];
			return `[${args.map((a) => formatValueForProse(a, preserveQuotes)).join(", ")}]`;
		}
		if (t === "keyValue") {
			const kv = value as { key?: unknown; value?: unknown };
			return `${kv.key}: ${formatValueForProse(kv.value, preserveQuotes)}`;
		}
		// Unknown object shape — fall through to JSON.
		return JSON.stringify(value);
	}
	return String(value);
}

function formatFunc(func: FuncNode, preserveQuotes = false): string {
	const params = Array.isArray(func.params)
		? func.params.map((p) => formatValueForProse(p, preserveQuotes)).join(", ")
		: "";
	return `${func.name}(${params})`;
}

/** PSL string-literal values from `prisma-ast` arrive with their surrounding quotes (e.g. `"\"postgresql\""`). Strip them for display. */
function stripQuotes(s: string): string {
	if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) return s.slice(1, -1);
	return s;
}

// ─── Frontmatter synthesis ─────────────────────────────────────────────────

function buildFrontmatter(blocks: ReadonlyArray<BlockEntry>): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const entry of blocks) {
		const kind = entry.block.type;
		if (kind !== "datasource" && kind !== "generator") continue;
		const config = entry.block as ConfigBlock;
		const obj = assignmentsToObject(Array.isArray(config.assignments) ? config.assignments : []);
		// Drop blocks literally named `__proto__` — plain assignment
		// `bucket[name] = obj` would route through Object.prototype's
		// inherited setter and rewire the bucket's [[Prototype]].
		if (DANGEROUS_KEYS.has(config.name)) continue;
		let bucket = out[kind];
		if (!isPlainObject(bucket)) {
			bucket = {};
			out[kind] = bucket;
		}
		(bucket as Record<string, unknown>)[config.name] = obj;
	}
	return out;
}

function assignmentsToObject(assignments: ReadonlyArray<Assignment>): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const a of assignments) {
		if (!isPlainObject(a) || a.type !== "assignment" || typeof a.key !== "string") continue;
		if (DANGEROUS_KEYS.has(a.key)) continue;
		out[a.key] = serializeAssignmentValue(a.value);
	}
	return out;
}

function serializeAssignmentValue(value: unknown): unknown {
	if (value === null || value === undefined) return value;
	if (typeof value === "string") return stripQuotes(value);
	if (typeof value === "number" || typeof value === "boolean") return value;
	if (Array.isArray(value)) return value.map(serializeAssignmentValue);
	if (isPlainObject(value)) {
		const t = value.type;
		if (t === "function") return formatFunc(value as unknown as FuncNode);
		if (t === "array") {
			const args = Array.isArray((value as { args?: unknown[] }).args) ? (value as { args: unknown[] }).args : [];
			return args.map(serializeAssignmentValue);
		}
		// Unknown object — best-effort deep walk dropping DANGEROUS_KEYS.
		return deepSanitize(value);
	}
	return value;
}

// ─── Heading metadata ──────────────────────────────────────────────────────

function buildHeadingMeta(
	sec: SynthSection,
	relpath: string,
	source: string,
	lineStarts: ReadonlyArray<number>,
	dedupSlug: (base: string) => string,
): HeadingMeta {
	const id = stableId(relpath, sec.structuralSlot);
	const lineRange = computeLineRange(lineStarts, sec.rangeStart, sec.rangeEnd);
	const headingLineRange = computeLineRange(lineStarts, sec.rangeStart, sec.headingLineEndChar);

	const offsetRange: OffsetRange = { start: sec.rangeStart, end: sec.rangeEnd };
	const headingLineOffset: OffsetRange = { start: sec.rangeStart, end: sec.headingLineEndChar };
	const bodyOffsetRange: OffsetRange = { start: sec.headingLineEnd, end: sec.rangeEnd };

	const bodySlice = source.slice(sec.headingLineEnd, sec.rangeEnd);
	const bodyTokensApprox = estimateTokens(bodySlice);

	const pathText = normalizeHeadingText(sec.headingText);
	return {
		stable_id: id,
		structuralPath: sec.structuralSlot,
		level: 2 as HeadingLevel,
		pathText,
		displayText: sec.headingText,
		slug: dedupSlug(sec.baseSlug),
		headingPath: [pathText],
		range: lineRange,
		selectionRange: headingLineRange,
		offsetRange,
		headingLineOffset,
		bodyOffsetRange,
		bodyTokensApprox,
		descendantTokensApprox: 0,
		subheadings: 0,
		contentKinds: sec.contentKinds,
		blockIds: [],
	};
}

// ─── Source parsing (PSL → AST) ────────────────────────────────────────────

const localRequire = createRequire(import.meta.url);

interface PrismaAstRuntime {
	getSchema: (source: string, options: { parser: unknown; visitor: unknown }) => PrismaSchema;
	PrismaParser: new (config: { nodeLocationTracking: "none" | "full" | "onlyOffset" }) => unknown;
	VisitorClassFactory: (parser: unknown) => new () => unknown;
}

interface PinnedPrismaAst {
	getSchema: PrismaAstRuntime["getSchema"];
	parser: unknown;
	visitor: unknown;
}

let cachedPrismaAst: PinnedPrismaAst | null = null;

/**
 * Lazy-loaded + config-pinned `@mrleebo/prisma-ast` runtime. Three reasons:
 *
 * (a) Markdown-only vaults never call `parsePrismaFile`, so `localRequire`
 *     never fires, so the package's module-load `defaultParser` initializer
 *     never runs.
 *
 * (b) Even when `.prisma` files are present, we use OUR pinned
 *     `PrismaParser({ nodeLocationTracking: "none" })` instance instead of
 *     the package's `defaultParser`. Ambient `parser.nodeLocationTracking:
 *     "full"` would otherwise add `location?: CstNodeLocation` to every
 *     AST node — those fields flow into the JSON fence via
 *     `stringifyJsonForFence`, drifting cached fence bytes per user
 *     environment without a `PARSER_SHAPE_VERSION`-correlated invalidation.
 *
 * (c) `@mrleebo/prisma-ast`'s module-load runs
 *     `defaultParser = new PrismaParser(getConfig().parser)`, where
 *     `getConfig()` calls `lilconfigSync('prisma-ast').search()` against
 *     `process.cwd()` and walks upward. lilconfig's default loader set
 *     INCLUDES `.js`/`.cjs`, so a `.prisma-astrc.js` (or `prisma-ast.config.js`)
 *     anywhere from cwd to `/` gets `require()`-ed — executing arbitrary
 *     JavaScript supplied by an untrusted vault. Before requiring the
 *     package we mutate the shared `lilconfig` module's exports so its
 *     `lilconfigSync(...).search()` returns `null` unconditionally. That
 *     drops `getConfig()` to its baked-in `defaultConfig`
 *     (`nodeLocationTracking: "none"`) — the same shape we'd pin anyway —
 *     while removing the file-system-walking side effect entirely.
 *
 *     The mutation targets the lilconfig instance prisma-ast will resolve
 *     (via `createRequire(prismaAstPath)`), so under flat node_modules it's
 *     the same `require.cache` entry both consumers share.
 */
function getPinnedPrismaAst(): PinnedPrismaAst {
	if (cachedPrismaAst === null) {
		const prismaAstPath = localRequire.resolve("@mrleebo/prisma-ast");
		const prismaAstScope = createRequire(prismaAstPath);
		const lilconfig = prismaAstScope("lilconfig") as {
			lilconfigSync: unknown;
			lilconfig: unknown;
		};
		lilconfig.lilconfigSync = () => ({ search: () => null, load: () => null });
		lilconfig.lilconfig = () => ({ search: async () => null, load: async () => null });

		const mod = localRequire("@mrleebo/prisma-ast") as PrismaAstRuntime;
		const parser = new mod.PrismaParser({ nodeLocationTracking: "none" });
		const VisitorClass = mod.VisitorClassFactory(parser);
		const visitor = new VisitorClass();
		cachedPrismaAst = { getSchema: mod.getSchema, parser, visitor };
	}
	return cachedPrismaAst;
}

/**
 * Wrap `getSchema` so chevrotain errors route through `ParseError.prisma`.
 * Mismatched-token errors carry `token.startLine` / `token.startColumn`;
 * `RangeError` from pathological recursion reclassifies as `ast_node_cap_exceeded`.
 *
 * Pre-strips `/* ... * /` block comments before parsing because
 * `@mrleebo/prisma-ast`'s lexer rejects them with `MismatchedTokenException`
 * even though Prisma's documented PSL grammar admits them ("attached to
 * AST nodes"). The stripped runs are returned alongside the AST so they
 * can be surfaced in `## Schema notes`.
 *
 * KNOWN UPSTREAM LIMITATION: `prisma-ast`'s `getSchema` discards
 * `lexingResult.errors` (see `@mrleebo/prisma-ast/src/getSchema.ts:24–29`)
 * and `PrismaLexer` is not named-exported, so we cannot surface lex
 * errors through the public API.
 * Pathological inputs containing characters the PSL lexer cannot tokenize
 * (e.g. a stray `$` mid-identifier, an emoji codepoint) parse with the
 * unrecognized char silently elided — `model U { $bad String }` becomes
 * `model U { bad String }`. Real `.prisma` files typically also need to
 * pass `prisma generate`, which catches the same inputs, so the practical
 * risk in a notes-vault is low. A custom pre-lexer would need to replicate
 * the ~25 token definitions from `@mrleebo/prisma-ast/src/lexer.ts`
 * verbatim and re-verify on every upstream upgrade — not worth the drift
 * risk for the residual surface. Track upstream at
 * https://github.com/MrLeebo/prisma-ast/issues — request to expose
 * `lexingResult.errors` on the returned Schema.
 */
function parsePrismaSource(source: string): { schema: PrismaSchema; blockComments: string[] } {
	const { stripped: stripped0, blockComments: blockComments0 } = stripPrismaBlockComments(source);
	const { stripped: stripped1, comments: openerLineComments } = stripBlockOpenerLineComments(stripped0);
	const stripped = normalizeBlockOpenerWhitespace(stripped1);
	const blockComments = openerLineComments.length === 0 ? blockComments0 : [...blockComments0, ...openerLineComments];
	try {
		const { getSchema, parser, visitor } = getPinnedPrismaAst();
		const schema = getSchema(stripped, { parser, visitor });
		if (!isPlainObject(schema) || !Array.isArray((schema as { list?: unknown }).list)) {
			throw ParseError.prisma("syntax", "Prisma parser returned an unexpected shape (missing `list`).");
		}
		return { schema, blockComments };
	} catch (cause) {
		if (cause instanceof ParseError) throw cause;
		if (cause instanceof RangeError) {
			throw ParseError.prisma("ast_node_cap_exceeded", `Prisma schema too deep: ${errorMessage(cause)}`);
		}
		const { line, column } = extractPrismaErrorLocation(cause);
		const opts: { line?: number; column?: number } = {};
		if (line !== undefined) opts.line = line;
		if (column !== undefined) opts.column = column;
		throw ParseError.prisma("syntax", errorMessage(cause), opts);
	}
}

/**
 * Skip a double-quoted string literal starting at `input[i]`, pushing the
 * matched run verbatim to `out`. Returns the index one past the closing
 * quote, or `null` when `input[i]` is not `"`. Honors backslash escapes.
 *
 * Shared by every PSL pre-pass that walks the source — strings must be
 * opaque to `{`/`/*`/`//` detection so embedded delimiters can't trigger
 * spurious mode changes.
 */
function consumeStringLiteral(input: string, i: number, out: string[]): number | null {
	if (input[i] !== '"') return null;
	out.push('"');
	i++;
	while (i < input.length) {
		const sc = input[i];
		if (sc === undefined) break;
		if (sc === "\\" && i + 1 < input.length) {
			out.push(sc, input[i + 1] as string);
			i += 2;
			continue;
		}
		out.push(sc);
		i++;
		if (sc === '"') break;
	}
	return i;
}

/**
 * Skip a double-quoted string literal or `//` line comment starting at
 * `input[i]`, pushing the matched run verbatim to `out`. Returns the index
 * one past the consumed run, or `null` when `input[i]` is neither.
 *
 * Shared by `stripPrismaBlockComments` and `normalizeBlockOpenerWhitespace`
 * so the two PSL pre-passes can't drift on what counts as "skippable" —
 * both must treat strings + line comments as opaque spans (a `/*` inside
 * either must not trigger block-comment mode; a `{` inside either must
 * not trigger LineBreak rotation).
 */
function consumeStringOrLineComment(input: string, i: number, out: string[]): number | null {
	const stringEnd = consumeStringLiteral(input, i, out);
	if (stringEnd !== null) return stringEnd;
	if (input[i] === "/" && input[i + 1] === "/") {
		const nl = input.indexOf("\n", i);
		const end = nl === -1 ? input.length : nl + 1;
		out.push(input.slice(i, end));
		return end;
	}
	return null;
}

/**
 * String-literal-aware pre-strip of PSL block comments (slash-star ...
 * star-slash). Replaces each block-comment run with same-length
 * whitespace (newlines preserved) so downstream line/column reporting
 * stays accurate. Double-quoted strings (with backslash escapes) and
 * `//` / `///` line comments are skipped verbatim — embedded slash-star
 * inside either cannot trigger spurious block-comment mode or, on an
 * unclosed `//` case, swallow the rest of the file. First star-slash
 * closes. Unclosed runs throw `PRISMA_PARSE_ERROR` (`reason: "syntax"`)
 * with the `/*` opener's line/column — matches Prisma compiler behavior
 * and prevents silent data loss when the swallowed body would otherwise
 * surface as a `## Schema notes` paragraph.
 */
export function stripPrismaBlockComments(source: string): { stripped: string; blockComments: string[] } {
	// Fast path: most `.prisma` files contain no block comments.
	if (source.indexOf("/*") === -1) return { stripped: source, blockComments: [] };

	const blockComments: string[] = [];
	const out: string[] = [];
	let i = 0;
	while (i < source.length) {
		const consumed = consumeStringOrLineComment(source, i, out);
		if (consumed !== null) {
			i = consumed;
			continue;
		}
		const ch = source[i];
		if (ch === "/" && source[i + 1] === "*") {
			const startOffset = i;
			i += 2;
			let closed = false;
			while (i < source.length) {
				if (source[i] === "*" && source[i + 1] === "/") {
					i += 2;
					closed = true;
					break;
				}
				i++;
			}
			if (!closed) {
				const { line, column } = offsetToLineColumn(source, startOffset);
				throw ParseError.prisma("syntax", "Unterminated block comment (missing closing `*/`).", {
					line,
					column,
				});
			}
			const run = source.slice(startOffset, i);
			out.push(run.replace(/[^\n]/g, " "));
			blockComments.push(run.slice(2, -2).trim());
			continue;
		}
		if (ch !== undefined) out.push(ch);
		i++;
	}
	return { stripped: out.join(""), blockComments };
}

/**
 * Strip `//` and `///` line comments that sit on a block-opener line — i.e.
 * `{` then optional horizontal whitespace then `//...` then `\n`, at
 * paren-depth 0. Replaces the slash-slash span with spaces of equal length
 * (byte length + line numbers preserved) and captures the comment text for
 * `## Schema notes` emission. `normalizeBlockOpenerWhitespace` then rotates
 * the resulting `{[ws]\n` to `{\n[ws]`, satisfying the parser's `LCurly
 * LineBreak` requirement.
 *
 * Why this is needed: `@mrleebo/prisma-ast`'s `LineComment` and `DocComment`
 * tokens (`lexer.ts:27-36`) are categorized under the abstract `Comment`
 * category but are NOT `Lexer.SKIPPED` — they reach the parser. The `block`
 * rule requires `LineBreak` immediately after `LCurly`, so a same-line `//`
 * or `///` comment surfaces as `parse_failed`. Comments on their own line
 * inside the block body are accepted.
 *
 * Why same-length-spaces (not collapse or rotate): preserves byte length so
 * chevrotain's error line/column numbers stay aligned. Same convention as
 * `stripPrismaBlockComments`. Lets the existing `normalizeBlockOpenerWhitespace`
 * own the spaces-before-newline rotation without duplicating that logic.
 *
 * Why `///` is stripped the same as `//`: `///` on a block-opener line is
 * non-idiomatic and fails to parse; the doc-comment can't attach to the
 * block from that position anyway. Salvaging the text into `Notes:` is
 * strictly better than `parse_failed`.
 */
function stripBlockOpenerLineComments(input: string): { stripped: string; comments: string[] } {
	// Fast path: no `{` followed by optional WS then `//` means no opener-line
	// comment to strip. Skips the full walk for the common case.
	if (!/\{[ \t]*\/\//.test(input)) return { stripped: input, comments: [] };

	let i = 0;
	let parenDepth = 0;
	const out: string[] = [];
	const comments: string[] = [];

	while (i < input.length) {
		const stringEnd = consumeStringLiteral(input, i, out);
		if (stringEnd !== null) {
			i = stringEnd;
			continue;
		}

		const ch = input[i] as string;

		if (ch === "(") parenDepth++;
		else if (ch === ")" && parenDepth > 0) parenDepth--;

		// Block opener at depth 0 — strip any same-line `//` or `///` comment.
		if (ch === "{" && parenDepth === 0) {
			let j = i + 1;
			while (j < input.length && (input[j] === " " || input[j] === "\t")) j++;
			if (input[j] === "/" && input[j + 1] === "/") {
				const nl = input.indexOf("\n", j);
				const slashEnd = nl === -1 ? input.length : nl;
				comments.push(
					input
						.slice(j, slashEnd)
						.replace(/^\/\/\/?[ \t]*/, "")
						.trimEnd(),
				);
				out.push("{");
				out.push(input.slice(i + 1, j));
				out.push(" ".repeat(slashEnd - j));
				i = slashEnd;
				continue;
			}
		}

		// Line comment outside the block-opener context — passthrough verbatim.
		if (ch === "/" && input[i + 1] === "/") {
			const nl = input.indexOf("\n", i);
			const end = nl === -1 ? input.length : nl;
			out.push(input.slice(i, end));
			i = end;
			continue;
		}

		out.push(ch);
		i++;
	}

	return { stripped: out.join(""), comments };
}

/**
 * Rewrite `{[ \t]+(\r?\n)` → `{(\r?\n)[ \t]+` at paren-depth 0 so the
 * upstream chevrotain lexer produces the `LineBreak` token the `block`
 * rule requires immediately after `LCurly`.
 *
 * Why this is needed: `@mrleebo/prisma-ast`'s lexer has `WhiteSpace = /\s+/`
 * (`Lexer.SKIPPED`) AND `LineBreak = /\n|\r\n/` as separate tokens.
 * Chevrotain dispatches on the first character — for `\n`-starting positions
 * `LineBreak` wins (declared first); for ` `-starting positions only
 * `WhiteSpace` can match, and it greedily consumes the horizontal whitespace
 * AND the following newline. The parser then never sees the mandatory
 * `LineBreak` and the file surfaces as `parse_failed`. Triggers in practice:
 * (a) trailing space after `{` on the block-open line, (b) any block comment
 * on the block-open line that `stripPrismaBlockComments` turned into
 * same-length whitespace, (c) any line comment on the block-open line that
 * `stripBlockOpenerLineComments` turned into same-length whitespace.
 *
 * Why paren-depth-0 only: inline `{` from the `object` rule (e.g.,
 * `@default({...})`) appears inside attribute args, always within `(`. The
 * `object` rule does NOT consume a `LineBreak` — rotating there would
 * inject a token the parser can't accept and break previously-valid
 * multi-line inline objects.
 *
 * Why rotation (not collapse): preserves byte length, so the AST's line
 * numbers stay aligned to the original source for error reporting. Only
 * column numbers on the immediately-following line shift (horizontal
 * whitespace moved from end-of-block-open line to start-of-next line).
 */
function normalizeBlockOpenerWhitespace(input: string): string {
	if (!/\{[ \t]+\r?\n/.test(input)) return input;

	let i = 0;
	let parenDepth = 0;
	const out: string[] = [];
	while (i < input.length) {
		const consumed = consumeStringOrLineComment(input, i, out);
		if (consumed !== null) {
			i = consumed;
			continue;
		}
		const ch = input[i] as string;
		if (ch === "(") parenDepth++;
		else if (ch === ")" && parenDepth > 0) parenDepth--;
		if (ch !== "{" || parenDepth !== 0) {
			out.push(ch);
			i++;
			continue;
		}
		let j = i + 1;
		while (j < input.length && (input[j] === " " || input[j] === "\t")) j++;
		const isCRLF = input[j] === "\r" && input[j + 1] === "\n";
		const isLF = input[j] === "\n";
		if (j === i + 1 || (!isLF && !isCRLF)) {
			out.push(ch);
			i++;
			continue;
		}
		const nlLen = isCRLF ? 2 : 1;
		out.push("{", input.slice(j, j + nlLen), input.slice(i + 1, j));
		i = j + nlLen;
	}
	return out.join("");
}

function extractPrismaErrorLocation(cause: unknown): { line?: number; column?: number } {
	// Chevrotain throws Error subclasses (`MismatchedTokenException`,
	// `NoViableAltException`, `NotAllInputParsedException`), so
	// `isPlainObject(cause)` rejects them via the prototype check.
	// Tokens themselves are plain objects so the inner `isPlainObject`
	// checks below stay correct.
	if (typeof cause !== "object" || cause === null) return {};
	const tok = (cause as { token?: unknown }).token;
	if (isPlainObject(tok)) {
		// `MismatchedTokenException` on missing-brace surfaces an EOF token
		// whose `startLine` / `startColumn` are `null`; the empty result
		// must fall through to `previousToken` rather than be returned.
		const loc = locFromToken(tok);
		if (loc.line !== undefined) return loc;
	}
	const previousToken = (cause as { previousToken?: unknown }).previousToken;
	if (isPlainObject(previousToken)) return locFromToken(previousToken);
	return {};
}

function locFromToken(tok: Record<string, unknown>): { line?: number; column?: number } {
	const out: { line?: number; column?: number } = {};
	// Chevrotain's EOF token (synthesized when input ends before parsing finishes)
	// carries `NaN` for every position field — `typeof NaN === "number"` so a bare
	// type check would propagate NaN downstream as a "valid line." `Number.isFinite`
	// catches both `NaN` and the never-empirically-observed `Infinity` cases.
	if (Number.isFinite(tok.startLine)) out.line = tok.startLine as number;
	if (Number.isFinite(tok.startColumn)) out.column = tok.startColumn as number;
	return out;
}

function offsetToLineColumn(source: string, offset: number): { line: number; column: number } {
	const clamped = Math.min(offset, source.length);
	let line = 1;
	let column = 1;
	for (let k = 0; k < clamped; k++) {
		if (source[k] === "\n") {
			line++;
			column = 1;
		} else {
			column++;
		}
	}
	return { line, column };
}

/**
 * Walk the parsed AST counting nodes; throw `ast_node_cap_exceeded` if the
 * total exceeds `cap`. Same guard pattern as `yaml.ts:enforceNodeCap`. The
 * counter visits every node (block, field, attribute, assignment, comment,
 * break) so a `.prisma` file with 10K models + 10 fields each lands at
 * ~110K and trips the default cap (50K).
 */
function enforceNodeCap(schema: PrismaSchema, cap: number): void {
	let count = 0;
	const visit = (v: unknown): void => {
		count++;
		if (count > cap) throw ParseError.prisma("ast_node_cap_exceeded", `Prisma AST exceeds node cap (${cap}).`);
		if (Array.isArray(v)) {
			for (const x of v) visit(x);
			return;
		}
		if (!isPlainObject(v)) return;
		for (const k of Object.keys(v)) visit(v[k]);
	};
	visit(schema);
}

// ─── Opaque fallback ───────────────────────────────────────────────────────

/**
 * Build a heading-less `ParsedFile` for `.prisma` files. Signature mirrors
 * `yaml.ts:buildOpaqueFile` so the three call paths read the same way:
 *   - sparse file (no indexable blocks): `(src, rel, null, false, true)` —
 *     whole source goes into a body preamble so it stays searchable.
 *   - `frontmatterOnly` fast path: `(src, rel, fm, hasFm, false)` — `get_metadata`
 *     reads only `frontmatter`/`hasFrontmatter`; the preamble would be
 *     allocated work nothing consumes.
 *   - synthesized-null fallback (no blocks AND no floating docs): same as
 *     sparse-file path.
 */
function buildOpaqueFile(
	source: string,
	relpath: string,
	frontmatter: Record<string, unknown> | null,
	hasFrontmatter: boolean,
	withBodyPreamble: boolean,
): ParsedFile {
	const preamble: ParsedFile["preamble"] =
		withBodyPreamble && source.length > 0
			? {
					range: { start: 1, end: countLines(source) },
					offsetRange: { start: 0, end: source.length },
					contentKinds: [] as ContentKind[],
				}
			: null;
	return {
		kind: "prisma",
		relpath,
		source,
		hasFrontmatter,
		frontmatter,
		frontmatterEndOffset: 0,
		outline: [],
		blockIndex: {},
		headings: [],
		blocks: [],
		preamble,
		excludedRanges: [],
	};
}
