/**
 * OpenAPI 3.x synthesizer.
 *
 * `structuralPath = "op[<sha14(slotInput)>]"` is the load-bearing
 * choice: name-based slot IDs survive path reorder, so code-generated
 * specs don't churn `heading_history` on every regeneration. The slot
 * input is `"oid:" + operationId` when `operationId` is present and
 * unique-in-file; otherwise it falls back to the heading text
 * (`<METHOD> <path>`) — preserves today's behavior for specs without
 * operationId. Webhook ops (3.1) use the `webhook[...]` prefix
 * with the same slot-input rule.
 *
 * The `frontmatter` field holds the entire top-level object so
 * nested-path filters (`fields["info.version"]`) work without
 * OpenAPI-specific wiring. The synthesized `source` is the prose
 * rendering used by `get_fragment`; `note://` returns the LITERAL
 * on-disk YAML — the divergence is intentional and contractual.
 *
 * Prototype-pollution defenses come from `./shared.js` (shared
 * with AsyncAPI). `## Spec metadata` residual extractors sanitize at
 * extraction time — no second-pass wrapper — so user-named `__proto__`
 * keys at depth 1 (webhook names) survive while spec-key layers
 * (OpenAPI root + `info` fields + pathItem fields) reject `__proto__`.
 */

import type { ContentKind, HeadingLevel, Range } from "../../types.js";
import type { ExcludedRange } from "../blockIds.js";
import { MAX_FILE_BYTES } from "../limits.js";
import {
	annotateDescendantTokens,
	buildOutlineTree,
	createSlugDedup,
	type HeadingMeta,
	isPlainObject,
	normalizeHeadingText,
	type OffsetRange,
	type ParsedFile,
} from "../parser.js";
import { sha1HexN, stableId } from "../structuralPath.js";
import { estimateTokens } from "../tokenizer.js";
import {
	DANGEROUS_KEYS,
	deepSanitize,
	safeSet,
	sanitizeBucketMap,
	sanitizeNested,
	stringField,
	stringifyJsonForFence,
} from "./shared.js";

/**
 * Canonical HTTP method order — operations within a path emit in this
 * sequence. Lowercase form matches OpenAPI 3.x's path-item keys.
 */
const CANONICAL_METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"] as const;
type Method = (typeof CANONICAL_METHODS)[number];

const CANONICAL_METHOD_SET: ReadonlySet<string> = new Set(CANONICAL_METHODS);

/**
 * Namespace prefix on the slot-hash input when `operationId` is used as
 * slot identity. Keeps the operationId-keyed scheme collision-distinct
 * from the heading-text-keyed fallback at the same digest width.
 */
const OPERATION_ID_HASH_NAMESPACE = "oid:";

/**
 * Aggregate cap on synthesized source bytes. Per-fence cap
 * (`MAX_FENCE_JSON_BYTES = 64 KiB`) bounds individual operation /
 * components / spec-metadata fences, but a pathological spec with
 * thousands of operations + webhooks could still accumulate gigabytes
 * of fence payload in the joined source. On cap exceeded the
 * synthesizer returns `null` and the caller falls back to opaque YAML
 * emission. 2× the input cap leaves headroom for the prose preamble +
 * per-op headings + fence inflation. Symmetric with AsyncAPI.
 */
const MAX_SYNTHESIZED_SOURCE_BYTES = 2 * MAX_FILE_BYTES;

/** Returns true iff `top` looks like an OpenAPI 3.x document. */
export function detectOpenApi(top: unknown): top is Record<string, unknown> {
	if (!isPlainObject(top)) return false;
	const ver = top.openapi;
	return typeof ver === "string" && /^3\./.test(ver);
}

interface OperationEntry {
	method: Method;
	path: string;
	op: Record<string, unknown>;
}

/**
 * One webhook operation as seen by the synthesizer. Webhooks are an
 * OpenAPI 3.1 addition: top-level `webhooks: { <name>: <PathItem> }`
 * carries asynchronous-event operations the API provider sends out,
 * structurally identical to a path entry but identified by user-chosen
 * name rather than URL path.
 */
interface WebhookEntry {
	method: Method;
	webhookName: string;
	op: Record<string, unknown>;
}

/**
 * One emitted heading within the synthesized source. Operations supply
 * method/path-derived heading text and a sha-of-text structural slot;
 * named singletons (e.g. `## Components`) supply a literal label.
 * `buildHeadingMeta` reads only the precomputed `headingText` /
 * `structuralSlot` / `baseSlug` so it doesn't need to know which kind
 * of section it's processing.
 */
interface SynthSection {
	headingText: string;
	structuralSlot: string;
	baseSlug: string;
	contentKinds: ContentKind[];
	/** Byte offset of the `##` heading line start in the synthesized source. */
	rangeStart: number;
	/** Byte offset of EOF or next `##` start. */
	rangeEnd: number;
	/** Byte offset just past the heading line AND its trailing blank line — start of the body. */
	headingLineEnd: number;
	/** Byte offset of the heading line's terminating `\n` (used for `headingLineOffset.end`). */
	headingLineEndChar: number;
}

interface PreambleInfo {
	rangeStart: number;
	rangeEnd: number;
	hasProse: boolean;
}

