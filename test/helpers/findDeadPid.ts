/**
 * Pick a PID that `process.kill(p, 0)` reports as ESRCH, so
 * `isProcessAlive` returns false. Scans from a high number downwards;
 * on macOS the PID range maxes near 99999, on Linux it goes much
 * higher — either way we find one quickly.
 */
export function findDeadPid(): number {
	for (let pid = 99_999; pid > 1_000; pid--) {
		try {
			process.kill(pid, 0);
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === "ESRCH") return pid;
		}
	}
	throw new Error("could not find a dead PID");
}
