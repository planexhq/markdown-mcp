/**
 * YAML parser entry point. Routes OpenAPI 3.x specs to
 * `synthesizeOpenApiFile` and everything else to opaque emission
 * (whole source indexed as one `file`-kind fragment; parsed top-level
 * exposed as `frontmatter` for nested-path filters). Errors flow
 * through `ParseError.yaml(...)` so `parseErrorPayload` surfaces
 * them as `YAML_PARSE_ERROR`.
 */

import { parse as parseYAML, YAMLParseError } from "yaml";

import { isWhitespaceRange } from "../blockIds.js";
import { errorMessage } from "../error.js";
import { MAX_AST_NODES, MAX_YAML_DEPTH } from "../limits.js";
import {
	countLines,
	isPlainObject,
	normalizeForJson,
	type ParsedFile,
	ParseError,
	type ParseFileOptions,
} from "../parser.js";
import { detectAsyncApi, synthesizeAsyncApiFile } from "./asyncapi.js";
import { detectOpenApi, synthesizeOpenApiFile } from "./openapi.js";
import { hasFrontmatterKeys } from "./shared.js";

export function parseYamlFile(source: string, relpath: string, options: ParseFileOptions = {}): ParsedFile {
	const parsed = parseYamlSource(source);
	const normalized = normalizeTopLevel(parsed);
	// Cap applies to the frontmatterOnly path too — `parseYamlSource`
	// always builds the full AST (the file IS YAML).
	enforceNodeCap(normalized, options.maxAstNodes ?? MAX_AST_NODES);

	const frontmatter = isPlainObject(normalized) ? normalized : null;
	const hasFrontmatter = hasFrontmatterKeys(frontmatter);

	if (options.frontmatterOnly) {
		return buildOpaqueFile(source, relpath, frontmatter, hasFrontmatter, /* withBodyPreamble */ false);
	}

	// Synthesize OpenAPI 3.x; fall through to opaque emission otherwise
	// (Swagger 2.x deferred to v1.x; sparse 3.x with no operations + no info
	// prose returns null so raw YAML stays searchable).
	if (detectOpenApi(normalized)) {
		const synthesized = synthesizeOpenApiFile(normalized, relpath);
		if (synthesized !== null) return synthesized;
	}

	// Synthesize AsyncAPI 3.x; falls through to opaque emission for 2.x
	// (nested publish/subscribe under channels is deferred). `top.openapi`
	// and `top.asyncapi` are mutually exclusive top-level fields, so
	// detection order is a no-op tie-break.
	if (detectAsyncApi(normalized)) {
		const synthesized = synthesizeAsyncApiFile(normalized, relpath);
		if (synthesized !== null) return synthesized;
	}

	return buildOpaqueFile(source, relpath, frontmatter, hasFrontmatter, /* withBodyPreamble */ true);
}

/**
 * Build the opaque-YAML `ParsedFile` shape — shared between the
 * `frontmatterOnly` fast path and the non-OpenAPI fallback. Whole source
 * IS the body: `buildFragmentRows` (scanner.ts) reads
 * `frontmatterEndOffset` to slice the file row's range; offset 0 puts the
 * entire YAML source into the indexable `body`/`code` columns.
 *
 * `withBodyPreamble=true` emits a whole-source preamble so
 * `computeFileMetrics` counts body tokens for non-OpenAPI YAML.
 * `frontmatterOnly` callers (`get_metadata`) skip the preamble to mirror
 * markdown's fast path — the body span is irrelevant for metadata reads.
 */
function buildOpaqueFile(
	source: string,
	relpath: string,
	frontmatter: Record<string, unknown> | null,
	hasFrontmatter: boolean,
	withBodyPreamble: boolean,
): ParsedFile {
	const preamble =
		withBodyPreamble && !isWhitespaceRange(source)
			? {
					range: { start: 1, end: countLines(source) },
					offsetRange: { start: 0, end: source.length },
					contentKinds: [],
				}
			: null;
	return {
		kind: "yaml",
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

function parseYamlSource(source: string): unknown {
	try {
		return parseYAML(source);
	} catch (cause) {
		// V8 stack-overflow surfaces as RangeError; reclassify so
		// depth failures share `enforceNodeCap`'s code, not `syntax`.
		if (cause instanceof RangeError) {
			throw ParseError.yaml(
				"ast_node_cap_exceeded",
				"YAML parse exceeded recursion limit (likely pathological nesting depth)",
			);
		}
		throw ParseError.yaml("syntax", `YAML parse failed: ${errorMessage(cause)}`, extractYamlErrorPos(cause));
	}
}

/**
 * Run the same cycle-safe + JSON-serializable normalization the markdown
 * frontmatter path uses (`parser.ts:normalizeForJson`). `normalizeForJson`
 * itself throws `ParseError` on cycles AND on BigInt values, so a separate
 * `JSON.stringify` pre-flight is unnecessary.
 */
function normalizeTopLevel(parsed: unknown): unknown {
	try {
		return normalizeForJson(parsed);
	} catch (cause) {
		if (cause instanceof ParseError) {
			throw ParseError.yaml(cause.reason, cause.message, {
				...(cause.line !== undefined ? { line: cause.line } : {}),
				...(cause.column !== undefined ? { column: cause.column } : {}),
			});
		}
		// `normalizeForJson` has no depth guard; surface stack overflows as ast_node_cap_exceeded.
		if (cause instanceof RangeError) {
			throw ParseError.yaml(
				"ast_node_cap_exceeded",
				"YAML normalization exceeded recursion limit (likely pathological nesting depth)",
			);
		}
		throw ParseError.yaml("syntax", `YAML normalization failed: ${errorMessage(cause)}`);
	}
}

function enforceNodeCap(v: unknown, cap: number): void {
	let count = 0;
	function walk(node: unknown, depth: number): void {
		count++;
		if (count > cap) return;
		if (depth > MAX_YAML_DEPTH) {
			// Pathological depth — treat as cap-exceeded rather than recursing.
			count = cap + 1;
			return;
		}
		if (node === null || typeof node !== "object") return;
		if (Array.isArray(node)) {
			for (const item of node) {
				walk(item, depth + 1);
				if (count > cap) return;
			}
			return;
		}
		for (const child of Object.values(node as object)) {
			walk(child, depth + 1);
			if (count > cap) return;
		}
	}
	walk(v, 0);
	if (count > cap) {
		throw ParseError.yaml("ast_node_cap_exceeded", `YAML parse produced ${count} nodes, exceeding the ${cap} cap.`);
	}
}

/**
 * `yaml@2.x` throws `YAMLParseError` with a `linePos` array on syntax
 * failures (and a position-less message on some I/O paths). Extract
 * 1-based line/column when available; return `undefined` otherwise so
 * `ParseError`'s line/column stay omitted.
 */
function extractYamlErrorPos(cause: unknown): { line?: number; column?: number } {
	if (cause instanceof YAMLParseError) {
		const linePos = cause.linePos?.[0];
		if (linePos !== undefined) {
			return { line: linePos.line, column: linePos.col };
		}
	}
	return {};
}
