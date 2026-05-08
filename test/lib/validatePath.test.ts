/**
 * Security corpus tests for `validatePath`.
 *
 * The "rejection group" is the W1 exit gate (Brief lines 766–770): every
 * input below MUST throw a `PathValidationError` whose payload carries
 * `code: "PATH_OUTSIDE_VAULT"` (or `VAULT_ROOT_SYMLINK` for the startup
 * case) before W1 ships. The "downstream guards" group (10 MB cap,
 * case-mismatch ENOENT) is W2/W4.
 */

import { symlink, unlink } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import {
	assertIndexFilesAreRegular,
	classifyRelpathPolicy,
	ensureIndexDirIsRealDir,
	openNoFollow,
	PathValidationError,
	type VaultRoot,
	validatePath,
	validateVaultRoot,
} from "../../src/lib/validatePath.js";
import type { ErrorCode, PathRejectionReason, VaultError } from "../../src/types.js";
import { buildDeepPath, createSymlink, createTempVault, DEFAULT_VAULT_STRUCTURE, UUID_V4 } from "../helpers/vault.js";

const REJECTION_INPUTS: Array<{ input: string; reason: PathRejectionReason }> = [
	{ input: "../", reason: "TRAVERSAL_SEGMENT" },
	{ input: "../../etc/passwd", reason: "TRAVERSAL_SEGMENT" },
	{ input: "..%2f", reason: "PERCENT_ENCODED" },
	{ input: "%2e%2e/", reason: "PERCENT_ENCODED" },
	{ input: "%252e%252e/", reason: "PERCENT_ENCODED" },
	{ input: "..\\\\", reason: "BACKSLASH" },
	{ input: "\x00../", reason: "NULL_BYTE" },
	{ input: "note.md\x00.txt", reason: "NULL_BYTE" },
	{ input: "/etc/passwd", reason: "ABSOLUTE_PATH" },
	{ input: "//vault/note.md", reason: "ABSOLUTE_PATH" },
	{ input: "%c0%ae%c0%ae/", reason: "PERCENT_ENCODED" },
];

/**
 * Capture the `PathValidationError` payload from a thrown call. Returns
 * the payload so callers can assert additional fields (`param`, `cause`,
 * etc.) beyond the common `code`/`reason`/`request_id` triple.
 */
async function expectPathRejection(
	thunk: () => Promise<unknown>,
	expectedCode: ErrorCode,
	expectedReason?: PathRejectionReason,
): Promise<VaultError> {
	let caught: unknown;
	try {
		await thunk();
	} catch (err) {
		caught = err;
	}
	expect(caught).toBeInstanceOf(PathValidationError);
	const payload = (caught as PathValidationError).payload;
	expect(payload.code).toBe(expectedCode);
	expect(payload.request_id).toMatch(UUID_V4);
	if (expectedReason !== undefined) {
		expect(payload.reason).toBe(expectedReason);
	}
	return payload;
}

let vault: { path: string; cleanup: () => Promise<void> };
let root: VaultRoot;

beforeAll(async () => {
	vault = await createTempVault(DEFAULT_VAULT_STRUCTURE);
	root = await validateVaultRoot(vault.path);
});

afterAll(async () => {
	await vault.cleanup();
});

