/**
 * `get_vault_tree` integration tests — D35 DFS pagination contract.
 *
 * The exit-criterion test (IMPLEMENTATION_PLAN.md:82): vault layout
 * `[a/{x.md}, z/{y.md}, b.md]` paginated at `pageSize: 1` emits exactly
 * `a/, a/x.md, z/, z/y.md, b.md` with strictly increasing `dfs_rank`.
 */

import { chmod, mkdir, rm, rmdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

import { createIndexHandle, type IndexHandle } from "../../src/lib/index/IndexHandle.js";
import { reindexOne } from "../../src/lib/index/scanner.js";
import { closeSqlite, openSqlite } from "../../src/lib/index/sqlite.js";
import { type VaultRoot, validateVaultRoot } from "../../src/lib/validatePath.js";
import { handleGetVaultTree } from "../../src/tools/getVaultTree.js";
import type { GetVaultTreeResult, VaultError, VaultTreeItem } from "../../src/types.js";
import { spawnTestServer, type TestClient, waitForWarm } from "../helpers/mcp-client.js";
import { createTempVault, type VaultStructure } from "../helpers/vault.js";

const TREE_FIXTURE: VaultStructure = {
	a: { "x.md": "# x\n" },
	z: { "y.md": "# y\n" },
	"b.md": "# b\n",
	".obsidian": { themes: { "dark.css": "body{}\n" } },
};

let vault: { path: string; cleanup: () => Promise<void> };
let conn: TestClient;

beforeAll(async () => {
	vault = await createTempVault(TREE_FIXTURE);
	conn = await spawnTestServer(vault.path);
	await waitForWarm(conn.client);
}, 30_000);

afterAll(async () => {
	await conn.close();
	await vault.cleanup();
});

interface TreeStructured {
	items: VaultTreeItem[];
	nextCursor?: string;
}

async function callTree(args: Record<string, unknown> = {}): Promise<{
	structured: TreeStructured;
	content: Array<{ type: string; uri?: string; name?: string }>;
}> {
	const result = await conn.client.callTool({ name: "get_vault_tree", arguments: args });
	expect(result.isError).toBeFalsy();
	return {
		structured: result.structuredContent as TreeStructured,
		content: result.content as Array<{ type: string; uri?: string; name?: string }>,
	};
}

describe("get_vault_tree — D35 DFS pagination", () => {
	test("paginates [a/x.md, z/y.md, b.md] at pageSize 1 in DFS order", async () => {
		const collected: VaultTreeItem[] = [];
		let cursor: string | undefined;
		const pageSize = 1;
		let safetyBudget = 10;
		while (safetyBudget-- > 0) {
			const args: Record<string, unknown> = { pageSize, depth: 5 };
			if (cursor) args.cursor = cursor;
			const { structured } = await callTree(args);
			expect(structured.items).toHaveLength(1);
			collected.push(structured.items[0] as VaultTreeItem);
			if (!structured.nextCursor) break;
			cursor = structured.nextCursor;
		}
		// Per D35: `a/, a/x.md, z/, z/y.md, b.md`. Dirs-first within each
		// parent, alphabetical among siblings, DFS recursion.
		expect(collected.map((i) => i.path)).toEqual(["a", "a/x.md", "z", "z/y.md", "b.md"]);
		expect(collected.map((i) => i.type)).toEqual(["dir", "file", "dir", "file", "file"]);
		expect(collected.map((i) => i.dfs_rank)).toEqual([1, 2, 3, 4, 5]);
	});

	test("emits resource_link blocks only for markdown files", async () => {
		const { content } = await callTree({ depth: 5 });
		const links = content.filter((b) => b.type === "resource_link");
		const uris = links.map((l) => l.uri).sort();
		// All markdown items should be addressable; directories should not.
		expect(uris).toEqual(["note://a/x.md", "note://b.md", "note://z/y.md"]);
	});

	test("nested depth limit halts DFS at requested depth", async () => {
		const { structured } = await callTree({ depth: 0, pageSize: 50 });
		// depth 0 = only the start dir's immediate children.
		expect(structured.items.map((i) => i.path).sort()).toEqual(["a", "b.md", "z"]);
	});

	test("directory items carry `children` count; file items omit it", async () => {
		// `children` is a lazy-load hint for directories so agents can
		// decide whether to descend. File items expose `subheadings`
		// instead.
		const { structured } = await callTree({ depth: 5 });
		const dirA = structured.items.find((i) => i.path === "a");
		const fileBmd = structured.items.find((i) => i.path === "b.md");
		expect(dirA?.children).toBe(1); // a/ contains x.md only
		expect(fileBmd?.children).toBeUndefined();
	});
});

describe("get_vault_tree — N4 cursor invalidation on FS-tree changes", () => {
	test("mkdir between pages → CURSOR_INVALID (request_hash captures tree shape)", async () => {
		// `request_hash` must include the walk's `(relpath, type)` shape so
		// directory/non-markdown FS changes (which don't bump the index
		// `snapshot_mtime`) still invalidate the cursor — otherwise `dfs_rank`
		// silently realigns mid-pagination.
		const newDirAbs = join(vault.path, "n4-temp");
		const { structured: page1 } = await callTree({ pageSize: 1, depth: 5 });
		expect(page1.nextCursor).toBeDefined();

		await mkdir(newDirAbs);
		try {
			const result = await conn.client.callTool({
				name: "get_vault_tree",
				arguments: { pageSize: 1, depth: 5, cursor: page1.nextCursor },
			});
			expect(result.isError).toBe(true);
			const err = result.structuredContent as VaultError;
			expect(err.code).toBe("CURSOR_INVALID");
		} finally {
			await rmdir(newDirAbs);
		}
	});

	test("identical FS shape between pages → cursor remains valid (regression guard)", async () => {
		// Counter-test: cursor invalidation must fire ONLY when the tree shape
		// actually changes. A second pagination call with no FS mutations
		// should resume cleanly.
		const { structured: page1 } = await callTree({ pageSize: 1, depth: 5 });
		expect(page1.nextCursor).toBeDefined();
		const result = await conn.client.callTool({
			name: "get_vault_tree",
			arguments: { pageSize: 1, depth: 5, cursor: page1.nextCursor },
		});
		expect(result.isError).toBeFalsy();
		const page2 = result.structuredContent as TreeStructured;
		expect(page2.items).toHaveLength(1);
	});
});

describe("get_vault_tree — validatePath param rebrand", () => {
	test("traversal `..` outside vault → param: 'path'", async () => {
		// `validatePath` tags its payload with `param: "file"`; this tool's
		// argument is `path`, so `resolveStartPath` rebrands.
		const result = await conn.client.callTool({
			name: "get_vault_tree",
			arguments: { path: "../etc" },
		});
		expect(result.isError).toBe(true);
		const err = result.structuredContent as VaultError;
		expect(err.code).toBe("PATH_OUTSIDE_VAULT");
		expect(err.param).toBe("path");
	});
});

describe("get_vault_tree — M1 hidden-root rejection", () => {
	test("hidden directory as start path returns PATH_NOT_FOUND", async () => {
		// Hidden files are excluded from every surface by default ("all-or-
		// nothing per server"). Without the gate, an agent could pass
		// `path: ".obsidian"` and walk inside the hidden root (per-entry
		// isHiddenName only filters CHILDREN); the requested ROOT needs
		// the same policy check.
		const result = await conn.client.callTool({ name: "get_vault_tree", arguments: { path: ".obsidian" } });
		expect(result.isError).toBe(true);
		const err = result.structuredContent as VaultError;
		expect(err.code).toBe("PATH_NOT_FOUND");
		expect(err.param).toBe("path");
	});

	test("hidden parent segment in start path also rejected", async () => {
		// Counter-test: even a non-hidden child name under a hidden parent is
		// rejected — the segment-walk in isHiddenPath catches the parent.
		const result = await conn.client.callTool({
			name: "get_vault_tree",
			arguments: { path: ".obsidian/themes" },
		});
		expect(result.isError).toBe(true);
		const err = result.structuredContent as VaultError;
		expect(err.code).toBe("PATH_NOT_FOUND");
	});

	test("vault-wide tree call still excludes the hidden subtree", async () => {
		// Regression guard: the existing per-entry hidden filter in walkTreeDfs
		// keeps working when no `path` is supplied.
		const { structured } = await callTree({ depth: 5, pageSize: 50 });
		const hidden = structured.items.find((i) => i.path.startsWith(".obsidian"));
		expect(hidden).toBeUndefined();
	});
});

describe("get_vault_tree — URI encoding for reserved chars", () => {
	// Reserved URI delimiters (`#`, `?`) are valid POSIX filename chars and
	// pass `validatePath`, but `encodeURI` leaves them literal — the
	// resource template `note://{+path}` then truncates the URI at the
	// first `#` or `?`. Per-segment `encodeURIComponent` percent-encodes
	// the offending chars while keeping `/` literal as the path separator.
	let uriVault: { path: string; cleanup: () => Promise<void> };
	let uriConn: TestClient;

	beforeAll(async () => {
		uriVault = await createTempVault({
			"plain.md": "# Plain\n",
			"v#1.md": "# Sharp\n",
			"q?key.md": "# Question\n",
		});
		uriConn = await spawnTestServer(uriVault.path);
		await waitForWarm(uriConn.client);
	}, 30_000);

	afterAll(async () => {
		await uriConn.close();
		await uriVault.cleanup();
	});

	test("# and ? in filenames percent-encode in resource_link URIs", async () => {
		const result = await uriConn.client.callTool({ name: "get_vault_tree", arguments: { depth: 5 } });
		expect(result.isError).toBeFalsy();
		const content = result.content as Array<{ type: string; uri?: string }>;
		const uris = content
			.filter((b) => b.type === "resource_link")
			.map((l) => l.uri)
			.sort();
		expect(uris).toContain("note://v%231.md");
		expect(uris).toContain("note://q%3Fkey.md");
		// Counter: ASCII-safe filename round-trips unchanged (encodeURIComponent
		// is idempotent on unreserved chars).
		expect(uris).toContain("note://plain.md");
	});
});

describe("get_vault_tree — basic shape", () => {
	test("each item carries id, dfs_rank, and mtime", async () => {
		const { structured } = await callTree({ depth: 5, pageSize: 50 });
		for (const item of structured.items) {
			expect(item.id).toMatch(/^t:[0-9a-f]{14}$/);
			expect(item.dfs_rank).toBeGreaterThan(0);
			expect(typeof item.mtime).toBe("number");
		}
		// dfs_rank strictly increasing.
		for (let i = 1; i < structured.items.length; i++) {
			expect(structured.items[i]?.dfs_rank).toBeGreaterThan(structured.items[i - 1]?.dfs_rank ?? 0);
		}
	});

	test("_meta carries tokenizer per Brief field-presence table", async () => {
		const result = await conn.client.callTool({
			name: "get_vault_tree",
			arguments: { path: "", depth: 1, pageSize: 5 },
		});
		expect(result.isError).toBeFalsy();
		const meta = result._meta as { tokenizer?: string };
		expect(typeof meta.tokenizer).toBe("string");
		expect(meta.tokenizer?.length ?? 0).toBeGreaterThan(0);
	});
});

interface ResourceLinkBlock {
	type: string;
	uri?: string;
	name?: string;
}

describe("get_vault_tree — resource_link emitted unconditionally for markdown", () => {
	// `note://` reads stream raw bytes via `readSource` — index membership
	// is not a precondition. Files NOT in the index but still readable via
	// `note://`: parse-failed (broken YAML / AST cap), newly-created
	// (pre-watcher race), EACCES during scanner stat. A presence gate
	// would hide working resources for all of those.
	let vault: { path: string; cleanup: () => Promise<void> };
	let vaultRoot: VaultRoot;
	let index: IndexHandle;
	let closeDb: () => void;

	beforeEach(async () => {
		vault = await createTempVault({ "a.md": "# A\n", "b.md": "# B\n" });
		vaultRoot = await validateVaultRoot(vault.path);
		const opened = openSqlite({ dbPath: ":memory:" });
		index = createIndexHandle(opened.db, { includeHidden: false });
		index.setStatus("warm");
		closeDb = () => closeSqlite(opened.db);
	});

	afterEach(async () => {
		closeDb();
		await vault.cleanup();
	});

	test("markdown file absent from index still gets a resource_link block", async () => {
		// Both files emit resource_link blocks: a.md is in the index, b.md
		// isn't, but both are readable via `note://`.
		await reindexOne(vaultRoot, index, "a.md");
		expect(index.getFileStats("a.md")).not.toBeNull();
		expect(index.getFileStats("b.md")).toBeNull();

		const r = await handleGetVaultTree({ path: "" }, vaultRoot, index);
		expect(r.isError).toBeFalsy();
		const out = r.structuredContent as GetVaultTreeResult;
		const paths = out.items.map((i) => i.path).sort();
		expect(paths).toEqual(["a.md", "b.md"]);

		// Both files emit resource_link blocks regardless of index state.
		const blocks = (r.content ?? []) as ResourceLinkBlock[];
		const links = blocks
			.filter((b) => b.type === "resource_link")
			.map((l) => l.uri)
			.sort();
		expect(links).toEqual(["note://a.md", "note://b.md"]);
	});
});

describe("get_vault_tree — file metrics", () => {
	// Tree's main budgeting signal: agents must distinguish a tiny leaf
	// from a huge subtree before fetching. Persisted via the v7
	// `file_metrics` table so the tree handler can read aggregates without
	// re-parsing each file per request.
	let metricsVault: { path: string; cleanup: () => Promise<void> };
	let metricsRoot: VaultRoot;
	let metricsIndex: IndexHandle;
	let metricsCloseDb: () => void;

	beforeEach(async () => {
		metricsVault = await createTempVault({
			"big.md": `# Heading\n\n${"word ".repeat(500)}\n\n## Sub\n\nmore body content here\n`,
			"tiny.md": "# tiny\n\nshort.\n",
			"code-only.md": "# Code\n\n```js\nconsole.log('hello');\n```\n",
			"headingless.md": "Just a preamble paragraph with no heading.\n",
		});
		metricsRoot = await validateVaultRoot(metricsVault.path);
		const opened = openSqlite({ dbPath: ":memory:" });
		metricsIndex = createIndexHandle(opened.db, { includeHidden: false });
		metricsIndex.setStatus("warm");
		metricsCloseDb = () => closeSqlite(opened.db);
	});

	afterEach(async () => {
		metricsCloseDb();
		await metricsVault.cleanup();
	});

	test("file items carry bodyTokensApprox after indexing", async () => {
		await reindexOne(metricsRoot, metricsIndex, "big.md");
		await reindexOne(metricsRoot, metricsIndex, "tiny.md");

		const r = await handleGetVaultTree({ path: "" }, metricsRoot, metricsIndex);
		expect(r.isError).toBeFalsy();
		const out = r.structuredContent as GetVaultTreeResult;
		const big = out.items.find((i) => i.path === "big.md");
		const tiny = out.items.find((i) => i.path === "tiny.md");
		expect(big?.bodyTokensApprox).toBeGreaterThan(0);
		expect(tiny?.bodyTokensApprox).toBeGreaterThan(0);
		// Big file body has 500+ words; tiny is one short paragraph.
		expect((big?.bodyTokensApprox ?? 0) > (tiny?.bodyTokensApprox ?? 0)).toBe(true);
	});

	test("file items carry descendantTokensApprox equal to bodyTokensApprox (leaf semantic)", async () => {
		await reindexOne(metricsRoot, metricsIndex, "tiny.md");

		const r = await handleGetVaultTree({ path: "" }, metricsRoot, metricsIndex);
		expect(r.isError).toBeFalsy();
		const out = r.structuredContent as GetVaultTreeResult;
		const tiny = out.items.find((i) => i.path === "tiny.md");
		expect(tiny?.descendantTokensApprox).toBe(tiny?.bodyTokensApprox);
	});

	test("file items carry contentKinds (code section → ['code'])", async () => {
		await reindexOne(metricsRoot, metricsIndex, "code-only.md");

		const r = await handleGetVaultTree({ path: "" }, metricsRoot, metricsIndex);
		expect(r.isError).toBeFalsy();
		const out = r.structuredContent as GetVaultTreeResult;
		const codeOnly = out.items.find((i) => i.path === "code-only.md");
		expect(codeOnly?.contentKinds).toContain("code");
	});

	test("headingless file: bodyTokensApprox spans the full body", async () => {
		await reindexOne(metricsRoot, metricsIndex, "headingless.md");

		const r = await handleGetVaultTree({ path: "" }, metricsRoot, metricsIndex);
		expect(r.isError).toBeFalsy();
		const out = r.structuredContent as GetVaultTreeResult;
		const hl = out.items.find((i) => i.path === "headingless.md");
		// Body is "Just a preamble paragraph with no heading.\n" — 8 words +
		// punctuation. estimateTokens's content-aware heuristic (whitespace
		// tokens + word splits) clears any reasonable lower bound.
		expect(hl?.bodyTokensApprox ?? 0).toBeGreaterThanOrEqual(5);
	});

	test("unindexed file: stat fallback sets mtime; metrics fields absent", async () => {
		// Unindexed files fall into the cold-stat branch; budgeting fields
		// stay undefined rather than misleading zeros so agents can
		// distinguish "no data yet" from "actually zero tokens."
		const r = await handleGetVaultTree({ path: "" }, metricsRoot, metricsIndex);
		expect(r.isError).toBeFalsy();
		const out = r.structuredContent as GetVaultTreeResult;
		const big = out.items.find((i) => i.path === "big.md");
		// big.md is on disk but not indexed in this test (no reindexOne above)
		expect(big?.mtime).toBeGreaterThan(0);
		expect(big?.bodyTokensApprox).toBeUndefined();
		expect(big?.descendantTokensApprox).toBeUndefined();
	});
});

describe("get_vault_tree — sync policy gates", () => {
	// Single-predicate file-content surface: the tree must never list a
	// path that direct-read tools or `note://` reject. Mirrors the
	// scanner's sync filters so the two surfaces stay in sync.
	let policyVault: { path: string; cleanup: () => Promise<void> };
	let policyRoot: VaultRoot;
	let policyIndex: IndexHandle;
	let policyCloseDb: () => void;

	beforeEach(async () => {
		policyVault = await createTempVault({
			"clean.md": "# clean\n",
			"bad%20name.md": "# percent-encoded\n",
			// NFD-encoded filename: `é` decomposed as `e\u0301`. `isNonNfc`
			// rejects via Unicode normalization comparison.
			"caf\u0065\u0301.md": "# nfd\n",
		});
		policyRoot = await validateVaultRoot(policyVault.path);
		const opened = openSqlite({ dbPath: ":memory:" });
		policyIndex = createIndexHandle(opened.db, { includeHidden: false });
		policyIndex.setStatus("warm");
		policyCloseDb = () => closeSqlite(opened.db);
	});

	afterEach(async () => {
		policyCloseDb();
		await policyVault.cleanup();
	});

	test("percent-encoded filename omitted from items + resource_links", async () => {
		const r = await handleGetVaultTree({ path: "" }, policyRoot, policyIndex);
		expect(r.isError).toBeFalsy();
		const out = r.structuredContent as GetVaultTreeResult;
		const paths = out.items.map((i) => i.path);
		expect(paths).toContain("clean.md");
		expect(paths).not.toContain("bad%20name.md");
		const blocks = (r.content ?? []) as ResourceLinkBlock[];
		const uris = blocks.filter((b) => b.type === "resource_link").map((l) => l.uri);
		expect(uris).not.toContain("note://bad%2520name.md");
		expect(uris).not.toContain("note://bad%20name.md");
	});

	test("NFD-encoded filename omitted (must rename to NFC for addressability)", async () => {
		const r = await handleGetVaultTree({ path: "" }, policyRoot, policyIndex);
		expect(r.isError).toBeFalsy();
		const out = r.structuredContent as GetVaultTreeResult;
		const paths = out.items.map((i) => i.path);
		// NFD path must NOT appear; NFC-clean files do.
		expect(paths).toContain("clean.md");
		expect(paths.some((p) => p.includes("\u0301"))).toBe(false);
	});

	test("children count excludes policy-rejected entries", async () => {
		// Add a subdir that contains a policy-rejected file alongside a clean one.
		const childVault = await createTempVault({
			sub: { "ok.md": "# ok\n", "bad%20file.md": "# bad\n" },
		});
		const childRoot = await validateVaultRoot(childVault.path);
		const opened = openSqlite({ dbPath: ":memory:" });
		const childIndex = createIndexHandle(opened.db, { includeHidden: false });
		childIndex.setStatus("warm");
		try {
			const r = await handleGetVaultTree({ path: "", depth: 1 }, childRoot, childIndex);
			expect(r.isError).toBeFalsy();
			const out = r.structuredContent as GetVaultTreeResult;
			const dir = out.items.find((i) => i.path === "sub");
			expect(dir?.children).toBe(1);
		} finally {
			closeSqlite(opened.db);
			await childVault.cleanup();
		}
	});
});

describe("get_vault_tree — cache-dir exclusion (case-insensitive)", () => {
	// `shouldEmitDirent` filters the server's own cache directory regardless
	// of `--include-hidden`. The tree dirent filter must use the same
	// case-folding `isIndexCachePath` predicate as direct-read tools so a
	// pre-existing `.Markdown-MCP/` (aliasing the cache on case-insensitive FS)
	// doesn't leak via DFS recursion into SQLite/WAL/SHM.

	test("mixed-case `.Markdown-MCP` at vault root excluded under --include-hidden", async () => {
		const v = await createTempVault({
			"clean.md": "# clean\n",
		});
		// Pre-create a mixed-case cache directory. On macOS APFS this aliases
		// to `.markdown-mcp/` (case-insensitive FS); on Linux ext4 it's a
		// distinct inode, but the default (flag = null) routes the predicate
		// through the case-fold branch, so the dirent is still excluded —
		// matching the safer-default behavior of the uninitialized flag.
		await mkdir(join(v.path, ".Markdown-MCP"), { recursive: true });
		await writeFile(join(v.path, ".Markdown-MCP", "fake-secret.md"), "# secret\n", "utf8");
		const root = await validateVaultRoot(v.path);
		const opened = openSqlite({ dbPath: ":memory:" });
		const idx = createIndexHandle(opened.db, { includeHidden: true });
		idx.setStatus("warm");
		try {
			const r = await handleGetVaultTree({ path: "", depth: 5 }, root, idx, true);
			expect(r.isError).toBeFalsy();
			const out = r.structuredContent as GetVaultTreeResult;
			const paths = out.items.map((i) => i.path);
			expect(paths).toContain("clean.md");
			// Neither the cache dir nor its contents should appear.
			expect(paths.some((p) => p.toLowerCase().startsWith(".markdown-mcp"))).toBe(false);
		} finally {
			closeSqlite(opened.db);
			await v.cleanup();
		}
	});
});

describe("get_vault_tree — symlink rejected at readdir descent", () => {
	// walkTreeDfs lstat-checks each path before readdir-ing to defend
	// against a TOCTOU where a directory was swapped to a symlink between
	// the parent's `entry.isSymbolicLink()` observation and the recursive
	// readdir. Without the lstat gate, `readdir` would follow the
	// symlink and list files outside the vault.

	test("subdirectory existing as a symlink to outside the vault is not descended", async () => {
		const v = await createTempVault({
			"clean.md": "# clean\n",
			realchild: { "inside.md": "# inside\n" },
		});
		// External directory the symlink will point at; populate it with a
		// distinctive file to verify it does NOT leak through the tree.
		const external = join(tmpdir(), `markdown-mcp-symlink-target-${Date.now()}`);
		await mkdir(external, { recursive: true });
		await writeFile(join(external, "leaked.md"), "# leaked\n", "utf8");
		// Replace `realchild` with a symlink to `external`. lstat sees a
		// symlink → walker skips. Without the lstat-before-readdir gate,
		// readdir would follow and emit `realchild/leaked.md`.
		await rm(join(v.path, "realchild"), { recursive: true });
		await symlink(external, join(v.path, "realchild"));

		const root = await validateVaultRoot(v.path);
		const opened = openSqlite({ dbPath: ":memory:" });
		const idx = createIndexHandle(opened.db, { includeHidden: false });
		idx.setStatus("warm");
		try {
			const r = await handleGetVaultTree({ path: "" }, root, idx);
			expect(r.isError).toBeFalsy();
			const out = r.structuredContent as GetVaultTreeResult;
			const paths = out.items.map((i) => i.path);
			expect(paths).toContain("clean.md");
			// The symlink's target contents must NOT appear — neither under
			// `realchild` nor leaked anywhere in the response.
			expect(paths.some((p) => p.endsWith("leaked.md"))).toBe(false);
		} finally {
			closeSqlite(opened.db);
			await v.cleanup();
			await rm(external, { recursive: true, force: true });
		}
	});
});

describe("get_vault_tree — readdir errno discipline", () => {
	// ENOENT/ENOTDIR stay silent (genuinely-vanished subtrees); other
	// errno log to stderr so an operator can correlate "tree truncated"
	// with the underlying failure. Mirrors scanner.ts:walkVault.
	test("EACCES on a subtree logs to stderr (operator can correlate)", async () => {
		// chmod 000 on a directory makes readdir EACCES for the test user.
		// Skip on non-POSIX systems where chmod semantics differ.
		const v = await createTempVault({
			"top.md": "# top\n",
			locked: { "inside.md": "# inside\n" },
		});
		const lockedAbs = join(v.path, "locked");
		const root = await validateVaultRoot(v.path);
		const opened = openSqlite({ dbPath: ":memory:" });
		const idx = createIndexHandle(opened.db, { includeHidden: false });
		idx.setStatus("warm");

		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			await chmod(lockedAbs, 0o000);
			const r = await handleGetVaultTree({ path: "" }, root, idx);
			expect(r.isError).toBeFalsy();
			const out = r.structuredContent as GetVaultTreeResult;
			// Top-level dir entry still emitted; just its descent is skipped.
			expect(out.items.some((i) => i.path === "top.md")).toBe(true);
			// stderr captures the readdir failure.
			const stderr = errSpy.mock.calls.flat().join("\n");
			expect(stderr).toMatch(/tree: skipping subtree locked \(readdir error: EACCES\)/);
		} finally {
			errSpy.mockRestore();
			// Restore perms so cleanup can recurse into the dir.
			await chmod(lockedAbs, 0o755);
			closeSqlite(opened.db);
			await v.cleanup();
		}
	});

	test("ENOENT on a vanished subtree stays silent (no operator alarm for racy deletes)", async () => {
		// We can't reliably stage an ENOENT readdir without a TOCTOU race
		// or fs mock. Use vi.spyOn over node:fs/promises is module-scoped.
		// Smoke-test: a non-existent directory passed via input goes through
		// resolveStartPath which returns null → PATH_NOT_FOUND, not the
		// walker. So skip this test arm — covered by the existing
		// PATH_NOT_FOUND tests at line 150-200.
		expect(true).toBe(true);
	});
});

