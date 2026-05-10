/**
 * Search latency benchmark — runs a representative query mix against an
 * indexed synthetic vault and reports p50/p95/p99 latency.
 *
 * Query mix exercises BOTH retrieval paths:
 *   - BM25 query mode (single-token / phrase / prefix)
 *   - filter-only mode (tags / fields date range)
 *
 * Per-query timing brackets only `handleSearch`; the SQLite open + index
 * priming happen once outside the timing loop.
 *
 * Usage:
 *   npx tsx bench/search.ts [--files 10000] [--iterations 50]
 */

import { performance } from "node:perf_hooks";
import { parseArgs } from "node:util";

import { scanVault } from "../src/lib/index/scanner.js";
import { handleSearch } from "../src/tools/search.js";
import type { SearchInput } from "../src/types.js";
import { generateVault, percentile, setupBenchHarness } from "./fixtures.js";

interface CliArgs {
	files: number;
	iterations: number;
}

function parseCli(): CliArgs {
	const { values } = parseArgs({
		args: process.argv.slice(2),
		options: {
			files: { type: "string" },
			iterations: { type: "string" },
		},
		strict: true,
		allowPositionals: false,
	});
	return {
		files: values.files !== undefined ? Number.parseInt(values.files, 10) : 10_000,
		iterations: values.iterations !== undefined ? Number.parseInt(values.iterations, 10) : 50,
	};
}

const QUERY_MIX: ReadonlyArray<{ label: string; input: SearchInput }> = [
	{ label: "single-token", input: { query: "auth" } },
	{ label: "single-token-rare", input: { query: "merkle" } },
	{ label: "phrase", input: { query: '"frontmatter tag"' } },
	{ label: "prefix", input: { query: "auth*" } },
	{ label: "two-token", input: { query: "auth token" } },
	// TagOps (src/types.ts) only exposes `has | has_any | has_all` — anything
	// else compiles to a vacuous filter via compileFilter's unknown-key drop.
	{ label: "filter-tag-has", input: { query: "", filters: { tags: { has: "api" } } } },
	{ label: "filter-tag-has-any", input: { query: "", filters: { tags: { has_any: ["api", "auth"] } } } },
	{ label: "filter-date", input: { query: "", filters: { date: { gte: "2024-06-01" } } } },
	{ label: "filter-priority", input: { query: "", filters: { fields: { priority: { gte: 4 } } } } },
	{ label: "query+filter", input: { query: "auth", filters: { tags: { has: "api" } } } },
];

interface Stat {
	label: string;
	p50: number;
	p95: number;
	p99: number;
	hits: number;
}

async function main(): Promise<void> {
	const args = parseCli();
	console.error(`bench/search: generating ${args.files}-file vault and indexing...`);
	const vault = await generateVault({ files: args.files });
	try {
		const harness = await setupBenchHarness(vault.path);
		const { index, coordinator, close } = harness.openIndex();
		await scanVault({ vaultRoot: harness.vaultRoot, index, coordinator, concurrency: 4 });

		console.error(`bench/search: index ready (${args.files} files); running ${args.iterations} iterations per query...`);
		const stats: Stat[] = [];
		for (const { label, input } of QUERY_MIX) {
			const samples: number[] = [];
			let lastHits = 0;
			for (let i = 0; i < args.iterations; i++) {
				const start = performance.now();
				const result = await handleSearch(input, harness.vaultRoot, index);
				const elapsed = performance.now() - start;
				samples.push(elapsed);
				if (i === 0 && !result.isError && "structuredContent" in result) {
					const sc = result.structuredContent as { items?: unknown[] };
					lastHits = sc.items?.length ?? 0;
				}
			}
			samples.sort((a, b) => a - b);
			stats.push({
				label,
				p50: percentile(samples, 50),
				p95: percentile(samples, 95),
				p99: percentile(samples, 99),
				hits: lastHits,
			});
		}

		console.error("");
		console.error("query                | p50      | p95      | p99      | hits");
		console.error("---------------------|----------|----------|----------|-----");
		for (const s of stats) {
			console.error(
				`${s.label.padEnd(20)} | ${s.p50.toFixed(2).padStart(7)}ms | ${s.p95.toFixed(2).padStart(7)}ms | ${s.p99.toFixed(2).padStart(7)}ms | ${String(s.hits).padStart(4)}`,
			);
		}
		console.error("");
		// Pass/fail signal against the W3 exit criterion (search < 100 ms).
		const breaches = stats.filter((s) => s.p95 > 100);
		if (breaches.length === 0) {
			console.error(`bench/search: PASS — all p95 < 100 ms (${args.files}-file vault)`);
		} else {
			console.error(`bench/search: BUDGET BREACH — p95 > 100 ms on: ${breaches.map((b) => b.label).join(", ")}`);
		}

		close();
	} finally {
		await vault.cleanup();
	}
}

main().catch((err: unknown) => {
	console.error(`bench/search: fatal: ${err instanceof Error ? err.stack : String(err)}`);
	process.exit(1);
});
