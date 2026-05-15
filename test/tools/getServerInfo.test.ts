/**
 * `get_server_info` unit tests (D37).
 *
 * The handler is pure delegation to {@link buildServerInfo}; tests here
 * verify the SHAPE of the success envelope and the determinism of the
 * vault root_hash. Integration coverage (live MCP client) lives in
 * `getServerInfo.integration.test.ts`.
 */

import { describe, expect, test, vi } from "vitest";

import { hashVaultRoot } from "../../src/lib/serverInfo.js";
import { GetServerInfoSchema } from "../../src/schemas.js";
import { handleGetServerInfo, type ServerInfoContext } from "../../src/tools/getServerInfo.js";
import type { GetServerInfoResult, IndexStatusSnapshot, MetaEnvelope, VaultError } from "../../src/types.js";
import { stubIndex } from "../helpers/stubIndex.js";

const DEFAULT_CONTEXT: ServerInfoContext = {
	rootHash: "0123456789abcdef",
	includeHidden: false,
	startedAt: "2026-05-15T12:00:00.000Z",
	serverName: "markdown-mcp",
	serverVersion: "1.0.1",
	getMcpProtocolVersion: () => "2025-06-18",
};

function unwrap(envelope: Awaited<ReturnType<typeof handleGetServerInfo>>): GetServerInfoResult {
	if (envelope.isError) throw new Error("expected success envelope, got error");
	return envelope.structuredContent as GetServerInfoResult;
}

describe("get_server_info — success envelope shape", () => {
	test("returns server identity from context, root_hash flows through verbatim", async () => {
		const r = await handleGetServerInfo({}, DEFAULT_CONTEXT, undefined);
		const sc = unwrap(r);

		expect(sc.server).toEqual({
			name: "markdown-mcp",
			version: "1.0.1",
			mcp_protocol_version: "2025-06-18",
			started_at: "2026-05-15T12:00:00.000Z",
		});
		expect(sc.vault.include_hidden).toBe(false);
		expect(sc.vault.root_hash).toBe(DEFAULT_CONTEXT.rootHash);
		expect(sc.vault.extensions).toEqual(["md"]);
		// `case_insensitive_fs` default is true under the round-40 fallback
		// (test runner doesn't probe; safer default).
		expect(typeof sc.vault.case_insensitive_fs).toBe("boolean");
	});

	test("`index: null` when no IndexHandle is supplied (W1 stub path)", async () => {
		const r = await handleGetServerInfo({}, DEFAULT_CONTEXT, undefined);
		const sc = unwrap(r);
		expect(sc.index).toBeNull();
	});

	test("`index` populated from IndexHandle.getStatus + getEverComplete", async () => {
		const index = stubIndex("warm", 42, {
			getEverComplete: () => true,
		});
		const r = await handleGetServerInfo({}, DEFAULT_CONTEXT, index);
		const sc = unwrap(r);
		expect(sc.index).not.toBeNull();
		expect(sc.index?.state).toBe("warm");
		expect(sc.index?.files_indexed).toBe(42);
		expect(sc.index?.ever_complete).toBe(true);
		expect(sc.index?.schema_version).toBe(1);
		// stub's getStatus returns no degraded / last_scan_finished_at;
		// the builder must omit them rather than emit `undefined` keys.
		expect(sc.index?.last_scan_finished_at).toBeUndefined();
		expect(sc.index?.degraded).toBeUndefined();
	});

	test("`include_hidden: true` flows through context, capabilities list both tools and resources", async () => {
		const r = await handleGetServerInfo({}, { ...DEFAULT_CONTEXT, includeHidden: true }, undefined);
		const sc = unwrap(r);
		expect(sc.vault.include_hidden).toBe(true);
		expect(sc.capabilities.tools).toContain("get_server_info");
		expect(sc.capabilities.tools).toContain("search");
		expect(sc.capabilities.resources).toContain("note://");
	});

	test("`algorithms` reports all 5 algorithm IDs as fixed strings", async () => {
		const r = await handleGetServerInfo({}, DEFAULT_CONTEXT, undefined);
		const sc = unwrap(r);
		expect(sc.algorithms.tokenizer).toBe("heuristic/content-aware-v1");
		expect(sc.algorithms.query_algorithm).toBe("query-sanitize-v1");
		expect(sc.algorithms.snippet_algorithm_query).toBe("bm25-fragment-v1");
		expect(sc.algorithms.snippet_algorithm_filter).toBe("filter-preview-v1");
		expect(sc.algorithms.fuzzy_algorithm).toBe("stable-id-fuzzy-v1");
	});

	test("`_meta` envelope present and request_id is a UUID v4", async () => {
		const r = await handleGetServerInfo({}, DEFAULT_CONTEXT, undefined);
		const meta = r._meta as MetaEnvelope;
		expect(meta.request_id).toMatch(/^[0-9a-f-]{36}$/i);
		// Tool's _meta carries no tokenizer per Brief field-presence table —
		// the algorithms.tokenizer field inside `structuredContent` is the
		// authoritative source for this tool.
		expect(meta.tokenizer).toBeUndefined();
	});

	test("`mcp_protocol_version` reflects whatever `getMcpProtocolVersion` returns at call time (D38)", async () => {
		// Mutate `negotiated` between two calls and confirm the second call
		// observes the new value — proves the builder reads the getter on
		// every call rather than snapshotting at construction.
		let negotiated = "2025-06-18";
		const ctx: ServerInfoContext = { ...DEFAULT_CONTEXT, getMcpProtocolVersion: () => negotiated };
		const r1 = await handleGetServerInfo({}, ctx, undefined);
		expect(unwrap(r1).server.mcp_protocol_version).toBe("2025-06-18");
		negotiated = "2025-11-25";
		const r2 = await handleGetServerInfo({}, ctx, undefined);
		expect(unwrap(r2).server.mcp_protocol_version).toBe("2025-11-25");
	});
});

