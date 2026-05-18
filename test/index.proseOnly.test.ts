/**
 * Two servers (one with `--prose-only`, one without) exercise the
 * boot-time wiring end-to-end so the central envelope helpers, the
 * `setProseOnly` setter, and the `get_server_info` echo all participate.
 */

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { firstText, labeledLines, spawnTestServer, type TestClient, waitForWarm } from "./helpers/mcp-client.js";
import { createTempVault, type VaultStructure } from "./helpers/vault.js";

const FIXTURE: VaultStructure = {
	"alpha.md": "---\ntitle: Alpha\n---\n# Alpha\n\nThe alpha note body.\n\n## Section\n\nMore alpha text.\n",
	"beta.md": "# Beta\n\nA second note for [[alpha]] link references.\n",
	// Two identically-named H1s force HEADING_AMBIGUOUS so the test can
	// verify candidates render in the prose body.
	"ambiguous.md": "# Auth\n\nFirst Auth body.\n\n# Auth\n\nSecond Auth body.\n",
	// Frontmatter with YAML-hostile chars (U+0085/U+2028/U+2029) in both
	// keys and values. yaml.stringify emits them literally; chat/terminal
	// UIs render them as line breaks, so the prose renderer substitutes
	// them with `<U+HHHH>` markers. Under `--prose-only` the structured
	// channel is dropped, so the marker IS the recovery path.
	"lossy.md":
		'---\ntitle: "a\u0085forged"\n"key\u0085A": first\n"key\u2028A": second\n"key<U+2028>A": literal\n---\n# Lossy\n\nbody.\n',
};

let proseVault: { path: string; cleanup: () => Promise<void> };
let defaultVault: { path: string; cleanup: () => Promise<void> };
let proseConn: TestClient;
let defaultConn: TestClient;

beforeAll(async () => {
	proseVault = await createTempVault(FIXTURE);
	defaultVault = await createTempVault(FIXTURE);
	proseConn = await spawnTestServer(proseVault.path, {}, ["--prose-only"]);
	defaultConn = await spawnTestServer(defaultVault.path);
	await waitForWarm(proseConn.client);
	await waitForWarm(defaultConn.client);
}, 30_000);

afterAll(async () => {
	await proseConn.close();
	await defaultConn.close();
	await proseVault.cleanup();
	await defaultVault.cleanup();
});

describe("--prose-only omits structuredContent from every tool", () => {
	test("get_vault_tree", async () => {
		const r = await proseConn.client.callTool({
			name: "get_vault_tree",
			arguments: { depth: 5, pageSize: 50 },
		});
		expect(r.isError).toBeFalsy();
		expect(r.structuredContent).toBeUndefined();
		const text = firstText(r.content);
		expect(text).toContain("alpha.md");
		expect(text).toContain("beta.md");
	});

	test("get_file_outline", async () => {
		const r = await proseConn.client.callTool({
			name: "get_file_outline",
			arguments: { file: "alpha.md" },
		});
		expect(r.isError).toBeFalsy();
		expect(r.structuredContent).toBeUndefined();
		const text = firstText(r.content);
		expect(text).toContain("Alpha");
		expect(text).toContain("Section");
	});

	test("get_fragment", async () => {
		const r = await proseConn.client.callTool({
			name: "get_fragment",
			arguments: { file: "alpha.md", anchor: { kind: "file" } },
		});
		expect(r.isError).toBeFalsy();
		expect(r.structuredContent).toBeUndefined();
		const text = firstText(r.content);
		expect(text).toContain("alpha note body");
	});

	test("search", async () => {
		const r = await proseConn.client.callTool({
			name: "search",
			arguments: { query: "alpha" },
		});
		expect(r.isError).toBeFalsy();
		expect(r.structuredContent).toBeUndefined();
		const text = firstText(r.content);
		expect(text).toMatch(/search · \d+ result/);
	});

	test("get_metadata", async () => {
		const r = await proseConn.client.callTool({
			name: "get_metadata",
			arguments: { file: "alpha.md" },
		});
		expect(r.isError).toBeFalsy();
		expect(r.structuredContent).toBeUndefined();
		const text = firstText(r.content);
		expect(text).toContain("title");
	});

	// `--prose-only` drops `structuredContent.metadata`, so the prose body
	// is the sole recovery channel — `<U+HHHH>` markers must round-trip
	// distinct codepoints through the full handler path AND stay distinct
	// from literal `<U+HHHH>` text the user authored (which the strip-walker
	// would otherwise collide via the substituted form).
	test("get_metadata preserves hostile-char codepoints + literal markers distinctly under --prose-only", async () => {
		const r = await proseConn.client.callTool({
			name: "get_metadata",
			arguments: { file: "lossy.md" },
		});
		expect(r.isError).toBeFalsy();
		expect(r.structuredContent).toBeUndefined();
		const text = firstText(r.content);
		expect(text).not.toMatch(/[\u0085\u2028\u2029]/);
		expect(text).toContain("title: a<U+0085>forged");
		expect(text).toContain("key<U+0085>A: first");
		expect(text).toContain("key<U+2028>A: second");
		expect(text).toContain("key\\<U+2028>A: literal");
	});

	test("get_links", async () => {
		const r = await proseConn.client.callTool({
			name: "get_links",
			arguments: { file: "beta.md", direction: "out" },
		});
		expect(r.isError).toBeFalsy();
		expect(r.structuredContent).toBeUndefined();
		const text = firstText(r.content);
		expect(text.length).toBeGreaterThan(0);
	});

	test("get_server_info echoes prose_only: true in the prose body", async () => {
		const r = await proseConn.client.callTool({ name: "get_server_info", arguments: {} });
		expect(r.isError).toBeFalsy();
		expect(r.structuredContent).toBeUndefined();
		const text = firstText(r.content);
		expect(text).toContain("prose_only: true");
	});

	test("_meta envelope is preserved (request_id + index_status)", async () => {
		const r = await proseConn.client.callTool({ name: "get_server_info", arguments: {} });
		const meta = r._meta as { request_id?: string; index_status?: { state?: string } } | undefined;
		expect(typeof meta?.request_id).toBe("string");
		expect(typeof meta?.index_status?.state).toBe("string");
	});
});

