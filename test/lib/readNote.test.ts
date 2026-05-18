/**
 * readNote pipeline tests:
 *   - File-size cap → FileTooLargeError
 *   - Invalid UTF-8 → ParseError reason="encoding_failed"
 *   - Non-regular files (FIFO, directory) → PathValidationError(PATH_NOT_FOUND)
 *   - Happy path returns {source, parsed}
 *
 * Uses real temp vaults via `createTempVault` so the `O_NOFOLLOW` open
 * and stat/decode chain runs end-to-end.
 */

import { exec } from "node:child_process";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import type { ToolErrorEnvelope } from "../../src/lib/error.js";
import { MAX_FILE_BYTES } from "../../src/lib/limits.js";
import { ParseError } from "../../src/lib/parser.js";
import { FileTooLargeError, readNote } from "../../src/lib/readNote.js";
import { PathValidationError, validatePath, validateVaultRoot } from "../../src/lib/validatePath.js";
import { routeToolError } from "../../src/tools/routeError.js";
import type { SafePath } from "../../src/types.js";
import { createTempVault } from "../helpers/vault.js";

const execp = promisify(exec);

let vault: { path: string; cleanup: () => Promise<void> };
let vaultRoot: { absolute: string };

beforeEach(async () => {
	vault = await createTempVault({});
	vaultRoot = await validateVaultRoot(vault.path);
});

afterEach(async () => {
	await vault.cleanup();
});

describe("readNote — happy path", () => {
	test("returns {source, parsed} for a well-formed file", async () => {
		await writeFile(join(vault.path, "happy.md"), "# Heading\n\nBody.\n", "utf-8");
		const safe = await validatePath("happy.md", vaultRoot);
		const result = await readNote(safe);
		expect(result.source).toBe("# Heading\n\nBody.\n");
		expect(result.parsed.outline).toHaveLength(1);
		expect(result.parsed.outline[0]?.path).toBe("Heading");
	});
});

describe("readNote — FileTooLargeError", () => {
	test("file size > MAX_FILE_BYTES throws FileTooLargeError before reading bytes", async () => {
		// Create a sparse-ish file just over the cap. Using a Buffer of the
		// exact size keeps the test deterministic across platforms.
		const oversize = MAX_FILE_BYTES + 1;
		const buf = Buffer.alloc(oversize, "a");
		await writeFile(join(vault.path, "huge.md"), buf);
		const safe = await validatePath("huge.md", vaultRoot);
		await expect(readNote(safe)).rejects.toBeInstanceOf(FileTooLargeError);
		try {
			await readNote(safe);
		} catch (e) {
			if (e instanceof FileTooLargeError) {
				expect(e.actualBytes).toBe(oversize);
				expect(e.limitBytes).toBe(MAX_FILE_BYTES);
				expect(e.relpath).toBe("huge.md");
			}
		}
	});
});

describe("readNote — encoding errors", () => {
	test("invalid UTF-8 bytes throw ParseError reason='encoding_failed'", async () => {
		// 0xFF / 0xFE are invalid as a leading UTF-8 byte sequence.
		await writeFile(join(vault.path, "bad-utf8.md"), Buffer.from([0xff, 0xfe, 0x00, 0x21]));
		const safe = await validatePath("bad-utf8.md", vaultRoot);
		try {
			await readNote(safe);
			throw new Error("expected ParseError");
		} catch (e) {
			expect(e).toBeInstanceOf(ParseError);
			if (e instanceof ParseError) expect(e.reason).toBe("encoding_failed");
		}
	});
});

describe("readNote — VAULT_EXTENSIONS gate", () => {
	test("non-markdown extension (.txt) → PathValidationError PATH_NOT_FOUND", async () => {
		await writeFile(join(vault.path, "secret.txt"), "secret data\n", "utf-8");
		const safe = await validatePath("secret.txt", vaultRoot);
		try {
			await readNote(safe);
			throw new Error("expected PathValidationError");
		} catch (e) {
			expect(e).toBeInstanceOf(PathValidationError);
			if (e instanceof PathValidationError) {
				expect(e.payload.code).toBe("PATH_NOT_FOUND");
				expect(e.payload.param).toBe("file");
			}
		}
	});
});

describe("readNote — hidden-path gate (default-off)", () => {
	test("dot-prefixed directory (.obsidian/notes.md) → PathValidationError PATH_NOT_FOUND", async () => {
		await mkdir(join(vault.path, ".obsidian"));
		await writeFile(join(vault.path, ".obsidian", "notes.md"), "# secret\n", "utf-8");
		const safe = await validatePath(".obsidian/notes.md", vaultRoot);
		try {
			await readNote(safe);
			throw new Error("expected PathValidationError");
		} catch (e) {
			expect(e).toBeInstanceOf(PathValidationError);
			if (e instanceof PathValidationError) {
				expect(e.payload.code).toBe("PATH_NOT_FOUND");
				expect(e.payload.param).toBe("file");
			}
		}
	});

	test("dot-prefixed file in normal directory (notes/.private.md) → PATH_NOT_FOUND", async () => {
		await mkdir(join(vault.path, "notes"));
		await writeFile(join(vault.path, "notes", ".private.md"), "# private\n", "utf-8");
		const safe = await validatePath("notes/.private.md", vaultRoot);
		await expect(readNote(safe)).rejects.toBeInstanceOf(PathValidationError);
	});
});

