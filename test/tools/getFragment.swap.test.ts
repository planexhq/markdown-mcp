/**
 * `handleGetFragment` stable_id-resolution tests.
 *
 * Outline IDs are authoritative (D27 — `stable_id` is a slot hash). When
 * the cached id resolves in `parsed.headings`, the resolver returns it
 * directly as `fresh`; fuzzy recovery only fires when the id is NOT in
 * the current outline (genuine retirement or slot move).
 *
 * Coverage:
 *   - Sibling swap: outline ID returns the current heading as `fresh`.
 *   - Rename in place: outline still has the ID → fresh.
 *   - Pure survivor (same id + same text): fresh.
 *   - Slot moved (heading promoted/demoted): cached id NOT in the new
 *     outline → fuzzy recovery fires with a text-match primary marked
 *     `stale`.
 *   - Genuinely retired stable_id with no recoverable candidate:
 *     `HEADING_NOT_FOUND` with empty fuzzy.
 */

import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { createIndexHandle, type IndexHandle } from "../../src/lib/index/IndexHandle.js";
import { scanVault } from "../../src/lib/index/scanner.js";
import { closeSqlite, openSqlite } from "../../src/lib/index/sqlite.js";
import { type VaultRoot, validateVaultRoot } from "../../src/lib/validatePath.js";
import { handleGetFragment } from "../../src/tools/getFragment.js";
import type { FragmentResult, MetaEnvelope, VaultError } from "../../src/types.js";
import { createTempVault } from "../helpers/vault.js";

interface Setup {
	vault: { path: string; cleanup: () => Promise<void> };
	opened: ReturnType<typeof openSqlite>;
	index: IndexHandle;
	vaultRoot: VaultRoot;
	teardown: () => Promise<void>;
}

const setups: Setup[] = [];

async function setup(initial: string, file = "swap.md"): Promise<Setup> {
	const vault = await createTempVault({ [file]: initial });
	const opened = openSqlite({ dbPath: ":memory:" });
	const index = createIndexHandle(opened.db, { includeHidden: false });
	// Use the production startup helper so the test exercises the same
	// realpath-canonicalization the server does — without it, macOS
	// `/var/folders/...` symlinks make `path.relative` report containment
	// failures from validatePath.
	const vaultRoot: VaultRoot = await validateVaultRoot(vault.path);
	const s: Setup = {
		vault,
		opened,
		index,
		vaultRoot,
		teardown: async () => {
			closeSqlite(opened.db);
			await vault.cleanup();
		},
	};
	setups.push(s);
	return s;
}

afterEach(async () => {
	while (setups.length > 0) {
		const s = setups.pop();
		if (s) await s.teardown();
	}
});

