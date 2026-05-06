/**
 * MCP server skeleton.
 *
 * Registers all 6 tools and the `note://` resource. In W1, every tool
 * handler returns the `INTERNAL_ERROR` domain envelope (D13 hybrid:
 * successful tool result + `isError: true` + `structuredContent`); the
 * resource read handler throws `McpError` with `-32603` so the SDK
 * surfaces it as a JSON-RPC error with our domain `code` in `data`.
 *
 * Real implementations land:
 *   - get_file_outline, get_fragment, get_metadata → W2
 *   - search, get_links partial, get_vault_tree → W3/W4
 *   - note:// real read, _meta finalization → W5
 *
 * `validatePath` is wired now (D8 + D16): every tool handler validates
 * its path argument first, even though the rest of the handler is a
 * stub. This locks the security invariant from day 1.
 */

import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
	ErrorCode,
	InitializeRequestSchema,
	McpError,
	type ServerCapabilities,
} from "@modelcontextprotocol/sdk/types.js";

import { internalErrorEnvelope, newMeta, toolErrorEnvelope, vaultError } from "./lib/error.js";
import { MIN_PROTOCOL_VERSION } from "./lib/limits.js";
import { PathValidationError, type VaultRoot, validatePath } from "./lib/validatePath.js";
import {
	GetFileOutlineSchema,
	GetFragmentSchema,
	GetLinksSchema,
	GetMetadataSchema,
	GetVaultTreeSchema,
	SearchSchema,
	TOOL_DESCRIPTIONS,
} from "./schemas.js";
import { handleGetFileOutline } from "./tools/getFileOutline.js";
import { handleGetFragment } from "./tools/getFragment.js";
import { handleGetMetadata } from "./tools/getMetadata.js";

/**
 * Server name + version reported in the MCP `initialize` handshake.
 * Bumped to a real `1.0.0` at the W5 release cut.
 */
const SERVER_INFO = {
	name: "vault-mcp",
	version: "1.0.0-w1",
} as const;

const INSTRUCTIONS =
	"Read-only access to a local markdown vault. Use get_vault_tree to discover files, get_file_outline + get_fragment for navigation.";

/**
 * Build a configured `McpServer` for the given vault root. Caller is
 * responsible for connecting it to a transport (stdio in v1, SSE/HTTP
 * deferred per D22).
 */
export function createServer(vaultRoot: VaultRoot): McpServer {
	// `tools` and `resources` capabilities are auto-registered by the SDK
	// when registerTool / registerResource fire; no need to pre-declare.
	// `subscribe: true` was advertised previously but no subscribe handler
	// is wired (W4 may add one alongside chokidar) — drop the false flag.
	const server = new McpServer(SERVER_INFO, { instructions: INSTRUCTIONS });

	// D22: declare `2025-06-18` minimum at handshake; reject older clients
	// rather than letting the SDK negotiate down. `setRequestHandler`
	// REPLACES the SDK's auto-registered `_oninitialize`, so the success
	// path must hand-build the response. W2+: replicate
	// `_clientCapabilities` / `_clientVersion` bookkeeping here if the
	// server starts requesting client capabilities (sampling, elicitation).
	server.server.setRequestHandler(InitializeRequestSchema, async (request) => {
		const requested = request.params.protocolVersion;
		if (typeof requested !== "string" || requested < MIN_PROTOCOL_VERSION) {
			throw new McpError(
				ErrorCode.InvalidRequest,
				`vault-mcp requires MCP protocol version ${MIN_PROTOCOL_VERSION} or newer; client requested ${requested}.`,
			);
		}
		// `_capabilities` is the SDK's authoritative snapshot, populated by
		// the registerTool/registerResource calls below. The public
		// `registerCapabilities` is a mutator only; no public getter exists,
		// so we read the private field via a tight cast to mirror what the
		// SDK's own `_oninitialize` returns.
		const capabilities = (server.server as unknown as { _capabilities: ServerCapabilities })._capabilities;
		return {
			protocolVersion: requested,
			capabilities,
			serverInfo: SERVER_INFO,
			instructions: INSTRUCTIONS,
		};
	});

	registerTools(server, vaultRoot);
	registerNoteResource(server, vaultRoot);
	return server;
}

// ─── Tool registration ─────────────────────────────────────────────────────

