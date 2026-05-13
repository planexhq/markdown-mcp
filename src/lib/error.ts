/**
 * VaultError construction and tool-result envelope helpers.
 *
 * Implements the D13 hybrid error envelope:
 *   Domain errors → successful JSON-RPC result with `isError: true` and
 *   `structuredContent: VaultError`. JSON-RPC error codes (-32xxx) are
 *   reserved for transport-layer failures (malformed request, unknown
 *   method) handled by the SDK itself.
 *
 * Implements the D17 `_meta` envelope: every tool response carries
 * `request_id` (UUID v4) and `index_status` minimally; tools add
 * tokenizer / snippet_algorithm / query_algorithm / fuzzy_algorithm
 * per the Brief's per-tool field-presence table.
 */

import { randomUUID } from "node:crypto";
import type { ErrorCode, HeadingCandidate, IndexStatus, MetaEnvelope, VaultError } from "../types.js";
import { MAX_FILE_BYTES } from "./limits.js";
import type { ParseError } from "./parser.js";

/**
 * Generate a fresh server-side request ID. Always UUID v4 per D13.
 */
export function newRequestId(): string {
	return randomUUID();
}

/**
 * Extract a printable message from a caught value. `catch` binds to `unknown`
 * because anything can be thrown; this normalizes to a string for embedding
 * in `ParseError` / `vaultError` messages.
 */
export function errorMessage(cause: unknown): string {
	return cause instanceof Error ? cause.message : String(cause);
}

/**
 * Extract the `code` field from an errno-style error (Node fs, SQLite,
 * etc.). Returns the string code, or `undefined` for any other shape.
 */
export function getErrnoCode(err: unknown): string | undefined {
	if (typeof err !== "object" || err === null) return undefined;
	const code = (err as { code?: unknown }).code;
	return typeof code === "string" ? code : undefined;
}

/**
 * `true` iff the error is a `lstat`/`stat`/`open` errno indicating the
 * path genuinely vanished (ENOENT) or a path component is not a
 * directory (ENOTDIR). Other errno (EACCES, EMFILE, EIO, …) are
 * transient blips and must not be treated as vanish.
 */
export function isVanishedErrno(err: unknown): boolean {
	const code = getErrnoCode(err);
	return code === "ENOENT" || code === "ENOTDIR";
}

/**
 * Build a `VaultError` payload. The required fields are `code` and
 * `message`; everything else is optional and code-specific. `request_id`
 * is auto-generated if not supplied (callers usually pass the same ID
 * already on the `_meta` envelope to keep correlation tight).
 */
export function vaultError(
	code: ErrorCode,
	message: string,
	options: {
		suggestion?: string;
		param?: string;
		candidates?: VaultError["candidates"];
		retry_after_ms?: number;
		request_id?: string;
		[extra: string]: unknown;
	} = {},
): VaultError {
	const err: VaultError = {
		code,
		message,
		request_id: options.request_id ?? newRequestId(),
	};
	for (const [key, value] of Object.entries(options)) {
		if (key === "request_id") continue;
		if (value === undefined) continue;
		err[key] = value;
	}
	return err;
}

/**
 * Shape of a CallToolResult error envelope. The index signature matches
 * the SDK's `CallToolResult` type so values flow through `registerTool`
 * without an explicit cast.
 */
export interface ToolErrorEnvelope {
	[extra: string]: unknown;
	isError: true;
	content: Array<{ type: "text"; text: string }>;
	structuredContent: VaultError;
	_meta: MetaEnvelope;
}

/**
 * Default `index_status` for W1 stubs — the indexer state machine doesn't
 * exist until W2. Hardcoded to `cold` so `_meta` stays well-formed.
 */
const DEFAULT_INDEX_STATUS: IndexStatus = {
	state: "cold",
	files_indexed: 0,
};

/**
 * Optional fields a caller can override when building a `MetaEnvelope`.
 * Mirrors `MetaEnvelope` so adding a field there propagates here too.
 */
type MetaOverrides = Partial<MetaEnvelope>;

const OPTIONAL_META_FIELDS = [
	"tokenizer",
	"snippet_algorithm",
	"query_algorithm",
	"query_note",
	"fuzzy_algorithm",
] as const satisfies ReadonlyArray<keyof MetaEnvelope>;

/**
 * Build a fresh `_meta` envelope with a new request_id and the W1 default
 * index status. The `index_status` is spread from the default so callers
 * can mutate the returned object without affecting subsequent calls.
 */
export function newMeta(overrides: MetaOverrides = {}): MetaEnvelope {
	const meta: MetaEnvelope = {
		request_id: typeof overrides.request_id === "string" ? overrides.request_id : newRequestId(),
		index_status: overrides.index_status ?? { ...DEFAULT_INDEX_STATUS },
	};
	for (const key of OPTIONAL_META_FIELDS) {
		const value = overrides[key];
		if (typeof value === "string") meta[key] = value;
	}
	return meta;
}

