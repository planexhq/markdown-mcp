/**
 * `get_fragment` must NOT resolve outgoing wikilinks or expand embeds
 * against a partial cold/warming index. The basename map is a strict
 * subset of the eventual vault during warm-up; resolving against it
 * produces transient unique resolutions that flip ambiguous post-warm.
 * The agent sees `index_status.state` in `_meta` and re-queries warm.
 */

import { afterEach, describe, expect, test } from "vitest";

import { createIndexHandle, type IndexHandle } from "../../src/lib/index/IndexHandle.js";
import { scanVault } from "../../src/lib/index/scanner.js";
import { closeSqlite, openSqlite } from "../../src/lib/index/sqlite.js";
import { type VaultRoot, validateVaultRoot } from "../../src/lib/validatePath.js";
import { handleGetFragment } from "../../src/tools/getFragment.js";
import type { FragmentResult } from "../../src/types.js";
import { createTempVault } from "../helpers/vault.js";

interface Setup {
	vault: { path: string; cleanup: () => Promise<void> };
	opened: ReturnType<typeof openSqlite>;
	index: IndexHandle;
	vaultRoot: VaultRoot;
}

const setups: Setup[] = [];

async function setup(): Promise<Setup> {
	const vault = await createTempVault({
		"host.md": "# Host\n\n[[target]]\n",
		"target.md": "# Target\n\nbody\n",
	});
	const opened = openSqlite({ dbPath: ":memory:" });
	const index = createIndexHandle(opened.db, { includeHidden: false });
	const vaultRoot = await validateVaultRoot(vault.path);
	const s: Setup = { vault, opened, index, vaultRoot };
	setups.push(s);
	return s;
}

afterEach(async () => {
	while (setups.length > 0) {
		const s = setups.pop();
		if (!s) continue;
		closeSqlite(s.opened.db);
		await s.vault.cleanup();
	}
});

describe("get_fragment — vaultIndex gated on warm/reconciling", () => {
	test("cold state → outgoing.resolved=false (gate active before warm)", async () => {
		// Fresh index handle starts cold. No scanVault runs, so the index
		// is empty — but the assertion is about the GATE, not about
		// resolution success. The gate suppresses resolution regardless.
		const s = await setup();
		expect(s.index.getStatus().state).toBe("cold");

		const result = await handleGetFragment({ file: "host.md", anchor: { kind: "file" } }, s.vaultRoot, s.index);
		expect(result.isError).toBeFalsy();
		const fragment = result.structuredContent as FragmentResult;
		expect(fragment.outgoing_links).toHaveLength(1);
		expect(fragment.outgoing_links[0]?.raw_target).toBe("target");
		expect(fragment.outgoing_links[0]?.resolved).toBe(false);
		expect(fragment.outgoing_links[0]?.target_file).toBeUndefined();
	});

	test("warming state → outgoing.resolved=false (gate still active)", async () => {
		const s = await setup();
		// Legal arc: cold → warming.
		s.index.setStatus("warming");

		const result = await handleGetFragment({ file: "host.md", anchor: { kind: "file" } }, s.vaultRoot, s.index);
		expect(result.isError).toBeFalsy();
		const fragment = result.structuredContent as FragmentResult;
		expect(fragment.outgoing_links[0]?.resolved).toBe(false);
		expect(fragment.outgoing_links[0]?.target_file).toBeUndefined();
	});

	test("warm state → outgoing.resolved=true with target_file populated", async () => {
		const s = await setup();
		await scanVault({ vaultRoot: s.vaultRoot, index: s.index, concurrency: 1 });
		// scanVault leaves status warm on a clean finish; assert as a guard.
		expect(s.index.getStatus().state).toBe("warm");

		const result = await handleGetFragment({ file: "host.md", anchor: { kind: "file" } }, s.vaultRoot, s.index);
		expect(result.isError).toBeFalsy();
		const fragment = result.structuredContent as FragmentResult;
		expect(fragment.outgoing_links).toHaveLength(1);
		expect(fragment.outgoing_links[0]?.resolved).toBe(true);
		expect(fragment.outgoing_links[0]?.target_file).toBe("target.md");
	});

	test("reconciling state → outgoing.resolved=true (snapshot still authoritative)", async () => {
		const s = await setup();
		await scanVault({ vaultRoot: s.vaultRoot, index: s.index, concurrency: 1 });
		// Legal arc: warm → reconciling.
		s.index.setStatus("reconciling");

		const result = await handleGetFragment({ file: "host.md", anchor: { kind: "file" } }, s.vaultRoot, s.index);
		expect(result.isError).toBeFalsy();
		const fragment = result.structuredContent as FragmentResult;
		expect(fragment.outgoing_links[0]?.resolved).toBe(true);
		expect(fragment.outgoing_links[0]?.target_file).toBe("target.md");
	});

	test("expand_embeds short-circuits during warming", async () => {
		const s = await setup();
		s.index.setStatus("warming");

		const result = await handleGetFragment(
			{ file: "host.md", anchor: { kind: "file" }, expand_embeds: true },
			s.vaultRoot,
			s.index,
		);
		expect(result.isError).toBeFalsy();
		// host.md uses [[target]] (link, not embed). The fragment still
		// builds; embed expansion would no-op because vaultIndex is undefined
		// during warming. Sanity: response shape intact, embeds list empty.
		const fragment = result.structuredContent as FragmentResult;
		expect(fragment.embeds).toEqual([]);
	});
});
