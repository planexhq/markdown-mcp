/**
 * HTTP transport (Streamable HTTP) for markdown-mcp.
 *
 * One process owns a single `node:http.Server` and a `Map<sessionId,
 * Session>` where each `Session` carries its own `StreamableHTTPServerTransport`
 * AND its own `McpServer` (per-session McpServer is required — the SDK's
 * `Server.connect` "assumes ownership of the Transport, replacing any
 * callbacks", `@modelcontextprotocol/sdk/dist/esm/server/mcp.d.ts:38–40`,
 * so one McpServer cannot multiplex over multiple transports).
 *
 * All sessions share the SAME {@link InflightTracker} from the
 * {@link ServerContext}; `tearDownAndExit`'s drain spans every session.
 *
 * v1 constraints:
 * - Localhost-only bind (caller's `validateTransportArgs` enforces).
 * - Optional bearer auth via `MCP_AUTH_TOKEN`; when set, every request
 *   must carry `Authorization: Bearer <token>`. Constant-time compare.
 * - DNS-rebinding protection is enabled per-transport with allowedHosts
 *   + allowedOrigins covering the three loopback forms.
 *
 * Lifecycle (HTTP-side):
 *   POST /mcp + no `Mcp-Session-Id` + body.method === "initialize"
 *     → create new Session (transport + McpServer + inflight wiring),
 *       connect, then handleRequest. `onsessioninitialized` populates the
 *       map; `onsessionclosed` (DELETE /mcp OR remote stream close) removes
 *       it and shuts the per-session McpServer down.
 *   POST/GET/DELETE /mcp + `Mcp-Session-Id` known → dispatch.
 *   `Mcp-Session-Id` unknown OR missing-and-not-initialize → SDK transport
 *     returns 404 / 400 (it owns session-id validation; we just hand off).
 *
 * The handle returned by {@link connectHttpTransport} exposes
 * {@link HttpTransportHandle.suppressDispatch} (used by `tearDownAndExit`
 * phase 0 to stop dispatching new RPC requests on every active session,
 * matching the stdio `transport.onmessage = () => {}` line) and
 * {@link HttpTransportHandle.close} (stop `httpServer.listen`, close
 * every active session, resolve). `close` does NOT drain inflight — the
 * caller's `inflight.drain` runs first in the teardown order so per-
 * session responses land on their SSE streams before sessions are torn
 * down.
 */

import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import {
	createServer as createHttpServer,
	type IncomingMessage,
	type Server as NodeHttpServer,
	type ServerResponse,
} from "node:http";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { createMcpServerForSession, type ServerContext } from "../server.js";
import { errorMessage } from "./error.js";
import { wireInflight } from "./inflightTracker.js";
import { formatProtocolVersionTooOldMessage, MAX_HTTP_BODY_BYTES, MIN_PROTOCOL_VERSION } from "./limits.js";

/**
 * Closed-over handle the CLI calls from `tearDownAndExit`.
 */
export interface HttpTransportHandle {
	/**
	 * Suppress dispatch on every active session — mirror of the stdio
	 * `transport.onmessage = () => {}` in `tearDownAndExit`. Stops new
	 * RPC requests from reaching handlers; in-flight handlers already
	 * past dispatch continue to completion (the InflightTracker still
	 * counts them).
	 */
	suppressDispatch(): void;
	/**
	 * Stop accepting new HTTP connections, then close every active
	 * session's McpServer + transport. Idempotent. Does NOT drain
	 * inflight; the caller calls `inflight.drain()` FIRST.
	 */
	close(): Promise<void>;
	/** Resolved bind port (useful when caller passed `port: 0`). */
	readonly port: number;
}

export interface ConnectHttpTransportOptions {
	bindAddress: string;
	port: number;
	context: ServerContext;
	/**
	 * When defined, every incoming HTTP request must carry an exact
	 * `Authorization: Bearer <authToken>` header (case-insensitive on
	 * the scheme). Mismatch / missing → 401. Undefined → no auth.
	 * Compared with `crypto.timingSafeEqual`.
	 */
	authToken?: string;
	/** Lets the router refuse new connections after `tearDownAndExit` flips. */
	isShuttingDown: () => boolean;
}

