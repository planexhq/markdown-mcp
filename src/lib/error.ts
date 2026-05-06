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
import type { ErrorCode, IndexStatus, MetaEnvelope, VaultError } from "../types.js";

/**
 * Generate a fresh server-side request ID. Always UUID v4 per D13.
 */
export function newRequestId(): string {
	return randomUUID();
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
 * Convenience: build an INTERNAL_ERROR envelope. Used by W1 tool stubs
 * where the implementation is not yet wired up.
 */
export function internalErrorEnvelope(message = "Tool not yet implemented (W1 stub)."): ToolErrorEnvelope {
	const meta = newMeta();
	const err = vaultError("INTERNAL_ERROR", message, {
		request_id: meta.request_id,
	});
	return toolErrorEnvelope(err, meta);
}
