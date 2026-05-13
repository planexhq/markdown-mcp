/**
 * Prose renderer for `get_links` output.
 *
 * Narrowing-miss case omits the `anchor:` line entirely (round-8 rule)
 * so the agent can distinguish "narrowing found nothing" from "anchor
 * resolved but had no links."
 */

import type { GetLinksResult, IncomingLink, MetaEnvelope, OutgoingLinkRow, ResolvedAnchor } from "../../types.js";
import {
	extractAnchorBody,
	formatAliasLabel,
	formatCursor,
	formatHeadingPath,
	formatIncomingSource,
	formatMeta,
	formatOutgoingTarget,
	joinLines,
	sanitizePathForProse,
} from "./_shared.js";

export function renderLinks(sc: GetLinksResult, meta: MetaEnvelope): string {
	const header = "links";
	const anchorLine = renderAnchor(sc.resolved_anchor);

	const sections: Array<string | null> = [header];
	if (anchorLine) sections.push(anchorLine);

	const outgoing = sc.outgoing;
	const incoming = sc.incoming;
	const hasOutgoing = outgoing !== undefined;
	const hasIncoming = incoming !== undefined;

	if (hasOutgoing) {
		sections.push("", `outgoing (${outgoing.length}):`);
		for (const row of outgoing) sections.push(renderOutgoingRow(row));
	}
	if (hasIncoming) {
		sections.push("", `incoming (${incoming.length}):`);
		for (const row of incoming) sections.push(renderIncomingRow(row));
	}

	const cursor = formatCursor(sc.nextCursor);
	if (cursor) sections.push("", cursor);

	const metaLine = formatMeta(meta);
	if (metaLine) sections.push("", metaLine);

	return joinLines(sections);
}

function renderAnchor(anchor: ResolvedAnchor | undefined): string | null {
	if (!anchor) return null;
	// Empty `heading_path: []` is the preamble narrowing marker
	// (`buildResolvedAnchor` in getLinks.ts). Distinguish from absent so the
	// agent sees the scope choice instead of a bare `anchor:` line.
	const pathFrag =
		anchor.heading_path === undefined
			? ""
			: anchor.heading_path.length === 0
				? " · preamble"
				: ` · ${formatHeadingPath(anchor.heading_path)}`;
	const idFrag = anchor.stable_id ? ` · id ${anchor.stable_id}` : "";
	const statusFrag =
		anchor.stable_id_status === "stale" && anchor.requested_stable_id
			? `  (stale, recovered from ${anchor.requested_stable_id})`
			: anchor.stable_id_status === "stale"
				? "  (stale, recovered)"
				: "";
	return `anchor:${pathFrag}${idFrag}${statusFrag}`;
}

function renderOutgoingRow(row: OutgoingLinkRow): string {
	const target = formatOutgoingTarget(row);
	const labelFrag = formatAliasLabel(row.alias);
	const embedFrag = row.is_embed ? "  embed" : "";
	const source =
		row.source_heading_path && row.source_heading_path.length > 0
			? `  (from ${formatHeadingPath(row.source_heading_path)})`
			: "";
	return `  → ${target}${labelFrag}${embedFrag}  (ord ${row.link_ordinal})${source}`;
}

function renderIncomingRow(row: IncomingLink): string {
	const source = formatIncomingSource(row);
	// `#anchor` disambiguates target precision (`#Heading` vs `#^block` vs
	// file-level) when two backlinks share the same source heading.
	// `sanitizePathForProse` defends against CR forgery: `raw_target` is
	// agent-controlled and WIKILINK_RE admits every byte except `]` and
	// `\n`, so an unsanitized CR would forge a `next: …` cursor line.
	const anchorBody = extractAnchorBody(row.raw_target);
	const targetFrag = anchorBody ? `  → ${sanitizePathForProse(anchorBody)}` : "";
	const labelFrag = formatAliasLabel(row.alias);
	const embedFrag = row.is_embed ? "  embed" : "";
	const idFrag = row.source_stable_id ? `  [${row.source_stable_id}]` : "";
	return `  ← ${source}${targetFrag}${labelFrag}${embedFrag}  (ord ${row.link_ordinal})${idFrag}`;
}
