/**
 * Unit tests for the `handleSearch` warm-up guard.
 *
 * The integration tests in `search.test.ts` poll until `state === "warm"`
 * before running any case, so they can't observe the cold/warming
 * envelopes. These cases call `handleSearch` directly with a stubbed
 * IndexHandle whose `getStatus()` returns the state under test.
 */

import { describe, expect, test, vi } from "vitest";

import type { IndexHandle } from "../../src/lib/index/IndexHandle.js";
import { TOKENIZER_HEURISTIC } from "../../src/lib/tokenizer.js";
import { handleSearch } from "../../src/tools/search.js";
import type { IndexState, MetaEnvelope, SearchInput, SearchOutput, VaultError } from "../../src/types.js";
import { FAKE_VAULT_ROOT } from "../helpers/vault.js";

function stubIndex(state: IndexState, filesIndexed: number): IndexHandle {
	return {
		getStatus: vi.fn().mockReturnValue({ state, files_indexed: filesIndexed }),
		getSnapshotMtime: vi.fn().mockReturnValue(0),
		searchQueryMode: vi.fn().mockReturnValue([]),
		searchFilterMode: vi.fn().mockReturnValue([]),
	} as unknown as IndexHandle;
}

const SEARCH_INPUT: SearchInput = { query: "anything" };

describe("search — warm-up guard", () => {
	test("state=cold returns INDEX_WARMING with tokenizer in _meta", async () => {
		const index = stubIndex("cold", 0);
		const r = await handleSearch(SEARCH_INPUT, FAKE_VAULT_ROOT, index);
		expect(r.isError).toBe(true);
		const err = r.structuredContent as VaultError;
		expect(err.code).toBe("INDEX_WARMING");
		const meta = r._meta as MetaEnvelope;
		expect(meta.tokenizer).toBe(TOKENIZER_HEURISTIC);
	});

	test("state=warming with files_indexed=0 returns INDEX_WARMING", async () => {
		const index = stubIndex("warming", 0);
		const r = await handleSearch(SEARCH_INPUT, FAKE_VAULT_ROOT, index);
		expect(r.isError).toBe(true);
		const err = r.structuredContent as VaultError;
		expect(err.code).toBe("INDEX_WARMING");
		expect(err.progress).toMatchObject({ files_indexed: 0 });
	});

	test("state=warming with files_indexed>0 still returns INDEX_WARMING", async () => {
		// The entire warming window is treated as unavailable for
		// vault-wide search — partial indices may grow before the next
		// call, so a row count > 0 doesn't mean "ready."
		const index = stubIndex("warming", 5);
		const r = await handleSearch(SEARCH_INPUT, FAKE_VAULT_ROOT, index);
		expect(r.isError).toBe(true);
		const err = r.structuredContent as VaultError;
		expect(err.code).toBe("INDEX_WARMING");
		expect(err.progress).toMatchObject({ files_indexed: 5 });
	});

	test("state=reconciling proceeds past the guard", async () => {
		// Reconciling means the prior snapshot is intact; reads continue.
		const index = stubIndex("reconciling", 10);
		const r = await handleSearch(SEARCH_INPUT, FAKE_VAULT_ROOT, index);
		// Whatever the downstream outcome (success / domain error), it MUST
		// NOT be INDEX_WARMING — the guard only fires for cold/warming.
		const code = (r.structuredContent as VaultError | undefined)?.code;
		expect(code).not.toBe("INDEX_WARMING");
	});
});

describe("search — validation precedence over warming gate", () => {
	// Permanent input errors (PATH_OUTSIDE_VAULT, INVALID_QUERY,
	// FILTER_SYNTAX_ERROR) must surface even when the index is cold or
	// warming. INDEX_WARMING carries `retry_after_ms`; agents will retry
	// indefinitely on a request that's actually permanently broken.
	test.each(["cold", "warming"] as const)("scope traversal during state=%s → PATH_OUTSIDE_VAULT", async (state) => {
		const index = stubIndex(state, 0);
		const r = await handleSearch({ query: "x", scope: { path: "../etc/hosts" } }, FAKE_VAULT_ROOT, index);
		expect(r.isError).toBe(true);
		const err = r.structuredContent as VaultError;
		expect(err.code).toBe("PATH_OUTSIDE_VAULT");
	});

	test.each(["cold", "warming"] as const)("control-char query during state=%s → INVALID_QUERY", async (state) => {
		const index = stubIndex(state, 0);
		const r = await handleSearch({ query: "\u0001bad" }, FAKE_VAULT_ROOT, index);
		expect(r.isError).toBe(true);
		const err = r.structuredContent as VaultError;
		expect(err.code).toBe("INVALID_QUERY");
	});

	test.each([
		"cold",
		"warming",
	] as const)("mixed-category fields[name] during state=%s → FILTER_SYNTAX_ERROR", async (state) => {
		const index = stubIndex(state, 0);
		const r = await handleSearch(
			{ query: "", filters: { fields: { x: { has: "a", eq: "b" } } } },
			FAKE_VAULT_ROOT,
			index,
		);
		expect(r.isError).toBe(true);
		const err = r.structuredContent as VaultError;
		expect(err.code).toBe("FILTER_SYNTAX_ERROR");
	});

	test.each(["cold", "warming"] as const)("empty query + empty filter during state=%s → items: []", async (state) => {
		// D23: empty-and-empty short-circuits without reading the index, so
		// it must succeed regardless of warming state.
		const index = stubIndex(state, 0);
		const r = await handleSearch({ query: "" }, FAKE_VAULT_ROOT, index);
		expect(r.isError).toBeFalsy();
		const out = r.structuredContent as SearchOutput;
		expect(out.items).toEqual([]);
		const meta = r._meta as MetaEnvelope;
		expect(meta.query_note).toBeTruthy();
	});

	test.each([
		"cold",
		"warming",
	] as const)("non-empty query + valid input during state=%s → INDEX_WARMING (regression guard)", async (state) => {
		const index = stubIndex(state, 0);
		const r = await handleSearch({ query: "real-token" }, FAKE_VAULT_ROOT, index);
		expect(r.isError).toBe(true);
		const err = r.structuredContent as VaultError;
		expect(err.code).toBe("INDEX_WARMING");
	});
});
