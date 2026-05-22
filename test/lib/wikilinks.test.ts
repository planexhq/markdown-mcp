/**
 * Wikilink extraction and Obsidian-style three-phase resolution tests.
 *
 * Extraction tests cover: code-fence/math exclusion, backslash-escape,
 * link_ordinal scoping, embed (`!`) prefix, alias (`|`) handling.
 *
 * Resolution tests cover: explicit-relpath match, basename-shortest-path
 * winner, ambiguous basename → `candidates`, heading match, missing
 * heading (file resolves but heading does not), block fragment passes
 * through unvalidated.
 */

import { afterEach, describe, expect, test, vi } from "vitest";

import {
	basenameNoExt,
	buildEmbed,
	buildOutgoingLink,
	extractWikilinks,
	resolveWikilink,
	stripMarkdownExt,
} from "../../src/lib/wikilinks.js";
import { FakeVaultIndex } from "../helpers/fakeVaultIndex.js";

// ─── Extraction ────────────────────────────────────────────────────────────

describe("wikilinks — extractWikilinks", () => {
	test("plain wikilink", () => {
		const out = extractWikilinks({ source: "see [[Auth]] for more", sliceStart: 0, excludedRanges: [] });
		expect(out).toHaveLength(1);
		expect(out[0]).toMatchObject({ rawTarget: "Auth", isEmbed: false, ordinalInSection: 1 });
	});

	test("embed prefix", () => {
		const out = extractWikilinks({ source: "![[Note]]", sliceStart: 0, excludedRanges: [] });
		expect(out[0]?.isEmbed).toBe(true);
	});

	test("alias via pipe", () => {
		const out = extractWikilinks({ source: "[[target.md|Display]]", sliceStart: 0, excludedRanges: [] });
		expect(out[0]).toMatchObject({ rawTarget: "target.md", alias: "Display" });
	});

	test("link_ordinal increments document order", () => {
		const out = extractWikilinks({ source: "[[A]] then [[B]] then [[C]]", sliceStart: 0, excludedRanges: [] });
		expect(out.map((e) => e.ordinalInSection)).toEqual([1, 2, 3]);
	});

	test("backslash-escaped wikilink is skipped", () => {
		const out = extractWikilinks({
			source: "real [[X]] vs escaped \\[[Y]] vs double \\\\[[Z]]",
			sliceStart: 0,
			excludedRanges: [],
		});
		expect(out.map((e) => e.rawTarget)).toEqual(["X", "Z"]);
	});

	test("excluded range filters wikilink inside it", () => {
		const src = "ok [[A]] code [[B]] end";
		const aIdx = src.indexOf("[[A]]");
		const bIdx = src.indexOf("[[B]]");
		// Mark the byte range covering [[B]] as excluded
		const out = extractWikilinks({
			source: src,
			sliceStart: 0,
			excludedRanges: [{ offsetStart: bIdx - 2, offsetEnd: bIdx + 5 }],
		});
		expect(out).toHaveLength(1);
		expect(out[0]?.absoluteOffset).toBe(aIdx);
	});

	test("matchLength includes ! and brackets", () => {
		const out = extractWikilinks({ source: "![[Note]]", sliceStart: 0, excludedRanges: [] });
		// "![[Note]]" is 9 chars
		expect(out[0]?.matchLength).toBe(9);
	});

	test("absoluteOffset uses sliceStart", () => {
		const out = extractWikilinks({ source: "[[X]]", sliceStart: 100, excludedRanges: [] });
		expect(out[0]?.absoluteOffset).toBe(100);
	});

	test("rawTarget NFC-normalizes decomposed Unicode", () => {
		// Vault paths are NFC (watcher / scanner reject NFD via isNonNfc).
		// `[[Cafe\u0301]]` (NFD: C-a-f-e + combining acute) lower-cases to
		// NFD and would miss NFC-keyed `filesByBasename`. extractWikilinks
		// canonicalizes at the source so storage is NFC and downstream
		// resolution against an NFC vault index hits.
		const nfdSource = "see [[Cafe\u0301]] tonight";
		const out = extractWikilinks({ source: nfdSource, sliceStart: 0, excludedRanges: [] });
		expect(out).toHaveLength(1);
		expect(out[0]?.rawTarget).toBe("Café");
		expect(out[0]?.rawTarget).toBe("Café".normalize("NFC"));
	});

	test("[[./../target]] collapses to ../target at extraction (redundant ./)", () => {
		// computeIncomingCandidates only enumerates canonical `./form` and
		// `../form` shapes. Storing `./../target` verbatim hides the
		// backlink row from the SQL prefilter.
		const out = extractWikilinks({ source: "[[./../target]]", sliceStart: 0, excludedRanges: [] });
		expect(out[0]?.rawTarget).toBe("../target");
	});

	test("[[.././target]] collapses to ../target at extraction (redundant .)", () => {
		const out = extractWikilinks({ source: "[[.././target]]", sliceStart: 0, excludedRanges: [] });
		expect(out[0]?.rawTarget).toBe("../target");
	});

	test("[[X/./Y]] collapses to X/Y at extraction (redundant inner .)", () => {
		const out = extractWikilinks({ source: "[[X/./Y]]", sliceStart: 0, excludedRanges: [] });
		expect(out[0]?.rawTarget).toBe("X/Y");
	});

	test("[[./target]] keeps its leading ./ marker (Phase 0 source-relative)", () => {
		// `./target` and `target` are NOT equivalent: the first is Phase 0
		// (source-relative) while the second is Phase 2/3 (basename
		// shortest-path-wins). Stripping the marker would regress
		// resolution against a vault with multiple basename matches.
		const out = extractWikilinks({ source: "[[./target]]", sliceStart: 0, excludedRanges: [] });
		expect(out[0]?.rawTarget).toBe("./target");
	});

	test("[[./../target#Heading]] preserves the heading suffix after normalize", () => {
		const out = extractWikilinks({ source: "[[./../target#Heading]]", sliceStart: 0, excludedRanges: [] });
		expect(out[0]?.rawTarget).toBe("../target#Heading");
	});

	test("[[././target]] collapses to ./target (preserves Phase-0 marker)", () => {
		const out = extractWikilinks({ source: "[[././target]]", sliceStart: 0, excludedRanges: [] });
		expect(out[0]?.rawTarget).toBe("./target");
	});

	test("[[./sub/../target]] collapses to ./target (Phase-0 marker survives ../)", () => {
		const out = extractWikilinks({ source: "[[./sub/../target]]", sliceStart: 0, excludedRanges: [] });
		expect(out[0]?.rawTarget).toBe("./target");
	});

	test("[[./X/./Y]] collapses to ./X/Y (inner ./ removed, leading marker kept)", () => {
		const out = extractWikilinks({ source: "[[./X/./Y]]", sliceStart: 0, excludedRanges: [] });
		expect(out[0]?.rawTarget).toBe("./X/Y");
	});

	test("[[././target#Heading]] preserves the heading suffix after canonicalization", () => {
		const out = extractWikilinks({ source: "[[././target#Heading]]", sliceStart: 0, excludedRanges: [] });
		expect(out[0]?.rawTarget).toBe("./target#Heading");
	});
});

