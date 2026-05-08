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

import { lstat, readdir, stat } from "node:fs/promises";
import { extname, join } from "node:path";
import type { AnchorKind, ContentKind, SafePath } from "../../types.js";
import { isWhitespaceRange } from "../blockIds.js";
import { errorMessage, getErrnoCode, isVanishedErrno } from "../error.js";
import { isUnderFailedSubtree } from "../failedSubtrees.js";
import { ISO_LIKELY_RE, isCalendarDate, parseIsoDatetimeToCanonical, toCanonicalUtcIso } from "../filter.js";
import { isHiddenName, isNonNfc } from "../hiddenPath.js";
import { type ParsedFile, ParseError } from "../parser.js";
import { readNote } from "../readNote.js";
import { estimateTokens } from "../tokenizer.js";
import { classifyRelpathPolicy, PathValidationError, type VaultRoot, validatePath } from "../validatePath.js";
import { isMarkdownPath } from "../vaultExtensions.js";
import { extractWikilinks } from "../wikilinks.js";
import { WriteCoordinator } from "../writeCoordinator.js";
import type {
	FileMetricsInput,
	FragmentRowInput,
	FrontmatterInput,
	IndexHandle,
	WikilinkRowInput,
} from "./IndexHandle.js";

export interface ScanProgress {
	files_indexed: number;
	files_total_estimate: number;
	phase: "scanning" | "parsing" | "fts_populating";
}

export interface ScanArgs {
	vaultRoot: VaultRoot;
	index: IndexHandle;
	/**
	 * Per-file FIFO so scanner's `replaceFile` writes serialize against
	 * any concurrent watcher / merkle event for the same file. Each task
	 * does its own stat at task-start, so the LAST writer wins. Optional
	 * for tests in single-writer scenarios; production wires the shared
	 * coordinator from `index.ts`.
	 */
	coordinator?: WriteCoordinator;
	signal?: AbortSignal;
	concurrency?: number;
	onProgress?: (p: ScanProgress) => void;
	/**
	 * Awaited between the pendingRetries drain and the sync
	 * `markScanFinalized` check. Caller drains in-flight watcher tasks
	 * here so their late `addPendingRetry` calls participate in the
	 * post-callback `hasPendingRetries()` re-check. See CLAUDE.md
	 * "Scanner finalize race" gotcha.
	 */
	preFinalize?: () => Promise<void>;
}

export interface ScanResult {
	filesIndexed: number;
	filesSkipped: number;
	aborted: boolean;
}

