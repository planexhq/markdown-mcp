/**
 * Process-wide flag for `--prose-only` mode. Mirrors `setFsCaseInsensitive`
 * in `hiddenPath.ts` — set once at startup, read by leaf utilities
 * (`successEnvelope` / `toolErrorEnvelope`). Per-process state is correct
 * because the server serves one vault per process AND the flag is
 * operator-chosen at server-spawn time, never toggled mid-call.
 */

let proseOnly = false;

export function setProseOnly(value: boolean): void {
	proseOnly = value;
}

/** Visible for testing only. */
export function resetProseOnlyForTest(): void {
	proseOnly = false;
}

export function isProseOnly(): boolean {
	return proseOnly;
}