// ─── Helpers ───────────────────────────────────────────────────────────────

describe("wikilinks — path helpers", () => {
	test("stripMarkdownExt strips configured extensions only", () => {
		// Default VAULT_EXTENSIONS is ["md"]. Per the single-predicate
		// file-content surface contract, wikilinks honors the configured
		// ext set — `.markdown`/`.mdx` aren't stripped under default
		// config because they aren't indexable either.
		expect(stripMarkdownExt("notes/auth.md")).toBe("notes/auth");
		expect(stripMarkdownExt("notes/auth")).toBe("notes/auth");
		expect(stripMarkdownExt("foo.markdown")).toBe("foo.markdown");
	});

	test("stripMarkdownExt strips configured exts when VAULT_EXTENSIONS is widened", () => {
		vi.stubEnv("VAULT_EXTENSIONS", "md,markdown,mdx");
		try {
			expect(stripMarkdownExt("foo.markdown")).toBe("foo");
			expect(stripMarkdownExt("foo.MDX")).toBe("foo");
		} finally {
			vi.unstubAllEnvs();
		}
	});

	test("stripMarkdownExt strips a configured non-default ext", () => {
		// VAULT_EXTENSIONS=md,txt makes target.txt indexable; basename map
		// keying must drop the .txt so `[[target]]` resolves.
		vi.stubEnv("VAULT_EXTENSIONS", "md,txt");
		try {
			expect(stripMarkdownExt("notes/target.txt")).toBe("notes/target");
		} finally {
			vi.unstubAllEnvs();
		}
	});

	test("basenameNoExt lowercases and strips dir + configured ext", () => {
		expect(basenameNoExt("Notes/Auth.md")).toBe("auth");
		expect(basenameNoExt("auth.md")).toBe("auth");
	});

	test("basenameNoExt strips .markdown when configured", () => {
		vi.stubEnv("VAULT_EXTENSIONS", "md,markdown,mdx");
		try {
			expect(basenameNoExt("a/b/c.markdown")).toBe("c");
		} finally {
			vi.unstubAllEnvs();
		}
	});
});

