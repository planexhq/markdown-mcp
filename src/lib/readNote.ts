/**
 * D16 read serializer — one read implementation shared by every direct-read
 * surface (`get_fragment`, `get_file_outline`, `get_metadata`, `get_links`,
 * and the `note://` resource). `readSource` returns the raw decoded source;
 * `readNote` layers `parseFile` above it for callers that need the AST.
 *
 * Centralizing means the security invariants (`O_NOFOLLOW`, file-size cap,
 * encoding detection) have one implementation, one test surface.
 *
 * Order is load-bearing:
 *   1. `openNoFollow` — refuses leaf-symlink swap that occurred between
 *      `validatePath` and the open (THREAT_MODEL V1/V6). Errno from a
 *      TOCTOU swap (ENOENT, ENOTDIR, ELOOP) is converted to the
 *      corresponding `PathValidationError` here — the open errno is a
 *      domain signal, not a server bug.
 *   2. `stat` — checks size against `MAX_FILE_BYTES` BEFORE reading bytes
 *      (so a 100 GB file never gets buffered).
 *   3. UTF-8 decode with `fatal: true` — invalid byte sequences surface
 *      as `MARKDOWN_PARSE_ERROR.reason: "encoding_failed"` rather than
 *      replacement characters that would silently corrupt fragments.
 *   4. `parseFile` (in `readNote` only) — propagates {@link ParseError}
 *      for syntax / AST cap. The `note://` resource skips this step so a
 *      parse-only failure doesn't block the literal source it advertises.
 *
 * Errors are typed: caller catches {@link FileTooLargeError},
 * {@link ParseError}, and {@link PathValidationError} (from the prior
 * validatePath call) to route to the correct domain envelope.
 */

import type { FileHandle } from "node:fs/promises";
import { lstat } from "node:fs/promises";

import type { PathRejectionReason, SafePath } from "../types.js";
import { errorMessage, getErrnoCode, isVanishedErrno, vaultError } from "./error.js";
import { isHiddenPath, isIndexCachePath } from "./hiddenPath.js";
import { MAX_FILE_BYTES } from "./limits.js";
import { type ParsedFile, ParseError, type ParseFileOptions, parseFile } from "./parser.js";
import { openNoFollow, PathValidationError } from "./validatePath.js";
import { isMarkdownPath } from "./vaultExtensions.js";

export interface SourceData {
	source: string;
	/**
	 * Raw on-disk byte count from the read window (post-`stat`, pre-decode).
	 * Surfaced through `get_fragment.file_size_bytes` for agent integrity
	 * checks against `get_vault_tree.size_bytes` / `fs.stat().size`. Distinct
	 * from `Buffer.byteLength(source, "utf8")` because `TextDecoder` strips
	 * the UTF-8 BOM during decode — re-encoding the string under-reports by
	 * 3 bytes on BOM-prefixed files.
	 */
	sizeBytes: number;
}

export interface NoteData extends SourceData {
	parsed: ParsedFile;
}

/**
 * Thrown when a file's size exceeds the per-read cap. Routes to the
 * `FILE_TOO_LARGE` domain envelope (Brief line 770 + CLAUDE.md
 * "Hard-cap routing"). The envelope's `param` is the contract-fixed
 * `"file"`; the offending vault-relative path is carried separately
 * in `relpath` for logging/diagnostics.
 */
export class FileTooLargeError extends Error {
	override readonly name = "FileTooLargeError";
	readonly relpath: string;
	readonly limitBytes: number;
	readonly actualBytes: number;
	constructor(relpath: string, limitBytes: number, actualBytes: number) {
		super(`File exceeds ${limitBytes}-byte read cap (actual: ${actualBytes}).`);
		this.relpath = relpath;
		this.limitBytes = limitBytes;
		this.actualBytes = actualBytes;
	}
}

function assertNotePathString(safePath: SafePath, includeHidden: boolean): void {
	if (!isMarkdownPath(safePath.relative)) {
		throw pathNotFound(`Path is not a markdown note: ${safePath.relative}`);
	}
	// Server's own cache dir is rejected regardless of `--include-hidden`.
	// Mirrors `watcher.ts:shouldIgnore` + `getVaultTree.resolveStartPath` +
	// `search.classifyScope`. Without this, an agent under `--include-hidden`
	// could read markdown placed inside `.markdown-mcp/` via get_fragment etc.
	if (isIndexCachePath(safePath.relative)) {
		throw pathNotFound(`Path is inside the server cache directory: ${safePath.relative}`);
	}
	if (!includeHidden && isHiddenPath(safePath.relative)) {
		// Brief line 928: hidden files are policy-excluded from every direct-read
		// surface by default. `--include-hidden` (CLI in W5) flips this off so
		// dotfiles become addressable through every surface symmetrically.
		throw pathNotFound(`Path is hidden (excluded by default): ${safePath.relative}`);
	}
}

/**
 * Policy gates (extension, hidden, regular-file via `lstat`) for callers
 * that skip the read/parse. The `lstat` gate has a TOCTOU window; callers
 * that subsequently open the file get a stricter post-open `fstat` from
 * `readSource`.
 */
export async function assertNotePathPolicy(safePath: SafePath, includeHidden = false): Promise<void> {
	assertNotePathString(safePath, includeHidden);
	let stat: Awaited<ReturnType<typeof lstat>>;
	try {
		stat = await lstat(safePath.absolute);
	} catch (cause) {
		if (isVanishedErrno(cause)) {
			throw pathNotFound(`Path does not exist: ${safePath.relative}`);
		}
		throw cause;
	}
	if (!stat.isFile()) {
		throw pathNotFound(`Path is not a regular file: ${safePath.relative}`);
	}
}

