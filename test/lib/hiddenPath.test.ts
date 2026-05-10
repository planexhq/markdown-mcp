/**
 * `isHiddenPath` predicate — any dot-prefixed segment makes the path hidden.
 * Mirrors the brief's "policy-excluded by default" surface (Brief line 928).
 */

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
	isHiddenPath,
	isIndexCachePath,
	resetFsCaseInsensitiveForTest,
	setFsCaseInsensitive,
} from "../../src/lib/hiddenPath.js";

describe("isHiddenPath", () => {
	test("dot-prefixed top-level directory → hidden", () => {
		expect(isHiddenPath(".obsidian/config.md")).toBe(true);
		expect(isHiddenPath(".git/HEAD.md")).toBe(true);
	});

	test("dot-prefixed file in normal directory → hidden", () => {
		expect(isHiddenPath("notes/.private.md")).toBe(true);
	});

	test("any dot-prefixed segment counts (deeply nested)", () => {
		expect(isHiddenPath(".foo/bar/baz.md")).toBe(true);
		expect(isHiddenPath("foo/.bar/baz.md")).toBe(true);
		expect(isHiddenPath("foo/bar/.baz.md")).toBe(true);
	});

	test("non-hidden paths → false", () => {
		expect(isHiddenPath("notes/foo.md")).toBe(false);
		expect(isHiddenPath("foo.md")).toBe(false);
		expect(isHiddenPath("a/b/c/d.md")).toBe(false);
	});

	test("dots inside a segment (not at the start) → not hidden", () => {
		// `topic.v1` is a normal directory name with a dot in the middle —
		// not the same as a leading-dot hidden marker.
		expect(isHiddenPath("topic.v1/note.md")).toBe(false);
		expect(isHiddenPath("notes/v1.0.md")).toBe(false);
	});
});

describe("isIndexCachePath", () => {
	test("lowercase top-level cache dir → true", () => {
		expect(isIndexCachePath(".vault-mcp")).toBe(true);
	});

	test("lowercase cache file → true", () => {
		expect(isIndexCachePath(".vault-mcp/index.sqlite3")).toBe(true);
		expect(isIndexCachePath(".vault-mcp/index.sqlite3-wal")).toBe(true);
		expect(isIndexCachePath(".vault-mcp/index.sqlite3-shm")).toBe(true);
	});

	test("mixed-case top-level cache dir → true (case-insensitive FS bypass closed)", () => {
		// validatePath preserves user-supplied casing in its returned relpath,
		// and `.Vault-MCP` resolves to the same inode as `.vault-mcp` on
		// macOS APFS / Windows NTFS. The predicate must match all casings to
		// prevent direct-read tools from leaking SQLite/WAL/SHM contents.
		expect(isIndexCachePath(".Vault-MCP")).toBe(true);
		expect(isIndexCachePath(".VAULT-MCP")).toBe(true);
		expect(isIndexCachePath(".vAuLt-McP")).toBe(true);
	});

	test("mixed-case cache file → true", () => {
		expect(isIndexCachePath(".Vault-MCP/index.sqlite3")).toBe(true);
		expect(isIndexCachePath(".VAULT-MCP/index.sqlite3-wal")).toBe(true);
	});

	test("non-cache top-level paths → false", () => {
		expect(isIndexCachePath("notes")).toBe(false);
		expect(isIndexCachePath(".obsidian/config.md")).toBe(false);
		expect(isIndexCachePath(".git/HEAD")).toBe(false);
		expect(isIndexCachePath("foo.md")).toBe(false);
	});

	test("cache-named segment NOT at top level → false", () => {
		// Only the top-level cache dir matters; a user could legitimately have
		// a deeper `.vault-mcp` subdirectory.
		expect(isIndexCachePath("notes/.vault-mcp/foo.md")).toBe(false);
		expect(isIndexCachePath("a/.Vault-MCP/b")).toBe(false);
	});

	test("near-miss prefix without slash boundary → false", () => {
		// Predicate is `=== NAME` OR `startsWith(NAME + "/")` — confirms the
		// slash boundary so `.vault-mcp-archive` doesn't false-positive.
		expect(isIndexCachePath(".vault-mcp-archive")).toBe(false);
		expect(isIndexCachePath(".vault-mcp-backup/notes.md")).toBe(false);
	});
});

describe("isIndexCachePath case-sensitive FS routing", () => {
	// Module-level FS flag is per-process; tests in this block set the
	// case-sensitive branch and reset afterwards so sibling tests in the
	// file see the default (null = case-insensitive).
	beforeEach(() => {
		setFsCaseInsensitive(false);
	});
	afterEach(() => {
		resetFsCaseInsensitiveForTest();
	});

	test("lowercase cache paths still match on case-sensitive FS", () => {
		expect(isIndexCachePath(".vault-mcp")).toBe(true);
		expect(isIndexCachePath(".vault-mcp/index.sqlite3")).toBe(true);
		expect(isIndexCachePath(".vault-mcp/index.sqlite3-wal")).toBe(true);
	});

	test("mixed-case treated as distinct user directory on case-sensitive FS", () => {
		// Linux ext4 / btrfs default: `.Vault-MCP/` is a distinct inode from
		// `.vault-mcp/`, so a user with a deliberate case-variant directory
		// retains direct-read access.
		expect(isIndexCachePath(".Vault-MCP")).toBe(false);
		expect(isIndexCachePath(".VAULT-MCP/notes.md")).toBe(false);
		expect(isIndexCachePath(".vAuLt-McP")).toBe(false);
		expect(isIndexCachePath(".Vault-MCP/index.sqlite3")).toBe(false);
	});

	test("non-cache paths still rejected", () => {
		expect(isIndexCachePath("notes")).toBe(false);
		expect(isIndexCachePath(".obsidian/config.md")).toBe(false);
		expect(isIndexCachePath("foo.md")).toBe(false);
	});
});