describe("validatePath — rejection group (W1 exit criterion)", () => {
	for (const { input, reason } of REJECTION_INPUTS) {
		test(`rejects ${JSON.stringify(input)} with reason=${reason}`, async () => {
			await expectPathRejection(() => validatePath(input, root), "PATH_OUTSIDE_VAULT", reason);
		});
	}

	test("rejects path > 32 segments deep with reason=TOO_DEEP", async () => {
		const tooDeep = `${buildDeepPath(33)}/file.md`;
		await expectPathRejection(() => validatePath(tooDeep, root), "PATH_OUTSIDE_VAULT", "TOO_DEEP");
	});

	test("rejects path > 1024 chars with reason=PATH_TOO_LONG", async () => {
		const longInput = `${"a/".repeat(513)}x.md`; // > 1024
		await expectPathRejection(() => validatePath(longInput, root), "PATH_OUTSIDE_VAULT", "PATH_TOO_LONG");
	});

	test("rejects symlinked segment with reason=SYMLINK_SEGMENT", async () => {
		// Symlink tests use isolated temp vaults so they don't pollute the
		// shared fixture and can run safely with beforeAll setup.
		const isolated = await createTempVault({ "foo.md": "# foo\n" });
		const linkedRoot = await createTempVault({ "target.md": "# target\n" });
		try {
			const isolatedRoot = await validateVaultRoot(isolated.path);
			await createSymlink(linkedRoot.path, `${isolated.path}/linked_dir`);
			await expectPathRejection(
				() => validatePath("linked_dir/target.md", isolatedRoot),
				"PATH_OUTSIDE_VAULT",
				"SYMLINK_SEGMENT",
			);
		} finally {
			await Promise.all([isolated.cleanup(), linkedRoot.cleanup()]);
		}
	});

	test("rejects symlinked leaf with reason=SYMLINK_SEGMENT", async () => {
		const isolated = await createTempVault({ "foo.md": "# foo\n" });
		try {
			const isolatedRoot = await validateVaultRoot(isolated.path);
			await createSymlink(`${isolated.path}/foo.md`, `${isolated.path}/leaf-link.md`);
			await expectPathRejection(
				() => validatePath("leaf-link.md", isolatedRoot),
				"PATH_OUTSIDE_VAULT",
				"SYMLINK_SEGMENT",
			);
		} finally {
			await isolated.cleanup();
		}
	});

	test("validateVaultRoot rejects symlinked root with reason=VAULT_ROOT_SYMLINK", async () => {
		const real = await createTempVault({ "x.md": "# x\n" });
		const linkVault = await createTempVault({});
		try {
			const linkPath = `${linkVault.path}/symlinked-vault`;
			await createSymlink(real.path, linkPath);
			await expectPathRejection(() => validateVaultRoot(linkPath), "PATH_OUTSIDE_VAULT", "VAULT_ROOT_SYMLINK");
		} finally {
			await Promise.all([linkVault.cleanup(), real.cleanup()]);
		}
	});

	test.each([
		{ suffix: "/", label: "trailing slash" },
		{ suffix: "/.", label: "trailing /." },
		{ suffix: "/./", label: "trailing /./" },
	])("validateVaultRoot rejects symlinked root with $label", async ({ suffix }) => {
		const real = await createTempVault({ "x.md": "# x\n" });
		const linkVault = await createTempVault({});
		try {
			const linkPath = `${linkVault.path}/symlinked-vault`;
			await createSymlink(real.path, linkPath);
			await expectPathRejection(
				() => validateVaultRoot(`${linkPath}${suffix}`),
				"PATH_OUTSIDE_VAULT",
				"VAULT_ROOT_SYMLINK",
			);
		} finally {
			await Promise.all([linkVault.cleanup(), real.cleanup()]);
		}
	});

	test("validateVaultRoot rejects non-directory file with reason=VAULT_ROOT_NOT_DIRECTORY", async () => {
		const payload = await expectPathRejection(
			() => validateVaultRoot(`${vault.path}/foo.md`),
			"PATH_OUTSIDE_VAULT",
			"VAULT_ROOT_NOT_DIRECTORY",
		);
		expect(payload.param).toBe("vault");
	});

	test("validateVaultRoot rejects non-existent path", async () => {
		await expect(validateVaultRoot("/this/path/almost/certainly/does/not/exist/8675309")).rejects.toThrow(
			PathValidationError,
		);
	});
});

describe("classifyRelpathPolicy — sync subset of validatePath", () => {
	const POLICY_CASES: Array<{ input: string; reason: PathRejectionReason | null }> = [
		{ input: "", reason: "EMPTY_PATH" },
		{ input: "a/b.md", reason: null },
		{ input: "./a.md", reason: null },
		{ input: "/abs/path.md", reason: "ABSOLUTE_PATH" },
		{ input: "a\\b.md", reason: "BACKSLASH" },
		{ input: "a%2fb.md", reason: "PERCENT_ENCODED" },
		{ input: "a\x00b.md", reason: "NULL_BYTE" },
		{ input: "a/../b.md", reason: "TRAVERSAL_SEGMENT" },
		{ input: "../escape.md", reason: "TRAVERSAL_SEGMENT" },
	];

	for (const { input, reason } of POLICY_CASES) {
		const label = reason === null ? "accepts" : `rejects with ${reason}`;
		test(`${label}: ${JSON.stringify(input)}`, () => {
			expect(classifyRelpathPolicy(input)).toBe(reason);
		});
	}

	test("rejects path > 1024 chars with PATH_TOO_LONG", () => {
		const longInput = `${"a/".repeat(513)}x.md`;
		expect(classifyRelpathPolicy(longInput)).toBe("PATH_TOO_LONG");
	});

	test("rejects path > 32 segments deep with TOO_DEEP", () => {
		const tooDeep = `${buildDeepPath(33)}/file.md`;
		expect(classifyRelpathPolicy(tooDeep)).toBe("TOO_DEEP");
	});

	test("validatePath still throws PATH_OUTSIDE_VAULT for every classifier rejection", async () => {
		// Confirms the refactor preserved validatePath's behavior — the
		// policy classifier is the single source, validatePath just
		// dispatches its result to PathValidationError.
		for (const { input, reason } of POLICY_CASES) {
			if (reason === null) continue;
			await expectPathRejection(() => validatePath(input, root), "PATH_OUTSIDE_VAULT", reason);
		}
	});
});

