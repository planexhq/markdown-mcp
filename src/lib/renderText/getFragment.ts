/**
 * Prose renderer for `get_fragment` output.
 *
 * The markdown `content` field passes through verbatim — nested markdown
 * (fenced code, wikilinks, embeds) reads naturally instead of surviving
 * as `\n`-escaped JSON string literals. Body and expanded-embed bodies
 * are wrapped in begin/end sentinels carrying a per-section 16-hex
 * crypto-random nonce (see {@link sentinelToken}) so an unbounded body
 * can't collide with the boundary AND can't bloat the output via dash
 * auto-extension.
 *
 * Heading-row stale recovery (D32) surfaces three address atoms on
 * dedicated lines: the resolved `id:`, the agent's `requested:` id, and
 * a `fuzzy_candidates` list — so the agent can confirm the recovery
 * target or pick an alternative.
 */

import { randomBytes } from "node:crypto";

import type { Embed, FragmentResult, MetaEnvelope, OutgoingLink } from "../../types.js";
import {
	formatAliasLabel,
	formatFileHeading,
	formatHeadingPath,
	formatMeta,
	formatOutgoingTarget,
	joinLines,
} from "./_shared.js";

export function renderFragment(sc: FragmentResult, meta: MetaEnvelope): string {
	const header = renderHeader(sc);
	const addressLines = renderAddressLines(sc);
	const body = sc.content;
	const linksSection = renderLinksSection(sc.outgoing_links, sc.embeds);
	const metaLine = formatMeta(meta);

	const sections: Array<string | null> = [header];
	for (const line of addressLines) sections.push(line);
	if (body.length > 0) {
		const [begin, end] = bodySentinels();
		sections.push("", begin, body, end);
	}
	if (linksSection) sections.push("", linksSection);
	if (metaLine) sections.push("", metaLine);

	return joinLines(sections);
}

function renderHeader(sc: FragmentResult): string {
	const tokens = `~${sc.bodyTokensApprox} tok`;
	switch (sc.anchor_kind) {
		case "heading":
			return `fragment · ${formatFileHeading(sc.file, sc.heading_path)}  (level ${sc.level}, ${tokens})`;
		case "preamble":
			return `fragment · ${formatFileHeading(sc.file)} · preamble  (${tokens})`;
		case "block": {
			const file = formatFileHeading(sc.file);
			const path = formatHeadingPath(sc.containing_heading_path);
			const containerLabel = path.length > 0 ? ` · ${path}` : "";
			return `fragment · ${file}${containerLabel} · block ^${sc.block_id}  (${tokens})`;
		}
		case "file":
			return `fragment · ${formatFileHeading(sc.file)} · whole file  (${tokens})`;
	}
}

function renderAddressLines(sc: FragmentResult): string[] {
	if (sc.anchor_kind === "block") {
		return sc.containing_stable_id ? [`container id: ${sc.containing_stable_id}`] : [];
	}
	if (sc.anchor_kind !== "heading") return [];

	const lines: string[] = [];
	if (sc.stable_id_status === "stale") {
		lines.push(`id: ${sc.stable_id}  (status: stale, recovered)`);
		if (sc.requested_stable_id) {
			lines.push(`requested: ${sc.requested_stable_id}`);
		}
		if (sc.fuzzy_candidates && sc.fuzzy_candidates.length > 0) {
			lines.push("fuzzy candidates:");
			for (const c of sc.fuzzy_candidates) {
				const path = formatHeadingPath(c.heading_path);
				lines.push(`  ${c.stable_id} · ${path}  (score ${c.score.toFixed(2)})`);
			}
		}
	} else {
		lines.push(`id: ${sc.stable_id}`);
	}
	return lines;
}

function renderLinksSection(outgoing: ReadonlyArray<OutgoingLink>, embeds: ReadonlyArray<Embed>): string | null {
	if (outgoing.length === 0 && embeds.length === 0) return null;

	const embedLabel = embeds.length === 1 ? "embed" : "embeds";
	const lines: string[] = [`— links (${outgoing.length} outgoing, ${embeds.length} ${embedLabel}) —`];

	for (const link of outgoing) {
		const target = formatOutgoingTarget(link);
		// `link_text` is `alias ?? rawTarget` per the wikilinks parser, so it
		// only carries human-meaningful display text when `alias` is set.
		const labelFrag = formatAliasLabel(link.alias);
		lines.push(`  → ${target}${labelFrag}  (ord ${link.link_ordinal})`);
	}

	if (embeds.length > 0) {
		if (outgoing.length > 0) lines.push("embeds:");
		for (const embed of embeds) {
			const target = formatOutgoingTarget(embed);
			lines.push(`  ${renderEmbedSummary(embed, target)}`);
			// Caller opted into `expand_embeds` and the transclusion succeeded
			// — emit the body inside explicit begin/end markers so the LLM can
			// see where the nested content starts and stops without relying on
			// indentation (expanded bodies routinely contain headings + fenced
			// code blocks whose semantics break under indentation).
			if (embed.expanded_content !== undefined) {
				const [begin, end] = embedSentinels(target);
				lines.push(begin);
				lines.push(embed.expanded_content);
				lines.push(end);
			}
		}
	}

	return lines.join("\n");
}

// 64-bit crypto-random per call. The 10 MB file cap fits ~357K
// candidate `--- end body XXXXXXXX… ---` lines in a hostile body —
// 32 bits is ~10⁻⁵ collision per render, 64 bits is ~10⁻¹⁴ — and the
// fixed length keeps the boundary at 36 bytes regardless of body size,
// so an unbounded body can't bloat `content[0].text` via boundary
// auto-extension.
function sentinelToken(): string {
	return randomBytes(8).toString("hex");
}

function bodySentinels(): [string, string] {
	const token = sentinelToken();
	return [`--- begin body ${token} ---`, `--- end body ${token} ---`];
}

function embedSentinels(target: string): [string, string] {
	const token = sentinelToken();
	return [`  --- begin embed: ${target} ${token} ---`, `  --- end embed ${token} ---`];
}

function renderEmbedSummary(embed: Embed, target: string): string {
	const tags: string[] = [embed.kind];
	if (embed.expanded) tags.push("expanded");
	else if (embed.resolved) tags.push("resolved");
	else tags.push("unresolved");
	if (embed.expansion_error) tags.push(embed.expansion_error);
	return `${target} · ${tags.join(" · ")}`;
}
