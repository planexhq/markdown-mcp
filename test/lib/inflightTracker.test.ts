/**
 * `InflightTracker` — counter-based gate at the transport boundary.
 * `enter()` / `exit()` pair around the SDK's full request lifecycle
 * (`handler(request)` + `transport.send(response)`); `drain` lets
 * `tearDownAndExit` wait until the send has actually flushed before
 * `process.exit()` discards the partial stdout buffer.
 */

import { describe, expect, test } from "vitest";

import { createInflightTracker } from "../../src/lib/inflightTracker.js";

describe("InflightTracker.enter / exit", () => {
	test("size reflects current count", () => {
		const t = createInflightTracker();
		expect(t.size()).toBe(0);
		t.enter();
		expect(t.size()).toBe(1);
		t.enter();
		expect(t.size()).toBe(2);
		t.exit();
		expect(t.size()).toBe(1);
		t.exit();
		expect(t.size()).toBe(0);
	});

	test("exit is a no-op when count is already zero", () => {
		const t = createInflightTracker();
		t.exit();
		t.exit();
		expect(t.size()).toBe(0);
		t.enter();
		expect(t.size()).toBe(1);
	});
});

describe("InflightTracker.drain", () => {
	test('resolves "drained" immediately when count is zero on entry', async () => {
		const t = createInflightTracker();
		await expect(t.drain(1000)).resolves.toBe("drained");
	});

	test('resolves "drained" once outstanding exits bring count to zero', async () => {
		const t = createInflightTracker();
		t.enter();
		const drainResult = t.drain(5000);
		await Promise.resolve();
		expect(t.size()).toBe(1);

		t.exit();
		await expect(drainResult).resolves.toBe("drained");
	});

	test('resolves "timeout" if budget elapses before count reaches zero', async () => {
		const t = createInflightTracker();
		t.enter();
		await expect(t.drain(20)).resolves.toBe("timeout");
		t.exit();
	});

	test("extends the wait when a new enter arrives during drain", async () => {
		const t = createInflightTracker();
		t.enter();
		const drainResult = t.drain(5000);

		t.enter();
		t.exit();
		await Promise.resolve();
		expect(t.size()).toBe(1);

		t.exit();
		await expect(drainResult).resolves.toBe("drained");
	});

	test("supports multiple concurrent drains", async () => {
		const t = createInflightTracker();
		t.enter();

		const a = t.drain(5000);
		const b = t.drain(5000);

		t.exit();
		await expect(a).resolves.toBe("drained");
		await expect(b).resolves.toBe("drained");
	});
});
