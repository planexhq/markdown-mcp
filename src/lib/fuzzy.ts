/**
 * `stable-id-fuzzy-v1` — durable stale-ID recovery (D32 confidence-gated).
 *
 * Pure scoring against `HeadingMeta[]` (current headings of the file)
 * and one {@link HeadingHistoryRow} (the retired heading's last-known
 * state). The IndexHandle queries `heading_history` for the row; this
 * module makes the recovery decision.
 *
 * Confidence-gating partition rule:
 *   1. Split `currentHeadings` into `text_match` (heading whose
 *      normalized text equals the history's last text) and
 *      `no_text_match` (everything else).
 *   2. If `text_match` is empty → `primary: null`. The caller emits
 *      `HEADING_NOT_FOUND` with up to 3 structural-proximity candidates
 *      from `no_text_match` so the agent has navigation hints. A sibling-
 *      slot match without text identity is NOT enough confidence to
 *      surface as the recovered heading (counter-example: rename-and-
 *      reorder would otherwise pick the heading occupying the old slot
 *      whose text bears no relation to the retired one).
 *   3. Otherwise `primary` is the highest-scoring `text_match`;
 *      `others` is the remaining `text_match` plus top `no_text_match`
 *      by structural proximity, capped at 3.
 *
 * Score breakdown (per candidate):
 *   +1.0  text identity (`pathText` === history `last_heading_text`)
 *   +0.5  exact structural-path match
 *   +0.25 * (common-prefix segments / max segments)
 *   +0.1  ancestor-or-descendant relation
 *
 * Maximum: 1.85 (rename-only case — text identity + same slot).
 * Algorithm id `stable-id-fuzzy-v1` is published in
 * `_meta.fuzzy_algorithm` whenever recovery fires.
 */

import { type HeadingMeta, normalizeHeadingText } from "./parser.js";

/**
 * One row of the `heading_history` table — the per-retirement snapshot
 * the scanner writes when a heading no longer appears in a file's
 * outline (D32 retirement-diff write rule).
 */
export interface HeadingHistoryRow {
	file: string;
	stable_id: string;
	last_heading_text: string;
	last_heading_path_json: string;
	last_structural_path: string;
	last_range_start: number;
	last_range_end: number;
	last_seen_mtime: number;
	retired_at_mtime: number;
}

/** A scored fuzzy-recovery candidate. */
export interface ScoredCandidate {
	heading: HeadingMeta;
	score: number;
}

/** Output of {@link recoverStaleStableId}. */
export interface FuzzyRecoveryResult {
	/** Primary recovered heading; `null` when text identity is unrecoverable. */
	primary: ScoredCandidate | null;
	/** Up to 3 additional candidates (D32). */
	others: ScoredCandidate[];
}

export interface RecoveryInput {
	history: HeadingHistoryRow;
	currentHeadings: ReadonlyArray<HeadingMeta>;
}

/**
 * Recover a stale `stable_id` against the current outline using the
 * retired heading's history row. See module docstring for the partition
 * rule + scoring formula.
 */
export function recoverStaleStableId({ history, currentHeadings }: RecoveryInput): FuzzyRecoveryResult {
	if (currentHeadings.length === 0) {
		return { primary: null, others: [] };
	}

	const histText = normalizeHeadingText(history.last_heading_text);
	const histStruct = history.last_structural_path;

	const textMatch: HeadingMeta[] = [];
	const noTextMatch: HeadingMeta[] = [];
	for (const h of currentHeadings) {
		if (normalizeHeadingText(h.pathText) === histText) {
			textMatch.push(h);
		} else {
			noTextMatch.push(h);
		}
	}

	if (textMatch.length === 0) {
		const ranked = scoreCandidates(noTextMatch, histStruct, /* hasText */ false);
		return { primary: null, others: ranked.slice(0, 3) };
	}

	const scoredText = scoreCandidates(textMatch, histStruct, /* hasText */ true);
	const primary = scoredText[0] ?? null;
	const remainingText = scoredText.slice(1);
	const otherSlotCount = Math.max(0, 3 - remainingText.length);
	const scoredNoText = scoreCandidates(noTextMatch, histStruct, /* hasText */ false).slice(0, otherSlotCount);
	const others = [...remainingText, ...scoredNoText].slice(0, 3);
	return { primary, others };
}

function scoreCandidates(
	headings: ReadonlyArray<HeadingMeta>,
	histStruct: string,
	hasText: boolean,
): ScoredCandidate[] {
	const scored = headings.map((h) => ({ heading: h, score: computeScore(h, histStruct, hasText) }));
	scored.sort((a, b) => b.score - a.score);
	return scored;
}

function computeScore(h: HeadingMeta, histStruct: string, hasText: boolean): number {
	let score = 0;
	if (hasText) score += 1.0;
	if (h.structuralPath === histStruct) score += 0.5;
	score += 0.25 * commonPrefixRatio(h.structuralPath, histStruct);
	if (isAncestorOrEqual(h.structuralPath, histStruct) || isAncestorOrEqual(histStruct, h.structuralPath)) {
		score += 0.1;
	}
	return roundScore(score);
}

/**
 * Round to 3 decimals to keep `score` deterministic across platforms;
 * float arithmetic on the same algorithm should be bit-identical, but
 * a tiny rounding step makes test assertions robust.
 */
function roundScore(value: number): number {
	return Math.round(value * 1000) / 1000;
}

function commonPrefixRatio(a: string, b: string): number {
	const segsA = splitSegments(a);
	const segsB = splitSegments(b);
	const maxLen = Math.max(segsA.length, segsB.length);
	if (maxLen === 0) return 0;
	const minLen = Math.min(segsA.length, segsB.length);
	let common = 0;
	for (let i = 0; i < minLen; i++) {
		if (segsA[i] === segsB[i]) common++;
		else break;
	}
	return common / maxLen;
}

function splitSegments(p: string): string[] {
	return p.split("/").filter((s) => s.length > 0);
}

/** True iff `a` is equal to `b` OR `b` strictly contains `a` as an ancestor (i.e., `a/...` prefix of `b`). */
function isAncestorOrEqual(a: string, b: string): boolean {
	if (a === b) return true;
	return b.startsWith(`${a}/`);
}

/** Algorithm id stamped on `_meta.fuzzy_algorithm`. */
export const FUZZY_ALGORITHM_ID = "stable-id-fuzzy-v1";
