/**
 * Heuristic tokenizer tests. Pin the divisor selection at the 30%
 * boundary and the unsupported-tokenizer rejection.
 */

import { afterEach, describe, expect, test } from "vitest";

import { estimateTokens, getTokenizerId, TOKENIZER_HEURISTIC } from "../../src/lib/tokenizer.js";

const ORIGINAL_ENV = process.env.VAULT_TOKENIZER;

afterEach(() => {
	if (ORIGINAL_ENV === undefined) delete process.env.VAULT_TOKENIZER;
	else process.env.VAULT_TOKENIZER = ORIGINAL_ENV;
});

describe("estimateTokens (heuristic/content-aware-v1)", () => {
	test("empty string → 0", () => {
		expect(estimateTokens("", TOKENIZER_HEURISTIC)).toBe(0);
	});

	test("prose uses 3.5 chars/token divisor", () => {
		const text = "x".repeat(70); // 70 / 3.5 = 20
		expect(estimateTokens(text, TOKENIZER_HEURISTIC)).toBe(20);
	});

	test("code-fence-dominant content uses 2.7 divisor (smaller divisor → more tokens than prose)", () => {
		// Make >30% of total chars be inside a code fence.
		const code = `\`\`\`\n${"y".repeat(100)}\n\`\`\``; // 108 fence chars
		const prose = "p".repeat(50); // 50 prose chars; ratio ≈68% > 30%
		const text = `${prose}\n${code}`;
		const result = estimateTokens(text, TOKENIZER_HEURISTIC);
		// Code divisor (2.7) is smaller than prose (3.5), so MORE tokens per char.
		const proseEquivalent = Math.round(text.length / 3.5);
		expect(result).toBeGreaterThan(proseEquivalent);
	});

	test("CJK-dominant content uses 1.5 divisor", () => {
		// All CJK characters → ratio 100% > 30% → CJK divisor
		const text = "日本語テキスト".repeat(20); // ~140 codepoints
		const result = estimateTokens(text, TOKENIZER_HEURISTIC);
		const proseEquivalent = Math.round(text.length / 3.5);
		expect(result).toBeGreaterThan(proseEquivalent); // smaller divisor → more tokens
	});

	test("rejects unsupported tokenizer ids", () => {
		expect(() => estimateTokens("hello", "tiktoken/o200k_base")).toThrow(/not yet supported/);
		expect(() => estimateTokens("hello", "anthropic/count_tokens_api")).toThrow(/not yet supported/);
	});

	test("returns at least 1 token for non-empty content", () => {
		expect(estimateTokens("x", TOKENIZER_HEURISTIC)).toBeGreaterThanOrEqual(1);
	});

	test.each([
		["\n"],
		["\n\n"],
		["   "],
		["\t\n  \n"],
	])("whitespace-only input %j → 0 (no phantom token for empty heading bodies)", (input) => {
		expect(estimateTokens(input, TOKENIZER_HEURISTIC)).toBe(0);
	});

	test("tilde-fenced code is treated like backtick-fenced for divisor selection", () => {
		// CommonMark §4.5: fences may use `~~~` OR ```` ``` ````. The heuristic
		// should classify both as code so token counts agree for identical bodies.
		const body =
			"function f() {\n  for (let i = 0; i < 100; i++) console.log(i);\n}\nconst x = 42;\n// comment\n".repeat(2);
		const tilde = `~~~\n${body}\n~~~`;
		const backtick = `\`\`\`\n${body}\n\`\`\``;
		expect(estimateTokens(tilde, TOKENIZER_HEURISTIC)).toBe(estimateTokens(backtick, TOKENIZER_HEURISTIC));
	});

	test("tilde-fence-dominant content uses 2.7 divisor (smaller divisor → more tokens than prose)", () => {
		const code = `~~~\n${"y".repeat(100)}\n~~~`;
		const prose = "p".repeat(50);
		const text = `${prose}\n${code}`;
		const result = estimateTokens(text, TOKENIZER_HEURISTIC);
		const proseEquivalent = Math.round(text.length / 3.5);
		expect(result).toBeGreaterThan(proseEquivalent);
	});
});

describe("getTokenizerId", () => {
	test("default is heuristic when env var is unset", () => {
		delete process.env.VAULT_TOKENIZER;
		expect(getTokenizerId()).toBe(TOKENIZER_HEURISTIC);
	});

	test("returns env var value when set", () => {
		process.env.VAULT_TOKENIZER = "tiktoken/o200k_base";
		expect(getTokenizerId()).toBe("tiktoken/o200k_base");
	});

	test("falls back to heuristic when env var is empty string", () => {
		process.env.VAULT_TOKENIZER = "";
		expect(getTokenizerId()).toBe(TOKENIZER_HEURISTIC);
	});
});