/**
 * Synthesize a ParsedFile for an OpenAPI 3.x document. `top` is the parsed,
 * normalized top-level object (output of `normalizeForJson`). `relpath` is
 * the vault-relative path used in stable_id generation.
 *
 * Returns `null` when the synthesized source would be empty (no operations
 * AND no preamble prose — e.g. `openapi: "3.0.0"\nfoo: bar`). Callers fall
 * back to opaque YAML emission — without this gate the file silently drops
 * from search.
 */
export function synthesizeOpenApiFile(top: Record<string, unknown>, relpath: string): ParsedFile | null {
	const operations = enumerateOperations(top);
	const webhooks = enumerateWebhooks(top);
	const duplicateOpIds = computeDuplicateOpIds(operations, webhooks);
	const built = buildSynthesizedSource(top, operations, webhooks, duplicateOpIds);
	if (built === null || !built.hasPrimaryContent) return null;
	const lineStarts = computeLineStarts(built.source);

	const preamble = built.preamble.hasProse ? buildPreambleMeta(built.preamble, lineStarts) : null;
	// `pathToSlug` collapses `/pets/id` and `/pets/{id}` to the same value;
	// per-file dedup keeps `OutlineNode.anchor` unique.
	const dedupSlug = createSlugDedup();
	const headings = built.sections.map((sec) => buildHeadingMeta(sec, relpath, built.source, lineStarts, dedupSlug));
	const outline = buildOutlineTree(headings);
	// Back-fills `subheadings` + `descendantTokensApprox` on both `outline`
	// and `headings`. Flat OpenAPI sections → each node's descendant total
	// equals its own `bodyTokensApprox`; the shared traversal matches what
	// markdown does so wire-shapes stay byte-identical across formats.
	annotateDescendantTokens(outline, headings);

	return {
		kind: "yaml",
		relpath,
		source: built.source,
		hasFrontmatter: true,
		frontmatter: top,
		// Synthesized source's body region IS the source from offset 0; the
		// info preamble + per-operation sections are all indexable as
		// fragments. `frontmatterEndOffset: 0` lets the scanner's
		// `buildFragmentRows` slice from offset 0 when (e.g.) there are no
		// operations — falls into the "headings.length === 0 → one file
		// row" branch with the synthesized info block as the body.
		frontmatterEndOffset: 0,
		outline,
		blockIndex: {},
		headings,
		blocks: [],
		preamble,
		excludedRanges: built.excludedRanges,
	};
}

/**
 * Walk a `paths`-shaped map (sorted by key) and emit one entry per
 * `(method, mapKey, parameter-merged op)` combination via `buildEntry`.
 * Shared between `top.paths` and `top.webhooks` (3.1) since
 * the PathItem shape, canonical-method enumeration, and path-item
 * `parameters` inheritance are identical between the two sources. The
 * `buildEntry` callback names the per-format entry shape — paths produce
 * `OperationEntry { method, path, op }`; webhooks produce
 * `WebhookEntry { method, webhookName, op }`. Intra-doc `$ref` resolution
 * is deferred; see AsyncAPI's `extractRefString` for the pattern.
 */
function enumeratePathItems<T>(
	map: unknown,
	buildEntry: (method: Method, mapKey: string, op: Record<string, unknown>) => T,
): T[] {
	if (!isPlainObject(map)) return [];

	const out: T[] = [];
	// Sort for stable order under JSON object key reordering.
	const keys = Object.keys(map).sort();

	for (const mapKey of keys) {
		const pathItem = map[mapKey];
		if (!isPlainObject(pathItem)) continue;
		// Path-item `parameters` array shape-checked once per PathItem; the
		// inner merge function then takes the already-normalized array
		// directly so we don't pay `Array.isArray` × N methods per item.
		const pathArr = Array.isArray(pathItem.parameters) ? pathItem.parameters : [];
		for (const method of CANONICAL_METHODS) {
			const op = pathItem[method];
			if (!isPlainObject(op)) continue;
			const merged = mergePathItemParameters(pathArr, op.parameters);
			const opForRender = merged === undefined ? op : { ...op, parameters: merged };
			out.push(buildEntry(method, mapKey, opForRender));
		}
	}

	return out;
}

function enumerateOperations(top: Record<string, unknown>): OperationEntry[] {
	return enumeratePathItems(top.paths, (method, path, op) => ({ method, path, op }));
}

/**
 * `webhooks` is a 3.1+ construct; 3.0.x documents that carry one are
 * either migration drafts, custom data, or authoring errors. Single
 * source of truth for the version gate — both `enumerateWebhooks`
 * (heading suppression) and `residualForKey` (spec-metadata verbatim
 * fallback when headings are suppressed) consult this so the two
 * branches stay in lockstep.
 */
function supportsWebhooks(top: Record<string, unknown>): boolean {
	const version = top.openapi;
	return typeof version !== "string" || !version.startsWith("3.0");
}

/** Enumerate `top.webhooks`; `supportsWebhooks` gates 3.0.x out → `[]`. */
function enumerateWebhooks(top: Record<string, unknown>): WebhookEntry[] {
	if (!supportsWebhooks(top)) return [];
	return enumeratePathItems(top.webhooks, (method, webhookName, op) => ({ method, webhookName, op }));
}

