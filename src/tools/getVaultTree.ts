/**
 * `get_vault_tree` — paginated DFS walk of the vault subtree at `path`,
 * up to `depth` levels.
 *
 * Cursor sort `tree-dfs-v1` (D35): `after_key = { dfs_rank }`. The
 * walker re-runs DFS on each request and skips nodes whose
 * `walk_position <= cursor.dfs_rank`, then emits the next `pageSize`
 * nodes. `dfs_rank` is exposed on each item so debugging the order is
 * trivial.
 *
 * `resource_link` blocks are emitted next to the JSON `text` block in
 * the response `content[]` array — only for items whose extension
 * matches `VAULT_EXTENSIONS` (default `.md`). Non-markdown assets
 * appear in `items[]` but emit no `resource_link`. Hidden paths follow
 * the all-or-nothing server flag (programmatic in W4; CLI flag in W5).
 */

import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import { lstat, readdir, stat } from "node:fs/promises";
import { join } from "node:path";

import { type CursorEnvelope, decodeOptionalCursor, encodeCursor, type TreeDfsKey } from "../lib/cursor.js";
import {
	type ExtraContentBlock,
	getErrnoCode,
	indexWarmingEnvelope,
	isVanishedErrno,
	newMetaForHandler,
	successEnvelope,
	type ToolErrorEnvelope,
	type ToolSuccessEnvelope,
	toolErrorEnvelope,
	vaultError,
} from "../lib/error.js";
import { isHiddenName, isHiddenPath, isIndexCachePath } from "../lib/hiddenPath.js";
import type { IndexHandle } from "../lib/index/IndexHandle.js";
import { isIndexWarming } from "../lib/index_status.js";
import { clampPageSize, MAX_PATH_DEPTH } from "../lib/limits.js";
import { getTokenizerId } from "../lib/tokenizer.js";
import { PathValidationError, passesPathPolicy, type VaultRoot, validatePath } from "../lib/validatePath.js";
import { isMarkdownPath } from "../lib/vaultExtensions.js";
import type { GetVaultTreeInput, GetVaultTreeResult, SafePath, VaultTreeItem } from "../types.js";
import { routeToolError } from "./routeError.js";

const DEFAULT_DEPTH = 2;

export async function handleGetVaultTree(
	input: GetVaultTreeInput,
	vaultRoot: VaultRoot,
	index?: IndexHandle,
	includeHidden = false,
): Promise<ToolSuccessEnvelope<GetVaultTreeResult> | ToolErrorEnvelope> {
	const meta = newMetaForHandler(index, { tokenizer: getTokenizerId() });
	try {
		// Path validation precedes INDEX_WARMING (mirrors search.ts) so
		// permanent errors like `path: "../etc"` aren't masked as transient.
		const startRel = await resolveStartPath(input.path, vaultRoot, includeHidden);
		if (startRel === null) {
			const err = vaultError("PATH_NOT_FOUND", `Tree root path does not exist: ${input.path ?? ""}`, {
				param: "path",
				request_id: meta.request_id,
			});
			return toolErrorEnvelope(err, meta);
		}

		const indexStatus = index?.getStatus();
		if (indexStatus && isIndexWarming(indexStatus.state)) {
			return indexWarmingEnvelope(meta, {
				filesIndexed: indexStatus.files_indexed,
				message: "Index is warming; retry once the initial scan finishes.",
				suggestion: "Bounded reads (outline/fragment/metadata) work now; tree waits for the initial scan.",
			});
		}

		const depth = clampDepth(input.depth);
		const pageSize = clampPageSize(input.pageSize);
		const startAbs = startRel === "" ? vaultRoot.absolute : join(vaultRoot.absolute, startRel);
		// `request_hash` includes a streaming hash of `(relpath, type)` tuples
		// so cursors invalidate on tree-shape drift the index snapshot misses
		// (new directory, moved non-markdown asset).
		const hasher = createHash("sha1");
		hasher.update(`${startRel}\u0000${depth}\u0000`);
		const allNodes: WalkNode[] = [];
		for await (const node of walkTreeDfs(startAbs, startRel, depth, /* currentDepth */ 0, includeHidden)) {
			allNodes.push(node);
			hasher.update(`${node.relpath}\u0000${node.type}\u0001`);
		}
		const requestHash = hasher.digest("hex");
		const snapshotMtime = index?.getSnapshot() ?? 0;

		const cursorEnv = decodeOptionalCursor(input.cursor, {
			expectedSort: "tree-dfs-v1",
			currentRequestHash: requestHash,
			currentSnapshotMtime: snapshotMtime,
		});
		const skipBeforeRank = cursorEnv && cursorEnv.sort === "tree-dfs-v1" ? cursorEnv.after_key.dfs_rank : 0;

		const pageNodes = allNodes.slice(skipBeforeRank, skipBeforeRank + pageSize);
		const items = await Promise.all(
			pageNodes.map((node, i) => materializeItem(node, skipBeforeRank + i + 1, vaultRoot, index, includeHidden)),
		);
		const hasMore = allNodes.length > skipBeforeRank + items.length;
		const nextCursorAfter = hasMore && items.length === pageSize ? skipBeforeRank + items.length : null;

		const out: GetVaultTreeResult = { items };
		if (nextCursorAfter !== null) {
			out.nextCursor = buildNextCursor(requestHash, snapshotMtime, nextCursorAfter);
		}

		return successEnvelope(out, meta, buildResourceLinks(out.items));
	} catch (err) {
		return routeToolError(err, "get_vault_tree", meta);
	}
}