describe("handleGetFragment — stable_id resolution (D27 outline-authoritative)", () => {
	test("sibling swap: post-swap fresh ID resolves to current heading as fresh", async () => {
		// Pre-swap: # Alpha (slot 0 → h:X), # Beta (slot 1 → h:Y).
		// Post-swap: # Beta (slot 0 → h:X), # Alpha (slot 1 → h:Y). Hash set
		// preserved; texts swap. Outline-authoritative rule: requesting
		// h:X returns Beta (the heading currently at that slot) as fresh.
		const s = await setup("# Alpha\n\n# Beta\n");
		await scanVault({ vaultRoot: s.vaultRoot, index: s.index, concurrency: 1 });

		await writeFile(join(s.vault.path, "swap.md"), "# Beta\n\n# Alpha\n");
		await scanVault({ vaultRoot: s.vaultRoot, index: s.index, concurrency: 1 });

		// Read the post-swap IDs straight from the index (production agents
		// would call get_file_outline; the on-disk DB is authoritative).
		const postSwapIds = listHeadingIds(s.opened.db, "swap.md");
		const idForCurrentBeta = postSwapIds.Beta;

		const result = await handleGetFragment(
			{ file: "swap.md", anchor: { kind: "file" }, stable_id: idForCurrentBeta },
			s.vaultRoot,
			s.index,
		);
		expect(result.isError).toBeFalsy();
		const fragment = result.structuredContent as FragmentResult & {
			stable_id_status: string;
			heading_path: string[];
		};
		expect(fragment.stable_id_status).toBe("fresh");
		expect(fragment.heading_path).toEqual(["Beta"]);
		const meta = result._meta as MetaEnvelope;
		expect(meta.fuzzy_algorithm).toBeUndefined();
	});

	test("rename in place → fresh (no history written; outline still has the ID)", async () => {
		const s = await setup("# Apha\n\n# Other\n", "rename.md");
		await scanVault({ vaultRoot: s.vaultRoot, index: s.index, concurrency: 1 });
		const ids = listHeadingIds(s.opened.db, "rename.md");
		const cachedAphaId = ids.Apha;

		await writeFile(join(s.vault.path, "rename.md"), "# Alpha\n\n# Other\n");
		await scanVault({ vaultRoot: s.vaultRoot, index: s.index, concurrency: 1 });

		const result = await handleGetFragment(
			{ file: "rename.md", anchor: { kind: "file" }, stable_id: cachedAphaId },
			s.vaultRoot,
			s.index,
		);
		expect(result.isError).toBeFalsy();
		const fragment = result.structuredContent as FragmentResult & {
			stable_id_status: string;
			heading_path: string[];
		};
		expect(fragment.stable_id_status).toBe("fresh");
		expect(fragment.heading_path).toEqual(["Alpha"]);
		const meta = result._meta as MetaEnvelope;
		expect(meta.fuzzy_algorithm).toBeUndefined();
	});

	test("pure survivor (same id + same text) → fresh (regression guard)", async () => {
		const s = await setup("# Same\n\nbody\n", "survivor.md");
		await scanVault({ vaultRoot: s.vaultRoot, index: s.index, concurrency: 1 });
		const ids = listHeadingIds(s.opened.db, "survivor.md");

		await scanVault({ vaultRoot: s.vaultRoot, index: s.index, concurrency: 1 });
		const result = await handleGetFragment(
			{ file: "survivor.md", anchor: { kind: "file" }, stable_id: ids.Same },
			s.vaultRoot,
			s.index,
		);
		expect(result.isError).toBeFalsy();
		const fragment = result.structuredContent as FragmentResult & {
			stable_id_status: string;
		};
		expect(fragment.stable_id_status).toBe("fresh");
	});

	test("slot moved (heading promoted to top-level) → fuzzy recovery fires, returns stale text-match", async () => {
		// Pre-edit: # A then ## B (B is a child of A — structural_path
		// `h1[0]/h2[0]`). Post-edit: # A then # B (B promoted to top-level
		// — structural_path `h1[1]`). The cached B-ID is no longer in the
		// outline; confidence-gated fuzzy recovers via text match.
		const s = await setup("# A\n\n## B\n\nbody\n", "slot.md");
		await scanVault({ vaultRoot: s.vaultRoot, index: s.index, concurrency: 1 });
		const cachedBId = listHeadingIds(s.opened.db, "slot.md").B;

		await writeFile(join(s.vault.path, "slot.md"), "# A\n\n# B\n\nbody\n");
		await scanVault({ vaultRoot: s.vaultRoot, index: s.index, concurrency: 1 });

		const result = await handleGetFragment(
			{ file: "slot.md", anchor: { kind: "file" }, stable_id: cachedBId },
			s.vaultRoot,
			s.index,
		);
		expect(result.isError).toBeFalsy();
		const fragment = result.structuredContent as FragmentResult & {
			stable_id_status: string;
			requested_stable_id?: string;
			heading_path: string[];
		};
		expect(fragment.stable_id_status).toBe("stale");
		expect(fragment.requested_stable_id).toBe(cachedBId);
		expect(fragment.heading_path).toEqual(["B"]);
		const meta = result._meta as MetaEnvelope;
		expect(meta.fuzzy_algorithm).toBe("stable-id-fuzzy-v1");
	});

	test("genuinely retired stable_id with empty fuzzy → HEADING_NOT_FOUND (regression guard)", async () => {
		const s = await setup("# OnlyHeading\n\nbody\n", "retired.md");
		await scanVault({ vaultRoot: s.vaultRoot, index: s.index, concurrency: 1 });

		const result = await handleGetFragment(
			{ file: "retired.md", anchor: { kind: "file" }, stable_id: "h:0000000000abcd" },
			s.vaultRoot,
			s.index,
		);
		expect(result.isError).toBe(true);
		const err = result.structuredContent as VaultError & {
			stable_id_status?: string;
			candidates?: unknown[];
		};
		expect(err.code).toBe("HEADING_NOT_FOUND");
		expect(err.stable_id_status).toBe("stale");
		expect(err.candidates).toHaveLength(0);
	});
});

