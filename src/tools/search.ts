/**
 * `search` handler — BM25 query mode + filter-only mode (D33).
 *
 * Mode determination per D33: non-empty post-sanitize query → query
 * mode; empty query + non-trivial filter → filter-only mode; empty +
 * empty → success with `items: []`.
 *
 * Cursor invalidation routes via the `CURSOR_INVALID` domain envelope
 * (D26 supersedes D9), so a sort / request_hash / snapshot_mtime drift
 * never escapes as JSON-RPC `-32602`.
 */

import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";

import {
	type CursorEnvelope,
	type CursorSort,
	decodeOptionalCursor,
	encodeCursor,
	type FilterKeysetKey,
	parseHeadingPathJson,
	type ScoreDescKey,
} from "../lib/cursor.js";
import {
	indexWarmingEnvelope,
	newMeta,
	successEnvelope,
	type ToolErrorEnvelope,
	type ToolSuccessEnvelope,
	toolErrorEnvelope,
	vaultError,
} from "../lib/error.js";
import { compileFilter } from "../lib/filter.js";
import { isHiddenPath, isIndexCachePath } from "../lib/hiddenPath.js";
import type { IndexHandle, SearchRow, SearchScopeClause } from "../lib/index/IndexHandle.js";
import { isIndexWarming } from "../lib/index_status.js";
import { clampPageSize } from "../lib/limits.js";
import { QUERY_ALGORITHM_ID, sanitizeQuery } from "../lib/search/sanitize.js";
import {
	BM25_SNIPPET_ALGORITHM_ID,
	buildBm25Snippet,
	buildFilterPreview,
	EMPTY_STEMMED_TERMS,
	FILTER_PREVIEW_ALGORITHM_ID,
	type StemmedTerms,
	stemTerms,
} from "../lib/search/snippet.js";
import { getTokenizerId } from "../lib/tokenizer.js";
import { PathValidationError, type VaultRoot, validatePath } from "../lib/validatePath.js";
import type { AnchorKind, MetaEnvelope, SafePath, SearchInput, SearchOutput, SearchResult } from "../types.js";
import { routeToolError } from "./routeError.js";

export async function handleSearch(
	input: SearchInput,
	vaultRoot: VaultRoot,
	index: IndexHandle,
	includeHidden = false,
): Promise<ToolSuccessEnvelope<SearchOutput> | ToolErrorEnvelope> {
	// Hoisted so the catch block can pass it to routeToolError — keeps
	// `index_status` (warm/reconciling) and `query_algorithm` on error
	// envelopes instead of regressing to the cold-default newMeta().
	const indexStatus = index.getStatus();
	const meta = newMeta({
		index_status: indexStatus,
		query_algorithm: QUERY_ALGORITHM_ID,
		tokenizer: getTokenizerId(),
	});
	try {
		// Validation runs BEFORE the warming gate: PATH_OUTSIDE_VAULT,
		// INVALID_QUERY, FILTER_SYNTAX_ERROR are permanent for that input,
		// but INDEX_WARMING is transient — masking the former with the
		// latter wastes the agent's retry budget on requests that will
		// never succeed. The empty-and-empty D23 fast path also moves
		// above the gate; it never reads the index.
		const scope = await classifyScope(input.scope?.path, vaultRoot, includeHidden);
		if (!scope.ok) return toolErrorEnvelope(scope.err, meta);

		const outcome = sanitizeQuery(input.query ?? "");
		if (outcome.kind === "reject") {
			const err = vaultError(
				"INVALID_QUERY",
				outcome.reason === "too_long" ? "Query exceeds 1024-char limit." : "Query contains control characters.",
				{
					param: "query",
					reason: outcome.reason,
					request_id: meta.request_id,
					suggestion: "Issue a shorter query without control bytes.",
				},
			);
			return toolErrorEnvelope(err, meta);
		}

		const filter = compileFilter(input.filters);
		const pageSize = clampPageSize(input.pageSize);

		// D33 mode determination: non-empty query → query mode; empty query
		// + non-trivial filter → filter mode; both empty → success items: [].
		if (outcome.kind !== "ok" && filter === null) {
			const successMeta: MetaEnvelope = {
				...meta,
				query_note: outcome.kind === "empty" ? `empty query (${outcome.reason})` : "empty query",
				snippet_algorithm: BM25_SNIPPET_ALGORITHM_ID,
			};
			return successEnvelope({ items: [], retriever: "bm25" } satisfies SearchOutput, successMeta);
		}

		if (isIndexWarming(indexStatus.state)) {
			return indexWarmingEnvelope(meta, {
				filesIndexed: indexStatus.files_indexed,
				message: "Index is warming; vault-wide search is not yet available.",
				suggestion: "Retry after the warm-up completes; bounded reads (outline/fragment/metadata) work now.",
			});
		}

		const queryMode = outcome.kind === "ok";
		const expectedSort: CursorSort = queryMode ? "score-desc" : "filter-keyset-v1";
		const requestHash = computeRequestHash({
			filterHash: filter?.filterHash ?? "",
			scope: scope.value,
			queryMatch: outcome.kind === "ok" ? outcome.match : "",
		});
		const snapshotMtime = index.getSnapshot();
		const cursorEnv = decodeOptionalCursor(input.cursor, {
			expectedSort,
			currentRequestHash: requestHash,
			currentSnapshotMtime: snapshotMtime,
		});

		let rows: SearchRow[];
		let snippetAlgo: string;
		let queryNote: string | undefined;
		// Pre-stem once per page so the per-row snippet builder doesn't
		// repeat porter-stem work across (up to) MAX_PAGE_SIZE rows.
		let matchedTerms: StemmedTerms = EMPTY_STEMMED_TERMS;
		if (outcome.kind === "ok") {
			snippetAlgo = BM25_SNIPPET_ALGORITHM_ID;
			matchedTerms = stemTerms(outcome.tokens);
			const after = cursorEnv?.sort === "score-desc" ? cursorEnv.after_key : undefined;
			const result = executeQueryWithFallback(index, outcome.match, scope.value, filter, pageSize, after);
			rows = result.rows;
			if (result.fallback) queryNote = "fallback-defanged";
		} else {
			snippetAlgo = FILTER_PREVIEW_ALGORITHM_ID;
			const after = cursorEnv?.sort === "filter-keyset-v1" ? cursorEnv.after_key : undefined;
			rows = index.searchFilterMode({ scope: scope.value, filter, pageSize, after });
		}

		const items: SearchResult[] = rows.map((r) => buildSearchResult(r, queryMode ? "bm25" : "filter", matchedTerms));

		const out: SearchOutput = {
			items,
			retriever: queryMode ? "bm25" : "filter",
		};
		if (items.length === pageSize) {
			const last = rows[rows.length - 1];
			if (last !== undefined) {
				out.nextCursor = buildNextCursor(expectedSort, requestHash, snapshotMtime, last);
			}
		}

		const successMeta: MetaEnvelope = { ...meta, snippet_algorithm: snippetAlgo };
		if (queryNote !== undefined) successMeta.query_note = queryNote;
		return successEnvelope(out, successMeta);
	} catch (err) {
		return routeToolError(err, "search", meta);
	}
}

