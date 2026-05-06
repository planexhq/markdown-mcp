/**
 * `get_metadata` — parsed YAML frontmatter as JSON for one file.
 *
 * Per Brief lines 301–310: nested objects preserved (not flattened).
 * Dataview inline fields are NOT merged in v1 (deferred to v1.1).
 *
 * `_meta` carries no `tokenizer` for this tool since the response has no
 * token fields (Brief line 970 / per-tool field-presence table).
 *
 * Date-string normalization is reserved for index time (W3) and applied
 * during indexing for the reserved `date` filter chain. `get_metadata`
 * returns the raw `YAML.parse` output; YAML 1.2 datetimes parse to JS
 * `Date` objects which serialize to ISO 8601 strings via JSON.stringify
 * on the wire.
 */

import { newMeta, successEnvelope, type ToolErrorEnvelope, type ToolSuccessEnvelope } from "../lib/error.js";
import { readNote } from "../lib/readNote.js";
import { type VaultRoot, validatePath } from "../lib/validatePath.js";
import type { GetMetadataInput, GetMetadataResult } from "../types.js";
import { routeToolError } from "./routeError.js";

export async function handleGetMetadata(
	input: GetMetadataInput,
	vaultRoot: VaultRoot,
): Promise<ToolSuccessEnvelope<GetMetadataResult> | ToolErrorEnvelope> {
	try {
		const safePath = await validatePath(input.file, vaultRoot);
		const { parsed } = await readNote(safePath, { frontmatterOnly: true });
		const result: GetMetadataResult = {
			metadata: parsed.frontmatter ?? {},
			has_frontmatter: parsed.hasFrontmatter,
		};
		return successEnvelope(result, newMeta());
	} catch (err) {
		return routeToolError(err, "get_metadata");
	}
}
