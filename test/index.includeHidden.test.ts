/**
 * `--include-hidden` is all-or-nothing per server (CLAUDE.md gotcha:
 * "Hidden files: all-or-nothing per-server"). With the flag off (default),
 * dot-prefixed paths are excluded from EVERY surface. With it on, they
 * become addressable through every surface symmetrically — tree, search,
 * fragment, links, note://. This test runs the same vault under both
 * modes and asserts the visibility flips together, not piecewise.
 *
 * Two server processes are spawned (one with the flag, one without) so
 * the boot-time wiring (scanner gate, watcher ignore, server config) is
 * exercised end-to-end rather than mocked.
 */

import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import type { GetVaultTreeResult, SearchOutput, VaultTreeItem } from "../src/types.js";
import { spawnTestServer, type TestClient, waitForWarm } from "./helpers/mcp-client.js";
import { createTempVault, type VaultStructure } from "./helpers/vault.js";

const FIXTURE: VaultStructure = {
	"plain.md": "# Plain\n\nVisible always.\n",
	".dotfile.md": "# Dotfile\n\nHidden by default.\n",
	".obsidian": {
		"workspace.md": "# Workspace\n\nHidden by default (parent dir is dotted).\n",
	},
};

// Two separate vault dirs with identical content — both servers share the
// same on-disk SQLite (`<vault>/.markdown-mcp/index.sqlite3`) within a single
// vault, so a single shared vault would cross-contaminate: the hidden-mode
// server would index `.dotfile.md` and the default-mode server would then
// see those rows on its next reconcile. Independent vaults preserve the
// per-server policy boundary.
let defaultVault: { path: string; cleanup: () => Promise<void> };
let hiddenVault: { path: string; cleanup: () => Promise<void> };
let defaultConn: TestClient;
let hiddenConn: TestClient;

beforeAll(async () => {
	defaultVault = await createTempVault(FIXTURE);
	hiddenVault = await createTempVault(FIXTURE);
	defaultConn = await spawnTestServer(defaultVault.path);
	hiddenConn = await spawnTestServer(hiddenVault.path, {}, ["--include-hidden"]);
	await waitForWarm(defaultConn.client);
	await waitForWarm(hiddenConn.client);
	// Cache-dir gate test fixture: write a markdown file inside the
	// hidden-mode server's `.markdown-mcp/` AFTER warm so the watcher's
	// isIndexCachePath ignore prevents reindex chatter. The file must EXIST
	// for the readNote.assertNotePathString gate to fire — validatePath's
	// segment-walk lstat would otherwise return PATH_NOT_FOUND first and
	// mask the cache-dir rejection path.
	await writeFile(
		join(hiddenVault.path, ".markdown-mcp", "notes.md"),
		"# Inside cache\n\nshould be unreachable\n",
		"utf8",
	);
}, 30_000);

afterAll(async () => {
	await defaultConn.close();
	await hiddenConn.close();
	await defaultVault.cleanup();
	await hiddenVault.cleanup();
});

async function listTreePaths(client: TestClient["client"]): Promise<string[]> {
	const r = await client.callTool({ name: "get_vault_tree", arguments: { depth: 5, pageSize: 50 } });
	expect(r.isError).toBeFalsy();
	const items = (r.structuredContent as GetVaultTreeResult).items;
	return items.map((i: VaultTreeItem) => i.path);
}

