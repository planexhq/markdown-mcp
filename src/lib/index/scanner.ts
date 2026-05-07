/**
 * Vault scanner — walks the tree, parses each note via `readNote`
 * (so `O_NOFOLLOW` + size cap apply uniformly), derives row inputs per
 * D31 emit-rules, and commits via `IndexHandle.replaceFile` with
 * bounded concurrency (default 4). Symlinks + hidden paths +
 * non-markdown files are skipped.
 *
 * D31 emit-rules: `headings.length > 0` → one heading row per heading
 * plus an optional preamble row (only if non-whitespace); else a
 * single `file` row covering the post-frontmatter body. `preamble`
 * and `file` rows are mutually exclusive per file.
 *
 * `AbortSignal` cooperatively halts the walk; in-flight per-file
 * commits finish atomically so the DB is never half-written.
 */

import { readdir, stat } from "node:fs/promises";
import { extname, join } from "node:path";
import type { SafePath } from "../../types.js";
import { isWhitespaceRange } from "../blockIds.js";
import { errorMessage, getErrnoCode } from "../error.js";
import { ISO_LIKELY_RE, isCalendarDate, parseIsoDatetimeToCanonical, toCanonicalUtcIso } from "../filter.js";
import { isHiddenPath } from "../hiddenPath.js";
import { type ParsedFile, ParseError } from "../parser.js";
import { readNote } from "../readNote.js";
import { classifyRelpathPolicy, PathValidationError, type VaultRoot, validatePath } from "../validatePath.js";
import { isMarkdownPath } from "../vaultExtensions.js";
import type { FragmentRowInput, FrontmatterInput, IndexHandle } from "./IndexHandle.js";

export interface ScanProgress {
	files_indexed: number;
	files_total_estimate: number;
	phase: "scanning" | "parsing" | "fts_populating";
}

export interface ScanArgs {
	vaultRoot: VaultRoot;
	index: IndexHandle;
	signal?: AbortSignal;
	concurrency?: number;
	onProgress?: (p: ScanProgress) => void;
}

export interface ScanResult {
	filesIndexed: number;
	filesSkipped: number;
	aborted: boolean;
}