// ─── Resolution ────────────────────────────────────────────────────────────

describe("wikilinks — resolveWikilink", () => {
	test("explicit relpath with .md resolves", () => {
		const idx = new FakeVaultIndex({ files: ["notes/auth.md"] });
		const r = resolveWikilink("notes/auth.md", "src.md", idx);
		expect(r).toMatchObject({ resolved: true, targetFile: "notes/auth.md" });
	});

	test("explicit relpath without .md tries with .md appended", () => {
		const idx = new FakeVaultIndex({ files: ["notes/auth.md"] });
		const r = resolveWikilink("notes/auth", "src.md", idx);
		expect(r).toMatchObject({ resolved: true, targetFile: "notes/auth.md" });
	});

	test("explicit relpath miss returns unresolved without candidates", () => {
		const idx = new FakeVaultIndex({ files: ["notes/auth.md"] });
		const r = resolveWikilink("missing/x.md", "src.md", idx);
		expect(r.resolved).toBe(false);
		expect(r.candidates).toBeUndefined();
	});

	test("basename match unique resolves", () => {
		const idx = new FakeVaultIndex({ files: ["notes/auth.md"] });
		const r = resolveWikilink("auth", "src.md", idx);
		expect(r).toMatchObject({ resolved: true, targetFile: "notes/auth.md" });
	});

	test("basename match shortest-path wins (Obsidian closest-to-root)", () => {
		const idx = new FakeVaultIndex({ files: ["auth.md", "notes/folder/auth.md"] });
		const r = resolveWikilink("auth", "src.md", idx);
		expect(r).toMatchObject({ resolved: true, targetFile: "auth.md" });
	});

	test("basename equal-length matches → ambiguous + candidates", () => {
		const idx = new FakeVaultIndex({ files: ["a/auth.md", "b/auth.md"] });
		const r = resolveWikilink("auth", "src.md", idx);
		expect(r.resolved).toBe(false);
		expect(r.candidates?.map((c) => c.file)).toEqual(["a/auth.md", "b/auth.md"]);
	});

	test("basename miss returns unresolved without candidates", () => {
		const idx = new FakeVaultIndex({ files: ["other.md"] });
		const r = resolveWikilink("auth", "src.md", idx);
		expect(r.resolved).toBe(false);
		expect(r.candidates).toBeUndefined();
	});

	test("heading anchor matches", () => {
		const idx = new FakeVaultIndex({
			files: ["auth.md"],
			headings: { "auth.md": [{ stable_id: "h:abc", heading_path: ["OAuth2"] }] },
		});
		const r = resolveWikilink("auth#OAuth2", "src.md", idx);
		expect(r).toMatchObject({ resolved: true, targetFile: "auth.md", targetHeadingPath: ["OAuth2"] });
	});

	test("heading anchor with > path", () => {
		const idx = new FakeVaultIndex({
			files: ["auth.md"],
			headings: { "auth.md": [{ stable_id: "h:def", heading_path: ["A", "B"] }] },
		});
		const r = resolveWikilink("auth#A > B", "src.md", idx);
		expect(r.targetHeadingPath).toEqual(["A", "B"]);
	});

	test("heading miss leaves file resolved, no targetHeadingPath, sets headingResolutionFailed", () => {
		// The flag distinguishes `![[a#missing]]` (embed should fail with
		// unresolved_heading) from `![[a]]` (whole-file embed).
		const idx = new FakeVaultIndex({
			files: ["auth.md"],
			headings: { "auth.md": [{ stable_id: "h:abc", heading_path: ["OAuth2"] }] },
		});
		const r = resolveWikilink("auth#NoSuch", "src.md", idx);
		expect(r.resolved).toBe(true);
		expect(r.targetFile).toBe("auth.md");
		expect(r.targetHeadingPath).toBeUndefined();
		expect(r.headingResolutionFailed).toBe(true);
	});

	test("heading-less link does NOT set headingResolutionFailed", () => {
		const idx = new FakeVaultIndex({ files: ["auth.md"] });
		const r = resolveWikilink("auth", "src.md", idx);
		expect(r.resolved).toBe(true);
		expect(r.headingResolutionFailed).toBeUndefined();
	});

	test("duplicate heading sets duplicateHeading + candidates", () => {
		const idx = new FakeVaultIndex({
			files: ["auth.md"],
			headings: {
				"auth.md": [
					{ stable_id: "h:1", heading_path: ["Auth"] },
					{ stable_id: "h:2", heading_path: ["Auth"] },
				],
			},
		});
		const r = resolveWikilink("auth#Auth", "src.md", idx);
		expect(r.duplicateHeading).toBe(true);
		expect(r.candidates).toHaveLength(2);
	});

	test("block ref (^id) sets targetBlockId without validating existence", () => {
		const idx = new FakeVaultIndex({ files: ["auth.md"] });
		const r = resolveWikilink("auth#^block-1", "src.md", idx);
		expect(r).toMatchObject({ resolved: true, targetFile: "auth.md", targetBlockId: "block-1" });
	});

	test("empty filePart treats as same-file reference", () => {
		const idx = new FakeVaultIndex({
			files: ["src.md"],
			headings: { "src.md": [{ stable_id: "h:s", heading_path: ["Section"] }] },
		});
		const r = resolveWikilink("#Section", "src.md", idx);
		expect(r).toMatchObject({ resolved: true, targetFile: "src.md", targetHeadingPath: ["Section"] });
	});

	test("blank rawTarget '' (from [[ ]] or [[|alias]]) → unresolved", () => {
		// `[[ ]]` and `[[|alias]]` both produce an empty rawTarget after
		// trim / pipe-split; the link must stay unresolved rather than
		// resolving as an anchorless self-link and persisting a spurious row.
		const idx = new FakeVaultIndex({ files: ["src.md"] });
		expect(resolveWikilink("", "src.md", idx).resolved).toBe(false);
	});

	test("'#' alone (from [[#]]) → unresolved", () => {
		// parseTarget('#') returns {filePart: ''} with no heading and no
		// block — same trivial case as `[[ ]]`.
		const idx = new FakeVaultIndex({ files: ["src.md"] });
		expect(resolveWikilink("#", "src.md", idx).resolved).toBe(false);
	});

	test("counter: '#^block' (from [[#^block]]) still resolves as self-block-link", () => {
		// Block anchor carries semantic content — guard must not reject.
		const idx = new FakeVaultIndex({ files: ["src.md"] });
		const r = resolveWikilink("#^block-1", "src.md", idx);
		expect(r).toMatchObject({ resolved: true, targetFile: "src.md", targetBlockId: "block-1" });
	});
});