describe("GetServerInfoSchema — spec-compliant `arguments` omission", () => {
	// MCP spec: `tools/call.params.arguments` is optional. The SDK forwards
	// `request.params.arguments` to the schema as-is (no `?? {}` default),
	// so `undefined` reaches Zod when a client omits the field; `.optional()`
	// accepts that case without breaking the tool's "always succeeds" contract.
	test("accepts `undefined` (omitted arguments)", async () => {
		const r = await GetServerInfoSchema.safeParseAsync(undefined);
		expect(r.success).toBe(true);
	});
	test("accepts `{}` (explicit empty arguments)", async () => {
		const r = await GetServerInfoSchema.safeParseAsync({});
		expect(r.success).toBe(true);
	});
	test("rejects unknown keys (strictObject)", async () => {
		const r = await GetServerInfoSchema.safeParseAsync({ verbose: true });
		expect(r.success).toBe(false);
	});
});

describe("hashVaultRoot — determinism", () => {
	// `rootHash` is computed once at startup and passed via context; the
	// determinism guarantee lives on `hashVaultRoot` itself rather than on
	// the handler. Verify it here so a future change to the hash function
	// surfaces immediately.
	test("same input → same 16-hex output", () => {
		const h1 = hashVaultRoot("/vault/one");
		const h2 = hashVaultRoot("/vault/one");
		expect(h1).toBe(h2);
		expect(h1).toMatch(/^[0-9a-f]{16}$/);
	});

	test("different inputs → different outputs", () => {
		expect(hashVaultRoot("/vault/one")).not.toBe(hashVaultRoot("/vault/two"));
	});
});