/**
 * Build the set of operationIds that appear more than once across the
 * union of operations + webhooks. Per OpenAPI 3.1 the field "MUST be
 * unique among all operations described in the API" (where "operations"
 * includes both paths and webhooks). The spec says SHOULD pre-3.1 and
 * MUST in 3.1; we treat duplicates as a spec violation in either case
 * and route the colliding entries to the path/name-hash slot scheme
 * (the per-op default) so their stable_ids stay distinct. Silent
 * fallback beats refusing to synthesize.
 */
const EMPTY_STRING_SET: ReadonlySet<string> = new Set();

function computeDuplicateOpIds(operations: OperationEntry[], webhooks: WebhookEntry[]): ReadonlySet<string> {
	const counts = new Map<string, number>();
	const tally = (op: Record<string, unknown>): void => {
		const opId = stringField(op, "operationId");
		if (opId !== null) counts.set(opId, (counts.get(opId) ?? 0) + 1);
	};
	for (const e of operations) tally(e.op);
	for (const e of webhooks) tally(e.op);
	// `counts.size === 0` means no operationIds in the file; skip the
	// dup-extraction allocation entirely. A single operationId shared by
	// N>1 ops still has `size === 1` but is itself a duplicate, so we
	// can't early-exit on that case.
	if (counts.size === 0) return EMPTY_STRING_SET;
	const dups = new Set<string>();
	for (const [opId, count] of counts) if (count > 1) dups.add(opId);
	return dups;
}

/**
 * Per-op slot-hash input. When `operationId` is present and unique
 * across the file's operations + webhooks, hash `"oid:" + operationId`
 * — slot survives path/name renames and method changes. Otherwise fall
 * back to `<heading-text>` so the default slot scheme (`sha14(method +
 * ' ' + path)` for paths, `sha14("<METHOD> <name>")` for webhooks) is
 * preserved unchanged for specs that don't supply operationId. The
 * `"oid:"` namespace prefix in the hash input keeps the two schemes
 * collision-distinct even at the same digest width.
 */
function slotInputForEntry(
	op: Record<string, unknown>,
	headingText: string,
	duplicateOpIds: ReadonlySet<string>,
): string {
	const opId = stringField(op, "operationId");
	if (opId === null || duplicateOpIds.has(opId)) return headingText;
	return `${OPERATION_ID_HASH_NAMESPACE}${opId}`;
}

/**
 * Per OpenAPI 3.x Path Item Object: `parameters` listed at the path-item
 * level apply to every operation under that path. Operation-level entries
 * override path-item entries with the same `name` + `in` (location) pair;
 * non-overridden path-item entries are inherited. Returns `undefined` when
 * neither level declares parameters so callers preserve the original `op`
 * shape (no spurious `parameters: []` injected into the JSON fence).
 */
function mergePathItemParameters(pathArr: unknown[], opParams: unknown): unknown[] | undefined {
	// `undefined` = no change needed (caller preserves original op shape).
	// Covers both "no params anywhere" AND "no path-level params" (op's own
	// params already in op.parameters; merging is a no-op).
	if (pathArr.length === 0) return undefined;
	const opArr = Array.isArray(opParams) ? opParams : [];
	// Path-level params with no op-level overrides — return the path-level
	// array directly to skip per-method Set allocation across N methods.
	if (opArr.length === 0) return pathArr;

	const opKeys = new Set<string>();
	for (const p of opArr) {
		const key = paramKey(p);
		if (key !== null) opKeys.add(key);
	}

	const merged: unknown[] = [];
	for (const p of pathArr) {
		const key = paramKey(p);
		// Preserve `$ref` and other no-name entries — we can't `(name, in)`-match
		// them, so we don't know if the op overrides. Duplicates in the synthesized
		// output beat silent omission; v1.x will resolve `$ref`.
		if (key === null || !opKeys.has(key)) merged.push(p);
	}
	for (const p of opArr) merged.push(p);
	return merged;
}

/**
 * OpenAPI parameter identity is `(name, in)`. Both fields are restricted to
 * printable strings by the spec, so a NUL byte separator is unambiguous.
 * Returns null when the entry isn't a plain object or has no `name` — those
 * entries can't participate in override matching and are skipped upstream.
 */
function paramKey(p: unknown): string | null {
	if (!isPlainObject(p)) return null;
	const name = stringField(p, "name");
	if (name === null) return null;
	const inLoc = stringField(p, "in") ?? "";
	return `${inLoc}\x00${name}`;
}

interface SynthesisResult {
	source: string;
	sections: SynthSection[];
	preamble: PreambleInfo;
	excludedRanges: ExcludedRange[];
	/**
	 * True iff a dedicated section (info preamble prose, an operation,
	 * or components) emitted. Drives the synthesize-vs-opaque fallback:
	 * spec-metadata alone (e.g. `openapi: "3.0.0"\nfoo: bar`) reverts to
	 * opaque YAML so a non-spec file isn't dressed up as one.
	 */
	hasPrimaryContent: boolean;
}

