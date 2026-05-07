/**
 * `routeToolError` envelope-meta tests.
 *
 * The `INTERNAL_ERROR` fallthrough must thread caller `baseMeta` through
 * to the response envelope, so warm-search responses keep their
 * `index_status` / `query_algorithm` / `tokenizer` even when a non-typed
 * error escapes from the handler.
 */

import { describe, expect, test } from "vitest";

import { newMeta } from "../../src/lib/error.js";
import { FilterSyntaxError } from "../../src/lib/filter.js";
import { routeToolError } from "../../src/tools/routeError.js";
import type { MetaEnvelope, VaultError } from "../../src/types.js";

const WARM_META: MetaEnvelope = newMeta({
	index_status: { state: "warm", files_indexed: 42 },
	query_algorithm: "query-sanitize-v1",
	tokenizer: "heuristic/content-aware-v1",
});

describe("routeToolError — meta passthrough", () => {
	test("INTERNAL_ERROR fallthrough preserves caller meta", () => {
		const env = routeToolError(new Error("boom"), "search", WARM_META);
		const err = env.structuredContent as VaultError;
		expect(err.code).toBe("INTERNAL_ERROR");
		// Without baseMeta passthrough, the fallthrough path constructs
		// a fresh newMeta() (cold/0, no algorithm IDs) — same fields the
		// typed branches preserve.
		expect(env._meta.index_status).toEqual({ state: "warm", files_indexed: 42 });
		expect(env._meta.query_algorithm).toBe("query-sanitize-v1");
		expect(env._meta.tokenizer).toBe("heuristic/content-aware-v1");
		// request_id flows from caller meta to the error and back into _meta.
		expect(env._meta.request_id).toBe(WARM_META.request_id);
		expect(err.request_id).toBe(WARM_META.request_id);
	});

	test("typed branches also preserve caller meta (regression guard)", () => {
		// FILTER_SYNTAX_ERROR was already wired via baseMeta — guard against
		// the fallthrough fix accidentally rerouting it.
		const env = routeToolError(
			new FilterSyntaxError({ param: "filters.tags.has", expected: "string" }),
			"search",
			WARM_META,
		);
		const err = env.structuredContent as VaultError;
		expect(err.code).toBe("FILTER_SYNTAX_ERROR");
		expect(env._meta.index_status).toEqual({ state: "warm", files_indexed: 42 });
		expect(env._meta.query_algorithm).toBe("query-sanitize-v1");
	});

	test("no meta arg → default cold/0 envelope", () => {
		const env = routeToolError(new Error("boom"), "search");
		const err = env.structuredContent as VaultError;
		expect(err.code).toBe("INTERNAL_ERROR");
		expect(env._meta.index_status).toEqual({ state: "cold", files_indexed: 0 });
		expect(env._meta.query_algorithm).toBeUndefined();
		expect(env._meta.tokenizer).toBeUndefined();
	});
});
