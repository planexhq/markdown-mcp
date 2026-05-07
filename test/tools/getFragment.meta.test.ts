/**
 * `get_fragment` error-envelope `_meta` preservation: a throw from
 * `validatePath` / `readNote` / `getTokenizerId` must reach the catch
 * with `index_status` (warm/reconciling) and `tokenizer` preserved
 * rather than regressing to the cold-default newMeta() — the round-11
 * "same observability contract for every error path" rule.
 */

import { describe, expect, test, vi } from "vitest";

import { TOKENIZER_HEURISTIC } from "../../src/lib/tokenizer.js";
import { handleGetFragment } from "../../src/tools/getFragment.js";
import type { GetFragmentInput, MetaEnvelope, VaultError } from "../../src/types.js";
import { stubIndex } from "../helpers/stubIndex.js";

const VAULT_ROOT = { absolute: "/tmp/vault-mcp-fragment-meta-test" };
const TRAVERSE_INPUT: GetFragmentInput = { file: "../escape.md", anchor: { kind: "file" } };
const HISTORY_STUB = { getHistoryRow: vi.fn().mockReturnValue(null) };

describe("get_fragment — error envelope `_meta` preservation", () => {
	test("PathValidationError on warm index → _meta.index_status reflects warm + tokenizer present", async () => {
		const index = stubIndex("warm", 42, HISTORY_STUB);
		const r = await handleGetFragment(TRAVERSE_INPUT, VAULT_ROOT, index);
		expect(r.isError).toBe(true);
		const err = r.structuredContent as VaultError;
		expect(err.code).toBe("PATH_OUTSIDE_VAULT");
		const meta = r._meta as MetaEnvelope;
		expect(meta.index_status.state).toBe("warm");
		expect(meta.index_status.files_indexed).toBe(42);
		expect(meta.tokenizer).toBe(TOKENIZER_HEURISTIC);
	});

	test("PathValidationError on reconciling index → _meta.index_status reflects reconciling", async () => {
		const index = stubIndex("reconciling", 17, HISTORY_STUB);
		const r = await handleGetFragment(TRAVERSE_INPUT, VAULT_ROOT, index);
		expect(r.isError).toBe(true);
		const meta = r._meta as MetaEnvelope;
		expect(meta.index_status.state).toBe("reconciling");
		expect(meta.index_status.files_indexed).toBe(17);
		expect(meta.tokenizer).toBe(TOKENIZER_HEURISTIC);
	});
});