interface Session {
	transport: StreamableHTTPServerTransport;
	mcpServer: McpServer;
	/**
	 * Milliseconds-since-epoch of the last request dispatched to this
	 * session. Updated by `handleHttpRequest` on every accepted POST /
	 * GET / DELETE. The idle-timeout sweep compares this against
	 * `Date.now() - idleMs` to find abandoned sessions (TCP disconnect
	 * without DELETE → SDK never fires `onsessionclosed`, so this is
	 * the only reclamation signal).
	 */
	lastTouchedAt: number;
}

/**
 * Idle-timeout reclamation for sessions abandoned without DELETE.
 *
 * The SDK fires `_onsessionclosed` ONLY from `handleDeleteRequest`
 * (`webStandardStreamableHttp.js:567-579`); TCP RST, GET-SSE stream
 * cancel, and POST-SSE stream cancel all leave the session map entry
 * intact. Without an external reclamation path, every reconnecting /
 * crashing client leaks one `McpServer` + one transport for process
 * lifetime.
 *
 * Defaults: 30 min idle window, 60 s sweep cadence. Both overridable
 * via env (mostly for tests; production deployments are localhost
 * single-user so 30 min is generous). Floor at 1 s idle / 100 ms sweep
 * so a typo can't make the sweep busy-loop.
 */
const DEFAULT_SESSION_IDLE_MS = 30 * 60_000;
const SESSION_IDLE_FLOOR_MS = 1_000;
const DEFAULT_SESSION_SWEEP_MS = 60_000;
const SESSION_SWEEP_FLOOR_MS = 100;

function readPositiveEnvMs(name: string, fallback: number, floor: number): number {
	const raw = process.env[name];
	if (raw === undefined) return fallback;
	const parsed = Number.parseInt(raw, 10);
	if (!Number.isFinite(parsed) || parsed < floor) return fallback;
	return parsed;
}

type BodyReadResult = { ok: true; parsed: unknown } | { ok: false; status: number; body: string };

/**
 * Stand up the HTTP server, install the request router, and resolve with
 * the {@link HttpTransportHandle}. Rejects on `listen` errors (e.g.
 * `EADDRINUSE`); caller's post-lock catch path runs `tearDownAndExit`
 * to release the lockfile cleanly.
 */
