/**
 * Externally-resolvable promise. Tests use this to gate one async
 * operation behind another (e.g., hold a reindex while issuing a
 * second event, then release).
 */
export function defer<T = void>(): { promise: Promise<T>; resolve: (v: T) => void } {
	let resolve!: (v: T) => void;
	const promise = new Promise<T>((res) => {
		resolve = res;
	});
	return { promise, resolve };
}
