// Vault surface always emits `/`-form paths to clients (Brief D8); used
// also by test mocks whose predicates key on POSIX paths.
import { sep } from "node:path";

export function toPosix(p: string): string {
	return sep === "/" ? p : p.split(sep).join("/");
}