export async function scanVault(args: ScanArgs): Promise<ScanResult> {
	const { vaultRoot, index, signal, concurrency = 4, onProgress } = args;

	if (signal?.aborted) {
		return { filesIndexed: 0, filesSkipped: 0, aborted: true };
	}

	// Round-7 state machine: cold → warming → warm (fresh scan), or
	// warm → reconciling → warm (re-scan of existing DB). `reconciling`
	// is purely diagnostic — reads continue serving the prior snapshot
	// while this walk runs.
	const startingState = index.getStatus().state;
	// Capture BEFORE flipping `scan_complete = false`: an interrupted
	// prior scan must re-index every file (the index may be missing
	// entries that no per-file diff would catch).
	const wasComplete = index.getScanComplete();
	index.setScanComplete(false);
	index.setStatus(startingState === "warm" ? "reconciling" : "warming");

	// Phase 1: enumerate files. Plan calls this `scanning` in the
	// progress envelope.
	onProgress?.({ files_indexed: 0, files_total_estimate: 0, phase: "scanning" });
	const files: string[] = [];
	// Subtrees whose `readdir` failed with a non-deletion errno (EACCES,
	// EMFILE, EIO, …). Files under these prefixes are preserved by the
	// prune pass and the scan refuses to flip `scan_complete = true`, so
	// the next startup retries enumeration.
	const failedSubtrees = new Set<string>();
	for await (const file of walkVault(vaultRoot.absolute, "", failedSubtrees, signal)) {
		files.push(file);
		if (files.length % 100 === 0) {
			onProgress?.({
				files_indexed: 0,
				files_total_estimate: files.length,
				phase: "scanning",
			});
		}
		if (signal?.aborted) return { filesIndexed: 0, filesSkipped: 0, aborted: true };
	}

	// Phase 2 + 3: parse + write. Bounded concurrency.
	let indexed = 0;
	let skipped = 0;
	// `skipped` conflates failures with vanished + mtime-skip outcomes,
	// so the end-of-scan gate can't reuse it. `failedFiles` increments
	// only on parse_failed + worker-catch (the two preserve-and-retry
	// paths) so a single EACCES/EMFILE/parse-broken file blocks the
	// `scan_complete=true` flip the same way a `failedSubtrees` entry
	// already does at the directory level.
	let failedFiles = 0;
	let cursor = 0;
	const total = files.length;
	// `walkVault` snapshot can include files that get deleted before
	// `indexOne`'s stat lands. Building the prune set from confirmed-
	// on-disk relpaths (indexed OR parse_failed) prevents the prune
	// pass from treating a vanished file as still-on-disk → leaving
	// stale rows until the next full scan.
	const stillOnDisk: string[] = [];

	async function worker(): Promise<void> {
		while (cursor < total) {
			if (signal?.aborted) return;
			const idx = cursor++;
			const relpath = files[idx];
			if (relpath === undefined) continue;
			try {
				const outcome = await indexOne(vaultRoot, index, relpath, wasComplete);
				if (outcome === "indexed") {
					indexed++;
					stillOnDisk.push(relpath);
				} else if (outcome === "parse_failed") {
					skipped++;
					failedFiles++;
					stillOnDisk.push(relpath);
				} else {
					skipped++;
				}
			} catch (err) {
				skipped++;
				failedFiles++;
				// `indexOne` returns "vanished" only for ENOENT/ENOTDIR, so
				// anything reaching this catch is a file on disk that couldn't
				// be indexed this pass. Route the same as `parse_failed` so
				// the prune pass doesn't drop valid rows.
				stillOnDisk.push(relpath);
				console.error(`vault-mcp scanner: failed to index ${relpath}: ${errorMessage(err)}`);
			}
			if (indexed % 50 === 0) {
				onProgress?.({
					files_indexed: indexed,
					files_total_estimate: total,
					phase: "parsing",
				});
			}
		}
	}

	const pool = Array.from({ length: Math.max(1, concurrency) }, () => worker());
	await Promise.all(pool);

	const aborted = signal?.aborted ?? false;
	if (!aborted) {
		// Prune files that are in the index but no longer on disk. Done
		// before `setScanComplete(true)` so a crash mid-prune leaves the
		// flag false and the next startup re-runs the diff.
		pruneVanishedFiles(index, stillOnDisk, failedSubtrees);
		// State + scan_complete depend on whether enumeration was clean:
		//   - clean (no failed subtrees AND no failed files) → flip both
		//     to ready (`scan_complete=true`, `state=warm`).
		//   - any failure (failed subtree OR failed file), was warm →
		//     reconcile didn't fully refresh, but the prior snapshot in
		//     `fragments` is consistent for vault-wide reads. Leave
		//     `state=warm`; `scan_complete=false` so the next startup
		//     retries.
		//   - any failure, was cold/warming → no prior snapshot to fall
		//     back on. Stay `warming` so vault-wide tools return INDEX_WARMING
		//     instead of serving a silently partial index. Bounded reads
		//     (outline/fragment/metadata) parse on demand.
		if (failedSubtrees.size === 0 && failedFiles === 0) {
			index.setScanComplete(true);
			// One-way latch: from this point on, the persisted index always
			// represents at least one usable snapshot, so a future restart
			// after a partial reconcile can safely stay `warm`.
			index.markEverComplete();
			index.setStatus("warm");
		} else if (startingState === "warm") {
			index.setStatus("warm");
		} else {
			index.setStatus("warming");
		}
		onProgress?.({
			files_indexed: indexed,
			files_total_estimate: total,
			phase: "fts_populating",
		});
	}
	return { filesIndexed: indexed, filesSkipped: skipped, aborted };
}

function pruneVanishedFiles(
	index: IndexHandle,
	onDiskFiles: ReadonlyArray<string>,
	failedSubtrees: ReadonlySet<string>,
): void {
	const onDisk = new Set(onDiskFiles);
	const retiredAt = Date.now();
	for (const file of index.listIndexedFiles()) {
		if (onDisk.has(file)) continue;
		if (isUnderFailedSubtree(file, failedSubtrees)) continue;
		index.removeFile(file, retiredAt);
	}
}

