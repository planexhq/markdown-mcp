/**
 * `get_file_outline` — heading tree + block-ID index for a single file.
 *
 * Per Brief lines 62–91: not paginated, returns full outline regardless
 * of node count. The `_meta.tokenizer` field carries the active tokenizer
 * id since outline nodes expose `bodyTokensApprox` / `descendantTokensApprox`.
 *
 * Hard-cap routing per CLAUDE.md:
 *   - PathValidationError → PATH_OUTSIDE_VAULT / PATH_NOT_FOUND envelope
 *   - FileTooLargeError   → FILE_TOO_LARGE envelope
 *   - ParseError(reason)  → MARKDOWN_PARSE_ERROR envelope (reason routed)
 *   - Anything else       → INTERNAL_ERROR (true bug, not a domain error)
 */

import { newMetaForHandler, successEnvelope, type ToolErrorEnvelope, type ToolSuccessEnvelope } from "../lib/error.js";
import type { IndexHandle } from "../lib/index/IndexHandle.js";
import { readNote } from "../lib/readNote.js";
import { getTokenizerId } from "../lib/tokenizer.js";
import { type VaultRoot, validatePath } from "../lib/validatePath.js";
import type { GetFileOutlineInput, GetFileOutlineResult } from "../types.js";
import { routeToolError } from "./routeError.js";

export async function handleGetFileOutline(
	input: GetFileOutlineInput,
	vaultRoot: VaultRoot,
	index?: IndexHandle,
	includeHidden = false,
): Promise<ToolSuccessEnvelope<GetFileOutlineResult> | ToolErrorEnvelope> {
	// Hoisted before try so the catch can pass meta to routeToolError —
	// preserves `index_status` and `tokenizer` on error envelopes.
	const meta = newMetaForHandler(index, { tokenizer: getTokenizerId() });
	try {
		const safePath = await validatePath(input.file, vaultRoot);
		const { parsed } = await readNote(safePath, {}, includeHidden);
		const result: GetFileOutlineResult = {
			outline: parsed.outline,
			blockIndex: parsed.blockIndex,
		};
		return successEnvelope(result, meta);
	} catch (err) {
		return routeToolError(err, "get_file_outline", meta);
	}
}
