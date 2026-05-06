/**
 * Single read+parse serializer per D16 — shared by `get_fragment` (W2)
 * and the W5 `note://{path}` resource. Centralizing here means the
 * security invariants (`O_NOFOLLOW`, file-size cap, encoding detection)
 * have one implementation, one test surface.
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
 *   4. `parseFile` — propagates {@link ParseError} for syntax / AST cap.
 *
 * Errors are typed: caller catches {@link FileTooLargeError},
 * {@link ParseError}, and {@link PathValidationError} (from the prior
 * validatePath call) to route to the correct domain envelope.
 */

import type { FileHandle } from "node:fs/promises";

import type { PathRejectionReason, SafePath } from "../types.js";
import { errorMessage, vaultError } from "./error.js";
import { isHiddenPath } from "./hiddenPath.js";
import { MAX_FILE_BYTES } from "./limits.js";
import { type ParsedFile, ParseError, type ParseFileOptions, parseFile } from "./parser.js";
import { openNoFollow, PathValidationError } from "./validatePath.js";
import { isMarkdownPath } from "./vaultExtensions.js";

export interface NoteData {
	source: string;
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

/**
 * Read and parse the file at `safePath`. The caller must have already
 * run `validatePath`. `safePath.relative` is used as the input to the
 * D27 stable_id hash.
 *
 * Non-note extensions are rejected before any syscall (saves an open +
 * stat for the common "agent passed a `.txt` asset" case). The
 * non-regular-file check uses `fstat` after the open so a FIFO swap
 * during the validation window still can't bypass it; `O_NONBLOCK` on
 * the open keeps the FIFO from hanging the server.
 */
export async function readNote(safePath: SafePath, options: ParseFileOptions = {}): Promise<NoteData> {
	if (!isMarkdownPath(safePath.relative)) {
		throw pathNotFound(`Path is not a markdown note: ${safePath.relative}`);
	}
	if (isHiddenPath(safePath.relative)) {
		// Brief line 928: hidden files are policy-excluded from every direct-read
		// surface by default. Code is `PATH_NOT_FOUND` (Brief line 361 verbatim),
		// not `PATH_OUTSIDE_VAULT`, since the file exists on disk and the rejection
		// is policy, not a security boundary. `--include-hidden` will gate this
		// predicate at the call site (W5).
		throw pathNotFound(`Path is hidden (excluded by default): ${safePath.relative}`);
	}
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
			if (isFsErrorCode(cause, "ENOENT") || isFsErrorCode(cause, "ENOTDIR")) {
				throw pathNotFound(`Path does not exist: ${safePath.relative}`);
			}
			if (isFsErrorCode(cause, "ELOOP")) {
				throw new PathValidationError(
					vaultError("PATH_OUTSIDE_VAULT", `Path leaf became a symlink: ${safePath.relative}`, {
						param: "file",
						reason: "SYMLINK_SEGMENT" satisfies PathRejectionReason,
					}),
				);
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
		const parsed = parseFile(source, safePath.relative, options);
		return { source, parsed };
	} finally {
		if (fh !== undefined) await fh.close();
	}
}

function isFsErrorCode(err: unknown, code: string): boolean {
	return typeof err === "object" && err !== null && "code" in err && (err as { code: unknown }).code === code;
}

function pathNotFound(message: string): PathValidationError {
	return new PathValidationError(vaultError("PATH_NOT_FOUND", message, { param: "file" }));
}