export function connectHttpTransport(opts: ConnectHttpTransportOptions): Promise<HttpTransportHandle> {
	const sessions = new Map<string, Session>();
	let dispatchSuppressed = false;
	// Cached close promise — second-call returns the same promise so
	// concurrent `close()` callers all await one teardown.
	let closePromise: Promise<void> | undefined;

	// SDK DNS-rebinding allowlists need the RESOLVED port (`--port 0`
	// resolves to an OS-assigned value), so build them inside the
	// `listening` callback below and stash references for use by every
	// per-session transport. `allowedHosts`/`allowedOrigins` arrays stay
	// the same object identity across sessions — the SDK reads them per
	// request, no copy needed.
	let allowedHosts: string[] = [];
	let allowedOrigins: string[] = [];
	// Idle-timeout sweep timer — assigned inside `onListening` so a
	// failed `listen()` (EADDRINUSE) doesn't leak a Node interval for
	// the lifetime of the test process.
	let sweepTimer: NodeJS.Timeout | undefined;
	const stopSweeping = (): void => {
		if (sweepTimer !== undefined) {
			clearInterval(sweepTimer);
			sweepTimer = undefined;
		}
	};

	// Pre-hash the auth token for constant-time comparison. We hash once
	// at startup to get a fixed-length buffer (sha256 = 32 bytes), then
	// compare the inbound header's sha256 against this. timingSafeEqual
	// requires equal-length inputs — naive byte-by-byte compare on the
	// raw token would leak length information.
	const authHash = opts.authToken !== undefined ? sha256(opts.authToken) : undefined;

	const httpServer: NodeHttpServer = createHttpServer((req, res) => {
		void handleHttpRequest(req, res, {
			sessions,
			context: opts.context,
			authHash,
			allowedHosts,
			allowedOrigins,
			isDispatchSuppressed: () => dispatchSuppressed,
			isShuttingDown: opts.isShuttingDown,
		});
	});

	// Per-connection error listener is the only way to surface a torn
	// TCP stream without taking the whole process down. Node emits
	// `clientError` for malformed HTTP frames.
	httpServer.on("clientError", (err, socket) => {
		try {
			socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
		} catch {
			// Socket already closed; nothing to do.
		}
		// Don't surface to stdout — stderr only.
		console.error(`markdown-mcp http: clientError: ${errorMessage(err)}`);
	});

	return new Promise<HttpTransportHandle>((resolve, reject) => {
		const onListenError = (err: Error): void => {
			httpServer.removeListener("listening", onListening);
			reject(err);
		};
		const onListening = (): void => {
			httpServer.removeListener("error", onListenError);
			const address = httpServer.address();
			if (address === null || typeof address === "string") {
				reject(new Error("http server bound to unexpected address shape"));
				return;
			}
			const resolvedPort = address.port;
			// `--port 0` resolves to an OS-assigned value only AFTER
			// `httpServer.listen()` succeeds — finalize the transport
			// metadata on the shared context here so per-session
			// `get_server_info` reports the real port. Allowlists are
			// populated at the same time so per-session transports read
			// the right refs at session-creation time. Both assignments
			// precede any session creation (requests can only arrive
			// after listen() resolves).
			opts.context.serverInfoContextBase.port = resolvedPort;
			opts.context.serverInfoContextBase.bindAddress = opts.bindAddress;
			allowedHosts = buildAllowedHosts(opts.bindAddress, resolvedPort);
			allowedOrigins = buildAllowedOrigins(opts.bindAddress, resolvedPort);
			const idleMs = readPositiveEnvMs("MCP_HTTP_SESSION_IDLE_MS", DEFAULT_SESSION_IDLE_MS, SESSION_IDLE_FLOOR_MS);
			const sweepMs = readPositiveEnvMs("MCP_HTTP_SESSION_SWEEP_MS", DEFAULT_SESSION_SWEEP_MS, SESSION_SWEEP_FLOOR_MS);
			sweepTimer = setInterval(() => {
				const cutoff = Date.now() - idleMs;
				for (const [sessionId, session] of sessions) {
					if (session.lastTouchedAt < cutoff) {
						void reclaimSession(sessions, sessionId, "idle-timeout");
					}
				}
			}, sweepMs);
			// Don't keep the event loop alive on the sweep timer alone —
			// matches stdio's exit semantics on SIGTERM.
			sweepTimer.unref();
			resolve({
				suppressDispatch: () => {
					dispatchSuppressed = true;
					// Parity with stdio's `transport.onmessage = () => {}` line
					// in `tearDownAndExit`. The router gate at handleHttpRequest
					// only stops NEW requests from reaching the SDK; a slow body
					// read already past the gate would otherwise dispatch into
					// the InflightTracker-wrapped onmessage AFTER drain has
					// observed zero. Nulling onmessage on every active session
					// closes the second hole.
					for (const { transport } of sessions.values()) {
						transport.onmessage = () => {};
					}
				},
				close: () => (closePromise ??= closeAll(httpServer, sessions, stopSweeping)),
				port: resolvedPort,
			});
		};
		httpServer.once("error", onListenError);
		httpServer.once("listening", onListening);
		httpServer.listen(opts.port, opts.bindAddress);
	});
}

interface RouterDeps {
	sessions: Map<string, Session>;
	context: ServerContext;
	authHash: Buffer | undefined;
	allowedHosts: string[];
	allowedOrigins: string[];
	isDispatchSuppressed: () => boolean;
	isShuttingDown: () => boolean;
}

