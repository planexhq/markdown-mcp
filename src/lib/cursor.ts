/**
 * Opaque pagination cursors. Wire format:
 * base64url(JSON.stringify({v, sort, request_hash, snapshot_mtime,
 * after_key})). `after_key` shape is discriminated by `sort`.
 *
 * Validation drift (D26): a `sort` / `request_hash` / `snapshot_mtime`
 * mismatch throws {@link CursorMismatchError}; the tool handler routes
 * it to the `CURSOR_INVALID` domain envelope (NOT JSON-RPC `-32602`).
 * Bad encoding throws {@link CursorDecodeError}, routed identically.
 *
 * `snapshot_mtime` is the IndexHandle's monotonic counter (NOT
 * `fs.mtime`) — second-resolution rounding can't produce false matches.
 *
 * `request_hash` is a per-tool opaque hash of the request-shaping
 * inputs that determine result identity. Each tool composes its own
 * inputs (see the tool's `computeRequestHash`), so reusing a cursor
 * across mutated inputs invalidates.
 */

import type { AnchorKind } from "../types.js";

const ANCHOR_KINDS = new Set<AnchorKind>(["heading", "preamble", "file"]);

export type CursorSort = "score-desc" | "filter-keyset-v1" | "links-keyset-v1" | "tree-dfs-v1";

export interface ScoreDescKey {
	score: number;
	file: string;
	heading_path: string[] | null;
	anchor_kind: AnchorKind;
	/** `fragments.id` — final tiebreaker for duplicate sibling headings
	 *  and BM25 score ties. Stable within a snapshot; cursor invalidates
	 *  on snapshot drift so cross-restart staleness isn't a concern. */
	id: number;
}

export interface FilterKeysetKey {
	file: string;
	heading_path: string[] | null;
	anchor_kind: AnchorKind;
	id: number;
}

/**
 * Placeholder typing for W4 cursor variants. Decoder accepts the sort
 * value; W3 search handler rejects them via sort-mismatch (it expects
 * `score-desc` or `filter-keyset-v1`).
 */
export interface LinksKeysetKey {
	source_file: string;
	source_heading_path: string[] | null;
	link_ordinal: number;
	/**
	 * Wikilinks row PK — final tiebreaker so duplicate-heading sections paginate
	 * without skipping. Optional on the wire; legacy clients omit it.
	 */
	id: number;
	phase?: "in" | "out";
}

export interface TreeDfsKey {
	dfs_rank: number;
}

export type CursorEnvelope =
	| {
			v: 1;
			sort: "score-desc";
			request_hash: string;
			snapshot_mtime: number;
			after_key: ScoreDescKey;
	  }
	| {
			v: 1;
			sort: "filter-keyset-v1";
			request_hash: string;
			snapshot_mtime: number;
			after_key: FilterKeysetKey;
	  }
	| {
			v: 1;
			sort: "links-keyset-v1";
			request_hash: string;
			snapshot_mtime: number;
			after_key: LinksKeysetKey;
	  }
	| {
			v: 1;
			sort: "tree-dfs-v1";
			request_hash: string;
			snapshot_mtime: number;
			after_key: TreeDfsKey;
	  };

export class CursorDecodeError extends Error {
	override readonly name = "CursorDecodeError";
	readonly reason: string;
	constructor(reason: string) {
		super(`Cursor decode failed: ${reason}`);
		this.reason = reason;
	}
}

export class CursorMismatchError extends Error {
	override readonly name = "CursorMismatchError";
	readonly reason: "sort" | "request_hash" | "snapshot_mtime";
	constructor(reason: "sort" | "request_hash" | "snapshot_mtime") {
		super(`Cursor ${reason} mismatch`);
		this.reason = reason;
	}
}

/**
 * Encode a cursor envelope. JSON-stringifies in declared key order then
 * base64url-encodes (RFC 4648 §5).
 */
export function encodeCursor(env: CursorEnvelope): string {
	const json = JSON.stringify(env);
	return Buffer.from(json, "utf8").toString("base64url");
}

/**
 * Decode + schema-validate a cursor string. Throws
 * {@link CursorDecodeError} on bad encoding or shape.
 */
export function decodeCursor(raw: string): CursorEnvelope {
	if (typeof raw !== "string" || raw.length === 0) {
		throw new CursorDecodeError("empty");
	}
	let json: string;
	try {
		json = Buffer.from(raw, "base64url").toString("utf8");
	} catch {
		throw new CursorDecodeError("invalid-base64");
	}
	if (json.length === 0) {
		throw new CursorDecodeError("empty-payload");
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(json);
	} catch {
		throw new CursorDecodeError("invalid-json");
	}
	return validateEnvelopeShape(parsed);
}

/**
 * Validate cursor against the current request context.
 *
 * `expectedSort` mismatch fires when a client sends a cursor minted by
 * a different code path (e.g., a query-mode cursor sent on a filter-only
 * request). `request_hash` / `snapshot_mtime` drift fires when the
 * underlying state changed between page calls — the cursor's positional
 * key no longer corresponds to the same logical row.
 */
export interface ValidateContext {
	expectedSort: CursorSort;
	currentRequestHash: string;
	currentSnapshotMtime: number;
}

export function validateCursor(env: CursorEnvelope, ctx: ValidateContext): void {
	if (env.sort !== ctx.expectedSort) throw new CursorMismatchError("sort");
	if (env.request_hash !== ctx.currentRequestHash) throw new CursorMismatchError("request_hash");
	if (env.snapshot_mtime !== ctx.currentSnapshotMtime) {
		throw new CursorMismatchError("snapshot_mtime");
	}
}

