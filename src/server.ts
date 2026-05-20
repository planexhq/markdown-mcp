/**
 * MCP server skeleton.
 *
 * Registers all 7 tools and the `note://` resource. Tool handlers
 * return the D13 hybrid envelope (successful JSON-RPC result with
 * `isError: true` + `structuredContent` for domain errors); the
 * resource read handler throws `McpError` with `-32603` so the SDK
 * surfaces it as a JSON-RPC error with our domain `code` in `data`.
 *
 * Every tool's path argument runs through `validatePath` — the
 * security invariant is locked from registration time.
 */

import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
	ErrorCode,
	InitializeRequestSchema,
	LATEST_PROTOCOL_VERSION,
	McpError,
	type ServerCapabilities,
	SUPPORTED_PROTOCOL_VERSIONS,
} from "@modelcontextprotocol/sdk/types.js";

import { errorMessage, internalErrorEnvelope, parseErrorPayload, vaultError } from "./lib/error.js";
import type { IndexHandle } from "./lib/index/IndexHandle.js";
import { createInflightTracker, type InflightTracker } from "./lib/inflightTracker.js";
import { formatProtocolVersionTooOldMessage, MIN_PROTOCOL_VERSION } from "./lib/limits.js";
import { ParseError } from "./lib/parser.js";
import { FileTooLargeError, readSource } from "./lib/readNote.js";
import { hashVaultRoot } from "./lib/serverInfo.js";
import { PathValidationError, type VaultRoot, validatePath } from "./lib/validatePath.js";
import { getParserKind } from "./lib/vaultExtensions.js";
import { PACKAGE_VERSION } from "./lib/version.js";
import {
	GetFileOutlineSchema,
	GetFragmentSchema,
	GetLinksSchema,
	GetMetadataSchema,
	GetServerInfoSchema,
	GetVaultTreeSchema,
	SearchSchema,
	TOOL_DESCRIPTIONS,
} from "./schemas.js";
import { handleGetFileOutline } from "./tools/getFileOutline.js";
import { handleGetFragment } from "./tools/getFragment.js";
import { handleGetLinks } from "./tools/getLinks.js";
import { handleGetMetadata } from "./tools/getMetadata.js";
import { handleGetServerInfo, type ServerInfoContext } from "./tools/getServerInfo.js";
import { handleGetVaultTree } from "./tools/getVaultTree.js";
import { handleSearch } from "./tools/search.js";
import type { TransportKind, ErrorCode as VaultErrorCode } from "./types.js";

/**
 * Server name + version reported in the MCP `initialize` handshake AND
 * surfaced via `get_server_info` (D37). `version` reads from this package's
 * `package.json` at module load (see {@link PACKAGE_VERSION}), NOT
 * `npm_package_version` — that env var is correct only when launched via
 * `npm exec` from inside this package's working dir; every other launch
 * mode (direct `node dist/index.js`, `npx` from outside any package,
 * `npm exec` from a vault with its own package.json) silently produced the
 * wrong value (D39).
 */
const SERVER_NAME = "markdown-mcp" as const;
const SERVER_INFO = {
	name: SERVER_NAME,
	version: PACKAGE_VERSION,
};

const INSTRUCTIONS =
	"Read-only access to a local markdown vault. Use get_vault_tree to discover files, get_file_outline + get_fragment for navigation.";

/**
 * Server-wide policy carried alongside the vault root and index handle.
 *
 * `includeHidden` is set by the `--include-hidden` CLI flag. It flows from
 * here into every surface (tree, search, fragment, outline, metadata,
 * links, embeds, note:// resource) so dotfile visibility is genuinely
 * all-or-nothing per CLAUDE.md's "Hidden files: all-or-nothing per-server"
 * gotcha. The watcher and scanner receive the same flag separately at
 * startup; both sides must agree or surfaces drift apart.
 *
 * `transport`, `bindAddress`, `port` carry the live transport identity
 * for `get_server_info`. Stdio populates only `transport`; HTTP populates
 * all three.
 */
