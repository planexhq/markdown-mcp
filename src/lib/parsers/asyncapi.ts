/**
 * AsyncAPI 3.x synthesizer.
 *
 * `structuralPath = "op[<sha14(opName)>]"`: AsyncAPI 3.x operations have
 * explicit map-key names guaranteed unique within a document, so the slot
 * hash input is single-source. Name-based slots survive operation reorder;
 * renaming an operation retires its ID.
 *
 * `frontmatter` holds the entire top-level object so nested-path filters
 * (`fields["info.version"]`) work without AsyncAPI-specific wiring. The
 * synthesized `source` is the prose rendering used by `get_fragment`;
 * `note://` returns the LITERAL on-disk YAML.
 *
 * AsyncAPI 2.x (operations nested under channels as `publish`/`subscribe`)
 * falls through to opaque YAML emission. The detection gate is
 * `asyncapi: "3.*"`.
 */

import type { ContentKind, HeadingLevel, Range } from "../../types.js";
import type { ExcludedRange } from "../blockIds.js";
import { errorMessage } from "../error.js";
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
	ParseError,
} from "../parser.js";
import { sha1HexN, stableId } from "../structuralPath.js";
import { estimateTokens } from "../tokenizer.js";

/**
 * Hard cap on the compact JSON payload inside a `code`-routed fence
 * (per operation, channels, components, spec metadata). Defends against
 * pathological specs (a single op embedding MB of example data,
 * a `channels` subtree with thousands of messages).
 */
const MAX_FENCE_JSON_BYTES = 64 * 1024;

/**
 * Aggregate cap on synthesized source bytes. Trait amplification: N ops
 * referencing one large-`description` OperationTrait expand to N ×
 * <trait-bytes> of duplicated prose, which `MAX_FENCE_JSON_BYTES` does
 * not bound (it only caps individual JSON fences). Cap-exceeded forces
 * opaque-YAML fallback. 2× the input cap leaves headroom for legitimate
 * prose + fence inflation.
 */
const MAX_SYNTHESIZED_SOURCE_BYTES = 2 * MAX_FILE_BYTES;

/** Cap preamble server lines so a 200-server spec doesn't bloat the preamble row. */
const MAX_PREAMBLE_SERVERS = 20;

const VALID_ACTIONS = ["send", "receive"] as const;
type AsyncApiAction = (typeof VALID_ACTIONS)[number];
const VALID_ACTION_SET: ReadonlySet<string> = new Set(VALID_ACTIONS);

/** Returns true iff `top` looks like an AsyncAPI 3.x document. */
export function detectAsyncApi(top: unknown): top is Record<string, unknown> {
	if (!isPlainObject(top)) return false;
	const ver = top.asyncapi;
	return typeof ver === "string" && /^3\./.test(ver);
}

interface OperationEntry {
	name: string;
	/** Null when the root `operations.<name>` slot is an external/unresolved `$ref` — the target's `action` field is unreachable, so the entry renders as a minimal heading + `Reference:` line + `{$ref}` fence. Inline ops AND intra-doc aliased ops always carry a resolved action. */
	action: AsyncApiAction | null;
	merged: Record<string, unknown>;
	rawRef: string | null;
	/** Channel resolution: address / map-key name / raw `$ref` (unresolved). All 3 states collapse into a single render string per `resolveChannelText`. */
	channelText: string | null;
	messageNames: string[];
	replyChannelText: string | null;
	replyMessageNames: string[];
	/** Reply-address render: `$message.header#/replyTo` location string OR raw `$ref` for external/unresolved ref-form addresses. Single field; rendering doesn't branch on state. */
	replyAddressText: string | null;
	/** Set when `op.reply` itself is an unresolved/external ref. Suppresses the entire Reply block in favor of a single `Reply: <raw $ref>` line so the ref stays searchable. */
	replyRawRef: string | null;
}

/**
 * One emitted heading within the synthesized source. Mirrors openapi.ts's
 * `SynthSection` shape — kept module-local so the two synthesizers stay
 * independent.
 */
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

interface PreambleInfo {
	rangeStart: number;
	rangeEnd: number;
	hasProse: boolean;
}

/**
 * Synthesize a `ParsedFile` for an AsyncAPI 3.x document. `top` is the
 * parsed, normalized top-level object (output of `normalizeForJson`).
 * `relpath` is the vault-relative path used in `stable_id` generation.
 *
 * Returns `null` when the synthesized source would be empty (no operations
 * AND no preamble prose AND no channels/components). Callers fall back to
 * opaque YAML emission so a sparse `asyncapi: "3.0.0"\nfoo: bar` file stays
 * searchable rather than silently dropping from the index.
 */
