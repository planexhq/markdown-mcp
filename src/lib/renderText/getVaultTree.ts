/**
 * Prose renderer for `get_vault_tree` output. Items render as a flat
 * DFS-ranked list (matching `VaultTreeItem`'s shape) rather than a
 * synthesized tree, since pagination can split a directory's children
 * across pages and indented output would mislead. Non-markdown files
 * are tagged `asset` so the agent knows why no `resource_link` block
 * was emitted alongside.
 */

import type { GetVaultTreeResult, MetaEnvelope, VaultTreeItem } from "../../types.js";
import { isMarkdownPath } from "../vaultExtensions.js";
import { formatCursor, formatFileHeading, formatMeta, joinLines } from "./_shared.js";

export function renderTree(sc: GetVaultTreeResult, meta: MetaEnvelope): string {
	const header = `tree · ${sc.items.length} ${sc.items.length === 1 ? "item" : "items"}`;

	const sections: Array<string | null> = [header];
	if (sc.items.length > 0) {
		sections.push("");
		for (const item of sc.items) sections.push(renderItem(item));
	}
	const cursor = formatCursor(sc.nextCursor);
	if (cursor) sections.push("", cursor);
	const metaLine = formatMeta(meta);
	if (metaLine) sections.push("", metaLine);

	return joinLines(sections);
}

function renderItem(item: VaultTreeItem): string {
	if (item.type === "dir") {
		// Slash inside the wrap so `stripOuterGuillemets` (gated on
		// `endsWith(»)`) fires on copy-back of `›`-bearing dirs.
		const dirPath = formatFileHeading(`${item.path}/`);
		const children = item.children ?? 0;
		const childLabel = children === 1 ? "child" : "children";
		return `[dir]   ${dirPath}  (rank ${item.dfs_rank}, ${children} ${childLabel})`;
	}
	const path = formatFileHeading(item.path);
	const isMarkdown = isMarkdownPath(item.path);
	// Markdown files on disk but not in the index (pre-watcher, parse-failed,
	// EACCES-during-scan) reach materializeItem without stats — label them so
	// the row doesn't read as a malformed `(rank N, )`.
	const suffix = isMarkdown ? formatFileSuffix(item) || "unindexed" : "asset";
	return `[file]  ${path}  (rank ${item.dfs_rank}, ${suffix})`;
}

function formatFileSuffix(item: VaultTreeItem): string {
	const parts: string[] = [];
	if (item.subheadings !== undefined) {
		parts.push(`${item.subheadings} ${item.subheadings === 1 ? "heading" : "headings"}`);
	}
	if (item.bodyTokensApprox !== undefined) {
		if (item.descendantTokensApprox !== undefined && item.descendantTokensApprox !== item.bodyTokensApprox) {
			parts.push(`~${item.bodyTokensApprox} tok body`);
			parts.push(`~${item.descendantTokensApprox} tok total`);
		} else {
			parts.push(`~${item.bodyTokensApprox} tok`);
		}
	}
	if (item.contentKinds && item.contentKinds.length > 0) {
		parts.push(`contains: ${item.contentKinds.join(", ")}`);
	}
	return parts.join(", ");
}