function registerTools(server: McpServer, vaultRoot: VaultRoot): void {
	server.registerTool(
		"get_vault_tree",
		{
			title: "Get Vault Tree",
			description: TOOL_DESCRIPTIONS.get_vault_tree,
			inputSchema: GetVaultTreeSchema,
		},
		async ({ path }) => stubWithPathValidation(vaultRoot, path, "get_vault_tree"),
	);

	server.registerTool(
		"get_file_outline",
		{
			title: "Get File Outline",
			description: TOOL_DESCRIPTIONS.get_file_outline,
			inputSchema: GetFileOutlineSchema,
		},
		async (input) => handleGetFileOutline(input, vaultRoot),
	);

	server.registerTool(
		"get_fragment",
		{
			title: "Get Fragment",
			description: TOOL_DESCRIPTIONS.get_fragment,
			inputSchema: GetFragmentSchema,
		},
		async (input) => handleGetFragment(input, vaultRoot),
	);

	server.registerTool(
		"search",
		{
			title: "Search Vault",
			description: TOOL_DESCRIPTIONS.search,
			inputSchema: SearchSchema,
		},
		async ({ scope }) => stubWithPathValidation(vaultRoot, scope?.path, "search"),
	);

	server.registerTool(
		"get_metadata",
		{
			title: "Get Metadata",
			description: TOOL_DESCRIPTIONS.get_metadata,
			inputSchema: GetMetadataSchema,
		},
		async (input) => handleGetMetadata(input, vaultRoot),
	);

	server.registerTool(
		"get_links",
		{
			title: "Get Links",
			description: TOOL_DESCRIPTIONS.get_links,
			inputSchema: GetLinksSchema,
		},
		async ({ file }) => stubWithPathValidation(vaultRoot, file, "get_links"),
	);
}

/**
 * Run `validatePath` on the user-supplied file path (skipped if undefined,
 * for tools where path is optional like `search.scope.path`); on success
 * return the W1 stub `INTERNAL_ERROR` envelope, on failure return the
 * `PATH_OUTSIDE_VAULT` (or `PATH_NOT_FOUND`) envelope. Wires the D8/D16
 * invariant from W1 even though the read handlers are stubs.
 */
async function stubWithPathValidation(
	vaultRoot: VaultRoot,
	file: string | undefined,
	toolName: string,
): Promise<ReturnType<typeof internalErrorEnvelope>> {
	if (file !== undefined) {
		try {
			await validatePath(file, vaultRoot);
		} catch (err) {
			if (err instanceof PathValidationError) {
				return toolErrorEnvelope(err.payload, newMeta());
			}
			throw err;
		}
	}
	return internalErrorEnvelope(`${toolName} not yet implemented (W1 stub).`);
}

// ─── Resource registration ─────────────────────────────────────────────────

function registerNoteResource(server: McpServer, vaultRoot: VaultRoot): void {
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
				"Full markdown of one vault file (frontmatter included). Vault-relative path; same validatePath rules as tools.",
			mimeType: "text/markdown",
		},
		async (_uri, variables) => {
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
			const rawPath = Array.isArray(variables.path) ? variables.path.join("/") : variables.path;
			if (typeof rawPath !== "string" || rawPath.length === 0) {
				const err = vaultError("PATH_NOT_FOUND", "note:// URI is missing the path component.", {
					param: "uri",
				});
				throw new McpError(ErrorCode.InvalidParams, err.message, err);
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
				const err = vaultError("PATH_NOT_FOUND", "note:// URI has malformed percent-encoding.", {
					param: "uri",
				});
				throw new McpError(ErrorCode.InvalidParams, err.message, err);
			}
			try {
				await validatePath(decodedPath, vaultRoot);
			} catch (err) {
				if (err instanceof PathValidationError) {
					// validatePath's payload sets `param: "file"` (Tool surface);
					// rebrand for the Resource surface — the bad input here is
					// the request URI, not a file argument.
					const payload = { ...err.payload, param: "uri" };
					throw new McpError(ErrorCode.InvalidParams, payload.message, payload);
				}
				throw err;
			}
			// W1 stub: validation passed but read is not wired up yet.
			// Surface as -32603 with our domain code so clients can
			// distinguish a server-side stub from a real -32603 transport
			// failure.
			const stubErr = vaultError("INTERNAL_ERROR", "note:// read not yet implemented (W1 stub).", { param: "uri" });
			throw new McpError(ErrorCode.InternalError, stubErr.message, stubErr);
		},
	);
}
