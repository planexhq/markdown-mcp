import { describe, expect, test } from "vitest";

import { renderTree } from "../../../src/lib/renderText/getVaultTree.js";
import { TOKENIZER_HEURISTIC } from "../../../src/lib/tokenizer.js";
import type { GetVaultTreeResult, MetaEnvelope } from "../../../src/types.js";

function meta(overrides: Partial<MetaEnvelope> = {}): MetaEnvelope {
	return {
		request_id: "00000000-0000-0000-0000-000000000000",
		index_status: { state: "warm", files_indexed: 42 },
		tokenizer: TOKENIZER_HEURISTIC,
		...overrides,
	};
}

describe("renderTree", () => {
	test("mixed dirs / markdown files / asset + cursor", () => {
		const sc: GetVaultTreeResult = {
			items: [
				{
					id: "t:aaaaaaaaaaaaaa",
					type: "dir",
					path: "notes",
					name: "notes",
					dfs_rank: 1,
					children: 12,
					mtime: 0,
				},
				{
					id: "t:bbbbbbbbbbbbbb",
					type: "file",
					path: "notes/intro.md",
					name: "intro.md",
					dfs_rank: 2,
					subheadings: 3,
					bodyTokensApprox: 89,
					descendantTokensApprox: 89,
					mtime: 0,
				},
				{
					id: "t:cccccccccccccc",
					type: "file",
					path: "notes/auth/oauth.md",
					name: "oauth.md",
					dfs_rank: 3,
					subheadings: 5,
					bodyTokensApprox: 342,
					descendantTokensApprox: 1240,
					contentKinds: ["code"],
					mtime: 0,
				},
				{
					id: "t:dddddddddddddd",
					type: "file",
					path: "projects/diagram.png",
					name: "diagram.png",
					dfs_rank: 4,
					mtime: 0,
				},
			],
			nextCursor: "eyJ2IjoxLCJzb3J0Ijoi...",
		};
		const out = renderTree(sc, meta());
		expect(out).toBe(
			[
				"tree · 4 items",
				"",
				"[dir]   notes/  (rank 1, 12 children)",
				"[file]  notes/intro.md  (rank 2, 3 headings, ~89 tok)",
				"[file]  notes/auth/oauth.md  (rank 3, 5 headings, ~342 tok body, ~1240 tok total, contains: code)",
				"[file]  projects/diagram.png  (rank 4, asset)",
				"",
				"next: eyJ2IjoxLCJzb3J0Ijoi...",
			].join("\n"),
		);
	});

	test("empty tree", () => {
		const sc: GetVaultTreeResult = { items: [] };
		const out = renderTree(sc, meta());
		expect(out).toBe("tree · 0 items");
	});

	test("singular item / child counts", () => {
		const sc: GetVaultTreeResult = {
			items: [
				{
					id: "t:0000000000abcd",
					type: "dir",
					path: "lone",
					name: "lone",
					dfs_rank: 1,
					children: 1,
					mtime: 0,
				},
				{
					id: "t:1111111111abcd",
					type: "file",
					path: "lone/only.md",
					name: "only.md",
					dfs_rank: 2,
					subheadings: 1,
					bodyTokensApprox: 10,
					descendantTokensApprox: 10,
					mtime: 0,
				},
			],
		};
		const out = renderTree(sc, meta());
		expect(out).toContain("[dir]   lone/  (rank 1, 1 child)");
		expect(out).toContain("[file]  lone/only.md  (rank 2, 1 heading, ~10 tok)");
	});

	test("markdown file without index stats labelled `unindexed`", () => {
		const sc: GetVaultTreeResult = {
			items: [
				{
					id: "t:aaaaaaaaaaaaaa",
					type: "file",
					path: "notes/just-saved.md",
					name: "just-saved.md",
					dfs_rank: 1,
					mtime: 0,
				},
			],
		};
		const out = renderTree(sc, meta());
		expect(out).toBe(["tree · 1 item", "", "[file]  notes/just-saved.md  (rank 1, unindexed)"].join("\n"));
	});

	test("warming state surfaces", () => {
		const sc: GetVaultTreeResult = { items: [] };
		const out = renderTree(sc, meta({ index_status: { state: "warming", files_indexed: 5 } }));
		expect(out).toBe(["tree · 0 items", "", "meta: state=warming files=5"].join("\n"));
	});

	test("`›`-bearing file path is wrapped in `«…»` for round-trip safety", () => {
		// `«foo › bar.md»` round-trips through validatePath's
		// `stripOuterGuillemets` fallback back to `foo › bar.md`.
		const sc: GetVaultTreeResult = {
			items: [
				{
					id: "t:1111111111aaaa",
					type: "file",
					path: "foo › bar.md",
					name: "bar.md",
					dfs_rank: 1,
					subheadings: 2,
					bodyTokensApprox: 20,
					descendantTokensApprox: 20,
					mtime: 0,
				},
			],
		};
		const out = renderTree(sc, meta());
		expect(out).toContain("[file]  «foo › bar.md»  (rank 1, 2 headings, ~20 tok)");
	});

	test("`›`-bearing dir wraps with slash inside so prose copy-back round-trips", () => {
		// Tree renders `«foo › bar/»` (slash inside the wrap);
		// `stripOuterGuillemets` peels → `foo › bar/` → validatePath
		// segment-walk filters the empty trailing segment → resolves.
		const sc: GetVaultTreeResult = {
			items: [
				{
					id: "t:3333333333aaaa",
					type: "dir",
					path: "foo › bar",
					name: "bar",
					dfs_rank: 1,
					children: 0,
					mtime: 0,
				},
			],
		};
		const out = renderTree(sc, meta());
		expect(out).toContain("[dir]   «foo › bar/»  (rank 1, 0 children)");
	});

	test("literal `«foo › bar»` dir double-wraps with slash inside the outer wrap", () => {
		// Prose renders `««foo › bar»/»` (slash inside the outer wrap so the
		// strip rule's `endsWith(»)` fires); strip peels exactly one layer →
		// `«foo › bar»/` → resolves the literal dir. The structured channel
		// emits raw `«foo › bar»` and its round-trip for literal-named
		// `«…›…»` paths stays a documented residual.
		const sc: GetVaultTreeResult = {
			items: [
				{
					id: "t:2222222222aaaa",
					type: "dir",
					path: "«foo › bar»",
					name: "«foo › bar»",
					dfs_rank: 1,
					children: 0,
					mtime: 0,
				},
			],
		};
		const out = renderTree(sc, meta());
		expect(out).toContain("[dir]   ««foo › bar»/»  (rank 1, 0 children)");
	});
});