describe("validatePath — successful path coverage", () => {
	test("accepts top-level file", async () => {
		const safe = await validatePath("foo.md", root);
		expect(safe.relative).toBe("foo.md");
		expect(safe.normalized).toBe("foo.md");
		expect(safe.absolute.endsWith("foo.md")).toBe(true);
	});

	test("accepts nested file", async () => {
		const safe = await validatePath("sub/nested.md", root);
		expect(safe.relative).toBe("sub/nested.md");
	});

	test("accepts leading ./ shorthand", async () => {
		const safe = await validatePath("./foo.md", root);
		expect(safe.relative).toBe("foo.md");
	});

	test("safe.absolute is the pre-realpath walked path (D8 + V1/V6)", async () => {
		// Pin the contract. If `safe.absolute` were ever switched back to
		// `realpath(walked)`, an in-vault leaf-symlink swap created
		// between the segment walk and the realpath would be silently
		// followed and `openNoFollow` would not see the symlink.
		const safe = await validatePath("foo.md", root);
		expect(safe.absolute).toBe(join(root.absolute, "foo.md"));
	});
});

describe("openNoFollow — closes validation→open TOCTOU window", () => {
	test("rejects a leaf-symlink swap performed AFTER validatePath returns", async () => {
		const isolated = await createTempVault({ "victim.md": "# v\n", "target.md": "# t\n" });
		try {
			const isolatedRoot = await validateVaultRoot(isolated.path);
			const safe = await validatePath("victim.md", isolatedRoot);
			await unlink(safe.absolute);
			await symlink(`${isolated.path}/target.md`, safe.absolute);
			await expect(openNoFollow(safe.absolute)).rejects.toMatchObject({ code: "ELOOP" });
		} finally {
			await isolated.cleanup();
		}
	});
});

describe("validatePath — edge cases", () => {
	test("rejects empty input", async () => {
		await expect(validatePath("", root)).rejects.toThrow(PathValidationError);
	});

	test("rejects '.'", async () => {
		await expect(validatePath(".", root)).rejects.toThrow(PathValidationError);
	});

	test("rejects '/'", async () => {
		await expect(validatePath("/", root)).rejects.toThrow(PathValidationError);
	});

	test("rejects sub/../sub/foo.md (traversal segment fails pre-check)", async () => {
		// Even though the path resolves back inside the vault, the `..`
		// segment is rejected by the pre-check — defense in depth.
		await expect(validatePath("sub/../sub/nested.md", root)).rejects.toThrow(PathValidationError);
	});

	test("returns ENOENT-style PATH_NOT_FOUND for missing-but-otherwise-valid path", async () => {
		await expectPathRejection(() => validatePath("does-not-exist.md", root), "PATH_NOT_FOUND");
	});

	test("returns PATH_NOT_FOUND for traversal through a regular file (ENOTDIR)", async () => {
		// `foo.md` exists in the shared fixture; `foo.md/bar` triggers ENOTDIR
		// during the segment walk. Same semantic as not-found, not a security
		// rejection.
		await expectPathRejection(() => validatePath("foo.md/bar", root), "PATH_NOT_FOUND");
	});

	test("accepts a vault file literally named `..draft.md`", async () => {
		// `path.relative` returns `"..draft.md"` — segment-aware check must
		// distinguish this from a true `../` escape.
		const dotDraft = await createTempVault({ "..draft.md": "# draft\n" });
		try {
			const dotDraftRoot = await validateVaultRoot(dotDraft.path);
			const safe = await validatePath("..draft.md", dotDraftRoot);
			expect(safe.relative).toBe("..draft.md");
		} finally {
			await dotDraft.cleanup();
		}
	});

	test("validateVaultRoot resolves macOS /var → /private/var style stable links", async () => {
		// realpath of the temp dir is what gets cached; per-call validate
		// compares against the resolved absolute. A vault path like /var/tmp/...
		// on macOS resolves to /private/var/... — captured here so future
		// changes don't accidentally store the input form instead.
		const { realpath } = await import("node:fs/promises");
		expect(root.absolute).toBe(await realpath(vault.path));
	});

	test("handles NFC/NFD round-trip on Unicode filenames", async () => {
		// Combining marks: "café" can be NFC (0xC3 0xA9) or NFD ("e" +
		// combining acute 0xCC 0x81). validatePath normalizes input to NFC;
		// realpath returns the OS-native form (NFD on HFS+, NFC on APFS).
		const composed = "café.md".normalize("NFC");
		const decomposed = "café.md".normalize("NFD");
		const cafeVault = await createTempVault({ [composed]: "# café\n" });
		try {
			const cafeRoot = await validateVaultRoot(cafeVault.path);
			const safeNfc = await validatePath(composed, cafeRoot);
			expect(safeNfc.normalized).toBe(composed);
			const safeNfd = await validatePath(decomposed, cafeRoot).catch(() => null);
			if (safeNfd) {
				expect(safeNfd.normalized).toBe(composed);
			}
		} finally {
			await cafeVault.cleanup();
		}
	});
});