export interface ServerConfig {
	includeHidden?: boolean;
	transport?: TransportKind;
	bindAddress?: string;
	port?: number;
}

/**
 * Shared state for one server process. Holds the single InflightTracker
 * (drained on shutdown across every session), the index/vault refs, the
 * `serverInfoContextBase` (process-constant identity), and the included-
 * hidden flag. Constructed once at startup by {@link createServerContext}.
 *
 * Stdio uses one context + one McpServer. HTTP uses one context + N
 * McpServers (one per session) so each session carries its own
 * `negotiatedProtocolVersion` — the SDK's `Server.connect` "assumes
 * ownership of the Transport, replacing any callbacks" per
 * `@modelcontextprotocol/sdk/dist/esm/server/mcp.d.ts:38–40`, so one
 * McpServer cannot multiplex across transports.
 */
export interface ServerContext {
	vaultRoot: VaultRoot;
	index: IndexHandle | undefined;
	includeHidden: boolean;
	inflight: InflightTracker;
	/**
	 * Base for {@link ServerInfoContext}; each per-session call to
	 * {@link createMcpServerForSession} fills in `getMcpProtocolVersion`
	 * pointing at that session's own closure variable.
	 */
	serverInfoContextBase: Omit<ServerInfoContext, "getMcpProtocolVersion">;
}

/**
 * Returned by `createServer`. The CLI wires `inflight` at the transport
 * boundary: `transport.onmessage` increments on incoming requests and
 * `transport.send` decrements after the SDK's send fully resolves —
 * including stdout-drain wait under backpressure. `tearDownAndExit`
 * awaits `inflight.drain(...)` before `process.exit()` so the final
 * response isn't truncated. See `src/lib/inflightTracker.ts`.
 */
export interface ServerInstance {
	server: McpServer;
	inflight: InflightTracker;
}

/**
 * Build the shared {@link ServerContext} once at startup. The single
 * `InflightTracker` and the once-hashed `rootHash` live here so multiple
 * sessions (HTTP) or a one-shot session (stdio) can be created against
 * the same context.
 */
export function createServerContext(
	vaultRoot: VaultRoot,
	index?: IndexHandle,
	config: ServerConfig = {},
): ServerContext {
	const includeHidden = config.includeHidden ?? false;
	// Process-start timestamp (ISO 8601, UTC). Captured here (D40) so each
	// `createServerContext` invocation reports its own creation time —
	// agents detect unexpected restarts between turns by comparing this
	// across calls. Pre-D40 this was a module-level const evaluated at
	// first import.
	const serverStartedAt = new Date().toISOString();
	const inflight = createInflightTracker();
	const serverInfoContextBase: Omit<ServerInfoContext, "getMcpProtocolVersion"> = {
		rootHash: hashVaultRoot(vaultRoot.absolute),
		includeHidden,
		startedAt: serverStartedAt,
		serverName: SERVER_NAME,
		serverVersion: PACKAGE_VERSION,
		transport: config.transport ?? "stdio",
		...(config.bindAddress !== undefined && { bindAddress: config.bindAddress }),
		...(config.port !== undefined && { port: config.port }),
	};
	return { vaultRoot, index, includeHidden, inflight, serverInfoContextBase };
}

/**
 * Build one `McpServer` against a shared {@link ServerContext}. Each call
 * yields a fresh `negotiatedProtocolVersion` closure — required for HTTP
 * because the SDK's `Server.connect` "assumes ownership of the Transport,
 * replacing any callbacks" (`mcp.d.ts:38–40`), so one McpServer cannot
 * multiplex across sessions. Stdio calls this exactly once; HTTP calls
 * it once per session.
 */