/** Minimal interface that matches `IndexHandle.getStatus()`; lets tool
 * handlers depend on the meta-construction surface without importing
 * the full IndexHandle type. */
interface IndexStatusSource {
	getStatus(): IndexStatus;
}

/**
 * Like {@link newMeta} but resolves `index_status` from an optional
 * IndexHandle. Handlers that have an index pass it; W2-only paths
 * pass `undefined` and get the default cold/0 status.
 */
export function newMetaForHandler(index: IndexStatusSource | undefined, overrides: MetaOverrides = {}): MetaEnvelope {
	const status = index?.getStatus();
	return status ? newMeta({ ...overrides, index_status: status }) : newMeta(overrides);
}

/**
 * Wrap a `VaultError` in a CallToolResult envelope ready to return from
 * an MCP tool handler. The `_meta` envelope's `request_id` is forced to
 * match the error's `request_id` so log correlation is consistent.
 */
export function toolErrorEnvelope(err: VaultError, meta: MetaEnvelope): ToolErrorEnvelope {
	const text = err.suggestion ? `${err.message}\n${err.suggestion}` : err.message;
	return {
		isError: true,
		content: [{ type: "text", text }],
		structuredContent: err,
		_meta: { ...meta, request_id: err.request_id },
	};
}

/**
 * Convenience: build an INTERNAL_ERROR envelope. Callers with a pre-built
 * envelope (e.g., `routeToolError` after `handleSearch` has populated
 * `index_status` / `query_algorithm`) pass it as `meta` so the error
 * response carries the same observability fields the typed branches do.
 */
export function internalErrorEnvelope(
	message = "Tool not yet implemented (W1 stub).",
	meta: MetaEnvelope = newMeta(),
): ToolErrorEnvelope {
	const err = vaultError("INTERNAL_ERROR", message, {
		request_id: meta.request_id,
	});
	return toolErrorEnvelope(err, meta);
}

/**
 * Shared INDEX_WARMING envelope — vault-wide tools (`search`, `get_links`,
 * `get_vault_tree`) all return this shape when the persisted index is not
 * usable yet (cold/warming). The progress payload's `phase` is hardcoded
 * `"scanning"` because finer-grained phases (parsing / fts_populating) are
 * not currently surfaced by the scanner. `files_total_estimate` mirrors
 * `files_indexed` for the same reason.
 */
export function indexWarmingEnvelope(
	meta: MetaEnvelope,
	options: { filesIndexed: number; message: string; suggestion: string },
): ToolErrorEnvelope {
	const err = vaultError("INDEX_WARMING", options.message, {
		retry_after_ms: 1000,
		request_id: meta.request_id,
		progress: {
			files_indexed: options.filesIndexed,
			files_total_estimate: options.filesIndexed,
			phase: "scanning",
		},
		suggestion: options.suggestion,
	});
	return toolErrorEnvelope(err, meta);
}

// ─── W2 envelope builders ─────────────────────────────────────────────────

/** Additional content blocks the SDK accepts on a `CallToolResult`. */
export type ExtraContentBlock =
	| { type: "resource_link"; uri: string; name: string; mimeType?: string; description?: string }
	| { type: "image"; data: string; mimeType: string }
	| { type: "audio"; data: string; mimeType: string };

/**
 * Shape of a CallToolResult success envelope. Mirrors {@link ToolErrorEnvelope}
 * but with `isError: false` (or absent) so the SDK marks the result as
 * successful while still surfacing the typed `structuredContent` (D13
 * hybrid envelope).
 *
 * `structuredContent` is intersected with `Record<string, unknown>` so
 * the typed payload satisfies the SDK's loose-Record expectation without
 * each response interface needing an explicit `[k: string]: unknown`
 * index signature.
 */
export interface ToolSuccessEnvelope<T> {
	[extra: string]: unknown;
	content: Array<{ type: "text"; text: string } | ExtraContentBlock>;
	structuredContent: T & Record<string, unknown>;
	_meta: MetaEnvelope;
}

/**
 * Wrap a typed payload + meta envelope as a successful tool result.
 *
 * `content[0].text` carries an LLM-readable prose rendering of the
 * payload when `options.renderText` is supplied; without it, the legacy
 * `JSON.stringify` form is emitted as a safe fallback so any tool that
 * forgets to pass one stays well-formed. `structuredContent` is the
 * canonical machine-readable channel and is always populated verbatim
 * — clients with `structuredContent` support should prefer it; the
 * prose channel exists to cut tokens for LLM consumers (Claude Code,
 * Codex) that read `content[0].text` directly.
 *
 * `options.extraBlocks` are appended after the text block — used by
 * `get_vault_tree` to emit `resource_link` blocks for markdown items.
 */
