import { describe, expect, test } from "vitest";

import { FUZZY_ALGORITHM_ID } from "../../../src/lib/fuzzy.js";
import { renderFragment } from "../../../src/lib/renderText/getFragment.js";
import { TOKENIZER_HEURISTIC } from "../../../src/lib/tokenizer.js";
import type {
	BlockFragment,
	FileFragment,
	HeadingFragment,
	MetaEnvelope,
	PreambleFragment,
} from "../../../src/types.js";

function meta(overrides: Partial<MetaEnvelope> = {}): MetaEnvelope {
	return {
		request_id: "00000000-0000-0000-0000-000000000000",
		index_status: { state: "warm", files_indexed: 42 },
		tokenizer: TOKENIZER_HEURISTIC,
		...overrides,
	};
}

// Body and embed sentinels carry a per-section 16-hex crypto-random nonce
// (bounded by construction so a pathological all-dash body can't bloat the
// output to 3× its size). Tests extract the actual nonce from the rendered
// output and substitute it into the expected lines — preserving exact-match
// strength without bypassing the random source under test.
const NONCE_RE_BEGIN_BODY = /--- begin body ([0-9a-f]{16}) ---/;
const NONCE_RE_BEGIN_EMBED = /--- begin embed: [^\n]+? ([0-9a-f]{16}) ---/g;

function bodyWrap(body: string, token: string): string[] {
	return [`--- begin body ${token} ---`, body, `--- end body ${token} ---`];
}

function embedWrap(target: string, content: string, token: string): string[] {
	return [`  --- begin embed: ${target} ${token} ---`, content, `  --- end embed ${token} ---`];
}

function bodyToken(out: string): string {
	const m = out.match(NONCE_RE_BEGIN_BODY);
	const captured = m?.[1];
	if (captured === undefined) {
		throw new Error(`body sentinel missing from rendered output:\n${out}`);
	}
	return captured;
}

function embedTokens(out: string): string[] {
	const tokens: string[] = [];
	for (const m of out.matchAll(NONCE_RE_BEGIN_EMBED)) {
		const captured = m[1];
		if (captured !== undefined) tokens.push(captured);
	}
	return tokens;
}