describe("--include-hidden gates every surface together", () => {
	test("default: dotfile not in get_vault_tree", async () => {
		const paths = await listTreePaths(defaultConn.client);
		expect(paths).toContain("plain.md");
		expect(paths).not.toContain(".dotfile.md");
		expect(paths).not.toContain(".obsidian");
	});

	test("--include-hidden: dotfile and dotted dir appear in get_vault_tree", async () => {
		const paths = await listTreePaths(hiddenConn.client);
		expect(paths).toContain("plain.md");
		expect(paths).toContain(".dotfile.md");
		expect(paths).toContain(".obsidian");
	});

	test("--include-hidden does NOT surface server's own .markdown-mcp cache dir", async () => {
		// Mirrors watcher.ts's hard exclusion: the server creates
		// `.markdown-mcp/index.sqlite3` (+ `-wal`/`-shm`) under the vault root.
		// Surfacing them in the tree leaks server internals and, because
		// `.markdown-mcp` sorts before any letter-named content, would consume
		// the first page on small `pageSize` requests.
		const paths = await listTreePaths(hiddenConn.client);
		expect(paths).not.toContain(".markdown-mcp");
		expect(paths.some((p) => p.startsWith(".markdown-mcp/"))).toBe(false);
	});

	test("--include-hidden: get_vault_tree({ path: '.markdown-mcp' }) rejects with PATH_NOT_FOUND", async () => {
		// `resolveStartPath`'s isHiddenPath gate is bypassed under
		// --include-hidden, so without the isIndexCachePath gate
		// the walk descends into the cache and exposes index.sqlite3 +
		// WAL/SHM siblings as items[].
		const r = await hiddenConn.client.callTool({
			name: "get_vault_tree",
			arguments: { path: ".markdown-mcp", depth: 5, pageSize: 50 },
		});
		expect(r.isError).toBeTruthy();
		const err = r.structuredContent as { code?: string; param?: string };
		expect(err.code).toBe("PATH_NOT_FOUND");
		expect(err.param).toBe("path");
	});

	test("--include-hidden: get_fragment rejects .markdown-mcp/* paths", async () => {
		// `.markdown-mcp/notes.md` exists on disk (planted in beforeAll) so
		// validatePath succeeds and we exercise the readNote
		// assertNotePathString isIndexCachePath gate specifically — not the
		// fall-through PATH_NOT_FOUND from a missing file.
		const r = await hiddenConn.client.callTool({
			name: "get_fragment",
			arguments: { file: ".markdown-mcp/notes.md", anchor: { kind: "file" } },
		});
		expect(r.isError).toBeTruthy();
		const err = r.structuredContent as { code?: string; message?: string };
		expect(err.code).toBe("PATH_NOT_FOUND");
		expect(err.message ?? "").toContain("server cache directory");
	});

	test("--include-hidden: search.scope.path rejects .markdown-mcp", async () => {
		// classifyScope mirrors readNote: isIndexCachePath gate after the
		// hidden-path gate so PATH_NOT_FOUND with `param: 'scope.path'`
		// surfaces under --include-hidden too.
		const r = await hiddenConn.client.callTool({
			name: "search",
			arguments: { query: "x", scope: { path: ".markdown-mcp" } },
		});
		expect(r.isError).toBeTruthy();
		const err = r.structuredContent as { code?: string; param?: string };
		expect(err.code).toBe("PATH_NOT_FOUND");
		expect(err.param).toBe("scope.path");
	});

	test("--include-hidden: note:// resource rejects .markdown-mcp/* read", async () => {
		// Same fixture as the get_fragment test: file exists so we exercise
		// the readNote.assertNotePathString gate, not the validatePath
		// fall-through.
		const r = await hiddenConn.client.readResource({ uri: "note://.markdown-mcp/notes.md" }).then(
			() => "ok" as const,
			(err) => err,
		);
		expect(r).not.toBe("ok");
		expect(String(r)).toContain("server cache directory");
	});

	test("default: search misses dotfile content", async () => {
		const r = await defaultConn.client.callTool({ name: "search", arguments: { query: "dotfile" } });
		expect(r.isError).toBeFalsy();
		const items = (r.structuredContent as SearchOutput).items;
		const files = items.map((i) => i.file);
		expect(files).not.toContain(".dotfile.md");
	});

	test("--include-hidden: search returns dotfile content", async () => {
		const r = await hiddenConn.client.callTool({ name: "search", arguments: { query: "dotfile" } });
		expect(r.isError).toBeFalsy();
		const items = (r.structuredContent as SearchOutput).items;
		const files = items.map((i) => i.file);
		expect(files).toContain(".dotfile.md");
	});

	test("default: get_fragment rejects dotfile path", async () => {
		const r = await defaultConn.client.callTool({
			name: "get_fragment",
			arguments: { file: ".dotfile.md", anchor: { kind: "file" } },
		});
		expect(r.isError).toBeTruthy();
		// `PATH_NOT_FOUND` because the hidden gate masks existence.
		const err = r.structuredContent as { code?: string };
		expect(err.code).toBe("PATH_NOT_FOUND");
	});

	test("--include-hidden: get_fragment serves dotfile body", async () => {
		const r = await hiddenConn.client.callTool({
			name: "get_fragment",
			arguments: { file: ".dotfile.md", anchor: { kind: "file" } },
		});
		expect(r.isError).toBeFalsy();
		const frag = r.structuredContent as { content?: string };
		expect(frag.content ?? "").toContain("Hidden by default.");
	});

	test("default: note:// resource rejects dotfile read", async () => {
		const r = await defaultConn.client.readResource({ uri: "note://.dotfile.md" }).then(
			() => "ok" as const,
			(err) => err,
		);
		expect(r).not.toBe("ok");
		// The SDK surfaces `-32602` / `-32603` JSON-RPC errors for resource
		// failures; the message includes the path-not-found vocabulary.
		expect(String(r)).toMatch(/PATH_NOT_FOUND|hidden/);
	});

	test("--include-hidden: note:// resource serves dotfile body", async () => {
		const r = await hiddenConn.client.readResource({ uri: "note://.dotfile.md" });
		expect(r.contents.length).toBeGreaterThan(0);
		const text = (r.contents[0] as { text: string }).text;
		expect(text).toContain("Hidden by default.");
	});
});
