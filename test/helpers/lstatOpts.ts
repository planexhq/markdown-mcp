import type { StatOptions } from "node:fs";

/**
 * Discriminates Win32 `lstat({bigint: true})` from no-opts `lstat()`. Win32
 * code paths (openNoFollow's pre-open + post-open identity check, serverLock's
 * preLstat) use the BigInt form for 64-bit dev/ino precision; same-path
 * disambiguation lstats (readSource's post-error branch, statEntry's reprobe)
 * use no opts. Mocks that intercept the disambiguation case must pass the
 * BigInt form through to the real FS, otherwise they short-circuit the
 * BigInt-call path before the test's intended branch runs.
 */
export function isBigIntLstat(opts: unknown): opts is { bigint: true } {
	return typeof opts === "object" && opts !== null && (opts as StatOptions).bigint === true;
}
