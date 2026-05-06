/**
 * Test helpers for spinning up isolated vault directories.
 *
 * Used by `validatePath` unit tests (need a real FS root for lstat /
 * realpath / symlink detection) and by the MCP integration test (needs
 * a `--vault` argument).
 *
 * Tests should always call `cleanup()` from `afterEach` — vitest does
 * not clean tmpdir automatically.
 */

import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Recursive vault structure descriptor.
 *
 *   string  → file with that text content
 *   object  → directory whose entries are nested descriptors
 */
export type VaultStructure = {
	[name: string]: string | VaultStructure;
};

/**
 * Create a fresh temp directory and populate it with the described
 * structure. Returns the absolute path and a cleanup function that
 * recursively removes the temp directory.
 *
 * Caller responsibility: invoke `cleanup()` in `afterEach` (or similar).
 */
export async function createTempVault(
	structure: VaultStructure = {},
): Promise<{ path: string; cleanup: () => Promise<void> }> {
	const root = await mkdtemp(join(tmpdir(), "vault-mcp-test-"));
	await populate(root, structure);
	return {
		path: root,
		cleanup: async () => {
			await rm(root, { recursive: true, force: true });
		},
	};
}

async function populate(parent: string, structure: VaultStructure): Promise<void> {
	for (const [name, value] of Object.entries(structure)) {
		const full = join(parent, name);
		if (typeof value === "string") {
			await mkdir(dirname(full), { recursive: true });
			await writeFile(full, value, "utf8");
		} else {
			await mkdir(full, { recursive: true });
			await populate(full, value);
		}
	}
}

/**
 * Create a symlink at `linkPath` pointing to `target`. Used to build
 * symlink-rejection test fixtures. `target` may be absolute or relative
 * to `dirname(linkPath)`. Throws on Windows native — tests using this
 * should be skipped on Windows (W1 CI is macOS+Linux only).
 */
export async function createSymlink(target: string, linkPath: string): Promise<void> {
	await mkdir(dirname(linkPath), { recursive: true });
	await symlink(target, linkPath);
}

/**
 * Build a deeply-nested path with `depth` directory segments under
 * `root`. Returns the deepest path (without the trailing file).
 * Used for the depth-cap test (depth > 32 → TOO_DEEP).
 */
export function buildDeepPath(depth: number): string {
	return Array.from({ length: depth }, (_, i) => `d${i}`).join("/");
}

/**
 * Default vault structure used by tests that need a non-empty fixture.
 * Reused across both the `validatePath` unit tests and the MCP integration
 * tests so any change to the canonical shape happens once.
 *
 * The W2 entries (`multi-section.md`, `with-blocks.md`, `with-frontmatter.md`,
 * `ambiguous.md`) drive `get_file_outline` / `get_fragment` / `get_metadata`
 * integration tests against real-handler responses.
 */
