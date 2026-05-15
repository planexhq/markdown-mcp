import { vi } from "vitest";

import type { IndexHandle } from "../../src/lib/index/IndexHandle.js";
import type { IndexState, IndexStatus, IndexStatusSnapshot } from "../../src/types.js";

/**
 * Minimal IndexHandle stub for tests that only need to control
 * `getStatus()` / `getStatusSnapshot()`. Pass `methods` to mix in extra
 * mocks (e.g. `getHistoryRow`, `searchQueryMode`) — they spread over the
 * defaults. The final `as unknown as IndexHandle` cast skips per-method
 * type checks, mirroring the project's existing test pattern (see
 * `search.warming.test.ts`).
 *
 * `getStatusSnapshot()` is synthesized from `getStatus()` +
 * `getEverComplete()` unless overridden — so existing tests overriding
 * either piece continue to work without rewrites.
 */
export function stubIndex(state: IndexState, filesIndexed: number, methods?: Record<string, unknown>): IndexHandle {
	const stub: Record<string, unknown> = {
		getStatus: vi.fn().mockReturnValue({ state, files_indexed: filesIndexed }),
		getEverComplete: vi.fn().mockReturnValue(false),
		...methods,
	};
	if (typeof stub.getStatusSnapshot !== "function") {
		stub.getStatusSnapshot = (): IndexStatusSnapshot => {
			const status = (stub.getStatus as () => IndexStatus)();
			const everComplete = (stub.getEverComplete as () => boolean)();
			return { ...status, ever_complete: everComplete };
		};
	}
	return stub as unknown as IndexHandle;
}
