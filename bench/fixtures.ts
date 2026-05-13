/**
 * Synthetic vault generator + shared bench harness.
 *
 * Produces a deterministic vault that exercises the full parser pipeline:
 * frontmatter, multiple heading levels, code fences, wikilinks, tags. The
 * shape resembles real Obsidian vaults more than a flat list of identical
 * files would, so BM25 + filter performance numbers are representative.
 *
 * `generateVault` plans bodies serially (the deterministic RNG is
 * single-threaded) then writes with bounded concurrency — I/O is the
 * 50K-file bottleneck, body-build is in-memory and cheap.
 *
 * `setupBenchHarness` collapses the validate-root + mkdir + open-SQLite
 * boilerplate that every bench script otherwise duplicates.
 */

import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { INDEX_DIR_NAME } from "../src/lib/hiddenPath.js";
import { createIndexHandle, type IndexHandle } from "../src/lib/index/IndexHandle.js";
import { closeSqlite, openSqlite } from "../src/lib/index/sqlite.js";
import { type VaultRoot, validateVaultRoot } from "../src/lib/validatePath.js";
import { WriteCoordinator } from "../src/lib/writeCoordinator.js";

export interface VaultGenSpec {
	/** Number of markdown files to generate. */
	files: number;
	/** Subdirectories to spread files across. Default: ceil(sqrt(files)). */
	directories?: number;
	/** Tags drawn from this pool (each file picks 0–3). */
	tagPool?: readonly string[];
	/** Wikilink density: average outgoing links per file. Default 2. */
	linksPerFile?: number;
	/** Optional seed for deterministic output. */
	seed?: number;
}

export interface GeneratedVault {
	path: string;
	cleanup(): Promise<void>;
	files: number;
}

const DEFAULT_TAGS = [
	"api",
	"api/auth",
	"api/billing",
	"book",
	"book/fiction",
	"daily",
	"design",
	"meeting",
	"project",
	"reference",
] as const;

const HEADINGS_PER_FILE = 6;
const PARAGRAPHS_PER_HEADING = 3;
const SENTENCES_PER_PARAGRAPH = 3;

const LOREM_WORDS = [
	"alpha", "beta", "gamma", "delta", "epsilon", "auth", "token", "session", "request", "handler",
	"vault", "fragment", "outline", "heading", "block", "search", "index", "scanner", "watcher", "merkle",
	"obsidian", "markdown", "frontmatter", "tag", "metadata", "graph", "wikilink", "embed", "snippet", "filter",
	"contract", "envelope", "policy", "boundary", "containment", "validate", "absolute", "relative", "symlink", "traversal",
] as const;

/**
 * Tiny deterministic PRNG (mulberry32). Stable across Node versions, no
 * external dep. Adequate for fixture generation; not cryptographic.
 */