describe("ensureIndexDirIsRealDir — startup symlink guard for .vault-mcp", () => {
	test("ENOENT (fresh vault) returns without throwing", async () => {
		const isolated = await createTempVault({});
		try {
			await ensureIndexDirIsRealDir(`${isolated.path}/.vault-mcp`);
		} finally {
			await isolated.cleanup();
		}
	});

	test("real directory passes through", async () => {
		const isolated = await createTempVault({ ".vault-mcp": { "keep.txt": "x" } });
		try {
			await ensureIndexDirIsRealDir(`${isolated.path}/.vault-mcp`);
		} finally {
			await isolated.cleanup();
		}
	});

	test("symlinked .vault-mcp rejected with VAULT_ROOT_SYMLINK", async () => {
		const isolated = await createTempVault({});
		const exfil = await createTempVault({});
		try {
			await createSymlink(exfil.path, `${isolated.path}/.vault-mcp`);
			await expectPathRejection(
				() => ensureIndexDirIsRealDir(`${isolated.path}/.vault-mcp`),
				"PATH_OUTSIDE_VAULT",
				"VAULT_ROOT_SYMLINK",
			);
		} finally {
			await Promise.all([isolated.cleanup(), exfil.cleanup()]);
		}
	});

	test("regular file at .vault-mcp rejected with VAULT_ROOT_NOT_DIRECTORY", async () => {
		const isolated = await createTempVault({ ".vault-mcp": "not a dir" });
		try {
			await expectPathRejection(
				() => ensureIndexDirIsRealDir(`${isolated.path}/.vault-mcp`),
				"PATH_OUTSIDE_VAULT",
				"VAULT_ROOT_NOT_DIRECTORY",
			);
		} finally {
			await isolated.cleanup();
		}
	});
});