export async function scanVault(args: ScanArgs): Promise<ScanResult> {
	const { vaultRoot, index, signal, concurrency = 4, onProgress } = args;
	// Default-construct so the worker can use the same code path
	// regardless of whether the caller supplied a shared coordinator.
	// A scanner-only coordinator is harmless: relpaths are unique per
	// scan, so its per-file FIFO is effectively pass-through.
	const coordinator = args.coordinator ?? new WriteCoordinator();

	if (signal?.aborted) {
		return { filesIndexed: 0, filesSkipped: 0, aborted: true };
	}

	// State machine: cold → warming → warm (fresh scan), or
	// warm → reconciling → warm (re-scan of existing DB). `reconciling`
	// is purely diagnostic — reads continue serving the prior snapshot
	// while this walk runs.
	//
	// Capture `scan_complete` BEFORE the flip below; the captured value
	// gates `skipUnchanged` in the worker so an interrupted prior scan
	// reindexes every file (not just drifted ones) on the next pass.
	const priorScanComplete = index.getScanComplete();
	const startingState = index.getStatus().state;
	index.setScanComplete(false);
	index.setStatus(startingState === "warm" ? "reconciling" : "warming");
	index.setScanInProgress(true);
	// Reset the failed-subtrees gate for this scan. End-of-scan resets
	// to the local `failedSubtrees.size > 0` value via the finally block.
	index.setFailedSubtreesPresent(false);

	// Subtrees whose `readdir` failed with a non-deletion errno (EACCES,
	// EMFILE, EIO, …). Files under these prefixes are preserved by the
	// prune pass and the scan refuses to flip `scan_complete = true`, so
	// the next startup retries enumeration.
	const failedSubtrees = new Set<string>();
	let indexed = 0;
	let skipped = 0;
	let aborted = false;
	// Set true only when the walk + prune + lstat sweep all completed;
	// drives `setScanIncomplete` in finally so a post-abort watcher
	// recovery can't finalize on a partial index.
	let scanReachedEndCheck = false;
	try {
		// Phase 1: enumerate files. Plan calls this `scanning` in the
		// progress envelope.
		onProgress?.({ files_indexed: 0, files_total_estimate: 0, phase: "scanning" });
		const files: string[] = [];
		for await (const file of walkVault(vaultRoot.absolute, "", failedSubtrees, signal)) {
			files.push(file);
			if (files.length % 100 === 0) {
				onProgress?.({
					files_indexed: 0,
					files_total_estimate: files.length,
					phase: "scanning",
				});
			}
			if (signal?.aborted) {
				aborted = true;
				break;
			}
		}
		if (aborted) {
			return { filesIndexed: 0, filesSkipped: 0, aborted: true };
		}

		// Phase 2 + 3: parse + write. Bounded concurrency.
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
					// Route through coordinator so the later task's stat wins —
					// a watcher event for the same file mid-scan can't roll
					// back a fresh commit. `skipUnchanged=priorScanComplete`
					// (captured before the flip — see top of `scanVault`).
					const outcome = await coordinator.enqueue(relpath, () =>
						indexOne(vaultRoot, index, relpath, priorScanComplete),
					);
					if (outcome === "indexed") {
						indexed++;
						stillOnDisk.push(relpath);
						// A stale pending retry from a prior watcher attempt for
						// this same file would otherwise gate finalize at warming
						// forever — merkle won't re-attempt unchanged files. The
						// scanInProgress gate keeps the delete from triggering
						// markScanFinalized prematurely.
						index.clearPendingRetry(relpath);
					} else if (outcome === "parse_failed") {
						skipped++;
						index.addPendingRetry(relpath);
						stillOnDisk.push(relpath);
					} else {
						skipped++;
						index.clearPendingRetry(relpath);
					}
				} catch (err) {
					skipped++;
					index.addPendingRetry(relpath);
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

		aborted = signal?.aborted ?? false;
		if (!aborted) {
			// Prune files that are in the index but no longer on disk. Done
			// before `setScanComplete(true)` so a crash mid-prune leaves the
			// flag false and the next startup re-runs the diff.
			await pruneVanishedFiles(index, stillOnDisk, failedSubtrees, vaultRoot, coordinator);
			// Cover unlink events chokidar dropped. `clearPendingRetry` is
			// gated by `scanInProgress=true` so it only removes entries; the
			// end-of-scan if-check below is what finalizes.
			if (index.hasPendingRetries()) {
				// Vanished pendingRetries: prune orphan rows that
				// `pruneVanishedFiles` skipped (parse_failed kept them in
				// `stillOnDisk`). pendingRetries are known-on-disk at
				// parse time, so we only need vanish-confirmation —
				// `confirmPrune`'s policy re-check would prune transient
				// SYMLINK_SEGMENT swaps the scanner deliberately tolerates.
				// Re-stat inside the coordinator slot dodges the
				// watcher-recreate race.
				const pendingSnapshot = index.pendingRetriesSnapshot();
				for (let i = 0; i < pendingSnapshot.length; i += PRUNE_STAT_BATCH) {
					const batch = pendingSnapshot.slice(i, i + PRUNE_STAT_BATCH);
					const vanished = (
						await Promise.all(batch.map(async (rel) => ((await lstatVanished(rel, vaultRoot)) ? rel : null)))
					).filter((r): r is string => r !== null);
					await Promise.all(
						vanished.map((rel) =>
							coordinator.enqueue(rel, async () => {
								if (!(await lstatVanished(rel, vaultRoot))) return;
								index.removeFile(rel, Date.now());
								index.clearPendingRetry(rel);
							}),
						),
					);
				}
			}
			if (args.preFinalize !== undefined) {
				await args.preFinalize();
			}
			// Clean → finalize. Warm restart with failures keeps
			// `state=warm` (prior snapshot still serves); cold/warming
			// start with failures stays `warming`. The
			// `hasPendingRetries` check below is sync through
			// `markScanFinalized` so a microtask-queued addPendingRetry
			// can't slip in between the check and the flip.
			scanReachedEndCheck = true;
			if (failedSubtrees.size === 0 && !index.hasPendingRetries()) {
				index.markScanFinalized();
			} else {
				index.setStatus(startingState === "warm" ? "warm" : "warming");
			}
			onProgress?.({
				files_indexed: indexed,
				files_total_estimate: total,
				phase: "fts_populating",
			});
		}
		return { filesIndexed: indexed, filesSkipped: skipped, aborted };
	} finally {
		// Reflect this scan's failed-subtree state regardless of exit path
		// (clean, aborted via inner break, or thrown). The next scan resets
		// to false at the top before the walk repopulates failedSubtrees.
		index.setFailedSubtreesPresent(failedSubtrees.size > 0);
		index.setScanIncomplete(!scanReachedEndCheck);
		// Release on every exit so post-scan watcher recoveries can drive
		// `markScanFinalized`.
		index.setScanInProgress(false);
	}
}

