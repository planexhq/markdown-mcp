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
		expect(isIndexCachePath(".markdown-mcp")).toBe(true);
	});

	test("lowercase cache file → true", () => {
		expect(isIndexCachePath(".markdown-mcp/index.sqlite3")).toBe(true);
		expect(isIndexCachePath(".markdown-mcp/index.sqlite3-wal")).toBe(true);
		expect(isIndexCachePath(".markdown-mcp/index.sqlite3-shm")).toBe(true);
	});

	test("mixed-case top-level cache dir → true (case-insensitive FS bypass closed)", () => {
		// validatePath preserves user-supplied casing in its returned relpath,
		// and `.Markdown-MCP` resolves to the same inode as `.markdown-mcp` on
		// macOS APFS / Windows NTFS. The predicate must match all casings to
		// prevent direct-read tools from leaking SQLite/WAL/SHM contents.
		expect(isIndexCachePath(".Markdown-MCP")).toBe(true);
		expect(isIndexCachePath(".MARKDOWN-MCP")).toBe(true);
		expect(isIndexCachePath(".mArKdOwN-McP")).toBe(true);
	});

	test("mixed-case cache file → true", () => {
		expect(isIndexCachePath(".Markdown-MCP/index.sqlite3")).toBe(true);
		expect(isIndexCachePath(".MARKDOWN-MCP/index.sqlite3-wal")).toBe(true);
	});

	test("non-cache top-level paths → false", () => {
		expect(isIndexCachePath("notes")).toBe(false);
		expect(isIndexCachePath(".obsidian/config.md")).toBe(false);
		expect(isIndexCachePath(".git/HEAD")).toBe(false);
		expect(isIndexCachePath("foo.md")).toBe(false);
	});

	test("cache-named segment NOT at top level → false", () => {
		// Only the top-level cache dir matters; a user could legitimately have
		// a deeper `.markdown-mcp` subdirectory.
		expect(isIndexCachePath("notes/.markdown-mcp/foo.md")).toBe(false);
		expect(isIndexCachePath("a/.Markdown-MCP/b")).toBe(false);
	});

	test("near-miss prefix without slash boundary → false", () => {
		// Predicate is `=== NAME` OR `startsWith(NAME + "/")` — confirms the
		// slash boundary so `.markdown-mcp-archive` doesn't false-positive.
		expect(isIndexCachePath(".markdown-mcp-archive")).toBe(false);
		expect(isIndexCachePath(".markdown-mcp-backup/notes.md")).toBe(false);
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
		expect(isIndexCachePath(".markdown-mcp")).toBe(true);
		expect(isIndexCachePath(".markdown-mcp/index.sqlite3")).toBe(true);
		expect(isIndexCachePath(".markdown-mcp/index.sqlite3-wal")).toBe(true);
	});

	test("mixed-case treated as distinct user directory on case-sensitive FS", () => {
		// Linux ext4 / btrfs default: `.Markdown-MCP/` is a distinct inode from
		// `.markdown-mcp/`, so a user with a deliberate case-variant directory
		// retains direct-read access.
		expect(isIndexCachePath(".Markdown-MCP")).toBe(false);
		expect(isIndexCachePath(".MARKDOWN-MCP/notes.md")).toBe(false);
		expect(isIndexCachePath(".mArKdOwN-McP")).toBe(false);
		expect(isIndexCachePath(".Markdown-MCP/index.sqlite3")).toBe(false);
	});

	test("non-cache paths still rejected", () => {
		expect(isIndexCachePath("notes")).toBe(false);
		expect(isIndexCachePath(".obsidian/config.md")).toBe(false);
		expect(isIndexCachePath("foo.md")).toBe(false);
	});
});