function buildSynthesizedSource(
	top: Record<string, unknown>,
	operations: OperationEntry[],
	webhooks: WebhookEntry[],
	duplicateOpIds: ReadonlySet<string>,
): SynthesisResult | null {
	const chunks: string[] = [];
	let offset = 0;
	let truncated = false;
	const excludedRanges: ExcludedRange[] = [];
	const sections: SynthSection[] = [];
	const topSecurity = top.security;

	const emit = (s: string): void => {
		if (truncated) return;
		if (offset + s.length > MAX_SYNTHESIZED_SOURCE_BYTES) {
			truncated = true;
			return;
		}
		chunks.push(s);
		offset += s.length;
	};

	/**
	 * Emit a `## <heading>` section whose body is exactly one JSON fence
	 * (no mid-section prose). Shared between `Components` and
	 * `Spec metadata`; operations need prose injection between heading
	 * and fence and stay inline below.
	 */
	const emitJsonSection = (
		headingText: string,
		structuralSlot: string,
		baseSlug: string,
		value: unknown,
		label: string,
	): void => {
		const sectionStart = offset;
		const headingLine = `## ${headingText}\n`;
		const headingLineEndChar = offset + headingLine.length - 1;
		emit(headingLine);
		emit("\n");
		const headingLineEnd = offset;
		if (truncated) return;

		const jsonStart = offset;
		const fence = stringifyJsonForFence(value, label);
		emit(`\`\`\`${fence.language}\n`);
		emit(`${fence.body}\n`);
		emit("```\n\n");
		excludedRanges.push({ offsetStart: jsonStart, offsetEnd: offset });

		sections.push({
			headingText,
			structuralSlot,
			baseSlug,
			contentKinds: ["code"],
			rangeStart: sectionStart,
			rangeEnd: offset,
			headingLineEnd,
			headingLineEndChar,
		});
	};

	// ─ Preamble: info + top-level tag names ────────────────────────────
	const preambleStart = offset;
	const hasProse = renderPreamble(top, emit);
	const preambleEnd = offset;

	/**
	 * Shared emitter for an operation-shaped section (path operation OR
	 * webhook operation). Emits heading + blank line + prose + JSON
	 * fence; pushes the section descriptor with the caller-supplied
	 * `structuralSlot` and `baseSlug`. `offset` is monotonic with no
	 * inter-section gaps so this section's `rangeEnd` already equals
	 * the next section's `rangeStart` — no finalize pass needed
	 * (unlike markdown's `finalizeHeadingRanges`).
	 */
	const emitOperationSection = (
		op: Record<string, unknown>,
		headingText: string,
		structuralSlot: string,
		baseSlug: string,
	): void => {
		const sectionStart = offset;
		// `normalizeHeadingText` collapses unconstrained user content (webhook
		// names; YAML-quoted path keys carrying `\n`/`\r`) so the synthesized
		// source can't grow a phantom secondary `##` inside the fragment body.
		// `sections.headingText` retains the raw form for `displayText`.
		const headingLine = `## ${normalizeHeadingText(headingText)}\n`;
		const headingLineEndChar = offset + headingLine.length - 1;
		emit(headingLine);
		emit("\n");
		const headingLineEnd = offset;

		const effectiveSecurity = op.security !== undefined ? op.security : topSecurity;
		renderOperationProse(op, effectiveSecurity, emit);
		if (truncated) return;
		const opJsonStart = offset;
		const fence = stringifyJsonForFence(sanitizeOperationForFence(op), "OpenAPI operation");
		emit(`\`\`\`${fence.language}\n`);
		emit(`${fence.body}\n`);
		emit("```\n\n");
		// The fence delimiters themselves don't matter; what matters is
		// the JSON region between them gets routed to `code`, not `body`.
		// Mirror markdown's `code` excluded-range encoding.
		excludedRanges.push({ offsetStart: opJsonStart, offsetEnd: offset });

		sections.push({
			headingText,
			structuralSlot,
			baseSlug,
			contentKinds: inferContentKinds(op, effectiveSecurity),
			rangeStart: sectionStart,
			rangeEnd: offset,
			headingLineEnd,
			headingLineEndChar,
		});
	};

	// ─ Operations (sorted: paths alphabetical, methods canonical) ─────
	for (let i = 0; i < operations.length; i++) {
		if (truncated) break;
		const entry = operations[i];
		if (!entry) continue;
		const method = entry.method.toUpperCase();
		const headingText = `${method} ${entry.path}`;
		const slotInput = slotInputForEntry(entry.op, headingText, duplicateOpIds);
		emitOperationSection(entry.op, headingText, `op[${sha1HexN(slotInput, 14)}]`, pathToSlug(method, entry.path));
	}

	// ─ Webhooks (3.1; sorted: names alphabetical, methods canonical) ──
	// Slot prefix `webhook[...]` keeps webhook IDs distinct from path-op
	// IDs even when a name happens to hash to the same digest as a path.
	// Pre-3.1 specs have no `webhooks` key → empty array → loop is a no-op.
	for (let i = 0; i < webhooks.length; i++) {
		if (truncated) break;
		const entry = webhooks[i];
		if (!entry) continue;
		const method = entry.method.toUpperCase();
		const headingText = `Webhook: ${entry.webhookName} ${method}`;
		const slotInput = slotInputForEntry(entry.op, headingText, duplicateOpIds);
		emitOperationSection(
			entry.op,
			headingText,
			`webhook[${sha1HexN(slotInput, 14)}]`,
			webhookToSlug(entry.webhookName, method),
		);
	}

	if (truncated) {
		// Skip remaining catch-all sections when the synth cap tripped —
		// each invokes a recursive deep-copy before emission.
		return null;
	}

	// Schemas / parameters / responses not inlined in operations (only
	// referenced via `$ref`) reach FTS only through this section's
	// `code`-column fence; without it, queries for properties defined
	// solely under `components` silently miss.
	const components = top.components;
	const hasComponentSection = isPlainObject(components) && Object.keys(components).length > 0;
	if (hasComponentSection) {
		// Literal slot — only one Components section per file, so a
		// sha-of-text slot would just be a longer alias.
		emitJsonSection("Components", "components", "components", sanitizeBucketMap(components), "OpenAPI components");
	}

	// Top-level keys outside the dedicated sections reach FTS only through
	// this catch-all — frontmatter carries them for filters but is
	// excluded from FTS row bodies. The fence routes them through `code`
	// (BM25 weight 0.5). `info` and `paths` flow through `residualForKey`
	// so subfields already rendered (preamble + per-op fences) don't
	// duplicate; `openapi` (version string) and `components` (its own
	// fence) skip entirely. `null` `leftovers` doubles as the emission
	// gate so specs with only rendered keys allocate nothing.
	let leftovers: Record<string, unknown> | null = null;
	for (const key of Object.keys(top)) {
		if (key === "openapi" || key === "components") continue;
		// OpenAPI root admits only spec-defined keys + `x-*` extensions;
		// `__proto__` is never legitimate here.
		if (DANGEROUS_KEYS.has(key)) continue;
		const value = residualForKey(key, top);
		if (value === null || value === undefined) continue;
		if (leftovers === null) leftovers = {};
		leftovers[key] = value;
	}
	if (leftovers !== null) {
		// Residuals are pre-sanitized; no wrapper here — `sanitizeNested(leftovers)`
		// would re-strip user-named `__proto__` keys at depth 1 (webhook names).
		emitJsonSection("Spec metadata", "spec_metadata", "spec-metadata", leftovers, "OpenAPI spec metadata");
	}

	if (truncated) return null;

	return {
		source: chunks.join(""),
		sections,
		preamble: {
			rangeStart: preambleStart,
			rangeEnd: preambleEnd,
			hasProse,
		},
		excludedRanges,
		hasPrimaryContent: hasProse || operations.length > 0 || webhooks.length > 0 || hasComponentSection,
	};
}