describe("wikilinks — buildEmbed / buildOutgoingLink ambiguity mapping", () => {
	test("buildEmbed surfaces duplicate_heading + candidates from the resolver", () => {
		// Without the mapping, `formatOutgoingTarget` skips the ambiguity
		// branch and an embed against a duplicate-heading target renders as
		// a bare resolved target. Symmetric with `buildOutgoingLink` below.
		const idx = new FakeVaultIndex({
			files: ["auth.md"],
			headings: {
				"auth.md": [
					{ stable_id: "h:1", heading_path: ["A", "Auth"] },
					{ stable_id: "h:2", heading_path: ["B", "Auth"] },
				],
			},
		});
		const extracted = extractWikilinks({
			source: "![[auth#Auth]]",
			sliceStart: 0,
			excludedRanges: [],
		});
		const e = extracted[0];
		if (!e) throw new Error("expected one wikilink");
		const resolved = resolveWikilink(e.rawTarget, "src.md", idx);
		expect(resolved.duplicateHeading).toBe(true);
		expect(buildEmbed(e, resolved)).toMatchObject({
			duplicate_heading: true,
			candidates: [
				{ file: "auth.md", heading_path: ["A", "Auth"] },
				{ file: "auth.md", heading_path: ["B", "Auth"] },
			],
		});
		expect(buildOutgoingLink(e, resolved)).toMatchObject({
			duplicate_heading: true,
			candidates: [
				{ file: "auth.md", heading_path: ["A", "Auth"] },
				{ file: "auth.md", heading_path: ["B", "Auth"] },
			],
		});
	});
});

