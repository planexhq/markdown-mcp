/**
 * Security corpus tests for `validatePath`.
 *
 * The "rejection group" is the W1 exit gate (Brief lines 766–770): every
 * input below MUST throw a `PathValidationError` whose payload carries
 * `code: "PATH_OUTSIDE_VAULT"` (or `VAULT_ROOT_SYMLINK` for the startup
 * case) before W1 ships. The "downstream guards" group (10 MB cap,
 * case-mismatch ENOENT) is W2/W4.
 */

import { mkdir, realpath, rename, symlink, unlink, writeFile } from "node:fs/promises";
import { join, parse } from "node:path";
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
	WIN_ROOT_NEEDING_SEP,
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

	// Win32-only: a trailing backslash is the native separator form (shell
	// tab-completion appends it). `stripTrailingPathSep` recognizes `\` as a
	// separator on Windows (via the imported `sep`) so the symlink root is
	// still caught; a `/`-only strip would miss it entirely.
	test.runIf(process.platform === "win32")(
		"validateVaultRoot rejects symlinked root with trailing backslash (win32)",
		async () => {
			const real = await createTempVault({ "x.md": "# x\n" });
			const linkVault = await createTempVault({});
			try {
				const linkPath = `${linkVault.path}/symlinked-vault`;
				await createSymlink(real.path, linkPath);
				await expectPathRejection(() => validateVaultRoot(`${linkPath}\\`), "PATH_OUTSIDE_VAULT", "VAULT_ROOT_SYMLINK");
			} finally {
				await Promise.all([linkVault.cleanup(), real.cleanup()]);
			}
		},
	);

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

	test("validateVaultRoot('<existing>/missing/..') fails instead of collapsing to CWD", async () => {
		// `path.resolve` would strip `missing/..` lexically and silently
		// accept the surviving directory; preserving the segments lets
		// `lstat` fail with ENOENT on the non-existent component.
		const isolated = await createTempVault({});
		try {
			await expectPathRejection(
				() => validateVaultRoot(`${isolated.path}/missing/..`),
				"PATH_OUTSIDE_VAULT",
				"VAULT_ROOT_INACCESSIBLE",
			);
		} finally {
			await isolated.cleanup();
		}
	});

	test("validateVaultRoot('<symlink>/..') resolves through the link, not to its lexical parent", async () => {
		// Pre-fix `resolve("inner/link/..")` collapsed to `inner` (the
		// symlink's lexical parent). Post-fix `lstat` traverses the
		// symlink to its target, then applies `..` to land at the
		// target's parent — a different directory.
		const outerVault = await createTempVault({
			"target/x.md": "# x\n",
			"inner/placeholder.md": "# p\n",
		});
		try {
			const innerDir = `${outerVault.path}/inner`;
			const targetDir = `${outerVault.path}/target`;
			const linkPath = `${innerDir}/link`;
			await createSymlink(targetDir, linkPath);

			const vaultRoot = await validateVaultRoot(`${linkPath}/..`);
			const fsReachedParent = await realpath(outerVault.path);
			const lexicalParent = await realpath(innerDir);
			expect(vaultRoot.absolute).toBe(fsReachedParent);
			expect(vaultRoot.absolute).not.toBe(lexicalParent);
		} finally {
			await outerVault.cleanup();
		}
	});

	// Win32 treats bare `C:` (drive-relative, "current directory on drive
	// C") and `C:\` (drive root) as different paths. Pre-fix
	// `stripTrailingPathSep` coerced both to `C:\` via an unconditional
	// regex restore, silently booting the server on the wrong target. The
	// fix gates the restore on "loop actually stripped a separator."
	test.runIf(process.platform === "win32")(
		"validateVaultRoot('C:') preserves drive-relative semantics on Win32",
		async () => {
			const drive = parse(process.cwd()).root.charAt(0);
			// Drive root == CWD collapses the two semantics; nothing to assert.
			if (process.cwd() === `${drive}:\\`) return;

			const vaultRoot = await validateVaultRoot(`${drive}:`);
			expect(vaultRoot.absolute).toBe(await realpath(process.cwd()));
			expect(vaultRoot.absolute).not.toBe(`${drive}:\\`);
		},
	);

	// Regression guard for the round-51 strip case the regex was originally
	// added for. Loop strips trailing `\`; restore brings it back so
	// `lstat` doesn't fail on the bare `C:` form.
	test.runIf(process.platform === "win32")(
		"validateVaultRoot('C:\\\\') still resolves to drive root on Win32",
		async () => {
			const drive = parse(process.cwd()).root.charAt(0);
			const driveRoot = `${drive}:\\`;
			const vaultRoot = await validateVaultRoot(driveRoot);
			expect(vaultRoot.absolute).toBe(await realpath(driveRoot));
		},
	);

	// Extended-length verbatim namespace requires the trailing separator;
	// stripping it produces `\\?\C:` which Windows treats as invalid.
	test.runIf(process.platform === "win32")(
		"validateVaultRoot('\\\\?\\\\C:\\\\') preserves verbatim drive root on Win32",
		async () => {
			const drive = parse(process.cwd()).root.charAt(0);
			const verbatim = `\\\\?\\${drive}:\\`;
			const vaultRoot = await validateVaultRoot(verbatim);
			expect(vaultRoot.absolute).toBeTruthy();
			expect(vaultRoot.absolute).not.toBe(`\\\\?\\${drive}:`);
		},
	);

	// DOS device namespace `\\.\C:\` is the FS root; the trailerless
	// `\\.\C:` opens the raw block device — semantically a different target.
	test.runIf(process.platform === "win32")(
		"validateVaultRoot('\\\\.\\\\C:\\\\') preserves DOS device drive root on Win32",
		async () => {
			const drive = parse(process.cwd()).root.charAt(0);
			const device = `\\\\.\\${drive}:\\`;
			const vaultRoot = await validateVaultRoot(device);
			expect(vaultRoot.absolute).toBeTruthy();
			expect(vaultRoot.absolute).not.toBe(`\\\\.\\${drive}:`);
		},
	);

	test("validateVaultRoot('<vault>/<file>/..') rejects — `..` cannot exit a non-directory", async () => {
		// `realpath` succeeds on a regular file, so the walk's `..` branch
		// would `dirname` it to the file's parent; POSIX fails such a path
		// with ENOTDIR. The directory guard restores that.
		const isolated = await createTempVault({ "note.md": "# n\n" });
		try {
			await expectPathRejection(
				() => validateVaultRoot(`${isolated.path}/note.md/..`),
				"PATH_OUTSIDE_VAULT",
				"VAULT_ROOT_INACCESSIBLE",
			);
		} finally {
			await isolated.cleanup();
		}
	});

	test("validateVaultRoot('<symlink-to-file>/..') rejects instead of landing in the link target's parent", async () => {
		// `realpath` follows the symlink to its file target; without the
		// directory guard `dirname` would then walk to the target's parent —
		// a directory unrelated to the path the operator supplied.
		const isolated = await createTempVault({ "note.md": "# n\n" });
		try {
			await createSymlink(`${isolated.path}/note.md`, `${isolated.path}/link`);
			await expectPathRejection(
				() => validateVaultRoot(`${isolated.path}/link/..`),
				"PATH_OUTSIDE_VAULT",
				"VAULT_ROOT_INACCESSIBLE",
			);
		} finally {
			await isolated.cleanup();
		}
	});

	// Trailerless `\\?\C:` is a malformed root — the `\\?\` namespace requires
	// the drive-root form `\\?\C:\`. Pre-fix `stripDeviceNamespacePrefix`
	// rewrote it to bare `C:` (drive-relative → CWD); the separator-gated
	// regex now leaves it untouched so it is rejected, not silently retargeted.
	test.runIf(process.platform === "win32")(
		"validateVaultRoot rejects a trailerless \\\\?\\C: device-namespace root (win32)",
		async () => {
			const drive = parse(process.cwd()).root.charAt(0);
			await expectPathRejection(
				() => validateVaultRoot(`\\\\?\\${drive}:`),
				"PATH_OUTSIDE_VAULT",
				"VAULT_ROOT_INACCESSIBLE",
			);
		},
	);

	// A Win32 drive-relative root (`C:src`) names a path under the CWD on that
	// drive, not under the drive root. Pre-fix `walkVaultRoot` seeded `cur`
	// with the bare `C:` root, so `join("C:","src")` jumped to `C:\src`; the
	// fix resolves the drive-relative root before walking.
	test.runIf(process.platform === "win32")(
		"validateVaultRoot resolves a drive-relative root against the drive CWD (win32)",
		async () => {
			const drive = parse(process.cwd()).root.charAt(0);
			const vaultRoot = await validateVaultRoot(`${drive}:src`);
			expect(vaultRoot.absolute).toBe(await realpath(join(process.cwd(), "src")));
		},
	);

	// `path.parse` truncates a verbatim-UNC root to `\\?\UNC\`, so the segment
	// walk can't reconstruct the server\share root. Verbatim UNC vault roots
	// are rejected with a pointer to the plain `\\server\share\` form (which
	// parses correctly). Platform-agnostic — the guard is a pure string check.
	test("validateVaultRoot rejects a verbatim-UNC vault root", async () => {
		const payload = await expectPathRejection(
			() => validateVaultRoot("\\\\?\\UNC\\server\\share\\vault"),
			"PATH_OUTSIDE_VAULT",
			"VAULT_ROOT_INACCESSIBLE",
		);
		expect(payload.message).toContain("Verbatim UNC");
	});

	// POSIX treats `\` as an ordinary filename character, so the segment walk
	// must split a vault root on `/` alone here — splitting on `\` too would
	// shatter a real directory named `a\b` into two non-existent segments and
	// reject (or mis-target) a valid root. Win32-skipped: NTFS forbids `\` in
	// a name, so the directory cannot be created there.
	test.runIf(process.platform !== "win32")(
		"validateVaultRoot accepts a POSIX vault root whose directory name contains a backslash",
		async () => {
			const isolated = await createTempVault({ "note.md": "# n\n" });
			try {
				const backslashDir = join(isolated.path, "a\\b");
				await mkdir(backslashDir);
				const vaultRoot = await validateVaultRoot(backslashDir);
				expect(vaultRoot.absolute).toBe(await realpath(backslashDir));
			} finally {
				await isolated.cleanup();
			}
		},
	);

	// An empty root must be rejected, not seeded at ".": `walkVaultRoot` would
	// otherwise return "." and the server would silently index the process
	// CWD. `parseCli` already rejects an empty `--vault`, so this covers
	// direct callers of the exported `validateVaultRoot`.
	test("validateVaultRoot rejects an empty vault root instead of defaulting to CWD", async () => {
		await expectPathRejection(() => validateVaultRoot(""), "PATH_OUTSIDE_VAULT", "VAULT_ROOT_INACCESSIBLE");
	});
});