/**
 * Dispatch a top-level key through the appropriate residual extractor
 * for the spec-metadata catch-all. Each branch returns an already-
 * sanitized value (no second pass on assembled leftovers). `info` and
 * `paths` partially render so only their unrendered residuals survive;
 * `webhooks` follows the same on 3.1+ when well-formed; non-object
 * inputs fall back to `deepSanitize` so authoring state survives. Root
 * `security` preserves user-named scheme references at depth 0 of each
 * Security Requirement Object via `sanitizeNested` so a `__proto__`-named
 * scheme registered in `components.securitySchemes` survives the metadata
 * fence. Other keys `deepSanitize` through to the catch-all.
 */
function residualForKey(key: string, top: Record<string, unknown>): unknown {
	if (key === "info") return extractInfoResidual(top.info);
	if (key === "paths") return extractPathItemMapResidual(top.paths, true);
	if (key === "webhooks") {
		if (supportsWebhooks(top) && isPlainObject(top.webhooks)) {
			return extractPathItemMapResidual(top.webhooks, false);
		}
		return deepSanitize(top.webhooks);
	}
	if (key === "security" && Array.isArray(top.security)) {
		return top.security.map(sanitizeNested);
	}
	return deepSanitize(top[key]);
}

/**
 * Strip subfields already emitted by `renderPreamble` (title / version /
 * description) from `info`. Everything else — `contact`, `license`,
 * `termsOfService`, `summary`, `x-*` extensions — flows through the
 * spec-metadata catch-all so free-text search can reach it. Returns
 * `null` when the residual is empty so callers omit the key entirely
 * (no empty `info: {}` in the catch-all fence). `info` keys are
 * spec-defined / `x-*` extensions only; `__proto__` is rejected at this
 * layer and value subtrees `deepSanitize`d.
 */
function extractInfoResidual(info: unknown): Record<string, unknown> | null {
	if (!isPlainObject(info)) return null;
	let residual: Record<string, unknown> | null = null;
	for (const key of Object.keys(info)) {
		if (key === "title" || key === "description" || key === "version") continue;
		if (DANGEROUS_KEYS.has(key)) continue;
		if (residual === null) residual = {};
		residual[key] = deepSanitize(info[key]);
	}
	return residual;
}

