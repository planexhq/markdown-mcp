# Changelog

All notable changes to markdown-mcp are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

Two features shipping together: **HTTP transport** (Streamable HTTP / Docker) and **structured AsyncAPI 3.x synthesis**. Independent — adopt either or both.

### HTTP transport

Adds Streamable HTTP (MCP spec 2025-06-18+) as an opt-in alongside the existing stdio default — one process can now serve multiple concurrent agent sessions sharing one warm index. Bind is loopback-only; non-loopback addresses are rejected at startup. Optional bearer auth via `MCP_AUTH_TOKEN` for defense-in-depth on shared dev hosts. The stdio path is byte-identical to 1.1.0; no existing setup needs to change.

#### Added

- **`--transport <stdio|http>`**. Stdio is the default; HTTP opts in via `--transport http`. Under HTTP, `--port <n>` (default `3000`; use `0` for OS-assigned) and `--bind <addr>` (default `127.0.0.1`; loopback only) control the listener. Multiple concurrent sessions share one `IndexHandle` + `InflightTracker`; each session gets its own per-session `McpServer` because the SDK's `Server.connect` takes ownership of a transport and one McpServer can't multiplex.
- **`MCP_AUTH_TOKEN` env var**. When set, every HTTP request must carry `Authorization: Bearer <token>`. Constant-time compare via `crypto.timingSafeEqual` over `sha256` hashes (fixed-length inputs prevent length-leak via timing). Missing or mismatched → 401 JSON-RPC error body. Unset → no auth (loopback-trust model, matching stdio). Stdio is unaffected. Read once at startup; restart to rotate.
- **`get_server_info.server.transport`**. New field on `ServerIdentity`: `"stdio" | "http"`. HTTP additionally populates `bind_address` (the loopback address bound) and `port` (the **resolved** port — `--port 0` reports the OS-assigned value). Lets agents self-verify which channel they reached over before making transport-specific decisions.
- **`createServerContext` + `createMcpServerForSession`**. `src/server.ts` factored: `createServerContext(vaultRoot, index, config)` builds the shared `ServerContext` (one InflightTracker, hashed `rootHash`, `serverInfoContextBase` with transport metadata) reused across sessions; `createMcpServerForSession(context)` returns one `McpServer` with a fresh per-session `negotiatedProtocolVersion` closure. `createServer` retained as a thin backward-compat wrapper — stdio path unchanged.
- **`wireInflight(transport, inflight)` helper** (`src/lib/inflightTracker.ts`). Extracted from the inline stdio wiring at `src/index.ts:653–663`. Same contract: increment on inbound request, decrement after `transport.send` fully resolves. HTTP wires it per session; stdio wires it once.
- **`src/lib/httpTransport.ts`** (~350 LoC). Owns `node:http.Server`, the `Map<sessionId, {transport, mcpServer}>`, the `/mcp` POST/GET/DELETE router, body reader (64 KiB cap → 413), optional bearer-token check. Per-session `StreamableHTTPServerTransport` constructed with `enableDnsRebindingProtection: true` + `allowedHosts`/`allowedOrigins` covering the four loopback Host forms (built after `httpServer.listen()` resolves, so `--port 0` allowlist matches the OS-assigned port).
- **HTTP integration test suite** (`test/integration/http-transport.test.ts`). End-to-end: transport identity in `get_server_info`, multi-session concurrent clients, bearer auth ladder (no token / wrong token / right token), SIGTERM clean drain. New `test/helpers/mcp-http-client.ts` mirrors the stdio harness.

#### Changed

