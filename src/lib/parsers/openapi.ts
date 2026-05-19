/**
 * D44 — OpenAPI 3.x synthesizer.
 *
 * `structuralPath = "op[<sha14(method + ' ' + path)>]"` is the load-bearing
 * choice: name-based slot IDs survive path reorder, so code-generated specs
 * don't churn `heading_history` on every regeneration. The `frontmatter`
 * field holds the entire top-level object so D30 nested-path filters
 * (`fields["info.version"]`) work without OpenAPI-specific wiring. The
 * synthesized `source` is the prose rendering used by `get_fragment`;
 * `note://` returns the LITERAL on-disk YAML — the divergence is
 * intentional and contractual.
 */

import type { ContentKind, HeadingLevel, Range } from "../../types.js";
import type { ExcludedRange } from "../blockIds.js";
import { errorMessage } from "../error.js";
import {
	annotateDescendantTokens,
	buildOutlineTree,
	createSlugDedup,
	type HeadingMeta,
	isPlainObject,
	type OffsetRange,
	type ParsedFile,
	ParseError,
} from "../parser.js";
import { sha1HexN, stableId } from "../structuralPath.js";
import { estimateTokens } from "../tokenizer.js";

/**
 * Canonical HTTP method order — operations within a path emit in this
 * sequence. Lowercase form matches OpenAPI 3.x's path-item keys.
 */
const CANONICAL_METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"] as const;
type Method = (typeof CANONICAL_METHODS)[number];

const CANONICAL_METHOD_SET: ReadonlySet<string> = new Set(CANONICAL_METHODS);

/**
 * Hard cap on the compact JSON payload inside a `code`-routed fence
 * (per operation, components, spec metadata). Defends against
 * pathological specs (a single op embedding MB of example data,
 * a `components` subtree with thousands of schemas).
 */
const MAX_FENCE_JSON_BYTES = 64 * 1024;

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
	const built = buildSynthesizedSource(top, operations);
	if (!built.hasPrimaryContent) return null;
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
		// operations — falls into the D31 "headings.length === 0 → one
		// file row" branch with the synthesized info block as the body.
		frontmatterEndOffset: 0,
		outline,
		blockIndex: {},
		headings,
		blocks: [],
		preamble,
		excludedRanges: built.excludedRanges,
	};
}