function isUnderFailedSubtree(file: string, failedSubtrees: ReadonlySet<string>): boolean {
	if (failedSubtrees.size === 0) return false;
	if (failedSubtrees.has("")) return true; // vault root readdir failed
	for (const prefix of failedSubtrees) {
		if (file === prefix || file.startsWith(`${prefix}/`)) return true;
	}
	return false;
}

/**
 * `failedSubtrees` is an OUT param: subtrees whose `readdir` raised a
 * non-deletion errno are added to it (the empty string represents the
 * vault root). The caller threads this Set into the prune pass to skip
 * removals for files under unenumerated prefixes.
 */
async function* walkVault(
	root: string,
	relParent: string,
	failedSubtrees: Set<string>,
	signal?: AbortSignal,
): AsyncGenerator<string> {
	if (signal?.aborted) return;
	const dirAbs = relParent ? join(root, relParent) : root;
	let entries: import("node:fs").Dirent[];
	try {
		// `encoding: "utf8"` pins the Dirent generic so `entry.name` is
		// `string` (default in Node 22 type defs is the buffer-flavored
		// `Dirent<NonSharedBuffer>` whose `name` is a Buffer).
		entries = (await readdir(dirAbs, { withFileTypes: true, encoding: "utf8" })) as import("node:fs").Dirent[];
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		// ENOENT/ENOTDIR: directory genuinely vanished mid-scan. Existing
		// rows under this prefix should be pruned — file is gone.
		if (code === "ENOENT" || code === "ENOTDIR") return;
		// Other errno (EACCES, EMFILE, EIO, …): we can't enumerate, but
		// files may still exist. Track the prefix so the prune pass leaves
		// its rows alone and `scan_complete` stays false.
		console.error(
			`vault-mcp scanner: skipping subtree ${relParent || "(vault root)"} (readdir error: ${code ?? "unknown"})`,
		);
		failedSubtrees.add(relParent);
		return;
	}
	entries.sort((a, b) => a.name.localeCompare(b.name));
	for (const entry of entries) {
		if (signal?.aborted) return;
		const name = entry.name;
		const childRel = relParent ? `${relParent}/${name}` : name;
		if (isHiddenPath(childRel)) continue;
		if (entry.isSymbolicLink()) continue;
		if (entry.isDirectory()) {
			yield* walkVault(root, childRel, failedSubtrees, signal);
			continue;
		}
		if (!entry.isFile()) continue;
		if (!isMarkdownPath(childRel)) continue;
		// Cheap path-policy gate (length / %xx / backslash / depth).
		// Files violating these would be rejected by `validatePath`
		// from the tool surface — indexing them anyway would expose
		// non-addressable rows through `search`. Same policy as
		// `validatePath`'s sync portion; lstat-walk stays in
		// `validatePath` only.
		const policyRejection = classifyRelpathPolicy(childRel);
		if (policyRejection !== null) {
			console.error(`vault-mcp scanner: skipping ${childRel} (path policy: ${policyRejection})`);
			continue;
		}
		// On byte-exact filesystems (Linux ext4/xfs/btrfs), an NFD on-disk
		// name is a different byte sequence from its NFC form.
		// `validatePath` NFC-normalizes incoming agent paths before lstat,
		// so the indexed NFD relpath would surface in search but fail
		// every direct-read tool with `PATH_NOT_FOUND`. macOS APFS lookups
		// are normalization-insensitive so this is preventative there.
		if (childRel.normalize("NFC") !== childRel) {
			console.error(`vault-mcp scanner: skipping ${childRel} (non-NFC name; rename to NFC for tool addressability)`);
			continue;
		}
		yield childRel;
	}
}

/**
 * Three-state outcome of indexing one file:
 *   - `indexed`: parsed + replaced in DB. File is on disk.
 *   - `parse_failed`: file is on disk but unparseable; existing index
 *     entries are preserved (a transient YAML typo doesn't nuke search
 *     results for the file).
 *   - `vanished`: stat failed → file was deleted between `walkVault`
 *     and this call. Caller MUST exclude it from the prune set so the
 *     stale rows actually get removed this scan.
 */