/**
 * Strip canonical method keys (already emitted as operations or webhook
 * operations) from each PathItem in a `paths`-shaped map. The "already
 * emitted" predicate mirrors `enumeratePathItems`' `isPlainObject(op)`
 * gate: non-plain-object values at canonical method keys (mid-edit drafts
 * like `webhooks.foo.post: "TODO"`, arrays, scalars, null) are NOT emitted
 * upstream, so they survive in the residual rather than vanishing from
 * both the per-op section AND the Spec metadata fence. Path-item-level
 * `summary` / `description` / `servers` / `parameters` / `x-*` extensions
 * survive — these are the search-visible fields that would otherwise vanish
 * from FTS. Non-object values under the map (e.g. top-level `paths.x-*`
 * extensions per OpenAPI 3.x) are preserved verbatim. Returns `null` when
 * every PathItem is operations-only so the catch-all omits an empty
 * `paths: {}` / `webhooks: {}` payload. Shared by both `paths` and
 * `webhooks` — the residual logic is structurally identical for
 * either source.
 *
 * `filterDangerousOuterKey` controls outer-key policy: `true` for `paths`
 * (OpenAPI 3.x spec: the field name MUST begin with a forward slash, so
 * `__proto__` is structurally invalid at this layer); `false` for
 * `webhooks` (OpenAPI 3.1 spec: keys are unconstrained user-chosen names,
 * so a webhook literally named `__proto__` is legal-but-weird user content
 * preserved via `safeSet`). The two outer-key layers have DIFFERENT
 * policies; the call site picks.
 */
function extractPathItemMapResidual(map: unknown, filterDangerousOuterKey: boolean): Record<string, unknown> | null {
	if (!isPlainObject(map)) return null;
	let residual: Record<string, unknown> | null = null;
	for (const itemKey of Object.keys(map)) {
		if (filterDangerousOuterKey && DANGEROUS_KEYS.has(itemKey)) continue;
		const pathItem = map[itemKey];
		if (!isPlainObject(pathItem)) {
			if (residual === null) residual = {};
			safeSet(residual, itemKey, deepSanitize(pathItem));
			continue;
		}
		let itemResidual: Record<string, unknown> | null = null;
		for (const key of Object.keys(pathItem)) {
			if (CANONICAL_METHOD_SET.has(key) && isPlainObject(pathItem[key])) continue;
			if (DANGEROUS_KEYS.has(key)) continue;
			if (itemResidual === null) itemResidual = {};
			itemResidual[key] = deepSanitize(pathItem[key]);
		}
		if (itemResidual !== null) {
			if (residual === null) residual = {};
			safeSet(residual, itemKey, itemResidual);
		}
	}
	return residual;
}

/**
 * Sanitize an Operation Object for the JSON fence (`code` FTS column).
 *
 * Op-level keys are spec-defined; `__proto__` is filtered there.
 * `op.security[*].*` (scheme refs), `op.callbacks.*` (callback names),
 * and `op.callbacks.*.*` (callback expressions) are user-named per
 * OpenAPI 3.x and stay preserved so an operation referencing a
 * `__proto__`-named scheme registered in `components.securitySchemes`
 * doesn't read as `Security: none` while Components advertises the
 * scheme (symmetric with `sanitizeBucketMap`'s components handling).
 * The callbacks branch is 2-level user-named — outer `safeSet` for the
 * name; `sanitizeNested` handles the expression layer beneath.
 */
function sanitizeOperationForFence(op: Record<string, unknown>): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const key of Object.keys(op)) {
		if (DANGEROUS_KEYS.has(key)) continue;
		const value = op[key];
		if (key === "security" && Array.isArray(value)) {
			out[key] = value.map(sanitizeNested);
		} else if (key === "callbacks" && isPlainObject(value)) {
			const callbacksOut: Record<string, unknown> = {};
			for (const name of Object.keys(value)) {
				safeSet(callbacksOut, name, sanitizeNested(value[name]));
			}
			out[key] = callbacksOut;
		} else {
			out[key] = deepSanitize(value);
		}
	}
	return out;
}

/**
 * Emit the info preamble block. Returns true iff anything substantive
 * was written (so the caller decides whether to emit a preamble row).
 */
function renderPreamble(top: Record<string, unknown>, emit: (s: string) => void): boolean {
	let anyProse = false;
	const info = top.info;
	if (isPlainObject(info)) {
		const title = stringField(info, "title");
		const version = stringField(info, "version");
		const description = stringField(info, "description");
		if (title) {
			// User-controlled identifier interpolated into a single-line
			// prose emit; collapse embedded newlines so the markdown re-parser
			// doesn't pick up phantom `##` headings. Applied at every
			// user-identifier interpolation below — descriptions are passed
			// raw because spec permits multi-paragraph markdown there.
			// Mirrors asyncapi.ts:963-967.
			emit(`# ${normalizeHeadingText(title)}\n\n`);
			anyProse = true;
		}
		if (version) {
			emit(`Version: ${normalizeHeadingText(version)}\n\n`);
			anyProse = true;
		}
		if (description) {
			emit(`${description}\n\n`);
			anyProse = true;
		}
	}
	const tags = top.tags;
	if (Array.isArray(tags) && tags.length > 0) {
		const names: string[] = [];
		for (const t of tags) {
			if (isPlainObject(t)) {
				const n = stringField(t, "name");
				if (n) names.push(n);
			}
		}
		if (names.length > 0) {
			emit(`Tags: ${names.map(normalizeHeadingText).join(", ")}\n\n`);
			anyProse = true;
		}
	}
	return anyProse;
}

