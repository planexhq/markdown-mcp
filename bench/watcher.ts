/**
 * Watcher debounce benchmark — drives N atomic-rename writes against a
 * live watcher and measures event-to-index latency.
 *
 * Default mode runs against chokidar's native FS events; `--polling`
 * exercises the polling fallback (slower, used on network mounts where
 * native events are unreliable).
 *
 * Usage:
 *   npx tsx bench/watcher.ts [--writes 100] [--polling]
 */

import { rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { parseArgs } from "node:util";

import { reindexOne } from "../src/lib/index/scanner.js";
import { startWatcher } from "../src/lib/watcher.js";
import { generateVault, percentile, setupBenchHarness } from "./fixtures.js";

interface CliArgs {
	writes: number;
	polling: boolean;
}

function parseCli(): CliArgs {
	const { values } = parseArgs({
		args: process.argv.slice(2),
		options: {
			writes: { type: "string" },
			polling: { type: "boolean" },
		},
		strict: true,
		allowPositionals: false,
	});
	return {
		writes: values.writes !== undefined ? Number.parseInt(values.writes, 10) : 100,
		polling: values.polling === true,
	};
}

async function main(): Promise<void> {
	const args = parseCli();
	console.error(`bench/watcher: starting (${args.writes} writes, polling=${args.polling})`);
	// Pre-populate a small vault so the watcher has files to track from boot.
	const vault = await generateVault({ files: 50, linksPerFile: 0 });
	try {
		const harness = await setupBenchHarness(vault.path);
		const { index, coordinator, close } = harness.openIndex();
		index.markScanFinalized();

		// `pending` keys events by relpath → arrival time. Each write resolves
		// the promise once `reindexFile` lands the row.
		const pending = new Map<string, { resolve: () => void; start: number }>();
		const samples: number[] = [];

		const watcher = startWatcher({
			vaultRoot: harness.vaultRoot,
			index,
			coordinator,
			polling: args.polling,
			reindexFile: async (rel) => {
				const outcome = await reindexOne(harness.vaultRoot, index, rel);
				const entry = pending.get(rel);
				if (entry) {
					samples.push(performance.now() - entry.start);
					entry.resolve();
					pending.delete(rel);
				}
				return outcome;
			},
		});
		await watcher.ready();

		// `watcher.ready()` fires on chokidar's initial-crawl complete, not
		// when reindex chains from initial `add` events have committed; drain
		// so the timed loop measures steady-state, not initial-tail contention
		// on the SQLite write lock. Mirrors src/index.ts preFinalize.
		for (let i = 0; i < 3; i++) {
			await coordinator.drain();
			if (!coordinator.hasActiveChains()) break;
		}

		console.error("bench/watcher: watcher ready; driving atomic-rename writes...");
		const overallStart = performance.now();
		for (let i = 0; i < args.writes; i++) {
			const target = join(vault.path, `bench-${i}.md`);
			const tmp = `${target}.tmp`;
			await writeFile(tmp, `# bench-${i}\n\nIteration ${i}.\n`, "utf8");
			const start = performance.now();
			const wait = new Promise<void>((resolve) => {
				pending.set(`bench-${i}.md`, { resolve, start });
			});
			await rename(tmp, target);
			// Cap per-write wait at 5s so a missed event doesn't hang the bench.
			await Promise.race([
				wait,
				new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
			]);
		}
		const totalElapsed = performance.now() - overallStart;
		await watcher.close();
		close();

		samples.sort((a, b) => a - b);
		const p50 = percentile(samples, 50);
		const p95 = percentile(samples, 95);
		const p99 = percentile(samples, 99);
		console.error("");
		console.error(`bench/watcher: writes=${args.writes} captured=${samples.length} dropped=${args.writes - samples.length}`);
		console.error(`  total elapsed     : ${(totalElapsed / 1000).toFixed(2)} s`);
		console.error(`  event→index p50   : ${p50.toFixed(0)} ms`);
		console.error(`  event→index p95   : ${p95.toFixed(0)} ms`);
		console.error(`  event→index p99   : ${p99.toFixed(0)} ms`);
		// W4 exit criterion target: < 500 ms event-to-index lag.
		if (p95 > 500) {
			console.error(`  WARNING: p95 > 500 ms — debounce window may be misconfigured.`);
		}
	} finally {
		await vault.cleanup();
	}
}

main().catch((err: unknown) => {
	console.error(`bench/watcher: fatal: ${err instanceof Error ? err.stack : String(err)}`);
	process.exit(1);
});
