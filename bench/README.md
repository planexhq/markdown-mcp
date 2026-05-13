# markdown-mcp benchmarks

Three scripts that quantify the W3 + W4 performance budgets against synthetic vaults.

## Running

```bash
npm run bench:scan       # cold + warm scan against 10K-file vault
npm run bench:search     # 10-query mix × 50 iterations, p50/p95/p99 latency
npm run bench:watcher    # 100 atomic-rename writes, event→index latency
npm run bench            # all three back-to-back
```

Override defaults with flags:

```bash
npx tsx bench/scan.ts --files 50000
npx tsx bench/search.ts --files 10000 --iterations 100
npx tsx bench/watcher.ts --writes 200 --polling
```

## What each script measures

### `scan.ts` — cold-start + warm-restart

- **Cold-start**: fresh SQLite, full walk + parse + insert.
- **Warm-restart**: existing SQLite, every file hits the `(mtime, size)` skip path. Should be sub-second on 10K files.

Reports throughput (files/s) and peak RSS.

### `search.ts` — query latency

Runs 10 queries × N iterations:

| label | mode | shape |
|---|---|---|
| single-token | BM25 | one common term |
| single-token-rare | BM25 | one term appearing in few files |
| phrase | BM25 | quoted multi-word |
| prefix | BM25 | trailing `*` |
| two-token | BM25 | two common terms |
| filter-tag | filter-only | `tags.has` |
| filter-tag-prefix | filter-only | `tags.hasPrefix` |
| filter-date | filter-only | reserved date COALESCE chain |
| filter-priority | filter-only | numeric scalar range |
| query+filter | mixed | BM25 + tag filter |

W3 exit criterion: every p95 < 100 ms on a 1K-file vault. Bench runs against 10K by default to stress beyond the spec.

### `watcher.ts` — debounce verification

Drives N `write tmp + rename` cycles (the editor atomic-save pattern) and measures the wall clock from `rename` completion to `reindexFile` returning.

W4 exit criterion: events surface within the chokidar debounce window. Default ~250 ms; the script warns if p95 exceeds 500 ms.

## v1.0.0 baseline

Numbers captured on the release commit will land here. Run `npm run bench` and paste the output in this section as part of the release cut.

```
[scan]    cold-start: <ms> | files/s: <n>
[scan]    warm-restart: <ms>
[search]  see table
[watcher] event→index p95: <ms>
```