function renderOperationProse(op: Record<string, unknown>, security: unknown, emit: (s: string) => void): void {
	const summary = stringField(op, "summary");
	if (summary) emit(`Summary: ${normalizeHeadingText(summary)}\n\n`);

	// `description` allows multi-paragraph markdown per spec; preserve raw.
	const description = stringField(op, "description");
	if (description) emit(`${description}\n\n`);

	const operationId = stringField(op, "operationId");
	if (operationId) emit(`Operation ID: ${normalizeHeadingText(operationId)}\n\n`);

	const parameters = op.parameters;
	if (Array.isArray(parameters) && parameters.length > 0) {
		emit("Parameters:\n");
		for (const p of parameters) {
			if (!isPlainObject(p)) continue;
			const name = stringField(p, "name");
			const inLoc = stringField(p, "in");
			const desc = stringField(p, "description");
			if (!name) continue;
			const inPart = inLoc ? ` (${normalizeHeadingText(inLoc)})` : "";
			const descPart = desc ? `: ${normalizeHeadingText(desc)}` : "";
			emit(`- ${normalizeHeadingText(name)}${inPart}${descPart}\n`);
		}
		emit("\n");
	}

	const responses = op.responses;
	if (isPlainObject(responses)) {
		// Filter `__proto__` so yaml-parsed `responses.__proto__:` can't
		// reach the body FTS column (BM25 weight 2.0).
		const statuses = Object.keys(responses)
			.filter((k) => !DANGEROUS_KEYS.has(k))
			.sort((a, b) => {
				const na = Number.parseInt(a, 10);
				const nb = Number.parseInt(b, 10);
				if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
				return a.localeCompare(b);
			});
		if (statuses.length > 0) {
			emit("Responses:\n");
			for (const status of statuses) {
				const resp = responses[status];
				const desc = isPlainObject(resp) ? stringField(resp, "description") : null;
				emit(`- ${normalizeHeadingText(status)}${desc ? `: ${normalizeHeadingText(desc)}` : ""}\n`);
			}
			emit("\n");
		}
	}

	const requestBody = op.requestBody;
	if (isPlainObject(requestBody)) {
		const desc = stringField(requestBody, "description");
		if (desc) emit(`Request body: ${normalizeHeadingText(desc)}\n\n`);
	}

	const tags = op.tags;
	if (Array.isArray(tags) && tags.length > 0) {
		const names: string[] = [];
		for (const t of tags) {
			if (typeof t === "string") names.push(t);
		}
		if (names.length > 0) emit(`Tags: ${names.map(normalizeHeadingText).join(", ")}\n\n`);
	}

	// Five fields lifted out of the JSON fence (code weight 0.5) into
	// prose (body weight 2.0) so search reaches them at 4× rank.

	if (op.deprecated === true) emit("Deprecated: yes\n\n");

	const externalDocs = op.externalDocs;
	if (isPlainObject(externalDocs)) {
		const url = stringField(externalDocs, "url");
		const desc = stringField(externalDocs, "description");
		if (url || desc) {
			const descPart = desc ? normalizeHeadingText(desc) : "";
			const urlPart = url ? normalizeHeadingText(url) : "";
			const sep = desc && url ? " — " : "";
			emit(`External docs: ${descPart}${sep}${urlPart}\n\n`);
		}
	}

	// `security` is the effective value (see signature); the fence downstream
	// preserves on-disk `op.security` separately. `[]` and per-entry `{}` are
	// both OpenAPI no-auth overrides → `Security: none`.
	if (Array.isArray(security)) {
		if (security.length === 0) {
			emit("Security: none\n\n");
		} else {
			const renderedEntries: string[] = [];
			for (const entry of security) {
				if (!isPlainObject(entry)) continue;
				const parts: string[] = [];
				// Scheme names are user-named per spec; a `__proto__`-named
				// scheme is preserved so the operation truthfully reports
				// its auth requirement (symmetric with the components fence).
				for (const schemeName of Object.keys(entry)) {
					const safeName = normalizeHeadingText(schemeName);
					const scopes = entry[schemeName];
					if (Array.isArray(scopes) && scopes.length > 0) {
						const scopeStrings = scopes.filter((s): s is string => typeof s === "string").map(normalizeHeadingText);
						parts.push(scopeStrings.length > 0 ? `${safeName}(${scopeStrings.join(", ")})` : safeName);
					} else {
						parts.push(safeName);
					}
				}
				renderedEntries.push(parts.length === 0 ? "none" : parts.join(", "));
			}
			if (renderedEntries.length > 0) emit(`Security: ${renderedEntries.join(" | ")}\n\n`);
		}
	}

	const servers = op.servers;
	if (Array.isArray(servers) && servers.length > 0) {
		const urls: string[] = [];
		for (const s of servers) {
			if (!isPlainObject(s)) continue;
			const url = stringField(s, "url");
			if (url) urls.push(url);
		}
		if (urls.length > 0) emit(`Servers: ${urls.map(normalizeHeadingText).join(", ")}\n\n`);
	}

	const callbacks = op.callbacks;
	if (isPlainObject(callbacks)) {
		// Callback names are user-named per spec; `__proto__` is preserved
		// (peer of webhook names, components callback names).
		const names = Object.keys(callbacks);
		if (names.length > 0) emit(`Callbacks: ${names.map(normalizeHeadingText).join(", ")}\n\n`);
	}
}