describe("wikilinks — Phase 0 source-relative ./ and ../", () => {
	test("[[./target]] from notes/caller.md resolves to notes/target.md (NOT root target.md)", () => {
		const idx = new FakeVaultIndex({ files: ["notes/target.md", "target.md"] });
		const r = resolveWikilink("./target", "notes/caller.md", idx);
		expect(r).toMatchObject({ resolved: true, targetFile: "notes/target.md" });
	});

	test("[[./target]] from root-level caller resolves to root target", () => {
		// Source dir is root for `caller.md`. `./target` resolves to
		// root-level `target.md` (Obsidian same-directory shorthand).
		const idx = new FakeVaultIndex({ files: ["target.md"] });
		const r = resolveWikilink("./target", "caller.md", idx);
		expect(r).toMatchObject({ resolved: true, targetFile: "target.md" });
	});

	test("[[../target]] from notes/sub/caller.md resolves up one dir", () => {
		const idx = new FakeVaultIndex({ files: ["notes/target.md"] });
		const r = resolveWikilink("../target", "notes/sub/caller.md", idx);
		expect(r).toMatchObject({ resolved: true, targetFile: "notes/target.md" });
	});

	test("[[./folder/target]] from notes/caller.md resolves to notes/folder/target.md", () => {
		const idx = new FakeVaultIndex({ files: ["notes/folder/target.md"] });
		const r = resolveWikilink("./folder/target", "notes/caller.md", idx);
		expect(r).toMatchObject({ resolved: true, targetFile: "notes/folder/target.md" });
	});

	test("[[../../escape]] that exits the vault root returns unresolved", () => {
		// `notes/caller.md` + `../../escape` normalizes to `../escape` —
		// escapes the vault. Strict-prefix check rejects (NOT a vault file).
		const idx = new FakeVaultIndex({ files: ["target.md"] });
		const r = resolveWikilink("../../escape", "notes/caller.md", idx);
		expect(r.resolved).toBe(false);
	});

	test("[[./missing]] when target doesn't exist → unresolved (no candidates)", () => {
		const idx = new FakeVaultIndex({ files: ["notes/other.md"] });
		const r = resolveWikilink("./missing", "notes/caller.md", idx);
		expect(r.resolved).toBe(false);
		expect(r.candidates).toBeUndefined();
	});

	test("[[./diagram.png]] does NOT shadow notes/diagram.png.md (asset-extension input)", () => {
		// Phase 0 ext-append loop is gated on `extname(base) === ""` so a
		// non-markdown asset wikilink never tries `${base}.md`. Without
		// the gate, a literal-named markdown collision
		// `notes/diagram.png.md` would shadow the asset and `buildEmbed`
		// (kind from rawTarget) would expand markdown while reporting
		// `kind: "image"`. Returning unresolved here lets
		// `assetExistsOnDisk` surface the asset via
		// `non_markdown_target`.
		const idx = new FakeVaultIndex({ files: ["notes/diagram.png.md", "notes/host.md"] });
		const r = resolveWikilink("./diagram.png", "notes/host.md", idx);
		expect(r.resolved).toBe(false);
	});

	test("counter: [[./diagram]] (extensionless) still resolves through ext loop", () => {
		const idx = new FakeVaultIndex({ files: ["notes/diagram.md", "notes/host.md"] });
		const r = resolveWikilink("./diagram", "notes/host.md", idx);
		expect(r).toMatchObject({ resolved: true, targetFile: "notes/diagram.md" });
	});
});

