/**
 * `get_server_info` integration smoke (D37). Exercises the live MCP
 * stdio path — `tools/list` includes the new tool, `tools/call` returns
 * a structured payload whose fields match the live server state.
 */

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { PACKAGE_VERSION } from "../../src/lib/version.js";
import type { GetServerInfoResult } from "../../src/types.js";
import { spawnTestServer, type TestClient, waitForWarm } from "../helpers/mcp-client.js";
import { createTempVault } from "../helpers/vault.js";

let vault: { path: string; cleanup: () => Promise<void> };
let conn: TestClient;

beforeAll(async () => {
	vault = await createTempVault({
		"a.md": "# A\n",
		"b.md": "# B\n",
	});
	conn = await spawnTestServer(vault.path);
	await waitForWarm(conn.client);
}, 30_000);

afterAll(async () => {
	await conn.close();
	await vault.cleanup();
});

describe("get_server_info — live MCP surface", () => {
	test("`tools/list` includes get_server_info with the documented description", async () => {
		const r = await conn.client.listTools();
		const names = r.tools.map((t) => t.name);
		expect(names).toContain("get_server_info");
		const tool = r.tools.find((t) => t.name === "get_server_info");
		expect(tool?.description).toMatch(/identity/i);
	});

	test("`tools/call` returns the documented top-level groups", async () => {
		const r = await conn.client.callTool({ name: "get_server_info", arguments: {} });
		expect(r.isError).toBeFalsy();
		const sc = r.structuredContent as GetServerInfoResult;
		expect(sc.server.name).toBe("markdown-mcp");
		expect(sc.server.version).toMatch(/^\d+\.\d+\.\d+/);
		expect(sc.server.mcp_protocol_version).toMatch(/^\d{4}-\d{2}-\d{2}$/);
		expect(sc.server.started_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
		expect(sc.vault.root_hash).toMatch(/^[0-9a-f]{16}$/);
		expect(sc.vault.include_hidden).toBe(false);
		expect(sc.vault.extensions).toContain("md");
		expect(sc.index).not.toBeNull();
		expect(sc.index?.schema_version).toBe(1);
		// Warm-test fixture should have files_indexed = 2 after waitForWarm.
		expect(sc.index?.files_indexed).toBe(2);
		expect(sc.index?.ever_complete).toBe(true);
		// Last-scan timestamp populated after the initial cold→warm finalize.
		expect(sc.index?.last_scan_finished_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
		// No degradation expected on the clean fixture.
		expect(sc.index?.degraded).toBeUndefined();
		expect(sc.algorithms.tokenizer).toBe("heuristic/content-aware-v1");
		expect(sc.capabilities.tools).toContain("get_server_info");
		expect(sc.capabilities.resources).toContain("note://");
	});

	test("omitted `arguments` is accepted (zero-input tool contract)", async () => {
		// MCP `tools/call.arguments` is optional. The SDK forwards
		// `undefined` to the schema when the client omits it, so the
		// schema is `strictObject({}).optional()` rather than the bare
		// `strictObject({})` that would reject with -32602.
		const r = await conn.client.callTool({ name: "get_server_info" });
		expect(r.isError).toBeFalsy();
		const sc = r.structuredContent as GetServerInfoResult;
		expect(sc.server.name).toBe("markdown-mcp");
	});

	test("schema rejects extra keys (strictObject)", async () => {
		// Sending an extra top-level key surfaces as the SDK's input-validation
		// error envelope (`isError: true` + MCP error -32602 in content). The
		// strictObject schema fires BEFORE the handler — the catch isn't from
		// `routeToolError`, it's from the SDK's schema gate. Asserting the
		// resulting envelope is sufficient: both shapes signal "rejected by
		// strict-object validation."
		const r = await conn.client.callTool({
			name: "get_server_info",
			// @ts-expect-error: deliberate extra key for strictObject coverage
			arguments: { verbose: true },
		});
		expect(r.isError).toBe(true);
		const content = r.content as Array<{ type: string; text?: string }>;
		const text = content.find((b) => b.type === "text")?.text ?? "";
		expect(text).toMatch(/unrecognized_keys|verbose/i);
	});

	test("`_meta.request_id` is a UUID, `_meta.index_status.state` is warm post-warmup", async () => {
		const r = await conn.client.callTool({ name: "get_server_info", arguments: {} });
		expect(r.isError).toBeFalsy();
		const meta = r._meta as { request_id?: string; index_status?: { state?: string; files_indexed?: number } };
		expect(meta.request_id).toMatch(/^[0-9a-f-]{36}$/i);
		expect(meta.index_status?.state).toBe("warm");
		expect(meta.index_status?.files_indexed).toBe(2);
	});
});

describe("get_server_info — server.version source (D39)", () => {
	let envVault: { path: string; cleanup: () => Promise<void> };
	let envConn: TestClient;

	beforeAll(async () => {
		envVault = await createTempVault({ "a.md": "# A\n" });
		// Inject a bogus `npm_package_version` to prove the spawned server
		// IGNORES it. Pre-D39 the server read `process.env.npm_package_version`
		// directly, so this value would have flowed through to `server.version`.
		envConn = await spawnTestServer(envVault.path, { npm_package_version: "9.9.9-fake" });
	}, 30_000);

	afterAll(async () => {
		await envConn.close();
		await envVault.cleanup();
	});

	test("ignores `npm_package_version`; reports this package's version", async () => {
		const r = await envConn.client.callTool({ name: "get_server_info", arguments: {} });
		expect(r.isError).toBeFalsy();
		const sc = r.structuredContent as GetServerInfoResult;
		expect(sc.server.version).toBe(PACKAGE_VERSION);
		expect(sc.server.version).not.toBe("9.9.9-fake");
	});
});