describe("assertIndexFilesAreRegular — leaf-symlink + non-regular guard", () => {
	const dbRel = ".vault-mcp/index.sqlite3";

	test("ENOENT on all three paths (cold start) returns without throwing", async () => {
		const isolated = await createTempVault({ ".vault-mcp": {} });
		try {
			await assertIndexFilesAreRegular(`${isolated.path}/${dbRel}`);
		} finally {
			await isolated.cleanup();
		}
	});

	test("regular SQLite file (no sidecars) passes through", async () => {
		const isolated = await createTempVault({ ".vault-mcp": { "index.sqlite3": "fake" } });
		try {
			await assertIndexFilesAreRegular(`${isolated.path}/${dbRel}`);
		} finally {
			await isolated.cleanup();
		}
	});

	test("symlinked index.sqlite3 rejected with INDEX_FILE_SYMLINK", async () => {
		const isolated = await createTempVault({ ".vault-mcp": {} });
		const exfil = await createTempVault({ "evil.sqlite3": "exfil" });
		try {
			await createSymlink(`${exfil.path}/evil.sqlite3`, `${isolated.path}/${dbRel}`);
			await expectPathRejection(
				() => assertIndexFilesAreRegular(`${isolated.path}/${dbRel}`),
				"PATH_OUTSIDE_VAULT",
				"INDEX_FILE_SYMLINK",
			);
		} finally {
			await Promise.all([isolated.cleanup(), exfil.cleanup()]);
		}
	});

	test("symlinked -wal sidecar rejected with INDEX_FILE_SYMLINK", async () => {
		const isolated = await createTempVault({ ".vault-mcp": { "index.sqlite3": "fake" } });
		const exfil = await createTempVault({ "evil.wal": "exfil" });
		try {
			await createSymlink(`${exfil.path}/evil.wal`, `${isolated.path}/${dbRel}-wal`);
			await expectPathRejection(
				() => assertIndexFilesAreRegular(`${isolated.path}/${dbRel}`),
				"PATH_OUTSIDE_VAULT",
				"INDEX_FILE_SYMLINK",
			);
		} finally {
			await Promise.all([isolated.cleanup(), exfil.cleanup()]);
		}
	});

	test("symlinked -shm sidecar rejected with INDEX_FILE_SYMLINK", async () => {
		const isolated = await createTempVault({ ".vault-mcp": { "index.sqlite3": "fake" } });
		const exfil = await createTempVault({ "evil.shm": "exfil" });
		try {
			await createSymlink(`${exfil.path}/evil.shm`, `${isolated.path}/${dbRel}-shm`);
			await expectPathRejection(
				() => assertIndexFilesAreRegular(`${isolated.path}/${dbRel}`),
				"PATH_OUTSIDE_VAULT",
				"INDEX_FILE_SYMLINK",
			);
		} finally {
			await Promise.all([isolated.cleanup(), exfil.cleanup()]);
		}
	});

	// Vault-controlled cache is hostile input: a pre-planted directory
	// (or FIFO / device) at the index path bypasses the symlink-only guard
	// and either crashes openSqlite or — in the block-device case —
	// redirects index writes onto a real partition.
	test("directory at index.sqlite3 rejected with INDEX_FILE_NOT_REGULAR", async () => {
		const isolated = await createTempVault({ ".vault-mcp": { "index.sqlite3": {} } });
		try {
			await expectPathRejection(
				() => assertIndexFilesAreRegular(`${isolated.path}/${dbRel}`),
				"PATH_OUTSIDE_VAULT",
				"INDEX_FILE_NOT_REGULAR",
			);
		} finally {
			await isolated.cleanup();
		}
	});

	test("directory at -wal sidecar rejected with INDEX_FILE_NOT_REGULAR", async () => {
		const isolated = await createTempVault({
			".vault-mcp": { "index.sqlite3": "fake", "index.sqlite3-wal": {} },
		});
		try {
			await expectPathRejection(
				() => assertIndexFilesAreRegular(`${isolated.path}/${dbRel}`),
				"PATH_OUTSIDE_VAULT",
				"INDEX_FILE_NOT_REGULAR",
			);
		} finally {
			await isolated.cleanup();
		}
	});

	test("directory at -shm sidecar rejected with INDEX_FILE_NOT_REGULAR", async () => {
		const isolated = await createTempVault({
			".vault-mcp": { "index.sqlite3": "fake", "index.sqlite3-shm": {} },
		});
		try {
			await expectPathRejection(
				() => assertIndexFilesAreRegular(`${isolated.path}/${dbRel}`),
				"PATH_OUTSIDE_VAULT",
				"INDEX_FILE_NOT_REGULAR",
			);
		} finally {
			await isolated.cleanup();
		}
	});
});

describe("VaultError envelope contract", () => {
	test("rejection payload has code + reason + request_id + message + param", async () => {
		const payload = await expectPathRejection(
			() => validatePath("../escape", root),
			"PATH_OUTSIDE_VAULT",
			"TRAVERSAL_SEGMENT",
		);
		expect(payload.message).toBeTruthy();
		expect(payload.param).toBe("file");
	});

	test("two consecutive errors have different request_ids", async () => {
		const a = await expectPathRejection(() => validatePath("../escape", root), "PATH_OUTSIDE_VAULT");
		const b = await expectPathRejection(() => validatePath("../escape", root), "PATH_OUTSIDE_VAULT");
		expect(a.request_id).not.toBe(b.request_id);
	});
});
