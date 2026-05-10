import { join } from "node:path";

import { INDEX_DIR_NAME } from "../../src/lib/hiddenPath.js";
import { lockFileNameForPid } from "../../src/lib/serverLock.js";

export function indexDir(vaultPath: string): string {
	return join(vaultPath, INDEX_DIR_NAME);
}

export function ownLockPath(vaultPath: string, pid: number): string {
	return join(indexDir(vaultPath), lockFileNameForPid(pid));
}
