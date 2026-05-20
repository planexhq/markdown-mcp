import type { Transport, TransportSendOptions } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

/**
 * In-flight request counter with a bounded drain. Increments and
 * decrements are paired at the TRANSPORT boundary (incoming request →
 * `enter()`; outgoing response fully sent → `exit()`) so the count
 * spans the SDK's `handler(request) → transport.send(response)` chain
 * as a single unit — including the time `send` waits for stdout's
 * `drain` event under backpressure on a large reply.
 *
 * Tracking at the handler boundary is unsafe: the SDK's protocol
 * (`protocol.js:_onrequest`) awaits `handler(request)` first and THEN
 * awaits `transport.send(response)` in a separate `.then`. A drain
 * that observed `count === 0` between those two awaits would return
 * `"drained"` while the response was still queued in `stdout`'s
 * write buffer, and a subsequent `process.exit()` would truncate it.
 *
 * Drain semantics: resolves on the first count-equals-zero observation
 * after the call (or immediately if count is already zero on entry).
 * New `enter()` invocations arriving during a pending drain extend the
 * wait — the timeout bounds it under load.
 */
export interface InflightTracker {
	/** Current count of in-flight tracked operations. */
	size(): number;
	/** Increment the in-flight count. */
	enter(): void;
	/** Decrement the in-flight count; no-op if already at zero. */
	exit(): void;
	/** Resolve `"drained"` once count reaches 0 or `"timeout"` after `timeoutMs`. */
	drain(timeoutMs: number): Promise<"drained" | "timeout">;
}

export function createInflightTracker(): InflightTracker {
	let count = 0;
	const resolvers = new Set<() => void>();

	const fireZeroWaiters = (): void => {
		if (count !== 0) return;
		for (const resolve of resolvers) resolve();
		resolvers.clear();
	};

	return {
		size: () => count,
		enter: () => {
			count++;
		},
		exit: () => {
			if (count === 0) return;
			count--;
			if (count === 0) fireZeroWaiters();
		},
		drain: (timeoutMs: number): Promise<"drained" | "timeout"> => {
			if (count === 0) return Promise.resolve("drained");
			return new Promise<"drained" | "timeout">((resolve) => {
				let settled = false;
				const finish = (result: "drained" | "timeout"): void => {
					if (settled) return;
					settled = true;
					clearTimeout(timer);
					resolvers.delete(onZero);
					resolve(result);
				};
				const onZero = (): void => finish("drained");
				resolvers.add(onZero);
				const timer = setTimeout(() => finish("timeout"), timeoutMs);
			});
		},
	};
}

/**
 * JSON-RPC message-shape predicates for the inflight tracker hooks.
 * The SDK exports zod-backed `isJSONRPC*` helpers, but every send /
 * onmessage call would pay a full schema parse — overkill when the
 * transport only ever produces SDK-shaped messages. The shape checks
 * are sufficient to disambiguate request / response / notification.
 */
function isJsonRpcRequestShape(msg: unknown): boolean {
	return typeof msg === "object" && msg !== null && "id" in msg && "method" in msg;
}
function isJsonRpcResponseShape(msg: unknown): boolean {
	return typeof msg === "object" && msg !== null && "id" in msg && ("result" in msg || "error" in msg);
}

/**
 * Wire an {@link InflightTracker} to a transport's request/response
 * boundary. Increments on every inbound JSON-RPC *request* (notifications
 * are not tracked — the SDK doesn't send a paired response). Decrements
 * after the SDK's `transport.send(response)` fully resolves, including
 * the time `send` waits for stdout `drain` under backpressure on a large
 * reply (stdio) or the SSE flush (HTTP).
 *
 * MUST be called BEFORE `server.connect(transport)`. The SDK's `connect`
 * chains `transport.onmessage` (mcp.d.ts:38–40 — "assumes ownership of
 * the Transport, replacing any callbacks"; verified at protocol.js where
 * the prior `onmessage` is invoked before SDK dispatch), so our `enter()`
 * fires before the SDK invokes the request handler. `transport.send` is
 * read fresh on every call (the property, not a captured reference), so
 * our wrapper is used for all outgoing messages.
 *
 * HTTP transport uses this once per session — every new
 * `StreamableHTTPServerTransport` is wired against the SAME shared
 * `InflightTracker` so a single `tearDownAndExit` drain spans all
 * sessions.
 */
export function wireInflight(transport: Transport, inflight: InflightTracker): void {
	// Per-transport bookkeeping so the close-time drain only releases
	// enters that THIS transport claimed. Without it a shared tracker
	// over multiple HTTP sessions would have one session's close drain
	// the others' legitimate in-flight work.
	let perTransportEnters = 0;
	const originalSend = transport.send.bind(transport);
	// `options` carries `relatedRequestId` under HTTP — the SDK uses it to
	// route a handler's `extra.sendNotification` / `extra.sendRequest`
	// output back onto the POST SSE stream of the request that triggered
	// it. Dropping the second argument here would re-route to the GET
	// standalone stream (or drop entirely if no GET stream is open).
	transport.send = async (message: JSONRPCMessage, options?: TransportSendOptions) => {
		try {
			await originalSend(message, options);
		} finally {
			if (isJsonRpcResponseShape(message)) {
				inflight.exit();
				if (perTransportEnters > 0) perTransportEnters--;
			}
		}
	};
	transport.onmessage = (message: JSONRPCMessage) => {
		if (isJsonRpcRequestShape(message)) {
			inflight.enter();
			perTransportEnters++;
		}
	};
	// Drain orphaned enters when the transport closes. SDK's
	// `protocol._onclose` (protocol.js:259-261) aborts every in-flight
	// handler; aborted handlers check `signal.aborted` and return WITHOUT
	// calling `transport.send`, so the matching `inflight.exit()` would
	// never fire — leaving `tearDownAndExit`'s drain to block its full
	// 5 s budget. The SDK chains `transport.onclose` (protocol.js:220-224
	// reads the prior callback and wraps it), so setting our hook BEFORE
	// `mcpServer.connect` preserves protocol's abort path while running
	// our drain first.
	transport.onclose = () => {
		while (perTransportEnters > 0) {
			inflight.exit();
			perTransportEnters--;
		}
	};
}
