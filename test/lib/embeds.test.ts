/**
 * Embed expansion tests — cycle detection, max_depth, non-markdown
 * targets, unresolved targets. Uses an in-memory ParsedFile loader so
 * tests don't touch disk.
 */

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { type EmbedExpansionContext, expandEmbed } from "../../src/lib/embeds.js";
import { type ParsedFile, parseFile } from "../../src/lib/parser.js";
import { type VaultRoot, validateVaultRoot } from "../../src/lib/validatePath.js";
import { type ResolvedWikilink, resolveWikilink } from "../../src/lib/wikilinks.js";
import { FakeVaultIndex } from "../helpers/fakeVaultIndex.js";
import { createTempVault, FAKE_VAULT_ROOT } from "../helpers/vault.js";

function makeContext(args: {
	files: Record<string, string>;
	maxDepth?: number;
	vaultRoot?: VaultRoot;
	includeHidden?: boolean;
}): EmbedExpansionContext {
	const cache = new Map<string, ParsedFile | null>();
	return {
		vaultIndex: new FakeVaultIndex({ files: Object.keys(args.files) }),
		// FAKE_VAULT_ROOT points at a non-existent path so the asset probe's
		// validatePath rejects → assetExistsOnDisk catches → returns false. Tests
		// that need a real probe (asset-existence describe) pass their own root.
		vaultRoot: args.vaultRoot ?? FAKE_VAULT_ROOT,
		visited: new Set<string>(),
		maxDepth: args.maxDepth ?? 10,
		includeHidden: args.includeHidden ?? false,
		loadFile: async (rel) => {
			if (cache.has(rel)) return cache.get(rel) ?? null;
			const src = args.files[rel];
			if (src === undefined) {
				cache.set(rel, null);
				return null;
			}
			const parsed = parseFile(src, rel);
			cache.set(rel, parsed);
			return parsed;
		},
	};
}

describe("embeds — non-expansion outcomes", () => {
	test("max_depth_exceeded when depth > maxDepth", async () => {
		const ctx = makeContext({ files: { "a.md": "# A\n" }, maxDepth: 1 });
		const resolved: ResolvedWikilink = { rawTarget: "a", resolved: true, targetFile: "a.md" };
		const result = await expandEmbed(resolved, "src.md", ctx, 2);
		expect(result.expanded).toBe(false);
		expect(result.expansion_error).toBe("max_depth_exceeded");
	});

	test("unresolved_file when target is not in vault", async () => {
		const ctx = makeContext({ files: { "a.md": "# A\n" } });
		const resolved = resolveWikilink("ghost", "src.md", ctx.vaultIndex);
		const result = await expandEmbed(resolved, "src.md", ctx, 1);
		expect(result.expansion_error).toBe("unresolved_file");
	});

	test("ambiguous_file when basename match is ambiguous", async () => {
		const ctx = makeContext({ files: { "x/note.md": "", "y/note.md": "" } });
		const resolved = resolveWikilink("note", "src.md", ctx.vaultIndex);
		const result = await expandEmbed(resolved, "src.md", ctx, 1);
		expect(result.expansion_error).toBe("ambiguous_file");
	});

	test("non_markdown_target for image/pdf/media targets", async () => {
		const ctx = makeContext({ files: { "img.png": "binary" } });
		const resolved: ResolvedWikilink = { rawTarget: "img.png", resolved: true, targetFile: "img.png" };
		const result = await expandEmbed(resolved, "src.md", ctx, 1);
		expect(result.expansion_error).toBe("non_markdown_target");
	});
});

describe("embeds — successful expansion", () => {
	test("expands simple body", async () => {
		const ctx = makeContext({ files: { "a.md": "# A\n\nA body content.\n" } });
		const resolved = resolveWikilink("a", "src.md", ctx.vaultIndex);
		const result = await expandEmbed(resolved, "src.md", ctx, 1);
		expect(result.expanded).toBe(true);
		expect(result.expanded_content).toContain("A body content");
	});
});