export function createMcpServerForSession(context: ServerContext): McpServer {
	// `tools` and `resources` capabilities are auto-registered by the SDK
	// when registerTool / registerResource fire; no need to pre-declare.
	// `subscribe: true` was advertised previously but no subscribe handler
	// is wired (W4 may add one alongside chokidar) — drop the false flag.
	const server = new McpServer(SERVER_INFO, { instructions: INSTRUCTIONS });

	// Captured at the initialize handshake (below) and surfaced through
	// `get_server_info.server.mcp_protocol_version`. Defaults to LATEST so
	// pre-handshake debugging calls (no observed client yet) still get an
	// honest value; the initialize handler overwrites this with whatever
	// version the SDK actually negotiated for the session. Per-session
	// under HTTP so two clients on the same process don't clobber each
	// other's negotiated version.
	let negotiatedProtocolVersion: string = LATEST_PROTOCOL_VERSION;

	// D22: declare `2025-06-18` minimum at handshake; reject older clients
	// rather than letting the SDK negotiate down. `setRequestHandler`
	// REPLACES the SDK's auto-registered `_oninitialize`, so the success
	// path must hand-build the response. W2+: replicate
	// `_clientCapabilities` / `_clientVersion` bookkeeping here if the
	// server starts requesting client capabilities (sampling, elicitation).
	server.server.setRequestHandler(InitializeRequestSchema, async (request) => {
		const requested = request.params.protocolVersion;
		if (typeof requested !== "string" || requested < MIN_PROTOCOL_VERSION) {
			throw new McpError(ErrorCode.InvalidRequest, formatProtocolVersionTooOldMessage(requested));
		}
		// Per MCP spec: when the client requests a version the server does
		// not support, respond with the latest version it does. Echoing a
		// future date verbatim would let the client believe the server
		// implements a protocol it actually doesn't.
		const negotiated = SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : LATEST_PROTOCOL_VERSION;
		negotiatedProtocolVersion = negotiated;
		// `_capabilities` is the SDK's authoritative snapshot, populated by
		// the registerTool/registerResource calls below. The public
		// `registerCapabilities` is a mutator only; no public getter exists,
		// so we read the private field via a tight cast to mirror what the
		// SDK's own `_oninitialize` returns.
		const capabilities = (server.server as unknown as { _capabilities: ServerCapabilities })._capabilities;
		return {
			protocolVersion: negotiated,
			capabilities,
			serverInfo: SERVER_INFO,
			instructions: INSTRUCTIONS,
		};
	});

	const serverInfoContext: ServerInfoContext = {
		...context.serverInfoContextBase,
		getMcpProtocolVersion: () => negotiatedProtocolVersion,
	};

	registerTools(server, context.vaultRoot, context.index, context.includeHidden, serverInfoContext);
	registerNoteResource(server, context.vaultRoot, context.includeHidden);
	return server;
}

/**
 * Build a configured `McpServer` for the given vault root plus an
 * in-flight request tracker scoped to that instance. Caller is
 * responsible for connecting it to a transport.
 *
 * Thin wrapper over {@link createServerContext} + {@link createMcpServerForSession}
 * preserved for callers that want the legacy single-shot shape (stdio
 * mainline, existing tests). HTTP transport calls the two-layer API
 * directly to share one context across N sessions.
 *
 * `index` is mandatory for `search` and powers D32 fuzzy stale-id
 * recovery in `get_fragment`. Outline / metadata use it only for the
 * live `_meta.index_status`.
 */
export function createServer(vaultRoot: VaultRoot, index?: IndexHandle, config: ServerConfig = {}): ServerInstance {
	const context = createServerContext(vaultRoot, index, config);
	const server = createMcpServerForSession(context);
	return { server, inflight: context.inflight };
}

// ─── Tool registration ─────────────────────────────────────────────────────