/**
 * Build a single `HeadingMeta` from a precomputed `SynthSection`. The
 * slot scheme (`op[<sha14(slotInput)>]` / `webhook[<sha14(slotInput)>]`
 * for operations, literal labels like `"components"` for named
 * singletons) is fixed by the section builder; this function just
 * threads the precomputed values into the `HeadingMeta` shape and
 * resolves the relpath-aware `stable_id`.
 */
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

	// Normalize `pathText` + `headingPath` so they match what
	// `get_fragment`'s `normalizeHeadingPath` produces from agent input.
	// `displayText` stays raw — same split the markdown-heading path uses.
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
		// `annotateDescendantTokens` back-fills both fields from the outline
		// walk. Pre-setting `0` here matches `buildHeadingMetas` in parser.ts.
		descendantTokensApprox: 0,
		subheadings: 0,
		contentKinds: sec.contentKinds,
		blockIds: [],
	};
}

function buildPreambleMeta(
	preamble: PreambleInfo,
	lineStarts: ReadonlyArray<number>,
): { range: Range; offsetRange: OffsetRange; contentKinds: ContentKind[] } {
	return {
		range: computeLineRange(lineStarts, preamble.rangeStart, preamble.rangeEnd),
		offsetRange: { start: preamble.rangeStart, end: preamble.rangeEnd },
		contentKinds: [],
	};
}

/**
 * Infer content kinds for an operation's body. v1 emits `"code"` always
 * (every operation gets a JSON fence) and `"list"` when the prose carries
 * a Parameters: / Responses: list. `ContentKind` (types.ts:222) doesn't
 * have a `"paragraph"` value — prose is the unmarked default.
 */
function inferContentKinds(op: Record<string, unknown>, security: unknown): ContentKind[] {
	const kinds: ContentKind[] = ["code"];
	const params = op.parameters;
	const responses = op.responses;
	const callbacks = op.callbacks;
	const hasParams = Array.isArray(params) && params.length > 0;
	const hasResponses = isPlainObject(responses) && Object.keys(responses).length > 0;
	const hasSecurity = Array.isArray(security);
	const hasCallbacks = isPlainObject(callbacks) && Object.keys(callbacks).length > 0;
	if (hasParams || hasResponses || hasSecurity || hasCallbacks) kinds.push("list");
	return kinds;
}

/**
 * ASCII slug builder: join parts with `-`, lowercase, collapse runs of
 * non-alphanumeric to `-`, trim leading/trailing `-`. Differs from
 * `parser.ts:githubSlug` (Unicode-letter-preserving, single-`\s`-per-dash
 * for run-preserving semantics). OpenAPI operation slugs are used as URL
 * anchors via `dedupSlug`, so ASCII-only collapse is appropriate.
 */
function slugifyParts(...parts: string[]): string {
	const raw = parts.join("-").toLowerCase();
	return raw.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function pathToSlug(method: string, path: string): string {
	return slugifyParts(method, path) || "operation";
}

/**
 * `webhook-` prefix so a `## Webhook: pets POST` slug can't collide
 * with a `## POST /pets` op slug after lowercasing + non-alnum collapse.
 */
function webhookToSlug(name: string, method: string): string {
	return slugifyParts("webhook", name, method) || "webhook";
}

function computeLineRange(lineStarts: ReadonlyArray<number>, startOffset: number, endOffset: number): Range {
	return {
		start: offsetToLine(lineStarts, startOffset),
		end: offsetToLine(lineStarts, Math.max(endOffset - 1, startOffset)),
	};
}

/**
 * Precompute the start offset of every line in `source`. `lineStarts[i]` is
 * the byte offset of the `i`-th line (0-indexed) so a 1-based line number
 * for an offset is `upper-bound binary search index`. Built once per
 * synthesis; `O(N)` to build, `O(log N)` per lookup. Without precomputation
 * the linear-scan form was `O(offset)` per call × `~4N` calls in
 * `buildHeadingMeta` → `O(N²)` on synthesized sources.
 */
function computeLineStarts(source: string): number[] {
	const starts: number[] = [0];
	for (let i = 0; i < source.length; i++) {
		// Synthesized source is `\n`-only by construction (`buildSynthesizedSource`
		// emits no `\r`); a CR-aware variant lives in `parser.ts:countLines` for
		// on-disk markdown content.
		if (source.charCodeAt(i) === 10) starts.push(i + 1);
	}
	return starts;
}

function offsetToLine(lineStarts: ReadonlyArray<number>, offset: number): number {
	// Upper-bound binary search: largest `i` with `lineStarts[i] <= offset`.
	// Result is 1-based, matching the rest of the parser's line numbering.
	const clamped = Math.max(0, offset);
	let lo = 0;
	let hi = lineStarts.length;
	while (lo < hi) {
		const mid = (lo + hi) >>> 1;
		const start = lineStarts[mid] ?? 0;
		if (start <= clamped) lo = mid + 1;
		else hi = mid;
	}
	return Math.max(lo, 1);
}
