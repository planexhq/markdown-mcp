/**
 * In-memory `VaultFileIndex` for unit tests that exercise wikilink
 * resolution and embed expansion without a SQLite handle. Mirrors
 * `IndexHandle`'s contract: `filesByBasename` returns shortest-path-
 * first matches; heading lookups are seeded explicitly per test.
 */

import type { VaultFileIndex } from "../../src/lib/wikilinks.js";

export interface FakeVaultIndexOptions {
	files: ReadonlyArray<string>;
	headings?: Record<string, Array<{ stable_id: string; heading_path: string[] }>>;
}

export class FakeVaultIndex implements VaultFileIndex {
	private readonly files: ReadonlyArray<string>;
	private readonly headingsByFile: ReadonlyMap<string, ReadonlyArray<{ stable_id: string; heading_path: string[] }>>;

	constructor(args: FakeVaultIndexOptions) {
		this.files = args.files;
		const map = new Map<string, ReadonlyArray<{ stable_id: string; heading_path: string[] }>>();
		for (const [k, v] of Object.entries(args.headings ?? {})) map.set(k, v);
		this.headingsByFile = map;
	}

	hasFile(relpath: string): boolean {
		return this.files.includes(relpath);
	}

	findFileCi(relpath: string): string | null {
		const lower = relpath.toLowerCase();
		const sorted = [...this.files].sort();
		for (const f of sorted) {
			if (f.toLowerCase() === lower) return f;
		}
		return null;
	}

	filesByBasename(name: string): readonly string[] {
		const lower = name.toLowerCase();
		const matches = this.files.filter((f) => {
			const slash = f.lastIndexOf("/");
			const base = slash >= 0 ? f.slice(slash + 1) : f;
			return base.replace(/\.(md|markdown|mdx)$/i, "").toLowerCase() === lower;
		});
		return matches.sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b));
	}

	headingsByPath(file: string, path: string[]): readonly { stable_id: string; heading_path: string[] }[] {
		const all = this.headingsByFile.get(file) ?? [];
		return all.filter(
			(h) => h.heading_path.length === path.length && h.heading_path.every((seg, i) => seg === path[i]),
		);
	}

	headingsByText(file: string, text: string): readonly { stable_id: string; heading_path: string[] }[] {
		const all = this.headingsByFile.get(file) ?? [];
		return all.filter((h) => h.heading_path[h.heading_path.length - 1] === text);
	}
}