type IndexOutcome = "indexed" | "parse_failed" | "vanished";

type SkipStage = "stat" | "validate" | "parse";

function logSkipped(relpath: string, stage: SkipStage, detail: string): void {
	console.error(`vault-mcp scanner: skipping ${relpath} (${stage}: ${detail})`);
}

/**
 * Map a `PathValidationError` to its scanner outcome.
 * `PATH_NOT_FOUND` = file vanished post-walkVault (lstat ENOENT/ENOTDIR
 * via `validatePath` segment walk, or `readNote` open() ENOENT/ENOTDIR
 * converted to the same code). Other reasons (SYMLINK_SEGMENT,
 * OUTSIDE_VAULT, STAT_FAILED, REALPATH_FAILED) preserve rows so a
 * transient swap doesn't nuke valid content from the previous clean
 * scan.
 */
function classifyPathValidationError(err: PathValidationError, relpath: string): IndexOutcome {
	if (err.payload.code === "PATH_NOT_FOUND") return "vanished";
	logSkipped(relpath, "validate", `${err.payload.code}/${err.payload.reason ?? "unspecified"}`);
	return "parse_failed";
}

async function indexOne(
	vaultRoot: VaultRoot,
	index: IndexHandle,
	relpath: string,
	skipUnchanged: boolean,
): Promise<IndexOutcome> {
	// validatePath runs BEFORE stat so the warm-reconcile fast path can't
	// bypass the segment-walk symlink check. A parent-dir-to-symlink swap
	// between walkVault's readdir and now would otherwise let `stat()`
	// (which follows symlinks) reach the target through the symlink — if
	// its mtime/size happens to match cached values, the fast path would
	// silently keep search rows for a path direct-read tools now reject.
	// Cost: ~depth-many lstats per scanned file on warm reconcile
	// (background-only, doesn't block reads).
	let safePath: SafePath;
	try {
		safePath = await validatePath(relpath, vaultRoot);
	} catch (err) {
		if (err instanceof PathValidationError) return classifyPathValidationError(err, relpath);
		throw err;
	}

	let mtime: number;
	let size: number;
	try {
		const st = await stat(safePath.absolute);
		// Preserve sub-ms precision: APFS/ext4 carry fractional mtimeMs that
		// `Math.floor` would collapse, letting two saves within the same
		// integer ms compare equal in `isFileUnchanged` and silently retain
		// stale fragments through the warm-restart skip.
		mtime = st.mtimeMs;
		size = st.size;
	} catch (err) {
		const code = getErrnoCode(err);
		// Only ENOENT/ENOTDIR mean "this file vanished, prune its rows."
		// Other errno (EACCES, EBUSY, EMFILE, …) → log + preserve existing
		// rows by routing through `parse_failed` (adds to stillOnDisk and
		// counts as skipped). Next scan retries.
		if (code === "ENOENT" || code === "ENOTDIR") return "vanished";
		logSkipped(relpath, "stat", code ?? "unknown");
		return "parse_failed";
	}
	if (skipUnchanged && index.isFileUnchanged({ file: relpath, mtime, size })) {
		return "indexed";
	}

	let parsed: ParsedFile;
	try {
		const note = await readNote(safePath);
		parsed = note.parsed;
	} catch (err) {
		// Per-file parse failure: log + skip; aborting the whole scan
		// because one file is malformed would block index warming.
		if (err instanceof ParseError) {
			logSkipped(relpath, "parse", err.reason);
			return "parse_failed";
		}
		// `readNote` converts open() ENOENT/ENOTDIR to PathValidationError
		// with code PATH_NOT_FOUND — same disappearance class as the
		// validatePath catch above. ELOOP becomes PATH_OUTSIDE_VAULT
		// (leaf-symlink swap) and stays parse_failed.
		if (err instanceof PathValidationError) return classifyPathValidationError(err, relpath);
		throw err;
	}

	const fragments = buildFragmentRows(parsed);
	const frontmatter = buildFrontmatterInput(parsed);
	index.replaceFile({ file: relpath, mtime, size, fragments, frontmatter });
	return "indexed";
}

