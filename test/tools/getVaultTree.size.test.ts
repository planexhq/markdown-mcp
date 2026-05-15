/**
 * D37 + D41: `VaultTreeItem.size_bytes` is the on-disk byte count read
 * via live `lstat`, matching `get_fragment.file_size_bytes`' read-path
 * source. Pre-D41, the value was read from indexed `fragments.size`
 * and could lag disk for the watcher-debounce window — surfacing a
 * false-positive integrity mismatch on normal post-edit cross-checks.
 * Absent for symlinks (defense against leaf-symlink swaps) and
 * directories.
 */

import { stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";

import { createIndexHandle, type IndexHandle } from "../../src/lib/index/IndexHandle.js";
import { scanVault } from "../../src/lib/index/scanner.js";
import { closeSqlite, openSqlite } from "../../src/lib/index/sqlite.js";
import { type VaultRoot, validateVaultRoot } from "../../src/lib/validatePath.js";
import { handleGetVaultTree } from "../../src/tools/getVaultTree.js";
import type { GetVaultTreeResult, VaultTreeItem } from "../../src/types.js";
import { spawnTestServer, type TestClient, waitForWarm } from "../helpers/mcp-client.js";
import { createTempVault } from "../helpers/vault.js";

const SHORT_FILE = "# Short\n";
const LONGER_FILE = `# Longer\n\n${"x".repeat(2048)}\n`;

let vault: { path: string; cleanup: () => Promise<void> };
let conn: TestClient;

beforeAll(async () => {
	vault = await createTempVault({
		"short.md": SHORT_FILE,
		"longer.md": LONGER_FILE,
		nested: { "deep.md": "# Deep\n" },
	});
	conn = await spawnTestServer(vault.path);
	await waitForWarm(conn.client);
}, 30_000);

afterAll(async () => {
	await conn.close();
	await vault.cleanup();
});

async function fetchTree(): Promise<VaultTreeItem[]> {
	const r = await conn.client.callTool({ name: "get_vault_tree", arguments: { depth: 5, pageSize: 50 } });
	expect(r.isError).toBeFalsy();
	const sc = r.structuredContent as GetVaultTreeResult;
	return sc.items;
}

describe("get_vault_tree.items[].size_bytes — file items", () => {
	test("indexed markdown files carry `size_bytes` matching fs.stat().size", async () => {
		const items = await fetchTree();
		const short = items.find((i) => i.path === "short.md");
		const longer = items.find((i) => i.path === "longer.md");
		expect(short).toBeDefined();
		expect(longer).toBeDefined();

		const shortDiskSize = (await stat(join(vault.path, "short.md"))).size;
		const longerDiskSize = (await stat(join(vault.path, "longer.md"))).size;

		expect(short?.size_bytes).toBe(shortDiskSize);
		expect(longer?.size_bytes).toBe(longerDiskSize);
	});

	test("directories do NOT carry `size_bytes`", async () => {
		const items = await fetchTree();
		const nested = items.find((i) => i.path === "nested" && i.type === "dir");
		expect(nested).toBeDefined();
		expect(nested?.size_bytes).toBeUndefined();
	});

	test("nested-folder file also carries size_bytes", async () => {
		const items = await fetchTree();
		const deep = items.find((i) => i.path === "nested/deep.md");
		expect(deep).toBeDefined();
		const diskSize = (await stat(join(vault.path, "nested/deep.md"))).size;
		expect(deep?.size_bytes).toBe(diskSize);
	});
});

describe("get_vault_tree.items[].size_bytes — D41 live-stat behavior", () => {
	let v: { path: string; cleanup: () => Promise<void> } | undefined;
	let opened: ReturnType<typeof openSqlite> | undefined;
	let index: IndexHandle;
	let vaultRoot: VaultRoot;

	beforeEach(async () => {
		v = undefined;
		opened = undefined;
		v = await createTempVault({ "notes.md": "# Notes\n" });
		vaultRoot = await validateVaultRoot(v.path);
		opened = openSqlite({ dbPath: ":memory:" });
		index = createIndexHandle(opened.db, { includeHidden: false });
		index.setStatus("warming");
		await scanVault({ vaultRoot, index, concurrency: 1 });
	});

	afterEach(async () => {
		if (opened) closeSqlite(opened.db);
		if (v) await v.cleanup();
	});

	test("size_bytes reflects disk, not stale fragments.size, after a post-warm edit", async () => {
		const abs = join(vaultRoot.absolute, "notes.md");
		const initialSize = (await stat(abs)).size;
		expect(index.getFileMeta("notes.md")?.size).toBe(initialSize);

		await writeFile(abs, `# Notes\n\n${"x".repeat(1024)}\n`, "utf8");
		const liveSize = (await stat(abs)).size;
		expect(liveSize).not.toBe(initialSize);
		expect(index.getFileMeta("notes.md")?.size).toBe(initialSize); // index still stale

		const r = await handleGetVaultTree({ path: "" }, vaultRoot, index);
		expect(r.isError).toBeFalsy();
		const items = (r.structuredContent as GetVaultTreeResult).items;
		const notes = items.find((i: VaultTreeItem) => i.path === "notes.md");
		expect(notes?.size_bytes).toBe(liveSize);
		expect(notes?.size_bytes).not.toBe(initialSize);
	});

	// FAT/exFAT 2 s mtime resolution (Windows CI) makes the rewrite land
	// in the same tick as the cold scan; deterministic-bump via `utimes`.
	test("mtime also reflects disk (single live-stat covers both fields)", async () => {
		const abs = join(vaultRoot.absolute, "notes.md");
		const indexedMtime = index.getFileMtime("notes.md") ?? 0;
		expect(indexedMtime).toBeGreaterThan(0);

		await writeFile(abs, "# Notes updated\n", "utf8");
		const futureSec = Math.floor(Date.now() / 1000) + 5;
		await utimes(abs, futureSec, futureSec);
		const liveMtime = (await stat(abs)).mtimeMs;
		expect(liveMtime).toBeGreaterThan(indexedMtime);

		const r = await handleGetVaultTree({ path: "" }, vaultRoot, index);
		const items = (r.structuredContent as GetVaultTreeResult).items;
		const notes = items.find((i: VaultTreeItem) => i.path === "notes.md");
		expect(notes?.mtime).toBe(liveMtime);
		expect(notes?.mtime).not.toBe(indexedMtime);
	});
});
