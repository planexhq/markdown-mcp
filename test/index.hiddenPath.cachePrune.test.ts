/**
 * `confirmPrune` must drop pre-existing `.markdown-mcp/*` rows even under
 * `--include-hidden`. `walkVault` skips the cache dir unconditionally,
 * so any row the index already holds for a path under `.markdown-mcp/`
 * reaches the prune-candidates list (in DB, but walk skipped). Without
 * the cache-prefix gate in `confirmPrune`, markdown + non-hidden-gate +
 * `lstat`-says-regular-file preserves the row, and search/get_links
 * keep surfacing cache content despite tree/direct reads rejecting it.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import type { SearchOutput } from "../src/types.js";
import { spawnTestServer, waitForWarm } from "./helpers/mcp-client.js";
import { createTempVault, type VaultStructure } from "./helpers/vault.js";

const FIXTURE: VaultStructure = {
	"plain.md": "# Plain\n\nVisible note. cachepruneunique marker.\n",
};

let vault: { path: string; cleanup: () => Promise<void> };

beforeEach(async () => {
	vault = await createTempVault(FIXTURE);
});

afterEach(async () => {
	await vault.cleanup();
});

async function plantCacheDirNote(vaultPath: string): Promise<void> {
	const cacheDir = join(vaultPath, ".markdown-mcp");
	await mkdir(cacheDir, { recursive: true });
	await writeFile(join(cacheDir, "notes.md"), "# Cache leak\n\nshouldnotleaktoken sentinel.\n");
}

function plantCacheDirRow(vaultPath: string): void {
	const dbPath = join(vaultPath, ".markdown-mcp", "index.sqlite3");
	const db = new Database(dbPath);
	try {
		// Sentinel token routes through both `body` and `headings` FTS
		// columns so a `bm25-fragment-v1` query confirms the row's
		// existence (and after the prune fires, its absence).
		db.prepare(`INSERT INTO frontmatter (file, created, updated, fields_json) VALUES (:file, NULL, NULL, '{}')`).run({
			file: ".markdown-mcp/notes.md",
		});
		db.prepare(
			`INSERT INTO fragments
			   (file, anchor_kind, stable_id, heading_path_json, heading_text, structural_path,
			    range_start, range_end, body, code, headings, mtime, size)
			 VALUES (:file, 'heading', :sid, :hp, :ht, :sp, 0, 200, :body, '', :ht, :mtime, :size)`,
		).run({
			file: ".markdown-mcp/notes.md",
			sid: "h:abc123def45678",
			hp: '["Cache leak"]',
			ht: "Cache leak",
			sp: "h1[0]",
			body: "shouldnotleaktoken sentinel.",
			mtime: Date.now(),
			size: 50,
		});
	} finally {
		db.close();
	}
}

describe("confirmPrune .markdown-mcp gate", () => {
	test("pre-existing .markdown-mcp row is pruned under --include-hidden", async () => {
		// First lifecycle: let the server create the index + schema so we
		// can plant rows against the real shape (the FTS5 triggers + checks
		// require the trigger DDL to be in place).
		const seed = await spawnTestServer(vault.path);
		await waitForWarm(seed.client);
		await seed.close();
		// Allow closeSqlite + wal_checkpoint to flush before we open the DB
		// for the manual plant.
		await new Promise((r) => setTimeout(r, 150));

		await plantCacheDirNote(vault.path);
		plantCacheDirRow(vault.path);

		// Sanity: the planted row is present in the DB before the second
		// lifecycle runs the prune — same FTS-trigger path the scanner uses.
		{
			const db = new Database(join(vault.path, ".markdown-mcp", "index.sqlite3"), { readonly: true });
			try {
				const row = db.prepare(`SELECT file FROM fragments WHERE file = '.markdown-mcp/notes.md' LIMIT 1`).get() as
					| { file: string }
					| undefined;
				expect(row?.file).toBe(".markdown-mcp/notes.md");
			} finally {
				db.close();
			}
		}

		// Second lifecycle: --include-hidden. Scanner walks vault but skips
		// `.markdown-mcp/` so prune candidates include the planted row.
		// `confirmPrune`'s cache-prefix gate returns true regardless of
		// the hidden gate, and the row goes.
		const probe = await spawnTestServer(vault.path, {}, ["--include-hidden"]);
		try {
			await waitForWarm(probe.client);

			const search = await probe.client.callTool({
				name: "search",
				arguments: { query: "shouldnotleaktoken" },
			});
			const files = (search.structuredContent as SearchOutput).items.map((i) => i.file);
			expect(files).not.toContain(".markdown-mcp/notes.md");
		} finally {
			await probe.close();
		}

		// Confirm the underlying row is gone, not just filtered at the
		// query layer (which carries no cache-path predicate).
		{
			const db = new Database(join(vault.path, ".markdown-mcp", "index.sqlite3"), { readonly: true });
			try {
				const row = db.prepare(`SELECT file FROM fragments WHERE file = '.markdown-mcp/notes.md' LIMIT 1`).get() as
					| { file: string }
					| undefined;
				expect(row).toBeUndefined();
			} finally {
				db.close();
			}
		}
	}, 45_000);
});
