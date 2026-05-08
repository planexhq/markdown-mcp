import { describe, expect, test } from "vitest";

import { WriteCoordinator } from "../../src/lib/writeCoordinator.js";
import { defer } from "../helpers/defer.js";

describe("WriteCoordinator", () => {
	test("same-file tasks run in arrival order", async () => {
		const c = new WriteCoordinator();
		const order: number[] = [];
		const a = defer<void>();
		const t1 = c.enqueue("f.md", async () => {
			await a.promise;
			order.push(1);
		});
		const t2 = c.enqueue("f.md", async () => {
			order.push(2);
		});
		// Without serialization, t2 would push first.
		expect(order).toEqual([]);
		a.resolve();
		await Promise.all([t1, t2]);
		expect(order).toEqual([1, 2]);
	});

	test("different-file tasks run in parallel", async () => {
		const c = new WriteCoordinator();
		const a = defer<void>();
		const b = defer<void>();
		const ta = c.enqueue("a.md", async () => {
			await a.promise;
		});
		const tb = c.enqueue("b.md", async () => {
			await b.promise;
		});
		// Both must be in-flight simultaneously: resolving b first works
		// only if b is not blocked by a.
		b.resolve();
		await tb;
		a.resolve();
		await ta;
	});

	test("task error doesn't poison subsequent same-file tasks", async () => {
		const c = new WriteCoordinator();
		const order: string[] = [];
		const t1 = c.enqueue("f.md", async () => {
			order.push("first");
			throw new Error("boom");
		});
		const t2 = c.enqueue("f.md", async () => {
			order.push("second");
		});
		await expect(t1).rejects.toThrow("boom");
		await t2;
		expect(order).toEqual(["first", "second"]);
	});

	test("task return value flows back to caller", async () => {
		const c = new WriteCoordinator();
		const result = await c.enqueue("f.md", async () => 42);
		expect(result).toBe(42);
	});

	test("drain awaits all pending chains", async () => {
		const c = new WriteCoordinator();
		const a = defer<void>();
		const b = defer<void>();
		const order: string[] = [];
		void c.enqueue("a.md", async () => {
			await a.promise;
			order.push("a");
		});
		void c.enqueue("b.md", async () => {
			await b.promise;
			order.push("b");
		});
		const drainPromise = c.drain();
		// Resolve out-of-order; drain completes only after both finish.
		b.resolve();
		a.resolve();
		await drainPromise;
		expect(order.sort()).toEqual(["a", "b"]);
	});

	test("hasActiveChains: false on a fresh coordinator", () => {
		const c = new WriteCoordinator();
		expect(c.hasActiveChains()).toBe(false);
	});

	test("hasActiveChains: true while a task is in-flight, false after drain", async () => {
		// Used by the scanner's pre-finalize re-drain loop to detect
		// late-arriving tasks the single-pass `drain()` missed.
		// `drain()` awaits the followup chain (not just the returned
		// promise), so by the time it resolves the per-file Map entry
		// has been cleared via the followup's `finally`.
		const c = new WriteCoordinator();
		const a = defer<void>();
		const t = c.enqueue("a.md", async () => {
			await a.promise;
		});
		expect(c.hasActiveChains()).toBe(true);
		a.resolve();
		await t;
		await c.drain();
		expect(c.hasActiveChains()).toBe(false);
	});

	test("drain is single-pass: tasks enqueued AFTER drain are not awaited", async () => {
		// drain snapshots the chain set once and awaits — tasks enqueued
		// during the wait are NOT included. Callers must stop upstream
		// event sources (chokidar / merkle interval / scanner) BEFORE
		// drain, otherwise an event firing during shutdown enqueues a
		// task after the snapshot and races closeSqlite.
		const c = new WriteCoordinator();
		const a = defer<void>();
		const b = defer<void>();
		const order: string[] = [];
		void c.enqueue("a.md", async () => {
			await a.promise;
			order.push("a");
		});
		const drainPromise = c.drain();
		// Enqueue AFTER drain has already snapshotted. b's task is not
		// part of the drain set.
		void c.enqueue("b.md", async () => {
			await b.promise;
			order.push("b");
		});
		// Resolve a; drain should complete with only "a" recorded even
		// though b is still pending.
		a.resolve();
		await drainPromise;
		expect(order).toEqual(["a"]);
		// Cleanup: release b so the test exits without dangling promises.
		b.resolve();
	});
});