describe("embeds — unresolved heading", () => {
	test("![[target#missing]] returns unresolved_heading, NOT whole-file expansion", async () => {
		const ctx = makeContext({
			files: { "target.md": "# Other\n\nSecret content that must NOT leak.\n" },
		});
		const resolved = resolveWikilink("target#nope", "host.md", ctx.vaultIndex);
		expect(resolved.targetFile).toBe("target.md");
		expect(resolved.targetHeadingPath).toBeUndefined();
		expect(resolved.headingResolutionFailed).toBe(true);

		const result = await expandEmbed(resolved, "host.md", ctx, 1);
		expect(result.expanded).toBe(false);
		expect(result.expansion_error).toBe("unresolved_heading");
		expect(result.expanded_content).toBeUndefined();
	});

	test("heading-less embed ![[target]] still expands the whole file", async () => {
		const ctx = makeContext({
			files: { "target.md": "# Other\n\nWhole-file embed content.\n" },
		});
		const resolved = resolveWikilink("target", "host.md", ctx.vaultIndex);
		expect(resolved.headingResolutionFailed).toBeUndefined();

		const result = await expandEmbed(resolved, "host.md", ctx, 1);
		expect(result.expanded).toBe(true);
		expect(result.expanded_content).toContain("Whole-file embed content");
	});
});

describe("embeds — asset existence probe", () => {
	// The markdown index doesn't track non-markdown assets, so probe the
	// filesystem to distinguish "asset doesn't exist" from "asset exists but
	// is non-markdown."
	let assetVault: { path: string; cleanup: () => Promise<void> };
	let assetRoot: VaultRoot;

	beforeAll(async () => {
		assetVault = await createTempVault({ "image.png": "fake-png-bytes" });
		assetRoot = await validateVaultRoot(assetVault.path);
	});

	afterAll(async () => {
		await assetVault.cleanup();
	});

	test("![[image.png]] with image on disk → non_markdown_target", async () => {
		const ctx = makeContext({ files: { "src.md": "" }, vaultRoot: assetRoot });
		const resolved = resolveWikilink("image.png", "src.md", ctx.vaultIndex);
		expect(resolved.resolved).toBe(false);
		const result = await expandEmbed(resolved, "src.md", ctx, 1);
		expect(result.expansion_error).toBe("non_markdown_target");
	});

	test("![[ghost.png]] with no file on disk → unresolved_file", async () => {
		const ctx = makeContext({ files: { "src.md": "" }, vaultRoot: assetRoot });
		const resolved = resolveWikilink("ghost.png", "src.md", ctx.vaultIndex);
		expect(resolved.resolved).toBe(false);
		const result = await expandEmbed(resolved, "src.md", ctx, 1);
		expect(result.expansion_error).toBe("unresolved_file");
	});
});

describe("embeds — hidden asset policy", () => {
	// Hidden-path policy is "all-or-nothing per server".
	// Without a hidden-gate in `assetExistsOnDisk`, validatePath + stat
	// would let `![[.secret.png]]` return `non_markdown_target` (i.e.
	// "exists") — a side-channel revealing hidden assets. The gate makes
	// hidden assets indistinguishable from missing ones (both →
	// `unresolved_file`).
	let hiddenVault: { path: string; cleanup: () => Promise<void> };
	let hiddenRoot: VaultRoot;

	beforeAll(async () => {
		hiddenVault = await createTempVault({ ".secret.png": "fake-png", "image.png": "fake-png" });
		hiddenRoot = await validateVaultRoot(hiddenVault.path);
	});

	afterAll(async () => {
		await hiddenVault.cleanup();
	});

	test("![[.secret.png]] with hidden file on disk → unresolved_file (NOT non_markdown_target)", async () => {
		const ctx = makeContext({ files: { "src.md": "" }, vaultRoot: hiddenRoot });
		const resolved = resolveWikilink(".secret.png", "src.md", ctx.vaultIndex);
		expect(resolved.resolved).toBe(false);
		const result = await expandEmbed(resolved, "src.md", ctx, 1);
		expect(result.expansion_error).toBe("unresolved_file");
	});

	test("regression: visible ![[image.png]] still routes to non_markdown_target", async () => {
		const ctx = makeContext({ files: { "src.md": "" }, vaultRoot: hiddenRoot });
		const resolved = resolveWikilink("image.png", "src.md", ctx.vaultIndex);
		expect(resolved.resolved).toBe(false);
		const result = await expandEmbed(resolved, "src.md", ctx, 1);
		expect(result.expansion_error).toBe("non_markdown_target");
	});
});

