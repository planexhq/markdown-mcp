import type { IndexState } from "../types.js";

/**
 * Stderr log fragment emitted when {@link chooseStartupState} forces a
 * cold rescan because of a policy mismatch. Exported so tests assert
 * against the same string the production code emits — if the copy ever
 * changes, both move together.
 */
export const POLICY_MISMATCH_LOG_FRAGMENT = "--include-hidden policy changed since last run";

/**
 * Inputs to {@link computePolicyMismatch}. Two distinct signals collapse
 * into one boolean: either indicates the persisted index population
 * doesn't match the running `--include-hidden` flag.
 */
export interface PolicyMismatchInputs {
	preexisted: boolean;
	scanComplete: boolean;
	/** Persisted policy of the LAST CLEANLY-FINALIZED snapshot. `null` for
	 * fresh DBs or pre-column upgrades. */
	includeHiddenPolicy: boolean | null;
	/** Policy of an IN-FLIGHT (interrupted) scan. `null` when no scan is
	 * in progress / last scan finalized cleanly. */
	inflightIncludeHidden: boolean | null;
	argIncludeHidden: boolean;
}

/**
 * `true` when either signal indicates the persisted index doesn't match
 * the running `--include-hidden` flag and a cold rescan is required:
 *
 * 1. **Last-clean mismatch**: the persisted last-clean policy differs
 *    from `args.includeHidden`. Catches the simple toggle case. NULL
 *    `includeHiddenPolicy` coerces to `false` (the legacy default) so
 *    upgrades from a pre-column cache opened with the flag flip are
 *    caught.
 * 2. **Interrupted-scan mismatch**: a scan was interrupted
 *    (`scan_complete=false`) under a policy that differs from
 *    `args.includeHidden`. The persisted last-clean policy can match
 *    `args.includeHidden` (revert-during-flip case) and still leave the
 *    DB contaminated by an unfinalized scan; without this signal,
 *    `chooseStartupState` would return warm via the
 *    `(preexisted && everComplete)` branch and serve the contaminated
 *    snapshot until reconcile drained.
 *
 * `preexisted=false` short-circuits to false; a fresh DB forces cold via
 * the rest of `chooseStartupState`.
 */
export function computePolicyMismatch(inputs: PolicyMismatchInputs): boolean {
	if (!inputs.preexisted) return false;
	const persisted = inputs.includeHiddenPolicy ?? false;
	if (persisted !== inputs.argIncludeHidden) return true;
	if (inputs.scanComplete) return false;
	if (inputs.inflightIncludeHidden === null) return false;
	return inputs.inflightIncludeHidden !== inputs.argIncludeHidden;
}

/**
 * Startup state decision. Warm requires `(scan_complete OR ever_complete)`
 * AND `fileCount > 0`. The two persisted flags answer different questions:
 * `scan_complete` = "did the most recent scan finish cleanly?";
 * `ever_complete` = "has any scan ever finished cleanly?" (one-way-set on
 * the first clean finish, never reset). Without the second flag, a partial
 * first scan (rows present but no clean finish ever) would advertise
 * itself as warm, silently truncating vault-wide search to the indexed
 * subset.
 */
export interface StartupStateInputs {
	preexisted: boolean;
	scanComplete: boolean;
	everComplete: boolean;
	fileCount: number;
	/**
	 * `true` when the persisted `--include-hidden` policy differs from this
	 * run's policy. The prior snapshot was internally consistent for its
	 * own policy but contains the wrong row population for this run
	 * (extra hidden rows when off→on→off, missing hidden rows when off→on),
	 * so vault-wide tools must return INDEX_WARMING until reconcile
	 * realigns the index. Forces cold regardless of `scan_complete` /
	 * `ever_complete`.
	 */
	policyMismatch?: boolean;
}

export interface StartupStateDecision {
	state: IndexState;
	log: string | null;
}

export function chooseStartupState(inputs: StartupStateInputs): StartupStateDecision {
	if (inputs.preexisted && inputs.policyMismatch === true) {
		return {
			state: "cold",
			log: `vault-mcp index: ${POLICY_MISMATCH_LOG_FRAGMENT}; rebuilding (${inputs.fileCount} prior rows).`,
		};
	}
	if (inputs.preexisted && inputs.scanComplete) {
		return {
			state: "warm",
			log: `vault-mcp index: warm (preexisted; ${inputs.fileCount} files indexed); reconciling on startup.`,
		};
	}
	// SIGTERM mid-reconcile or failed-subtree warm restart: prior clean scan
	// existed (`ever_complete=true`), `scan_complete=false`. On-disk
	// fragments serve a usable snapshot. Mirrors scanner.ts's
	// failed-subtree-warm-restart branch.
	//
	// Empty-vault case (`fileCount=0`) also resolves to warm: the prior
	// clean scan indexed zero files, the persisted snapshot is honest
	// about that, and async reconcile picks up any files added during
	// the interruption. Serving an empty snapshot beats wedging vault-
	// wide tools at INDEX_WARMING for an empty vault.
	if (inputs.preexisted && inputs.everComplete) {
		return {
			state: "warm",
			log: `vault-mcp index: warm (preexisted; ${inputs.fileCount} files indexed; last scan incomplete); reconciling on startup.`,
		};
	}
	// Partial first scan: rows exist but no clean scan has ever completed.
	// Serving would silently truncate vault-wide search to the indexed
	// subset. Stay cold so INDEX_WARMING gates vault-wide tools until the
	// next clean finish (mirrors scanner.ts's cold/warming-start branch).
	if (inputs.preexisted && inputs.fileCount > 0) {
		return {
			state: "cold",
			log: `vault-mcp index: preexisted DB with ${inputs.fileCount} partial rows from an interrupted first scan; rebuilding.`,
		};
	}
	if (inputs.preexisted) {
		return { state: "cold", log: "vault-mcp index: preexisted DB found but no indexed rows; starting cold scan." };
	}
	return { state: "cold", log: null };
}
