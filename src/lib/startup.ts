import type { IndexState } from "../types.js";

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
}

export interface StartupStateDecision {
	state: IndexState;
	log: string | null;
}

export function chooseStartupState(inputs: StartupStateInputs): StartupStateDecision {
	if (inputs.preexisted && inputs.scanComplete) {
		return {
			state: "warm",
			log: `vault-mcp index: warm (preexisted; ${inputs.fileCount} files indexed); reconciling on startup.`,
		};
	}
	// SIGTERM mid-reconcile or failed-subtree warm restart: prior clean scan
	// existed (`ever_complete=true`), `scan_complete=false`, but on-disk
	// fragments still serve a usable snapshot. Mirrors scanner.ts's
	// failed-subtree-warm-restart branch.
	if (inputs.preexisted && inputs.everComplete && inputs.fileCount > 0) {
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
