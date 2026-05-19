import type { IndexState } from "../types.js";

/**
 * Stderr log fragment emitted when {@link chooseStartupState} forces a
 * cold rescan because of a policy mismatch. Exported so tests assert
 * against the same string the production code emits — if the copy ever
 * changes, both move together.
 */
export const POLICY_MISMATCH_LOG_FRAGMENT = "--include-hidden policy changed since last run";

/**
 * Inputs to {@link computePolicyMismatch}. Multiple signals collapse into
 * one boolean: any indicates the persisted index population doesn't match
 * this run's flag set.
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
	/**
	 * D47 (optional, defaults to `null`) — persisted `VAULT_EXTENSIONS`
	 * snapshot (sorted lowercase comma-joined) from the last cleanly-
	 * finalized scan, or `null` for pre-D47 caches. Optional so pre-D47
	 * test fixtures that don't exercise the extension-mismatch axis can
	 * keep their existing call shape; production callers always supply
	 * both this and `argVaultExtensions`.
	 */
	vaultExtensionsPolicy?: string | null;
	/** D47 (optional, defaults to `"md"`) — `VAULT_EXTENSIONS` snapshot
	 * for THIS run, canonicalized the same way (sorted lowercase
	 * comma-joined). Defaulting to `"md"` matches the pre-D47 cache
	 * default so an omitted field never triggers a spurious mismatch. */
	argVaultExtensions?: string;
}

/**
 * `true` when any signal indicates the persisted index doesn't match
 * this run's flags and a cold rescan is required:
 *
 * 1. **Last-clean `--include-hidden` mismatch**: persisted policy differs
 *    from `args.includeHidden`. NULL coerces to `false` (legacy default)
 *    so upgrades opened with the flag flip are caught.
 * 2. **Interrupted-scan `--include-hidden` mismatch**: a scan was
 *    interrupted (`scan_complete=false`) under a policy differing from
 *    `args.includeHidden`. Without this signal, `chooseStartupState`
 *    would return warm via `(preexisted && everComplete)` and serve a
 *    contaminated snapshot.
 * 3. **D47 — `VAULT_EXTENSIONS` mismatch**: the persisted extension list
 *    differs from this run's. Symmetric in both directions: adding `yaml`
 *    needs to index previously-skipped files; removing `yaml` needs to
 *    prune existing YAML rows from search. NULL coerces to `"md"` (the
 *    pre-D47 default extension), so an upgrader opening a default-built
 *    cache with `VAULT_EXTENSIONS=md,yaml,yml` is caught.
 *
 * `preexisted=false` short-circuits to false; a fresh DB forces cold via
 * the rest of `chooseStartupState`.
 */
export function computePolicyMismatch(inputs: PolicyMismatchInputs): boolean {
	if (!inputs.preexisted) return false;
	const persisted = inputs.includeHiddenPolicy ?? false;
	if (persisted !== inputs.argIncludeHidden) return true;
	const persistedExt = inputs.vaultExtensionsPolicy ?? "md";
	const argExt = inputs.argVaultExtensions ?? "md";
	if (persistedExt !== argExt) return true;
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
			log: `markdown-mcp index: ${POLICY_MISMATCH_LOG_FRAGMENT}; rebuilding (${inputs.fileCount} prior rows).`,
		};
	}
	if (inputs.preexisted && inputs.scanComplete) {
		return {
			state: "warm",
			log: `markdown-mcp index: warm (preexisted; ${inputs.fileCount} files indexed); reconciling on startup.`,
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
			log: `markdown-mcp index: warm (preexisted; ${inputs.fileCount} files indexed; last scan incomplete); reconciling on startup.`,
		};
	}
	// Partial first scan: rows exist but no clean scan has ever completed.
	// Serving would silently truncate vault-wide search to the indexed
	// subset. Stay cold so INDEX_WARMING gates vault-wide tools until the
	// next clean finish (mirrors scanner.ts's cold/warming-start branch).
	if (inputs.preexisted && inputs.fileCount > 0) {
		return {
			state: "cold",
			log: `markdown-mcp index: preexisted DB with ${inputs.fileCount} partial rows from an interrupted first scan; rebuilding.`,
		};
	}
	if (inputs.preexisted) {
		return { state: "cold", log: "markdown-mcp index: preexisted DB found but no indexed rows; starting cold scan." };
	}
	return { state: "cold", log: null };
}