describe("wikilinks — Phase 1.5 path-suffix lookup", () => {
	test("[[folder/note]] from caller.md resolves to projects/folder/note.md", () => {
		// Vault-root lookup misses `folder/note(.md)`; suffix lookup finds
		// `projects/folder/note.md` via the basename bucket.
		const idx = new FakeVaultIndex({ files: ["projects/folder/note.md", "caller.md"] });
		const r = resolveWikilink("folder/note", "caller.md", idx);
		expect(r).toMatchObject({ resolved: true, targetFile: "projects/folder/note.md" });
	});

	test("[[folder/note]] with two suffix matches → ambiguous + candidates", () => {
		const idx = new FakeVaultIndex({ files: ["a/folder/note.md", "b/folder/note.md"] });
		const r = resolveWikilink("folder/note", "caller.md", idx);
		expect(r.resolved).toBe(false);
		expect(r.candidates?.map((c) => c.file).sort()).toEqual(["a/folder/note.md", "b/folder/note.md"]);
	});

	test("vault-root lookup wins over path-suffix when both match", () => {
		// Phase 1 returns first; Phase 1.5 only fires if Phase 1 misses.
		const idx = new FakeVaultIndex({ files: ["folder/note.md", "projects/folder/note.md"] });
		const r = resolveWikilink("folder/note", "caller.md", idx);
		expect(r).toMatchObject({ resolved: true, targetFile: "folder/note.md" });
	});

	test("[[folder/note.md]] does NOT match projects/folder/note.mdx (explicit ext required)", () => {
		// Mixed-extension vault. The explicit-extension gate keeps
		// `[[folder/note.md]]` matching `.md` candidates only — without
		// it, stripMarkdownExt on both sides drops the constraint and
		// the .mdx file matches.
		vi.stubEnv("VAULT_EXTENSIONS", "md,mdx");
		try {
			const idx = new FakeVaultIndex({ files: ["projects/folder/note.mdx", "caller.md"] });
			const r = resolveWikilink("folder/note.md", "caller.md", idx);
			expect(r.resolved).toBe(false);
		} finally {
			vi.unstubAllEnvs();
		}
	});

	test("counter: [[folder/note]] (no extension) still matches any configured ext", () => {
		// Without an explicit extension, the gate is inert and the loose
		// suffix match keeps working — `[[folder/note]]` resolves to any
		// configured-extension file.
		vi.stubEnv("VAULT_EXTENSIONS", "md,mdx");
		try {
			const idx = new FakeVaultIndex({ files: ["projects/folder/note.mdx", "caller.md"] });
			const r = resolveWikilink("folder/note", "caller.md", idx);
			expect(r).toMatchObject({ resolved: true, targetFile: "projects/folder/note.mdx" });
		} finally {
			vi.unstubAllEnvs();
		}
	});

	test("[[folder/note.mdx]] still matches the .mdx file (same ext)", () => {
		vi.stubEnv("VAULT_EXTENSIONS", "md,mdx");
		try {
			const idx = new FakeVaultIndex({ files: ["projects/folder/note.mdx", "caller.md"] });
			const r = resolveWikilink("folder/note.mdx", "caller.md", idx);
			expect(r).toMatchObject({ resolved: true, targetFile: "projects/folder/note.mdx" });
		} finally {
			vi.unstubAllEnvs();
		}
	});

	test("D46 — extensionless [[notes/auth]] does NOT silently resolve to .yaml in mixed vaults", () => {
		// Wikilinks INTO YAML are deferred per D46. With VAULT_EXTENSIONS=md,yaml,yml
		// and no matching .md, `findFileWithVaultExt` must skip the YAML
		// extensions; the link stays unresolved rather than retargeting to
		// `notes/auth.yaml`.
		vi.stubEnv("VAULT_EXTENSIONS", "md,yaml,yml");
		try {
			const idx = new FakeVaultIndex({ files: ["notes/auth.yaml", "caller.md"] });
			const r = resolveWikilink("notes/auth", "caller.md", idx);
			expect(r.resolved).toBe(false);
		} finally {
			vi.unstubAllEnvs();
		}
	});

	test("D46 — explicit [[notes/auth.yaml]] does NOT resolve as a markdown wikilink", () => {
		// Phase 1 enters via the slash branch even though `isResolvableLinkTarget`
		// rejects YAML; the early `isAssetPath` gate keeps the YAML target
		// unresolved (Obsidian-style asset semantics) instead of silently
		// landing a `target_file: "notes/auth.yaml"` row in `wikilinks`.
		vi.stubEnv("VAULT_EXTENSIONS", "md,yaml,yml");
		try {
			const idx = new FakeVaultIndex({ files: ["notes/auth.yaml", "caller.md"] });
			const r = resolveWikilink("notes/auth.yaml", "caller.md", idx);
			expect(r.resolved).toBe(false);
		} finally {
			vi.unstubAllEnvs();
		}
	});
});

describe("wikilinks — Phase 1 extension-bearing path-less fall-through", () => {
	test("[[target.md]] (extension, no slash) falls through to Phase 2/3 basename", () => {
		const idx = new FakeVaultIndex({ files: ["notes/target.md"] });
		const r = resolveWikilink("target.md", "caller.md", idx);
		expect(r).toMatchObject({ resolved: true, targetFile: "notes/target.md" });
	});

	test("[[Target.MD]] (mixed case extension) resolves via lowercased basename", () => {
		const idx = new FakeVaultIndex({ files: ["notes/target.md"] });
		const r = resolveWikilink("Target.MD", "caller.md", idx);
		expect(r).toMatchObject({ resolved: true, targetFile: "notes/target.md" });
	});

	test("[[target.md]] with two equal-depth basename matches → ambiguous + candidates", () => {
		const idx = new FakeVaultIndex({ files: ["a/target.md", "b/target.md"] });
		const r = resolveWikilink("target.md", "caller.md", idx);
		expect(r.resolved).toBe(false);
		expect(r.candidates?.map((c) => c.file).sort()).toEqual(["a/target.md", "b/target.md"]);
	});

	test("[[notes/auth.md]] (slash + ext) still unresolved when neither root nor suffix match", () => {
		// Slash-bearing path-less fall-through is NOT enabled — Phase 1.5
		// covers the slash case.
		const idx = new FakeVaultIndex({ files: ["other.md"] });
		const r = resolveWikilink("notes/auth.md", "caller.md", idx);
		expect(r.resolved).toBe(false);
	});

	test("[[notes/diagram.png]] does NOT match notes/diagram.png.md (Phase 1 ext-append gate)", () => {
		// Phase 1 ext-append loop pre-fix tried `${filePart}.${ext}` for
		// non-markdown filePart, so the explicit asset path was shadowed
		// by a literal-named markdown collision. Same gate as Phase 0.
		const idx = new FakeVaultIndex({ files: ["notes/diagram.png.md"] });
		const r = resolveWikilink("notes/diagram.png", "caller.md", idx);
		expect(r.resolved).toBe(false);
	});
});