export function synthesizeAsyncApiFile(top: Record<string, unknown>, relpath: string): ParsedFile | null {
	const operations = enumerateOperations(top);
	const built = buildSynthesizedSource(top, operations);
	if (built === null || !built.hasPrimaryContent) return null;
	const lineStarts = computeLineStarts(built.source);

	const preamble = built.preamble.hasProse ? buildPreambleMeta(built.preamble, lineStarts) : null;
	const dedupSlug = createSlugDedup();
	const headings = built.sections.map((sec) => buildHeadingMeta(sec, relpath, built.source, lineStarts, dedupSlug));
	const outline = buildOutlineTree(headings);
	annotateDescendantTokens(outline, headings);

	return {
		kind: "yaml",
		relpath,
		source: built.source,
		hasFrontmatter: true,
		frontmatter: top,
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
 * Walk `top.operations` (a map of opName → operation object), sort by name
 * alphabetically, resolve each operation's intra-doc `$ref`s for channel
 * and messages so the prose layer can render addresses + message names.
 * Operations missing or carrying an invalid `action` are skipped — they
 * can't be addressed as `send X` / `receive X` headings.
 */
function enumerateOperations(top: Record<string, unknown>): OperationEntry[] {
	const operations = top.operations;
	if (!isPlainObject(operations)) return [];

	const out: OperationEntry[] = [];
	const names = Object.keys(operations).sort();

	for (const name of names) {
		const rawRef = extractRefString(operations[name]);
		const op = maybeDereference(top, operations[name], "operations");
		if (op === null) {
			// External/unresolved ref: emit a minimal heading + `{$ref: rawRef}` fence so
			// `get_file_outline` / per-op `get_fragment` navigation works for specs that
			// factor operations into shared files. Symmetric with how channel / reply /
			// message external refs already render verbatim.
			if (rawRef === null) continue;
			out.push({
				name,
				action: null,
				merged: { $ref: rawRef },
				rawRef,
				channelText: null,
				messageNames: [],
				replyChannelText: null,
				replyMessageNames: [],
				replyAddressText: null,
				replyRawRef: null,
			});
			continue;
		}
		const action = stringField(op, "action");
		if (action === null || !VALID_ACTION_SET.has(action)) continue;

		const traits = dereferenceTraits(top, op);
		const merged = applyTraitMerge(op, traits);

		const channelText = resolveChannelText(top, op.channel);
		const messageNames =
			op.messages === undefined
				? resolveImpliedChannelMessages(top, op.channel)
				: resolveMessageNames(top, op.messages);

		const { resolved: reply, rawRef: replyRawRef } = resolveOrRetainRef(top, merged.reply, "replies");
		let replyChannelText: string | null = null;
		let replyMessageNames: string[] = [];
		let replyAddressText: string | null = null;
		if (reply !== null) {
			replyChannelText = resolveChannelText(top, reply.channel);
			replyMessageNames =
				reply.messages === undefined
					? resolveImpliedChannelMessages(top, reply.channel)
					: resolveMessageNames(top, reply.messages);
			const { resolved: address, rawRef: addressRawRef } = resolveOrRetainRef(top, reply.address, "replyAddresses");
			replyAddressText = addressRawRef ?? (address !== null ? stringField(address, "location") : null);
		}
		out.push({
			name,
			action: action as AsyncApiAction,
			merged,
			rawRef,
			channelText,
			messageNames,
			replyChannelText,
			replyMessageNames,
			replyAddressText,
			replyRawRef,
		});
	}

	return out;
}

/**
 * Dereference each entry in `op.traits` through `components.operationTraits`.
 * Returns trait objects in spec-defined application order — JSON Merge
 * Patch applies them sequentially; target wins over all traits and later
 * traits override earlier on field collisions.
 */
function dereferenceTraits(top: Record<string, unknown>, op: Record<string, unknown>): Record<string, unknown>[] {
	const raw = op.traits;
	if (!Array.isArray(raw)) return [];
	const out: Record<string, unknown>[] = [];
	for (const t of raw) {
		const resolved = maybeDereference(top, t, "operationTraits");
		if (resolved !== null) out.push(resolved);
	}
	return out;
}

/** Spec-forbidden in AsyncAPI 3 OperationTrait — defensively dropped from the merge so a malformed spec can't smuggle them through a trait. `reply` is intentionally absent: per OperationTrait Object spec, traits MAY contain any property from the Operation Object except `action`/`channel`/`messages`/`traits`. */
const TRAIT_FORBIDDEN_FIELDS: ReadonlySet<string> = new Set(["action", "channel", "messages", "traits"]);

/** `target[k] = v` on `__proto__` invokes `Object.prototype`'s inherited setter and reroutes the target's `[[Prototype]]`; the `yaml` parser stores `__proto__:` as own enumerable data so the key reaches this merge code. `constructor` is deliberately NOT in this set: writing `target.constructor = v` shadows the inherited data property without invoking any setter — no prototype-pollution vector — and JSON Schema `properties.constructor: { type }` is legitimate user content that earlier defensive stripping silently dropped from `## Components`. */
const DANGEROUS_KEYS: ReadonlySet<string> = new Set(["__proto__"]);

/**
 * Walk a plain-object / array tree, returning a copy with `__proto__`
 * keys filtered at every depth. Applied to `applyTraitMerge` output so
 * the JSON fence — which serializes via `JSON.stringify`'s own-
 * enumerable-key iteration — doesn't surface yaml-parsed `__proto__:`
 * data nested anywhere in the merged tree. Array branch maps element-
 * wise so objects nested inside array-valued AsyncAPI fields (`tags`,
 * `security`, protocol-binding sub-arrays) are scrubbed too — the
 * original object-only branch missed array elements per RFC 7396 §1's
 * "arrays atomic" rule, but that rule applies to the MERGE operator
 * (don't recurse into arrays during merge); the SANITIZE walk must
 * still visit element children. Scalars / tagged scalars / null are
 * atomic leaves.
 */
function deepSanitize(v: unknown): unknown {
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
 * (e.g. an AsyncAPI operation literally named `__proto__`) and should
 * be preserved as own data rather than silently dropped by the setter.
 */
function safeSet(target: Record<string, unknown>, key: string, value: unknown): void {
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
function sanitizeNested(v: unknown): unknown {
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
 * Recursive merge: returns a new object where `b` wins at every leaf
 * and nested plain objects recurse. Arrays, scalars, and null are
 * atomic per RFC 7396 §1. AsyncAPI Reference Objects (`{$ref: "..."}`)
 * are also atomic per spec — the Reference Object spec forbids
 * siblings, so a recursive merge would produce an invalid hybrid
 * (`{$ref, kafka, ...}`); when either side holds a `$ref` we collapse
 * to `bv` directly (target-wins preserves op-level $ref or replaces
 * trait $ref with op inline).
 */
function deepMerge(a: Record<string, unknown>, b: Record<string, unknown>): Record<string, unknown> {
	const out: Record<string, unknown> = { ...a };
	for (const k of Object.keys(b)) {
		if (DANGEROUS_KEYS.has(k)) continue;
		const av = out[k];
		const bv = b[k];
		const bothObjects = isPlainObject(av) && isPlainObject(bv);
		const eitherIsRef = bothObjects && (extractRefString(av) ?? extractRefString(bv)) !== null;
		out[k] = bothObjects && !eitherIsRef ? deepMerge(av, bv) : bv;
	}
	return out;
}

/**
 * JSON Merge Patch view of an operation + its traits per RFC 7396 +
 * AsyncAPI 3 OperationTrait spec. Recursive across object-valued fields;
 * arrays atomic. Target wins on collision at every leaf; later traits
 * override earlier between traits. Patch-present: target's
 * explicit `""` (or any non-undefined own value) beats trait values.
 * RFC 7396's null-as-delete clause is intentionally NOT honored — null
 * is treated as an atomic scalar leaf (AsyncAPI specs don't use null
 * as a trait remove sentinel in practice). Output is `deepSanitize`d
 * so yaml-parsed `__proto__:` keys are dropped at every depth — per-op
 * fence, aliased-operations fence, prose readers (`stringField(entry.merged, ...)`),
 * AND the catch-all `## Channels` / `## Components` fences (which carry
 * defined-shape subtrees). The `## Spec metadata` residual uses
 * `sanitizeNested` instead: it preserves user-content `__proto__` map
 * keys (operation names, server names, info residual extension keys)
 * at depth 0 via `safeSet` and `deepSanitize`s value subtrees deeper.
 */
function applyTraitMerge(
	op: Record<string, unknown>,
	traits: ReadonlyArray<Record<string, unknown>>,
): Record<string, unknown> {
	if (traits.length === 0) return deepSanitize(op) as Record<string, unknown>;
	let traitAcc: Record<string, unknown> = {};
	for (const trait of traits) {
		const filtered: Record<string, unknown> = {};
		for (const k of Object.keys(trait)) {
			if (TRAIT_FORBIDDEN_FIELDS.has(k) || DANGEROUS_KEYS.has(k)) continue;
			filtered[k] = trait[k];
		}
		traitAcc = deepMerge(traitAcc, filtered);
	}
	return deepSanitize(deepMerge(traitAcc, op)) as Record<string, unknown>;
}

/**
 * Single-deref classifier for values that may be inline, an intra-doc ref,
 * or an external/unresolved ref. Preferred over a `maybeDereference` +
 * `extractRefString` pair when the caller needs both the resolved object
 * AND the raw ref string (e.g. reply rendering — external refs surface
 * verbatim rather than dropping).
 */
function resolveOrRetainRef(
	top: Record<string, unknown>,
	value: unknown,
	componentKey: ComponentBucket,
): { resolved: Record<string, unknown> | null; rawRef: string | null } {
	if (!isPlainObject(value)) return { resolved: null, rawRef: null };
	const resolved = dereferenceAnywhere(top, value, componentKey);
	if (resolved !== null) return { resolved, rawRef: null };
	const ref = extractRefString(value);
	return ref !== null ? { resolved: null, rawRef: ref } : { resolved: value, rawRef: null };
}

/**
 * Resolve `operation.channel` / `reply.channel` to a renderable string.
 * Null/absent address renders `<map-key> (address unknown)` rather than
 * the bare map-key — spec defines null/absent as "unknown," so labeling
 * the channel ID alone as `Channel: <id>` would be a false claim.
 */
function resolveChannelText(top: Record<string, unknown>, channel: unknown): string | null {
	const ref = extractRefString(channel);
	if (ref === null) return null;
	const parsed = parseChannelRef(ref);
	if (parsed === null) return ref;
	const resolved = findChannel(top, parsed);
	if (resolved === null) return ref;
	const address = nullableString(resolved, "address");
	if (address !== null) return address;
	return `${parsed.name} (address unknown)`;
}

/** Read the `$ref` string from a Reference Object, or `null` when shape-wrong. */
function extractRefString(obj: unknown): string | null {
	if (!isPlainObject(obj)) return null;
	const ref = obj.$ref;
	return typeof ref === "string" && ref.length > 0 ? ref : null;
}

/** True iff `obj` is a `{$ref: "..."}` stub. Callers reject these to enforce the single-level invariant — `isPlainObject` admits stubs, this filters them. */
function isUnresolvedRefStub(obj: Record<string, unknown>): boolean {
	return extractRefString(obj) !== null;
}

/**
 * AsyncAPI 3 buckets under `components` that may be the target of a
 * Reference Object. Constrained to a string-literal union so typos in
 * the bucket name fail at compile time rather than silently resolving
 * to `null` at runtime (which would masquerade as "external ref").
 */
type ComponentBucket =
	| "operations"
	| "channels"
	| "messages"
	| "replies"
	| "replyAddresses"
	| "servers"
	| "operationTraits"
	| "tags";

/**
 * The three AsyncAPI 3 root-level buckets that may also be the target
 * of an intra-doc Reference Object (`#/operations/<name>`,
 * `#/channels/<name>`, `#/servers/<name>`). Uncommon but legal — the
 * spec doesn't restrict refs to `components/*`. `replies`,
 * `replyAddresses`, `messages`, `operationTraits`, and `tags` exist
 * ONLY under `components` so they're absent from this list.
 */
const ROOT_BUCKET_NAMES = ["operations", "channels", "servers"] as const;
type RootBucket = (typeof ROOT_BUCKET_NAMES)[number];

function isRootBucket(key: ComponentBucket): key is RootBucket {
	return (ROOT_BUCKET_NAMES as readonly string[]).includes(key);
}

/**
 * Resolve a Reference Object against a pre-resolved `bucket` keyed by `name`.
 * The outer slot/map key — not the ref target — remains the identity for
 * `stable_id` and prose rendering. Single-level resolution: chained refs
 * (target is itself a ref-stub) return null.
 */
function dereferenceFromBucket(valueOrRef: unknown, section: string, bucket: unknown): Record<string, unknown> | null {
	const ref = extractRefString(valueOrRef);
	if (ref === null) return null;
	const name = parseIntraDocRef(ref, section);
	if (name === null) return null;
	if (!isPlainObject(bucket)) return null;
	const target = bucket[name];
	if (!isPlainObject(target)) return null;
	if (isUnresolvedRefStub(target)) return null;
	return target;
}

/** `#/components/<componentKey>/<name>` lookup. */
function dereferenceComponent(
	top: Record<string, unknown>,
	valueOrRef: unknown,
	componentKey: ComponentBucket,
): Record<string, unknown> | null {
	const components = top.components;
	if (!isPlainObject(components)) return null;
	return dereferenceFromBucket(valueOrRef, `components/${componentKey}`, components[componentKey]);
}

/**
 * Resolve a Reference Object via `#/components/<componentKey>/<name>` and
 * — for the three root-level buckets — fall through to `#/<rootKey>/<name>`.
 * Returns `null` for non-refs, external refs, chained refs, and shape-bad
 * targets. Single source of the "components-first, then root" precedence
 * rule used by `resolveOrRetainRef` and `maybeDereference`.
 */
function dereferenceAnywhere(
	top: Record<string, unknown>,
	valueOrRef: unknown,
	componentKey: ComponentBucket,
): Record<string, unknown> | null {
	const componentResolved = dereferenceComponent(top, valueOrRef, componentKey);
	if (componentResolved !== null) return componentResolved;
	if (isRootBucket(componentKey)) {
		return dereferenceFromBucket(valueOrRef, componentKey, top[componentKey]);
	}
	return null;
}

/**
 * Resolve a value that may be inline OR a Reference Object. Returns the
 * dereferenced target when it's a ref-form pointing to a concrete inline
 * component (or — for the three root-level buckets — a root entry), the
 * value itself when inline. Returns `null` when the value isn't a plain
 * object OR when it's a ref-stub that didn't resolve (external, chained,
 * or shape-bad) — so a single null check lets callers branch between
 * "concrete object I can read fields off" and "unresolved ref I should
 * render verbatim."
 */
function maybeDereference(
	top: Record<string, unknown>,
	valueOrRef: unknown,
	componentKey: ComponentBucket,
): Record<string, unknown> | null {
	if (!isPlainObject(valueOrRef)) return null;
	const resolved = dereferenceAnywhere(top, valueOrRef, componentKey);
	if (resolved !== null) return resolved;
	if (isUnresolvedRefStub(valueOrRef)) return null;
	return valueOrRef;
}

/**
 * Look up `top.channels[<chanName>]` and dereference through
 * `components.channels` when the entry is a Reference Object. Returns the
 * resolved channel object or `null` when the lookup misses at any hop.
 */
function resolveChannelByName(top: Record<string, unknown>, chanName: string): Record<string, unknown> | null {
	const channels = top.channels;
	if (!isPlainObject(channels)) return null;
	return maybeDereference(top, channels[chanName], "channels");
}

/**
 * Where an intra-doc channel ref points: the root `top.channels` map or
 * `top.components.channels`. AsyncAPI 3 lets shared channels live ONLY
 * under `components.channels`; operations under `components.operations`
 * commonly ref them via `#/components/channels/<name>`.
 */
type ChannelSource = "root" | "components";
interface ChannelRef {
	source: ChannelSource;
	name: string;
}

/**
 * Match a channel `$ref` against either prefix form. Returns the source
 * bucket tag + the remainder after the prefix.
 */
function matchChannelRefPrefix(ref: string): { source: ChannelSource; rest: string } | null {
	const rootPrefix = "#/channels/";
	const componentsPrefix = "#/components/channels/";
	if (ref.startsWith(componentsPrefix)) return { source: "components", rest: ref.slice(componentsPrefix.length) };
	if (ref.startsWith(rootPrefix)) return { source: "root", rest: ref.slice(rootPrefix.length) };
	return null;
}

/**
 * Parse a single-segment channel ref into a `ChannelRef`. External refs,
 * shape mismatches, and refs with trailing path segments past the channel
 * name return `null`. A Reference Object's `$ref` per RFC 6901 points to
 * ONE complete object — trailing `/...` indicates a malformed pointer
 * that should surface as a raw `$ref` render rather than be silently
 * truncated to the wrong target.
 */
function parseChannelRef(ref: string): ChannelRef | null {
	const m = matchChannelRefPrefix(ref);
	if (m === null) return null;
	if (m.rest.length === 0 || m.rest.includes("/")) return null;
	return { source: m.source, name: decodeJsonPointerSegment(m.rest) };
}

/**
 * Resolve a `ChannelRef` to its target Channel Object. Walks the right
 * bucket (root vs components) and applies one ref-form deref via
 * `maybeDereference` — single-level only.
 */
function findChannel(top: Record<string, unknown>, parsed: ChannelRef): Record<string, unknown> | null {
	if (parsed.source === "root") return resolveChannelByName(top, parsed.name);
	const components = top.components;
	if (!isPlainObject(components)) return null;
	const bucket = components.channels;
	if (!isPlainObject(bucket)) return null;
	return maybeDereference(top, bucket[parsed.name], "channels");
}

/**
 * `messageId` is the channel-map key (canonical addressable identifier);
 * `name` is the optional "machine-friendly name" carried on the Message
 * Object. When both are present and differ, emit `messageId (name)` so
 * agent searches for either identifier surface the row.
 */
function formatMessageBullet(messageId: string, message: Record<string, unknown> | null): string {
	const declared = message !== null ? stringField(message, "name") : null;
	return declared !== null && declared !== messageId ? `${messageId} (${declared})` : messageId;
}

/**
 * Resolve an array of message `$ref` objects to a list of bullet strings.
 * Each entry's `$ref` is one of:
 *   - `#/channels/<chan>/messages/<msg>` (channel-scoped, spec-explicit)
 *   - `#/components/channels/<chan>/messages/<msg>` (components-channels)
 *   - `#/components/messages/<msg>` (canonical reusable form)
 * Channel-scoped + components-channels parse via `parseChannelMessageRef`;
 * the bare components-messages form falls back through `parseIntraDocRef`
 * + `maybeDereference`. Missing or shape-invalid targets surface the
 * literal `$ref` string so the malformation stays visible to the editor —
 * chained refs (target itself a `$ref`) still render bare msgId per the
 * single-level invariant since their slot IS a plain object.
 * External refs and shape mismatches at the parse layer fall through to
 * raw `$ref` rendering at the tail.
 */
function resolveMessageNames(top: Record<string, unknown>, messages: unknown): string[] {
	if (!Array.isArray(messages)) return [];
	const out: string[] = [];
	for (const entry of messages) {
		if (!isPlainObject(entry)) continue;
		const ref = extractRefString(entry);
		if (ref === null) continue;
		const channelScoped = parseChannelMessageRef(ref);
		if (channelScoped !== null) {
			const slot = lookupChannelMessageEntry(top, channelScoped);
			if (!isPlainObject(slot)) {
				out.push(ref);
			} else {
				out.push(formatMessageBullet(channelScoped.message, resolveMessageEntryDeref(top, slot)));
			}
			continue;
		}
		const componentName = parseIntraDocRef(ref, "components/messages");
		if (componentName !== null) {
			const slot = lookupComponentMessage(top, componentName);
			if (!isPlainObject(slot)) {
				out.push(ref);
			} else {
				out.push(formatMessageBullet(componentName, isUnresolvedRefStub(slot) ? null : slot));
			}
			continue;
		}
		out.push(ref);
	}
	return out;
}

/** Raw slot at `channel.messages[name]`. Returns `undefined` when any hop misses. */
function lookupChannelMessageEntry(
	top: Record<string, unknown>,
	parsed: { channelRef: ChannelRef; message: string },
): unknown {
	const channel = findChannel(top, parsed.channelRef);
	if (channel === null) return undefined;
	const messages = channel.messages;
	if (!isPlainObject(messages)) return undefined;
	return messages[parsed.message];
}

/** Raw slot at `components.messages[name]`. Returns `undefined` when any hop misses. */
function lookupComponentMessage(top: Record<string, unknown>, name: string): unknown {
	const components = top.components;
	if (!isPlainObject(components)) return undefined;
	const bucket = components.messages;
	if (!isPlainObject(bucket)) return undefined;
	return bucket[name];
}

/**
 * Resolve a value in `channel.messages[name]` — inline OR any of the
 * three legal Reference Object shapes a channel-scoped message entry
 * may take: `#/components/messages/<msg>`, `#/channels/<chan>/messages/<msg>`,
 * or `#/components/channels/<chan>/messages/<msg>`. Single-level
 * invariant: when the target is itself a `$ref`, returns null (chained
 * refs stay unresolved).
 */
function resolveMessageEntryDeref(top: Record<string, unknown>, value: unknown): Record<string, unknown> | null {
	if (!isPlainObject(value)) return null;
	const ref = extractRefString(value);
	if (ref === null) return value;
	const channelScoped = parseChannelMessageRef(ref);
	if (channelScoped !== null) {
		const target = lookupChannelMessageEntry(top, channelScoped);
		if (!isPlainObject(target)) return null;
		if (isUnresolvedRefStub(target)) return null;
		return target;
	}
	return maybeDereference(top, value, "messages");
}

/**
 * Implicit-all interpretation: omitted `messages` means the operation
 * processes every message on its referenced channel. Spec leaves omitted
 * semantics undefined; parser-js + AsyncAPI Studio + generators all treat
 * omitted as the full set.
 */
function resolveImpliedChannelMessages(top: Record<string, unknown>, channelRef: unknown): string[] {
	const ref = extractRefString(channelRef);
	if (ref === null) return [];
	const parsed = parseChannelRef(ref);
	if (parsed === null) return [];
	const channel = findChannel(top, parsed);
	if (channel === null) return [];
	const messages = channel.messages;
	if (!isPlainObject(messages)) return [];
	const out: string[] = [];
	for (const [msgId, rawMsg] of Object.entries(messages)) {
		out.push(formatMessageBullet(msgId, resolveMessageEntryDeref(top, rawMsg)));
	}
	return out;
}

/**
 * Parse `#/<section>/<name>` returning the URI-decoded `<name>` segment.
 * Returns `null` for external refs (`./other.yaml#/...`), shape mismatches,
 * empty names (`#/components/operations/`), or refs with trailing path
 * segments past the name (`#/components/messages/Ping/name` indicates a
 * malformed pointer — Reference Objects target one complete object per
 * RFC 6901 + AsyncAPI spec; the caller's raw-`$ref` render path is the
 * correct surface for malformed refs). Used for non-channel buckets
 * (replies, replyAddresses, operationTraits, servers, etc.); channel refs
 * go through `parseChannelRef` because they have two valid prefix forms
 * (root + components).
 */
function parseIntraDocRef(ref: string, section: string): string | null {
	const prefix = `#/${section}/`;
	if (!ref.startsWith(prefix)) return null;
	const rest = ref.slice(prefix.length);
	if (rest.length === 0 || rest.includes("/")) return null;
	return decodeJsonPointerSegment(rest);
}

/**
 * Parse a two-segment `<channel>/messages/<message>` ref against either
 * prefix form. Both segments returned URI-decoded with the channel's
 * resolution source tagged for `findChannel`. Returns `null` for external
 * refs, shape mismatches, or refs with trailing path segments past the
 * message name — same single-complete-object rule as `parseChannelRef`
 * / `parseIntraDocRef` (silently truncating produces prose from the wrong
 * target).
 */
function parseChannelMessageRef(ref: string): { channelRef: ChannelRef; message: string } | null {
	const m = matchChannelRefPrefix(ref);
	if (m === null) return null;
	const marker = "/messages/";
	const idx = m.rest.indexOf(marker);
	if (idx === -1) return null;
	const chanRaw = m.rest.slice(0, idx);
	if (chanRaw.length === 0 || chanRaw.includes("/")) return null;
	const msgRaw = m.rest.slice(idx + marker.length);
	if (msgRaw.length === 0 || msgRaw.includes("/")) return null;
	return {
		channelRef: { source: m.source, name: decodeJsonPointerSegment(chanRaw) },
		message: decodeJsonPointerSegment(msgRaw),
	};
}

/**
 * Decode a JSON Pointer segment carried in a `$ref` URI fragment.
 * RFC 3986 percent-decode runs FIRST (URI level), then RFC 6901
 * `~1` → `/` / `~0` → `~` escape decode. Order-sensitive: percent-escaped
 * `~` (`%7E`) must reveal itself before the `~0/~1` pass.
 * Malformed `%`-escapes leave the segment as-is rather than throw.
 */
function decodeJsonPointerSegment(seg: string): string {
	let decoded: string;
	try {
		decoded = decodeURIComponent(seg);
	} catch {
		decoded = seg;
	}
	return decoded.replace(/~1/g, "/").replace(/~0/g, "~");
}

interface SynthesisResult {
	source: string;
	sections: SynthSection[];
	preamble: PreambleInfo;
	excludedRanges: ExcludedRange[];
	/**
	 * True iff any dedicated section (preamble prose, an operation, the
	 * channels fence, or the components fence) emitted. Drives the
	 * synthesize-vs-opaque fallback: spec-metadata-only (e.g.
	 * `asyncapi: "3.0.0"\nfoo: bar`) reverts to opaque YAML so a non-spec
	 * file isn't dressed up as one.
	 */
	hasPrimaryContent: boolean;
}

function buildSynthesizedSource(top: Record<string, unknown>, operations: OperationEntry[]): SynthesisResult | null {
	const chunks: string[] = [];
	let offset = 0;
	let truncated = false;
	const excludedRanges: ExcludedRange[] = [];
	const sections: SynthSection[] = [];

	const emit = (s: string): void => {
		if (truncated) return;
		if (offset + s.length > MAX_SYNTHESIZED_SOURCE_BYTES) {
			truncated = true;
			return;
		}
		chunks.push(s);
		offset += s.length;
	};

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

	// ─ Preamble: info + servers ──────────────────────────────────────────
	const preambleStart = offset;
	const hasProse = renderPreamble(top, emit);
	const preambleEnd = offset;

	// ─ Operations (sorted alphabetically by opName) ──────────────────────
	for (const entry of operations) {
		if (truncated) break;
		const sectionStart = offset;

		// Normalize the SOURCE heading line so op names containing `\n`/`\r`
		// (legal YAML for quoted keys) don't inject phantom secondary `##`
		// headings. `sections.headingText` keeps the RAW form so `buildHeadingMeta`
		// can produce a normalized `pathText` AND a raw `displayText`.
		const actionPrefix = entry.action ?? "external";
		const rawHeadingText = `${actionPrefix} ${entry.name}`;
		const headingLine = `## ${normalizeHeadingText(rawHeadingText)}\n`;
		const headingLineEndChar = offset + headingLine.length - 1;
		emit(headingLine);
		emit("\n");
		const headingLineEnd = offset;

		if (entry.action !== null) {
			renderOperationProse(top, entry, emit);
		} else if (entry.rawRef !== null) {
			emit(`Reference: ${normalizeHeadingText(entry.rawRef)}\n\n`);
		}
		// Re-check after the heading/prose emits — `stringifyJsonForFence`
		// below does a full `JSON.stringify(entry.merged)` that an earlier
		// `if (truncated) break;` at the top of the loop can't catch when
		// truncation fires mid-iteration.
		if (truncated) break;
		const opJsonStart = offset;
		// Aliased ops emit bare `$ref`; the shared body remains addressable via `## Components`.
		const fenceSource = entry.rawRef !== null ? { $ref: entry.rawRef } : entry.merged;
		const fence = stringifyJsonForFence(fenceSource, "operation");
		emit(`\`\`\`${fence.language}\n`);
		emit(`${fence.body}\n`);
		emit("```\n\n");
		excludedRanges.push({ offsetStart: opJsonStart, offsetEnd: offset });

		sections.push({
			headingText: rawHeadingText,
			structuralSlot: `op[${sha1HexN(entry.name, 14)}]`,
			baseSlug: opNameToSlug(actionPrefix, entry.name),
			contentKinds: inferContentKinds(entry),
			rangeStart: sectionStart,
			rangeEnd: offset,
			headingLineEnd,
			headingLineEndChar,
		});
	}

	if (truncated) {
		// Catch-all sections each call `sanitizeNested(top.channels/components/leftovers)`
		// (recursive deep-copy) before emitting — skip them when we're already heading
		// for the opaque-YAML fallback.
		return null;
	}

	// ─ Channels catch-all ────────────────────────────────────────────────
	const channels = top.channels;
	const hasChannelsSection = isPlainObject(channels) && Object.keys(channels).length > 0;
	if (hasChannelsSection) {
		emitJsonSection("Channels", "channels", "channels", sanitizeNested(channels), "channels");
	}

	// ─ Components catch-all ──────────────────────────────────────────────
	// `components` is a TWO-level user-content shape: bucket layer
	// (`messages`, `schemas`, …) is spec-defined; the layer inside each
	// bucket is a map of user-controlled names. `sanitizeNested` preserves
	// only one level, so we explicitly walk the bucket layer and apply
	// `sanitizeNested` to each bucket value — that way a message literally
	// named `__proto__` (`components.messages.__proto__`) reaches the
	// fence while deeper attacker payloads stay scrubbed.
	const components = top.components;
	const hasComponentsSection = isPlainObject(components) && Object.keys(components).length > 0;
	if (hasComponentsSection) {
		const sanitizedComponents: Record<string, unknown> = {};
		for (const bucketKey of Object.keys(components)) {
			safeSet(sanitizedComponents, bucketKey, sanitizeNested(components[bucketKey]));
		}
		emitJsonSection("Components", "components", "components", sanitizedComponents, "components");
	}

	// ─ Aliased operations: deduped by `rawRef` so N aliases of one target
	// emit one entry. Independent 64 KiB fence keeps shared bodies searchable
	// when `## Components` truncates. External-ref ops are excluded — their
	// `merged` is just `{$ref: rawRef}`, so a `{rawRef: {$ref: rawRef}}` entry
	// would carry zero new content.
	const aliasedBodies: Record<string, unknown> = {};
	for (const entry of operations) {
		if (entry.rawRef === null || entry.action === null) continue;
		if (Object.hasOwn(aliasedBodies, entry.rawRef)) continue;
		aliasedBodies[entry.rawRef] = entry.merged;
	}
	const hasAliasedSection = Object.keys(aliasedBodies).length > 0;
	if (hasAliasedSection) {
		emitJsonSection(
			"Aliased operations",
			"aliased_operations",
			"aliased-operations",
			aliasedBodies,
			"aliased operations",
		);
	}

	// ─ Spec metadata residual (top-level keys not yet emitted) ───────────
	const operationsRendered = operations.length > 0;
	const renderedNames = new Set(operations.map((e) => e.name));

	let leftovers: Record<string, unknown> | null = null;
	for (const key of Object.keys(top)) {
		if (key === "asyncapi") continue;
		if (key === "operations" && operationsRendered) continue;
		if (key === "channels" && hasChannelsSection) continue;
		if (key === "components" && hasComponentsSection) continue;
		let value: unknown;
		if (key === "info" && isPlainObject(top.info)) {
			value = extractInfoResidual(top.info);
			if (value === null) continue;
		} else {
			// Preserve null/non-object drafts (e.g. `info: null`, `channels: null`,
			// `operations: []`) so live-editing recall surfaces them via
			// `## Spec metadata` instead of silently dropping them.
			value = top[key];
			if (value === undefined) continue;
		}
		if (leftovers === null) leftovers = {};
		safeSet(leftovers, key, sanitizeNested(value));
	}
	if (operationsRendered) {
		const operationsResidual = buildOperationsResidual(top.operations, renderedNames);
		if (operationsResidual !== null) {
			if (leftovers === null) leftovers = {};
			leftovers.operations = sanitizeNested(operationsResidual);
		}
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
		hasPrimaryContent:
			hasProse || operations.length > 0 || hasChannelsSection || hasComponentsSection || hasAliasedSection,
	};
}

/**
 * Build the un-rendered subset of the `operations` map for the
 * spec-metadata fence. Rendered operations already have dedicated heading
 * sections + JSON fences; only entries that didn't render (external
 * `$ref`s, action-invalid shapes, etc.) need to flow through to the
 * residual so they stay searchable.
 */
function buildOperationsResidual(raw: unknown, renderedNames: ReadonlySet<string>): Record<string, unknown> | null {
	if (!isPlainObject(raw)) return null;
	let out: Record<string, unknown> | null = null;
	for (const key of Object.keys(raw)) {
		if (renderedNames.has(key)) continue;
		if (out === null) out = {};
		safeSet(out, key, raw[key]);
	}
	return out;
}

function extractInfoResidual(info: unknown): Record<string, unknown> | null {
	if (!isPlainObject(info)) return null;
	let residual: Record<string, unknown> | null = null;
	for (const key of Object.keys(info)) {
		if (key === "title" || key === "description" || key === "version") continue;
		if (key === "tags") {
			// Preserve full tag objects (descriptions, externalDocs) since the
			// preamble only emits names. Skip when array is empty.
			const v = info[key];
			if (Array.isArray(v) && v.length > 0) {
				if (residual === null) residual = {};
				safeSet(residual, key, v);
			}
			continue;
		}
		if (residual === null) residual = {};
		safeSet(residual, key, info[key]);
	}
	return residual;
}

/**
 * Emit the AsyncAPI 3.x info + servers preamble block. Returns true iff
 * any prose was written (so the caller decides whether to emit a preamble
 * row at all).
 */
function renderPreamble(top: Record<string, unknown>, emit: (s: string) => void): boolean {
	let anyProse = false;
	const info = top.info;
	if (isPlainObject(info)) {
		const title = stringField(info, "title");
		const version = stringField(info, "version");
		const description = stringField(info, "description");
		if (title) {
			// User-controlled identifier interpolated into a single-line prose
			// emit; collapse embedded newlines so the markdown re-parser doesn't
			// pick up phantom `##` headings. Applied at every user-identifier
			// interpolation below — descriptions are passed raw because spec
			// permits multi-paragraph markdown there.
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
		const tagNames = collectTagNames(top, info.tags);
		if (tagNames.length > 0) {
			emit(`Tags: ${tagNames.map(normalizeHeadingText).join(", ")}\n\n`);
			anyProse = true;
		}
	}

	const servers = top.servers;
	if (isPlainObject(servers)) {
		// Buffer lines so an empty `Servers:` block doesn't keep `hasProse`
		// true and block opaque-YAML fallback when every entry is
		// non-renderable (e.g. `servers: {broker: 1}`).
		const renderableLines: string[] = [];
		let omittedRenderable = 0;
		for (const [name, rawServer] of Object.entries(servers)) {
			const { resolved: server, rawRef } = resolveOrRetainRef(top, rawServer, "servers");
			if (server === null && rawRef === null) continue;
			let host: string | null = null;
			let protocol: string | null = null;
			if (server !== null) {
				host = stringField(server, "host");
				protocol = stringField(server, "protocol");
				if (host === null && protocol === null) continue;
			}
			if (renderableLines.length >= MAX_PREAMBLE_SERVERS) {
				omittedRenderable++;
				continue;
			}
			const safeName = normalizeHeadingText(name);
			if (server !== null) {
				const pathname = stringField(server, "pathname");
				const target = composeServerTarget(host, pathname);
				const protoPart = protocol ? ` (${normalizeHeadingText(protocol)})` : "";
				const targetPart = target ? `: ${normalizeHeadingText(target)}` : "";
				renderableLines.push(`- ${safeName}${protoPart}${targetPart}\n`);
			} else if (rawRef !== null) {
				// Unresolved ref (external, chained, or non-component intra-doc) —
				// surface the pointer verbatim so the broker target stays searchable.
				renderableLines.push(`- ${safeName}: ${normalizeHeadingText(rawRef)}\n`);
			}
		}
		if (renderableLines.length > 0) {
			emit("Servers:\n");
			for (const line of renderableLines) emit(line);
			if (omittedRenderable > 0) {
				emit(`- ... and ${omittedRenderable} more\n`);
			}
			emit("\n");
			anyProse = true;
		}
	}

	return anyProse;
}

function collectTagNames(top: Record<string, unknown>, tags: unknown): string[] {
	if (!Array.isArray(tags)) return [];
	const out: string[] = [];
	for (const t of tags) {
		const resolved = maybeDereference(top, t, "tags");
		if (resolved === null) continue;
		const name = stringField(resolved, "name");
		if (name) out.push(name);
	}
	return out;
}

/**
 * Compose an AsyncAPI 3 Server Object endpoint from `host + pathname`.
 * Pathname "MUST be in the form of a URI Path" per spec but may or may
 * not start with `/`; insert a separator when absent so the rendered
 * endpoint is unambiguous. `url` is NOT an AsyncAPI 3 server field
 * (removed from 2.x); `detectAsyncApi` gates synthesis on
 * `asyncapi: "3.*"` so reading it would surface a non-spec value.
 */
function composeServerTarget(host: string | null, pathname: string | null): string {
	if (host === null) return "";
	if (pathname === null) return host;
	return pathname.startsWith("/") ? `${host}${pathname}` : `${host}/${pathname}`;
}

function renderOperationProse(top: Record<string, unknown>, entry: OperationEntry, emit: (s: string) => void): void {
	const summary = stringField(entry.merged, "summary");
	if (summary) emit(`Summary: ${normalizeHeadingText(summary)}\n\n`);
	// `description` allows multi-paragraph markdown per spec; preserve raw.
	const description = stringField(entry.merged, "description");
	if (description) emit(`${description}\n\n`);

	emit(`Action: ${entry.action}\n\n`);

	if (entry.channelText !== null) emit(`Channel: ${normalizeHeadingText(entry.channelText)}\n\n`);

	if (entry.messageNames.length > 0) {
		emit("Messages:\n");
		for (const name of entry.messageNames) emit(`- ${normalizeHeadingText(name)}\n`);
		emit("\n");
	}

	const operationId = stringField(entry.merged, "operationId");
	if (operationId) emit(`Operation ID: ${normalizeHeadingText(operationId)}\n\n`);

	if (entry.replyRawRef !== null) {
		// External/unresolved reply ref renders the pointer verbatim so the
		// reply stays searchable, matching channel/messages ref handling.
		emit(`Reply: ${normalizeHeadingText(entry.replyRawRef)}\n\n`);
	} else if (hasReplyBullets(entry)) {
		emit("Reply:\n");
		if (entry.replyAddressText) emit(`- Address: ${normalizeHeadingText(entry.replyAddressText)}\n`);
		if (entry.replyChannelText !== null) emit(`- Channel: ${normalizeHeadingText(entry.replyChannelText)}\n`);
		for (const name of entry.replyMessageNames) emit(`- Message: ${normalizeHeadingText(name)}\n`);
		emit("\n");
	}

	const tagNames = collectTagNames(top, entry.merged.tags);
	if (tagNames.length > 0) {
		emit(`Tags: ${tagNames.map(normalizeHeadingText).join(", ")}\n\n`);
	}
}

interface FenceContent {
	body: string;
	language: "json" | "text";
}

/**
 * Compact-JSON serializer mirroring `openapi.ts:stringifyJsonForFence` —
 * 64 KiB cap + `json`→`text` language swap on truncation defends against
 * pathological payloads (a single op embedding MB of example data, a
 * `channels` subtree with thousands of messages). Errors surface as
 * `YAML_PARSE_ERROR` via `ParseError.yaml(...)`.
 */
function stringifyJsonForFence(value: unknown, label: string): FenceContent {
	try {
		const s = JSON.stringify(value);
		if (typeof s !== "string") return { body: "{}", language: "json" };
		if (s.length <= MAX_FENCE_JSON_BYTES) return { body: s, language: "json" };
		const elided = `${s.slice(0, MAX_FENCE_JSON_BYTES)}\n... (truncated; ${s.length - MAX_FENCE_JSON_BYTES} bytes elided)`;
		return { body: elided, language: "text" };
	} catch (cause) {
		throw ParseError.yaml("syntax", `AsyncAPI ${label} not JSON-serializable: ${errorMessage(cause)}`);
	}
}

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

function inferContentKinds(entry: OperationEntry): ContentKind[] {
	const kinds: ContentKind[] = ["code"];
	if (entry.messageNames.length > 0 || hasReplyBullets(entry)) {
		kinds.push("list");
	}
	return kinds;
}

function hasReplyBullets(entry: OperationEntry): boolean {
	return (
		entry.replyRawRef === null &&
		(entry.replyAddressText !== null || entry.replyChannelText !== null || entry.replyMessageNames.length > 0)
	);
}

function opNameToSlug(action: string, opName: string): string {
	const raw = `${action}-${opName}`.toLowerCase();
	const slug = raw.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
	return slug || "operation";
}

function computeLineRange(lineStarts: ReadonlyArray<number>, startOffset: number, endOffset: number): Range {
	return {
		start: offsetToLine(lineStarts, startOffset),
		end: offsetToLine(lineStarts, Math.max(endOffset - 1, startOffset)),
	};
}

function computeLineStarts(source: string): number[] {
	const starts: number[] = [0];
	for (let i = 0; i < source.length; i++) {
		if (source.charCodeAt(i) === 10) starts.push(i + 1);
	}
	return starts;
}

function offsetToLine(lineStarts: ReadonlyArray<number>, offset: number): number {
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

/** Like {@link stringField} but preserves `""` as a present value. Use for fields where the spec distinguishes empty from null/absent. */
function nullableString(obj: Record<string, unknown>, key: string): string | null {
	const v = obj[key];
	return typeof v === "string" ? v : null;
}
