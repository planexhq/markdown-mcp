/**
 * D38 — UTF-8 BOM byte-count accuracy.
 *
 * `TextDecoder("utf-8", { fatal: true })` strips the leading BOM (3 bytes
 * `EF BB BF`) during decode, so `Buffer.byteLength(parsed.source, "utf8")`
 * under-reports the on-disk size by 3 on BOM-prefixed files. D38 threads
 * the raw read-window byte count via {@link NoteData.sizeBytes} /
 * {@link SourceData.sizeBytes}; this test pins the contract:
 *   - `parsed.source` does NOT contain the BOM character.
 *   - `sizeBytes` equals `fs.stat().size` (the on-disk byte count).
 *   - For NON-BOM files, the two routes agree byte-for-byte (regression
 *     guard against a future change to the read pipeline that re-introduces
 *     re-encoding).
 */

import { stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { readNote, readSource } from "../../src/lib/readNote.js";
import { validatePath, validateVaultRoot } from "../../src/lib/validatePath.js";
import { createTempVault } from "../helpers/vault.js";

const BOM = Buffer.from([0xef, 0xbb, 0xbf]);

let vault: { path: string; cleanup: () => Promise<void> };
let vaultRoot: { absolute: string };

beforeEach(async () => {
	vault = await createTempVault({});
	vaultRoot = await validateVaultRoot(vault.path);
});

afterEach(async () => {
	await vault.cleanup();
});

describe("readSource / readNote — UTF-8 BOM handling", () => {
	test("BOM-prefixed file: sizeBytes equals fs.stat().size; source has no BOM", async () => {
		const body = "# A\nbody\n";
		const bytes = Buffer.concat([BOM, Buffer.from(body, "utf8")]);
		await writeFile(join(vault.path, "bom.md"), bytes);
		const safe = await validatePath("bom.md", vaultRoot);
		const onDiskSize = (await stat(safe.absolute)).size;

		const fromSource = await readSource(safe);
		expect(fromSource.sizeBytes).toBe(onDiskSize);
		// `\uFEFF` is the unicode BOM codepoint; TextDecoder strips it by
		// default for UTF-8 so `parsed.source` MUST NOT start with it.
		expect(fromSource.source.charCodeAt(0)).not.toBe(0xfeff);
		// And Buffer.byteLength of the decoded source under-reports — the
		// regression we're guarding against.
		expect(Buffer.byteLength(fromSource.source, "utf8")).toBe(onDiskSize - BOM.length);

		// Same answer via readNote (delegates to readSource).
		const fromNote = await readNote(safe);
		expect(fromNote.sizeBytes).toBe(onDiskSize);
	});

	test("non-BOM file: sizeBytes matches both fs.stat().size AND Buffer.byteLength(source)", async () => {
		const body = "# A\nbody\n";
		await writeFile(join(vault.path, "plain.md"), body, "utf8");
		const safe = await validatePath("plain.md", vaultRoot);
		const onDiskSize = (await stat(safe.absolute)).size;
		const fromSource = await readSource(safe);
		expect(fromSource.sizeBytes).toBe(onDiskSize);
		// For non-BOM UTF-8 the two routes converge — confirms the new
		// `sizeBytes` channel doesn't drift from the old behavior in the
		// common case.
		expect(Buffer.byteLength(fromSource.source, "utf8")).toBe(onDiskSize);
	});
});
