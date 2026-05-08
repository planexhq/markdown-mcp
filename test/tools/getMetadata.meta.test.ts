/**
 * `get_metadata` error-envelope `_meta` preservation: a throw from
 * `validatePath` / `readNote` must reach the catch with `index_status`
 * preserved rather than regressing to cold-default. This tool carries
 * no `tokenizer` per the Brief field-presence table, but the same
 * regression class applies to `index_status`.
 */

import { describe, expect, test } from "vitest";

import { handleGetMetadata } from "../../src/tools/getMetadata.js";
import type { GetMetadataInput, MetaEnvelope, VaultError } from "../../src/types.js";
import { stubIndex } from "../helpers/stubIndex.js";
import { FAKE_VAULT_ROOT } from "../helpers/vault.js";

const TRAVERSE_INPUT: GetMetadataInput = { file: "../escape.md" };

describe("get_metadata — error envelope `_meta` preservation", () => {
	test("PathValidationError on warm index → _meta.index_status reflects warm; no tokenizer", async () => {
		const index = stubIndex("warm", 42);
		const r = await handleGetMetadata(TRAVERSE_INPUT, FAKE_VAULT_ROOT, index);
		expect(r.isError).toBe(true);
		const err = r.structuredContent as VaultError;
		expect(err.code).toBe("PATH_OUTSIDE_VAULT");
		const meta = r._meta as MetaEnvelope;
		expect(meta.index_status.state).toBe("warm");
		expect(meta.index_status.files_indexed).toBe(42);
		expect(meta.tokenizer).toBeUndefined();
	});
});