describe("renderFragment", () => {
	test("heading fresh — full body with outgoing + embeds", () => {
		const sc: HeadingFragment = {
			anchor_kind: "heading",
			file: "notes/auth/oauth.md",
			stable_id: "h:7a3f1b2c8d9e4f",
			stable_id_status: "fresh",
			heading_path: ["Auth", "OAuth2"],
			level: 2,
			slug_path: "auth-oauth2",
			content: "## OAuth2\n\nConfigure your provider.",
			bodyTokensApprox: 287,
			outgoing_links: [
				{
					raw_target: "notes/setup.md",
					target_file: "notes/setup.md",
					link_text: "see setup",
					alias: "see setup",
					resolved: true,
					link_ordinal: 1,
				},
				{
					raw_target: "missing",
					link_text: "missing",
					resolved: false,
					link_ordinal: 2,
				},
			],
			embeds: [
				{
					raw_target: "diagram.png",
					target_file: "assets/diagram.png",
					kind: "image",
					resolved: true,
					expanded: false,
				},
			],
		};
		const out = renderFragment(sc, meta());
		expect(out).toBe(
			[
				"fragment · notes/auth/oauth.md › Auth › OAuth2  (level 2, ~287 tok)",
				"id: h:7a3f1b2c8d9e4f",
				"",
				...bodyWrap("## OAuth2\n\nConfigure your provider.", bodyToken(out)),
				"",
				`— links (2 outgoing, 1 embed) —`,
				`  → notes/setup.md  "see setup"  (ord 1)`,
				`  → missing  (unresolved)  (ord 2)`,
				`embeds:`,
				`  assets/diagram.png · image · resolved`,
			].join("\n"),
		);
	});

	test("heading stale (recovered) — emits requested + fuzzy candidates", () => {
		const sc: HeadingFragment = {
			anchor_kind: "heading",
			file: "notes/auth/oauth.md",
			stable_id: "h:7a3f1b2c8d9e4f",
			stable_id_status: "stale",
			requested_stable_id: "h:deadbeefcafe11",
			fuzzy_candidates: [{ stable_id: "h:1234567890abcd", heading_path: ["Auth", "OAuth1"], score: 0.71 }],
			heading_path: ["Auth", "OAuth2"],
			level: 2,
			slug_path: "auth-oauth2",
			content: "body",
			bodyTokensApprox: 5,
			outgoing_links: [],
			embeds: [],
		};
		const out = renderFragment(sc, meta({ fuzzy_algorithm: FUZZY_ALGORITHM_ID }));
		expect(out).toBe(
			[
				"fragment · notes/auth/oauth.md › Auth › OAuth2  (level 2, ~5 tok)",
				"id: h:7a3f1b2c8d9e4f  (status: stale, recovered)",
				"requested: h:deadbeefcafe11",
				"fuzzy candidates:",
				"  h:1234567890abcd · Auth › OAuth1  (score 0.71)",
				"",
				...bodyWrap("body", bodyToken(out)),
				"",
				`meta: fuzzy=${FUZZY_ALGORITHM_ID}`,
			].join("\n"),
		);
	});

	test("preamble — no id, no links section if empty", () => {
		const sc: PreambleFragment = {
			anchor_kind: "preamble",
			file: "notes/intro.md",
			content: "Intro paragraph.",
			bodyTokensApprox: 5,
			outgoing_links: [],
			embeds: [],
		};
		const out = renderFragment(sc, meta());
		expect(out).toBe(
			["fragment · notes/intro.md · preamble  (~5 tok)", "", ...bodyWrap("Intro paragraph.", bodyToken(out))].join(
				"\n",
			),
		);
	});

	test("file fragment — whole file label", () => {
		const sc: FileFragment = {
			anchor_kind: "file",
			file: "notes/quickref.md",
			content: "Just a short note.",
			bodyTokensApprox: 4,
			outgoing_links: [],
			embeds: [],
		};
		const out = renderFragment(sc, meta());
		expect(out).toBe(
			[
				"fragment · notes/quickref.md · whole file  (~4 tok)",
				"",
				...bodyWrap("Just a short note.", bodyToken(out)),
			].join("\n"),
		);
	});

	test("block fragment with containing heading + stable_id", () => {
		const sc: BlockFragment = {
			anchor_kind: "block",
			file: "notes/code.md",
			block_id: "abc123",
			containing_heading_path: ["Snippets", "Helpers"],
			containing_stable_id: "h:c0ffee01234567",
			content: "code body",
			bodyTokensApprox: 12,
			outgoing_links: [],
			embeds: [],
		};
		const out = renderFragment(sc, meta());
		expect(out).toBe(
			[
				"fragment · notes/code.md · Snippets › Helpers · block ^abc123  (~12 tok)",
				"container id: h:c0ffee01234567",
				"",
				...bodyWrap("code body", bodyToken(out)),
			].join("\n"),
		);
	});

	test("expand_embeds: expanded_content rendered inside begin/end markers", () => {
		const sc: FileFragment = {
			anchor_kind: "file",
			file: "notes/parent.md",
			content: "Parent body.\n\n![[child#Section]]",
			bodyTokensApprox: 10,
			outgoing_links: [],
			embeds: [
				{
					raw_target: "child#Section",
					target_file: "notes/child.md",
					target_heading_path: ["Section"],
					kind: "note",
					resolved: true,
					expanded: true,
					expanded_content: "## Section\n\nChild body line 1.\nChild body line 2.",
				},
			],
		};
		const out = renderFragment(sc, meta());
		const bt = bodyToken(out);
		const [et] = embedTokens(out);
		if (et === undefined) throw new Error("expected one embed token");
		expect(out).toBe(
			[
				"fragment · notes/parent.md · whole file  (~10 tok)",
				"",
				...bodyWrap("Parent body.\n\n![[child#Section]]", bt),
				"",
				"— links (0 outgoing, 1 embed) —",
				"  notes/child.md › Section · note · expanded",
				...embedWrap("notes/child.md › Section", "## Section\n\nChild body line 1.\nChild body line 2.", et),
			].join("\n"),
		);
	});

	test("body containing a 1 MB dash run stays bounded by the nonce sentinel", () => {
		// Fixed-length nonce sentinel keeps the boundary at 36 bytes
		// regardless of body content — an all-dash body can't bloat
		// `content[0].text` via boundary auto-extension.
		const body = "-".repeat(1_000_000);
		const sc: FileFragment = {
			anchor_kind: "file",
			file: "notes/dashy.md",
			content: body,
			bodyTokensApprox: 1,
			outgoing_links: [],
			embeds: [],
		};
		const out = renderFragment(sc, meta());
		const overhead = out.length - body.length;
		// Header + 2 sentinel lines + separators. Header is small (file
		// path + label) and the two sentinels are 36 bytes each — total
		// overhead is in the low hundreds of bytes, not millions.
		expect(overhead).toBeLessThan(1_000);
		// Sentinel pair carries the same nonce; collision-with-body at 64
		// bits is ~2×10⁻¹⁴ even against the worst-case 10 MB hostile body
		// (~357K candidate sentinel lines), well below test-flake floor.
		const bt = bodyToken(out);
		expect(out).toContain(`--- begin body ${bt} ---`);
		expect(out).toContain(`--- end body ${bt} ---`);
	});

	test("each section gets its own crypto-random nonce", () => {
		// Body and each expanded embed draw independent tokens so a
		// collision in one section doesn't break the others.
		const sc: FileFragment = {
			anchor_kind: "file",
			file: "notes/parent.md",
			content: "Parent body.",
			bodyTokensApprox: 5,
			outgoing_links: [],
			embeds: [
				{
					raw_target: "a",
					target_file: "notes/a.md",
					kind: "note",
					resolved: true,
					expanded: true,
					expanded_content: "First embed.",
				},
				{
					raw_target: "b",
					target_file: "notes/b.md",
					kind: "note",
					resolved: true,
					expanded: true,
					expanded_content: "Second embed.",
				},
			],
		};
		const out = renderFragment(sc, meta());
		const bt = bodyToken(out);
		const ets = embedTokens(out);
		expect(ets).toHaveLength(2);
		const allTokens = new Set([bt, ...ets]);
		// 32-bit nonces collide at ~2^-32 per pair; for 3 tokens the
		// collision probability is ~3 * 2^-32 ≈ 7e-10 — well below
		// test-flake thresholds.
		expect(allTokens.size).toBe(3);
	});

	test("embed with expansion_error surfaces in tags", () => {
		const sc: HeadingFragment = {
			anchor_kind: "heading",
			file: "n.md",
			stable_id: "h:0000000000abcd",
			stable_id_status: "fresh",
			heading_path: ["H"],
			level: 1,
			slug_path: "h",
			content: "",
			bodyTokensApprox: 0,
			outgoing_links: [],
			embeds: [
				{
					raw_target: "missing.md",
					kind: "note",
					resolved: false,
					expanded: false,
					expansion_error: "unresolved_file",
				},
			],
		};
		const out = renderFragment(sc, meta());
		expect(out).toContain("missing.md  (unresolved) · note · unresolved · unresolved_file");
	});

	test("frontmatter-only file — empty content body, no links section", () => {
		const sc: FileFragment = {
			anchor_kind: "file",
			file: "notes/empty-body.md",
			content: "",
			bodyTokensApprox: 0,
			outgoing_links: [],
			embeds: [],
		};
		const out = renderFragment(sc, meta());
		expect(out).toBe("fragment · notes/empty-body.md · whole file  (~0 tok)");
	});

	test("ambiguous outgoing link — inline candidate paths", () => {
		const sc: PreambleFragment = {
			anchor_kind: "preamble",
			file: "n.md",
			content: "ignored",
			bodyTokensApprox: 1,
			outgoing_links: [
				{
					raw_target: "notes",
					link_text: "notes",
					resolved: false,
					candidates: [{ file: "a/notes.md" }, { file: "b/notes.md" }],
					link_ordinal: 1,
				},
			],
			embeds: [],
		};
		const out = renderFragment(sc, meta());
		expect(out).toContain("  → notes  (ambiguous: a/notes.md, b/notes.md)  (ord 1)");
	});

	test("resolved outgoing with duplicate_heading surfaces ambiguity", () => {
		const sc: PreambleFragment = {
			anchor_kind: "preamble",
			file: "n.md",
			content: "ignored",
			bodyTokensApprox: 1,
			outgoing_links: [
				{
					raw_target: "setup#OAuth2",
					target_file: "notes/setup.md",
					target_heading_path: ["Auth", "OAuth2"],
					link_text: "setup#OAuth2",
					resolved: true,
					duplicate_heading: true,
					candidates: [{ file: "a/setup.md" }, { file: "b/setup.md" }],
					link_ordinal: 1,
				},
			],
			embeds: [],
		};
		const out = renderFragment(sc, meta());
		expect(out).toContain(
			"  → notes/setup.md › Auth › OAuth2  (ambiguous: 2 candidates: a/setup.md, b/setup.md)  (ord 1)",
		);
	});

	test("resolved embed with duplicate_heading surfaces ambiguity", () => {
		// Without the ambiguity surface, an embed against a duplicate-heading
		// target silently commits the agent to the first matching heading.
		const sc: PreambleFragment = {
			anchor_kind: "preamble",
			file: "n.md",
			content: "ignored",
			bodyTokensApprox: 1,
			outgoing_links: [],
			embeds: [
				{
					raw_target: "setup#OAuth2",
					target_file: "notes/setup.md",
					target_heading_path: ["Auth", "OAuth2"],
					kind: "note",
					resolved: true,
					duplicate_heading: true,
					candidates: [
						{ file: "notes/setup.md", heading_path: ["Auth", "OAuth2"] },
						{ file: "notes/setup.md", heading_path: ["Marketing", "OAuth2"] },
					],
					expanded: false,
				},
			],
		};
		const out = renderFragment(sc, meta());
		expect(out).toContain(
			"  notes/setup.md › Auth › OAuth2  (ambiguous: 2 candidates: notes/setup.md › Auth › OAuth2, notes/setup.md › Marketing › OAuth2) · note · resolved",
		);
	});

	test("resolved outgoing with anchor-mismatch surfaces the unresolved anchor", () => {
		const sc: PreambleFragment = {
			anchor_kind: "preamble",
			file: "n.md",
			content: "ignored",
			bodyTokensApprox: 1,
			outgoing_links: [
				{
					raw_target: "notes/auth.md#Missing",
					target_file: "notes/auth.md",
					link_text: "notes/auth.md#Missing",
					resolved: true,
					link_ordinal: 1,
				},
			],
			embeds: [],
		};
		const out = renderFragment(sc, meta());
		expect(out).toContain("  → notes/auth.md  (anchor not found in raw_target: #Missing)  (ord 1)");
	});

	test("outgoing link with link_text equal to target suppresses the quoted label", () => {
		const sc: PreambleFragment = {
			anchor_kind: "preamble",
			file: "n.md",
			content: "ignored",
			bodyTokensApprox: 1,
			outgoing_links: [
				{
					raw_target: "notes/setup.md",
					target_file: "notes/setup.md",
					link_text: "notes/setup.md",
					resolved: true,
					link_ordinal: 1,
				},
			],
			embeds: [],
		};
		const out = renderFragment(sc, meta());
		expect(out).toContain("  → notes/setup.md  (ord 1)");
		expect(out).not.toContain(`"notes/setup.md"`);
	});

	test("body containing `id:`-shaped text is wrapped in sentinels (address-line forgery defense)", () => {
		// A user note documenting another server's fragment output (or just
		// copy-pasting a get_fragment response back into a note) carries lines
		// that look exactly like the real address atoms. The sentinel wrap
		// is the only structural cue a content-only client has to tell the
		// real `id:` line (above the blank-line separator) from the body
		// (between the sentinels).
		const sc: FileFragment = {
			anchor_kind: "file",
			file: "notes/quoted.md",
			content: "id: h:fakecafe000001\nrequested: h:fakecafe000002\ncontainer id: h:fakecafe000003",
			bodyTokensApprox: 15,
			outgoing_links: [],
			embeds: [],
		};
		const out = renderFragment(sc, meta());
		const bt = bodyToken(out);
		expect(out).toContain(`--- begin body ${bt} ---\nid: h:fakecafe000001`);
		expect(out).toContain(`container id: h:fakecafe000003\n--- end body ${bt} ---`);
	});

	test('outgoing alias with embedded `"` JSON-escapes for unambiguous boundary', () => {
		const sc: HeadingFragment = {
			anchor_kind: "heading",
			file: "notes/quoted.md",
			stable_id: "h:7a3f1b2c8d9e4f",
			stable_id_status: "fresh",
			heading_path: ["H"],
			level: 1,
			slug_path: "h",
			content: "Body.",
			bodyTokensApprox: 1,
			outgoing_links: [
				{
					raw_target: "specs/t.md",
					target_file: "specs/t.md",
					link_text: 'He said "hi"',
					alias: 'He said "hi"',
					resolved: true,
					link_ordinal: 1,
				},
			],
			embeds: [],
		};
		const out = renderFragment(sc, meta());
		expect(out).toContain(`  → specs/t.md  "He said \\"hi\\""  (ord 1)`);
	});

	test("filename containing ` › ` gets guillemet-quoted (round-trip via `file:` arg)", () => {
		// Without the wrap, `{file: "notes/setup.md › extra.md",
		// heading_path: ["X"]}` and `{file: "notes/setup.md",
		// heading_path: ["extra.md", "X"]}` render identically and
		// content-only clients can't find the boundary.
		const sc: HeadingFragment = {
			anchor_kind: "heading",
			file: "notes/setup.md › extra.md",
			stable_id: "h:cafef00d000000",
			stable_id_status: "fresh",
			heading_path: ["X"],
			level: 1,
			slug_path: "x",
			content: "Body.",
			bodyTokensApprox: 1,
			outgoing_links: [],
			embeds: [],
		};
		const out = renderFragment(sc, meta());
		expect(out).toContain("fragment · «notes/setup.md › extra.md» › X  (level 1, ~1 tok)");
		expect(out).not.toContain("\\›");
	});

	test("preamble / file / block headers wrap `›`-bearing filenames", () => {
		// Block keeps ` · ` (not ` › `) between file and containing heading —
		// the heading is a container, not part of a heading-as-address.
		const preamble: PreambleFragment = {
			anchor_kind: "preamble",
			file: "notes/foo › bar.md",
			content: "preamble body",
			bodyTokensApprox: 3,
			outgoing_links: [],
			embeds: [],
		};
		const file: FileFragment = {
			anchor_kind: "file",
			file: "docs/x › y.md",
			content: "whole file body",
			bodyTokensApprox: 4,
			outgoing_links: [],
			embeds: [],
		};
		const blockNoContainer: BlockFragment = {
			anchor_kind: "block",
			file: "notes/foo › bar.md",
			containing_heading_path: [],
			block_id: "abc",
			content: "block body",
			bodyTokensApprox: 2,
			outgoing_links: [],
			embeds: [],
		};
		const blockWithContainer: BlockFragment = {
			anchor_kind: "block",
			file: "notes/foo › bar.md",
			containing_heading_path: ["Section"],
			containing_stable_id: "h:1234567890abcd",
			block_id: "xyz",
			content: "block body",
			bodyTokensApprox: 2,
			outgoing_links: [],
			embeds: [],
		};
		expect(renderFragment(preamble, meta())).toContain("fragment · «notes/foo › bar.md» · preamble  (~3 tok)");
		expect(renderFragment(file, meta())).toContain("fragment · «docs/x › y.md» · whole file  (~4 tok)");
		expect(renderFragment(blockNoContainer, meta())).toContain(
			"fragment · «notes/foo › bar.md» · block ^abc  (~2 tok)",
		);
		expect(renderFragment(blockWithContainer, meta())).toContain(
			"fragment · «notes/foo › bar.md» · Section · block ^xyz  (~2 tok)",
		);
	});
});
