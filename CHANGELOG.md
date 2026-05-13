# Changelog

All notable changes to markdown-mcp are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] — 2026-05-11

Initial release. Six tools + one resource, MCP spec **2025-06-18**, stdio transport, single-vault per process, read-only.

### Tools

- **`get_vault_tree`** — Paginated DFS over the vault. Cursor sort tuple `{dfs_rank}` (D35). Each item exposes `dfs_rank` for stable pagination across snapshots.
- **`get_file_outline`** — Full heading tree + block-ID index for one file. Outline is the authoritative source for `stable_id` resolution (D27).
- **`get_fragment`** — Anchor resolution by `heading_path` / `block` / `stable_id` / `file`. Discriminated-union response per anchor kind (D29). Stale `stable_id` recovers via `stable-id-fuzzy-v1` against `heading_history` (D32).
- **`search`** — BM25 full-text (D18 weights `body=2.0, code=0.5, headings=3.0`) plus structured frontmatter filter (D30). Two retrieval modes (D33): query mode and filter-only mode. Discriminated-union row shape over `anchor_kind` (D31).
- **`get_metadata`** — Parsed YAML frontmatter as JSON; nested objects preserved (not flattened).
- **`get_links`** — Outgoing wikilinks + incoming backlinks, with optional narrowing by `heading_path` or `stable_id`. Cursor sort tuple `{source_file, source_heading_path, link_ordinal}` (D34).

### Resource

- **`note://{path}`** — Raw on-disk markdown (frontmatter included) for any file matching `VAULT_EXTENSIONS`. Single `read_note` serializer shared with `get_fragment` per D16.

### Security & hardening

- Single `validatePath` entry point (D8/D16). `path.relative` containment, segment-walk symlink rejection, `O_NOFOLLOW` on the final read.
- Vault-root `lstat`-before-`realpath` startup sequence (rejects a symlinked vault root).
- Hard caps: 10 MB per file (`FILE_TOO_LARGE`), 50K AST nodes (`MARKDOWN_PARSE_ERROR.reason = "ast_node_cap_exceeded"`), 32-segment path depth (`PATH_OUTSIDE_VAULT`).
- All filter SQL is parameterized; FTS5 input runs through `query-sanitize-v1` (D23).
- Threat-model vectors V1–V7 covered by tests; V2 (prompt injection via vault content) is a host-layer responsibility — the server faithfully returns the vault content the host queried, and the host is responsible for sandboxing the surfaced text.

### Infrastructure

- Async-reconcile startup: SQLite opens immediately and serves; full Merkle walk runs in the background. `_meta.index_status.state` advertises `cold | warming | warm | reconciling`.
- chokidar v4 file watcher with `awaitWriteFinish` for editor atomic-rename saves; 5-minute Merkle reconciliation tick covers missed events.
- Write coordinator serializes scanner + watcher + merkle writes per file (last-stat-wins).
- Schema migration guard for pre-W4 databases — forces a full rescan to backfill `wikilinks` + `file_metrics` rows.

### CLI flags

- `--vault <path>` (required)
- `--polling` — force fs polling for chokidar (network mounts / unreliable native FS events)
- `--include-hidden` — include dot-prefixed paths on every surface (all-or-nothing per server)
- `-h`, `--help`

### Performance

Verified on a 10K-file synthetic vault:

- Cold-start scan completes; warm-restart reconcile uses `(mtime, size)` skip path
- Search p95 < 100 ms (W3 budget)
- Watcher event-to-index lag p95 within debounce window (W4 budget)

Run `npm run bench` to reproduce locally.

### Locked-in design

Internal algorithm IDs that ship with v1.0.0:

- `query-sanitize-v1` (D23)
- `bm25-fragment-v1` and `filter-preview-v1` snippet algorithms (D19, D33)
- `stable-id-fuzzy-v1` (D32)
- `filter-keyset-v1`, `links-keyset-v1`, `tree-dfs-v1` cursor sort tuples (D33–D35)

Algorithm IDs are versioned in `_meta`; behavior changes bump the id rather than mutating under the old name.

[1.0.0]: https://github.com/planexhq/markdown-mcp/releases/tag/v1.0.0
