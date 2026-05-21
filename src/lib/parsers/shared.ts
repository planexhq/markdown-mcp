/**
 * Helpers shared across spec-format synthesizers (AsyncAPI, OpenAPI,
 * future Prisma): prototype-pollution defenses, JSON-fence
 * emission with 64 KiB cap and `json`→`text` language swap on
 * truncation, and `stringField` for non-empty string extraction.
 *
 * `deepMerge` stays AsyncAPI-local — it depends on `extractRefString`
 * for Reference Object hybridization defense. `nullableString` (preserves
 * `""`) is similarly AsyncAPI-local until a second consumer needs it.
 */

import type { Range } from "../../types.js";
import { errorMessage } from "../error.js";
import { isPlainObject, ParseError } from "../parser.js";

/**
 * `target[k] = v` on `__proto__` invokes `Object.prototype`'s inherited
 * setter and reroutes the target's `[[Prototype]]`; the `yaml` parser
 * stores `__proto__:` as own enumerable data so the key reaches
 * synthesizer code. `constructor` is deliberately NOT in this set:
 * writing `target.constructor = v` shadows the inherited data property
 * without invoking any setter — no prototype-pollution vector — and
 * JSON Schema `properties.constructor: { type }` is legitimate user
 * content that earlier defensive stripping silently dropped from
 * `## Components`.
 */
export const DANGEROUS_KEYS: ReadonlySet<string> = new Set(["__proto__"]);

/**
 * Walk a plain-object / array tree, returning a copy with `__proto__`
 * keys filtered at every depth. Applied to merged or user-controlled
 * subtrees before JSON-fence serialization — `JSON.stringify`'s
 * own-enumerable-key iteration would otherwise surface yaml-parsed
 * `__proto__:` data. Array branch maps element-wise so objects nested
 * inside array-valued fields (`tags`, `security`, protocol-binding
 * sub-arrays, OpenAPI `parameters[]`) are scrubbed too — the
 * object-only branch missed array elements per RFC 7396 §1's
 * "arrays atomic" rule, but that rule applies to the MERGE operator;
 * the SANITIZE walk must still visit element children. Scalars /
 * tagged scalars / null are atomic leaves.
 */
export function deepSanitize(v: unknown): unknown {
	if (Array.isArray(v)) return v.map(deepSanitize);
	if (!isPlainObject(v)) return v;
	const out: Record<string, unknown> = {};
	for (const k of Object.keys(v)) {
		if (DANGEROUS_KEYS.has(k)) continue;
		out[k] = deepSanitize(v[k]);
	}
	return out;
}

/**
 * Assign `value` to `target[key]` without invoking inherited accessors.
 * For `key === "__proto__"`, `target[key] = value` routes through
 * `Object.prototype`'s inherited `__proto__` setter (polluting the
 * target's `[[Prototype]]` and leaving NO own data); `Object.defineProperty`
 * writes an own data property unconditionally. Used at non-merge call
 * sites where the user-supplied key MAY legitimately be `__proto__`
 * (e.g. an OpenAPI components bucket literally named `__proto__`, an
 * AsyncAPI operation named `__proto__`) and should be preserved as own
 * data rather than silently dropped by the setter.
 */
export function safeSet(target: Record<string, unknown>, key: string, value: unknown): void {
	if (DANGEROUS_KEYS.has(key)) {
		Object.defineProperty(target, key, {
			value,
			writable: true,
			enumerable: true,
			configurable: true,
		});
	} else {
		target[key] = value;
	}
}

/**
 * Catch-all fence scrubber: at depth 0 of a plain-object map, preserves
 * user-controlled keys via `safeSet` (server/channel/operation names —
 * including a literal `__proto__`) and `deepSanitize`s each value
 * subtree. Non-object inputs (arrays from invalid drafts like
 * `info: [...]`, x-* extension arrays, scalars) route through
 * `deepSanitize` directly so attacker payloads nested inside array
 * elements still get scrubbed; without this, an `x-extra: [{__proto__:
 * {pwn: "X"}}]` would have reached the fence unscrubbed.
 */
export function sanitizeNested(v: unknown): unknown {
	if (isPlainObject(v)) {
		const out: Record<string, unknown> = {};
		for (const k of Object.keys(v)) {
			safeSet(out, k, deepSanitize(v[k]));
		}
		return out;
	}
	return deepSanitize(v);
}

/**
 * Walk a two-level user-content map (SPEC-defined bucket layer over
 * user-named entry layer — e.g. AsyncAPI / OpenAPI `components` whose
 * `schemas` / `messages` / etc. each hold maps of user-chosen names).
 * The bucket-key layer is filtered through `DANGEROUS_KEYS` because
 * bucket names are spec-defined (fixed component types + `x-*`
 * extensions); `__proto__` is never legitimate there, so a hostile
 * `components.__proto__:` doesn't reach the `## Components` fence.
 * Each bucket VALUE flows through `sanitizeNested` so a USER-named
 * `__proto__` one level deeper (e.g. `components.schemas.__proto__`)
 * IS preserved via `safeSet` at depth 0 of that subtree.
 */
