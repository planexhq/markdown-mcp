/**
 * `InflightTracker` — counter-based gate at the transport boundary.
 * `enter()` / `exit()` pair around the SDK's full request lifecycle
 * (`handler(request)` + `transport.send(response)`); `drain` lets
 * `tearDownAndExit` wait until the send has actually flushed before
 * `process.exit()` discards the partial stdout buffer.
 */

import type { Transport, TransportSendOptions } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, test } from "vitest";

import { createInflightTracker, wireInflight } from "../../src/lib/inflightTracker.js";

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

describe("wireInflight", () => {
	interface SendCall {
		message: JSONRPCMessage;
		options: TransportSendOptions | undefined;
	}

	function makeStubTransport(): { transport: Transport; calls: SendCall[] } {
		const calls: SendCall[] = [];
		const transport: Transport = {
			start: () => Promise.resolve(),
			close: () => Promise.resolve(),
			send: (message, options) => {
				calls.push({ message, options });
				return Promise.resolve();
			},
		};
		return { transport, calls };
	}

	test("forwards `TransportSendOptions` to the underlying transport", async () => {
		// HTTP path: SDK calls `transport.send(message, {relatedRequestId})`
		// so handler-side notifications are routed to the correct POST SSE
		// stream. Without forwarding, the SDK would silently re-route to the
		// GET standalone stream or drop the message.
		const { transport, calls } = makeStubTransport();
		const tracker = createInflightTracker();
		wireInflight(transport, tracker);

		const response: JSONRPCMessage = { jsonrpc: "2.0", id: 7, result: {} };
		await transport.send(response, { relatedRequestId: 7 });

		expect(calls).toHaveLength(1);
		expect(calls[0]?.options).toEqual({ relatedRequestId: 7 });
	});

	test("send without options still works (stdio path)", async () => {
		const { transport, calls } = makeStubTransport();
		const tracker = createInflightTracker();
		wireInflight(transport, tracker);

		const response: JSONRPCMessage = { jsonrpc: "2.0", id: 1, result: {} };
		await transport.send(response);

		expect(calls).toHaveLength(1);
		expect(calls[0]?.options).toBeUndefined();
	});

	test("counts requests on inbound onmessage, exits on response send", async () => {
		const { transport } = makeStubTransport();
		const tracker = createInflightTracker();
		wireInflight(transport, tracker);

		expect(tracker.size()).toBe(0);
		transport.onmessage?.({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
		expect(tracker.size()).toBe(1);

		await transport.send({ jsonrpc: "2.0", id: 1, result: {} });
		expect(tracker.size()).toBe(0);
	});

	test("onclose drains orphaned enters from aborted handlers", () => {
		// SDK abort path (protocol.js:259-261) aborts in-flight handlers,
		// which return WITHOUT calling transport.send — leaving our
		// `inflight.enter()` unpaired. The onclose hook drains them so
		// `tearDownAndExit`'s drain doesn't block its full 5 s budget on
		// phantom counts.
		const { transport } = makeStubTransport();
		const tracker = createInflightTracker();
		wireInflight(transport, tracker);

		transport.onmessage?.({ jsonrpc: "2.0", id: 1, method: "tools/call", params: {} });
		transport.onmessage?.({ jsonrpc: "2.0", id: 2, method: "tools/call", params: {} });
		expect(tracker.size()).toBe(2);

		// Simulate the SDK's chained onclose call (protocol.js:220-224)
		// reaching our hook first.
		transport.onclose?.();
		expect(tracker.size()).toBe(0);
	});

	test("onclose only drains this transport's enters, not the shared tracker", () => {
		// One shared tracker, two transports — close on transport A must
		// not zero out B's legitimate in-flight enters. Multi-session HTTP
		// invariant: per-session McpServer + transport, single shared
		// tracker.
		const a = makeStubTransport();
		const b = makeStubTransport();
		const tracker = createInflightTracker();
		wireInflight(a.transport, tracker);
		wireInflight(b.transport, tracker);

		a.transport.onmessage?.({ jsonrpc: "2.0", id: 1, method: "tools/call", params: {} });
		b.transport.onmessage?.({ jsonrpc: "2.0", id: 1, method: "tools/call", params: {} });
		b.transport.onmessage?.({ jsonrpc: "2.0", id: 2, method: "tools/call", params: {} });
		expect(tracker.size()).toBe(3);

		a.transport.onclose?.();
		// A had 1 enter, B's 2 enters remain.
		expect(tracker.size()).toBe(2);

		b.transport.onclose?.();
		expect(tracker.size()).toBe(0);
	});

	test("onclose after a matched send drains nothing (no double-exit)", async () => {
		// Per-transport counter decrements on send-finally; close at that
		// point has nothing to drain. Important under the DELETE-mid-call
		// race where send + close fire close together.
		const { transport } = makeStubTransport();
		const tracker = createInflightTracker();
		wireInflight(transport, tracker);

		transport.onmessage?.({ jsonrpc: "2.0", id: 1, method: "tools/call", params: {} });
		await transport.send({ jsonrpc: "2.0", id: 1, result: {} });
		expect(tracker.size()).toBe(0);

		transport.onclose?.();
		expect(tracker.size()).toBe(0);
	});
});