async function handleHttpRequest(req: IncomingMessage, res: ServerResponse, deps: RouterDeps): Promise<void> {
	try {
		// Refuse new requests during teardown. In-flight ones already past
		// this point keep running — InflightTracker covers their lifetime.
		if (deps.isShuttingDown() || deps.isDispatchSuppressed()) {
			respondJsonRpcError(res, 503, "Service Unavailable", "server is shutting down");
			return;
		}

		// Path gate: every accepted MCP request lives at `/mcp`. Anything
		// else is a misconfigured client; respond plainly so curl debugging
		// shows the real reason.
		const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
		if (url.pathname !== "/mcp") {
			respondJsonRpcError(res, 404, "Not Found", `path ${url.pathname} is not an MCP endpoint`);
			return;
		}

		// Auth gate. When `MCP_AUTH_TOKEN` is set, every request must
		// carry `Authorization: Bearer <token>`. Constant-time hash compare
		// so a missing or short token doesn't leak length via timing.
		if (deps.authHash !== undefined && !authMatches(req, deps.authHash)) {
			respondJsonRpcError(res, 401, "Unauthorized", "missing or invalid bearer token");
			return;
		}

		// Parse body only for POST. GET (SSE stream) and DELETE (session
		// termination) carry no body of interest; the SDK transport handles
		// those directly.
		let parsedBody: unknown;
		if (req.method === "POST") {
			const result = await readJsonBody(req);
			if (!result.ok) {
				respondJsonRpcError(res, result.status, "Bad Request", result.body);
				return;
			}
			parsedBody = result.parsed;
		}

		// Re-check shutdown AFTER the body read. A slow / chunked POST can
		// take O(seconds); SIGTERM during that window flips the suppression
		// flag but our pre-body gate is already past. Without this re-check,
		// the dispatch below could land on a torn-down session OR call
		// inflight.enter() after `inflight.drain()` has already observed
		// zero and returned. Pair with the per-session onmessage null-out
		// inside suppressDispatch — together they close both halves of the
		// race.
		if (deps.isShuttingDown() || deps.isDispatchSuppressed()) {
			respondJsonRpcError(res, 503, "Service Unavailable", "server is shutting down");
			return;
		}

		const sessionId = headerString(req.headers["mcp-session-id"]);
		const existing = sessionId !== undefined ? deps.sessions.get(sessionId) : undefined;

		if (existing) {
			// Update the idle-timeout watermark BEFORE dispatch. Doing it
			// after `handleRequest` would race a SIGTERM-driven sweep that
			// observed the pre-request timestamp and reclaimed the session
			// while its response was still streaming.
			existing.lastTouchedAt = Date.now();
			await existing.transport.handleRequest(req, res, parsedBody);
			return;
		}

		// `sessionId` present but no matching session → 404 unconditionally,
		// even when the body is an initialize. MCP spec recovery requires
		// clients receiving 404 to drop the stale id and re-initialize
		// WITHOUT one; accepting initialize-with-stale-id would silently
		// hand out a new id (the SDK's webStandardStreamableHttp doesn't
		// validate the inbound header during init) and mask the client's
		// protocol violation. One rule covers both "completely unknown" and
		// "previously valid but expired" cases.
		if (sessionId !== undefined) {
			respondJsonRpcError(res, 404, "Not Found", `unknown session id ${sessionId}`);
			return;
		}

		// No session-id at all. Only legal arrival: POST + initialize body.
		// The cheap shape probe avoids constructing a session for malformed
		// non-initialize traffic.
		const initMessage = req.method === "POST" ? parseInitializeMessage(parsedBody) : undefined;
		if (initMessage === undefined) {
			respondJsonRpcError(res, 400, "Bad Request", "request requires Mcp-Session-Id or initialize body");
			return;
		}

		// Pre-validate the requested protocol version BEFORE createSession.
		// The SDK's WebStandardStreamableHTTPServerTransport sets
		// `_initialized = true`, assigns `sessionId`, and fires our
		// `onsessioninitialized` (which inserts the session into the map)
		// BEFORE the message is dispatched to McpServer's
		// `InitializeRequestSchema` handler. If we let that path run for an
		// old protocol, our handler throws, the client sees an error
		// response, but the session lingers in the map — a misbehaving
		// client could then call tools with the leaked id and bypass the
		// protocol floor. Reject here so createSession never runs.
		const requestedProtocol = initMessage.protocolVersion;
		if (requestedProtocol === undefined || requestedProtocol < MIN_PROTOCOL_VERSION) {
			respondJsonRpcError(res, 400, "Bad Request", formatProtocolVersionTooOldMessage(requestedProtocol));
			return;
		}

		// Initialize: build a fresh per-session McpServer + transport, wire
		// inflight, connect, then hand off. `onsessioninitialized` populates
		// the map AFTER the SDK assigns the session id during handleRequest.
		const session = await createSession(deps);
		await session.transport.handleRequest(req, res, parsedBody);
	} catch (err) {
		// Last-resort error log + 500 — the SDK transport normally writes
		// its own response, but a thrown exception before handleRequest
		// would otherwise hang the client on an unfinished response stream.
		console.error(`markdown-mcp http: request handler error: ${errorMessage(err)}`);
		if (!res.headersSent) {
			respondJsonRpcError(res, 500, "Internal Server Error", "request handler threw");
		} else {
			try {
				res.end();
			} catch {
				// Already closed; nothing more to do.
			}
		}
	}
}