const PRUNE_STAT_BATCH = 64;

/**
 * `true` iff `lstat(rel)` throws ENOENT/ENOTDIR. Other errno
 * (EACCES, EMFILE, EIO, …) treat as transient and return `false`
 * (preserve rows). Bare check — no validatePath, no symlink
 * detection. Use `confirmPrune` when those richer semantics matter.
 */
async function lstatVanished(rel: string, vaultRoot: VaultRoot): Promise<boolean> {
	try {
		await lstat(join(vaultRoot.absolute, rel));
		return false;
	} catch (err) {
		return isVanishedErrno(err);
	}
}

/**
 * Per-row prune verdict. Returns `true` when the indexed row should be
 * removed:
 *   - File's extension no longer matches `VAULT_EXTENSIONS` (policy
 *     shrink: e.g. `md,mdx → md` leaves orphaned `.mdx` rows that the
 *     walk skipped). Cheap string predicate; no syscall.
 *   - Path is not a regular file on disk (`lstat` says directory,
 *     symlink, FIFO, …).
 *   - `lstat` ENOENT/ENOTDIR — file genuinely vanished.
 *
 * Returns `false` for other lstat errno (EACCES, EMFILE, EIO, …): a
 * transient blip must not nuke valid rows, mirroring scanner's
 * per-subtree preservation. `lstat` (not `stat`) so a path swapped to
 * a symlink prunes — `stat` would follow and report the target's
 * metadata, leaving a row pointing at a path `validatePath` now
 * rejects.
 */
export async function confirmPrune(rel: string, vaultRoot: VaultRoot): Promise<boolean> {
	if (!isMarkdownPath(rel)) return true;
	// Segment-walk via validatePath catches parent-dir symlink swaps and
	// any path the indexer would now refuse (NFC/percent mismatches, depth
	// cap, hidden-segment policy). A flat lstat(leaf) follows parent
	// symlinks and would falsely keep rows for paths direct reads now
	// reject with PATH_OUTSIDE_VAULT.
	try {
		await validatePath(rel, vaultRoot);
	} catch (err) {
		if (err instanceof PathValidationError) {
			// Transient lstat failures (EACCES/EMFILE/EIO) → preserve;
			// policy violations and PATH_NOT_FOUND → prune.
			const reason = err.payload.reason;
			if (reason === "STAT_FAILED" || reason === "REALPATH_FAILED") return false;
			return true;
		}
		// Unknown error: preserve row (defensive). Re-throwing here would
		// cancel the entire prune batch, dropping legitimate prunes for
		// unrelated rows.
		return false;
	}
	try {
		const st = await lstat(join(vaultRoot.absolute, rel));
		return !st.isFile();
	} catch (err) {
		return isVanishedErrno(err);
	}
}

/**
 * Stat-confirm `candidates` in parallel batches and invoke `onPrune`
 * for each row whose `confirmPrune` returns true. Shared between the
 * scan-finalize prune (`scanVault`) and merkle's removal loop —
 * batching keeps the lstat fan-out bounded so a 100k-file vault
 * doesn't open thousands of concurrent file handles.
 */
export async function confirmAndPrune(
	candidates: ReadonlyArray<string>,
	vaultRoot: VaultRoot,
	onPrune: (rel: string) => void | Promise<void>,
): Promise<void> {
	for (let i = 0; i < candidates.length; i += PRUNE_STAT_BATCH) {
		const batch = candidates.slice(i, i + PRUNE_STAT_BATCH);
		const verdicts = await Promise.all(batch.map(async (rel) => ({ rel, prune: await confirmPrune(rel, vaultRoot) })));
		// Fan out so async `onPrune` callers (merkle, which routes through
		// the coordinator) don't serialize N independent prune dispatches.
		// Sync callers see no throughput change — better-sqlite3 serializes
		// writes anyway — but the parallel form keeps both shapes uniform.
		await Promise.all(verdicts.filter((v) => v.prune).map(({ rel }) => onPrune(rel)));
	}
}