function makeRng(seed: number): () => number {
	let s = seed >>> 0;
	return () => {
		s = (s + 0x6d2b79f5) >>> 0;
		let t = s;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function pick<T>(arr: readonly T[], rng: () => number): T {
	const item = arr[Math.floor(rng() * arr.length)];
	if (item === undefined) throw new Error("pick: empty array");
	return item;
}

function sentenceWords(rng: () => number, count: number): string {
	const words: string[] = [];
	for (let i = 0; i < count; i++) words.push(pick(LOREM_WORDS, rng));
	const first = words[0];
	if (first !== undefined) words[0] = first[0]?.toUpperCase() + first.slice(1);
	return `${words.join(" ")}.`;
}

function paragraph(rng: () => number): string {
	const sentences: string[] = [];
	for (let i = 0; i < SENTENCES_PER_PARAGRAPH; i++) {
		const wordCount = 6 + Math.floor(rng() * 8);
		sentences.push(sentenceWords(rng, wordCount));
	}
	return sentences.join(" ");
}

function fileBody(rng: () => number, fileIndex: number, totalFiles: number, linksPerFile: number, tags: string[]): string {
	const parts: string[] = [];
	// Frontmatter — enough fields to exercise filter compilation and the
	// reserved `date` chain.
	parts.push("---");
	parts.push(`title: Note ${fileIndex}`);
	if (tags.length > 0) {
		parts.push("tags:");
		for (const t of tags) parts.push(`  - ${t}`);
	}
	parts.push(`created: 2024-${String(((fileIndex % 12) + 1)).padStart(2, "0")}-${String(((fileIndex % 28) + 1)).padStart(2, "0")}`);
	parts.push(`priority: ${(fileIndex % 5) + 1}`);
	parts.push("---");
	parts.push("");

	// Preamble
	parts.push(paragraph(rng));
	parts.push("");

	// Headings + bodies
	for (let h = 1; h <= HEADINGS_PER_FILE; h++) {
		const level = 1 + (h % 3);
		parts.push(`${"#".repeat(level)} Section ${h}`);
		parts.push("");
		for (let p = 0; p < PARAGRAPHS_PER_HEADING; p++) {
			parts.push(paragraph(rng));
			parts.push("");
		}
		// Code fence in every other heading — exercises D18 code-weight downweight
		// and the round-19 snippet code-fallback path.
		if (h % 2 === 0) {
			parts.push("```ts");
			parts.push(`function handler${h}(): void { /* ${pick(LOREM_WORDS, rng)} */ }`);
			parts.push("```");
			parts.push("");
		}
	}

	// Wikilinks — pick targets uniformly from the corpus so the resolver
	// hits both basename and explicit-path resolution paths.
	if (linksPerFile > 0) {
		parts.push(`## Links`);
		parts.push("");
		const linkLine: string[] = [];
		for (let i = 0; i < linksPerFile; i++) {
			const target = Math.floor(rng() * totalFiles);
			linkLine.push(`[[note-${target}]]`);
		}
		parts.push(linkLine.join(" "));
		parts.push("");
	}
	return parts.join("\n");
}

/**
 * Generate a deterministic synthetic vault matching `spec`. Files are
 * named `note-N.md` and distributed across a fixed set of subdirectories
 * so wikilink resolution exercises both basename and explicit-path forms.
 *
 * Returns a `cleanup` function the caller MUST invoke when done — the
 * vault lives in tmpdir but is large enough that lingering benchmark
 * fixtures eat disk fast (50K files ≈ 200 MB).
 */
export async function generateVault(spec: VaultGenSpec): Promise<GeneratedVault> {
	const {
		files,
		directories = Math.max(1, Math.ceil(Math.sqrt(files))),
		tagPool = DEFAULT_TAGS,
		linksPerFile = 2,
		seed = 0xc0ffee,
	} = spec;
	const rng = makeRng(seed);
	const root = await mkdtemp(join(tmpdir(), `markdown-mcp-bench-${files}-`));
	const dirs = Array.from({ length: directories }, (_, i) => `dir-${i}`);
	await Promise.all(dirs.map((d) => mkdir(join(root, d), { recursive: true })));
	const planned: Array<{ path: string; body: string }> = [];
	for (let i = 0; i < files; i++) {
		const dir = dirs[i % dirs.length] ?? "";
		const fileTags: string[] = [];
		const tagCount = Math.floor(rng() * 4);
		for (let t = 0; t < tagCount; t++) fileTags.push(pick(tagPool, rng));
		const body = fileBody(rng, i, files, linksPerFile, fileTags);
		planned.push({ path: join(root, dir, `note-${i}.md`), body });
	}
	const concurrency = 16;
	let cursor = 0;
	const workers = Array.from({ length: concurrency }, async () => {
		while (cursor < planned.length) {
			const idx = cursor++;
			const job = planned[idx];
			if (!job) continue;
			await writeFile(job.path, job.body, "utf8");
		}
	});
	await Promise.all(workers);
	return {
		path: root,
		files,
		cleanup: async () => {
			await rm(root, { recursive: true, force: true });
		},
	};
}

/**
 * Stable digest of a generation spec; lets the bench harness tag results
 * with the corpus that produced them. Cheap (sha1 over JSON.stringify)
 * and the spec is small.
 */
export function specDigest(spec: VaultGenSpec): string {
	return createHash("sha1").update(JSON.stringify(spec)).digest("hex").slice(0, 12);
}

/**
 * Nearest-rank percentile over a SORTED ascending array. Caller-side sort
 * keeps the helper a pure index lookup. Empty input returns 0 so summary
 * tables don't crash on a fully-dropped sample run.
 */
export function percentile(sortedAsc: number[], p: number): number {
	if (sortedAsc.length === 0) return 0;
	const idx = Math.min(sortedAsc.length - 1, Math.ceil((p / 100) * sortedAsc.length) - 1);
	return sortedAsc[idx] ?? 0;
}

export interface BenchHarness {
	vaultRoot: VaultRoot;
	dbPath: string;
	openIndex(): { index: IndexHandle; coordinator: WriteCoordinator; close(): void };
}

/**
 * Boilerplate shared by every bench script: validate the vault root,
 * ensure the `.markdown-mcp/` dir exists, return a factory that opens a
 * fresh SQLite + IndexHandle + WriteCoordinator. The factory is a thunk
 * so benches that need cold/warm pairs (scan.ts) can reopen mid-script;
 * each opened handle owns its own `close()` so callers don't round-trip
 * the raw `Database` back to the harness.
 */
export async function setupBenchHarness(vaultPath: string): Promise<BenchHarness> {
	const vaultRoot = await validateVaultRoot(vaultPath);
	const dbDir = join(vaultRoot.absolute, INDEX_DIR_NAME);
	await mkdir(dbDir, { recursive: true });
	const dbPath = join(dbDir, "index.sqlite3");
	return {
		vaultRoot,
		dbPath,
		openIndex() {
			const opened = openSqlite({ dbPath });
			return {
				index: createIndexHandle(opened.db, { includeHidden: false }),
				coordinator: new WriteCoordinator(),
				close: () => closeSqlite(opened.db),
			};
		},
	};
}
