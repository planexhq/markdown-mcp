/**
 * Index lifecycle state machine. Centralized so the scanner, watcher,
 * and merkle reconciler all flip state through the same gate.
 *
 * Legal arcs (Brief §index status):
 *   cold → warming | warm
 *   warming → warm
 *   warm → reconciling | warm
 *   reconciling → warm
 *
 * Same-state transitions are no-ops, NOT errors — bootstrap paths can
 * idempotently call `setStatus(currentState)` without exception. The
 * `cold → warm` fast-path fires when the scanner finds a preexisting
 * complete DB and skips warming.
 *
 * The progress-shape constant lives here too so emitters don't
 * hand-roll `_meta.index_status.progress` and risk drift from the
 * documented contract.
 */

import type { IndexState } from "../types.js";

const LEGAL_TRANSITIONS: ReadonlyMap<IndexState, ReadonlySet<IndexState>> = new Map<IndexState, Set<IndexState>>([
	["cold", new Set<IndexState>(["cold", "warming", "warm"])],
	["warming", new Set<IndexState>(["warming", "warm"])],
	["warm", new Set<IndexState>(["warm", "reconciling"])],
	["reconciling", new Set<IndexState>(["reconciling", "warm"])],
]);

export class IllegalStateTransitionError extends Error {
	override readonly name = "IllegalStateTransitionError";
	readonly from: IndexState;
	readonly to: IndexState;
	constructor(from: IndexState, to: IndexState) {
		super(`Illegal index_status transition: ${from} → ${to}`);
		this.from = from;
		this.to = to;
	}
}

/**
 * Validate a state transition. Returns `next` on success; throws
 * {@link IllegalStateTransitionError} on illegal arcs. Same-state arcs
 * (`from === next`) always pass — bootstrap idempotency.
 */
export function transition(from: IndexState, next: IndexState): IndexState {
	const allowed = LEGAL_TRANSITIONS.get(from);
	if (!allowed?.has(next)) {
		throw new IllegalStateTransitionError(from, next);
	}
	return next;
}

export type IndexProgressPhase = "scanning" | "parsing" | "fts_populating";

export interface IndexProgress {
	files_indexed: number;
	files_total_estimate: number;
	phase: IndexProgressPhase;
}

/**
 * `true` when the index has a snapshot suitable for vault-wide lookups
 * (basename map, heading map, link rows). `cold` and `warming` return
 * `false` — their indexes are partial subsets of the eventual vault, so
 * resolving against them produces transient answers that flip post-warm.
 * `reconciling` returns `true` because the prior warm snapshot keeps
 * serving while the re-walk runs.
 */
export function isReadyForIndexLookup(state: IndexState): boolean {
	return state === "warm" || state === "reconciling";
}

/** Inverse of {@link isReadyForIndexLookup}. Vault-wide tools (search,
 * get_links, get_vault_tree) gate on this and return INDEX_WARMING. */
export function isIndexWarming(state: IndexState): boolean {
	return !isReadyForIndexLookup(state);
}