describe("embeds — index-cache directory exclusion", () => {
	// `.vault-mcp` is unreachable through every surface, independent of
	// `includeHidden`. Without the gate in `assetExistsOnDisk`, an embed
	// like `![[.vault-mcp/index.sqlite3]]` would surface as
	// `non_markdown_target` and confirm the cache file's existence.
	let cacheVault: { path: string; cleanup: () => Promise<void> };
	let cacheRoot: VaultRoot;

	beforeAll(async () => {
		cacheVault = await createTempVault({
			".vault-mcp": { "foo.png": "fake-png" },
			"image.png": "fake-png",
		});
		cacheRoot = await validateVaultRoot(cacheVault.path);
	});

	afterAll(async () => {
		await cacheVault.cleanup();
	});

	test("![[.vault-mcp/foo.png]] with includeHidden=true → unresolved_file (NOT non_markdown_target)", async () => {
		// `includeHidden: true` defeats the hidden-path gate; the cache
		// gate must fire on top of it.
		const ctx = makeContext({ files: { "src.md": "" }, vaultRoot: cacheRoot, includeHidden: true });
		const resolved = resolveWikilink(".vault-mcp/foo.png", "src.md", ctx.vaultIndex);
		expect(resolved.resolved).toBe(false);
		const result = await expandEmbed(resolved, "src.md", ctx, 1);
		expect(result.expansion_error).toBe("unresolved_file");
	});

	test("regression: ![[image.png]] still surfaces as non_markdown_target with includeHidden=true", async () => {
		const ctx = makeContext({ files: { "src.md": "" }, vaultRoot: cacheRoot, includeHidden: true });
		const resolved = resolveWikilink("image.png", "src.md", ctx.vaultIndex);
		expect(resolved.resolved).toBe(false);
		const result = await expandEmbed(resolved, "src.md", ctx, 1);
		expect(result.expansion_error).toBe("non_markdown_target");
	});
});