function buildResourceLinks(items: ReadonlyArray<VaultTreeItem>): ExtraContentBlock[] {
	const blocks: ExtraContentBlock[] = [];
	for (const item of items) {
		if (item.type !== "file" || !isMarkdownPath(item.path)) continue;
		// `note://` reads validate path + stream raw bytes via `readSource`;
		// index membership is NOT a precondition. Parse-failed, newly-
		// created (pre-watcher), and EACCES-during-scan markdown files all
		// resolve for `note://` reads even when absent from the index — so
		// a tree-walk surface that suppresses resource_links based on index
		// presence would hide working resources.
		blocks.push({
			type: "resource_link",
			// Per-segment encodeURIComponent because validatePath admits `#`
			// and `?` (valid POSIX filename chars), but encodeURI keeps both
			// literal — the resource template `note://{+path}` would parse
			// `note://a#b.md` as path=`a` fragment=`b.md` and the read fails
			// with PATH_NOT_FOUND. The `/` separator stays literal so the
			// template's path expansion works as before.
			uri: `note://${item.path.split("/").map(encodeURIComponent).join("/")}`,
			name: item.name,
			mimeType: "text/markdown",
		});
	}
	return blocks;
}

async function resolveStartPath(
	input: string | undefined,
	vaultRoot: VaultRoot,
	includeHidden: boolean,
): Promise<string | null> {
	if (!input || input === "" || input === "/") return "";
	let safe: SafePath;
	try {
		safe = await validatePath(input, vaultRoot);
	} catch (err) {
		// validatePath tags its payload with `param: "file"`; this tool's
		// argument is `path`. Rebrand so clients keying off `param` to
		// highlight the bad field get the right name.
		if (err instanceof PathValidationError) {
			throw new PathValidationError({ ...err.payload, param: "path" });
		}
		throw err;
	}
	// Hidden roots are policy-excluded by default — without this gate, an agent
	// passing `path: ".obsidian"` would walk inside the hidden root and emit
	// its non-hidden children. Per-entry isHiddenName in walkTreeDfs only
	// vets descendants. Mirrors search.ts (scope.path) and readNote.ts.
	if (!includeHidden && isHiddenPath(safe.relative)) return null;
	// Server's own cache dir is rejected as a tree root regardless of
	// `--include-hidden`. The dirent filter in `shouldEmitDirent` only excludes
	// `.markdown-mcp` when encountered as a child of vault root — without this
	// resolver-level gate, `path: ".markdown-mcp"` under `--include-hidden` would
	// walk inside the cache and enumerate `index.sqlite3` + WAL/SHM siblings.
	if (isIndexCachePath(safe.relative)) return null;
	try {
		const st = await stat(safe.absolute);
		if (!st.isDirectory()) return null;
	} catch {
		return null;
	}
	return safe.relative;
}

