import type { IndexOutcome } from "../../src/lib/index/scanner.js";
import { WriteCoordinator } from "../../src/lib/writeCoordinator.js";

/**
 * Wraps `WriteCoordinator` to fire `hook` once the inner task for
 * `targetRel` resolves with `parse_failed`. The hook is awaited so
 * fs-touching cleanups and `setImmediate`-deferred recoveries both
 * compose correctly. Per-file FIFO ordering is inherited from the base
 * coordinator.
 */
export class FailureHookCoordinator extends WriteCoordinator {
	constructor(
		private readonly targetRel: string,
		private readonly hook: () => void | Promise<void>,
	) {
		super();
	}

	override async enqueue<T>(rel: string, task: () => Promise<T>): Promise<T> {
		const result = await super.enqueue(rel, task);
		if (rel === this.targetRel && (result as unknown as IndexOutcome) === "parse_failed") {
			await this.hook();
		}
		return result;
	}
}
