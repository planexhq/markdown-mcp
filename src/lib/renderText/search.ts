/** Prose renderer for `search` output. */

import type { MetaEnvelope, SearchOutput, SearchResult } from "../../types.js";
import { formatCursor, formatFileHeading, formatMeta, joinLines, singleLine } from "./_shared.js";

export function renderSearch(sc: SearchOutput, meta: MetaEnvelope): string {
	const modeLabel = sc.retriever === "filter" ? "filter-only" : "bm25";
	const header = `search · ${sc.items.length} ${sc.items.length === 1 ? "result" : "results"} · ${modeLabel}`;

	const sections: Array<string | null> = [header];
	if (sc.items.length > 0) {
		sections.push("", sc.items.map(renderRow).join("\n\n"));
	}
	const cursor = formatCursor(sc.nextCursor);
	if (cursor) sections.push("", cursor);
	const metaLine = formatMeta(meta);
	if (metaLine) sections.push("", metaLine);

	return joinLines(sections);
}

function renderRow(row: SearchResult): string {
	const scoreFrag = `(score ${formatScore(row.score)})`;
	const lines: string[] = [];

	if (row.anchor_kind === "heading") {
		lines.push(`${formatFileHeading(row.file, row.heading_path)}  ${scoreFrag}`);
		lines.push(`  id: ${row.stable_id}`);
	} else {
		lines.push(`${formatFileHeading(row.file)} · ${row.anchor_kind}  ${scoreFrag}`);
	}

	const snippet = singleLine(row.snippet);
	// Label so vault content starting with `id: h:…` can't be mistaken
	// for the `  id: ${stable_id}` line emitted above.
	if (snippet.length > 0) lines.push(`  snippet: ${snippet}`);

	return lines.join("\n");
}

function formatScore(n: number): string {
	return n.toFixed(2);
}
