/**
 * D37: `FragmentCommon.file_size_bytes` is the byte count of the WHOLE
 * file the fragment came from, computed via `Buffer.byteLength(parsed.source,
 * "utf8")`. Distinct from `content.length` for every anchor kind that
 * slices (heading, preamble, block) — and equal to fs.stat().size for the
 * file the parser just read.
 *
 * Test all four anchor kinds against a known-content vault so each
 * builder's emission is exercised.
 */

import { stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import type { FragmentResult } from "../../src/types.js";
import { spawnTestServer, type TestClient, waitForWarm } from "../helpers/mcp-client.js";
import { createTempVault } from "../helpers/vault.js";

const MULTI_SECTION =
	"Preamble paragraph.\n\n# Section A\n\nA body.\n\n## Sub\n\nSub body.\n\n# Section B\n\nB body. ^block-x\n";
const BOM = Buffer.from([0xef, 0xbb, 0xbf]);

let vault: { path: string; cleanup: () => Promise<void> };
let conn: TestClient;

beforeAll(async () => {
	vault = await createTempVault({
		"multi.md": MULTI_SECTION,
	});
	await writeFile(join(vault.path, "bom.md"), Buffer.concat([BOM, Buffer.from("# B\nbody\n", "utf8")]));
	conn = await spawnTestServer(vault.path);
	await waitForWarm(conn.client);
}, 30_000);

afterAll(async () => {
	await conn.close();
	await vault.cleanup();
});

let onDiskSize: number;
beforeAll(async () => {
	onDiskSize = (await stat(join(vault.path, "multi.md"))).size;
});

async function callFragment(args: Record<string, unknown>): Promise<FragmentResult> {
	const r = await conn.client.callTool({ name: "get_fragment", arguments: { file: "multi.md", ...args } });
	expect(r.isError).toBeFalsy();
	return r.structuredContent as FragmentResult;
}

describe("get_fragment — file_size_bytes is whole-file size for every anchor kind", () => {
	test("heading anchor: file_size_bytes equals on-disk file size, distinct from content.length", async () => {
		const frag = await callFragment({ anchor: { kind: "heading_path", path: ["Section A"] } });
		expect(frag.file_size_bytes).toBe(onDiskSize);
		// `content` is the heading section slice — shorter than the whole file.
		expect(frag.content.length).toBeLessThan(frag.file_size_bytes);
	});

	test("preamble anchor: file_size_bytes still whole-file", async () => {
		const frag = await callFragment({ anchor: { kind: "file" } });
		// For `kind: "file"`, the spec says content excludes frontmatter
		// (this fixture has none, so content equals body), but file_size_bytes
		// remains the whole-file value.
		expect(frag.file_size_bytes).toBe(onDiskSize);
	});

	test("block anchor: file_size_bytes whole-file", async () => {
		const frag = await callFragment({ anchor: { kind: "block", id: "block-x" } });
		expect(frag.file_size_bytes).toBe(onDiskSize);
		// Block content is a single paragraph — much smaller than the file.
		expect(frag.content.length).toBeLessThan(frag.file_size_bytes);
	});

	test("file_size_bytes is a positive integer", async () => {
		const frag = await callFragment({ anchor: { kind: "file" } });
		expect(frag.file_size_bytes).toBeGreaterThan(0);
		expect(Number.isInteger(frag.file_size_bytes)).toBe(true);
	});

	test("BOM-prefixed file: file_size_bytes equals fs.stat().size (NoteData.sizeBytes contract)", async () => {
		const bomSize = (await stat(join(vault.path, "bom.md"))).size;
		const r = await conn.client.callTool({
			name: "get_fragment",
			arguments: { file: "bom.md", anchor: { kind: "file" } },
		});
		expect(r.isError).toBeFalsy();
		const frag = r.structuredContent as FragmentResult;
		expect(frag.file_size_bytes).toBe(bomSize);
	});
});