describe("wikilinks — Phase 1.5 (suffix lookup) asset-extension gate", () => {
	test("[[folder/diagram.png]] does NOT match projects/folder/diagram.png.md via suffix lookup", () => {
		// Bug only triggers when the candidate sits at a deeper directory
		// level than the input — same-level cases pass via `endsWith` miss.
		const idx = new FakeVaultIndex({ files: ["projects/folder/diagram.png.md"] });
		const r = resolveWikilink("folder/diagram.png", "caller.md", idx);
		expect(r.resolved).toBe(false);
	});

	test("counter: [[folder/note]] still suffix-matches projects/folder/note.md", () => {
		const idx = new FakeVaultIndex({ files: ["projects/folder/note.md"] });
		const r = resolveWikilink("folder/note", "caller.md", idx);
		expect(r).toMatchObject({ resolved: true, targetFile: "projects/folder/note.md" });
	});

	test("counter: [[folder/note.md]] still suffix-matches with explicit markdown extension", () => {
		const idx = new FakeVaultIndex({ files: ["projects/folder/note.md"] });
		const r = resolveWikilink("folder/note.md", "caller.md", idx);
		expect(r).toMatchObject({ resolved: true, targetFile: "projects/folder/note.md" });
	});
});

describe("wikilinks — Phase 2 basename gate on non-markdown extension", () => {
	test("[[diagram.png]] does NOT match diagram.png.md via basename lookup", () => {
		// `filesByBasename` keys on extensionless lowercase basename, so
		// `notes/diagram.png.md` strips to `diagram.png` and the lookup
		// for `diagram.png` would otherwise return the markdown
		// collision. `buildEmbed` derives kind from rawTarget (`image`
		// for `.png`) but `target_file` would point at markdown — embed
		// expansion would inline markdown content while reporting
		// `kind: "image"`. Gating Phase 2 on extensionless or
		// markdown-extensioned filePart returns unresolved so
		// `assetExistsOnDisk` reports `non_markdown_target`.
		const idx = new FakeVaultIndex({ files: ["notes/diagram.png.md", "notes/host.md"] });
		const r = resolveWikilink("diagram.png", "notes/host.md", idx);
		expect(r.resolved).toBe(false);
	});

	test("counter: [[auth.md]] still resolves via basename match (markdown extension)", () => {
		const idx = new FakeVaultIndex({ files: ["notes/auth.md"] });
		const r = resolveWikilink("auth.md", "caller.md", idx);
		expect(r).toMatchObject({ resolved: true, targetFile: "notes/auth.md" });
	});

	test("counter: [[auth]] still resolves via basename match (extensionless)", () => {
		const idx = new FakeVaultIndex({ files: ["notes/auth.md"] });
		const r = resolveWikilink("auth", "caller.md", idx);
		expect(r).toMatchObject({ resolved: true, targetFile: "notes/auth.md" });
	});
});

describe("wikilinks — case-insensitive path lookup (Phase 0 + Phase 1)", () => {
	test("Phase 1: [[notes/auth]] resolves to on-disk Notes/Auth.md", () => {
		const idx = new FakeVaultIndex({ files: ["Notes/Auth.md"] });
		const r = resolveWikilink("notes/auth", "caller.md", idx);
		expect(r).toMatchObject({ resolved: true, targetFile: "Notes/Auth.md" });
	});

	test("Phase 1: [[NOTES/AUTH.md]] (uppercase) resolves to Notes/Auth.md", () => {
		const idx = new FakeVaultIndex({ files: ["Notes/Auth.md"] });
		const r = resolveWikilink("NOTES/AUTH.md", "caller.md", idx);
		expect(r).toMatchObject({ resolved: true, targetFile: "Notes/Auth.md" });
	});

	test("Phase 0: [[./Auth]] from Notes/caller.md resolves to Notes/Auth.md", () => {
		const idx = new FakeVaultIndex({ files: ["Notes/Auth.md", "Notes/caller.md"] });
		const r = resolveWikilink("./Auth", "Notes/caller.md", idx);
		expect(r).toMatchObject({ resolved: true, targetFile: "Notes/Auth.md" });
	});

	test("Phase 0: [[./auth]] (lowercase) from Notes/caller.md resolves to Notes/Auth.md", () => {
		const idx = new FakeVaultIndex({ files: ["Notes/Auth.md", "Notes/caller.md"] });
		const r = resolveWikilink("./auth", "Notes/caller.md", idx);
		expect(r).toMatchObject({ resolved: true, targetFile: "Notes/Auth.md" });
	});

	test("case collision: lex-smallest path wins deterministically", () => {
		// On filesystems that admit both cases, "Notes/Auth.md" < "notes/auth.md"
		// (uppercase 'N' = 0x4E < lowercase 'n' = 0x6E).
		const idx = new FakeVaultIndex({ files: ["notes/auth.md", "Notes/Auth.md"] });
		const r = resolveWikilink("notes/auth", "caller.md", idx);
		expect(r).toMatchObject({ resolved: true, targetFile: "Notes/Auth.md" });
	});
});

