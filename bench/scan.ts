/**
 * Scan benchmark — measures cold-start full-vault scan time and warm-
 * restart reconcile time against a synthetic 10K-file vault.
 *
 * Cold-start: fresh SQLite, full walk + parse + insert. Warm-restart:
 * existing SQLite, mtime-skip fast path on every file. Numbers from this
 * script land in `bench/README.md` as the v1.0.0 release baseline.
 *
 * Usage:
 *   npx tsx bench/scan.ts [--files 10000] [--keep-vault]
 */

import { performance } from "node:perf_hooks";
import { parseArgs } from "node:util";

import { scanVault } from "../src/lib/index/scanner.js";
import { generateVault, setupBenchHarness } from "./fixtures.js";

interface CliArgs {
	files: number;
	keepVault: boolean;
}

function parseCli(): CliArgs {
	const { values } = parseArgs({
		args: process.argv.slice(2),
		options: {
			files: { type: "string" },
			"keep-vault": { type: "boolean" },
		},
		strict: true,
		allowPositionals: false,
	});
	return {
		files: values.files !== undefined ? Number.parseInt(values.files, 10) : 10_000,
		keepVault: values["keep-vault"] === true,
	};
}

function fmtMs(ms: number): string {
	if (ms < 1000) return `${ms.toFixed(0)} ms`;
	return `${(ms / 1000).toFixed(2)} s`;
}

function fmtRss(): string {
	const rss = process.memoryUsage().rss;
	return `${(rss / 1024 / 1024).toFixed(0)} MB`;
}

async function main(): Promise<void> {
	const args = parseCli();
	console.error(`bench/scan: generating ${args.files}-file synthetic vault...`);
	const genStart = performance.now();
	const vault = await generateVault({ files: args.files });
	const genElapsed = performance.now() - genStart;
	console.error(`bench/scan: vault at ${vault.path} (gen took ${fmtMs(genElapsed)})`);

	try {
		const harness = await setupBenchHarness(vault.path);

		// Cold-start: fresh DB.
		const cold = harness.openIndex();
		const coldStart = performance.now();
		const coldResult = await scanVault({
			vaultRoot: harness.vaultRoot,
			index: cold.index,
			coordinator: cold.coordinator,
			concurrency: 4,
		});
		const coldElapsed = performance.now() - coldStart;
		console.error(
			`bench/scan: cold-start scan: ${fmtMs(coldElapsed)} | indexed=${coldResult.filesIndexed} skipped=${coldResult.filesSkipped} | rss=${fmtRss()}`,
		);
		cold.close();

		// Warm-restart: existing DB, every file should hit the mtime-skip path.
		const warm = harness.openIndex();
		const warmStart = performance.now();
		const warmResult = await scanVault({
			vaultRoot: harness.vaultRoot,
			index: warm.index,
			coordinator: warm.coordinator,
			concurrency: 4,
		});
		const warmElapsed = performance.now() - warmStart;
		console.error(
			`bench/scan: warm-restart reconcile: ${fmtMs(warmElapsed)} | indexed=${warmResult.filesIndexed} skipped=${warmResult.filesSkipped} | rss=${fmtRss()}`,
		);
		warm.close();

		// Throughput summary
		const cps = (args.files / coldElapsed) * 1000;
		console.error(`bench/scan: cold-start throughput ≈ ${cps.toFixed(0)} files/s`);
	} finally {
		if (!args.keepVault) {
			await vault.cleanup();
		} else {
			console.error(`bench/scan: --keep-vault set; vault retained at ${vault.path}`);
		}
	}
}

main().catch((err: unknown) => {
	console.error(`bench/scan: fatal: ${err instanceof Error ? err.stack : String(err)}`);
	process.exit(1);
});
