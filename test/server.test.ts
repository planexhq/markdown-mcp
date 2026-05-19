/**
 * MCP integration tests for the W1 stub server.
 *
 * Spawns the built server (`dist/index.js`) and exercises the MCP
 * protocol: Initialize handshake, tools/list, tools/call (each tool),
 * resources/list, resources/read.
 *
 * W1 exit-criteria coverage:
 *   - 7 tools registered, schemas non-empty
 *   - Each tool returns INTERNAL_ERROR envelope (D13) with valid UUIDv4
 *     request_id and `_meta` envelope
 *   - request_id is unique per call
 *   - Path-validating tools surface PATH_OUTSIDE_VAULT for traversal
 *     inputs (validatePath wired even in stubs)
 *   - note:// resource read maps to a JSON-RPC error with our domain
 *     code in `data` (W5 will turn this into a real read)
 */

import { spawn } from "node:child_process";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
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
	// D37 — identity / health snapshot for agent self-verification.
	"get_server_info",
] as const;

/**
 * After W4 every tool has a real handler. STUBBED_TOOLS is empty; the
 * test below that iterates it is preserved as a regression hook so a
 * future regression that re-adds a stub fails loudly. The
 * `note://{path}` resource is still stubbed (W5).
 */
const STUBBED_TOOLS: ReadonlyArray<(typeof TOOL_NAMES)[number]> = [];

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

/**
 * Spawn a fresh server, send a single hand-rolled `initialize` request
 * with the given protocol version, and return the parsed JSON-RPC
 * response. The SDK Client always sends `LATEST_PROTOCOL_VERSION`, so
 * any test that needs to exercise a different version on the wire
 * must bypass it.
 */
async function sendInitialize(
	vaultPath: string,
	protocolVersion: string,
): Promise<{ error?: { code: number; message: string }; result?: { protocolVersion: string } }> {
	const child = spawn(process.execPath, [SERVER_BIN, "--vault", vaultPath], {
		stdio: ["pipe", "pipe", "inherit"],
	});
	try {
		const initialize = `${JSON.stringify({
			jsonrpc: "2.0",
			id: 1,
			method: "initialize",
			params: {
				protocolVersion,
				capabilities: {},
				clientInfo: { name: "init-test-client", version: "0.0.0" },
			},
		})}\n`;
		child.stdin.write(initialize);
		const responseLine = await new Promise<string>((resolve, reject) => {
			child.stdout.once("data", (chunk: Buffer) => resolve(chunk.toString().split("\n")[0] ?? ""));
			child.once("error", reject);
			child.once("exit", (code) => reject(new Error(`server exited prematurely with code ${code}`)));
		});
		return JSON.parse(responseLine);
	} finally {
		child.kill();
	}
}

describe("Initialize handshake — D22 minimum protocol version", () => {
	test("rejects pre-2025-06-18 clients with InvalidRequest", async () => {
		const response = await sendInitialize(vault.path, "2024-11-05");
		expect(response.error?.code).toBe(-32600);
		expect(response.error?.message).toContain(MIN_PROTOCOL_VERSION);
	});

	test("clamps newer-than-SUPPORTED protocol version to LATEST", async () => {
		const response = await sendInitialize(vault.path, "2030-01-01");
		expect(response.error).toBeUndefined();
		expect(response.result?.protocolVersion).toBe(LATEST_PROTOCOL_VERSION);
	});

	test("echoes a SUPPORTED in-window version unchanged", async () => {
		// Regression: clamp branch must not rewrite a supported version
		// to LATEST.
		const response = await sendInitialize(vault.path, MIN_PROTOCOL_VERSION);
		expect(response.error).toBeUndefined();
		expect(response.result?.protocolVersion).toBe(MIN_PROTOCOL_VERSION);
	});
});

describe("Initialize handshake", () => {
	test("server reports name + version", () => {
		const info = connection.client.getServerVersion();
		expect(info?.name).toBe("markdown-mcp");
		expect(info?.version).toBe("1.0.0");
	});

	test("server advertises tools + resources capabilities", () => {
		const caps = connection.client.getServerCapabilities();
		expect(caps?.tools).toBeDefined();
		expect(caps?.resources).toBeDefined();
	});
});