function buildFragmentRows(parsed: ParsedFile): FragmentRowInput[] {
	const rows: FragmentRowInput[] = [];
	const stem = fileStem(parsed.relpath);

	if (parsed.headings.length === 0) {
		// Per D31: emit exactly one `file` row even for frontmatter-only
		// notes (empty/whitespace body). Without this, filter-only search
		// by tag/date can't surface metadata-only notes.
		const start = parsed.frontmatterEndOffset;
		const end = parsed.source.length;
		const { body, code } = extractFtsTexts(parsed, start, end);
		rows.push({
			anchor_kind: "file",
			stable_id: null,
			heading_path_json: null,
			heading_text: null,
			structural_path: null,
			range_start: start,
			range_end: end,
			body,
			code,
			headings: stem,
		});
		return rows;
	}

	for (const h of parsed.headings) {
		const ancestors = h.headingPath.join(" ");
		// `range_start`/`range_end` stay full-section so `get_fragment.content`
		// keeps returning the whole section (Brief: fragment = full section).
		// `body`/`code` index ONLY the immediate body (heading-line-end →
		// first-child-heading-start). Without this, a term that appears only
		// under a child heading would inflate every ancestor's BM25 score —
		// ancestor context flows via the `headings` column's ancestor chain,
		// not via body pollution.
		const { body, code } = extractFtsTexts(parsed, h.bodyOffsetRange.start, h.bodyOffsetRange.end);
		rows.push({
			anchor_kind: "heading",
			stable_id: h.stable_id,
			heading_path_json: JSON.stringify(h.headingPath),
			heading_text: h.pathText,
			structural_path: h.structuralPath,
			range_start: h.offsetRange.start,
			range_end: h.offsetRange.end,
			body,
			code,
			headings: ancestors,
		});
	}

	if (parsed.preamble) {
		const start = parsed.preamble.offsetRange.start;
		const end = parsed.preamble.offsetRange.end;
		// Gate the full source range (including code) so a code-only preamble
		// still emits with an empty `body` and a populated `code` column —
		// FTS hits then flow through the code column.
		if (!isWhitespaceRange(parsed.source, start, end)) {
			const { body, code } = extractFtsTexts(parsed, start, end);
			rows.push({
				anchor_kind: "preamble",
				stable_id: null,
				heading_path_json: null,
				heading_text: null,
				structural_path: null,
				range_start: start,
				range_end: end,
				body,
				code,
				headings: stem,
			});
		}
	}
	return rows;
}

function buildFrontmatterInput(parsed: ParsedFile): FrontmatterInput {
	const fm = parsed.frontmatter ?? {};
	const created = normalizeDateValue(fm.created);
	const updated = normalizeDateValue(fm.updated);
	const fieldsJson = serializeFields(fm);
	const tags = extractTags(fm);
	return { created, updated, fields_json: fieldsJson, tags };
}

function serializeFields(fm: Record<string, unknown>): string {
	// Brief line 593: invalid date strings are stored as raw text so
	// `fields["..."].eq` can lex-match. The reserved `date` filter chain
	// skips non-canonical values via the GLOB shape-check on
	// `RESERVED_DATE_EXPR` (filter.ts).
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(fm)) {
		out[k] = normalizeNestedDates(v);
	}
	try {
		return JSON.stringify(out) ?? "{}";
	} catch {
		return "{}";
	}
}

/**
 * Walk a frontmatter value, canonicalizing any ISO-shaped string or Date
 * to UTC ISO. Recursive so nested dotted-path fields (D30 Note 3a, e.g.,
 * `fields["meta.published"]`) pick up the same canonicalization.
 *
 * Null-on-invalid stays scoped to top-level reserved keys: a nested
 * `meta.created` isn't part of the reserved COALESCE chain, so leaving
 * its raw text is fine — losing it would surprise users who rely on
 * scalar `eq` against literal text.
 */