describe("readNote — at-cap boundary", () => {
	// 10MB write + parse + tokenize is borderline against vitest's 10s default;
	// per-test timeout bump keeps CI stable.
	test("file at exactly MAX_FILE_BYTES is read successfully", { timeout: 30_000 }, async () => {
		// Bounded read uses a `MAX_FILE_BYTES + 1` buffer; this test pins the
		// "exactly cap" boundary so the read-loop and slice logic don't
		// off-by-one. Use a markdown-shaped body so parseFile succeeds.
		const header = "# H\n\n";
		const padding = "x".repeat(MAX_FILE_BYTES - header.length);
		const content = header + padding;
		expect(content.length).toBe(MAX_FILE_BYTES);
		await writeFile(join(vault.path, "at-cap.md"), content, "utf-8");
		const safe = await validatePath("at-cap.md", vaultRoot);
		const result = await readNote(safe);
		expect(result.source.length).toBe(MAX_FILE_BYTES);
	});
});

describe("readNote — non-regular files", () => {
	test("directory path → PathValidationError PATH_NOT_FOUND", async () => {
		await mkdir(join(vault.path, "subdir"));
		const safe = await validatePath("subdir", vaultRoot);
		try {
			await readNote(safe);
			throw new Error("expected PathValidationError");
		} catch (e) {
			expect(e).toBeInstanceOf(PathValidationError);
			if (e instanceof PathValidationError) {
				expect(e.payload.code).toBe("PATH_NOT_FOUND");
				expect(e.payload.param).toBe("file");
			}
		}
	});

	test.skipIf(process.platform === "win32")("FIFO does not block server; surfaces PATH_NOT_FOUND", async () => {
		const fifoPath = join(vault.path, "pipe.md");
		await execp(`mkfifo ${JSON.stringify(fifoPath)}`);
		const safe = await validatePath("pipe.md", vaultRoot);
		// Strict timeout — without O_NONBLOCK + isFile gate this hangs forever.
		const result = await Promise.race([
			readNote(safe).catch((e) => ({ kind: "throw" as const, error: e })),
			new Promise<{ kind: "timeout" }>((resolve) => setTimeout(() => resolve({ kind: "timeout" }), 2000)),
		]);
		expect(result.kind).toBe("throw");
		if (result.kind === "throw") {
			expect(result.error).toBeInstanceOf(PathValidationError);
			if (result.error instanceof PathValidationError) {
				expect(result.error.payload.code).toBe("PATH_NOT_FOUND");
				expect(result.error.payload.param).toBe("file");
			}
		}
	});
});

describe("readNote — post-validation TOCTOU window (open errno → domain error)", () => {
	test("ENOENT from openNoFollow (file deleted post-validation) → PATH_NOT_FOUND", async () => {
		// Construct a SafePath pointing at a path that openNoFollow will fail
		// to find. Bypassing validatePath here is intentional — we're simulating
		// the documented THREAT_MODEL V1/V6 race where the file disappears
		// between successful validation and the open syscall.
		const safe: SafePath = {
			input: "ghost.md",
			normalized: "ghost.md",
			absolute: join(vault.path, "ghost.md"),
			relative: "ghost.md",
		};
		try {
			await readNote(safe);
			throw new Error("expected PathValidationError");
		} catch (e) {
			expect(e).toBeInstanceOf(PathValidationError);
			if (e instanceof PathValidationError) {
				expect(e.payload.code).toBe("PATH_NOT_FOUND");
				expect(e.payload.param).toBe("file");
			}
		}
	});

	test("ELOOP from openNoFollow (leaf swapped to symlink) → PATH_OUTSIDE_VAULT", async () => {
		// Real symlink at the leaf — bypass validatePath (which would catch
		// it at lstat time) by hand-constructing a SafePath. Mirrors the
		// "swap window" between validatePath returning a SafePath for a
		// regular file and openNoFollow's O_NOFOLLOW refusing the swapped
		// symlink at open time.
		const target = join(vault.path, "real.md");
		await writeFile(target, "# real\n", "utf-8");
		const linkPath = join(vault.path, "swapped.md");
		await symlink(target, linkPath);
		const safe: SafePath = {
			input: "swapped.md",
			normalized: "swapped.md",
			absolute: linkPath,
			relative: "swapped.md",
		};
		try {
			await readNote(safe);
			throw new Error("expected PathValidationError");
		} catch (e) {
			expect(e).toBeInstanceOf(PathValidationError);
			if (e instanceof PathValidationError) {
				expect(e.payload.code).toBe("PATH_OUTSIDE_VAULT");
				expect(e.payload.param).toBe("file");
				expect(e.payload.reason).toBe("SYMLINK_SEGMENT");
			}
		}
	});
});

describe("FILE_TOO_LARGE envelope routing", () => {
	test("routed envelope's structuredContent.param is the literal 'file'", async () => {
		const oversize = MAX_FILE_BYTES + 1;
		await writeFile(join(vault.path, "huge.md"), Buffer.alloc(oversize, "a"));
		const safe = await validatePath("huge.md", vaultRoot);
		let envelope: ToolErrorEnvelope | undefined;
		try {
			await readNote(safe);
		} catch (err) {
			envelope = routeToolError(err, "get_file_outline");
		}
		expect(envelope).toBeDefined();
		expect(envelope?.structuredContent.code).toBe("FILE_TOO_LARGE");
		expect(envelope?.structuredContent.param).toBe("file");
		expect(envelope?.structuredContent.limit_bytes).toBe(MAX_FILE_BYTES);
		expect(envelope?.structuredContent.actual_bytes).toBe(oversize);
	});
});