async function createSession(deps: RouterDeps): Promise<{ transport: StreamableHTTPServerTransport }> {
	const mcpServer = createMcpServerForSession(deps.context);

	// `onsessioninitialized` fires INSIDE `handleRequest` once the SDK
	// has assigned `transport.sessionId`. We need `transport` and
	// `mcpServer` already captured by the closure so the map entry
	// resolves to the right pair — both are assigned below before
	// handleRequest is called, satisfying the timing.
	const transport = new StreamableHTTPServerTransport({
		sessionIdGenerator: () => randomUUID(),
		onsessioninitialized: (sessionId) => {
			deps.sessions.set(sessionId, { transport, mcpServer, lastTouchedAt: Date.now() });
			console.error(`markdown-mcp http: session opened ${sessionId}`);
		},
		onsessionclosed: (sessionId) => {
			void reclaimSession(deps.sessions, sessionId, "delete");
		},
		enableDnsRebindingProtection: true,
		allowedHosts: deps.allowedHosts,
		allowedOrigins: deps.allowedOrigins,
	});

	// Wire MUST happen BEFORE server.connect (matches stdio invariant —
	// SDK chains onto the existing `onmessage` for inflight `enter()`).
	// Cast: StreamableHTTPServerTransport declares `onclose: (() => void)
	// | undefined` (always-present-may-be-undefined) while the Transport
	// interface declares `onclose?: () => void` (optional). The SDK's own
	// transports flip between these forms — runtime is identical, the
	// types just don't unify under `exactOptionalPropertyTypes: true`.
	// `StreamableHTTPServerTransport implements Transport` per its .d.ts,
	// so the cast is sound.
	const transportAsBase = transport as unknown as Transport;
	wireInflight(transportAsBase, deps.context.inflight);
	await mcpServer.connect(transportAsBase);

	// The full `Session` record (with `lastTouchedAt`) is built inside
	// `onsessioninitialized`, which fires synchronously during the first
	// `handleRequest`. Returning only the transport keeps that callback
	// the single source of truth for map-entry contents.
	return { transport };
}

type ReclaimReason = "delete" | "idle-timeout" | "shutdown";

/**
 * Tear down a single session. The `sessions.delete` runs synchronously
 * BEFORE any await so concurrent sweep ticks (or duplicate SDK callback
 * invocations) bail at the `entry === undefined` guard rather than
 * double-closing. `transport.close()` and `mcpServer.close()` operate
 * on disjoint SDK resources, so `Promise.allSettled` runs them in
 * parallel; each rejection is logged but doesn't block its sibling.
 */
async function reclaimSession(sessions: Map<string, Session>, sessionId: string, reason: ReclaimReason): Promise<void> {
	const entry = sessions.get(sessionId);
	if (entry === undefined) return;
	sessions.delete(sessionId);
	console.error(`markdown-mcp http: session closing ${sessionId} (${reason})`);
	const [transportResult, mcpResult] = await Promise.allSettled([entry.transport.close(), entry.mcpServer.close()]);
	if (transportResult.status === "rejected") {
		console.error(`markdown-mcp http: transport.close ${sessionId}: ${errorMessage(transportResult.reason)}`);
	}
	if (mcpResult.status === "rejected") {
		console.error(`markdown-mcp http: McpServer.close ${sessionId}: ${errorMessage(mcpResult.reason)}`);
	}
}

