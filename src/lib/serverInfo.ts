/**
 * Pure builder for `get_server_info` (D37). Snapshots server identity,
 * vault config, index state, algorithm IDs, and tool/resource capabilities
 * into a single structured payload an AI agent can self-verify against.
 *
 * Identity-only: no FS reads, no DB writes. Safe to call from any state
 * (cold/warming/warm/reconciling) — when `index === undefined` (W1 stub
 * path) the `index` field is `null` rather than throwing.
 *
 * `vault.root_hash` is a 16-hex sha256 truncation of `vaultRoot.absolute`
 * (post-realpath). Deliberately NOT the absolute path — keeps the
 * filesystem layout out of agent context while still letting agents
 * detect "different vault" mid-session.
 */

import { createHash } from "node:crypto";
import type { GetServerInfoResult, IndexIdentity, IndexStatusSnapshot } from "../types.js";
import { FUZZY_ALGORITHM_ID } from "./fuzzy.js";
import { isFsCaseInsensitiveResolved } from "./hiddenPath.js";
import type { IndexHandle } from "./index/IndexHandle.js";
import { SCHEMA_VERSION } from "./index/sqlite.js";
import { isProseOnly } from "./proseOnly.js";
import { QUERY_ALGORITHM_ID } from "./search/sanitize.js";
import { BM25_SNIPPET_ALGORITHM_ID, FILTER_PREVIEW_ALGORITHM_ID } from "./search/snippet.js";
import { getTokenizerId } from "./tokenizer.js";
import { getSortedVaultExtensions } from "./vaultExtensions.js";

/**
 * Tool names the server registers. Single source of truth for the
 * `capabilities.tools` field. MUST stay in sync with the
 * `server.registerTool(...)` calls in `src/server.ts`; the
 * `tools/list` integration test (`test/server.test.ts`) compares
 * against this list and fails loudly on drift.
 */
export const TOOL_NAMES = [
	"get_vault_tree",
	"get_file_outline",
	"get_fragment",
	"search",
	"get_metadata",
	"get_links",
	"get_server_info",
] as const;

/** URI scheme strings for `capabilities.resources`. */
export const RESOURCE_SCHEMES = ["note://"] as const;

export interface BuildServerInfoArgs {
	/** Precomputed at startup via {@link hashVaultRoot} — constant for
	 * process lifetime. */
	rootHash: string;
	index: IndexHandle | undefined;
	/**
	 * Optional pre-built snapshot (D40). When provided, {@link buildIndexIdentity}
	 * uses it instead of issuing its own `getStatusSnapshot()` call. The
	 * `get_server_info` handler captures one snapshot at entry and threads
	 * it through both this builder AND the `_meta` envelope so a same-policy
	 * peer's `markScanFinalized` between the handler's two reads cannot
	 * surface a self-contradictory response. D39 closed the torn read
	 * INSIDE `buildIndexIdentity`; D40 closes it across the handler.
	 */
	indexSnapshot?: IndexStatusSnapshot;
	includeHidden: boolean;
	startedAt: string;
	serverName: string;
	serverVersion: string;
	/**
	 * Getter (not snapshot) so the value reflects the version actually
	 * negotiated at the initialize handshake — `setRequestHandler` runs
	 * after `createServer` returns, so a string captured at registration
	 * time would always report `LATEST_PROTOCOL_VERSION` even when a
	 * client downgraded to an older supported version.
	 */
	getMcpProtocolVersion: () => string;
}

export function buildServerInfo(args: BuildServerInfoArgs): GetServerInfoResult {
	return {
		server: {
			name: args.serverName,
			version: args.serverVersion,
			mcp_protocol_version: args.getMcpProtocolVersion(),
			started_at: args.startedAt,
			// Reads the module global directly — single source of truth
			// with `successEnvelope`/`toolErrorEnvelope`'s suppression
			// path. Same precedent as `case_insensitive_fs` below.
			prose_only: isProseOnly(),
		},
		vault: {
			root_hash: args.rootHash,
			include_hidden: args.includeHidden,
			// Sort so two agents comparing snapshots of the same vault see
			// byte-identical `extensions` arrays — Set iteration order is
			// insertion-order, which depends on the env-var parse path.
			// Copy because the wire type is mutable `string[]`; the cached
			// readonly array stays shared with the lockfile + startup callers.
			extensions: [...getSortedVaultExtensions()],
			case_insensitive_fs: isFsCaseInsensitiveResolved(),
		},
		index: args.index ? buildIndexIdentity(args.index, args.indexSnapshot) : null,
		algorithms: {
			tokenizer: getTokenizerId(),
			query_algorithm: QUERY_ALGORITHM_ID,
			snippet_algorithm_query: BM25_SNIPPET_ALGORITHM_ID,
			snippet_algorithm_filter: FILTER_PREVIEW_ALGORITHM_ID,
			fuzzy_algorithm: FUZZY_ALGORITHM_ID,
		},
		capabilities: {
			tools: [...TOOL_NAMES],
			resources: [...RESOURCE_SCHEMES],
		},
	};
}

function buildIndexIdentity(index: IndexHandle, snapshot?: IndexStatusSnapshot): IndexIdentity {
	const snap = snapshot ?? index.getStatusSnapshot();
	const identity: IndexIdentity = {
		schema_version: SCHEMA_VERSION,
		state: snap.state,
		files_indexed: snap.files_indexed,
		ever_complete: snap.ever_complete,
	};
	if (snap.last_scan_finished_at !== undefined) identity.last_scan_finished_at = snap.last_scan_finished_at;
	if (snap.degraded !== undefined) identity.degraded = snap.degraded;
	return identity;
}

/**
 * 16-hex sha256 truncation of the realpath-resolved vault root. 64 bits
 * is collision-safe for vault-identity discrimination (~10⁹ vaults at
 * <0.01% collision probability) — `stable_id`'s 14-hex form is tuned for
 * a much larger heading-row population.
 *
 * Exported so `src/server.ts` can compute the hash once at startup
 * (vault root is constant for process lifetime) and pass it via the
 * builder context — avoids re-hashing on every `get_server_info` call.
 */
export function hashVaultRoot(absolute: string): string {
	return createHash("sha256").update(absolute).digest("hex").slice(0, 16);
}