describe("get_server_info — D40: single getStatusSnapshot per handler call", () => {
	test("handler issues exactly one getStatusSnapshot call (no torn read)", async () => {
		// Pre-D40 the handler called `newMetaForHandler(index) → index.getStatus()`
		// AND `buildServerInfo(...) → buildIndexIdentity(index) → index.getStatusSnapshot()`,
		// two separate reads. A same-policy peer's `markScanFinalized` between
		// the two reads could surface a self-contradictory response. D40 reads
		// the snapshot once and threads it through both surfaces.
		const snapshotSpy = vi.fn<() => IndexStatusSnapshot>(() => ({
			state: "warm",
			files_indexed: 7,
			last_scan_finished_at: "2026-05-15T11:00:00.000Z",
			ever_complete: true,
		}));
		const statusSpy = vi.fn(); // should NEVER be called after D40
		const everCompleteSpy = vi.fn(); // should NEVER be called after D40
		const index = stubIndex("warm", 7, {
			getStatusSnapshot: snapshotSpy,
			getStatus: statusSpy,
			getEverComplete: everCompleteSpy,
		});
		await handleGetServerInfo({}, DEFAULT_CONTEXT, index);
		expect(snapshotSpy).toHaveBeenCalledTimes(1);
		expect(statusSpy).not.toHaveBeenCalled();
		expect(everCompleteSpy).not.toHaveBeenCalled();
	});

	test("_meta.index_status matches structuredContent.index for the same snapshot", async () => {
		// Verifies the response is internally consistent under D40's
		// single-snapshot contract — _meta carries IndexStatus (no
		// ever_complete) while structuredContent.index includes ever_complete,
		// but the shared fields agree byte-for-byte.
		const index = stubIndex("warm", 12, {
			getStatusSnapshot: (): IndexStatusSnapshot => ({
				state: "warm",
				files_indexed: 12,
				last_scan_finished_at: "2026-05-15T10:30:00.000Z",
				ever_complete: true,
			}),
		});
		const r = await handleGetServerInfo({}, DEFAULT_CONTEXT, index);
		const meta = r._meta as MetaEnvelope;
		const sc = unwrap(r);
		expect(meta.index_status.state).toBe(sc.index?.state);
		expect(meta.index_status.files_indexed).toBe(sc.index?.files_indexed);
		expect(meta.index_status.last_scan_finished_at).toBe(sc.index?.last_scan_finished_at);
		// `ever_complete` is on structuredContent but NOT on _meta wire shape
		// (D39's contract; D40 preserves it via the `toIndexStatus` strip).
		expect(sc.index?.ever_complete).toBe(true);
		expect((meta.index_status as { ever_complete?: unknown }).ever_complete).toBeUndefined();
	});
});

describe("get_server_info — snapshot read fault tolerance", () => {
	test("getStatusSnapshot throws → structured INTERNAL_ERROR envelope, not transport failure", async () => {
		const index = stubIndex("warm", 0, {
			getStatusSnapshot: () => {
				throw new Error("SQLITE_IOERR: simulated DB read failure");
			},
		});
		const r = await handleGetServerInfo({}, DEFAULT_CONTEXT, index);
		expect(r.isError).toBe(true);
		const err = r.structuredContent as VaultError;
		expect(err.code).toBe("INTERNAL_ERROR");
		expect(err.message).toContain("get_server_info");
		expect(err.message).toContain("SQLITE_IOERR");
		// Catch path runs before the snapshot landed → meta is the fallback.
		const meta = r._meta as MetaEnvelope;
		expect(meta.request_id).toMatch(/^[0-9a-f-]{36}$/i);
		expect(meta.index_status.state).toBe("cold");
		expect(meta.index_status.files_indexed).toBe(0);
	});
});

describe("get_server_info — degraded / last_scan_finished_at propagation", () => {
	test("`last_scan_finished_at` propagates from getStatus when set", async () => {
		const index = stubIndex("warm", 10, {
			getStatus: () => ({
				state: "warm" as const,
				files_indexed: 10,
				last_scan_finished_at: "2026-05-15T11:59:00.000Z",
			}),
			getEverComplete: () => true,
		});
		const r = await handleGetServerInfo({}, DEFAULT_CONTEXT, index);
		expect(unwrap(r).index?.last_scan_finished_at).toBe("2026-05-15T11:59:00.000Z");
	});

	test("`degraded` propagates from getStatus when populated", async () => {
		const index = stubIndex("warm", 10, {
			getStatus: () => ({
				state: "warm" as const,
				files_indexed: 10,
				degraded: { failed_subtrees_present: true, pending_retries: 3 },
			}),
			getEverComplete: () => true,
		});
		const r = await handleGetServerInfo({}, DEFAULT_CONTEXT, index);
		expect(unwrap(r).index?.degraded).toEqual({
			failed_subtrees_present: true,
			pending_retries: 3,
		});
	});
});