describe("tools/list", () => {
	test("returns all 7 tools with non-empty input schemas", async () => {
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

describe("tools/call — INTERNAL_ERROR envelope regression hook", () => {
	// W4 wires every tool to a real handler. Loop body retained as a
	// regression sentry: if a future change re-stubs something, the
	// expected INTERNAL_ERROR shape is still asserted.
	for (const name of STUBBED_TOOLS) {
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

	test("two consecutive calls produce distinct request_ids on a deterministic error path", async () => {
		// Use `get_metadata` against a non-existent file — guaranteed to
		// produce a domain error envelope on every invocation, so we can
		// inspect `request_id` deterministically.
		const a = await connection.client.callTool({ name: "get_metadata", arguments: { file: "definitely-missing.md" } });
		const b = await connection.client.callTool({ name: "get_metadata", arguments: { file: "definitely-missing.md" } });
		const idA = (a.structuredContent as VaultError).request_id;
		const idB = (b.structuredContent as VaultError).request_id;
		expect(idA).toBeTruthy();
		expect(idB).toBeTruthy();
		expect(idA).not.toBe(idB);
	});
});

describe("tools/call — W2 real handlers", () => {
	test("get_file_outline returns outline + blockIndex with tokenizer in _meta", async () => {
		const result = await connection.client.callTool({
			name: "get_file_outline",
			arguments: { file: "multi-section.md" },
		});
		expect(result.isError).toBeFalsy();
		const structured = result.structuredContent as {
			outline: Array<{ path: string }>;
			blockIndex: Record<string, unknown>;
		};
		expect(structured.outline.map((n) => n.path)).toEqual(["Auth", "Tags"]);
		const meta = result._meta as MetaEnvelope | undefined;
		expect(meta?.tokenizer).toBe("heuristic/content-aware-v1");
	});

	test("get_file_outline surfaces blockIndex first-match-wins", async () => {
		const result = await connection.client.callTool({
			name: "get_file_outline",
			arguments: { file: "with-blocks.md" },
		});
		const structured = result.structuredContent as { blockIndex: Record<string, { heading_path: string[] }> };
		expect(Object.keys(structured.blockIndex).sort()).toEqual(["block-one", "block-two"]);
		expect(structured.blockIndex["block-one"]?.heading_path).toEqual(["Section"]);
	});

	test("get_fragment heading_path resolves a single match", async () => {
		const result = await connection.client.callTool({
			name: "get_fragment",
			arguments: { file: "multi-section.md", anchor: { kind: "heading_path", path: ["Auth"] } },
		});
		expect(result.isError).toBeFalsy();
		const f = result.structuredContent as {
			anchor_kind: string;
			heading_path: string[];
			level: number;
			content: string;
		};
		expect(f.anchor_kind).toBe("heading");
		expect(f.heading_path).toEqual(["Auth"]);
		expect(f.level).toBe(1);
		expect(f.content).toContain("Auth body");
	});

	test("get_fragment heading_path 'A > B' string form works", async () => {
		const result = await connection.client.callTool({
			name: "get_fragment",
			arguments: { file: "multi-section.md", anchor: { kind: "heading_path", path: "Auth > OAuth2" } },
		});
		expect(result.isError).toBeFalsy();
		const f = result.structuredContent as { heading_path: string[]; level: number };
		expect(f.heading_path).toEqual(["Auth", "OAuth2"]);
		expect(f.level).toBe(2);
	});

	test("get_fragment heading_path string form is trimmed and whitespace-collapsed", async () => {
		// Stored `pathText` runs `.trim().replace(/\s+/g, " ")` at parse time;
		// input must undergo the same normalization or sloppy whitespace
		// returns HEADING_NOT_FOUND despite matching the canonical form.
		const result = await connection.client.callTool({
			name: "get_fragment",
			arguments: { file: "multi-section.md", anchor: { kind: "heading_path", path: "  Auth  >  OAuth2  " } },
		});
		expect(result.isError).toBeFalsy();
		const f = result.structuredContent as { heading_path: string[] };
		expect(f.heading_path).toEqual(["Auth", "OAuth2"]);
	});

	test("get_fragment heading_path array form is trimmed per component", async () => {
		const result = await connection.client.callTool({
			name: "get_fragment",
			arguments: { file: "multi-section.md", anchor: { kind: "heading_path", path: ["  Auth  ", "OAuth2"] } },
		});
		expect(result.isError).toBeFalsy();
		const f = result.structuredContent as { heading_path: string[] };
		expect(f.heading_path).toEqual(["Auth", "OAuth2"]);
	});

	test("get_fragment heading_path empty returns PreambleFragment", async () => {
		const result = await connection.client.callTool({
			name: "get_fragment",
			arguments: { file: "multi-section.md", anchor: { kind: "heading_path", path: [] } },
		});
		expect(result.isError).toBeFalsy();
		const f = result.structuredContent as { anchor_kind: string; content: string };
		expect(f.anchor_kind).toBe("preamble");
		expect(f.content).toContain("Preamble line");
	});

	test("get_fragment ambiguous heading_path returns HEADING_AMBIGUOUS with candidates", async () => {
		const result = await connection.client.callTool({
			name: "get_fragment",
			arguments: { file: "ambiguous.md", anchor: { kind: "heading_path", path: ["Auth"] } },
		});
		expect(result.isError).toBe(true);
		const err = result.structuredContent as VaultError & { candidates?: Array<{ stable_id: string }> };
		expect(err.code).toBe("HEADING_AMBIGUOUS");
		expect(err.candidates).toHaveLength(2);
		expect(err.candidates?.[0]?.stable_id).toMatch(/^h:[0-9a-f]{14}$/);
	});

	test("get_fragment missing heading_path returns HEADING_NOT_FOUND", async () => {
		const result = await connection.client.callTool({
			name: "get_fragment",
			arguments: { file: "multi-section.md", anchor: { kind: "heading_path", path: ["NonExistent"] } },
		});
		expect(result.isError).toBe(true);
		const err = result.structuredContent as VaultError;
		expect(err.code).toBe("HEADING_NOT_FOUND");
	});

	test("get_fragment block id returns BlockFragment with containing_heading_path", async () => {
		const result = await connection.client.callTool({
			name: "get_fragment",
			arguments: { file: "with-blocks.md", anchor: { kind: "block", id: "block-one" } },
		});
		expect(result.isError).toBeFalsy();
		const f = result.structuredContent as {
			anchor_kind: string;
			block_id: string;
			containing_heading_path: string[];
			content: string;
		};
		expect(f.anchor_kind).toBe("block");
		expect(f.block_id).toBe("block-one");
		expect(f.containing_heading_path).toEqual(["Section"]);
		expect(f.content).not.toMatch(/\^block-one/); // ^id stripped from displayed content
	});

	test("get_fragment block id tolerates a leading `^` (renderer round-trip)", async () => {
		// The outline renderer emits `^block-one` (matching Obsidian's
		// `[[file#^abc]]` convention); an agent copying the rendered form
		// must round-trip to the same BlockFragment as the bare id.
		const result = await connection.client.callTool({
			name: "get_fragment",
			arguments: { file: "with-blocks.md", anchor: { kind: "block", id: "^block-one" } },
		});
		expect(result.isError).toBeFalsy();
		const f = result.structuredContent as { anchor_kind: string; block_id: string };
		expect(f.anchor_kind).toBe("block");
		expect(f.block_id).toBe("block-one");
	});

	test("get_fragment deferred-block preserves caret-suffixed prior text", async () => {
		// `^math-block` is a deferred-form block ID addressing `Value x^2`.
		// The trim regex must strip ONLY `^math-block`, not `^2` from the
		// addressed paragraph (which is not a block ID per BLOCK_ID_RE).
		const result = await connection.client.callTool({
			name: "get_fragment",
			arguments: { file: "block-deferred-caret.md", anchor: { kind: "block", id: "math-block" } },
		});
		expect(result.isError).toBeFalsy();
		const f = result.structuredContent as { content: string; block_id: string };
		expect(f.block_id).toBe("math-block");
		expect(f.content).toBe("Value x^2");
	});

	test("get_fragment for block inside blockquote preserves the `>` marker", async () => {
		// mdast paragraph offsets start after `> `; the block-fragment slice
		// must re-include the marker so the returned content is the raw
		// markdown blockquote, not bare quoted text.
		const result = await connection.client.callTool({
			name: "get_fragment",
			arguments: { file: "block-in-blockquote.md", anchor: { kind: "block", id: "quote-block" } },
		});
		expect(result.isError).toBeFalsy();
		const f = result.structuredContent as { content: string; block_id: string };
		expect(f.block_id).toBe("quote-block");
		expect(f.content).toBe("> quoted text");
	});

	test("get_fragment for block inside a blockquote-wrapped list preserves the `> -` prefix", async () => {
		// `> - item` nests as `blockquote → list → listItem`, so detection must
		// walk the ancestor chain (not just immediate parent) to fire the
		// line-start walkback that re-includes the `> ` marker.
		const result = await connection.client.callTool({
			name: "get_fragment",
			arguments: { file: "block-in-blockquote-list.md", anchor: { kind: "block", id: "qlist-block" } },
		});
		expect(result.isError).toBeFalsy();
		const f = result.structuredContent as { content: string; block_id: string };
		expect(f.block_id).toBe("qlist-block");
		expect(f.content).toBe("> - quoted item");
	});

	test("get_fragment for deferred block ID inside a blockquote returns the prior quoted paragraph", async () => {
		// `> p1\n> \n> ^id` is the canonical deferred-form pattern inside a
		// blockquote: the blank `> ` line ends p1; the lone `> ^id` paragraph
		// addresses p1. `>` markers are notation, not content, for adjacency.
		const result = await connection.client.callTool({
			name: "get_fragment",
			arguments: { file: "block-in-blockquote-deferred.md", anchor: { kind: "block", id: "quote-deferred" } },
		});
		expect(result.isError).toBeFalsy();
		const f = result.structuredContent as { content: string; block_id: string };
		expect(f.block_id).toBe("quote-deferred");
		expect(f.content).toBe("> first quoted");
	});

	test("get_fragment for ^id on a parent list item with a sub-list returns the parent (marker stripped)", async () => {
		// Per Obsidian semantics the addressed block is the entire parent
		// listItem — including the nested sub-list — when `^id` sits at the
		// parent's text edge. The addressing marker itself is metadata
		// (carried in `block_id`), so it must be stripped from `content`
		// along with its leading space — same behavior as inline form.
		const result = await connection.client.callTool({
			name: "get_fragment",
			arguments: { file: "nested-list-block-ids.md", anchor: { kind: "block", id: "p" } },
		});
		expect(result.isError).toBeFalsy();
		const f = result.structuredContent as { content: string; block_id: string };
		expect(f.block_id).toBe("p");
		expect(f.content).toBe("- Parent\n  - Child");
	});

	test("get_fragment for ^id on a nested-list parent excludes wikilinks inside child code spans", async () => {
		// Regression guard for buildBlockFragment's extract-then-strip order:
		// stripping ` ^p` mid-`raw` would shift the child's wikilink offsets
		// out of sync with `excludedRanges`, leaking `[[Fake]]` (inside an
		// inline-code span) as a real outgoing link.
		const result = await connection.client.callTool({
			name: "get_fragment",
			arguments: { file: "nested-list-block-with-code-child.md", anchor: { kind: "block", id: "p" } },
		});
		expect(result.isError).toBeFalsy();
		const f = result.structuredContent as {
			content: string;
			outgoing_links: Array<{ raw_target: string }>;
		};
		expect(f.outgoing_links.map((l) => l.raw_target)).toEqual(["Real"]);
		expect(f.content.startsWith("- Parent\n")).toBe(true);
	});

	test("get_fragment for a duplicate ^id resolves to the FIRST occurrence (Brief line 90)", async () => {
		// Fixture has `^dupe` in both `# First section` and `# Second section`.
		// Index is first-match-wins; the parser test confirms the outline
		// also attributes `dupe` only to "First section".
		const result = await connection.client.callTool({
			name: "get_fragment",
			arguments: { file: "duplicate-block-ids.md", anchor: { kind: "block", id: "dupe" } },
		});
		expect(result.isError).toBeFalsy();
		const f = result.structuredContent as { content: string; block_id: string };
		expect(f.block_id).toBe("dupe");
		expect(f.content).toContain("Paragraph A");
		expect(f.content).not.toContain("Paragraph C");
	});

	test("get_fragment with anchor.kind='file' returns FileFragment", async () => {
		const result = await connection.client.callTool({
			name: "get_fragment",
			arguments: { file: "foo.md", anchor: { kind: "file" } },
		});
		expect(result.isError).toBeFalsy();
		const structured = result.structuredContent as { anchor_kind: string; content: string };
		expect(structured.anchor_kind).toBe("file");
		expect(structured.content).toContain("# foo");
	});

	test("get_fragment on a frontmatter-only note excludes the YAML block", async () => {
		const result = await connection.client.callTool({
			name: "get_fragment",
			arguments: { file: "fm-only.md", anchor: { kind: "file" } },
		});
		expect(result.isError).toBeFalsy();
		const structured = result.structuredContent as { anchor_kind: string; content: string };
		expect(structured.anchor_kind).toBe("file");
		expect(structured.content).not.toContain("title:");
		expect(structured.content).not.toContain("---");
	});

	test("get_fragment with frontmatter+blank+heading starts at the heading, no stray leading newline", async () => {
		const result = await connection.client.callTool({
			name: "get_fragment",
			arguments: { file: "with-frontmatter.md", anchor: { kind: "file" } },
		});
		expect(result.isError).toBeFalsy();
		const structured = result.structuredContent as { content: string };
		expect(structured.content.startsWith("# Body heading")).toBe(true);
		expect(structured.content).not.toContain("title:");
	});

	test("get_fragment on a non-markdown extension returns PATH_NOT_FOUND", async () => {
		const err = await callToolForError("get_fragment", { file: "secret.txt", anchor: { kind: "file" } });
		expect(err.code).toBe("PATH_NOT_FOUND");
		expect(err.param).toBe("file");
	});

	test("get_file_outline on a non-markdown extension returns PATH_NOT_FOUND", async () => {
		const err = await callToolForError("get_file_outline", { file: "secret.txt" });
		expect(err.code).toBe("PATH_NOT_FOUND");
		expect(err.param).toBe("file");
	});

	test("get_metadata on a non-markdown extension returns PATH_NOT_FOUND", async () => {
		const err = await callToolForError("get_metadata", { file: "secret.txt" });
		expect(err.code).toBe("PATH_NOT_FOUND");
		expect(err.param).toBe("file");
	});

	test("get_fragment on a hidden path (.obsidian/notes.md) returns PATH_NOT_FOUND", async () => {
		const err = await callToolForError("get_fragment", {
			file: ".obsidian/notes.md",
			anchor: { kind: "file" },
		});
		expect(err.code).toBe("PATH_NOT_FOUND");
		expect(err.param).toBe("file");
	});

	test("get_file_outline on a hidden path returns PATH_NOT_FOUND", async () => {
		const err = await callToolForError("get_file_outline", { file: ".obsidian/notes.md" });
		expect(err.code).toBe("PATH_NOT_FOUND");
		expect(err.param).toBe("file");
	});

	test("get_metadata on a hidden path returns PATH_NOT_FOUND", async () => {
		const err = await callToolForError("get_metadata", { file: ".obsidian/notes.md" });
		expect(err.code).toBe("PATH_NOT_FOUND");
		expect(err.param).toBe("file");
	});

	test("get_file_outline on ambiguous.md emits deduplicated slugs", async () => {
		// The fixture has two `# Auth` headings. Anchors must be `auth` and `auth-1`
		// per github-slugger convention; otherwise agents can't link to the second.
		const result = await connection.client.callTool({
			name: "get_file_outline",
			arguments: { file: "ambiguous.md" },
		});
		const structured = result.structuredContent as { outline: Array<{ anchor: string }> };
		expect(structured.outline.map((n) => n.anchor)).toEqual(["auth", "auth-1"]);
	});

	test("get_fragment accepts case-variant stable_id (uppercase prefix + hex digits)", async () => {
		// Get a real stable_id from the outline, then send it back uppercased.
		// The schema regex is case-insensitive (`/^h:[0-9a-f]{14}$/i`); generated
		// IDs are always lowercase. Handler-side normalization should resolve
		// either form to the same heading.
		const outline = await connection.client.callTool({
			name: "get_file_outline",
			arguments: { file: "multi-section.md" },
		});
		const id = (outline.structuredContent as { outline: Array<{ stable_id: string }> }).outline[0]?.stable_id;
		expect(id).toMatch(/^h:[0-9a-f]{14}$/);
		const upper = id?.toUpperCase() ?? "";
		const result = await connection.client.callTool({
			name: "get_fragment",
			arguments: { file: "multi-section.md", anchor: { kind: "file" }, stable_id: upper },
		});
		expect(result.isError).toBeFalsy();
		const f = result.structuredContent as {
			anchor_kind: string;
			stable_id: string;
			stable_id_status: string;
			heading_path: string[];
		};
		expect(f.anchor_kind).toBe("heading");
		expect(f.stable_id_status).toBe("fresh");
		// The resolved ID is the canonical lowercase form, not the uppercase input.
		expect(f.stable_id).toBe(id);
		expect(f.heading_path).toEqual(["Auth"]);
	});

	test("get_fragment with stale stable_id returns HEADING_NOT_FOUND with stable_id_status='stale'", async () => {
		// Hex-shape valid id (`h:` + 14 hex) but not present in any fixture's outline.
		const STALE_STABLE_ID = "h:0000000000abcd";
		const result = await connection.client.callTool({
			name: "get_fragment",
			arguments: { file: "foo.md", anchor: { kind: "file" }, stable_id: STALE_STABLE_ID },
		});
		expect(result.isError).toBe(true);
		const structured = result.structuredContent as VaultError & {
			requested_stable_id?: string;
			stable_id_status?: string;
		};
		expect(structured.code).toBe("HEADING_NOT_FOUND");
		expect(structured.requested_stable_id).toBe(STALE_STABLE_ID);
		expect(structured.stable_id_status).toBe("stale");
		expect(Array.isArray(structured.candidates)).toBe(true);
		expect(structured.candidates).toHaveLength(0);
	});

	test("get_fragment expand_embeds is accepted as a no-op in W2", async () => {
		const result = await connection.client.callTool({
			name: "get_fragment",
			arguments: { file: "multi-section.md", anchor: { kind: "file" }, expand_embeds: true },
		});
		expect(result.isError).toBeFalsy();
		// Embeds present in the source would have `expanded: false` in W2;
		// `multi-section.md` has none, so just confirm the call succeeds.
		const f = result.structuredContent as { embeds: unknown[] };
		expect(Array.isArray(f.embeds)).toBe(true);
	});

	test("get_fragment classifies embed kind correctly when target carries a #fragment", async () => {
		// `extname("paper.pdf#page=2")` returns `.pdf#page=2` — the kind guess
		// must strip the `#…` before doing the extension lookup.
		const result = await connection.client.callTool({
			name: "get_fragment",
			arguments: { file: "with-embeds.md", anchor: { kind: "file" } },
		});
		expect(result.isError).toBeFalsy();
		const f = result.structuredContent as { embeds: Array<{ raw_target: string; kind: string }> };
		const byPrefix = (prefix: string) => f.embeds.find((e) => e.raw_target.startsWith(prefix));
		expect(byPrefix("paper.pdf")?.kind).toBe("pdf");
		expect(byPrefix("clip.mp4")?.kind).toBe("media");
		expect(byPrefix("image.png")?.kind).toBe("image");
		expect(byPrefix("note#Section")?.kind).toBe("note");
	});

	test.each([
		{ fixture: "with-code-wikilinks.md", desc: "code blocks and inline code" },
		{ fixture: "with-math-wikilinks.md", desc: "math spans (inline + display)" },
	])("get_fragment skips wikilinks inside $desc", async ({ fixture }) => {
		const result = await connection.client.callTool({
			name: "get_fragment",
			arguments: { file: fixture, anchor: { kind: "file" } },
		});
		expect(result.isError).toBeFalsy();
		const f = result.structuredContent as {
			outgoing_links: Array<{ raw_target: string }>;
			embeds: Array<{ raw_target: string }>;
		};
		const targets = f.outgoing_links.map((l) => l.raw_target);
		expect(targets).toEqual(["Real", "Other"]);
		expect(f.embeds).toEqual([]);
	});

	test("get_fragment honors CommonMark backslash-escape on wikilinks", async () => {
		// `\\[[…]]` (even backslash count) emits a real link; phantom emissions
		// would shift `link_ordinal` and break `get_links` cursor stability.
		const result = await connection.client.callTool({
			name: "get_fragment",
			arguments: { file: "with-escaped-wikilinks.md", anchor: { kind: "heading_path", path: ["H"] } },
		});
		expect(result.isError).toBeFalsy();
		const f = result.structuredContent as {
			outgoing_links: Array<{ raw_target: string; link_ordinal: number }>;
		};
		expect(f.outgoing_links.map((l) => l.raw_target)).toEqual(["Real", "Other", "StillReal"]);
		expect(f.outgoing_links.map((l) => l.link_ordinal)).toEqual([1, 2, 3]);
	});

	test("get_metadata on a no-frontmatter file returns has_frontmatter=false", async () => {
		const result = await connection.client.callTool({ name: "get_metadata", arguments: { file: "foo.md" } });
		expect(result.isError).toBeFalsy();
		const structured = result.structuredContent as { metadata: unknown; has_frontmatter: boolean };
		expect(structured.has_frontmatter).toBe(false);
		expect(structured.metadata).toEqual({});
	});

	test("get_metadata preserves nested frontmatter objects", async () => {
		const result = await connection.client.callTool({
			name: "get_metadata",
			arguments: { file: "with-frontmatter.md" },
		});
		expect(result.isError).toBeFalsy();
		const structured = result.structuredContent as {
			metadata: Record<string, unknown>;
			has_frontmatter: boolean;
		};
		expect(structured.has_frontmatter).toBe(true);
		expect(structured.metadata.title).toBe("Test");
		expect(structured.metadata.tags).toEqual(["api", "auth"]);
		const book = structured.metadata.book as Record<string, unknown>;
		const author = book.author as Record<string, unknown>;
		expect(author.name).toBe("Jane Doe");
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

	test("get_vault_tree with no path arg returns the vault root tree", async () => {
		// Post-W4 this is a real handler — vault root walk should succeed
		// and emit at least one item from the fixture vault.
		const result = await connection.client.callTool({ name: "get_vault_tree", arguments: {} });
		expect(result.isError).toBeFalsy();
		const structured = result.structuredContent as { items: Array<{ path: string; dfs_rank: number }> };
		expect(structured.items.length).toBeGreaterThan(0);
		expect(structured.items[0]?.dfs_rank).toBe(1);
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
		// Per-instance mimeType is authoritative for mixed-type resources
		// (markdown + YAML).
		expect(note?.mimeType).toBeUndefined();
	});
});

describe("resources/read", () => {
	test("note:// returns the literal file source for an existing markdown file", async () => {
		const result = await connection.client.readResource({ uri: "note://foo.md" });
		expect(result.contents).toHaveLength(1);
		const item = result.contents[0] as { uri: string; mimeType: string; text: string };
		expect(item.mimeType).toBe("text/markdown");
		expect(item.text).toBe("# foo\n");
	});

	test("note:// nested path reads successfully", async () => {
		const result = await connection.client.readResource({ uri: "note://sub/nested.md" });
		const item = result.contents[0] as { mimeType: string; text: string };
		expect(item.mimeType).toBe("text/markdown");
		expect(item.text).toBe("# nested\n");
	});

	test("note:// with percent-encoded path decodes before validatePath", async () => {
		const result = await connection.client.readResource({ uri: "note://unicode-%C3%A9.md" });
		const item = result.contents[0] as { text: string };
		expect(item.text).toBe("# unicode\n");
	});

	test("note:// with traversal path returns PATH_OUTSIDE_VAULT", async () => {
		const data = await captureReadResourceData("note://../../etc/passwd");
		expectVaultError(data, "PATH_OUTSIDE_VAULT", "TRAVERSAL_SEGMENT");
		// Resource surface — the bad input is the request URI, not a `file` arg.
		expect(data.param).toBe("uri");
	});

	test("note:// with missing file returns PATH_NOT_FOUND", async () => {
		const data = await captureReadResourceData("note://does-not-exist.md");
		expectVaultError(data, "PATH_NOT_FOUND");
		expect(data.param).toBe("uri");
	});

	test("note:// with malformed percent-encoding returns PATH_NOT_FOUND", async () => {
		// `%G1` is not valid hex → decodeURIComponent throws URIError;
		// surface as PATH_NOT_FOUND, not an uncaught -32603.
		const data = await captureReadResourceData("note://bad-%G1.md");
		expectVaultError(data, "PATH_NOT_FOUND");
	});

	test("%2e%2e segments are URL-normalized before template match", async () => {
		// `note://sub/%2e%2e/nested.md`: WHATWG URL parses `sub` as host,
		// `/%2e%2e/nested.md` as path. Path-position `..` collapses against
		// the host-rooted segments and never escapes past the host root, so
		// the captured `path` template variable resolves to `nested.md` for
		// the subsequent validatePath. Catches any SDK change that drops this
		// normalization.
		const result = await connection.client.readResource({ uri: "note://sub/%2e%2e/nested.md" });
		const item = result.contents[0] as { text: string };
		expect(item.text).toBe("# nested\n");
	});

	test("note:// with invalid UTF-8 returns MARKDOWN_PARSE_ERROR/encoding_failed", async () => {
		// Resource and tool surfaces must produce identical domain errors
		// for the same parse failure on the same file.
		const { writeFile } = await import("node:fs/promises");
		const { join } = await import("node:path");
		const badRel = "bad-utf8.md";
		// 0x80-0x82 are UTF-8 continuation bytes without a leading byte: invalid.
		await writeFile(join(vault.path, badRel), Buffer.from([0x80, 0x81, 0x82]));

		const data = await captureReadResourceData(`note://${badRel}`);
		expect(data.code).toBe("MARKDOWN_PARSE_ERROR");
		expect(data.param).toBe("uri");
		expect((data as VaultError & { reason?: string }).reason).toBe("encoding_failed");
	});

	test("note:// over the 10 MB cap returns FILE_TOO_LARGE with limit_bytes/actual_bytes", async () => {
		// Mirror the tool path's `fileTooLargeEnvelope` payload — clients
		// keying off `limit_bytes`/`actual_bytes` must see both fields.
		const { writeFile } = await import("node:fs/promises");
		const { join } = await import("node:path");
		const bigRel = "huge.md";
		const bigBytes = 10 * 1024 * 1024 + 256; // just over the 10 MB cap
		const buf = Buffer.alloc(bigBytes, 0x61); // 'a' bytes
		await writeFile(join(vault.path, bigRel), buf);

		const data = (await captureReadResourceData(`note://${bigRel}`)) as VaultError & {
			limit_bytes?: number;
			actual_bytes?: number;
		};
		expect(data.code).toBe("FILE_TOO_LARGE");
		expect(data.param).toBe("uri");
		expect(data.limit_bytes).toBe(10 * 1024 * 1024);
		expect(data.actual_bytes).toBe(bigBytes);
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
		case "get_server_info":
			return {};
	}
}
