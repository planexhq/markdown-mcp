/**
 * Embed cycle host-seed test.
 *
 * Without seeding `visited` with the host fragment's cycle key, an
 * `a.md → b.md → a.md` chain recurses one level too deep before the
 * cycle detector fires. The host body re-appears inside b's expansion
 * because the second `a` reference resolves cleanly.
 *
 * `maybeExpandEmbeds` seeds `visited` with `makeFragmentCycleKey(host)`
 * so the second `a` reference is left as plain `![[a]]` text inside b.
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
	teardown: () => Promise<void>;
}

const setups: Setup[] = [];

afterEach(async () => {
	while (setups.length > 0) {
		const s = setups.pop();
		if (s) await s.teardown();
	}
});

async function makeVault(files: Record<string, string>): Promise<Setup> {
	const vault = await createTempVault(files);
	const opened = openSqlite({ dbPath: ":memory:" });
	const index = createIndexHandle(opened.db, { includeHidden: false });
	const vaultRoot: VaultRoot = await validateVaultRoot(vault.path);
	await scanVault({ vaultRoot, index, concurrency: 1 });
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

describe("getFragment — embed cycle host seed", () => {
	test("a → b → a leaves the second `a` as plain text", async () => {
		const s = await makeVault({
			"a.md": "ALPHA-HOST-MARKER\n\n![[b]]\n",
			"b.md": "BETA-BODY-MARKER\n\n![[a]]\n",
		});
		const result = await handleGetFragment(
			{ file: "a.md", anchor: { kind: "file" }, expand_embeds: true },
			s.vaultRoot,
			s.index,
		);
		expect(result.isError).toBeFalsy();
		const fragment = result.structuredContent as FragmentResult;
		expect(fragment.embeds).toHaveLength(1);
		const embed = fragment.embeds[0];
		expect(embed?.expanded).toBe(true);
		const expanded = embed?.expanded_content ?? "";
		// b's body must appear (one level of expansion is correct).
		expect(expanded).toContain("BETA-BODY-MARKER");
		// The second `a` reference must NOT re-embed the host body. Without
		// the host-fragment seed in `visited`, ALPHA-HOST-MARKER appears
		// inside b's expansion before the cycle detector trips.
		expect(expanded).not.toContain("ALPHA-HOST-MARKER");
		// The literal `![[a]]` should be preserved as plain text.
		expect(expanded).toContain("![[a]]");
	});

	test("self-embed `![[a]]` from a.md is detected as cycle on first encounter", async () => {
		const s = await makeVault({
			"a.md": "SELF-MARKER\n\n![[a]]\n",
		});
		const result = await handleGetFragment(
			{ file: "a.md", anchor: { kind: "file" }, expand_embeds: true },
			s.vaultRoot,
			s.index,
		);
		const fragment = result.structuredContent as FragmentResult;
		const embed = fragment.embeds[0];
		expect(embed?.expansion_error).toBe("cycle_detected");
		expect(embed?.expanded).toBe(false);
	});
});