// Volume GUID paths name the volume device object without the trailing `\`
// and the root directory WITH it (per MS docs: Naming Files, Paths, and
// Namespaces). The regex consumer in `stripTrailingPathSep` only fires on
// Win32, but the regex itself is a pure string check — testing here keeps
// the assertion hermetic. Loss of regex coverage would silently drop the
// trailer for any operator mounting an unlettered volume.
describe("WIN_ROOT_NEEDING_SEP — Windows root forms requiring trailing separator", () => {
	const GUID = "12345678-1234-1234-1234-123456789012";

	test.each([
		`C:`,
		`Z:`,
		`\\\\?\\C:`,
		`\\\\.\\C:`,
		`\\\\?\\Volume{${GUID}}`,
		`\\\\.\\Volume{${GUID}}`,
		`\\\\?\\UNC\\server\\share`,
		`\\\\server\\share`,
	])("matches %s (requires trailing separator)", (input) => {
		expect(WIN_ROOT_NEEDING_SEP.test(input)).toBe(true);
	});

	test.each([
		`C:\\note.md`, // not a root — has trailing content
		`\\\\?\\C:\\note.md`,
		`\\\\?\\Volume{${GUID}}\\note.md`,
		`\\\\.\\Volume{${GUID}}\\note.md`,
		`/usr/local`,
		`a/b.md`,
		``,
	])("does not match %s (not a root needing restore)", (input) => {
		expect(WIN_ROOT_NEEDING_SEP.test(input)).toBe(false);
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
		// Control chars in vault filenames are POSIX-legal but would let a
		// hostile path forge a fake `next: <cursor>` line in prose
		// renderers. Reject at ingress so the indexer never sees them.
		{ input: "foo\nbar.md", reason: "CONTROL_CHAR" },
		{ input: "foo\rbar.md", reason: "CONTROL_CHAR" },
		{ input: "\tnotes.md", reason: "CONTROL_CHAR" },
		{ input: "a\x07b.md", reason: "CONTROL_CHAR" },
		{ input: "a\x1Fb.md", reason: "CONTROL_CHAR" },
		{ input: "a\x7Fb.md", reason: "CONTROL_CHAR" }, // DEL
		// C1 controls + Unicode line/paragraph separators render as line
		// breaks in chat UIs / terminals — same forgery class as `\n`.
		{ input: "foo\u0085bar.md", reason: "CONTROL_CHAR" }, // NEL (C1)
		{ input: "foo\u009Fbar.md", reason: "CONTROL_CHAR" }, // APC (C1)
		{ input: "foo\u2028next: forged.md", reason: "CONTROL_CHAR" }, // LINE SEPARATOR
		{ input: "foo\u2029bar.md", reason: "CONTROL_CHAR" }, // PARAGRAPH SEPARATOR
		// COLON — NTFS alternate data streams. Bare ADS, ADS-with-extension,
		// and colon in any subpath segment all reject.
		{ input: "note.md:secret.md", reason: "COLON" },
		{ input: "notes:stream", reason: "COLON" },
		{ input: "folder/note.md:stream", reason: "COLON" },
		// RESERVED_DEVICE_NAME — case-insensitive base-name match per MS docs:
		// CON, PRN, AUX, NUL, COM1-9 (incl. 8859-1 superscripts ¹²³), LPT1-9
		// (incl. ¹²³). COM0/LPT0 are NOT enumerated by MS, so we don't reject.
		// The 8859-1 superscripts (U+00B9/B2/B3) are reserved but the Unicode
		// superscript block (U+2070+) is NOT — the regex must distinguish.
		{ input: "CON", reason: "RESERVED_DEVICE_NAME" },
		{ input: "CON.md", reason: "RESERVED_DEVICE_NAME" },
		{ input: "con.md", reason: "RESERVED_DEVICE_NAME" },
		{ input: "PRN.txt", reason: "RESERVED_DEVICE_NAME" },
		{ input: "AUX.md", reason: "RESERVED_DEVICE_NAME" },
		{ input: "NUL", reason: "RESERVED_DEVICE_NAME" },
		{ input: "COM9.md", reason: "RESERVED_DEVICE_NAME" },
		{ input: "LPT1.md", reason: "RESERVED_DEVICE_NAME" },
		{ input: "folder/CON.md", reason: "RESERVED_DEVICE_NAME" },
		// 8859-1 superscripts ¹²³ — reserved per MS docs.
		{ input: "COM\u00B9.md", reason: "RESERVED_DEVICE_NAME" }, // COM¹
		{ input: "COM\u00B2.md", reason: "RESERVED_DEVICE_NAME" }, // COM²
		{ input: "COM\u00B3.md", reason: "RESERVED_DEVICE_NAME" }, // COM³
		{ input: "LPT\u00B9.md", reason: "RESERVED_DEVICE_NAME" }, // LPT¹
		{ input: "LPT\u00B2.md", reason: "RESERVED_DEVICE_NAME" }, // LPT²
		{ input: "LPT\u00B3.md", reason: "RESERVED_DEVICE_NAME" }, // LPT³
		{ input: "CONFIGS.md", reason: null }, // CON prefix but boundary fails
		{ input: "MYCON.md", reason: null }, // CON not at start
		{ input: "COM10.md", reason: null }, // COM10 is not a reserved device
		{ input: "COMA.md", reason: null }, // COM[…] needs a digit-class char
		{ input: ".con.md", reason: null }, // leading dot — `.con` not reserved
		{ input: "COM0.md", reason: null }, // COM0 NOT enumerated by MS docs
		{ input: "LPT0.md", reason: null }, // LPT0 NOT enumerated by MS docs
		{ input: "COM\u2074.md", reason: null }, // U+2074 Unicode-superscript-4 NOT 8859-1, NOT reserved
		// TRAILING_DOT_OR_SPACE — NTFS strips these during normalization, so
		// the path aliases another file the FS already exposes via `readdir`.
		{ input: "notes.md.", reason: "TRAILING_DOT_OR_SPACE" },
		{ input: "notes.md ", reason: "TRAILING_DOT_OR_SPACE" },
		{ input: "folder/sub.", reason: "TRAILING_DOT_OR_SPACE" },
		{ input: "folder./note.md", reason: "TRAILING_DOT_OR_SPACE" }, // mid-path segment
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

	test.runIf(process.platform === "win32")(
		"Win32: drive-prefixed absolute path returns ABSOLUTE_PATH (isAbsolute precedes COLON)",
		() => {
			// `node:path.isAbsolute` is platform-aware: on Win32 it accepts
			// drive-prefixed paths. Returning ABSOLUTE_PATH directs agents
			// at the actionable fix ("pass a vault-relative path") instead
			// of misrouting to the COLON branch's ADS-fix messaging.
			expect(classifyRelpathPolicy("C:/vault/note.md")).toBe("ABSOLUTE_PATH");
		},
	);

	test.skipIf(process.platform === "win32")(
		"POSIX: Windows-syntax drive-prefixed path still returns COLON (isAbsolute is false on POSIX)",
		() => {
			// `node:path.isAbsolute("C:/...")` returns false on POSIX, so
			// the COLON guard catches it — acceptable since a POSIX user
			// typing `C:/...` is in a misconfigured environment regardless.
			expect(classifyRelpathPolicy("C:/vault/note.md")).toBe("COLON");
		},
	);

	test("RESERVED_DEVICE_NAME message advertises COM1-9 / LPT1-9, matching the regex", async () => {
		// Policy at validatePath.ts:82 admits COM0.md / LPT0.md by design
		// (MS doesn't enumerate them); the user-facing hint must agree
		// so an agent's self-correction probe doesn't contradict policy.
		const payload = await expectPathRejection(
			() => validatePath("CON.md", root),
			"PATH_OUTSIDE_VAULT",
			"RESERVED_DEVICE_NAME",
		);
		expect(payload.message).toContain("COM1-9");
		expect(payload.message).toContain("LPT1-9");
		expect(payload.message).not.toContain("COM0-9");
		expect(payload.message).not.toContain("LPT0-9");
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
			const err = await openNoFollow(safe.absolute).catch((e) => e);
			// POSIX: `O_NOFOLLOW` rejects the open with errno ELOOP.
			// Windows: libuv strips `O_NOFOLLOW`, so the pre-open lstat in
			// `openNoFollow` catches the symlink and throws
			// `PathValidationError(reason: SYMLINK_SEGMENT)`. Either shape
			// satisfies the underlying invariant — the swap is refused.
			if (err instanceof PathValidationError) {
				expect(err.payload.code).toBe("PATH_OUTSIDE_VAULT");
				expect(err.payload.reason).toBe("SYMLINK_SEGMENT");
			} else {
				expect(err).toMatchObject({ code: "ELOOP" });
			}
		} finally {
			await isolated.cleanup();
		}
	});

	// Win32 regression: the win32 leaf check keys on symlink-ness, not inode
	// identity — an atomic save (write-temp + rename) gives the file a new
	// inode, and an inode compare would reject that benign in-vault file as
	// a swap. `openNoFollow` must still open it.
	test.runIf(process.platform === "win32")(
		"openNoFollow accepts a file replaced by an atomic save (win32)",
		async () => {
			const isolated = await createTempVault({ "note.md": "# v1\n" });
			try {
				const isolatedRoot = await validateVaultRoot(isolated.path);
				const safe = await validatePath("note.md", isolatedRoot);
				const tmp = `${isolated.path}/note.md.tmp`;
				await writeFile(tmp, "# v2\n");
				await rename(tmp, safe.absolute); // atomic save → new inode
				const fh = await openNoFollow(safe.absolute);
				try {
					expect((await fh.stat()).isFile()).toBe(true);
				} finally {
					await fh.close();
				}
			} finally {
				await isolated.cleanup();
			}
		},
	);
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

describe("ensureIndexDirIsRealDir — startup symlink guard for .markdown-mcp", () => {
	test("ENOENT (fresh vault) returns without throwing", async () => {
		const isolated = await createTempVault({});
		try {
			await ensureIndexDirIsRealDir(`${isolated.path}/.markdown-mcp`);
		} finally {
			await isolated.cleanup();
		}
	});

	test("real directory passes through", async () => {
		const isolated = await createTempVault({ ".markdown-mcp": { "keep.txt": "x" } });
		try {
			await ensureIndexDirIsRealDir(`${isolated.path}/.markdown-mcp`);
		} finally {
			await isolated.cleanup();
		}
	});

	test("symlinked .markdown-mcp rejected with VAULT_ROOT_SYMLINK", async () => {
		const isolated = await createTempVault({});
		const exfil = await createTempVault({});
		try {
			await createSymlink(exfil.path, `${isolated.path}/.markdown-mcp`);
			await expectPathRejection(
				() => ensureIndexDirIsRealDir(`${isolated.path}/.markdown-mcp`),
				"PATH_OUTSIDE_VAULT",
				"VAULT_ROOT_SYMLINK",
			);
		} finally {
			await Promise.all([isolated.cleanup(), exfil.cleanup()]);
		}
	});

	test("regular file at .markdown-mcp rejected with VAULT_ROOT_NOT_DIRECTORY", async () => {
		const isolated = await createTempVault({ ".markdown-mcp": "not a dir" });
		try {
			await expectPathRejection(
				() => ensureIndexDirIsRealDir(`${isolated.path}/.markdown-mcp`),
				"PATH_OUTSIDE_VAULT",
				"VAULT_ROOT_NOT_DIRECTORY",
			);
		} finally {
			await isolated.cleanup();
		}
	});
});

describe("assertIndexFilesAreRegular — leaf-symlink + non-regular guard", () => {
	const dbRel = ".markdown-mcp/index.sqlite3";

	test("ENOENT on all three paths (cold start) returns without throwing", async () => {
		const isolated = await createTempVault({ ".markdown-mcp": {} });
		try {
			await assertIndexFilesAreRegular(`${isolated.path}/${dbRel}`);
		} finally {
			await isolated.cleanup();
		}
	});

	test("regular SQLite file (no sidecars) passes through", async () => {
		const isolated = await createTempVault({ ".markdown-mcp": { "index.sqlite3": "fake" } });
		try {
			await assertIndexFilesAreRegular(`${isolated.path}/${dbRel}`);
		} finally {
			await isolated.cleanup();
		}
	});

	test("symlinked index.sqlite3 rejected with INDEX_FILE_SYMLINK", async () => {
		const isolated = await createTempVault({ ".markdown-mcp": {} });
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
		const isolated = await createTempVault({ ".markdown-mcp": { "index.sqlite3": "fake" } });
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
		const isolated = await createTempVault({ ".markdown-mcp": { "index.sqlite3": "fake" } });
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
		const isolated = await createTempVault({ ".markdown-mcp": { "index.sqlite3": {} } });
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
			".markdown-mcp": { "index.sqlite3": "fake", "index.sqlite3-wal": {} },
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
			".markdown-mcp": { "index.sqlite3": "fake", "index.sqlite3-shm": {} },
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

describe("validatePath — outer guillemet normalization", () => {
	test("strips outer `«…»` and resolves the inner `›`-bearing path", async () => {
		const isolated = await createTempVault({ "foo › bar.md": "# foo\n" });
		try {
			const isolatedRoot = await validateVaultRoot(isolated.path);
			const safe = await validatePath("«foo › bar.md»", isolatedRoot);
			expect(safe.relative).toBe("foo › bar.md");
		} finally {
			await isolated.cleanup();
		}
	});

	test("path NOT bracketed by guillemets is unchanged", async () => {
		const isolated = await createTempVault({ "foo.md": "# foo\n" });
		try {
			const isolatedRoot = await validateVaultRoot(isolated.path);
			const safe = await validatePath("foo.md", isolatedRoot);
			expect(safe.relative).toBe("foo.md");
		} finally {
			await isolated.cleanup();
		}
	});

	test("literal-guillemet file `«foo».md` (ends with `d`, no strip) resolves", async () => {
		const isolated = await createTempVault({ "«foo».md": "# foo\n" });
		try {
			const isolatedRoot = await validateVaultRoot(isolated.path);
			const safe = await validatePath("«foo».md", isolatedRoot);
			expect(safe.relative).toBe("«foo».md");
		} finally {
			await isolated.cleanup();
		}
	});

	test("nested `notes/«inner».md` is unchanged (path doesn't start with `«`)", async () => {
		const isolated = await createTempVault({ "notes/«inner».md": "# inner\n" });
		try {
			const isolatedRoot = await validateVaultRoot(isolated.path);
			const safe = await validatePath("notes/«inner».md", isolatedRoot);
			expect(safe.relative).toBe("notes/«inner».md");
		} finally {
			await isolated.cleanup();
		}
	});

	test("literal-guillemet file `«bar.md»` (no inner ` › `, no strip) resolves", async () => {
		// Strip is gated on inner separator (mirrors renderer trigger);
		// without the gate, a vault file literally named `«bar.md»` is
		// silently rewritten to `bar.md` and the real file is unreachable.
		const isolated = await createTempVault({ "«bar.md»": "# bar\n" });
		try {
			const isolatedRoot = await validateVaultRoot(isolated.path);
			const safe = await validatePath("«bar.md»", isolatedRoot);
			expect(safe.relative).toBe("«bar.md»");
		} finally {
			await isolated.cleanup();
		}
	});

	test("`«»` (empty inner has no ` › `) is unchanged → routes through not-found", async () => {
		await expectPathRejection(() => validatePath("«»", root), "PATH_NOT_FOUND");
	});

	test("`«foo` (open only) is unchanged → routes through normal not-found", async () => {
		await expectPathRejection(() => validatePath("«foo", root), "PATH_NOT_FOUND");
	});

	test("`«foo\\nbar»` (inner has no ` › `, no strip) → CONTROL_CHAR on wrapped path", async () => {
		// The `\n` rejection fires regardless of strip outcome.
		await expectPathRejection(() => validatePath("«foo\nbar»", root), "PATH_OUTSIDE_VAULT", "CONTROL_CHAR");
	});

	test("`«foo\\nbar › baz»` (inner has ` › `, strips first) → CONTROL_CHAR on inner (no bypass)", async () => {
		// Defense-in-depth: even when strip fires, the resulting inner
		// content is re-validated and a control char still rejects.
		await expectPathRejection(() => validatePath("«foo\nbar › baz»", root), "PATH_OUTSIDE_VAULT", "CONTROL_CHAR");
	});

	test("strips outer `«…»` and resolves the inner `,`-bearing path", async () => {
		// `formatFileHeading` wraps on `,` so `formatCandidateList`'s
		// `", "` join can't shred comma-bearing filenames; the inverse
		// here strips when inner contains `,`.
		const isolated = await createTempVault({ "a, b.md": "# a\n" });
		try {
			const isolatedRoot = await validateVaultRoot(isolated.path);
			const safe = await validatePath("«a, b.md»", isolatedRoot);
			expect(safe.relative).toBe("a, b.md");
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
