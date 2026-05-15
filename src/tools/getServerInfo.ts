/**
 * `get_server_info` (D37) — zero-input identity / health snapshot for
 * AI-agent self-verification. Always succeeds: identity must be queryable
 * the moment the server connects, so cold/warming states surface honestly
 * via `index.state` rather than being hidden behind `INDEX_WARMING`.
 *
 * D40 single-snapshot contract: one `index.getStatusSnapshot()` DB read
 * shared between `_meta.index_status` and `structuredContent.index` —
 * runs inside the guarded path because the read can throw under load or
 * during shutdown, with a fallback meta covering the catch.
 */

import {
	newMeta,
	newRequestId,
	successEnvelope,
	type ToolErrorEnvelope,
	type ToolSuccessEnvelope,
} from "../lib/error.js";
import type { IndexHandle } from "../lib/index/IndexHandle.js";
import { renderServerInfo } from "../lib/renderText/getServerInfo.js";
import { type BuildServerInfoArgs, buildServerInfo } from "../lib/serverInfo.js";
import type { GetServerInfoInput, GetServerInfoResult, IndexStatus, IndexStatusSnapshot } from "../types.js";
import { routeToolError } from "./routeError.js";

/**
 * Identity + protocol fields that are constant for the server's lifetime;
 * captured once at startup and threaded into every `get_server_info` call.
 * Derived from `BuildServerInfoArgs` minus `index` (per-call) and
 * `indexSnapshot` (per-call, shared with `_meta`) so the two stay in
 * sync — a new field on `BuildServerInfoArgs` surfaces here as a missing
 * property at compile time.
 */
export type ServerInfoContext = Omit<BuildServerInfoArgs, "index" | "indexSnapshot">;

export async function handleGetServerInfo(
	input: GetServerInfoInput,
	context: ServerInfoContext,
	index?: IndexHandle,
): Promise<ToolSuccessEnvelope<GetServerInfoResult> | ToolErrorEnvelope> {
	void input;
	// Fallback meta covers the catch path before the snapshot read lands;
	// `request_id` captured once so the success-path re-assignment reuses it.
	const request_id = newRequestId();
	let meta = newMeta({ request_id });
	try {
		const indexSnapshot = index?.getStatusSnapshot();
		if (indexSnapshot) {
			meta = newMeta({ request_id, index_status: toIndexStatus(indexSnapshot) });
		}
		// Spread `indexSnapshot` only when present so we don't hand
		// `buildServerInfo` an explicit `undefined` field
		// (`exactOptionalPropertyTypes` makes that a type error).
		const result = buildServerInfo({ ...context, index, ...(indexSnapshot && { indexSnapshot }) });
		return successEnvelope(result, meta, { renderText: renderServerInfo });
	} catch (err) {
		return routeToolError(err, "get_server_info", meta);
	}
}

/**
 * Strip `ever_complete` from the snapshot so the value fed to
 * `_meta.index_status` matches the `IndexStatus` wire shape exactly.
 * D39 deliberately kept `ever_complete` off the _meta envelope; this
 * helper makes the omission explicit and survives `JSON.stringify`.
 */
function toIndexStatus(snap: IndexStatusSnapshot): IndexStatus {
	const { ever_complete: _everComplete, ...status } = snap;
	return status;
}