describe("embeds — source-relative asset probe", () => {
	// Asset probes for `./X` and `../X` resolve against the SOURCE file's
	// directory, matching the note-link resolver. Without this,
	// `notes/host.md` containing `![[./image.png]]` would probe vault-root
	// `image.png` and return `unresolved_file` despite the file existing
	// at `notes/image.png`.
	let nestedVault: { path: string; cleanup: () => Promise<void> };
	let nestedRoot: VaultRoot;

	beforeAll(async () => {
		nestedVault = await createTempVault({
			notes: { "image.png": "fake-png", assets: { "chart.svg": "fake-svg" } },
			"escape.png": "fake-png",
		});
		nestedRoot = await validateVaultRoot(nestedVault.path);
	});

	afterAll(async () => {
		await nestedVault.cleanup();
	});

	test("![[./image.png]] from notes/host.md → non_markdown_target (resolves notes/image.png)", async () => {
		const ctx = makeContext({ files: { "notes/host.md": "" }, vaultRoot: nestedRoot });
		const resolved = resolveWikilink("./image.png", "notes/host.md", ctx.vaultIndex);
		expect(resolved.resolved).toBe(false);
		const result = await expandEmbed(resolved, "notes/host.md", ctx, 1);
		expect(result.expansion_error).toBe("non_markdown_target");
	});

	test("![[../assets/chart.svg]] from notes/sub/host.md resolves to notes/assets/chart.svg", async () => {
		const ctx = makeContext({ files: { "notes/sub/host.md": "" }, vaultRoot: nestedRoot });
		const resolved = resolveWikilink("../assets/chart.svg", "notes/sub/host.md", ctx.vaultIndex);
		expect(resolved.resolved).toBe(false);
		const result = await expandEmbed(resolved, "notes/sub/host.md", ctx, 1);
		expect(result.expansion_error).toBe("non_markdown_target");
	});

	test("counter: ![[./missing.png]] from notes/host.md → unresolved_file (asset truly absent)", async () => {
		const ctx = makeContext({ files: { "notes/host.md": "" }, vaultRoot: nestedRoot });
		const resolved = resolveWikilink("./missing.png", "notes/host.md", ctx.vaultIndex);
		expect(resolved.resolved).toBe(false);
		const result = await expandEmbed(resolved, "notes/host.md", ctx, 1);
		expect(result.expansion_error).toBe("unresolved_file");
	});

	test("counter: ![[../../escape.png]] vault-escape from notes/sub/host.md → unresolved_file", async () => {
		// `notes/sub/host.md` joined with `../../escape.png` normalizes to
		// `escape.png` (vault root) — that's still INSIDE the vault, so this
		// case actually resolves. To genuinely escape, source needs to be
		// shallower. Use a root-level source for true escape.
		const ctx = makeContext({ files: { "host.md": "" }, vaultRoot: nestedRoot });
		const resolved = resolveWikilink("../escape.png", "host.md", ctx.vaultIndex);
		expect(resolved.resolved).toBe(false);
		const result = await expandEmbed(resolved, "host.md", ctx, 1);
		// posix.normalize("../escape.png") === "../escape.png" → starts
		// with "../" → vault-escape rejected → unresolved_file.
		expect(result.expansion_error).toBe("unresolved_file");
	});

	test("![[image.png]] (bare) from notes/host.md → resolves to notes/image.png (source-relative-first)", async () => {
		// Bare asset embeds probe source-relative (notes/) first, then
		// fall back to vault-root — matches Obsidian's "shortest path
		// that uniquely identifies" default for the common case where
		// the asset is colocated with the host note.
		const ctx = makeContext({ files: { "notes/host.md": "" }, vaultRoot: nestedRoot });
		const resolved = resolveWikilink("image.png", "notes/host.md", ctx.vaultIndex);
		expect(resolved.resolved).toBe(false);
		const result = await expandEmbed(resolved, "notes/host.md", ctx, 1);
		expect(result.expansion_error).toBe("non_markdown_target");
	});

	test("counter: ![[image.png]] from root host.md still resolves to vault-root image.png", async () => {
		// Source dir is `.` for root-level files → source-relative is
		// skipped, only vault-root probed. This is the existing behavior
		// (no regression).
		const ctx = makeContext({ files: { "host.md": "" }, vaultRoot: nestedRoot });
		const resolved = resolveWikilink("escape.png", "host.md", ctx.vaultIndex);
		expect(resolved.resolved).toBe(false);
		const result = await expandEmbed(resolved, "host.md", ctx, 1);
		expect(result.expansion_error).toBe("non_markdown_target");
	});

	test("counter: ![[folder/image.png]] (slash-bearing) is vault-root-relative ONLY", async () => {
		// Slash-bearing inputs name an explicit vault-root path. Without
		// this guard, `![[notes/image.png]]` from `notes/host.md` would
		// also probe `notes/notes/image.png` (source-relative) which is
		// confusing. Source-relative is bare-filename-only.
		const ctx = makeContext({ files: { "notes/host.md": "" }, vaultRoot: nestedRoot });
		// `notes/image.png` exists at vault-root sense — verify normal
		// vault-root probe still works.
		const resolved = resolveWikilink("notes/image.png", "notes/host.md", ctx.vaultIndex);
		expect(resolved.resolved).toBe(false);
		const result = await expandEmbed(resolved, "notes/host.md", ctx, 1);
		expect(result.expansion_error).toBe("non_markdown_target");
	});
});