function clampDepth(input: number | undefined): number {
	if (input === undefined || !Number.isFinite(input)) return DEFAULT_DEPTH;
	const n = Math.floor(input);
	if (n < 0) return DEFAULT_DEPTH;
	return Math.min(n, MAX_PATH_DEPTH);
}

function buildNextCursor(requestHash: string, snapshotMtime: number, dfsRank: number): string {
	const env: CursorEnvelope = {
		v: 1,
		sort: "tree-dfs-v1",
		request_hash: requestHash,
		snapshot_mtime: snapshotMtime,
		after_key: { dfs_rank: dfsRank } satisfies TreeDfsKey,
	};
	return encodeCursor(env);
}

interface WalkNode {
	relpath: string;
	type: "dir" | "file";
}

/**
 * Iterative DFS over the FS subtree rooted at `startAbs` (vault-relative
 * `startRel`). Sorted alphabetically per directory; `depth` limits
 * recursion (0 = startRel only, 1 = direct children, …).
 *
 * Hidden files filtered, symlinks skipped. Markdown predicate applies
 * to file emission only — directories always recurse. Non-markdown
 * assets ARE emitted as `file` items so callers can see them, but the
 * envelope builder skips `resource_link` blocks for non-markdown
 * extensions.
 */
async function* walkTreeDfs(
	startAbs: string,
	startRel: string,
	maxDepth: number,
	currentDepth: number,
	includeHidden: boolean,
): AsyncGenerator<WalkNode> {
	if (currentDepth > maxDepth) return;
	if (!(await isRealDirectory(startAbs))) return;
	let entries: Dirent[];
	try {
		entries = (await readdir(startAbs, { withFileTypes: true, encoding: "utf8" })) as Dirent[];
	} catch (err) {
		// ENOENT/ENOTDIR: vanished mid-walk — silent (next call sees the
		// drop). Other errno (EACCES/EMFILE/EIO/…) log so an operator
		// can correlate "tree truncated" with the underlying failure.
		if (!isVanishedErrno(err)) {
			console.error(
				`markdown-mcp tree: skipping subtree ${startRel || "(vault root)"} (readdir error: ${getErrnoCode(err) ?? "unknown"})`,
			);
		}
		return;
	}
	// Dirs-first within each parent (D35 + file-manager convention):
	// visit all subdirectories alphabetically, recursing into each, then
	// emit files alphabetically. Without this, mixed sort yields
	// `[a, b.md, z]` which interleaves files between dirs and breaks
	// the documented DFS order.
	const dirs: Dirent[] = [];
	const files: Dirent[] = [];
	for (const entry of entries) {
		if (!shouldEmitDirent(entry, startRel, includeHidden)) continue;
		if (entry.isDirectory()) dirs.push(entry);
		else files.push(entry);
	}
	dirs.sort((a, b) => a.name.localeCompare(b.name));
	files.sort((a, b) => a.name.localeCompare(b.name));

	// Sync policy gates mirror the scanner's `walkVault`: a path that
	// direct-read tools / `note://` would reject (PERCENT_ENCODED,
	// BACKSLASH, TOO_DEEP, NON_NFC) must not appear in tree items either,
	// or its `resource_link` would dangle.
	for (const entry of dirs) {
		const childRel = startRel ? `${startRel}/${entry.name}` : entry.name;
		if (!passesPathPolicy(childRel)) continue;
		yield { relpath: childRel, type: "dir" };
		if (currentDepth < maxDepth) {
			yield* walkTreeDfs(join(startAbs, entry.name), childRel, maxDepth, currentDepth + 1, includeHidden);
		}
	}
	for (const entry of files) {
		const childRel = startRel ? `${startRel}/${entry.name}` : entry.name;
		if (!passesPathPolicy(childRel)) continue;
		yield { relpath: childRel, type: "file" };
	}
}

/**
 * Per-entry filter for the tree walk + child counter. Symlinks are
 * skipped (D8 — symlinks are rejected at every surface), the server's
 * own top-level cache dir is skipped regardless of `includeHidden` via
 * `isIndexCachePath` (FS-aware case-folding so a `.Markdown-MCP/` aliasing
 * the cache on macOS APFS / Windows NTFS is also excluded — byte-wise
 * compare against `INDEX_DIR_NAME` alone would leak the cache through
 * the tree), hidden names are skipped per the all-or-nothing server
 * policy, and only regular files and directories are considered
 * (sockets/devices/FIFOs surface from readdir but have no addressable
 * representation).
 *
 * Shared between `walkTreeDfs` (DFS emission) and `safeChildrenCount`
 * (the `children` lazy-load hint) so the visible-children count never
 * lies about what DFS would yield.
 */