export function successEnvelope<T extends object>(
	structuredContent: T,
	meta: MetaEnvelope,
	options?: {
		renderText?: (sc: T, meta: MetaEnvelope) => string;
		extraBlocks?: ReadonlyArray<ExtraContentBlock>;
	},
): ToolSuccessEnvelope<T> {
	const text = options?.renderText
		? options.renderText(structuredContent, meta)
		: JSON.stringify(structuredContent, null, 2);
	const content: ToolSuccessEnvelope<T>["content"] = [{ type: "text", text }, ...(options?.extraBlocks ?? [])];
	return {
		content,
		structuredContent: structuredContent as T & Record<string, unknown>,
		_meta: meta,
	};
}

/**
 * `FILE_TOO_LARGE` per Brief line 770. Carries `limit_bytes` /
 * `actual_bytes` in `structuredContent` so agents can decide whether to
 * skip vs split vs abort.
 */
export function fileTooLargeEnvelope(
	param: string,
	actualBytes: number,
	meta: MetaEnvelope = newMeta(),
): ToolErrorEnvelope {
	const err = vaultError("FILE_TOO_LARGE", `File exceeds ${MAX_FILE_BYTES}-byte read cap (actual: ${actualBytes}).`, {
		param,
		request_id: meta.request_id,
		limit_bytes: MAX_FILE_BYTES,
		actual_bytes: actualBytes,
		suggestion: "Split the file into smaller notes (each under 10 MB).",
	});
	return toolErrorEnvelope(err, meta);
}

/**
 * `MARKDOWN_PARSE_ERROR` payload from a `ParseError` instance — shared
 * between Tool surface (`routeError.ts`) and Resource surface
 * (`server.ts` `note://`) so both report identical `{reason, line?,
 * column?}` for the same parser failure. `messagePrefix` lets the
 * Resource side prepend `"note:// parse failed: "` to disambiguate.
 */
export function markdownParseErrorPayload(
	err: ParseError,
	param: string,
	options: { messagePrefix?: string; requestId?: string } = {},
): VaultError {
	const message = options.messagePrefix !== undefined ? `${options.messagePrefix}${err.message}` : err.message;
	return vaultError("MARKDOWN_PARSE_ERROR", message, {
		param,
		reason: err.reason,
		...(options.requestId !== undefined ? { request_id: options.requestId } : {}),
		...(err.line !== undefined ? { line: err.line } : {}),
		...(err.column !== undefined ? { column: err.column } : {}),
	});
}

export function markdownParseErrorEnvelope(
	err: ParseError,
	param: string,
	meta: MetaEnvelope = newMeta(),
): ToolErrorEnvelope {
	return toolErrorEnvelope(markdownParseErrorPayload(err, param, { requestId: meta.request_id }), meta);
}

/**
 * `HEADING_NOT_FOUND` flat payload: stale-recovery fields sit directly
 * on `VaultError`, NOT inside a nested `structured` sub-object.
 * `requested_stable_id` is present on a stale-stable_id miss;
 * `stable_id_status: "stale"` likewise.
 */
export function headingNotFoundEnvelope(
	options: {
		message?: string;
		param?: string;
		suggestion?: string;
		requested_stable_id?: string;
		stable_id_status?: "stale" | "missing";
		candidates?: HeadingCandidate[];
	},
	meta: MetaEnvelope = newMeta(),
): ToolErrorEnvelope {
	const candidates = options.candidates ?? [];
	const extras: Record<string, unknown> = {};
	if (options.requested_stable_id) extras.requested_stable_id = options.requested_stable_id;
	if (options.stable_id_status) extras.stable_id_status = options.stable_id_status;
	const errOptions: Parameters<typeof vaultError>[2] = {
		request_id: meta.request_id,
		candidates,
		...extras,
	};
	if (options.param !== undefined) errOptions.param = options.param;
	if (options.suggestion !== undefined) errOptions.suggestion = options.suggestion;
	const err = vaultError("HEADING_NOT_FOUND", options.message ?? "Heading not found.", errOptions);
	return toolErrorEnvelope(err, meta);
}

/**
 * `HEADING_AMBIGUOUS` — `heading_path` matched multiple headings; client
 * must pick one. `candidates` carries every matching heading's stable_id +
 * heading_path so the agent can disambiguate by structural slot.
 */
export function headingAmbiguousEnvelope(
	options: { candidates: HeadingCandidate[]; param?: string; suggestion?: string; message?: string },
	meta: MetaEnvelope = newMeta(),
): ToolErrorEnvelope {
	const errOptions: Parameters<typeof vaultError>[2] = {
		request_id: meta.request_id,
		candidates: options.candidates,
	};
	if (options.param !== undefined) errOptions.param = options.param;
	if (options.suggestion !== undefined) errOptions.suggestion = options.suggestion;
	const err = vaultError("HEADING_AMBIGUOUS", options.message ?? "Heading path matched multiple headings.", errOptions);
	return toolErrorEnvelope(err, meta);
}