function enumerateOperations(top: Record<string, unknown>): OperationEntry[] {
	const paths = top.paths;
	if (!isPlainObject(paths)) return [];

	const out: OperationEntry[] = [];
	const pathKeys = Object.keys(paths).sort(); // Stable order under JSON object key reordering.

	for (const path of pathKeys) {
		const pathItem = paths[path];
		if (!isPlainObject(pathItem)) continue;
		// Path-item `parameters` array shape-checked once per path; the inner
		// merge function then takes the already-normalized array directly so
		// we don't pay `Array.isArray` × N methods per path.
		const pathArr = Array.isArray(pathItem.parameters) ? pathItem.parameters : [];
		for (const method of CANONICAL_METHODS) {
			const op = pathItem[method];
			if (!isPlainObject(op)) continue;
			const merged = mergePathItemParameters(pathArr, op.parameters);
			const opForRender = merged === undefined ? op : { ...op, parameters: merged };
			out.push({ method, path, op: opForRender });
		}
	}

	return out;
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

function buildSynthesizedSource(top: Record<string, unknown>, operations: OperationEntry[]): SynthesisResult {
	const chunks: string[] = [];
	let offset = 0;
	const excludedRanges: ExcludedRange[] = [];
	const sections: SynthSection[] = [];

	const emit = (s: string): void => {
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

	// ─ Operations (sorted: paths alphabetical, methods canonical) ─────
	for (let i = 0; i < operations.length; i++) {
		const entry = operations[i];
		if (!entry) continue;
		const sectionStart = offset;

		const method = entry.method.toUpperCase();
		const headingText = `${method} ${entry.path}`;
		const headingLine = `## ${headingText}\n`;
		const headingLineEndChar = offset + headingLine.length - 1; // index of `\n`
		emit(headingLine);
		emit("\n"); // Blank line after heading
		const headingLineEnd = offset;

		renderOperationProse(entry.op, emit);
		const opJsonStart = offset;
		const fence = stringifyJsonForFence(entry.op, "operation");
		emit(`\`\`\`${fence.language}\n`);
		emit(`${fence.body}\n`);
		emit("```\n\n");
		const opJsonEnd = offset;
		// The fence delimiters themselves don't matter; what matters is
		// the JSON region between them gets routed to `code`, not `body`.
		// Mirror markdown's `code` excluded-range encoding: cover the
		// whole fence + body so `extractFtsTexts` includes the JSON in
		// the `code` column.
		excludedRanges.push({ offsetStart: opJsonStart, offsetEnd: opJsonEnd });

		// `offset` is monotonic with no inter-section gaps, so this section's
		// `rangeEnd` already equals the next section's `rangeStart`. No
		// finalize pass needed (unlike markdown's `finalizeHeadingRanges`).
		sections.push({
			headingText,
			structuralSlot: `op[${sha1HexN(headingText, 14)}]`,
			baseSlug: pathToSlug(method, entry.path),
			contentKinds: inferContentKinds(entry.op),
			rangeStart: sectionStart,
			rangeEnd: offset,
			headingLineEnd,
			headingLineEndChar,
		});
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
		emitJsonSection("Components", "components", "components", components, "components");
	}

	// Top-level keys outside the dedicated sections reach FTS only through
	// this catch-all — frontmatter carries them for D30 filters but is
	// excluded from FTS row bodies. The fence routes them through `code`
	// (D18 weight 0.5). `info` and `paths` flow through `residualForKey`
	// so subfields already rendered (preamble + per-op fences) don't
	// duplicate; `openapi` (version string) and `components` (its own
	// fence) skip entirely. `null` `leftovers` doubles as the emission
	// gate so specs with only rendered keys allocate nothing.
	let leftovers: Record<string, unknown> | null = null;
	for (const key of Object.keys(top)) {
		if (key === "openapi" || key === "components") continue;
		const value = residualForKey(key, top);
		if (value === null || value === undefined) continue;
		if (leftovers === null) leftovers = {};
		leftovers[key] = value;
	}
	if (leftovers !== null) {
		emitJsonSection("Spec metadata", "spec_metadata", "spec-metadata", leftovers, "spec metadata");
	}

	return {
		source: chunks.join(""),
		sections,
		preamble: {
			rangeStart: preambleStart,
			rangeEnd: preambleEnd,
			hasProse,
		},
		excludedRanges,
		hasPrimaryContent: hasProse || operations.length > 0 || hasComponentSection,
	};
}

/**
 * Dispatch a top-level key through the appropriate residual extractor
 * for the spec-metadata catch-all. `info` and `paths` are partially
 * rendered so only their unrendered residuals survive; every other key
 * passes through verbatim (`openapi` and `components` are filtered by
 * the caller before reaching here).
 */
function residualForKey(key: string, top: Record<string, unknown>): unknown {
	if (key === "info") return extractInfoResidual(top.info);
	if (key === "paths") return extractPathsResidual(top.paths);
	return top[key];
}

/**
 * Strip subfields already emitted by `renderPreamble` (title / version /
 * description) from `info`. Everything else — `contact`, `license`,
 * `termsOfService`, `summary`, `x-*` extensions — flows through the
 * spec-metadata catch-all so free-text search can reach it. Returns
 * `null` when the residual is empty so callers omit the key entirely
 * (no empty `info: {}` in the catch-all fence).
 */
function extractInfoResidual(info: unknown): Record<string, unknown> | null {
	if (!isPlainObject(info)) return null;
	let residual: Record<string, unknown> | null = null;
	for (const key of Object.keys(info)) {
		if (key === "title" || key === "description" || key === "version") continue;
		if (residual === null) residual = {};
		residual[key] = info[key];
	}
	return residual;
}

/**
 * Strip canonical method keys (already emitted as operations) from each
 * path-item. Path-item-level `summary` / `description` / `servers` /
 * `parameters` / `x-*` extensions survive — these are the search-visible
 * fields that would otherwise vanish from FTS. Non-object values under
 * `paths` (top-level `paths.x-*` extensions per OpenAPI 3.x) are
 * preserved verbatim. Returns `null` when every path-item is
 * operations-only so the catch-all omits an empty `paths: {}` payload.
 */
function extractPathsResidual(paths: unknown): Record<string, unknown> | null {
	if (!isPlainObject(paths)) return null;
	let residual: Record<string, unknown> | null = null;
	for (const pathKey of Object.keys(paths)) {
		const pathItem = paths[pathKey];
		if (!isPlainObject(pathItem)) {
			if (residual === null) residual = {};
			residual[pathKey] = pathItem;
			continue;
		}
		let pathResidual: Record<string, unknown> | null = null;
		for (const key of Object.keys(pathItem)) {
			if (CANONICAL_METHOD_SET.has(key)) continue;
			if (pathResidual === null) pathResidual = {};
			pathResidual[key] = pathItem[key];
		}
		if (pathResidual !== null) {
			if (residual === null) residual = {};
			residual[pathKey] = pathResidual;
		}
	}
	return residual;
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
			emit(`# ${title}\n\n`);
			anyProse = true;
		}
		if (version) {
			emit(`Version: ${version}\n\n`);
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
			emit(`Tags: ${names.join(", ")}\n\n`);
			anyProse = true;
		}
	}
	return anyProse;
}

