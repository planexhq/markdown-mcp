/**
 * Shared error router for all tool handlers.
 *
 * Lives in `src/tools/` (not `src/lib/error.ts`) because:
 *   - PathValidationError is exported from validatePath.ts, which imports
 *     from error.ts; placing the router in error.ts would create a cycle.
 *   - FileTooLargeError lives in readNote.ts, ParseError in parser.ts —
 *     a tools-private helper is the right home for the cross-cut.
 */

import { CursorDecodeError, CursorMismatchError } from "../lib/cursor.js";
import {
	errorMessage,
	fileTooLargeEnvelope,
	internalErrorEnvelope,
	newMeta,
	parseErrorEnvelope,
	type ToolErrorEnvelope,
	toolErrorEnvelope,
	vaultError,
} from "../lib/error.js";
import { FilterSyntaxError } from "../lib/filter.js";
import { ParseError } from "../lib/parser.js";
import { FileTooLargeError } from "../lib/readNote.js";
import { PathValidationError } from "../lib/validatePath.js";
import type { MetaEnvelope } from "../types.js";

/**
 * Route an unknown caught error to the appropriate `ToolErrorEnvelope`.
 * Order is precedence: path validation → size cap → parse → cursor /
 * filter → fallthrough.
 *
 * `meta` lets callers pass a pre-built envelope so late-throw errors don't
 * regress `index_status` to the cold default or drop tool-specific fields
 * like `query_algorithm`. Callers that don't have meta yet pass nothing
 * and get a fresh `newMeta()`.
 */
export function routeToolError(err: unknown, toolName: string, meta?: MetaEnvelope): ToolErrorEnvelope {
	const baseMeta = meta ?? newMeta();
	if (err instanceof PathValidationError) return toolErrorEnvelope(err.payload, baseMeta);
	if (err instanceof FileTooLargeError) return fileTooLargeEnvelope("file", err.actualBytes, baseMeta);
	if (err instanceof ParseError) return parseErrorEnvelope(err, "file", baseMeta);
	if (err instanceof FilterSyntaxError) {
		const payload = vaultError("FILTER_SYNTAX_ERROR", err.message, {
			param: err.param,
			expected: err.expected,
			suggest: err.suggest,
			request_id: baseMeta.request_id,
		});
		return toolErrorEnvelope(payload, baseMeta);
	}
	if (err instanceof CursorDecodeError || err instanceof CursorMismatchError) {
		const payload = vaultError("CURSOR_INVALID", `Cursor invalid: ${err.reason}`, {
			param: "cursor",
			reason: err.reason,
			request_id: baseMeta.request_id,
			suggestion: "Restart pagination with cursor=null.",
		});
		return toolErrorEnvelope(payload, baseMeta);
	}
	return internalErrorEnvelope(`${toolName}: ${errorMessage(err)}`, baseMeta);
}
