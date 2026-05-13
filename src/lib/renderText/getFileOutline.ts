/** Prose renderer for `get_file_outline` output. */

import type { BlockIndexEntry, GetFileOutlineResult, MetaEnvelope, OutlineNode } from "../../types.js";
import { formatHeadingPath, formatHeadingSegment, formatMeta, joinLines } from "./_shared.js";

export function renderOutline(sc: GetFileOutlineResult, meta: MetaEnvelope): string {
	const headingLines: string[] = [];
	let headingCount = 0;
	for (const node of sc.outline) headingCount += renderNode(node, 0, headingLines);

	const blockEntries = Object.entries(sc.blockIndex);
	const blockCount = blockEntries.length;

	// `GetFileOutlineResult` carries no file path, so the header doesn't
	// echo it — the agent already knows the file from its request.
	const header = `outline · ${headingCount} ${
		headingCount === 1 ? "heading" : "headings"
	}, ${blockCount} ${blockCount === 1 ? "block" : "blocks"}`;

	const sections: Array<string | null> = [header];
	if (headingLines.length > 0) sections.push("", headingLines.join("\n"));
	if (blockCount > 0) {
		sections.push("", "blocks:");
		for (const [id, entry] of blockEntries) {
			sections.push(`  ^${id}  ${formatBlockSuffix(entry)}`);
		}
	}
	const metaLine = formatMeta(meta);
	if (metaLine) sections.push("", metaLine);

	return joinLines(sections);
}

function renderNode(node: OutlineNode, depth: number, out: string[]): number {
	const indent = "  ".repeat(depth);
	const hashes = "#".repeat(node.level);
	// `OutlineNode.path` is the parser's normalized `pathText` — markup
	// stripped, NFC + trim + whitespace-collapsed; matches what
	// `normalizeHeadingPath` accepts. `OutlineNode.text` (displayText)
	// preserves inline markdown (`` `<T>` ``, `[label](url)`, etc.) but
	// can't be used as a follow-up `heading_path` input.
	const text = formatHeadingSegment(node.path);
	const counts = formatTokenCounts(node);
	const kindsFrag =
		node.contentKinds && node.contentKinds.length > 0 ? ` · contains: ${node.contentKinds.join(", ")}` : "";
	out.push(
		`${indent}${hashes} ${text}  (${counts}, id: ${node.stable_id}, L${node.range.start}-L${node.range.end}${kindsFrag})`,
	);
	let count = 1;
	if (node.children) {
		for (const child of node.children) count += renderNode(child, depth + 1, out);
	}
	return count;
}

function formatTokenCounts(node: OutlineNode): string {
	if (node.descendantTokensApprox === node.bodyTokensApprox) {
		return `~${node.bodyTokensApprox} tok`;
	}
	return `~${node.bodyTokensApprox} tok body, ~${node.descendantTokensApprox} tok total`;
}

function formatBlockSuffix(entry: BlockIndexEntry): string {
	const path = entry.heading_path.length > 0 ? formatHeadingPath(entry.heading_path) : "preamble";
	// `containing_stable_id` disambiguates blocks under duplicate-heading
	// parents (legal under D27 — two `# A` sections share heading_path but
	// have distinct stable_ids); preamble blocks (null) skip the suffix.
	const idFrag = entry.containing_stable_id ? `, id: ${entry.containing_stable_id}` : "";
	return `(L${entry.range.start}-L${entry.range.end}, ${path}${idFrag})`;
}