describe("wikilinks — VAULT_EXTENSIONS resolution", () => {
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	test("extensionless explicit path resolves through configured extensions (mdx)", () => {
		vi.stubEnv("VAULT_EXTENSIONS", "md,mdx");
		const idx = new FakeVaultIndex({ files: ["notes/auth.mdx"] });
		const r = resolveWikilink("notes/auth", "src.md", idx);
		expect(r).toMatchObject({ resolved: true, targetFile: "notes/auth.mdx" });
	});

	test("first-listed extension wins when multiple exist", () => {
		vi.stubEnv("VAULT_EXTENSIONS", "md,mdx");
		const idx = new FakeVaultIndex({ files: ["notes/auth.md", "notes/auth.mdx"] });
		const r = resolveWikilink("notes/auth", "src.md", idx);
		expect(r.targetFile).toBe("notes/auth.md");
	});

	test("default config (md only) resolves classic .md", () => {
		const idx = new FakeVaultIndex({ files: ["notes/auth.md"] });
		const r = resolveWikilink("notes/auth", "src.md", idx);
		expect(r.targetFile).toBe("notes/auth.md");
	});
});

// ─── Non-resolvable target families: YAML + Prisma ─────────────────────────

describe("wikilinks — non-resolvable target gating (YAML + Prisma)", () => {
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	test("Phase 0 source-relative extensionless input does NOT retarget to .prisma", () => {
		vi.stubEnv("VAULT_EXTENSIONS", "md,prisma");
		const idx = new FakeVaultIndex({ files: ["schema.prisma"] });
		const r = resolveWikilink("./schema", "src.md", idx);
		expect(r.resolved).toBe(false);
	});

	test("Phase 1 explicit vault-root extensionless input does NOT retarget to .prisma", () => {
		vi.stubEnv("VAULT_EXTENSIONS", "md,prisma");
		const idx = new FakeVaultIndex({ files: ["prisma/schema.prisma"] });
		const r = resolveWikilink("prisma/schema", "src.md", idx);
		expect(r.resolved).toBe(false);
	});

	test("Phase 2/3 bare basename does NOT retarget to .prisma", () => {
		vi.stubEnv("VAULT_EXTENSIONS", "md,prisma");
		const idx = new FakeVaultIndex({ files: ["notes/schema.prisma"] });
		const r = resolveWikilink("schema", "src.md", idx);
		expect(r.resolved).toBe(false);
	});

	test("Phase 2/3 bare basename does NOT retarget to .yaml (latent hole closed)", () => {
		vi.stubEnv("VAULT_EXTENSIONS", "md,yaml");
		const idx = new FakeVaultIndex({ files: ["notes/petstore.yaml"] });
		const r = resolveWikilink("petstore", "src.md", idx);
		expect(r.resolved).toBe(false);
	});

	test("Phase 1.5 suffix lookup does NOT retarget to .prisma when bucket includes it", () => {
		vi.stubEnv("VAULT_EXTENSIONS", "md,prisma");
		const idx = new FakeVaultIndex({ files: ["nested/folder/schema.prisma"] });
		const r = resolveWikilink("folder/schema", "src.md", idx);
		expect(r.resolved).toBe(false);
	});

	test("happy path: markdown still resolves when both .md and .prisma exist", () => {
		vi.stubEnv("VAULT_EXTENSIONS", "md,prisma");
		const idx = new FakeVaultIndex({ files: ["schema.md", "schema.prisma"] });
		const r = resolveWikilink("./schema", "src.md", idx);
		expect(r).toMatchObject({ resolved: true, targetFile: "schema.md" });
	});

	test("happy path: bare basename picks .md over .prisma sibling", () => {
		vi.stubEnv("VAULT_EXTENSIONS", "md,prisma");
		const idx = new FakeVaultIndex({ files: ["notes/schema.md", "notes/schema.prisma"] });
		const r = resolveWikilink("schema", "src.md", idx);
		expect(r).toMatchObject({ resolved: true, targetFile: "notes/schema.md" });
	});
});