function registerTools(
	server: McpServer,
	vaultRoot: VaultRoot,
	index: IndexHandle | undefined,
	includeHidden: boolean,
	serverInfoContext: ServerInfoContext,
): void {
	server.registerTool(
		"get_vault_tree",
		{
			title: "Get Vault Tree",
			description: TOOL_DESCRIPTIONS.get_vault_tree,
			inputSchema: GetVaultTreeSchema,
		},
		async (input) => handleGetVaultTree(input, vaultRoot, index, includeHidden),
	);

	server.registerTool(
		"get_file_outline",
		{
			title: "Get File Outline",
			description: TOOL_DESCRIPTIONS.get_file_outline,
			inputSchema: GetFileOutlineSchema,
		},
		async (input) => handleGetFileOutline(input, vaultRoot, index, includeHidden),
	);

	server.registerTool(
		"get_fragment",
		{
			title: "Get Fragment",
			description: TOOL_DESCRIPTIONS.get_fragment,
			inputSchema: GetFragmentSchema,
		},
		async (input) => handleGetFragment(input, vaultRoot, index, includeHidden),
	);

	server.registerTool(
		"search",
		{
			title: "Search Vault",
			description: TOOL_DESCRIPTIONS.search,
			inputSchema: SearchSchema,
		},
		async (input) => {
			if (index === undefined) {
				return internalErrorEnvelope("search requires the index handle (server misconfigured).");
			}
			return handleSearch(input, vaultRoot, index, includeHidden);
		},
	);

	server.registerTool(
		"get_metadata",
		{
			title: "Get Metadata",
			description: TOOL_DESCRIPTIONS.get_metadata,
			inputSchema: GetMetadataSchema,
		},
		async (input) => handleGetMetadata(input, vaultRoot, index, includeHidden),
	);

	server.registerTool(
		"get_links",
		{
			title: "Get Links",
			description: TOOL_DESCRIPTIONS.get_links,
			inputSchema: GetLinksSchema,
		},
		async (input) => {
			if (index === undefined) {
				return internalErrorEnvelope("get_links requires the index handle (server misconfigured).");
			}
			return handleGetLinks(input, vaultRoot, index, includeHidden);
		},
	);

	// D37: identity/health snapshot. Index optional — when not configured,
	// `get_server_info` surfaces `index: null` so an agent debugging a stub
	// server sees the misconfig honestly instead of an opaque INTERNAL_ERROR.
	// `serverInfoContext` is built by the caller (createMcpServerForSession)
	// so per-session getters (negotiatedProtocolVersion) stay session-scoped
	// and `rootHash` is hashed once at startup (vault root is process-constant).
	server.registerTool(
		"get_server_info",
		{
			title: "Get Server Info",
			description: TOOL_DESCRIPTIONS.get_server_info,
			inputSchema: GetServerInfoSchema,
		},
		async (input) => handleGetServerInfo(input, serverInfoContext, index),
	);
}

// ─── Resource registration ─────────────────────────────────────────────────