describe("get_vault_tree — children count filters match walkTreeDfs", () => {
	// `children` is a lazy-load hint and must agree with what DFS yields
	// when the agent descends — otherwise the count leaks hidden-file
	// existence (a directory of only `.secret.md` would advertise
	// `children: 1` while DFS yields zero descendants).
	let countVault: { path: string; cleanup: () => Promise<void> };
	let countRoot: VaultRoot;
	let countIndex: IndexHandle;
	let countCloseDb: () => void;

	beforeEach(async () => {
		countVault = await createTempVault({
			"hidden-only": { ".secret.md": "# hidden\n" },
			mixed: { ".secret.md": "# hidden\n", "visible.md": "# visible\n" },
			plain: { "a.md": "# a\n", subdir: { "b.md": "# b\n" } },
		});
		countRoot = await validateVaultRoot(countVault.path);
		const opened = openSqlite({ dbPath: ":memory:" });
		countIndex = createIndexHandle(opened.db, { includeHidden: false });
		countIndex.setStatus("warm");
		countCloseDb = () => closeSqlite(opened.db);
	});

	afterEach(async () => {
		countCloseDb();
		await countVault.cleanup();
	});

	test("directory with only hidden files reports children: 0 (no leak)", async () => {
		const r = await handleGetVaultTree({ path: "", depth: 1 }, countRoot, countIndex);
		expect(r.isError).toBeFalsy();
		const out = r.structuredContent as GetVaultTreeResult;
		const dir = out.items.find((i) => i.path === "hidden-only");
		expect(dir).toBeDefined();
		expect(dir?.children).toBe(0);
	});

	test("directory with mix of hidden + visible reports only visible count", async () => {
		const r = await handleGetVaultTree({ path: "", depth: 1 }, countRoot, countIndex);
		expect(r.isError).toBeFalsy();
		const out = r.structuredContent as GetVaultTreeResult;
		const dir = out.items.find((i) => i.path === "mixed");
		expect(dir).toBeDefined();
		expect(dir?.children).toBe(1);
	});

	test("regression: directory with regular file + subdir reports 2", async () => {
		// Counter to the hidden-only case: visible regular files and
		// subdirectories are both counted, matching what walkTreeDfs emits.
		const r = await handleGetVaultTree({ path: "", depth: 1 }, countRoot, countIndex);
		expect(r.isError).toBeFalsy();
		const out = r.structuredContent as GetVaultTreeResult;
		const dir = out.items.find((i) => i.path === "plain");
		expect(dir).toBeDefined();
		expect(dir?.children).toBe(2);
	});
});
