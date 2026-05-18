import type { BigIntStats } from "node:fs";

/**
 * Build a fully-methoded synthetic `BigIntStats` for serverLock tests.
 * `kindOf` in `src/lib/serverLock.ts` walks `isSymbolicLink → isDirectory
 * → isFIFO → isBlockDevice → isCharacterDevice → isSocket`; the round-49
 * post-open error log calls it unconditionally on its lstat result. If
 * an inline literal omits a predicate, the test throws TypeError before
 * the asserted sentinel ever returns. All predicates default to `false`;
 * `ino`/`dev` default to `1n` (a valid non-zero inode for "ordinary
 * regular file" baselines).
 */
export function makeBigIntStats(overrides: {
	isFile?: boolean;
	isSymbolicLink?: boolean;
	isDirectory?: boolean;
	isFIFO?: boolean;
	isBlockDevice?: boolean;
	isCharacterDevice?: boolean;
	isSocket?: boolean;
	ino?: bigint;
	dev?: bigint;
}): BigIntStats {
	return {
		isFile: () => overrides.isFile ?? false,
		isSymbolicLink: () => overrides.isSymbolicLink ?? false,
		isDirectory: () => overrides.isDirectory ?? false,
		isFIFO: () => overrides.isFIFO ?? false,
		isBlockDevice: () => overrides.isBlockDevice ?? false,
		isCharacterDevice: () => overrides.isCharacterDevice ?? false,
		isSocket: () => overrides.isSocket ?? false,
		ino: overrides.ino ?? 1n,
		dev: overrides.dev ?? 1n,
	} as unknown as BigIntStats;
}
