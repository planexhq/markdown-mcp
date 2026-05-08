/**
 * Per-file FIFO for index writes. Scanner / watcher / merkle all enqueue
 * through `enqueue(file, task)`. Same-file tasks run in arrival order;
 * cross-file tasks run in parallel.
 *
 * Each task does its own stat at task-start, so the LAST-enqueued task
 * wins — by the time it runs, its stat is the freshest. This eliminates
 * the "scanner reads T0, user edits at T1, watcher commits T1, scanner
 * overwrites with T0" race that occurs whenever scanner and watcher run
 * concurrently (warm restart, in particular).
 */
export class WriteCoordinator {
	private chains = new Map<string, Promise<void>>();

	enqueue<T>(file: string, task: () => Promise<T>): Promise<T> {
		const prev = this.chains.get(file) ?? Promise.resolve();
		const next = prev.then(task);
		// `followup` is the chain link; absorbs errors so a failing task
		// doesn't poison subsequent tasks for this file.
		const followup = next.then(
			() => undefined,
			() => undefined,
		);
		this.chains.set(file, followup);
		void followup.finally(() => {
			if (this.chains.get(file) === followup) this.chains.delete(file);
		});
		return next;
	}

	/** Drain all in-flight chains. Used during shutdown so `replaceFile` /
	 * `removeFile` writes complete before `closeSqlite` runs.
	 *
	 * Single-pass: snapshots the chain set once and waits. Callers must
	 * stop the upstream event sources (chokidar, merkle interval) BEFORE
	 * drain, otherwise a task enqueued during the wait isn't included. */
	async drain(): Promise<void> {
		await Promise.allSettled([...this.chains.values()]);
	}

	/** True iff any per-file chain is currently active. Used by the
	 * scanner's pre-finalize re-drain loop to detect whether tasks
	 * landed during a `drain()` call (which is single-pass). */
	hasActiveChains(): boolean {
		return this.chains.size > 0;
	}
}
