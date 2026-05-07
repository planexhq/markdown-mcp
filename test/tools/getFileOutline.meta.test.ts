/**
 * `get_file_outline` error-envelope `_meta` preservation: a throw from
 * `validatePath` / `readNote` / `getTokenizerId` must reach the catch
 * with `index_status` and `tokenizer` preserved rather than regressing
 * to the cold-default newMeta().
 */

import { describe, expect, test } from "vitest";

import { TOKENIZER_HEURISTIC } from "../../src/lib/tokenizer.js";
import { handleGetFileOutline } from "../../src/tools/getFileOutline.js";
import type { GetFileOutlineInput, MetaEnvelope, VaultError } from "../../src/types.js";
import { stubIndex } from "../helpers/stubIndex.js";

const VAULT_ROOT = { absolute: "/tmp/vault-mcp-outline-meta-test" };
const TRAVERSE_INPUT: GetFileOutlineInput = { file: "../escape.md" };

describe("get_file_outline — error envelope `_meta` preservation", () => {
	test("PathValidationError on warm index → _meta.index_status reflects warm + tokenizer present", async () => {
		const index = stubIndex("warm", 42);
		const r = await handleGetFileOutline(TRAVERSE_INPUT, VAULT_ROOT, index);
		expect(r.isError).toBe(true);
		const err = r.structuredContent as VaultError;
		expect(err.code).toBe("PATH_OUTSIDE_VAULT");
		const meta = r._meta as MetaEnvelope;
		expect(meta.index_status.state).toBe("warm");
		expect(meta.index_status.files_indexed).toBe(42);
		expect(meta.tokenizer).toBe(TOKENIZER_HEURISTIC);
	});
});