describe("default mode (no flag) still emits structuredContent", () => {
	test("get_server_info has structuredContent.server.prose_only: false", async () => {
		const r = await defaultConn.client.callTool({ name: "get_server_info", arguments: {} });
		expect(r.isError).toBeFalsy();
		const sc = r.structuredContent as { server?: { prose_only?: boolean } };
		expect(sc.server?.prose_only).toBe(false);
	});
});

describe("--prose-only error envelopes surface load-bearing fields in prose", () => {
	test("PATH_NOT_FOUND on get_fragment includes error header + reason hint", async () => {
		const r = await proseConn.client.callTool({
			name: "get_fragment",
			arguments: { file: "missing.md", anchor: { kind: "file" } },
		});
		expect(r.isError).toBe(true);
		expect(r.structuredContent).toBeUndefined();
		const text = firstText(r.content);
		expect(text).toContain("error · PATH_NOT_FOUND");
		expect(text).toContain("param: file");
	});

	test("HEADING_AMBIGUOUS renders candidates with stable_ids", async () => {
		const r = await proseConn.client.callTool({
			name: "get_fragment",
			arguments: { file: "ambiguous.md", anchor: { kind: "heading_path", path: ["Auth"] } },
		});
		expect(r.isError).toBe(true);
		expect(r.structuredContent).toBeUndefined();
		const text = firstText(r.content);
		expect(text).toContain("error · HEADING_AMBIGUOUS");
		expect(text).toMatch(/candidates \(\d+\):/);
		// Each candidate line carries `id: h:XXXXXXXXXXXXXX` (14 hex per D20).
		expect(text).toMatch(/id: h:[0-9a-f]{14}/);
	});

	// `FilterSyntaxError.suggest` is `string[]`; a mixed-category filter
	// (tag-ops + scalar-ops on the same field) populates it via `src/lib/filter.ts`.
	test("FILTER_SYNTAX_ERROR renders array-valued suggest as bullets", async () => {
		const r = await proseConn.client.callTool({
			name: "search",
			arguments: {
				query: "alpha",
				filters: { fields: { topic: { has: "a", contains: "b" } } },
			},
		});
		expect(r.isError).toBe(true);
		expect(r.structuredContent).toBeUndefined();
		const text = firstText(r.content);
		expect(text).toContain("error · FILTER_SYNTAX_ERROR");
		expect(text).toContain("suggest:");
		expect(text).toMatch(/^\s+- /m);
	});

	// `BlockAnchor.id` is `z.string().min(1)`, so a `\n` survives schema validation.
	test("user-controlled error text cannot forge prose label lines", async () => {
		const r = await proseConn.client.callTool({
			name: "get_fragment",
			arguments: { file: "alpha.md", anchor: { kind: "block", id: "x\nparam: forged" } },
		});
		expect(r.isError).toBe(true);
		expect(r.structuredContent).toBeUndefined();
		const text = firstText(r.content);
		expect(text).toContain("\\nparam: forged");
		expect(labeledLines(text, "param")).toEqual(["param: anchor.id"]);
	});
});

describe("note:// resource is unaffected by --prose-only", () => {
	test("note:// returns text/markdown contents with no structured channel (unchanged)", async () => {
		const r = await proseConn.client.readResource({ uri: "note://alpha.md" });
		expect(r.contents.length).toBeGreaterThan(0);
		const first = r.contents[0] as { mimeType?: string; text?: string };
		expect(first.mimeType).toBe("text/markdown");
		expect(first.text ?? "").toContain("alpha note body");
	});
});