/**
 * Read the file source (decoded as UTF-8) without parsing. Shared between
 * `readNote` (which then runs the parser) and the `note://` resource handler
 * (which surfaces literal contents).
 *
 * Non-note extensions are rejected before any syscall (saves an open +
 * stat for the common "agent passed a `.txt` asset" case). The
 * non-regular-file check uses `fstat` after the open so a FIFO swap
 * during the validation window still can't bypass it; `O_NONBLOCK` on
 * the open keeps the FIFO from hanging the server.
 */
export async function readSource(safePath: SafePath, includeHidden = false): Promise<SourceData> {
	assertNotePathString(safePath, includeHidden);
	let fh: FileHandle | undefined;
	try {
		try {
			fh = await openNoFollow(safePath.absolute);
		} catch (cause) {
			// Post-validation TOCTOU window (THREAT_MODEL V1/V6): the open
			// errno is a domain signal — file deleted (ENOENT), parent
			// replaced with a regular file (ENOTDIR), or final component
			// became a symlink (ELOOP, caught by O_NOFOLLOW). All three
			// have validatePath analogues; route to the same envelopes
			// instead of leaking as INTERNAL_ERROR.
			if (isVanishedErrno(cause)) {
				throw pathNotFound(`Path does not exist: ${safePath.relative}`);
			}
			const code = getErrnoCode(cause);
			if (code === "ELOOP") {
				throw symlinkSegment(safePath);
			}
			// Win32 libuv strips O_NOFOLLOW and opens directories via backup
			// semantics, so a dir-symlink/junction swap surfaces as either
			// EACCES or EISDIR (OS-version/reparse-type dependent). Post-error
			// lstat disambiguates: symlink → SYMLINK_SEGMENT (preserve rows);
			// non-regular non-symlink → PATH_NOT_FOUND (prune real dir swap);
			// regular → propagate cause (ACL deny / share-lock / race-back).
			if (process.platform === "win32" && (code === "EACCES" || code === "EISDIR")) {
				let postStat: Awaited<ReturnType<typeof lstat>>;
				try {
					postStat = await lstat(safePath.absolute);
				} catch (lstatErr) {
					if (isVanishedErrno(lstatErr)) {
						throw pathNotFound(`Path does not exist: ${safePath.relative}`);
					}
					throw cause;
				}
				if (postStat.isSymbolicLink()) {
					throw symlinkSegment(safePath);
				}
				if (!postStat.isFile()) {
					throw pathNotFound(`Path is not a regular file: ${safePath.relative}`);
				}
				// Regular file post-lstat on Win32 — propagate cause without
				// falling through to the POSIX-only EISDIR check below (that
				// would defeat the row-preservation we just earned via
				// disambiguation).
				throw cause;
			}
			// POSIX EISDIR is unambiguous: open(O_RDONLY) of a regular file
			// cannot return EISDIR per errno semantics — target must be a
			// directory.
			if (code === "EISDIR") {
				throw pathNotFound(`Path is not a regular file: ${safePath.relative}`);
			}
			throw cause;
		}
		const stat = await fh.stat();
		if (!stat.isFile()) {
			throw pathNotFound(`Path is not a regular file: ${safePath.relative}`);
		}
		if (stat.size > MAX_FILE_BYTES) {
			throw new FileTooLargeError(safePath.relative, MAX_FILE_BYTES, stat.size);
		}
		// Bounded read into a `MAX_FILE_BYTES + 1` buffer guards against the
		// stat→read TOCTOU window: a concurrent writer (rsync, log rotation,
		// editor flush) could grow the file between `stat()` and the read, and
		// `fh.readFile()` would happily allocate the larger buffer — bypassing
		// the cap and risking OOM on a pathological grow. Looping is required
		// because POSIX `read` may short-read even when more bytes are available.
		const cap = MAX_FILE_BYTES + 1;
		const buffer = Buffer.allocUnsafe(cap);
		let total = 0;
		while (total < cap) {
			const { bytesRead } = await fh.read(buffer, total, cap - total, total);
			if (bytesRead === 0) break;
			total += bytesRead;
		}
		if (total > MAX_FILE_BYTES) {
			throw new FileTooLargeError(safePath.relative, MAX_FILE_BYTES, total);
		}
		const buf = total === buffer.length ? buffer : buffer.subarray(0, total);
		let source: string;
		try {
			source = new TextDecoder("utf-8", { fatal: true }).decode(buf);
		} catch (cause) {
			throw new ParseError("encoding_failed", `File is not valid UTF-8: ${errorMessage(cause)}`);
		}
		return { source, sizeBytes: total };
	} finally {
		if (fh !== undefined) await fh.close();
	}
}

/**
 * Read and parse the file at `safePath`. The caller must have already
 * run `validatePath`. `safePath.relative` is used as the input to the
 * D27 stable_id hash.
 */
export async function readNote(
	safePath: SafePath,
	options: ParseFileOptions = {},
	includeHidden = false,
): Promise<NoteData> {
	const { source, sizeBytes } = await readSource(safePath, includeHidden);
	const parsed = parseFile(source, safePath.relative, options);
	return { source, parsed, sizeBytes };
}

function pathNotFound(message: string): PathValidationError {
	return new PathValidationError(vaultError("PATH_NOT_FOUND", message, { param: "file" }));
}

function symlinkSegment(safePath: SafePath): PathValidationError {
	return new PathValidationError(
		vaultError("PATH_OUTSIDE_VAULT", `Path leaf became a symlink: ${safePath.relative}`, {
			param: "file",
			reason: "SYMLINK_SEGMENT" satisfies PathRejectionReason,
		}),
	);
}
