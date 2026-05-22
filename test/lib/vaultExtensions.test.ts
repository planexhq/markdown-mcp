/**
 * `vaultExtensions` — predicate behavior under default config and env-var
 * overrides. The implementation memoizes by raw env-string value: a
 * `vi.stubEnv` between cases changes the string and invalidates the
 * cache, so each test sees fresh parsing without re-importing.
 */

import { afterEach, describe, expect, test, vi } from "vitest";

import { getVaultExtensions, isLinkableExtension, isResolvableLinkTarget } from "../../src/lib/vaultExtensions.js";

afterEach(() => {
	vi.unstubAllEnvs();
});

describe("getVaultExtensions", () => {
	test("default is exactly { 'md' }", () => {
		const exts = getVaultExtensions();
		expect([...exts]).toEqual(["md"]);
	});

	test("env override accepts comma-separated list, lowercased and trimmed", () => {
		vi.stubEnv("VAULT_EXTENSIONS", "MD, Markdown , mdx");
		const exts = getVaultExtensions();
		expect([...exts].sort()).toEqual(["markdown", "md", "mdx"]);
	});

	test("empty env value falls back to default", () => {
		vi.stubEnv("VAULT_EXTENSIONS", "");
		expect([...getVaultExtensions()]).toEqual(["md"]);
	});

	test("whitespace-only env value falls back to default", () => {
		vi.stubEnv("VAULT_EXTENSIONS", "   ");
		expect([...getVaultExtensions()]).toEqual(["md"]);
	});
});

describe("isResolvableLinkTarget", () => {
	test("default config: .md accepted, .txt rejected", () => {
		expect(isResolvableLinkTarget("note.md")).toBe(true);
		expect(isResolvableLinkTarget("secret.txt")).toBe(false);
	});

	test("case-insensitive extension match", () => {
		expect(isResolvableLinkTarget("NOTE.MD")).toBe(true);
	});

	test("paths without an extension are rejected (no Makefile-style notes)", () => {
		expect(isResolvableLinkTarget("Makefile")).toBe(false);
		expect(isResolvableLinkTarget("README")).toBe(false);
	});

	test("nested path uses the FILE extension, not directory dots", () => {
		expect(isResolvableLinkTarget("topic.v1/note.md")).toBe(true);
		expect(isResolvableLinkTarget("topic.v1/asset.png")).toBe(false);
	});

	test("env override: .markdown accepted when configured", () => {
		vi.stubEnv("VAULT_EXTENSIONS", "md,markdown");
		expect(isResolvableLinkTarget("note.markdown")).toBe(true);
		expect(isResolvableLinkTarget("note.mdx")).toBe(false);
	});
});

describe("isLinkableExtension", () => {
	test("default config: md accepted; yaml/prisma rejected when configured", () => {
		expect(isLinkableExtension("md")).toBe(true);
		vi.stubEnv("VAULT_EXTENSIONS", "md,yaml,prisma");
		expect(isLinkableExtension("md")).toBe(true);
		expect(isLinkableExtension("yaml")).toBe(false);
		expect(isLinkableExtension("yml")).toBe(false);
		expect(isLinkableExtension("prisma")).toBe(false);
	});

	test("rejects extension not configured even if family is markdown-like", () => {
		expect(isLinkableExtension("markdown")).toBe(false);
		vi.stubEnv("VAULT_EXTENSIONS", "md,markdown");
		expect(isLinkableExtension("markdown")).toBe(true);
	});

	test("non-markdown configured extension (.txt) is linkable", () => {
		vi.stubEnv("VAULT_EXTENSIONS", "md,txt");
		expect(isLinkableExtension("txt")).toBe(true);
	});
});