async function pruneVanishedFiles(
	index: IndexHandle,
	onDiskFiles: ReadonlyArray<string>,
	failedSubtrees: ReadonlySet<string>,
	vaultRoot: VaultRoot,
	coordinator: WriteCoordinator,
): Promise<void> {
	const onDisk = new Set(onDiskFiles);
	const retiredAt = Date.now();
	const candidates: string[] = [];
	for (const file of index.listIndexedFiles()) {
		if (onDisk.has(file)) continue;
		if (isUnderFailedSubtree(file, failedSubtrees)) continue;
		candidates.push(file);
	}
	await confirmAndPrune(candidates, vaultRoot, async (file) => {
		// Re-confirm INSIDE the coordinator window: a watcher reindex of
		// this path queues on the same FIFO key (FIFO-ordered ahead of
		// this task), so by the time we run, any concurrent recreate has
		// committed. Without the re-check, a recreated row is silently
		// deleted. Cost: one extra lstat per pruned file. Mirrors merkle's
		// prune routing in merkle.ts.
		await coordinator.enqueue(file, async () => {
			if (await confirmPrune(file, vaultRoot)) {
				index.removeFile(file, retiredAt);
			}
		});
	});
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
		// ENOENT/ENOTDIR: directory genuinely vanished mid-scan. Existing
		// rows under this prefix should be pruned — file is gone.
		if (isVanishedErrno(err)) return;
		// Other errno (EACCES, EMFILE, EIO, …): we can't enumerate, but
		// files may still exist. Track the prefix so the prune pass leaves
		// its rows alone and `scan_complete` stays false.
		const code = getErrnoCode(err);
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
		// Parent is already vetted by recursion; check the new segment only.
		if (isHiddenName(name)) continue;
		const childRel = relParent ? `${relParent}/${name}` : name;
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
		if (isNonNfc(childRel)) {
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
export type IndexOutcome = "indexed" | "parse_failed" | "vanished";

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
		// Only ENOENT/ENOTDIR mean "this file vanished, prune its rows."
		// Other errno (EACCES, EBUSY, EMFILE, …) → log + preserve existing
		// rows by routing through `parse_failed` (adds to stillOnDisk and
		// counts as skipped). Next scan retries.
		if (isVanishedErrno(err)) return "vanished";
		logSkipped(relpath, "stat", getErrnoCode(err) ?? "unknown");
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
	const links = buildWikilinkRows(parsed);
	const metrics = computeFileMetrics(parsed);
	index.replaceFile({ file: relpath, mtime, size, fragments, frontmatter, links, metrics });
	return "indexed";
}

/**
 * Aggregate file-level metrics for `get_vault_tree`'s file-row budgeting
 * fields. The parser's `annotateDescendantTokens` already stamps each
 * outline root with its full subtree's tokens, so summing roots gives
 * the file's heading-tree total in one pass; the preamble (or full body
 * for headingless notes) is the only slice we need to retokenize here.
 *
 * `descendantTokensApprox` ≡ `bodyTokensApprox` for a file: at the tree
 * level, a leaf's "descendants" are its own body. Directory aggregation
 * happens tree-side, not here.
 */
function computeFileMetrics(parsed: ParsedFile): FileMetricsInput {
	let bodyTokens = 0;
	for (const root of parsed.outline) bodyTokens += root.descendantTokensApprox;
	const kinds = new Set<ContentKind>();
	for (const h of parsed.headings) {
		for (const k of h.contentKinds) kinds.add(k);
	}
	// `computePreamble` returns the entire post-frontmatter body for
	// headingless files (parser.ts), so `parsed.preamble` covers that
	// case too — null only when the body is whitespace-only, in which
	// case there's nothing to tokenize. Preamble's `contentKinds` carries
	// kinds that fall outside any heading's IMMEDIATE body (headingless
	// files OR pre-first-heading nodes), which `annotateContentKinds`
	// would otherwise drop.
	if (parsed.preamble) {
		const preambleSlice = parsed.source.slice(parsed.preamble.offsetRange.start, parsed.preamble.offsetRange.end);
		bodyTokens += estimateTokens(preambleSlice);
		for (const k of parsed.preamble.contentKinds) kinds.add(k);
	}
	return {
		bodyTokensApprox: bodyTokens,
		descendantTokensApprox: bodyTokens,
		contentKinds: [...kinds],
	};
}

/**
 * Public wrapper for re-indexing a single file. The watcher and merkle
 * call this on add/change events without re-running the full vault walk.
 *
 * `skipUnchanged=true` so chokidar's startup `add` flood (one per
 * existing file under `ignoreInitial: false`) short-circuits on
 * `(mtime, size)` matches — no `replaceFile`, no `bumpSnapshot`, no
 * CURSOR_INVALID for in-flight cursors. Real edits change mtime so the
 * skip path won't fire.
 *
 * Mirrors `indexOne`'s outcome semantics. Caller treats `vanished` as
 * "remove from index" and `parse_failed` / other errors as "leave
 * existing rows alone."
 */
export async function reindexOne(vaultRoot: VaultRoot, index: IndexHandle, relpath: string): Promise<IndexOutcome> {
	// chokidar's `ignored` filter is stats-gated, but stats is undefined
	// during the initial recursive crawl (`alwaysStat: false`), so
	// non-markdown files reach here on `add` events. `walkVault` skips
	// them, so a `parse_failed` outcome's pendingRetry would never drain
	// via re-index — wedging `scan_complete=false`. `vanished` routes
	// removeFile + clearPendingRetry; the former is a no-op for
	// never-indexed paths and correct for renamed-to-non-markdown rows.
	if (!isMarkdownPath(relpath)) return "vanished";
	return indexOne(vaultRoot, index, relpath, true);
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

/**
 * Per-section wikilink extraction. Mirrors `buildFragmentRows`'s D31
 * emit rules: heading sections emit links, preamble emits links iff
 * non-whitespace, file row emits links for the entire post-frontmatter
 * body when there are no headings.
 *
 * `link_ordinal` is naturally 1-based per section (D34) — `extractWikilinks`
 * scopes its counter per call, and we call it once per source section.
 */
function buildWikilinkRows(parsed: ParsedFile): WikilinkRowInput[] {
	const out: WikilinkRowInput[] = [];

	const pushExtracted = (
		sliceStart: number,
		sliceEnd: number,
		sourceAnchorKind: AnchorKind,
		sourceHeadingPathJson: string | null,
		sourceStableId: string | null,
	): void => {
		const slice = parsed.source.slice(sliceStart, sliceEnd);
		const extracted = extractWikilinks({
			source: slice,
			sliceStart,
			excludedRanges: parsed.excludedRanges,
		});
		for (const e of extracted) {
			out.push({
				source_heading_path_json: sourceHeadingPathJson,
				source_stable_id: sourceStableId,
				source_anchor_kind: sourceAnchorKind,
				link_ordinal: e.ordinalInSection,
				raw_target: e.rawTarget,
				is_embed: e.isEmbed,
				alias: e.alias ?? null,
				link_text: e.alias ?? e.rawTarget,
			});
		}
	};

	if (parsed.headings.length === 0) {
		const start = parsed.frontmatterEndOffset;
		const end = parsed.source.length;
		pushExtracted(start, end, "file", null, null);
		return out;
	}

	// Insert preamble before headings so SQLite rowids end up in document
	// order — `listOutgoingLinks` uses `ORDER BY id ASC` per D36, which
	// only matches source position when each file's wikilinks were
	// inserted preamble-first.
	if (parsed.preamble) {
		const start = parsed.preamble.offsetRange.start;
		const end = parsed.preamble.offsetRange.end;
		if (!isWhitespaceRange(parsed.source, start, end)) {
			pushExtracted(start, end, "preamble", null, null);
		}
	}

	for (const h of parsed.headings) {
		// Slice spans heading line + immediate body so `# See [[Target]]`
		// indexes the link. FTS5 `body`/`code` keep `bodyOffsetRange` so a
		// term that appears only under a child heading does NOT inflate
		// every ancestor's BM25 score (the `headings` column already
		// carries the full ancestor chain for ancestor-aware ranking).
		pushExtracted(h.offsetRange.start, h.bodyOffsetRange.end, "heading", JSON.stringify(h.headingPath), h.stable_id);
	}

	return out;
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