interface ScopeOk {
	ok: true;
	value: SearchScopeClause;
}
interface ScopeErr {
	ok: false;
	err: ReturnType<typeof vaultError>;
}

async function classifyScope(
	rawPath: string | undefined,
	vaultRoot: VaultRoot,
	includeHidden: boolean,
): Promise<ScopeOk | ScopeErr> {
	// Only `undefined` (omitted) selects vault-wide; `""` falls through to
	// validatePath (which rejects with EMPTY_PATH) so scope.path follows the
	// same path-validation rules as every other tool's `file` parameter.
	if (rawPath === undefined) {
		return { ok: true, value: { kind: "vault" } };
	}
	let safe: SafePath;
	try {
		safe = await validatePath(rawPath, vaultRoot);
	} catch (err) {
		// validatePath hardcodes `param: "file"` for the tool surface;
		// search receives the path as `scope.path`, so rebrand here —
		// same pattern as the note:// resource at server.ts:258-262.
		if (err instanceof PathValidationError) {
			return { ok: false, err: { ...err.payload, param: "scope.path" } };
		}
		throw err;
	}
	// Hidden paths are policy-excluded from every surface; mirrors readNote.
	// Gate runs BEFORE `stat` — a hidden path's stat would succeed (the file
	// exists on disk), so a post-stat check would mis-classify the rejection
	// as "not a regular file or directory" instead of the precise reason.
	if (!includeHidden && isHiddenPath(safe.relative)) {
		return {
			ok: false,
			err: vaultError("PATH_NOT_FOUND", `Scope path is hidden (excluded by default): ${rawPath}`, {
				param: "scope.path",
			}),
		};
	}
	// Server's own cache dir is rejected regardless of `--include-hidden`.
	// Mirrors readNote, getVaultTree.resolveStartPath, and watcher.shouldIgnore.
	if (isIndexCachePath(safe.relative)) {
		return {
			ok: false,
			err: vaultError("PATH_NOT_FOUND", `Scope path is inside the server cache directory: ${rawPath}`, {
				param: "scope.path",
			}),
		};
	}
	let st: import("node:fs").Stats;
	try {
		st = await stat(safe.absolute);
	} catch {
		return {
			ok: false,
			err: vaultError("PATH_NOT_FOUND", `Scope path does not exist: ${rawPath}`, { param: "scope.path" }),
		};
	}
	if (st.isDirectory()) {
		return { ok: true, value: { kind: "subtree", value: safe.relative } };
	}
	if (st.isFile()) {
		return { ok: true, value: { kind: "file", value: safe.relative } };
	}
	return {
		ok: false,
		err: vaultError("PATH_NOT_FOUND", `Scope path is not a regular file or directory: ${rawPath}`, {
			param: "scope.path",
		}),
	};
}

