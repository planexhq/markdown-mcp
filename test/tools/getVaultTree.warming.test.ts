/**
 * Unit tests for the `handleGetVaultTree` warm-up guard.
 *
 * The integration tests in `getVaultTree.test.ts` poll until `state ===
 * "warm"` before any case runs, so they can't observe the warming
 * envelope. CLAUDE.md state machine: vault-wide tools (search, get_links,
 * get_vault_tree) MUST INDEX_WARMING during BOTH cold and warming. Pre-
 * fix, get_vault_tree only gated on `cold` — this test pins the rule.
 */

import { describe, expect, test } from "vitest";

import { handleGetVaultTree } from "../../src/tools/getVaultTree.js";
import type { GetVaultTreeInput, VaultError } from "../../src/types.js";
import { stubIndex } from "../helpers/stubIndex.js";
import { FAKE_VAULT_ROOT } from "../helpers/vault.js";

const TREE_INPUT: GetVaultTreeInput = { path: "" };

describe("get_vault_tree — warm-up guard", () => {
	test("state=cold returns INDEX_WARMING", async () => {
		const index = stubIndex("cold", 0);
		const r = await handleGetVaultTree(TREE_INPUT, FAKE_VAULT_ROOT, index);
		expect(r.isError).toBe(true);
		const err = r.structuredContent as VaultError;
		expect(err.code).toBe("INDEX_WARMING");
	});

	test("state=warming with files_indexed>0 still returns INDEX_WARMING", async () => {
		// Tree responses during warming would mix index-derived `subheadings`
		// with bare `mtime: 0` fallback for unscanned files — partial result.
		// State-machine contract: vault-wide tools return INDEX_WARMING
		// through both cold AND warming.
		const index = stubIndex("warming", 5);
		const r = await handleGetVaultTree(TREE_INPUT, FAKE_VAULT_ROOT, index);
		expect(r.isError).toBe(true);
		const err = r.structuredContent as VaultError;
		expect(err.code).toBe("INDEX_WARMING");
		expect(err.progress).toMatchObject({ files_indexed: 5 });
	});

	test("state=reconciling proceeds past the guard", async () => {
		// Reconciling means the prior snapshot is intact; reads continue.
		const index = stubIndex("reconciling", 10);
		const r = await handleGetVaultTree(TREE_INPUT, FAKE_VAULT_ROOT, index);
		const code = (r.structuredContent as VaultError | undefined)?.code;
		expect(code).not.toBe("INDEX_WARMING");
	});

	test.each([
		"cold",
		"warming",
	] as const)("traversal path during state=%s → PATH_OUTSIDE_VAULT (validation precedes gate)", async (state) => {
		// Permanent input errors must surface as their precise codes
		// during cold/warming instead of being masked by the transient
		// INDEX_WARMING — agents would otherwise retry indefinitely
		// against a permanently-broken request. validatePath pre-checks
		// `..` segments before any FS call so FAKE_VAULT_ROOT is fine.
		const index = stubIndex(state, 0);
		const r = await handleGetVaultTree({ path: "../escape" }, FAKE_VAULT_ROOT, index);
		expect(r.isError).toBe(true);
		const err = r.structuredContent as VaultError;
		expect(err.code).toBe("PATH_OUTSIDE_VAULT");
	});
});
