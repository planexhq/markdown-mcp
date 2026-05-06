/**
 * MCP integration tests for the W1 stub server.
 *
 * Spawns the built server (`dist/index.js`) and exercises the MCP
 * protocol: Initialize handshake, tools/list, tools/call (each tool),
 * resources/list, resources/read.
 *
 * W1 exit-criteria coverage:
 *   - 6 tools registered, schemas non-empty
 *   - Each tool returns INTERNAL_ERROR envelope (D13) with valid UUIDv4
 *     request_id and `_meta` envelope
 *   - request_id is unique per call
 *   - Path-validating tools surface PATH_OUTSIDE_VAULT for traversal
 *     inputs (validatePath wired even in stubs)
 *   - note:// resource read maps to a JSON-RPC error with our domain
 *     code in `data` (W5 will turn this into a real read)
 */

import { spawn } from "node:child_process";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { MAX_PATH_LENGTH, MIN_PROTOCOL_VERSION } from "../src/lib/limits.js";
import type { ErrorCode, MetaEnvelope, PathRejectionReason, VaultError } from "../src/types.js";
import type { TestClient } from "./helpers/mcp-client.js";
import { SERVER_BIN, spawnTestServer } from "./helpers/mcp-client.js";
import { createTempVault, DEFAULT_VAULT_STRUCTURE, UUID_V4 } from "./helpers/vault.js";

const TOOL_NAMES = [
	"get_vault_tree",
	"get_file_outline",
	"get_fragment",
	"search",
	"get_metadata",
	"get_links",
] as const;

let vault: { path: string; cleanup: () => Promise<void> };
let connection: TestClient;

beforeAll(async () => {
	vault = await createTempVault(DEFAULT_VAULT_STRUCTURE);
	connection = await spawnTestServer(vault.path);
});

afterAll(async () => {
	await connection.close();
	await vault.cleanup();
});

describe("Initialize handshake — D22 minimum protocol version", () => {
	test("rejects pre-2025-06-18 clients with InvalidRequest", async () => {
		// SDK Client always sends LATEST, so we hand-roll the JSON-RPC
		// frame to simulate an older host. Spawn fresh; killed in finally.
		const child = spawn(process.execPath, [SERVER_BIN, "--vault", vault.path], {
			stdio: ["pipe", "pipe", "inherit"],
		});
		try {
			const initialize = `${JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "initialize",
				params: {
					protocolVersion: "2024-11-05",
					capabilities: {},
					clientInfo: { name: "old-client", version: "0.0.0" },
				},
			})}\n`;
			child.stdin.write(initialize);
			const responseLine = await new Promise<string>((resolve, reject) => {
				child.stdout.once("data", (chunk: Buffer) => resolve(chunk.toString().split("\n")[0] ?? ""));
				child.once("error", reject);
				child.once("exit", (code) => reject(new Error(`server exited prematurely with code ${code}`)));
			});
			const response = JSON.parse(responseLine);
			expect(response.error?.code).toBe(-32600);
			expect(response.error?.message).toContain(MIN_PROTOCOL_VERSION);
		} finally {
			child.kill();
		}
	});
});

describe("Initialize handshake", () => {
	test("server reports name + version", () => {
		const info = connection.client.getServerVersion();
		expect(info?.name).toBe("vault-mcp");
		expect(info?.version).toBe("1.0.0-w1");
	});

	test("server advertises tools + resources capabilities", () => {
		const caps = connection.client.getServerCapabilities();
		expect(caps?.tools).toBeDefined();
		expect(caps?.resources).toBeDefined();
	});
});

describe("tools/list", () => {
	test("returns all 6 tools with non-empty input schemas", async () => {
		const result = await connection.client.listTools();
		const names = result.tools.map((t) => t.name).sort();
		expect(names).toEqual([...TOOL_NAMES].sort());
		for (const tool of result.tools) {
			expect(tool.description).toBeTruthy();
			expect(tool.inputSchema).toBeDefined();
			expect(tool.inputSchema.type).toBe("object");
		}
	});

	test("get_fragment schema declares discriminated anchor union", async () => {
		const result = await connection.client.listTools();
		const fragment = result.tools.find((t) => t.name === "get_fragment");
		expect(fragment).toBeDefined();
		// Check that the input schema mentions `anchor` and the discriminator
		// at least at the JSON-Schema level — exact shape depends on
		// zod-to-json-schema, so we keep the assertion shallow.
		const json = JSON.stringify(fragment?.inputSchema ?? {});
		expect(json).toContain("anchor");
		expect(json).toContain("heading_path");
		expect(json).toContain("block");
	});
});

