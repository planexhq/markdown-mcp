/**
 * Shared error router for the W2 tool handlers.
 *
 * Lives in `src/tools/` (not `src/lib/error.ts`) because:
 *   - PathValidationError is exported from validatePath.ts, which imports
 *     from error.ts; placing the router in error.ts would create a cycle.
 *   - FileTooLargeError lives in readNote.ts, ParseError in parser.ts —
 *     a tools-private helper is the right home for the cross-cut.
 */

import {
	errorMessage,
	fileTooLargeEnvelope,
	internalErrorEnvelope,
	markdownParseErrorEnvelope,
	newMeta,
	type ToolErrorEnvelope,
	toolErrorEnvelope,
} from "../lib/error.js";
import { ParseError } from "../lib/parser.js";
import { FileTooLargeError } from "../lib/readNote.js";
import { PathValidationError } from "../lib/validatePath.js";

/**
 * Route an unknown caught error to the appropriate `ToolErrorEnvelope`.
 * Order is precedence: path validation → size cap → parse → fallthrough.
 */
export function routeToolError(err: unknown, toolName: string): ToolErrorEnvelope {
	if (err instanceof PathValidationError) return toolErrorEnvelope(err.payload, newMeta());
	if (err instanceof FileTooLargeError) return fileTooLargeEnvelope("file", err.actualBytes);
	if (err instanceof ParseError) {
		const opts: Parameters<typeof markdownParseErrorEnvelope>[2] = { message: err.message };
		if (err.line !== undefined) opts.line = err.line;
		if (err.column !== undefined) opts.column = err.column;
		return markdownParseErrorEnvelope("file", err.reason, opts);
	}
	return internalErrorEnvelope(`${toolName}: ${errorMessage(err)}`);
}