- **D22's "HTTP+SSE deferred to a future major" clause is superseded.** D22's stdio default + `2025-06-18` protocol floor remain authoritative.
- **THREAT_MODEL V7 reactivated** (was deferred). Mitigations: localhost-only bind enforced at CLI parse, SDK DNS-rebinding protection + allowedHosts/allowedOrigins, optional bearer token. Residual: any local process on the same host can reach `127.0.0.1:<port>` — same model as `redis-server` default, `sqlite3 :memory:`, `chromedriver`. Operators on shared hosts should set `MCP_AUTH_TOKEN`.
- **Brief lines 763 / 930 / 1045 amended** to reflect dual-transport. Concurrency model now distinguishes stdio (one client) from HTTP (multiple sessions, same trusted local user).
- **`tearDownAndExit` extended** with `await httpHandle?.close()` between phase 1 (inflight drain) and phase 2 (producer stop). The HTTP handle closes idle keep-alive sockets, tears down per-session McpServer + transport (which terminates SSE streams), then awaits `httpServer.close`. InflightTracker remains the drain authority — `StreamableHTTPServerTransport.close()` does NOT drain on its own.

#### Out of scope (deferred)

- **`--bind 0.0.0.0` / non-loopback binds.** Needs V7 rewrite + multi-tenant identity + rate limiting + TLS.
- **OAuth / mTLS / JWT auth.** Bearer is the v1 surface.
- **Per-session policy override** (e.g. one session `include_hidden: true`, another `false`). v1 inherits process-wide policy.
- **Web Standard transport** (`Request`/`Response` shape for Cloudflare Workers / Deno / Bun). Project is Node-only.
- **Lockfile transport-mode schema extension.** Same-vault same-port HTTP collisions are caught by `EADDRINUSE`; document as "don't do that."
- **Session ID in `_meta`.** Stderr `session opened` / `session closed` log lines suffice for v1.
- **HTTP transport resumability** (SDK's `EventStore` option). Defer until long-running-request + flaky-connection scenarios materialize.

### Structured AsyncAPI 3.x synthesis

AsyncAPI specs join OpenAPI and opaque YAML on the parseable surface; same `kind: "yaml"` plumbing, same `note://` literal-YAML contract.

#### Added

- **AsyncAPI 3.x synthesis.** When a YAML file's top-level matches `asyncapi: "3.*"`, the parser emits one `HeadingMeta` per `operations.<opName>` entry. `stable_id` slot input is `sha14(opName)` — operation names are explicit map keys guaranteed unique in 3.x, so the hash input is single-source. `get_file_outline` returns `<action> <opName>` headings (`send userSignedUp`, `receive lightMeasured`); `get_fragment` returns synthesized prose with channel address, message list, reply info, tags + a compact JSON fence of the full operation object (64 KiB cap). On truncation the fence language drops to `text` so agents calling `JSON.parse` don't fail on a partial payload.
- **Intra-doc `$ref` resolution.** The synthesizer resolves two ref shapes: `#/channels/<chan>` (read `channel.address` for the operation's prose) and `#/channels/<chan>/messages/<msg>` (read the message name for the bullet list). RFC 6901 segment decoding (`~1`/`~0`) is applied so channel names containing `/` resolve correctly. External `$ref` strings (`./shared.yaml#/...`) render verbatim.
- **Action-aware operation headings.** `<action> <opName>` distinguishes the two operations a single channel typically hosts (one `send` + one `receive`). The `action` field is treated as orientation, not identity: flipping `send` ↔ `receive` on the same operation preserves the `stable_id`.
- **`## Channels` + `## Components` catch-all sections.** Each emits a single heading + single JSON fence (mirrors OpenAPI's `## Components`). Outline size stays bounded by `2 + (# operations)` on 100-channel specs.
- **Servers preamble.** Top-level `servers` render as `- <name> (<protocol>): <host[<pathname>]>` lines in the preamble, capped at 20 entries with an overflow marker. AsyncAPI 3 dropped `url` in favor of `host` + optional `pathname`; the synthesizer composes the two, inserting a `/` separator when pathname doesn't have a leading one.

#### Changed

- **Dispatcher order in `src/lib/parsers/yaml.ts`**: OpenAPI detection first, then AsyncAPI detection, then opaque fallback. `top.openapi` and `top.asyncapi` are mutually exclusive at the document level so order matters only as a no-op tie-break.
- **`buildWikilinkRows` gate now applies to AsyncAPI-synthesized files** — already inherited via the `parsed.kind === "yaml"` early-return in `scanner.ts`. Phantom `[[X]]` text inside AsyncAPI YAML scalars never surfaces as outgoing links.
- **Channel address null/absent rendering.** The `Channel:` line now reads `<id> (address unknown)` when the resolved channel's `address` is null or omitted, instead of bare `<id>`. AsyncAPI 3 spec defines null/absent address as "unknown"; the disambiguator preserves the channel-ID for navigation while marking that it is NOT an on-the-wire address.
- **Operation-trait merge widens to all AsyncAPI 3 OperationTrait fields**. `applyTraitMerge` now performs a full JSON Merge Patch per RFC 7396; `title`, `security`, `externalDocs`, and `bindings` from a referenced trait now flow into the per-operation JSON fence alongside `summary`/`description`/`tags`. Spec-forbidden trait fields (`action`/`channel`/`messages`/`reply`/`traits`) are defensively filtered. Search recall on operations that inherit protocol bindings (e.g. `kafka.topic`) improves — the binding now lands on the operation's fence rather than only the `## Components` catch-all.
- **Operation-trait merge is RECURSIVE for nested object-valued fields.** `applyTraitMerge` recurses through `bindings`, `externalDocs`, and any other nested object so partial trait overrides preserve inherited subfields — an op carrying `bindings: {kafka: {clientId: "X"}}` plus a trait carrying `bindings: {kafka: {topic: "Y"}}` now serializes both into the per-op fence (previously the trait's `topic` was silently dropped). Arrays (`tags`, `security`) stay atomic per RFC 7396 §1; target still wins at every leaf.

#### Security

- **AsyncAPI trait merge no longer routes attacker-supplied `__proto__` keys through the inherited prototype setter.** The `yaml` library defines parsed `__proto__:` map keys as own enumerable data properties; previously our `applyTraitMerge` / `deepMerge` did `target[k] = source[k]` which, for `k === "__proto__"`, invoked the inherited accessor on `Object.prototype` and changed the merge target's `[[Prototype]]` to the attacker-supplied payload. With an op carrying own `__proto__` + at least one trait, `entry.merged.summary` (and other top-level `stringField` reads in the prose renderer) walked the polluted prototype chain and surfaced attacker-controlled prose into synthesized fragments. New `DANGEROUS_KEYS = Set("__proto__", "constructor")` filter silently drops both keys at every depth of the merge. Trigger requires attacker-controlled YAML in the local vault — narrow given the vault is user-owned local content, but the fix is precautionary. Bumps `PARSER_SHAPE_VERSION` so the cold-rescan machinery removes the attacker's residual rows on upgrade.
- **AsyncAPI merge output is now `deepSanitize`d at every depth.** The previous `DANGEROUS_KEYS` filter ran at each merge step (the inner loop guard) but didn't walk nested subtrees — a trait subtree like `bindings.kafka.__proto__: {topic: "X"}` was copied wholesale when the operation didn't have that same nested branch, so `JSON.stringify(entry.merged)` enumerated the nested `__proto__` data into the per-op fence. No prototype pollution (shallow spread uses CreateDataProperty, not [[Set]]), but the attacker-controlled content reached the BM25 index. The new `deepSanitize` post-pass on `applyTraitMerge`'s output drops `__proto__` / `constructor` keys at every depth of the merged tree, matching the documented "every depth of the merge" coverage.
- **`deepSanitize` now also walks arrays.** The previous post-pass returned arrays unchanged because `isPlainObject([…])` is false, so attacker payloads nested inside array-valued AsyncAPI fields (`tags: [{__proto__: {pwn: "X"}, name: "Y"}]`, `security: [{type: "X", constructor: {evil: "Z"}}]`) survived into `entry.merged` and into the per-op / aliased-operations JSON fences. No prototype pollution at any nested depth (shallow spread + CreateDataProperty) but BM25 indexed the attacker-controlled content via the fence, mismatching the documented "every depth" coverage. The new array branch maps element-wise through `deepSanitize` so object/array/scalar dispatch applies recursively.
- **AsyncAPI `## Channels` + `## Components` catch-all fences now `deepSanitize`d.** The per-op merge tree has been scrubbed since the earlier `__proto__` / `constructor` hardening, but the catch-all sections that serialize `top.channels` / `top.components` directly via `JSON.stringify` bypassed the scrub — yaml-parsed `__proto__:` keys nested anywhere inside (e.g. `components.operationTraits.evil.__proto__: {pwn: "X"}`) landed in the BM25-indexed fence verbatim. New `deepSanitize(channels)` / `deepSanitize(components)` wraps close the gap. The `## Spec metadata` residual is intentionally NOT scrubbed because top-level / map-key `__proto__:` is legitimate user content under the `safeSet` rule (operation names, info x-* extension fields). Bumps `PARSER_SHAPE_VERSION` so existing caches re-index without the attacker payload on upgrade.

#### Known issues

- **Older binaries cannot refuse this version's lockfile.** Older `parseLockFile` implementations validate only `includeHidden` strictly and silently ignore unknown fields (including `parserShapeVersion`). So while this binary correctly refuses older slots (missing-field coerced to 0; mismatch → conflict), older binaries running against the same vault admit this binary's lockfile as compatible and write old-shape rows into a DB stamped at the newer parser. Mitigation is operator-facing: stop all running older peers before launching this version. Lock-format approaches considered (type-bumping `includeHidden`, side-channel filename, strict `lockFormatVersion` field) either silently delete the running peer's lockfile via the legacy-cleanup path or require older binaries to validate fields they don't know about — neither retroactively achievable.

#### Out of scope (later)

- **AsyncAPI 2.x synthesis.** Nested `channels.<name>.publish/subscribe` is a different shape; supporting both versions doubles synthesis code. 2.x specs index opaquely via the opaque-YAML fallback.
- **External `$ref` dereferencing.** Cross-file refs render as raw `$ref` strings in prose.
- **Wikilinks INTO AsyncAPI YAML.** `[[streetlights]]` does not resolve to `streetlights.yaml` — same deferral as OpenAPI.
- **`[[spec.yaml#operations/turnOn]]`** AsyncAPI fragment refs in wikilinks.
- **Per-protocol binding prose rendering** (Kafka headers, MQTT QoS, AMQP exchange types). Bindings reach FTS only via the JSON fence.
- **`operation.reply.address.location` runtime-expression resolution** (e.g. `$message.header#/replyTo`) — rendered as-is in prose.
- **Chained `$ref` resolution.** Refs that point to another ref (`#/components/operations/X` whose target is itself a `$ref`) stay unresolved; single-level dereference only.

## [1.1.0] — 2026-05-19

Structured OpenAPI 3.x + opaque YAML support. YAML files join markdown on the parseable surface when admitted via `VAULT_EXTENSIONS`.

### Added

- **OpenAPI 3.x synthesis.** When a YAML file's top-level matches `openapi: "3.*"`, the parser emits one `HeadingMeta` per `paths.<path>.<method>` operation. `stable_id` is derived from `sha8(method + " " + path)` — name-based, so sibling reorder doesn't retire IDs. `get_file_outline` returns one node per operation (`GET /pets`); `get_fragment` returns a synthesized prose rendering (summary, description, parameter prose, plus a compact JSON fence of the full operation object, capped at 64 KiB). On truncation the fence language drops to `text` so agents calling `JSON.parse` on the fragment body don't fail on a partial payload.
- **Opaque YAML emission.** Non-OpenAPI YAML (Swagger 2.x, generic configs, etc.) indexes opaquely: whole source searchable, parsed top-level exposed as `frontmatter` so nested-path filters (`fields["info.version"].eq`) work directly. `get_metadata` returns the whole top-level object.
- **`YAML_PARSE_ERROR`.** New error code discriminated on `ParseError.format`. Same `reason` set as `MARKDOWN_PARSE_ERROR`: `"syntax" | "ast_node_cap_exceeded" | "encoding_failed"`. Pathological-depth input that overflows the V8 stack (`RangeError`) is reclassified to `ast_node_cap_exceeded` at both the `parseYAML` and `normalizeForJson` layers — user-facing error code stays consistent with the explicit cap walker.
- **`note://` for YAML.** `note://api/petstore.yaml` returns the literal on-disk YAML with `mimeType: application/yaml`. The Resource still preserves on-disk bytes verbatim, so agents calling the Resource see spec truth; `get_fragment` returns the synthesized prose rendering.
- **`VAULT_EXTENSIONS=md,yaml,yml`.** The extension predicate now admits YAML alongside markdown. Single source of truth: `isParseablePath` gates scanner walk / watcher / `note://` / direct-read tools; the parallel `isResolvableLinkTarget` predicate (excludes YAML) gates `[[wikilink]]` resolution.

### Changed

- **`VAULT_EXTENSIONS` change forces a one-time cold rescan.** The value is persisted in `index_meta.vault_extensions`; startup compares running vs persisted and triggers a full re-walk on mismatch. Older caches coerce `NULL → "md"` for the upgrade path. Per-machine cost is bounded by the existing first-cold-scan budget (~5 s for 1K files, ~30 s for 10K).
- **Hard caps cover YAML symmetrically**. `MAX_AST_NODES = 50K` and `MAX_FILE_BYTES = 10 MB` apply to markdown and YAML inputs alike (`YAML_PARSE_ERROR.reason = "ast_node_cap_exceeded"` / `FILE_TOO_LARGE`).

### Deferred

Follow-ups surfaced during the YAML-support review iterations, scoped for v1.x:

- Fold `enforceNodeCap` into `normalizeForJson` (single tree walk).
- `computePolicyMismatch` 5 SELECTs → 1 (mirror of `getStatusSnapshot`).
- `stringifyOperationJson` lazy / index-time vs tool-time split.
- Shared `lineTable` module between `openapi.ts` and `parser.ts`.
- Opaque YAML body-weight asymmetry (currently routed through `body` at BM25 weight 2.0).

### Out of scope (later)

- **Wikilinks INTO YAML.** `[[petstore]]` does not resolve to `petstore.yaml` — admitting YAML to the resolver requires basename-collision rules between `foo.md` and `foo.yaml`.
- **OpenAPI 2.x (Swagger) synthesis.** Falls through to opaque YAML emission.
- **`$ref` dereferencing.** Opaque text indexing covers basic search.
- **`[[spec.yaml#paths./users/get]]`** OpenAPI fragment refs in wikilinks.

## [1.0.0] — 2026-05-18

Initial release. Seven tools + one resource, MCP spec **2025-06-18**, stdio transport, single-vault per process, read-only.

### Tools

- **`get_vault_tree`** — Paginated DFS over the vault. Cursor sort tuple `{dfs_rank}`. Each item exposes `dfs_rank` for stable pagination across snapshots.
- **`get_file_outline`** — Full heading tree + block-ID index for one file. Outline is the authoritative source for `stable_id` resolution.
- **`get_fragment`** — Anchor resolution by `heading_path` / `block` / `stable_id` / `file`. Discriminated-union response per anchor kind. Stale `stable_id` recovers via `stable-id-fuzzy-v1` against `heading_history`.
- **`search`** — BM25 full-text (`bm25(_, 2.0, 0.5, 3.0)` weights — body=2.0, code=0.5, headings=3.0) plus structured frontmatter filter. Two retrieval modes: query mode and filter-only mode. Discriminated-union row shape over `anchor_kind`.
- **`get_metadata`** — Parsed YAML frontmatter as JSON; nested objects preserved (not flattened).
- **`get_links`** — Outgoing wikilinks + incoming backlinks, with optional narrowing by `heading_path` or `stable_id`. Cursor sort tuple `{source_file, source_heading_path, link_ordinal}`.
- **`get_server_info`** — Identity / health snapshot for agent self-verification: server version + vault `root_hash`, index `state` + `files_indexed` + `last_scan_finished_at` + optional `degraded` flags, algorithm IDs, registered tool / resource capability list. Zero input; always succeeds.

Every tool response carries **both** `structuredContent` (machine-readable JSON; authoritative per MCP spec when present) **and** `content[0].text` (markdown prose for human-facing hosts that prefer text rendering). Both reflect the same data; agents that parse `structuredContent` can ignore the text channel. The `--prose-only` flag drops `structuredContent` so the prose body is the sole channel — useful for token-constrained LLM-consumer workflows; the prose renderers carry load-bearing fields (labels, candidates, progress, hash-fenced bodies, `<U+HHHH>` markers for YAML-hostile codepoints) so no data is lost.

### Resource

- **`note://{path}`** — Raw on-disk markdown (frontmatter included) for any file matching `VAULT_EXTENSIONS`. Single `read_note` serializer shared with `get_fragment`.

### Security & hardening

- Single `validatePath` entry point. `path.relative` containment, segment-walk symlink rejection, `O_NOFOLLOW` on the final read.
- Vault-root `lstat`-before-`realpath` startup sequence (rejects a symlinked vault root).
- Hard caps: 10 MB per file (`FILE_TOO_LARGE`), 50K AST nodes (`MARKDOWN_PARSE_ERROR.reason = "ast_node_cap_exceeded"`), 32-segment path depth (`PATH_OUTSIDE_VAULT`).
- All filter SQL is parameterized; FTS5 input runs through `query-sanitize-v1`.
- Threat-model vectors V1–V7 covered by tests; V2 (prompt injection via vault content) is a host-layer responsibility — the server faithfully returns the vault content the host queried, and the host is responsible for sandboxing the surfaced text.

### Infrastructure

- Async-reconcile startup: SQLite opens immediately and serves; full Merkle walk runs in the background. `_meta.index_status.state` advertises `cold | warming | warm | reconciling`.
- chokidar v4 file watcher with `awaitWriteFinish` for editor atomic-rename saves; 5-minute Merkle reconciliation tick covers missed events.
- Write coordinator serializes scanner + watcher + merkle writes per file (last-stat-wins).
- Schema migration guard for pre-W4 databases — forces a full rescan to backfill `wikilinks` + `file_metrics` rows.
- Graceful shutdown: SIGTERM / SIGINT / SIGHUP / stdin-EOF all route through a single teardown chain. A transport-boundary in-flight tracker drains outstanding `tools/call` / `resources/read` responses — including the SDK's wait on stdout's `drain` event under OS-pipe backpressure — before closing the transport. Half-close clients (test harnesses, batch scripts, orphan-defense paths) see complete responses instead of truncated stdout buffers.

### CLI flags

- `--vault <path>` (required)
- `--polling` — force fs polling for chokidar (network mounts / unreliable native FS events)
- `--include-hidden` — include dot-prefixed paths on every surface (all-or-nothing per server)
- `--prose-only` — suppress `structuredContent` on every tool response; `get_server_info.server.prose_only` reflects the flag for agent self-verification
- `-h`, `--help`

### Performance

Verified on a 10K-file synthetic vault:

- Cold-start scan completes; warm-restart reconcile uses `(mtime, size)` skip path
- Search p95 < 100 ms (W3 budget)
- Watcher event-to-index lag p95 within debounce window (W4 budget)

Run `npm run bench` to reproduce locally.

### Locked-in design

Internal algorithm IDs that ship with v1.0.0:

- `query-sanitize-v1`
- `bm25-fragment-v1` and `filter-preview-v1` snippet algorithms
- `stable-id-fuzzy-v1`
- `filter-keyset-v1`, `links-keyset-v1`, `tree-dfs-v1` cursor sort tuples

Algorithm IDs are versioned in `_meta`; behavior changes bump the id rather than mutating under the old name.

[Unreleased]: https://github.com/planexhq/markdown-mcp/compare/v1.1.0...HEAD
[1.1.0]: https://github.com/planexhq/markdown-mcp/releases/tag/v1.1.0
[1.0.0]: https://github.com/planexhq/markdown-mcp/releases/tag/v1.0.0