/**
 * Decode + validate the optional `cursor` arg every paginated handler
 * receives. Returns `undefined` when the input is empty/missing (first
 * page). On bad encoding or sort/hash/snapshot drift, throws — callers
 * route the throw through `routeToolError` to a `CURSOR_INVALID` domain
 * envelope (D26).
 */
export function decodeOptionalCursor(raw: string | undefined, ctx: ValidateContext): CursorEnvelope | undefined {
	if (raw === undefined || raw.length === 0) return undefined;
	const env = decodeCursor(raw);
	validateCursor(env, ctx);
	return env;
}

// ─── Schema validation ────────────────────────────────────────────────────

function validateEnvelopeShape(value: unknown): CursorEnvelope {
	if (!isObject(value)) throw new CursorDecodeError("not-object");
	if (value.v !== 1) throw new CursorDecodeError("unsupported-version");
	const sort = value.sort;
	if (typeof sort !== "string") throw new CursorDecodeError("missing-sort");
	const requestHash = value.request_hash;
	if (typeof requestHash !== "string") throw new CursorDecodeError("missing-request_hash");
	const snapshotMtime = value.snapshot_mtime;
	if (typeof snapshotMtime !== "number" || !Number.isFinite(snapshotMtime)) {
		throw new CursorDecodeError("missing-snapshot_mtime");
	}
	const afterKey = value.after_key;
	if (!isObject(afterKey)) throw new CursorDecodeError("missing-after_key");

	switch (sort) {
		case "score-desc": {
			const k = validateScoreDescKey(afterKey);
			return { v: 1, sort, request_hash: requestHash, snapshot_mtime: snapshotMtime, after_key: k };
		}
		case "filter-keyset-v1": {
			const k = validateFilterKeysetKey(afterKey);
			return { v: 1, sort, request_hash: requestHash, snapshot_mtime: snapshotMtime, after_key: k };
		}
		case "links-keyset-v1": {
			const k = validateLinksKeysetKey(afterKey);
			return { v: 1, sort, request_hash: requestHash, snapshot_mtime: snapshotMtime, after_key: k };
		}
		case "tree-dfs-v1": {
			const k = validateTreeDfsKey(afterKey);
			return { v: 1, sort, request_hash: requestHash, snapshot_mtime: snapshotMtime, after_key: k };
		}
		default:
			throw new CursorDecodeError("unknown-sort");
	}
}

function validateScoreDescKey(v: Record<string, unknown>): ScoreDescKey {
	const score = v.score;
	if (typeof score !== "number" || !Number.isFinite(score)) throw new CursorDecodeError("bad-score");
	const file = v.file;
	if (typeof file !== "string") throw new CursorDecodeError("bad-file");
	const headingPath = parseHeadingPath(v.heading_path);
	const anchorKind = parseAnchorKind(v.anchor_kind);
	const id = parseId(v.id);
	return { score, file, heading_path: headingPath, anchor_kind: anchorKind, id };
}

function validateFilterKeysetKey(v: Record<string, unknown>): FilterKeysetKey {
	const file = v.file;
	if (typeof file !== "string") throw new CursorDecodeError("bad-file");
	const headingPath = parseHeadingPath(v.heading_path);
	const anchorKind = parseAnchorKind(v.anchor_kind);
	const id = parseId(v.id);
	return { file, heading_path: headingPath, anchor_kind: anchorKind, id };
}

function parseId(value: unknown): number {
	if (typeof value !== "number" || !Number.isInteger(value)) throw new CursorDecodeError("bad-id");
	return value;
}

function parseOptionalId(value: unknown, fallback: number): number {
	if (value === undefined) return fallback;
	return parseId(value);
}

function validateLinksKeysetKey(v: Record<string, unknown>): LinksKeysetKey {
	const file = v.source_file;
	if (typeof file !== "string") throw new CursorDecodeError("bad-source_file");
	const ord = v.link_ordinal;
	if (typeof ord !== "number" || !Number.isInteger(ord)) throw new CursorDecodeError("bad-link_ordinal");
	const headingPath = parseHeadingPath(v.source_heading_path);
	// Optional on the wire; legacy clients omit `id`. Wikilinks rowids are
	// positive auto-increments so `id > 0` matches every row.
	const id = parseOptionalId(v.id, 0);
	const out: LinksKeysetKey = { source_file: file, source_heading_path: headingPath, link_ordinal: ord, id };
	const phase = v.phase;
	if (phase === "in" || phase === "out") out.phase = phase;
	return out;
}

function validateTreeDfsKey(v: Record<string, unknown>): TreeDfsKey {
	const rank = v.dfs_rank;
	if (typeof rank !== "number" || !Number.isInteger(rank)) throw new CursorDecodeError("bad-dfs_rank");
	return { dfs_rank: rank };
}

function parseHeadingPath(value: unknown): string[] | null {
	if (value === null) return null;
	if (Array.isArray(value) && value.every((v) => typeof v === "string")) {
		return value as string[];
	}
	throw new CursorDecodeError("bad-heading_path");
}

function parseAnchorKind(value: unknown): AnchorKind {
	if (typeof value === "string" && ANCHOR_KINDS.has(value as AnchorKind)) {
		return value as AnchorKind;
	}
	throw new CursorDecodeError("bad-anchor_kind");
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Parse a JSON-encoded heading_path stored in `fragments.heading_path_json`.
 * Used by both cursor encoding (after_key.heading_path) and search row →
 * SearchResult mapping. Returns `null` for null input or any malformed
 * payload — never throws, since heading_path is optional everywhere.
 */
export function parseHeadingPathJson(json: string | null): string[] | null {
	if (json === null) return null;
	try {
		const parsed = JSON.parse(json);
		if (Array.isArray(parsed) && parsed.every((v: unknown) => typeof v === "string")) {
			return parsed as string[];
		}
	} catch {
		// Malformed JSON — fall through.
	}
	return null;
}