export const DEFAULT_VAULT_STRUCTURE: VaultStructure = {
	"foo.md": "# foo\n",
	sub: { "nested.md": "# nested\n" },
	// Percent-encoded URI test fixture: addressed via `note://unicode-%C3%A9.md`
	// to verify the resource handler decodes before path validation.
	"unicode-é.md": "# unicode\n",
	"multi-section.md": "Preamble line.\n\n# Auth\n\nAuth body.\n\n## OAuth2\n\nOAuth2 body.\n\n# Tags\n\nTags body.\n",
	"with-blocks.md": "# Section\n\nFirst paragraph. ^block-one\n\nSecond paragraph.\n\n^block-two\n\nThird paragraph.\n",
	// Deferred-form `^id` paragraph following caret-suffixed text. The
	// block-fragment trim regex must NOT strip `^2` from `Value x^2` —
	// that's not a block ID (BLOCK_ID_RE requires whitespace lookbehind),
	// so the prior paragraph's body must be preserved verbatim.
	"block-deferred-caret.md": "# H\n\nValue x^2\n\n^math-block\n",
	// Block ID inside a blockquote. mdast paragraph offsets start AFTER `> `;
	// `pushRange` must walk back to line start so `get_fragment` returns the
	// raw markdown blockquote (`> quoted`) rather than bare `quoted`.
	"block-in-blockquote.md": "# H\n\n> quoted text ^quote-block\n",
	// List item inside a blockquote: mdast nests `blockquote → list → listItem`,
	// so the immediate parent of `listItem` is `list`, NOT `blockquote`. Without
	// any-ancestor blockquote detection, `pushRange` starts the slice at `-`
	// and drops the `> ` prefix from the displayed block content.
	"block-in-blockquote-list.md": "# H\n\n> - quoted item ^qlist-block\n",
	// Deferred-form block ID inside a blockquote: blank `> ` line ends the first
	// paragraph, lone `> ^id` paragraph addresses the previous quoted paragraph.
	// `>` markers between paragraphs and on the lone-id line are notation and
	// must count as adjacency whitespace.
	"block-in-blockquote-deferred.md": "# H\n\n> first quoted\n> \n> ^quote-deferred\n",
	// Block ID at the end of a parent list item with a nested sub-list. mdast's
	// listItem range covers the whole sub-tree, so the trailing-only `^id` check
	// must use the listItem's text edge (end of last non-list child), not the
	// listItem's overall end — otherwise `^p` falls victim to `\n  - Child`
	// being scanned as "non-trailing content" and disappears from blockIndex.
	"nested-list-block-ids.md": "# H\n\n- Parent ^p\n  - Child\n\n- Sibling ^s\n\n- Outer\n  - Inner ^i\n",
	// Cross-section duplicate `^id`: per Brief line 90 the index resolves to
	// the first occurrence; the outline must NOT advertise `dupe` under
	// "Second section" either, otherwise it lists a marker that
	// `get_fragment` can't reach there.
	"duplicate-block-ids.md":
		"# First section\n\nParagraph A. ^dupe\n\nParagraph B. ^dupe\n\n# Second section\n\nParagraph C with another. ^dupe\n",
	"with-frontmatter.md":
		"---\ntitle: Test\ntags: [api, auth]\nbook:\n  author:\n    name: Jane Doe\n---\n\n# Body heading\n\nBody.\n",
	"ambiguous.md": "# Auth\n\nFirst Auth body.\n\n# Auth\n\nSecond Auth body.\n",
	// Non-markdown asset — addressable via vault tree but rejected by
	// direct-read tools per VAULT_EXTENSIONS predicate.
	"secret.txt": "secret data\n",
	// Frontmatter-only note — has no body, so file fragments must still
	// skip the YAML rather than fall through to offset 0.
	"fm-only.md": "---\ntitle: only\n---\n",
	// Hidden directory — direct-read tools must return PATH_NOT_FOUND
	// (Brief line 928: hidden files are policy-excluded by default).
	".obsidian": { "notes.md": "# config\n\nshould not be readable.\n" },
	// Embeds with Obsidian fragment syntax (`#page=N`, `#t=Ns`, `#Section`).
	// `guessEmbedKind` must classify each by extension regardless of the
	// trailing `#fragment`; otherwise pdf/media embeds get mis-tagged as note.
	"with-embeds.md": "# H\n\n![[paper.pdf#page=2]]\n\n![[clip.mp4#t=10]]\n\n![[image.png#frag]]\n\n![[note#Section]]\n",
	// Wikilinks inside code/inlineCode are documentation, not graph edges.
	// `extractWikilinks` must filter them via the parser's `excludedRanges`.
	"with-code-wikilinks.md":
		"# H\n\nReal: [[Real]].\n\nInline `[[Fake]]` should not count.\n\n```\n[[AlsoFake]]\n```\n\nMore real: [[Other]].\n",
	// Wikilinks inside math (`$...$` / `$$...$$`) are notation, not graph
	// edges — Obsidian renders math via MathJax/KaTeX and doesn't resolve
	// `[[...]]` inside it. Same exclusion semantics as code spans.
	"with-math-wikilinks.md":
		"# H\n\nReal: [[Real]].\n\nInline $[[Fake]]$ should not count.\n\n$$\n[[AlsoFake]]\n$$\n\nMore real: [[Other]].\n",
	// CommonMark backslash-escape: `\[[X]]` is literal text, not a link.
	// `extractWikilinks` filters by leading-backslash count alongside its
	// existing code/math `excludedRanges` skip.
	"with-escaped-wikilinks.md":
		"# H\n\nReal: [[Real]].\n\nEscaped: \\[[NoLink]].\n\nMore real: [[Other]].\n\nDouble: \\\\[[StillReal]].\n",
	// Nested-list parent with `^id` and a child whose inline-code span
	// contains a wikilink. Regression guard for buildBlockFragment's
	// extract-then-strip ordering: stripping ` ^p` mid-`raw` would shift
	// the child wikilink's offset out of sync with `excludedRanges`.
	"nested-list-block-with-code-child.md":
		"# H\n\n- Parent ^p\n  - Child with `[[Fake]]` inline code\n  - Real: [[Real]]\n",
};

/**
 * UUID v4 regex (RFC 4122 §4.4). Reused across test files to avoid
 * re-defining the same pattern in two places.
 */
export const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