function renderOperationProse(op: Record<string, unknown>, emit: (s: string) => void): void {
	const summary = stringField(op, "summary");
	if (summary) emit(`Summary: ${summary}\n\n`);

	const description = stringField(op, "description");
	if (description) emit(`${description}\n\n`);

	const operationId = stringField(op, "operationId");
	if (operationId) emit(`Operation ID: ${operationId}\n\n`);

	const parameters = op.parameters;
	if (Array.isArray(parameters) && parameters.length > 0) {
		emit("Parameters:\n");
		for (const p of parameters) {
			if (!isPlainObject(p)) continue;
			const name = stringField(p, "name");
			const inLoc = stringField(p, "in");
			const desc = stringField(p, "description");
			if (!name) continue;
			const inPart = inLoc ? ` (${inLoc})` : "";
			const descPart = desc ? `: ${desc}` : "";
			emit(`- ${name}${inPart}${descPart}\n`);
		}
		emit("\n");
	}

	const responses = op.responses;
	if (isPlainObject(responses) && Object.keys(responses).length > 0) {
		emit("Responses:\n");
		// Sort numerically when status codes are numeric, else lex.
		const statuses = Object.keys(responses).sort((a, b) => {
			const na = Number.parseInt(a, 10);
			const nb = Number.parseInt(b, 10);
			if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
			return a.localeCompare(b);
		});
		for (const status of statuses) {
			const resp = responses[status];
			const desc = isPlainObject(resp) ? stringField(resp, "description") : null;
			emit(`- ${status}${desc ? `: ${desc}` : ""}\n`);
		}
		emit("\n");
	}

	const requestBody = op.requestBody;
	if (isPlainObject(requestBody)) {
		const desc = stringField(requestBody, "description");
		if (desc) emit(`Request body: ${desc}\n\n`);
	}

	const tags = op.tags;
	if (Array.isArray(tags) && tags.length > 0) {
		const names: string[] = [];
		for (const t of tags) {
			if (typeof t === "string") names.push(t);
		}
		if (names.length > 0) emit(`Tags: ${names.join(", ")}\n\n`);
	}
}

interface FenceContent {
	body: string;
	language: "json" | "text";
}

/**
 * Serialize a value as compact JSON for the `code` FTS column. Bounded
 * by `MAX_FENCE_JSON_BYTES` to defend against pathological payloads (a
 * single operation embedding MB of example data, a `components` subtree
 * with thousands of schemas). Compact form ~halves the byte cost —
 * pretty-printing buys nothing for an FTS column that tokenizes on
 * whitespace anyway. `label` is interpolated into the error message
 * when serialization fails.
 *
 * On truncation the fence language drops to `text` so an agent calling
 * `JSON.parse` on `get_fragment(file).content` doesn't fail on the
 * partial payload — the elision marker inside the body documents the
 * cut. FTS routing is unaffected because `extractFtsTexts` reads
 * `excludedRanges` offsets, not the fence info-string.
 *
 * Transient `JSON.stringify` peak is bounded by the upstream 10 MB
 * file cap (`MAX_FILE_BYTES`); fences emit sequentially, not summed.
 */
function stringifyJsonForFence(value: unknown, label: string): FenceContent {
	try {
		const s = JSON.stringify(value);
		if (typeof s !== "string") return { body: "{}", language: "json" };
		if (s.length <= MAX_FENCE_JSON_BYTES) return { body: s, language: "json" };
		const elided = `${s.slice(0, MAX_FENCE_JSON_BYTES)}\n... (truncated; ${s.length - MAX_FENCE_JSON_BYTES} bytes elided)`;
		return { body: elided, language: "text" };
	} catch (cause) {
		throw ParseError.yaml("syntax", `OpenAPI ${label} not JSON-serializable: ${errorMessage(cause)}`);
	}
}

/**
 * Build a single `HeadingMeta` from a precomputed `SynthSection`. The
 * D44 name-based slot scheme (`op[<sha14(method + ' ' + path)>]` for
 * operations, literal labels like `"components"` for named singletons)
 * is fixed by the section builder; this function just threads the
 * precomputed values into the `HeadingMeta` shape and resolves the
 * relpath-aware `stable_id`.
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

	return {
		stable_id: id,
		structuralPath: sec.structuralSlot,
		level: 2 as HeadingLevel,
		pathText: sec.headingText,
		displayText: sec.headingText,
		slug: dedupSlug(sec.baseSlug),
		headingPath: [sec.headingText],
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
function inferContentKinds(op: Record<string, unknown>): ContentKind[] {
	const kinds: ContentKind[] = ["code"];
	const params = op.parameters;
	const responses = op.responses;
	const hasParams = Array.isArray(params) && params.length > 0;
	const hasResponses = isPlainObject(responses) && Object.keys(responses).length > 0;
	if (hasParams || hasResponses) kinds.push("list");
	return kinds;
}

function pathToSlug(method: string, path: string): string {
	// GitHub-style slug: lowercase, replace non-alnum with `-`, collapse runs.
	const raw = `${method}-${path}`.toLowerCase();
	const slug = raw.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
	return slug || "operation";
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

function stringField(obj: Record<string, unknown>, key: string): string | null {
	const v = obj[key];
	return typeof v === "string" && v.length > 0 ? v : null;
}
