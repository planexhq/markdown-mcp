import { vi } from "vitest";

import type { IndexHandle } from "../../src/lib/index/IndexHandle.js";
import type { IndexState } from "../../src/types.js";

/**
 * Minimal IndexHandle stub for tests that only need to control
 * `getStatus()`. Pass `methods` to mix in extra mocks (e.g.
 * `getHistoryRow`, `searchQueryMode`) — they spread over the default
 * `getStatus` mock. The final `as unknown as IndexHandle` cast skips
 * per-method type checks, mirroring the project's existing test
 * pattern (see `search.warming.test.ts`).
 */
export function stubIndex(state: IndexState, filesIndexed: number, methods?: Record<string, unknown>): IndexHandle {
	return {
		getStatus: vi.fn().mockReturnValue({ state, files_indexed: filesIndexed }),
		...methods,
	} as unknown as IndexHandle;
}
