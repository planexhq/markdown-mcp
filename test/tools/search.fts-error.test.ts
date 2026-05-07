/**
 * Unit tests for `handleSearch`'s FTS fallback narrowing.
 *
 * Only `fts5:` syntax errors (which the public-surface sanitizer can't
 * always pre-empt) should drop into the defang-and-retry path. Every
 * other failure — corrupted DB, missing table, "database is locked",
 * even a generic runtime Error — must rethrow so the outer handler
 * surfaces it as `INTERNAL_ERROR` instead of pretending the search
 * succeeded with zero rows.
 */

import { describe, expect, test, vi } from "vitest";

import type { IndexHandle } from "../../src/lib/index/IndexHandle.js";
import { handleSearch } from "../../src/tools/search.js";
import type { MetaEnvelope, SearchOutput, VaultError } from "../../src/types.js";

class FakeSqliteError extends Error {
	override readonly name = "SqliteError";
	readonly code: string;
	constructor(code: string, message: string) {
		super(message);
		this.code = code;
	}
}

function stubIndex(throwOnQuery: () => never): IndexHandle {
	return {
		getStatus: vi.fn().mockReturnValue({ state: "warm", files_indexed: 1 }),
		getSnapshot: vi.fn().mockReturnValue(0),
		searchQueryMode: vi.fn().mockImplementation(throwOnQuery),
		searchFilterMode: vi.fn().mockReturnValue([]),
	} as unknown as IndexHandle;
}

const VAULT_ROOT = { absolute: "/tmp/vault-mcp-fts-error-test" };

describe("search — FTS fallback narrowing", () => {
	test("fts5: syntax error → fallback-defanged success", async () => {
		const index = stubIndex(() => {
			throw new FakeSqliteError("SQLITE_ERROR", 'fts5: syntax error near "foo"');
		});
		const r = await handleSearch({ query: "foo" }, VAULT_ROOT, index);
		expect(r.isError).toBeFalsy();
		const out = r.structuredContent as SearchOutput;
		expect(out.items).toEqual([]);
		const meta = r._meta as MetaEnvelope;
		expect(meta.query_note).toBe("fallback-defanged");
	});

	test("non-FTS SQLite error rethrows → INTERNAL_ERROR (preserves warm meta)", async () => {
		const index = stubIndex(() => {
			throw new FakeSqliteError("SQLITE_ERROR", "no such table: fragments");
		});
		const r = await handleSearch({ query: "foo" }, VAULT_ROOT, index);
		expect(r.isError).toBe(true);
		const err = r.structuredContent as VaultError;
		expect(err.code).toBe("INTERNAL_ERROR");
		// INTERNAL_ERROR envelope keeps the warm index_status +
		// query_algorithm + tokenizer the handler had built before the
		// error escaped — would otherwise regress to cold/0/missing.
		const meta = r._meta as MetaEnvelope;
		expect(meta.index_status).toEqual({ state: "warm", files_indexed: 1 });
		expect(meta.query_algorithm).toBeDefined();
		expect(meta.tokenizer).toBeDefined();
	});

	test("generic Error (no .code) rethrows → INTERNAL_ERROR", async () => {
		const index = stubIndex(() => {
			throw new Error("unexpected runtime failure");
		});
		const r = await handleSearch({ query: "foo" }, VAULT_ROOT, index);
		expect(r.isError).toBe(true);
		const err = r.structuredContent as VaultError;
		expect(err.code).toBe("INTERNAL_ERROR");
	});

	test("retry path: first call fts5:, second call non-fts5: rethrows", async () => {
		// Defang strips special chars; if the retried MATCH STILL hits a
		// non-FTS error, that's a real outage — must not be masked.
		let calls = 0;
		const index = stubIndex(() => {
			calls++;
			if (calls === 1) throw new FakeSqliteError("SQLITE_ERROR", 'fts5: syntax error near "+"');
			throw new FakeSqliteError("SQLITE_IOERR", "disk I/O error");
		});
		const r = await handleSearch({ query: "+foo" }, VAULT_ROOT, index);
		expect(r.isError).toBe(true);
		const err = r.structuredContent as VaultError;
		expect(err.code).toBe("INTERNAL_ERROR");
	});
});