describe("tools/call — INTERNAL_ERROR envelope", () => {
	for (const name of TOOL_NAMES) {
		test(`${name} returns isError + structuredContent + _meta`, async () => {
			const args = stubArgsFor(name);
			const result = await connection.client.callTool({ name, arguments: args });
			expect(result.isError).toBe(true);
			expect(Array.isArray(result.content)).toBe(true);
			const structured = result.structuredContent as VaultError;
			expect(structured.code).toBe("INTERNAL_ERROR");
			expect(structured.request_id).toMatch(UUID_V4);

			const meta = result._meta as MetaEnvelope | undefined;
			expect(meta).toBeDefined();
			expect(meta?.request_id).toBe(structured.request_id);
			expect(meta?.index_status?.state).toBe("cold");
		});
	}

	test("two consecutive calls have different request_ids", async () => {
		const a = await connection.client.callTool({ name: "get_metadata", arguments: { file: "foo.md" } });
		const b = await connection.client.callTool({ name: "get_metadata", arguments: { file: "foo.md" } });
		const idA = (a.structuredContent as VaultError).request_id;
		const idB = (b.structuredContent as VaultError).request_id;
		expect(idA).toBeTruthy();
		expect(idB).toBeTruthy();
		expect(idA).not.toBe(idB);
	});
});

describe("tools/call — path validation wired in W1 stubs (D8 + D16)", () => {
	test("get_fragment with traversal path returns PATH_OUTSIDE_VAULT", async () => {
		const err = await callToolForError("get_fragment", { file: "../../etc/passwd", anchor: { kind: "file" } });
		expectVaultError(err, "PATH_OUTSIDE_VAULT", "TRAVERSAL_SEGMENT");
	});

	test("get_metadata with absolute path returns PATH_OUTSIDE_VAULT", async () => {
		const err = await callToolForError("get_metadata", { file: "/etc/passwd" });
		expectVaultError(err, "PATH_OUTSIDE_VAULT", "ABSOLUTE_PATH");
	});

	test("search with traversal scope.path returns PATH_OUTSIDE_VAULT", async () => {
		const err = await callToolForError("search", { query: "anything", scope: { path: "../escape" } });
		expectVaultError(err, "PATH_OUTSIDE_VAULT", "TRAVERSAL_SEGMENT");
	});

	test("get_vault_tree with traversal path returns PATH_OUTSIDE_VAULT", async () => {
		const err = await callToolForError("get_vault_tree", { path: "../../etc/passwd" });
		expectVaultError(err, "PATH_OUTSIDE_VAULT", "TRAVERSAL_SEGMENT");
	});

	test("get_vault_tree with no path arg still returns the W1 INTERNAL_ERROR stub", async () => {
		const err = await callToolForError("get_vault_tree", {});
		expectVaultError(err, "INTERNAL_ERROR");
	});

	test("empty path returns PATH_OUTSIDE_VAULT/EMPTY_PATH envelope", async () => {
		const err = await callToolForError("get_metadata", { file: "" });
		expectVaultError(err, "PATH_OUTSIDE_VAULT", "EMPTY_PATH");
	});

	test("over-length path returns PATH_OUTSIDE_VAULT/PATH_TOO_LONG envelope", async () => {
		const err = await callToolForError("get_metadata", { file: "x".repeat(MAX_PATH_LENGTH + 1) });
		expectVaultError(err, "PATH_OUTSIDE_VAULT", "PATH_TOO_LONG");
	});
});

describe("tools/call — top-level argument strictness", () => {
	test("typo'd top-level key surfaces InvalidParams (not silent strip)", async () => {
		await expectTransportError(
			{ name: "search", arguments: { query: "auth", scpoe: { path: "private" } } },
			/unrecognized|-32602/i,
		);
	});
});

describe("tools/call — unknown tool", () => {
	test("surfaces a transport-layer error, not a domain VaultError", async () => {
		// Protocol-error surface for "method not found" per D13 — must NOT
		// carry a domain `VaultError` in `structuredContent`.
		await expectTransportError({ name: "does_not_exist", arguments: {} }, /-3260[12]|not found/i, (result) => {
			expect(result.structuredContent).toBeUndefined();
		});
	});
});

