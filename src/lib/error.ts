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
import type { ParseErrorReason } from "./parser.js";

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

// ─── W2 envelope builders ─────────────────────────────────────────────────

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
	content: Array<{ type: "text"; text: string }>;
	structuredContent: T & Record<string, unknown>;
	_meta: MetaEnvelope;
}

/**
 * Wrap a typed payload + meta envelope as a successful tool result. The
 * `content[0].text` mirrors `structuredContent` as JSON for clients that
 * don't read structured content.
 */
export function successEnvelope<T extends object>(structuredContent: T, meta: MetaEnvelope): ToolSuccessEnvelope<T> {
	return {
		content: [{ type: "text", text: JSON.stringify(structuredContent, null, 2) }],
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
 * `MARKDOWN_PARSE_ERROR` with reason routing per CLAUDE.md hard-cap rules.
 */
export function markdownParseErrorEnvelope(
	param: string,
	reason: ParseErrorReason,
	options: { message?: string; line?: number; column?: number } = {},
	meta: MetaEnvelope = newMeta(),
): ToolErrorEnvelope {
	const message = options.message ?? defaultParseMessage(reason);
	const extras: Record<string, unknown> = { reason };
	if (options.line !== undefined) extras.line = options.line;
	if (options.column !== undefined) extras.column = options.column;
	const err = vaultError("MARKDOWN_PARSE_ERROR", message, {
		param,
		request_id: meta.request_id,
		...extras,
	});
	return toolErrorEnvelope(err, meta);
}

function defaultParseMessage(reason: ParseErrorReason): string {
	switch (reason) {
		case "syntax":
			return "Markdown parse failed (syntax).";
		case "ast_node_cap_exceeded":
			return "Markdown parse failed (AST node cap exceeded).";
		case "encoding_failed":
			return "Markdown parse failed (file is not valid UTF-8).";
	}
}

/**
 * `HEADING_NOT_FOUND` flat payload per round 8 (CLAUDE.md): stale-recovery
 * fields sit directly on `VaultError`, NOT inside a nested `structured`
 * sub-object. `requested_stable_id` is present on a stale-stable_id miss;
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