export function sanitizeBucketMap(buckets: Record<string, unknown>): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const bucketKey of Object.keys(buckets)) {
		if (DANGEROUS_KEYS.has(bucketKey)) continue;
		out[bucketKey] = sanitizeNested(buckets[bucketKey]);
	}
	return out;
}

/**
 * Hard cap on the compact JSON payload inside a `code`-routed fence
 * (per operation, components, spec metadata, etc.). Defends against
 * pathological specs — a single op embedding MB of example data, or a
 * `components` / `channels` subtree with thousands of nested entries.
 */
export const MAX_FENCE_JSON_BYTES = 64 * 1024;

export interface FenceContent {
	body: string;
	language: "json" | "text";
}

/**
 * `JSON.stringify` replacer that drops `DANGEROUS_KEYS` inline — same
 * security property as `deepSanitize` for fence output, without
 * allocating a copy of the input tree. Synthesizers that don't already
 * `deepSanitize` their value (e.g. Prisma, whose AST is consumed
 * verbatim) pass this as the `replacer` argument to
 * `stringifyJsonForFence`.
 */
export function jsonSanitizeReplacer(key: string, value: unknown): unknown {
	return DANGEROUS_KEYS.has(key) ? undefined : value;
}

/**
 * Serialize a value as compact JSON for a `code` FTS fence. On
 * truncation the fence language drops to `text` so an agent calling
 * `JSON.parse` on `get_fragment(file).content` doesn't fail on the
 * partial payload — the elision marker inside the body documents the
 * cut. FTS routing is unaffected because `extractFtsTexts` reads
 * `excludedRanges` offsets, not the fence info-string.
 *
 * `label` is interpolated verbatim into the error message on
 * serialization failure; callers prefix it with the spec format
 * (`"OpenAPI operation"`, `"AsyncAPI components"`) so the surfaced
 * `YAML_PARSE_ERROR` identifies which fence emitter failed.
 *
 * `onSerializationError` is opt-in: when omitted, errors surface as
 * `ParseError.yaml("syntax", ...)` (the OpenAPI/AsyncAPI default).
 * Prisma passes `(msg) => ParseError.prisma("syntax", msg)` so the
 * error code reflects the actual format. `replacer` is opt-in too —
 * synthesizers that don't pre-sanitize pass `jsonSanitizeReplacer`.
 *
 * Transient `JSON.stringify` peak is bounded by the upstream 10 MB
 * file cap; fences emit sequentially, not summed.
 */
export function stringifyJsonForFence(
	value: unknown,
	label: string,
	onSerializationError?: (message: string) => Error,
	replacer?: (key: string, value: unknown) => unknown,
): FenceContent {
	try {
		const s = JSON.stringify(value, replacer);
		if (typeof s !== "string") return { body: "{}", language: "json" };
		if (s.length <= MAX_FENCE_JSON_BYTES) return { body: s, language: "json" };
		const elided = `${s.slice(0, MAX_FENCE_JSON_BYTES)}\n... (truncated; ${s.length - MAX_FENCE_JSON_BYTES} bytes elided)`;
		return { body: elided, language: "text" };
	} catch (cause) {
		const msg = `${label} not JSON-serializable: ${errorMessage(cause)}`;
		throw onSerializationError ? onSerializationError(msg) : ParseError.yaml("syntax", msg);
	}
}

/** Returns `obj[key]` when it's a non-empty string, else `null`. */
export function stringField(obj: Record<string, unknown>, key: string): string | null {
	const v = obj[key];
	return typeof v === "string" && v.length > 0 ? v : null;
}

/**
 * Precompute the start offset of every line in `source`. `lineStarts[i]`
 * is the byte offset of the `i`-th line (0-indexed); built once per
 * synthesis. Synthesized source is `\n`-only by construction (no `\r` is
 * ever emitted); a CR-aware variant for on-disk content lives in
 * `parser.ts:countLines`.
 */
export function computeLineStarts(source: string): number[] {
	const starts: number[] = [0];
	for (let i = 0; i < source.length; i++) {
		if (source.charCodeAt(i) === 10) starts.push(i + 1);
	}
	return starts;
}

/** Upper-bound binary search: largest `i` with `lineStarts[i] <= offset`. Result is 1-based. */
export function offsetToLine(lineStarts: ReadonlyArray<number>, offset: number): number {
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

export function computeLineRange(lineStarts: ReadonlyArray<number>, startOffset: number, endOffset: number): Range {
	return {
		start: offsetToLine(lineStarts, startOffset),
		end: offsetToLine(lineStarts, Math.max(endOffset - 1, startOffset)),
	};
}

/**
 * GitHub-compatible kebab slug: lowercase the input, replace non-alnum
 * runs with `-`, trim leading/trailing `-`. Fallback returned when the
 * resulting slug would be empty (input was entirely non-alnum).
 */
export function kebabSlug(input: string, fallback: string): string {
	const slug = input
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return slug || fallback;
}

/** True iff `frontmatter` is a non-null record with at least one own key. Mirrors the predicate `ParsedFile.hasFrontmatter` carries on the wire. */
export function hasFrontmatterKeys(frontmatter: Record<string, unknown> | null | undefined): boolean {
	return frontmatter != null && Object.keys(frontmatter).length > 0;
}
