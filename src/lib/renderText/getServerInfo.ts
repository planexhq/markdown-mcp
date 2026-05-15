/**
 * Prose renderer for `get_server_info` output (D37). Sectioned format
 * mirrors `renderMetadata` — each top-level group becomes a `## Header`
 * with bullet lines. Identity fields are short atoms so they render
 * cleanly in a chat UI without further sanitization (the underlying
 * `root_hash` is hex, version is semver, etc.; no untrusted text reaches
 * this surface).
 */

import type { GetServerInfoResult, MetaEnvelope } from "../../types.js";
import { formatMeta, joinLines } from "./_shared.js";

export function renderServerInfo(sc: GetServerInfoResult, meta: MetaEnvelope): string {
	const sections: Array<string | null> = [
		"server_info",
		"",
		"## Server",
		...bulletEntries(sc.server),
		"",
		"## Vault",
		...bulletEntries(sc.vault),
		"",
		"## Index",
		...renderIndexSection(sc.index),
		"",
		"## Algorithms",
		...bulletEntries(sc.algorithms),
		"",
		"## Capabilities",
		`- tools: ${sc.capabilities.tools.join(", ")}`,
		`- resources: ${sc.capabilities.resources.join(", ")}`,
	];

	const metaLine = formatMeta(meta);
	if (metaLine) {
		sections.push("", metaLine);
	}

	return joinLines(sections);
}

// Param typed as `object` (not `Record<string, unknown>`): TS won't
// structurally widen concrete interfaces to a record-with-index-sig.
function bulletEntries(obj: object): string[] {
	return Object.entries(obj).map(([key, value]) => {
		const rendered = Array.isArray(value) ? value.join(", ") : `${value}`;
		return `- ${key}: ${rendered}`;
	});
}

function renderIndexSection(index: GetServerInfoResult["index"]): string[] {
	// `index: null` is the W1-stub / misconfig signal; surface it honestly
	// instead of letting the renderer fall through to a phantom warm state.
	if (index === null) return ["- index: (not configured)"];
	const lines = bulletEntries({
		schema_version: index.schema_version,
		state: index.state,
		files_indexed: index.files_indexed,
		ever_complete: index.ever_complete,
	});
	if (index.last_scan_finished_at !== undefined) {
		lines.push(`- last_scan_finished_at: ${index.last_scan_finished_at}`);
	}
	if (index.degraded !== undefined) {
		lines.push(
			`- degraded.failed_subtrees_present: ${index.degraded.failed_subtrees_present}`,
			`- degraded.pending_retries: ${index.degraded.pending_retries}`,
		);
	}
	return lines;
}