function shouldEmitDirent(entry: Dirent, parentRel: string, includeHidden: boolean): boolean {
	if (entry.isSymbolicLink()) return false;
	if (parentRel === "" && isIndexCachePath(entry.name)) return false;
	if (!includeHidden && isHiddenName(entry.name)) return false;
	if (!entry.isDirectory() && !entry.isFile()) return false;
	return true;
}

async function materializeItem(
	node: WalkNode,
	dfsRank: number,
	vaultRoot: VaultRoot,
	index: IndexHandle | undefined,
	includeHidden: boolean,
): Promise<VaultTreeItem> {
	const id = `t:${createHash("sha1").update(node.relpath).digest("hex").slice(0, 14)}`;
	const slashIdx = node.relpath.lastIndexOf("/");
	const name = slashIdx >= 0 ? node.relpath.slice(slashIdx + 1) : node.relpath;
	const item: VaultTreeItem = {
		id,
		type: node.type,
		path: node.relpath,
		name,
		dfs_rank: dfsRank,
		mtime: 0,
	};

	if (node.type === "file") {
		const stats = index?.getFileStats(node.relpath);
		if (stats !== null && stats !== undefined) {
			item.subheadings = stats.subheadings;
			item.mtime = stats.mtime;
			item.bodyTokensApprox = stats.bodyTokensApprox;
			item.descendantTokensApprox = stats.descendantTokensApprox;
			if (stats.contentKinds.length > 0) item.contentKinds = [...stats.contentKinds];
			return item;
		}
		// Indexer-cold file: stat the path directly. Vanish-between-walk-
		// and-stat is benign — keep the default `mtime: 0`.
		item.mtime = await safeStatMtime(join(vaultRoot.absolute, node.relpath));
		return item;
	}
	// Directory: parallel `readdir` (children count, lazy-load hint per
	// the `get_vault_tree` contract) + `stat` (mtime). Per-page cost
	// scales with dir count; serialized fs ops would dominate for
	// pageSize-bounded responses with many directories.
	const absPath = join(vaultRoot.absolute, node.relpath);
	const [children, mtime] = await Promise.all([
		safeChildrenCount(absPath, node.relpath, includeHidden),
		safeStatMtime(absPath),
	]);
	item.children = children;
	item.mtime = mtime;
	return item;
}

/**
 * lstat-before-readdir gate. `readdir` follows symlinks at its input
 * path, so a directory swapped to a symlink between the parent's
 * observation and the recursive descent would otherwise list files
 * outside the vault. lstat refuses that swap. Residual TOCTOU between
 * this lstat and the readdir is the documented V1/V6 class — closing
 * fully would need `openat`/`fdopendir`, not available in Node 22.
 */
async function isRealDirectory(absPath: string): Promise<boolean> {
	try {
		const st = await lstat(absPath);
		return !st.isSymbolicLink() && st.isDirectory();
	} catch {
		return false;
	}
}

async function safeStatMtime(absPath: string): Promise<number> {
	try {
		// `lstat`, not `stat`: a leaf-symlink swap between walkTreeDfs's
		// observation and now would otherwise leak the target's mtime.
		const st = await lstat(absPath);
		if (st.isSymbolicLink()) return 0;
		return st.mtimeMs;
	} catch {
		return 0;
	}
}

async function safeChildrenCount(absPath: string, relParent: string, includeHidden: boolean): Promise<number> {
	if (!(await isRealDirectory(absPath))) return 0;
	try {
		const entries = (await readdir(absPath, { withFileTypes: true, encoding: "utf8" })) as Dirent[];
		let count = 0;
		for (const entry of entries) {
			if (!shouldEmitDirent(entry, relParent, includeHidden)) continue;
			const childRel = relParent ? `${relParent}/${entry.name}` : entry.name;
			if (!passesPathPolicy(childRel)) continue;
			count++;
		}
		return count;
	} catch {
		return 0;
	}
}