describe("handleGetFragment — embed expansion preserves missing-heading state", () => {
	test("![[target#missing]] returns unresolved_heading, NOT whole-file content", async () => {
		// `headingResolutionFailed` lives only on `ResolvedWikilink` (not on
		// the persisted `Embed`), so handleGetFragment must re-resolve from
		// `raw_target` to recover it; otherwise `![[target#missing]]` falls
		// through to whole-file expansion and leaks target.md's body.
		const vault = await createTempVault({
			"host.md": "![[target#nope]]\n",
			"target.md": "# Other\n\nSecret content that must not leak.\n",
		});
		const opened = openSqlite({ dbPath: ":memory:" });
		const index = createIndexHandle(opened.db, { includeHidden: false });
		const vaultRoot: VaultRoot = await validateVaultRoot(vault.path);
		setups.push({
			vault,
			opened,
			index,
			vaultRoot,
			teardown: async () => {
				closeSqlite(opened.db);
				await vault.cleanup();
			},
		});
		await scanVault({ vaultRoot, index, concurrency: 1 });

		const result = await handleGetFragment(
			{ file: "host.md", anchor: { kind: "file" }, expand_embeds: true },
			vaultRoot,
			index,
		);
		expect(result.isError).toBeFalsy();
		const fragment = result.structuredContent as FragmentResult;
		expect(fragment.embeds).toHaveLength(1);
		const embed = fragment.embeds[0];
		expect(embed?.expansion_error).toBe("unresolved_heading");
		expect(embed?.expanded).toBe(false);
		expect(embed?.expanded_content).toBeUndefined();
	});

	test("![[target]] without anchor still expands the whole file (counter-test)", async () => {
		// Confirms N1's fix doesn't regress the heading-less embed path.
		const vault = await createTempVault({
			"host.md": "![[target]]\n",
			"target.md": "# Other\n\nWhole-file body.\n",
		});
		const opened = openSqlite({ dbPath: ":memory:" });
		const index = createIndexHandle(opened.db, { includeHidden: false });
		const vaultRoot: VaultRoot = await validateVaultRoot(vault.path);
		setups.push({
			vault,
			opened,
			index,
			vaultRoot,
			teardown: async () => {
				closeSqlite(opened.db);
				await vault.cleanup();
			},
		});
		await scanVault({ vaultRoot, index, concurrency: 1 });

		const result = await handleGetFragment(
			{ file: "host.md", anchor: { kind: "file" }, expand_embeds: true },
			vaultRoot,
			index,
		);
		const fragment = result.structuredContent as FragmentResult;
		expect(fragment.embeds[0]?.expanded).toBe(true);
		expect(fragment.embeds[0]?.expanded_content).toContain("Whole-file body");
	});
});

/** Map of heading_text → stable_id, read directly from `fragments` for the
 *  given file. The scanner doesn't expose the assigned IDs through any
 *  public API, but they're authoritative inside the DB. */
function listHeadingIds(db: import("better-sqlite3").Database, file: string): Record<string, string> {
	const rows = db
		.prepare("SELECT stable_id, heading_text FROM fragments WHERE file = ? AND anchor_kind = 'heading'")
		.all(file) as Array<{ stable_id: string; heading_text: string }>;
	const map: Record<string, string> = {};
	for (const r of rows) map[r.heading_text] = r.stable_id;
	return map;
}