function normalizeNestedDates(v: unknown): unknown {
	if (v instanceof Date) return normalizeDateValue(v) ?? v;
	if (typeof v === "string") {
		const trimmed = v.trim();
		if (ISO_LIKELY_RE.test(trimmed)) {
			return normalizeDateValue(trimmed) ?? v;
		}
		return v;
	}
	if (Array.isArray(v)) return v.map(normalizeNestedDates);
	if (v !== null && typeof v === "object") {
		const out: Record<string, unknown> = {};
		for (const [k, child] of Object.entries(v as Record<string, unknown>)) {
			out[k] = normalizeNestedDates(child);
		}
		return out;
	}
	return v;
}

function extractTags(fm: Record<string, unknown>): string[] {
	return uniqueLowercase([...readTagSource(fm.tags), ...readTagSource(fm.tag)]);
}

function readTagSource(raw: unknown): string[] {
	if (typeof raw === "string") return splitTagString(raw);
	if (Array.isArray(raw)) {
		const out: string[] = [];
		for (const v of raw) {
			if (typeof v === "string") out.push(...splitTagString(v));
		}
		return out;
	}
	return [];
}

function splitTagString(s: string): string[] {
	// YAML `tags: api auth` (space-separated single string) is a common
	// mistake; tolerate it. A single hash-prefix-stripped token is the
	// 1-row case.
	return s
		.split(/[\s,]+/)
		.map(normalizeTagToken)
		.filter((t): t is string => t !== null);
}

function normalizeTagToken(t: string): string | null {
	const stripped = t.replace(/^#+/, "").trim();
	if (stripped.length === 0) return null;
	if (!/^[a-zA-Z0-9_/-]+$/.test(stripped)) return null;
	return stripped.toLowerCase();
}

function uniqueLowercase(arr: string[]): string[] {
	return Array.from(new Set(arr.map((s) => s.toLowerCase())));
}

function normalizeDateValue(value: unknown): string | null {
	if (value === null || value === undefined) return null;
	if (value instanceof Date) {
		if (Number.isNaN(value.getTime())) return null;
		return toCanonicalUtcIso(value);
	}
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	if (trimmed.length === 0) return null;
	if (isCalendarDate(trimmed)) return `${trimmed}T00:00:00Z`;
	return parseIsoDatetimeToCanonical(trimmed);
}

function fileStem(relpath: string): string {
	const segments = relpath.split("/");
	const base = segments[segments.length - 1] ?? relpath;
	const ext = extname(base);
	return ext.length > 0 ? base.slice(0, -ext.length) : base;
}

/**
 * Single pass over `parsed.excludedRanges` (code/inlineCode/math/inlineMath)
 * producing both FTS column strings for `[start, end)`: prose `body` (code
 * spans elided) and code-only text (newline-separated).
 *
 * Eliding code from `body` honors D18's `bm25(_, 2.0, 0.5, 3.0)` code
 * downweight — if a code-only term were indexed in `body` too, the 2.0
 * body weight would stack on top of 0.5 code and defeat the downweight.
 *
 * `excludedRanges` is sorted by `offsetStart`; binary-search the first
 * range whose `offsetEnd > start` so files with many code spans stay
 * O(headings × log ranges) instead of O(headings × ranges).
 */
function extractFtsTexts(parsed: ParsedFile, start: number, end: number): { body: string; code: string } {
	const ranges = parsed.excludedRanges;
	if (ranges.length === 0) return { body: parsed.source.slice(start, end), code: "" };
	let lo = 0;
	let hi = ranges.length;
	while (lo < hi) {
		const mid = (lo + hi) >>> 1;
		const r = ranges[mid];
		if (r === undefined || r.offsetEnd <= start) lo = mid + 1;
		else hi = mid;
	}
	let cursor = start;
	let body = "";
	let code = "";
	for (let i = lo; i < ranges.length; i++) {
		const range = ranges[i];
		if (range === undefined) continue;
		if (range.offsetStart >= end) break;
		const codeStart = Math.max(range.offsetStart, start);
		const codeEnd = Math.min(range.offsetEnd, end);
		if (codeEnd <= codeStart) continue;
		if (cursor < codeStart) body += parsed.source.slice(cursor, codeStart);
		code += `${parsed.source.slice(codeStart, codeEnd)}\n`;
		cursor = Math.max(cursor, codeEnd);
	}
	if (cursor < end) body += parsed.source.slice(cursor, end);
	return { body, code };
}