describe("embeds — cycle detection", () => {
	test("self-cycle (a → a) keeps the inner ![[a]] as source text", async () => {
		const ctx = makeContext({ files: { "a.md": "# A\n\n![[a]]\n" } });
		const resolved = resolveWikilink("a", "src.md", ctx.vaultIndex);
		const result = await expandEmbed(resolved, "src.md", ctx, 1);
		// Outer call expands; the recursive child sees the same target
		// already in `visited` and returns cycle_detected. Failed children
		// leave the source `![[a]]` text in place.
		expect(result.expanded).toBe(true);
		expect(result.expanded_content).toContain("![[a]]");
	});

	test("two-step cycle (a → b → a) breaks at the cycle", async () => {
		const ctx = makeContext({
			files: {
				"a.md": "# A\n\n![[b]]\n",
				"b.md": "# B\n\n![[a]]\n",
			},
		});
		const resolved = resolveWikilink("a", "src.md", ctx.vaultIndex);
		const result = await expandEmbed(resolved, "src.md", ctx, 1);
		expect(result.expanded).toBe(true);
		expect(result.expanded_content).toContain("![[a]]");
	});

	test("block embed strips trailing ^id marker", async () => {
		// `sliceTarget` would return the raw block slice INCLUDING the
		// trailing `^foo` marker. `getFragment.ts` strips it via regex on
		// direct reads, so the same block surfaced different content via
		// the two access paths. The strip must mirror getFragment's
		// `(?:^|[ \t])\^${id}\s*$` regex.
		const ctx = makeContext({
			files: { "b.md": "# Section\n\nfirst para.\n\nblock body ^foo\n" },
		});
		const resolved = resolveWikilink("b#^foo", "src.md", ctx.vaultIndex);
		expect(resolved.targetBlockId).toBe("foo");
		const result = await expandEmbed(resolved, "src.md", ctx, 1);
		expect(result.expanded).toBe(true);
		expect(result.expanded_content).toContain("block body");
		expect(result.expanded_content).not.toContain("^foo");
	});

	test("listItem block with nested code-span: marker strip preserves excludedRanges", async () => {
		// listItem blocks' offsetRange covers nested sub-lists past the
		// marker. Stripping the `^id` marker BEFORE recursivelyExpandSlice
		// shifts post-marker characters left in slice.content while
		// excludedRanges retain parent-absolute offsets — `sliceStart +
		// m.index` then understates true source offsets and the
		// excludedRanges check misses code spans in nested content,
		// leaking inline-code wikilinks as real embeds.
		const ctx = makeContext({
			files: {
				"b.md": "- parent text ^foo\n  - subitem `![[child]]` text\n",
				"child.md": "child body",
			},
		});
		const resolved = resolveWikilink("b#^foo", "src.md", ctx.vaultIndex);
		expect(resolved.targetBlockId).toBe("foo");
		const result = await expandEmbed(resolved, "src.md", ctx, 1);
		expect(result.expanded).toBe(true);
		expect(result.expanded_content).not.toContain("^foo");
		expect(result.expanded_content).toContain("`![[child]]`");
		expect(result.expanded_content).not.toContain("child body");
	});

	test("duplicate-heading file: ![[#A]] from second section expands first (no false cycle)", async () => {
		// File has two sections with identical heading text. Obsidian
		// first-match resolves `[[#A]]` to the first section regardless
		// of source. A (file, heading_path) visited key would collapse
		// the second section's host seed onto the first section's
		// resolved target → false cycle_detected. With stable_id in the
		// cycle key, host (id2) and target (id1) get
		// distinct keys; expansion succeeds.
		const source = "# A\n\nfirst body\n\n# A\n\nsecond body\n";
		const parsed = parseFile(source, "a.md");
		expect(parsed.headings.length).toBe(2);
		const firstId = parsed.headings[0]?.stable_id;
		const secondId = parsed.headings[1]?.stable_id;
		expect(firstId).toBeDefined();
		expect(secondId).toBeDefined();
		expect(firstId).not.toBe(secondId);
		const ctx = makeContext({
			files: { "a.md": source },
		});
		// FakeVaultIndex needs heading seeds for resolveHeading to fire.
		ctx.vaultIndex = new FakeVaultIndex({
			files: ["a.md"],
			headings: {
				"a.md": parsed.headings.map((h) => ({ stable_id: h.stable_id, heading_path: h.headingPath })),
			},
		});
		// Seed visited with the second section's host fragment cycle key
		// (mirrors what get_fragment does before recursing into the body).
		ctx.visited.add(`a.md#h:${secondId}^`);
		// Expand `![[#A]]` from the second section's body. Resolves to
		// first section (first-match). A (file, heading_path) visited
		// key would falsely detect a cycle because (a.md, ["A"]) was
		// already in visited.
		const resolved = resolveWikilink("#A", "a.md", ctx.vaultIndex);
		const result = await expandEmbed(resolved, "a.md", ctx, 1);
		expect(result.expanded).toBe(true);
		expect(result.expanded_content).toContain("first body");
	});
});
