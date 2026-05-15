/**
 * In-flight request counter with a bounded drain. Increments and
 * decrements are paired at the TRANSPORT boundary (incoming request →
 * `enter()`; outgoing response fully sent → `exit()`) so the count
 * spans the SDK's `handler(request) → transport.send(response)` chain
 * as a single unit — including the time `send` waits for stdout's
 * `drain` event under backpressure on a large reply.
 *
 * Tracking at the handler boundary is unsafe: the SDK's protocol
 * (`protocol.js:_onrequest`) awaits `handler(request)` first and THEN
 * awaits `transport.send(response)` in a separate `.then`. A drain
 * that observed `count === 0` between those two awaits would return
 * `"drained"` while the response was still queued in `stdout`'s
 * write buffer, and a subsequent `process.exit()` would truncate it.
 *
 * Drain semantics: resolves on the first count-equals-zero observation
 * after the call (or immediately if count is already zero on entry).
 * New `enter()` invocations arriving during a pending drain extend the
 * wait — the timeout bounds it under load.
 */
export interface InflightTracker {
	/** Current count of in-flight tracked operations. */
	size(): number;
	/** Increment the in-flight count. */
	enter(): void;
	/** Decrement the in-flight count; no-op if already at zero. */
	exit(): void;
	/** Resolve `"drained"` once count reaches 0 or `"timeout"` after `timeoutMs`. */
	drain(timeoutMs: number): Promise<"drained" | "timeout">;
}

export function createInflightTracker(): InflightTracker {
	let count = 0;
	const resolvers = new Set<() => void>();

	const fireZeroWaiters = (): void => {
		if (count !== 0) return;
		for (const resolve of resolvers) resolve();
		resolvers.clear();
	};

	return {
		size: () => count,
		enter: () => {
			count++;
		},
		exit: () => {
			if (count === 0) return;
			count--;
			if (count === 0) fireZeroWaiters();
		},
		drain: (timeoutMs: number): Promise<"drained" | "timeout"> => {
			if (count === 0) return Promise.resolve("drained");
			return new Promise<"drained" | "timeout">((resolve) => {
				let settled = false;
				const finish = (result: "drained" | "timeout"): void => {
					if (settled) return;
					settled = true;
					clearTimeout(timer);
					resolvers.delete(onZero);
					resolve(result);
				};
				const onZero = (): void => finish("drained");
				resolvers.add(onZero);
				const timer = setTimeout(() => finish("timeout"), timeoutMs);
			});
		},
	};
}
