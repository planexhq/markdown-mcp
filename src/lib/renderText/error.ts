/**
 * Prose renderer for `VaultError` envelopes. Fires from `toolErrorEnvelope`
 * (`src/lib/error.ts`) when `isProseOnly()` is true — composes a labeled
 * line per code-specific field so agents reading the prose channel can
 * recover load-bearing data (candidates, progress, retry_after_ms,
 * limit_bytes/actual_bytes, reason, requested_stable_id) that the default
 * `message + suggestion` form drops.
 */

import type { HeadingCandidate, IndexWarmingProgress, MetaEnvelope, VaultError } from "../../types.js";
import { formatHeadingPath, formatMeta, joinLines, sanitizePathForProse } from "./_shared.js";

// Mirrors VaultError's code-specific optional slots set by the envelope
// builders in `src/lib/error.ts` (`fileTooLargeEnvelope`,
// `parseErrorPayload`, etc.) — drift here drops fields silently
// since `--prose-only` also suppresses `structuredContent`.
const SCALAR_ERROR_FIELDS = [
	"param",
	"reason",
	"cause",
	"requested_stable_id",
	"stable_id_status",
	"line",
	"column",
	"limit_bytes",
	"actual_bytes",
	"retry_after_ms",
	"expected",
	"suggest",
] as const;

export function renderError(err: VaultError, meta: MetaEnvelope): string {
	const sections: Array<string | null> = [`error · ${err.code}`, "", sanitizePathForProse(err.message)];

	if (err.suggestion !== undefined) sections.push("", sanitizePathForProse(err.suggestion));

	const fields = renderCodeSpecificFields(err);
	if (fields.length > 0) sections.push("", ...fields);

	const metaLine = formatMeta(meta);
	if (metaLine !== null) sections.push("", metaLine);

	return joinLines(sections);
}

function renderCodeSpecificFields(err: VaultError): string[] {
	const lines: string[] = [];

	for (const field of SCALAR_ERROR_FIELDS) {
		const value = err[field];
		if (value === undefined) continue;
		if (typeof value === "string") {
			lines.push(`${field}: ${sanitizePathForProse(value)}`);
		} else if (typeof value === "number") {
			lines.push(`${field}: ${value}`);
		} else if (Array.isArray(value)) {
			// `FilterSyntaxError.suggest` is the only `string[]` field in
			// `SCALAR_ERROR_FIELDS`; scalar-only handling would silently drop it.
			const stringItems = value.filter((item): item is string => typeof item === "string");
			if (stringItems.length > 0) {
				lines.push(`${field}:`);
				for (const item of stringItems) lines.push(`  - ${sanitizePathForProse(item)}`);
			}
		}
	}

	const progress = err.progress;
	if (isProgress(progress)) {
		lines.push(
			`progress.files_indexed: ${progress.files_indexed}`,
			`progress.files_total_estimate: ${progress.files_total_estimate}`,
			`progress.phase: ${progress.phase}`,
		);
	}

	const candidates = err.candidates;
	if (Array.isArray(candidates) && candidates.length > 0) {
		lines.push(`candidates (${candidates.length}):`);
		for (const c of candidates) lines.push(formatCandidate(c));
	}

	return lines;
}

function formatCandidate(c: HeadingCandidate): string {
	// formatHeadingPath escapes literal `›` so it stays distinct from our separator.
	const headingPart = formatHeadingPath(c.heading_path);
	const scorePart = typeof c.score === "number" ? `  (score ${c.score.toFixed(2)})` : "";
	return `  - ${headingPart}  id: ${c.stable_id}${scorePart}`;
}

function isProgress(v: unknown): v is IndexWarmingProgress {
	return (
		typeof v === "object" &&
		v !== null &&
		typeof (v as { files_indexed?: unknown }).files_indexed === "number" &&
		typeof (v as { files_total_estimate?: unknown }).files_total_estimate === "number" &&
		typeof (v as { phase?: unknown }).phase === "string"
	);
}