describe("resources/list + resources/templates/list", () => {
	test("note:// template is registered with reserved-character expansion", async () => {
		// `{+path}` (RFC 6570 reserved expansion) is required so nested
		// paths like `notes/auth.md` actually match — plain `{path}`
		// silently fails because its regex is `([^/,]+)`.
		const templates = await connection.client.listResourceTemplates();
		const note = templates.resourceTemplates.find((t) => t.uriTemplate === "note://{+path}");
		expect(note).toBeDefined();
		expect(note?.mimeType).toBe("text/markdown");
	});
});

describe("resources/read", () => {
	test("note:// stub returns InternalError with INTERNAL_ERROR data code", async () => {
		const data = await captureReadResourceData("note://foo.md");
		expectVaultError(data, "INTERNAL_ERROR");
	});

	test("note:// with nested path reaches the W1 stub", async () => {
		const data = await captureReadResourceData("note://sub/nested.md");
		expectVaultError(data, "INTERNAL_ERROR");
	});

	test("note:// with percent-encoded path decodes before validatePath", async () => {
		const data = await captureReadResourceData("note://unicode-%C3%A9.md");
		expectVaultError(data, "INTERNAL_ERROR");
	});

	test("note:// with traversal path returns PATH_OUTSIDE_VAULT", async () => {
		const data = await captureReadResourceData("note://../../etc/passwd");
		expectVaultError(data, "PATH_OUTSIDE_VAULT", "TRAVERSAL_SEGMENT");
		// Resource surface — the bad input is the request URI, not a `file` arg.
		expect(data.param).toBe("uri");
	});

	test("note:// with malformed percent-encoding returns PATH_NOT_FOUND", async () => {
		// `%G1` is not valid hex → decodeURIComponent throws URIError;
		// surface as PATH_NOT_FOUND, not an uncaught -32603.
		const data = await captureReadResourceData("note://bad-%G1.md");
		expectVaultError(data, "PATH_NOT_FOUND");
	});

	test("%2e%2e segments are URL-normalized before template match", async () => {
		// `note://sub/%2e%2e/nested.md` rewrites to `note://sub/nested.md`
		// per URL spec (path-position `..` collapses against host-rooted
		// segments, never escapes past the host root). Catches any SDK
		// change that drops this normalization.
		const data = await captureReadResourceData("note://sub/%2e%2e/nested.md");
		expectVaultError(data, "INTERNAL_ERROR");
	});
});

// ─── Helpers ───────────────────────────────────────────────────────────────

async function callToolForError(name: (typeof TOOL_NAMES)[number], args: Record<string, unknown>): Promise<VaultError> {
	const result = await connection.client.callTool({ name, arguments: args });
	expect(result.isError).toBe(true);
	return result.structuredContent as VaultError;
}

/**
 * Assert a callTool produces a transport-layer error (no domain VaultError):
 * the SDK may either throw a JSON-RPC error OR wrap the protocol error in an
 * `isError: true` result. `pattern` matches either surface. Optional
 * `extraResultCheck` runs only when the SDK returned a result (didn't throw).
 */
async function expectTransportError(
	args: { name: string; arguments: Record<string, unknown> },
	pattern: RegExp,
	extraResultCheck?: (result: { content?: unknown; structuredContent?: unknown }) => void,
): Promise<void> {
	try {
		const result = await connection.client.callTool(args);
		expect(result.isError).toBe(true);
		const content = result.content as Array<{ type?: string; text?: string }>;
		expect(content[0]?.text).toMatch(pattern);
		extraResultCheck?.(result);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		expect(message).toMatch(pattern);
	}
}

function expectVaultError(err: VaultError, code: ErrorCode, reason?: PathRejectionReason): void {
	expect(err.code).toBe(code);
	if (reason !== undefined) {
		expect(err.reason).toBe(reason);
	}
}

async function captureReadResourceData(uri: string): Promise<VaultError> {
	try {
		await connection.client.readResource({ uri });
	} catch (err) {
		const data = (err as { data?: unknown }).data;
		if (data && typeof data === "object" && "code" in data) {
			return data as VaultError;
		}
		throw err;
	}
	throw new Error(`Expected readResource(${uri}) to reject, but it resolved.`);
}

function stubArgsFor(name: (typeof TOOL_NAMES)[number]): Record<string, unknown> {
	switch (name) {
		case "get_vault_tree":
			return {};
		case "get_file_outline":
			return { file: "foo.md" };
		case "get_fragment":
			return { file: "foo.md", anchor: { kind: "file" } };
		case "search":
			return { query: "" };
		case "get_metadata":
			return { file: "foo.md" };
		case "get_links":
			return { file: "foo.md" };
	}
}