async function closeAll(
	httpServer: NodeHttpServer,
	sessions: Map<string, Session>,
	stopSweeping: () => void,
): Promise<void> {
	stopSweeping();
	// Schedule httpServer close (stops accepting new connections) but
	// don't await yet. `close` resolves only after every active socket
	// has closed; if we await before tearing down per-session SSE streams
	// it would hang forever because SSE responses keep their sockets
	// non-idle. Order: schedule close → drop idle keep-alives → terminate
	// per-session SSE streams → await final close callback.
	const httpClosePromise = new Promise<void>((resolve) => {
		httpServer.close(() => resolve());
	});
	// Force-close idle keep-alive sockets (Node 18.2+); active SSE
	// sockets are bound to ongoing responses and unaffected here.
	httpServer.closeIdleConnections?.();

	// Reclaim every active session in parallel. `reclaimSession` deletes
	// from the map synchronously before its awaits, so iterating live
	// keys is safe; failures are logged inside `reclaimSession`.
	await Promise.allSettled([...sessions.keys()].map((id) => reclaimSession(sessions, id, "shutdown")));

	// All session SSE streams have ended; remaining sockets should now
	// be closeable. Await httpServer's own close callback.
	await httpClosePromise;
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function headerString(header: string | string[] | undefined): string | undefined {
	if (header === undefined) return undefined;
	return Array.isArray(header) ? header[0] : header;
}

function authMatches(req: IncomingMessage, expectedHash: Buffer): boolean {
	const header = headerString(req.headers.authorization);
	if (header === undefined) return false;
	// Match `Bearer <token>` (case-insensitive scheme; the spec allows
	// any-case). Anything else fails closed.
	const match = /^bearer\s+(.+)$/i.exec(header);
	if (!match) return false;
	const presented = match[1]?.trim();
	if (presented === undefined || presented.length === 0) return false;
	const presentedHash = sha256(presented);
	if (presentedHash.length !== expectedHash.length) return false;
	return timingSafeEqual(presentedHash, expectedHash);
}

function sha256(input: string): Buffer {
	return createHash("sha256").update(input, "utf8").digest();
}

async function readJsonBody(req: IncomingMessage): Promise<BodyReadResult> {
	// Defense-in-depth: Content-Length cap before stream read. The
	// streamed read below ALSO caps at MAX_HTTP_BODY_BYTES so a
	// missing or lying CL header can't slip past.
	const contentLength = req.headers["content-length"];
	if (contentLength !== undefined) {
		const declared = Number.parseInt(Array.isArray(contentLength) ? (contentLength[0] ?? "0") : contentLength, 10);
		if (Number.isFinite(declared) && declared > MAX_HTTP_BODY_BYTES) {
			return { ok: false, status: 413, body: `request body exceeds ${MAX_HTTP_BODY_BYTES} byte limit` };
		}
	}

	const chunks: Buffer[] = [];
	let total = 0;
	for await (const chunk of req) {
		const buf: Buffer = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : (chunk as Buffer);
		total += buf.length;
		if (total > MAX_HTTP_BODY_BYTES) {
			return { ok: false, status: 413, body: `request body exceeds ${MAX_HTTP_BODY_BYTES} byte limit` };
		}
		chunks.push(buf);
	}
	if (total === 0) {
		return { ok: false, status: 400, body: "empty request body" };
	}
	const text = Buffer.concat(chunks).toString("utf8");
	try {
		return { ok: true, parsed: JSON.parse(text) };
	} catch (err) {
		return { ok: false, status: 400, body: `invalid JSON body: ${errorMessage(err)}` };
	}
}

/**
 * Detect + extract from an initialize body in a single walk. Returns
 * `{ protocolVersion }` (possibly `undefined`) when the body is an
 * initialize REQUEST, or `undefined` when it isn't. Accepts both single-
 * message shapes AND single-element JSON-RPC batches — the SDK accepts
 * both via `messages.some(isInitializeRequest)` and rejects only MULTI-
 * element batches containing initialize, so a single-element batch must
 * not be 400'd ahead of the SDK's validation.
 *
 * Notifications (no `id`) are rejected. The SDK's `InitializeRequestSchema`
 * extends the lenient `RequestSchema` (not `JSONRPCRequestSchema`), so a
 * `{method: "initialize", params: ...}` notification passes
 * `isInitializeRequest` and would fire `_onsessioninitialized` — but the
 * 202 response carries no `Mcp-Session-Id`, leaving an unreachable session
 * map entry and a McpServer/transport pair leaked per call. MCP spec
 * defines initialize as a Request; rejecting notification-shape is
 * spec-conformant.
 */
function parseInitializeMessage(body: unknown): { protocolVersion: string | undefined } | undefined {
	if (Array.isArray(body)) {
		return body.length === 1 ? parseInitializeMessage(body[0]) : undefined;
	}
	if (typeof body !== "object" || body === null) return undefined;
	const obj = body as Record<string, unknown>;
	if (obj.method !== "initialize") return undefined;
	if (!("id" in obj)) return undefined;
	const params = obj.params;
	if (typeof params !== "object" || params === null) return { protocolVersion: undefined };
	const version = (params as Record<string, unknown>).protocolVersion;
	return { protocolVersion: typeof version === "string" ? version : undefined };
}

/**
 * Bracket an IPv6 host literal per RFC 3986 §3.2.2. Detection by `:`
 * presence is sufficient — the CLI's `isLoopbackBind` already restricts
 * inputs to `localhost`, IPv4 dotted form, or IPv6 (`::1` /
 * `0:0:0:0:0:0:0:1`), so any host containing `:` is an IPv6 literal that
 * needs the brackets. Idempotent on already-bracketed input.
 *
 * @internal Exported only so unit tests can pin its behavior; not part
 * of the module's external API.
 */
export function bracketIpv6Host(host: string): string {
	if (!host.includes(":")) return host;
	if (host.startsWith("[")) return host;
	return `[${host}]`;
}

/**
 * Loopback host forms a client might send as `Host` / `Origin`. The fourth
 * `<bindAddress>` slot is filled at call time so curl `--resolve` and
 * similar setups that send the literal bind value also match — bracketed
 * for IPv6 so `--bind ::1` yields the spec-compliant `[::1]:port`
 * (otherwise the entry duplicates `LOOPBACK_HOSTS`'s `[::1]` slot with an
 * unbracketed dead form). The SDK's `validateRequestHeaders` does
 * case-insensitive compare.
 */
const LOOPBACK_HOSTS = ["127.0.0.1", "localhost", "[::1]"] as const;

/**
 * Loopback host/origin allowlist shapes for the SDK's DNS-rebinding
 * validation. Always emits the `${scheme}${host}:${port}` form; for
 * `port === 80` also emits bare `${scheme}${host}` because standard
 * clients strip `:80` from Host / Origin headers (RFC 7230 §5.4 +
 * WHATWG URL).
 *
 * @internal Exported only so unit tests can pin the port-80 expansion;
 * not part of the module's external API.
 */
export function buildLoopbackEndpoints(bindAddress: string, port: number, scheme: "" | "http://"): string[] {
	const hosts = [...LOOPBACK_HOSTS, bracketIpv6Host(bindAddress)];
	const withPort = hosts.map((host) => `${scheme}${host}:${port}`);
	// Port 443 is not a default for `http://`, so its Host header
	// always carries `:443` — symmetric HTTPS handling deferred until
	// that transport ships.
	if (port === 80) {
		return [...withPort, ...hosts.map((host) => `${scheme}${host}`)];
	}
	return withPort;
}

function buildAllowedHosts(bindAddress: string, port: number): string[] {
	return buildLoopbackEndpoints(bindAddress, port, "");
}

function buildAllowedOrigins(bindAddress: string, port: number): string[] {
	return buildLoopbackEndpoints(bindAddress, port, "http://");
}

function respondJsonRpcError(res: ServerResponse, status: number, statusText: string, message: string): void {
	if (res.headersSent) return;
	const body = JSON.stringify({
		jsonrpc: "2.0",
		error: { code: -32600, message },
		id: null,
	});
	res.writeHead(status, statusText, {
		"Content-Type": "application/json",
		"Content-Length": Buffer.byteLength(body, "utf8"),
	});
	res.end(body);
}