/**
 * Hash of the request-shaping inputs for `search` cursors. Reusing a
 * cursor across mutated `scope` or `query` produces a different hash
 * and surfaces as `CURSOR_INVALID`. `queryMatch` is the post-sanitize
 * form so semantic-equivalent queries (`"foo bar"` vs `"foo  bar"`)
 * hash identically.
 *
 * Uses NUL-separated concatenation rather than `canonicalJson` because
 * the payload shape is fixed-arity (4 leaves) and all inputs are
 * NUL-free: `filterHash` is a hex sha1 digest; `scope.kind` is an enum;
 * `scope.value` is a validated relative path (POSIX/NTFS forbid embedded
 * NUL in filenames); `queryMatch` is post-`query-sanitize-v1` which
 * rejects all C0 control chars including NUL. Skipping JSON walk +
 * key-sort + per-leaf `JSON.stringify` cuts ~7 recursive calls per
 * `search` to a single string concat.
 */
function computeRequestHash(inputs: { filterHash: string; scope: SearchScopeClause; queryMatch: string }): string {
	const payload = `${inputs.filterHash}\u0000${inputs.scope.kind}\u0000${inputs.scope.value ?? ""}\u0000${inputs.queryMatch}`;
	return createHash("sha1").update(payload).digest("hex");
}

/**
 * Defense-in-depth retry: if FTS5 throws on the sanitized MATCH (rare —
 * sanitize covers the public surface), strip remaining special chars
 * and retry once. Both failures and the empty-after-defang case yield
 * `fallback: true` + empty rows so the handler can stamp `query_note`.
 *
 * Only `fts5:` syntax errors trigger the retry. Other SQLite or runtime
 * errors (corrupted index, missing table, "database is locked", bugs in
 * generated SQL) rethrow so the outer handler surfaces them as
 * `INTERNAL_ERROR` rather than pretending search succeeded with no rows.
 */
function executeQueryWithFallback(
	index: IndexHandle,
	match: string,
	scope: SearchScopeClause,
	filter: ReturnType<typeof compileFilter>,
	pageSize: number,
	after: ScoreDescKey | undefined,
): { rows: SearchRow[]; fallback: boolean } {
	try {
		return { rows: index.searchQueryMode({ match, scope, filter, pageSize, after }), fallback: false };
	} catch (err) {
		if (!isFtsSyntaxError(err)) throw err;
		const defanged = match.replace(/[+\-^():"]/g, " ").trim();
		if (defanged.length === 0) return { rows: [], fallback: true };
		try {
			return { rows: index.searchQueryMode({ match: defanged, scope, filter, pageSize, after }), fallback: true };
		} catch (err2) {
			if (!isFtsSyntaxError(err2)) throw err2;
			return { rows: [], fallback: true };
		}
	}
}

/**
 * better-sqlite3 throws `SqliteError` with `code: "SQLITE_ERROR"` and a
 * message starting `"fts5:"` for MATCH-syntax errors. Duck-type rather
 * than `instanceof SqliteError` to avoid a runtime import of the value
 * for one check.
 */
function isFtsSyntaxError(err: unknown): boolean {
	if (!(err instanceof Error)) return false;
	const code = (err as { code?: unknown }).code;
	return code === "SQLITE_ERROR" && err.message.startsWith("fts5:");
}

function buildNextCursor(sort: CursorSort, request_hash: string, snapshot_mtime: number, row: SearchRow): string {
	const heading_path = parseHeadingPathJson(row.heading_path_json);
	if (sort === "score-desc") {
		const env: CursorEnvelope = {
			v: 1,
			sort,
			request_hash,
			snapshot_mtime,
			after_key: {
				score: row.score,
				file: row.file,
				heading_path,
				anchor_kind: row.anchor_kind,
				id: row.id,
			} satisfies ScoreDescKey,
		};
		return encodeCursor(env);
	}
	if (sort === "filter-keyset-v1") {
		const env: CursorEnvelope = {
			v: 1,
			sort,
			request_hash,
			snapshot_mtime,
			after_key: {
				file: row.file,
				heading_path,
				anchor_kind: row.anchor_kind,
				id: row.id,
			} satisfies FilterKeysetKey,
		};
		return encodeCursor(env);
	}
	throw new Error(`buildNextCursor: unsupported sort ${sort}`);
}

function buildSearchResult(row: SearchRow, scoreType: "bm25" | "filter", matchedTerms: StemmedTerms): SearchResult {
	const snippet =
		scoreType === "bm25"
			? buildBm25Snippet({ body: row.body, code: row.code, terms: matchedTerms })
			: buildFilterPreview({ body: row.body, code: row.code });
	const anchorKind: AnchorKind = row.anchor_kind;
	switch (anchorKind) {
		case "heading":
			return {
				anchor_kind: "heading",
				file: row.file,
				snippet,
				score: row.score,
				score_type: scoreType,
				heading_path: parseHeadingPathJson(row.heading_path_json) ?? [],
				stable_id: row.stable_id ?? "",
			};
		case "preamble":
			return {
				anchor_kind: "preamble",
				file: row.file,
				snippet,
				score: row.score,
				score_type: scoreType,
			};
		case "file":
			return {
				anchor_kind: "file",
				file: row.file,
				snippet,
				score: row.score,
				score_type: scoreType,
			};
	}
}