function registerNoteResource(server: McpServer, vaultRoot: VaultRoot, includeHidden: boolean): void {
	server.registerResource(
		"note",
		// `{+path}` is RFC 6570 reserved-character expansion: the SDK's
		// regex becomes `(.+)` and matches slashes, so nested files like
		// `notes/auth.md` are addressable. Plain `{path}` compiles to
		// `([^/,]+)` and silently 404s any nested path.
		new ResourceTemplate("note://{+path}", {
			// W1: empty list — full enumeration ships in W4 alongside
			// `get_vault_tree` (which is the canonical enumeration
			// surface). Returning empty avoids client crashes that expect
			// the list callback to exist.
			list: async () => ({ resources: [] }),
		}),
		{
			title: "Note",
			description:
				"Full source of one vault file (frontmatter included for markdown; literal on-disk bytes for YAML). Vault-relative path; same validatePath rules as tools. mimeType is `text/markdown` for markdown files and `application/yaml` for `.yaml`/`.yml` (D46).",
			// Matching resources span markdown + YAML; the MCP spec sets
			// template-level `mimeType` only for single-type templates.
		},
		async (uri, variables) => {
			// SDK URL-normalizes `request.params.uri` BEFORE this handler runs
			// (mcp.js setResourceRequestHandlers): `new URL(uri)` collapses both
			// path-position `..` and `%2e%2e` segments. Per URL spec these
			// cannot escape past the host root, so validatePath containment
			// holds. Side effect: traversal-style note:// URIs (e.g.
			// `note://sub/../foo.md`, `note://sub/%2e%2e/foo.md`) reach this
			// handler as benign normalized URIs instead of returning
			// PATH_OUTSIDE_VAULT/TRAVERSAL_SEGMENT — the Tool surface has no
			// such gap. Closing it requires bypassing `registerResource` and
			// reimplementing the SDK's URI-template matcher to gain raw-URI
			// access. Deferred per cost/benefit; vault escape is already
			// prevented.
			try {
				const rawPath = Array.isArray(variables.path) ? variables.path.join("/") : variables.path;
				if (typeof rawPath !== "string" || rawPath.length === 0) {
					throw new ResourceUriError("PATH_NOT_FOUND", "note:// URI is missing the path component.");
				}
				// URI Templates capture raw URI substrings; per RFC 3986 the
				// caller percent-encodes reserved/non-ASCII characters in the
				// URI form. Decode once before path-domain validation, else
				// `My%20Note.md` and `unicode-%C3%A9.md` are wrongly rejected
				// as PERCENT_ENCODED. Decoding then validating is safe:
				// `note://%2e%2e/etc` decodes to `../etc` and validatePath
				// rejects it as TRAVERSAL_SEGMENT.
				let decodedPath: string;
				try {
					decodedPath = decodeURIComponent(rawPath);
				} catch {
					throw new ResourceUriError("PATH_NOT_FOUND", "note:// URI has malformed percent-encoding.");
				}
				const safePath = await validatePath(decodedPath, vaultRoot);
				// `readSource` (not `readNote`) returns the literal on-disk
				// file including frontmatter, the brief's contract for
				// `note://`. Skipping the parser also lets a parse-only
				// failure like AST cap not block a readable file. D44 note:
				// for OpenAPI YAML, `parseFile` produces a synthesized
				// `ParsedFile.source` distinct from the on-disk bytes —
				// `note://` deliberately surfaces the literal bytes so
				// agents reading the resource get the spec verbatim.
				const { source } = await readSource(safePath, includeHidden);
				const mimeType = getParserKind(safePath.relative) === "yaml" ? "application/yaml" : "text/markdown";
				return {
					contents: [{ uri: uri.toString(), mimeType, text: source }],
				};
			} catch (err) {
				throw resourceErrorToMcp(err);
			}
		},
	);
}

/**
 * Local marker for path-domain rejections raised inside the resource handler
 * body (missing path, malformed percent-encoding). Caught by the handler's
 * single mapping path so the body stays free of `new McpError(...)` plumbing.
 */
class ResourceUriError extends Error {
	readonly code: VaultErrorCode;
	constructor(code: VaultErrorCode, message: string) {
		super(message);
		this.code = code;
	}
}

function resourceErrorToMcp(err: unknown): McpError {
	if (err instanceof McpError) return err;
	if (err instanceof ResourceUriError) {
		const payload = vaultError(err.code, err.message, { param: "uri" });
		return new McpError(ErrorCode.InvalidParams, payload.message, payload);
	}
	if (err instanceof PathValidationError) {
		// validatePath's payload sets `param: "file"` (Tool surface); rebrand
		// for the Resource surface — the bad input here is the URI.
		const payload = { ...err.payload, param: "uri" };
		return new McpError(ErrorCode.InvalidParams, payload.message, payload);
	}
	if (err instanceof FileTooLargeError) {
		// Mirror the tool path's `fileTooLargeEnvelope` (error.ts) — clients
		// keying off `limit_bytes`/`actual_bytes` to surface the cap and
		// observed size need both fields on the resource path too.
		const payload = vaultError("FILE_TOO_LARGE", err.message, {
			param: "uri",
			limit_bytes: err.limitBytes,
			actual_bytes: err.actualBytes,
		});
		return new McpError(ErrorCode.InternalError, payload.message, payload);
	}
	if (err instanceof ParseError) {
		const payload = parseErrorPayload(err, "uri", { messagePrefix: "note:// parse failed: " });
		return new McpError(ErrorCode.InvalidParams, payload.message, payload);
	}
	const payload = vaultError("INTERNAL_ERROR", `note:// read failed: ${errorMessage(err)}`, { param: "uri" });
	return new McpError(ErrorCode.InternalError, payload.message, payload);
}
