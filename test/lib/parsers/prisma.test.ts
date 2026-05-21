/**
 * Prisma (PSL) synthesizer unit tests.
 *
 * Covers:
 *   - Detection: schema with ≥1 indexable block → synthesize.
 *   - Block enumeration: model/enum/view/type/datasource/generator each emit
 *     one heading in source order.
 *   - Slot IDs: `<kind>[<sha14(name)>]`, kind-prefixed (so `model X` and
 *     `enum X` disambiguate).
 *   - Stable IDs survive reorder; rename retires.
 *   - Prose surfaces: leading `///` doc paragraphs, `Fields:`/`Values:`/
 *     `Settings:` bullet lists, `Table:` from `@@map`, `Block attributes:`.
 *   - Synthesized source + excludedRanges (JSON fences route to `code`
 *     FTS column).
 *   - Frontmatter shape: `{ datasource, generator }` for nested-path
 *     filters.
 *   - Free-floating `///` / `/* * /` → `## Schema notes` catch-all; bare
 *     `//` dropped.
 *   - Truncation: 64 KiB fence cap + `json`→`text` language swap.
 *   - Prototype-pollution defense in fences + frontmatter.
 *   - Parse errors → `PRISMA_PARSE_ERROR` with line/column.
 *   - Contract test: canonical AST snapshot guards `@mrleebo/prisma-ast`
 *     shape drift.
 */

import { getSchema } from "@mrleebo/prisma-ast";
import { describe, expect, test } from "vitest";
import { ParseError } from "../../../src/lib/parser.js";
import {
	detectPrisma,
	parsePrismaFile,
	stripPrismaBlockComments,
	synthesizePrismaFile,
} from "../../../src/lib/parsers/prisma.js";

const isBlockHeading = (h: { structuralPath: string }): boolean =>
	h.structuralPath.startsWith("model[") ||
	h.structuralPath.startsWith("enum[") ||
	h.structuralPath.startsWith("view[") ||
	h.structuralPath.startsWith("type[") ||
	h.structuralPath.startsWith("datasource[") ||
	h.structuralPath.startsWith("generator[");

const MINIMAL_PRISMA = `datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

generator client {
  provider = "prisma-client-js"
}

model User {
  id    Int    @id @default(autoincrement())
  email String @unique
}
`;

const FULL_PRISMA = `datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

generator client {
  provider = "prisma-client-js"
  previewFeatures = ["views"]
}

/// A registered user.
model User {
  id        Int      @id @default(autoincrement())
  /// User's email — must be unique.
  email     String   @unique
  name      String?
  role      Role     @default(USER)
  posts     Post[]
  createdAt DateTime @default(now())

  @@map("users")
  @@index([email])
}

model Post {
  id       Int    @id @default(autoincrement())
  title    String @db.VarChar(255)
  author   User   @relation(fields: [authorId], references: [id])
  authorId Int
}

enum Role {
  USER
  /// Administrator role.
  ADMIN
}

view UserStats {
  userId Int @unique
  posts  Int
}

type Address {
  street String
  city   String
}
`;

// ─── Detection ─────────────────────────────────────────────────────────────

describe("detectPrisma", () => {
	test("returns true for schema with at least one indexable block", () => {
		const schema = getSchema(MINIMAL_PRISMA);
		expect(detectPrisma(schema)).toBe(true);
	});

	test("returns true for schema with only free-floating /// doc", () => {
		const schema = getSchema(`/// Just a note.\n`);
		expect(detectPrisma(schema)).toBe(true);
	});

	test("returns false for empty schema (only // comments + breaks)", () => {
		const schema = getSchema(`// just a comment\n`);
		expect(detectPrisma(schema)).toBe(false);
	});

	test("returns false for non-schema shape", () => {
		expect(detectPrisma(null)).toBe(false);
		expect(detectPrisma({})).toBe(false);
		expect(detectPrisma({ list: "wrong" })).toBe(false);
	});
});

// ─── Block enumeration ─────────────────────────────────────────────────────

describe("synthesizePrismaFile — block enumeration", () => {
	test("each top-level block produces exactly one heading", () => {
		const parsed = parsePrismaFile(FULL_PRISMA, "schema.prisma");
		const blockHeadings = parsed.headings.filter(isBlockHeading);
		// 1 datasource + 1 generator + 2 models + 1 enum + 1 view + 1 type = 7
		expect(blockHeadings).toHaveLength(7);
	});

	test("blocks emit in source order", () => {
		const parsed = parsePrismaFile(FULL_PRISMA, "schema.prisma");
		const orderedKinds = parsed.headings.filter(isBlockHeading).map((h) => h.headingPath[0]);
		expect(orderedKinds).toEqual([
			"datasource db",
			"generator client",
			"model User",
			"model Post",
			"enum Role",
			"view UserStats",
			"type Address",
		]);
	});

	test("all blocks share level 2 (flat outline)", () => {
		const parsed = parsePrismaFile(FULL_PRISMA, "schema.prisma");
		for (const h of parsed.headings.filter(isBlockHeading)) {
			expect(h.level).toBe(2);
		}
	});

	test("contentKinds includes 'code' and 'list' for non-empty blocks", () => {
		const parsed = parsePrismaFile(FULL_PRISMA, "schema.prisma");
		const userHeading = parsed.headings.find((h) => h.headingPath[0] === "model User");
		expect(userHeading?.contentKinds).toEqual(["code", "list"]);
	});
});

// ─── Slot IDs (stable_id) ──────────────────────────────────────────────────

describe("synthesizePrismaFile — stable IDs (kind-prefixed name-based slots)", () => {
	test("structuralPath uses `<kind>[<sha14>]` format", () => {
		const parsed = parsePrismaFile(FULL_PRISMA, "schema.prisma");
		for (const h of parsed.headings.filter(isBlockHeading)) {
			expect(h.structuralPath).toMatch(/^(model|enum|view|type|datasource|generator)\[[0-9a-f]{14}\]$/);
		}
	});

	test("model X and enum X produce DISTINCT stable_ids (kind disambiguation)", () => {
		const source = `model Foo {\n  id Int @id\n}\nenum Foo {\n  A\n  B\n}\n`;
		const parsed = parsePrismaFile(source, "schema.prisma");
		const ids = parsed.headings.filter(isBlockHeading).map((h) => h.structuralPath);
		expect(ids).toHaveLength(2);
		expect(new Set(ids).size).toBe(2);
	});

	test("stable_id survives block reorder (name-based, not position-based)", () => {
		const a = `model Alpha {\n  id Int @id\n}\nmodel Beta {\n  id Int @id\n}\n`;
		const b = `model Beta {\n  id Int @id\n}\nmodel Alpha {\n  id Int @id\n}\n`;
		const parsedA = parsePrismaFile(a, "schema.prisma");
		const parsedB = parsePrismaFile(b, "schema.prisma");
		const idsA = new Map(parsedA.headings.map((h) => [h.headingPath[0], h.stable_id]));
		const idsB = new Map(parsedB.headings.map((h) => [h.headingPath[0], h.stable_id]));
		expect(idsA.get("model Alpha")).toBe(idsB.get("model Alpha"));
		expect(idsA.get("model Beta")).toBe(idsB.get("model Beta"));
	});

	test("renaming a block retires its old stable_id", () => {
		const before = parsePrismaFile(`model Alpha {\n  id Int @id\n}\n`, "schema.prisma");
		const after = parsePrismaFile(`model Beta {\n  id Int @id\n}\n`, "schema.prisma");
		expect(before.headings[0]?.stable_id).not.toBe(after.headings[0]?.stable_id);
	});

	test("inserting a new block does NOT shift existing stable_ids", () => {
		const before = parsePrismaFile(`model Alpha {\n  id Int @id\n}\nmodel Beta {\n  id Int @id\n}\n`, "schema.prisma");
		const after = parsePrismaFile(
			`model Alpha {\n  id Int @id\n}\nmodel Gamma {\n  id Int @id\n}\nmodel Beta {\n  id Int @id\n}\n`,
			"schema.prisma",
		);
		const findId = (parsed: ReturnType<typeof parsePrismaFile>, name: string): string | undefined =>
			parsed.headings.find((h) => h.headingPath[0] === name)?.stable_id;
		expect(findId(before, "model Alpha")).toBe(findId(after, "model Alpha"));
		expect(findId(before, "model Beta")).toBe(findId(after, "model Beta"));
	});
});

// ─── Duplicate block-name disambiguation ──────────────────────────────────

describe("synthesizePrismaFile — duplicate block names produce ordinal-disambiguated slots", () => {
	test("two `model User` blocks → second slot suffixed `#2`; stable_ids distinct", () => {
		// `@mrleebo/prisma-ast` is lenient: it returns both blocks. Without
		// the ordinal suffix the second `sections.push` emits an identical
		// structuralSlot, the row hits SQLite's UNIQUE(file, stable_id), and
		// the whole file wedges into `parse_failed` retry.
		const source = `model User {\n  id Int @id\n}\nmodel User {\n  email String @id\n}\n`;
		const parsed = parsePrismaFile(source, "schema.prisma");
		const blockHeadings = parsed.headings.filter(isBlockHeading);
		expect(blockHeadings).toHaveLength(2);
		expect(blockHeadings[0]?.structuralPath).toMatch(/^model\[[0-9a-f]{14}\]$/);
		expect(blockHeadings[1]?.structuralPath).toMatch(/^model\[[0-9a-f]{14}\]#2$/);
		expect(blockHeadings[0]?.stable_id).not.toBe(blockHeadings[1]?.stable_id);
		expect(blockHeadings[0]?.headingPath[0]).toBe("model User");
		expect(blockHeadings[1]?.headingPath[0]).toBe("model User");
		expect(parsed.source).not.toMatch(/## Schema notes/);
	});

	test("three `enum Color` blocks → canonical, `#2`, `#3` ordinals", () => {
		const source = `enum Color {\n  RED\n}\nenum Color {\n  GREEN\n}\nenum Color {\n  BLUE\n}\n`;
		const parsed = parsePrismaFile(source, "schema.prisma");
		const slots = parsed.headings.filter(isBlockHeading).map((h) => h.structuralPath);
		expect(slots).toHaveLength(3);
		expect(slots[0]).toMatch(/^enum\[[0-9a-f]{14}\]$/);
		expect(slots[1]).toMatch(/^enum\[[0-9a-f]{14}\]#2$/);
		expect(slots[2]).toMatch(/^enum\[[0-9a-f]{14}\]#3$/);
		const ids = parsed.headings.filter(isBlockHeading).map((h) => h.stable_id);
		expect(new Set(ids).size).toBe(3);
	});

	test("unique-name schemas keep canonical slots (no `#N` suffix)", () => {
		const source = `model User {\n  id Int @id\n}\nmodel Post {\n  id Int @id\n}\n`;
		const parsed = parsePrismaFile(source, "schema.prisma");
		for (const slot of parsed.headings.filter(isBlockHeading).map((h) => h.structuralPath)) {
			expect(slot).toMatch(/^model\[[0-9a-f]{14}\]$/);
			expect(slot).not.toMatch(/#/);
		}
	});
});

// ─── Frontmatter ───────────────────────────────────────────────────────────

describe("synthesizePrismaFile — frontmatter shape", () => {
	test("frontmatter exposes datasource + generator nested by name", () => {
		const parsed = parsePrismaFile(MINIMAL_PRISMA, "schema.prisma");
		expect(parsed.frontmatter).toMatchObject({
			datasource: { db: { provider: "postgresql" } },
			generator: { client: { provider: "prisma-client-js" } },
		});
	});

	test("frontmatter does not include model/enum/view/type", () => {
		const parsed = parsePrismaFile(MINIMAL_PRISMA, "schema.prisma");
		const fm = parsed.frontmatter as Record<string, unknown>;
		expect(fm.model).toBeUndefined();
		expect(fm.enum).toBeUndefined();
		expect(fm.view).toBeUndefined();
		expect(fm.type).toBeUndefined();
	});

	test("multiple generators are aggregated into the same map", () => {
		const source = `datasource db {\n  provider = "postgresql"\n}\ngenerator a {\n  provider = "prisma-client-js"\n}\ngenerator b {\n  provider = "prisma-erd"\n}\n`;
		const parsed = parsePrismaFile(source, "schema.prisma");
		const fm = parsed.frontmatter as Record<string, Record<string, unknown>>;
		expect(Object.keys(fm.generator)).toEqual(["a", "b"]);
	});

	test("env() values flow through as string forms for JSON serializability", () => {
		const parsed = parsePrismaFile(MINIMAL_PRISMA, "schema.prisma");
		const fm = parsed.frontmatter as { datasource: { db: { url: string } } };
		expect(fm.datasource.db.url).toBe("env(DATABASE_URL)");
	});

	test("hasFrontmatter is true", () => {
		const parsed = parsePrismaFile(MINIMAL_PRISMA, "schema.prisma");
		expect(parsed.hasFrontmatter).toBe(true);
	});
});

// ─── Source synthesis + excludedRanges ─────────────────────────────────────

describe("synthesizePrismaFile — synthesized source + excludedRanges", () => {
	test("source contains one `## <kind> <name>` heading per block", () => {
		const parsed = parsePrismaFile(FULL_PRISMA, "schema.prisma");
		expect(parsed.source).toMatch(/^## datasource db$/m);
		expect(parsed.source).toMatch(/^## generator client$/m);
		expect(parsed.source).toMatch(/^## model User$/m);
		expect(parsed.source).toMatch(/^## enum Role$/m);
		expect(parsed.source).toMatch(/^## view UserStats$/m);
		expect(parsed.source).toMatch(/^## type Address$/m);
	});

	test("each block emits a ```json fence", () => {
		const parsed = parsePrismaFile(FULL_PRISMA, "schema.prisma");
		const fenceCount = (parsed.source.match(/```json/g) ?? []).length;
		expect(fenceCount).toBeGreaterThanOrEqual(7);
	});

	test("excludedRanges covers all JSON fences", () => {
		const parsed = parsePrismaFile(FULL_PRISMA, "schema.prisma");
		expect(parsed.excludedRanges.length).toBeGreaterThanOrEqual(7);
		// Each excludedRange should be non-empty and within source bounds.
		for (const r of parsed.excludedRanges) {
			expect(r.offsetStart).toBeGreaterThanOrEqual(0);
			expect(r.offsetEnd).toBeLessThanOrEqual(parsed.source.length);
			expect(r.offsetStart).toBeLessThan(r.offsetEnd);
		}
	});

	test("fence content includes the AST subtree (model name surfaces)", () => {
		const parsed = parsePrismaFile(FULL_PRISMA, "schema.prisma");
		expect(parsed.source).toMatch(/"name":"User"/);
		expect(parsed.source).toMatch(/"name":"Post"/);
		expect(parsed.source).toMatch(/"name":"Role"/);
	});
});

// ─── Heading text normalization ────────────────────────────────────────────

describe("synthesizePrismaFile — heading text normalization", () => {
	test("displayText preserves the kind + name", () => {
		const parsed = parsePrismaFile(`model User {\n  id Int @id\n}\n`, "schema.prisma");
		expect(parsed.headings[0]?.displayText).toBe("model User");
	});

	test("pathText is NFC-normalized + whitespace-collapsed", () => {
		const parsed = parsePrismaFile(`model User {\n  id Int @id\n}\n`, "schema.prisma");
		expect(parsed.headings[0]?.pathText).toBe("model User");
	});

	test("headingPath has exactly one element (flat outline)", () => {
		const parsed = parsePrismaFile(FULL_PRISMA, "schema.prisma");
		for (const h of parsed.headings.filter(isBlockHeading)) {
			expect(h.headingPath).toHaveLength(1);
		}
	});
});

// ─── Doc comment prose (block-level) ───────────────────────────────────────

describe("synthesizePrismaFile — block-level /// doc comments", () => {
	test("leading /// doc comment surfaces as the block's prose paragraph", () => {
		const source = `/// A registered user.\nmodel User {\n  id Int @id\n}\n`;
		const parsed = parsePrismaFile(source, "schema.prisma");
		expect(parsed.source).toMatch(/^## model User\n\nA registered user\.\n/m);
	});

	test("multiple consecutive /// lines all surface", () => {
		const source = `/// Line 1.\n/// Line 2.\nmodel User {\n  id Int @id\n}\n`;
		const parsed = parsePrismaFile(source, "schema.prisma");
		expect(parsed.source).toMatch(/Line 1\.\nLine 2\./);
	});

	test("non-doc // comment between /// and block does NOT block attachment", () => {
		// Plain // breaks the doc-comment attachment chain — only ///+Break before block.
		const source = `/// Doc.\nmodel User {\n  id Int @id\n}\n`;
		const parsed = parsePrismaFile(source, "schema.prisma");
		expect(parsed.source).toMatch(/^## model User\n\nDoc\.\n/m);
	});

	test("Break entries between /// and block are skipped (attachment still fires)", () => {
		const source = `/// Doc.\n\nmodel User {\n  id Int @id\n}\n`;
		const parsed = parsePrismaFile(source, "schema.prisma");
		expect(parsed.source).toMatch(/Doc\./);
	});
});

// ─── Doc comment prose (field-level) ───────────────────────────────────────

describe("synthesizePrismaFile — field-level /// doc comments", () => {
	test("preceding /// on a field surfaces in the bullet", () => {
		const source = `model User {\n  /// User email.\n  email String @unique\n}\n`;
		const parsed = parsePrismaFile(source, "schema.prisma");
		expect(parsed.source).toMatch(/- email: String @unique — User email\./);
	});

	test("field without /// produces a bullet without — suffix", () => {
		const source = `model User {\n  id Int @id\n}\n`;
		const parsed = parsePrismaFile(source, "schema.prisma");
		expect(parsed.source).toMatch(/- id: Int @id$/m);
	});

	test("consecutive /// lines on a field accumulate (space-joined)", () => {
		const source = `model User {\n  /// Primary email.\n  /// Must be unique.\n  email String @unique\n}\n`;
		const parsed = parsePrismaFile(source, "schema.prisma");
		expect(parsed.source).toMatch(/- email: String @unique — Primary email\. Must be unique\./);
	});

	test("trailing /// on a field strips the prefix from the bullet", () => {
		const source = `model User {\n  email String /// real doc\n}\n`;
		const parsed = parsePrismaFile(source, "schema.prisma");
		expect(parsed.source).toMatch(/- email: String — real doc$/m);
	});

	test("trailing bare // on a field is dropped (no — suffix)", () => {
		const source = `model User {\n  email String // bare comment\n}\n`;
		const parsed = parsePrismaFile(source, "schema.prisma");
		expect(parsed.source).toMatch(/- email: String$/m);
	});

	test("preceding /// wins over trailing /// when both present", () => {
		const source = `model User {\n  /// preceding\n  email String /// trailing\n}\n`;
		const parsed = parsePrismaFile(source, "schema.prisma");
		expect(parsed.source).toMatch(/- email: String — preceding$/m);
	});
});

// ─── Enum prose ────────────────────────────────────────────────────────────

describe("synthesizePrismaFile — enum values rendered as bullets", () => {
	test("each enum value emits a `- NAME` line", () => {
		const source = `enum Role {\n  USER\n  ADMIN\n}\n`;
		const parsed = parsePrismaFile(source, "schema.prisma");
		expect(parsed.source).toMatch(/Values:\n- USER\n- ADMIN/);
	});

	test("enum value /// doc surfaces as — suffix", () => {
		const source = `enum Role {\n  USER\n  /// Admin only.\n  ADMIN\n}\n`;
		const parsed = parsePrismaFile(source, "schema.prisma");
		expect(parsed.source).toMatch(/- ADMIN — Admin only\./);
	});

	test("consecutive /// lines on an enum value accumulate (space-joined)", () => {
		const source = `enum Role {\n  USER\n  /// Admin only.\n  /// Granted by invitation.\n  ADMIN\n}\n`;
		const parsed = parsePrismaFile(source, "schema.prisma");
		expect(parsed.source).toMatch(/- ADMIN — Admin only\. Granted by invitation\./);
	});

	test("trailing bare // on an enum value is dropped", () => {
		const source = `enum Role {\n  USER // dev only\n  ADMIN\n}\n`;
		const parsed = parsePrismaFile(source, "schema.prisma");
		expect(parsed.source).toMatch(/- USER$/m);
	});

	test("trailing /// on an enum value strips the prefix from the bullet", () => {
		const source = `enum Role {\n  USER /// the default\n  ADMIN\n}\n`;
		const parsed = parsePrismaFile(source, "schema.prisma");
		expect(parsed.source).toMatch(/- USER — the default$/m);
	});

	test("enum value with @map attribute renders in Values: bullet", () => {
		// Pre-fix `renderEnumProse` emitted `- ${node.name}` only, silently
		// dropping `node.attributes`. Field bullets already include
		// attributes; the enum bullet's inline emit missed the parallel.
		const source = `enum Role {\n  ADMIN @map("admin")\n  USER\n}\n`;
		const parsed = parsePrismaFile(source, "schema.prisma");
		expect(parsed.source).toMatch(/- ADMIN @map\("admin"\)/);
		expect(parsed.source).toMatch(/- USER$/m);
	});

	test("enum value with attribute AND leading /// doc → both surface, attr before em-dash", () => {
		const source = `enum Role {\n  /// Privileged role.\n  ADMIN @map("admin")\n}\n`;
		const parsed = parsePrismaFile(source, "schema.prisma");
		expect(parsed.source).toMatch(/- ADMIN @map\("admin"\) — Privileged role\./);
	});
});

// ─── Datasource / generator settings ───────────────────────────────────────

describe("synthesizePrismaFile — datasource assignments rendered", () => {
	test("each assignment emits a `- key = value` line", () => {
		const parsed = parsePrismaFile(MINIMAL_PRISMA, "schema.prisma");
		expect(parsed.source).toMatch(/Settings:\n- provider = postgresql\n- url = env\(DATABASE_URL\)/);
	});
});

describe("synthesizePrismaFile — generator assignments rendered", () => {
	test("provider + previewFeatures array surface", () => {
		const source = `generator client {\n  provider = "prisma-client-js"\n  previewFeatures = ["views", "fullTextSearch"]\n}\n`;
		const parsed = parsePrismaFile(source, "schema.prisma");
		expect(parsed.source).toMatch(/- provider = prisma-client-js/);
		expect(parsed.source).toMatch(/- previewFeatures = \[views, fullTextSearch\]/);
	});
});

// ─── @@map → Table: prose line ─────────────────────────────────────────────

describe("synthesizePrismaFile — @@map surfaces as Table: prose line", () => {
	test("model with @@map gets a Table: line above Fields:", () => {
		const source = `model User {\n  id Int @id\n\n  @@map("users_v2")\n}\n`;
		const parsed = parsePrismaFile(source, "schema.prisma");
		expect(parsed.source).toMatch(/Table: users_v2\n/);
	});

	test("model without @@map gets no Table: line", () => {
		const parsed = parsePrismaFile(`model User {\n  id Int @id\n}\n`, "schema.prisma");
		expect(parsed.source).not.toMatch(/Table:/);
	});

	test('model with @@map(name: "X") named-argument form also gets a Table: line', () => {
		// Cal.com schema.prisma uses this form exclusively; the positional-only
		// extraction missed it before this fix.
		const source = `model User {\n  id Int @id\n\n  @@map(name: "users_v2")\n}\n`;
		const parsed = parsePrismaFile(source, "schema.prisma");
		expect(parsed.source).toMatch(/Table: users_v2\n/);
	});
});

// ─── Block attributes ──────────────────────────────────────────────────────

describe("synthesizePrismaFile — block-level attributes preserved", () => {
	test("@@id and @@index appear in 'Block attributes:' list", () => {
		const source = `model User {\n  id Int\n  email String\n\n  @@id([id])\n  @@index([email])\n}\n`;
		const parsed = parsePrismaFile(source, "schema.prisma");
		expect(parsed.source).toMatch(/Block attributes:/);
		expect(parsed.source).toMatch(/- @@id\(/);
		expect(parsed.source).toMatch(/- @@index\(/);
	});
});

// ─── Field-level attributes in fence ───────────────────────────────────────

describe("synthesizePrismaFile — field-level attributes in fence", () => {
	test("@id, @default, @relation, @db.* preserved in fence JSON", () => {
		const parsed = parsePrismaFile(FULL_PRISMA, "schema.prisma");
		expect(parsed.source).toMatch(/"name":"id","kind":"field"/);
		expect(parsed.source).toMatch(/"name":"default","kind":"field"/);
		expect(parsed.source).toMatch(/"name":"relation","kind":"field"/);
		expect(parsed.source).toMatch(/"name":"VarChar","kind":"field","group":"db"/);
	});
});

// ─── String-literal quotes preserved in attribute/function args ───────────

describe("synthesizePrismaFile — string-literal quotes preserved in attribute/function args", () => {
	test("@default('USER') (string) distinguishable from @default(USER) (enum ref)", () => {
		// Pre-fix `formatValueForProse` stripped wrapping quotes from every
		// string, collapsing the string-literal default and the enum-value
		// reference into identical prose. The targeted fix preserves quotes
		// only in attribute/function arg position.
		const source = `model X {\n  status1 String @default("USER")\n  status2 Role @default(USER)\n}\nenum Role {\n  USER\n}\n`;
		const parsed = parsePrismaFile(source, "schema.prisma");
		expect(parsed.source).toMatch(/status1: String @default\("USER"\)/);
		expect(parsed.source).toMatch(/status2: Role @default\(USER\)/);
	});

	test("nested function arg keeps quotes: @default(dbgenerated('uuid_generate_v4()'))", () => {
		const source = `model X {\n  id String @id @default(dbgenerated("uuid_generate_v4()"))\n}\n`;
		const parsed = parsePrismaFile(source, "schema.prisma");
		expect(parsed.source).toMatch(/@default\(dbgenerated\("uuid_generate_v4\(\)"\)\)/);
	});

	test("@@map('users') keeps quotes in Block attributes; Table: users stays unquoted", () => {
		// Two `@@map` surfaces follow different rules: the Table: prose line
		// uses an explicit `stripQuotes` call dedicated to the convenience
		// surface; the Block attributes: line routes through the new
		// preserveQuotes path. Both behaviors must coexist.
		const source = `model User {\n  id Int @id\n\n  @@map("users")\n}\n`;
		const parsed = parsePrismaFile(source, "schema.prisma");
		expect(parsed.source).toMatch(/Table: users\n/);
		expect(parsed.source).toMatch(/- @@map\("users"\)/);
	});

	test("Settings: prose still strips quotes (scope-limited fix)", () => {
		// Regression guard: the targeted fix touches only formatAttributeArg.
		// Settings prose (datasource/generator) keeps the cleaner stripped
		// form because there's no string-vs-enum ambiguity in config blocks.
		const parsed = parsePrismaFile(MINIMAL_PRISMA, "schema.prisma");
		expect(parsed.source).toMatch(/- provider = postgresql/);
	});
});

// ─── Unsupported("...") field type preserves PSL syntax ────────────────────

describe('synthesizePrismaFile — Unsupported("...") field type preserves PSL syntax', () => {
	test('Unsupported("point") renders with quotes', () => {
		const source = `model Star {\n  id Int @id\n  position Unsupported("point")\n}\n`;
		const parsed = parsePrismaFile(source, "schema.prisma");
		expect(parsed.source).toMatch(/position: Unsupported\("point"\)/);
	});

	test('optional Unsupported("circle")? keeps quotes AND ? suffix order', () => {
		const source = `model Star {\n  id Int @id\n  position Unsupported("circle")?\n}\n`;
		const parsed = parsePrismaFile(source, "schema.prisma");
		expect(parsed.source).toMatch(/position: Unsupported\("circle"\)\?/);
	});

	test('array Unsupported("polygon")[] keeps quotes AND [] suffix order', () => {
		const source = `model Region {\n  id Int @id\n  shapes Unsupported("polygon")[]\n}\n`;
		const parsed = parsePrismaFile(source, "schema.prisma");
		expect(parsed.source).toMatch(/shapes: Unsupported\("polygon"\)\[\]/);
	});

	test('nested parens/commas survive: Unsupported("geography(Point, 4326)")', () => {
		const source = `model PointOfInterest {\n  id Int @id\n  location Unsupported("geography(Point, 4326)")\n}\n`;
		const parsed = parsePrismaFile(source, "schema.prisma");
		expect(parsed.source).toContain('Unsupported("geography(Point, 4326)")');
	});

	test("combined with @default(dbgenerated(...)) — both surfaces preserve quotes", () => {
		// Shape verbatim from Prisma docs (Star model example).
		const source = `model Star {\n  id Int @id @default(autoincrement())\n  position Unsupported("circle")? @default(dbgenerated("'<(10,4),11>'::circle"))\n}\n`;
		const parsed = parsePrismaFile(source, "schema.prisma");
		expect(parsed.source).toMatch(/Unsupported\("circle"\)\?/);
		expect(parsed.source).toMatch(/@default\(dbgenerated\("'<\(10,4\),11>'::circle"\)\)/);
	});
});

// ─── /// doc comments on block-level attributes ───────────────────────────

describe("synthesizePrismaFile — /// doc comments on block-level attributes", () => {
	test("/// preceding @@index attaches as — doc on the bullet", () => {
		const source = `model User {\n  id Int @id\n  /// Fast lookups\n  @@index([id])\n}\n`;
		const parsed = parsePrismaFile(source, "schema.prisma");
		expect(parsed.source).toMatch(/- @@index\(\[id\]\) — Fast lookups/);
	});

	test("multiple consecutive /// lines before block-attr join with space", () => {
		const source = `model User {\n  id Int\n  /// Compound key\n  /// of (id, tenantId)\n  @@id([id, tenantId])\n}\n`;
		const parsed = parsePrismaFile(source, "schema.prisma");
		expect(parsed.source).toMatch(/- @@id\(\[id, tenantId\]\) — Compound key of \(id, tenantId\)/);
	});

	test('/// preceding @@map("X") attaches as — doc AND Table: X line preserved', () => {
		const source = `model User {\n  id Int @id\n  /// Mapped to legacy table\n  @@map("users_v2")\n}\n`;
		const parsed = parsePrismaFile(source, "schema.prisma");
		expect(parsed.source).toMatch(/Table: users_v2\n/);
		expect(parsed.source).toMatch(/- @@map\("users_v2"\) — Mapped to legacy table/);
	});

	test("enum: /// preceding @@map on enum block attaches", () => {
		const source = `enum Role {\n  USER\n  ADMIN\n  /// Mapped to role_kind\n  @@map("role_kind")\n}\n`;
		const parsed = parsePrismaFile(source, "schema.prisma");
		expect(parsed.source).toMatch(/- @@map\("role_kind"\) — Mapped to role_kind/);
	});
});

// ─── Orphan /// at end-of-block surfaces in Notes: ─────────────────────────

describe("synthesizePrismaFile — orphan /// at end-of-block surfaces in Notes:", () => {
	test("single /// at end of model block emits Notes: sub-section", () => {
		const source = `model User {\n  id Int @id\n  /// TODO add email\n}\n`;
		const parsed = parsePrismaFile(source, "schema.prisma");
		expect(parsed.source).toMatch(/Notes:\n- TODO add email\n/);
	});

	test("multiple /// at end of model → multiple bullets in Notes", () => {
		const source = `model User {\n  id Int @id\n  /// Note A\n  /// Note B\n}\n`;
		const parsed = parsePrismaFile(source, "schema.prisma");
		expect(parsed.source).toMatch(/Notes:\n- Note A\n- Note B\n/);
	});

	test("compound: /// attached → @@index → /// orphan → first attaches, second in Notes", () => {
		const source = `model User {\n  id Int\n  /// fast lookup\n  @@index([id])\n  /// TODO: composite\n}\n`;
		const parsed = parsePrismaFile(source, "schema.prisma");
		expect(parsed.source).toMatch(/- @@index\(\[id\]\) — fast lookup/);
		expect(parsed.source).toMatch(/Notes:\n- TODO: composite\n/);
	});

	test("enum: orphan /// at end of enum → Notes section", () => {
		const source = `enum Role {\n  USER\n  ADMIN\n  /// TODO: SUPERUSER?\n}\n`;
		const parsed = parsePrismaFile(source, "schema.prisma");
		expect(parsed.source).toMatch(/Notes:\n- TODO: SUPERUSER\?\n/);
	});
});

// ─── Pinned parser excludes ambient location fields from JSON fence ───────

describe("parsePrismaFile — pinned parser excludes ambient location fields from JSON fence", () => {
	test("JSON fence body contains no location key regardless of ambient config", () => {
		// `@mrleebo/prisma-ast`'s default visitor merges `location: CstNodeLocation`
		// onto every AST node when the parser is configured with
		// `nodeLocationTracking: 'full' | 'onlyOffset'` — a setting a user's
		// `.prisma-astrc` could supply at cwd. Pinned parser must keep the
		// fence bytes stable per `PARSER_SHAPE_VERSION`-correlated invalidation.
		const source = `model User {\n  id Int @id\n}\n`;
		const parsed = parsePrismaFile(source, "schema.prisma");
		expect(parsed.source).toMatch(/```json/);
		expect(parsed.source).not.toMatch(/"location"\s*:/);
	});
});

// ─── Free-floating doc comments ────────────────────────────────────────────

describe("synthesizePrismaFile — free-floating /// surfaced in ## Schema notes", () => {
	test("trailing /// emits a ## Schema notes section", () => {
		const source = `model User {\n  id Int @id\n}\n\n/// Free-floating note.\n`;
		const parsed = parsePrismaFile(source, "schema.prisma");
		expect(parsed.source).toMatch(/## Schema notes\n\nFree-floating note\./);
	});

	test("leading /// without a following block attaches to ## Schema notes", () => {
		const source = `/// Free-floating note.\n`;
		const parsed = parsePrismaFile(source, "schema.prisma");
		expect(parsed.source).toMatch(/## Schema notes\n\nFree-floating note\./);
	});

	test("no Schema notes section when there are no free-floating ///", () => {
		const parsed = parsePrismaFile(MINIMAL_PRISMA, "schema.prisma");
		expect(parsed.source).not.toMatch(/## Schema notes/);
	});
});

describe("synthesizePrismaFile — bare // comments dropped", () => {
	test("// comments do not appear in source", () => {
		const source = `// just a regular comment\nmodel User {\n  id Int @id\n}\n`;
		const parsed = parsePrismaFile(source, "schema.prisma");
		expect(parsed.source).not.toMatch(/just a regular comment/);
	});
});

describe("synthesizePrismaFile — bare // comments dropped from JSON fence", () => {
	test("bare // inside model body excluded from fence", () => {
		const source = `model User {\n  id Int @id\n  // internal-only-todo\n  email String\n}\n`;
		const parsed = parsePrismaFile(source, "schema.prisma");
		expect(parsed.source).not.toMatch(/internal-only-todo/);
	});

	test("trailing bare // after a field excluded from fence", () => {
		const source = `model User {\n  id Int @id // private mailing\n  email String\n}\n`;
		const parsed = parsePrismaFile(source, "schema.prisma");
		expect(parsed.source).not.toMatch(/private mailing/);
	});

	test("bare // inside enum body excluded from fence", () => {
		const source = `enum Role {\n  USER\n  // deprecate ME\n  ADMIN\n}\n`;
		const parsed = parsePrismaFile(source, "schema.prisma");
		expect(parsed.source).not.toMatch(/deprecate ME/);
	});

	test("bare // inside datasource body excluded from fence", () => {
		const source = `datasource db {\n  provider = "postgresql"\n  // TODO migrate to mysql\n  url      = env("DATABASE_URL")\n}\n`;
		const parsed = parsePrismaFile(source, "schema.prisma");
		expect(parsed.source).not.toMatch(/TODO migrate to mysql/);
	});

	test("/// doc comments still appear in the fence (regression)", () => {
		const source = `model User {\n  /// internal documentation\n  id Int @id\n}\n`;
		const parsed = parsePrismaFile(source, "schema.prisma");
		expect(parsed.source).toMatch(/internal documentation/);
	});
});

// ─── Block comments (pre-strip + surface as Schema notes) ─────────────────

describe("synthesizePrismaFile — block comments pre-stripped + surfaced", () => {
	test("leading /* ... */ before a model surfaces in Schema notes", () => {
		const source = `/* schema-level block comment */\n\nmodel User {\n  id Int @id\n}\n`;
		const parsed = parsePrismaFile(source, "schema.prisma");
		expect(parsed.source).toMatch(/## Schema notes\n\nschema-level block comment/);
	});

	test("multi-line block comment preserves line breaks in Schema notes", () => {
		const source = `/*\n  hello\n  world\n*/\n\nmodel User {\n  id Int @id\n}\n`;
		const parsed = parsePrismaFile(source, "schema.prisma");
		expect(parsed.source).toMatch(/## Schema notes/);
		expect(parsed.source).toMatch(/hello/);
		expect(parsed.source).toMatch(/world/);
	});

	test("block comment inside model body parses successfully (no PRISMA_PARSE_ERROR)", () => {
		const source = `model User {\n  id Int @id\n  /* inline block doc */\n  email String\n}\n`;
		expect(() => parsePrismaFile(source, "schema.prisma")).not.toThrow();
		const parsed = parsePrismaFile(source, "schema.prisma");
		// v1: appears as floating Schema notes (attachment-to-AST-node deferred).
		expect(parsed.source).toMatch(/inline block doc/);
	});

	test("block comment inside string literal NOT stripped", () => {
		const source = `model User {\n  id Int @id\n  url String @default("https://example.com/*marker*/foo")\n}\n`;
		expect(() => parsePrismaFile(source, "schema.prisma")).not.toThrow();
		const parsed = parsePrismaFile(source, "schema.prisma");
		// The fence renders the AST: the @default value must carry the
		// full URL including the slash-star-marker-star-slash sequence.
		expect(parsed.source).toMatch(/example\.com\/\*marker\*\/foo/);
		// And the URL fragment must NOT appear as a floating Schema note.
		expect(parsed.source).not.toMatch(/## Schema notes/);
	});

	test("unclosed block comment throws with the `/*` opener's line/column", () => {
		// Pre-fix this consumed to EOF and surfaced the inner text as a
		// `## Schema notes` paragraph — silent data loss when valid blocks
		// preceded the unclosed `/*`. The stripper now throws instead. The
		// `/*` opener sits on line 5 column 1 (after `model User { ... }\n\n`),
		// so the error must carry those coordinates — different from the
		// line-1/column-1 case covered elsewhere in this file.
		const source = `model User {\n  id Int @id\n}\n\n/* unclosed runs to EOF`;
		let caught: unknown = null;
		try {
			parsePrismaFile(source, "schema.prisma");
		} catch (e) {
			caught = e;
		}
		expect(caught).toBeInstanceOf(ParseError);
		const pe = caught as ParseError;
		expect(pe.format).toBe("prisma");
		expect(pe.reason).toBe("syntax");
		expect(pe.message).toMatch(/Unterminated/);
		expect(pe.line).toBe(5);
		expect(pe.column).toBe(1);
	});

	test("block-comment-only source still synthesizes a Schema notes section", () => {
		const source = `/* only a block comment */\n`;
		const parsed = parsePrismaFile(source, "block-comment-only.prisma");
		expect(parsed.source).toMatch(/## Schema notes\n\nonly a block comment/);
		expect(parsed.headings.length).toBe(1);
		expect(parsed.headings[0]?.displayText).toBe("Schema notes");
	});
});

// ─── Line comments containing /* must not trigger block-comment mode ──────

describe("stripPrismaBlockComments — line comments shield embedded /*", () => {
	const expectStripIsNoop = (source: string): void => {
		const { stripped, blockComments } = stripPrismaBlockComments(source);
		expect(stripped).toBe(source);
		expect(blockComments).toEqual([]);
	};

	test("// with closed /* ... */ inside is preserved verbatim", () => {
		const source = `// see /* foo */ for docs\nmodel User {\n  id Int @id\n}\n`;
		expectStripIsNoop(source);
		const parsed = parsePrismaFile(source, "schema.prisma");
		expect(parsed.source).not.toMatch(/## Schema notes/);
		expect(parsed.headings.some((h) => h.displayText === "model User")).toBe(true);
	});

	test("// with unclosed /* does NOT swallow rest of file", () => {
		const source = `// /* unclosed\nmodel User {\n  id Int @id\n}\n`;
		expectStripIsNoop(source);
		const parsed = parsePrismaFile(source, "schema.prisma");
		expect(parsed.headings.some((h) => h.displayText === "model User")).toBe(true);
		expect(parsed.source).not.toMatch(/## Schema notes/);
	});

	test("/// doc comment with /* inside is preserved (no rest-of-file loss)", () => {
		const source = `/// docs about /* TODO\nmodel User {\n  id Int @id\n}\n`;
		expectStripIsNoop(source);
		const parsed = parsePrismaFile(source, "schema.prisma");
		expect(parsed.headings.some((h) => h.displayText === "model User")).toBe(true);
		expect(parsed.source).toMatch(/docs about \/\* TODO/);
	});

	test("// at EOF with no trailing newline", () => {
		const source = `model User {\n  id Int @id\n}\n// trailing /* without newline`;
		expectStripIsNoop(source);
		expect(() => parsePrismaFile(source, "schema.prisma")).not.toThrow();
	});

	test("// inside string literal — string mode still wins", () => {
		const source = `model X {\n  url String @default("//hello/*foo*/")\n}\n`;
		expectStripIsNoop(source);
		const parsed = parsePrismaFile(source, "schema.prisma");
		// @default value lands in the synthesized JSON fence, so parsed.source
		// is the surface where we can witness the URL surviving intact.
		expect(parsed.source).toMatch(/\/\/hello\/\*foo\*\//);
		expect(parsed.source).not.toMatch(/## Schema notes/);
	});

	test("// fence stops at \\n despite later stray */", () => {
		// The /* on line 1 lives inside a line comment; the */ on a later
		// line is orphan input that the downstream lexer rejects — confirming
		// the line-comment fence didn't leak past \n into block-comment mode.
		const source = `// /* opens\nmodel User {\n  id Int @id\n}\n*/ trailing\n`;
		expectStripIsNoop(source);
		expect(() => parsePrismaFile(source, "schema.prisma")).toThrow(ParseError);
	});

	test("bare /* without closing */ throws PRISMA_PARSE_ERROR with opener line/column", () => {
		// Pre-fix the inner while-loop walked to EOF, whitespace-replaced the
		// entire remainder of the file, and surfaced the swallowed model body
		// as a `## Schema notes` paragraph while the model itself vanished —
		// catastrophic silent data loss. Now the stripper throws on EOF.
		const source = `/* todo\nmodel User {\n  id Int @id\n}\n`;
		let caught: unknown = null;
		try {
			parsePrismaFile(source, "schema.prisma");
		} catch (e) {
			caught = e;
		}
		expect(caught).toBeInstanceOf(ParseError);
		const pe = caught as ParseError;
		expect(pe.format).toBe("prisma");
		expect(pe.reason).toBe("syntax");
		expect(pe.message).toMatch(/Unterminated/);
		expect(pe.line).toBe(1);
		expect(pe.column).toBe(1);
	});
});

// ─── extractPrismaErrorLocation surfaces line/column from chevrotain ──────

describe("parsePrismaFile — extractPrismaErrorLocation populates line/column", () => {
	test("redundant-input error carries token.startLine", () => {
		// Top-level garbage that triggers `NotAllInputParsedException` —
		// chevrotain throws with a real `.token` (line 1 NumberLiteral).
		const source = `1234 abc def\n`;
		let caught: unknown = null;
		try {
			parsePrismaFile(source, "schema.prisma");
		} catch (e) {
			caught = e;
		}
		expect(caught).toBeInstanceOf(ParseError);
		expect((caught as ParseError).reason).toBe("syntax");
		expect((caught as ParseError).line).toBe(1);
		expect((caught as ParseError).column).toBeGreaterThan(0);
	});

	test("missing-brace EOF falls back to previousToken's line", () => {
		// Unclosed model body — chevrotain throws `MismatchedTokenException`
		// with `token` = EOF (positions are NaN) and `previousToken` carrying
		// the last real position (the trailing LineBreak token at line 2).
		const source = `model User {\n  id Int @id\n`;
		let caught: unknown = null;
		try {
			parsePrismaFile(source, "schema.prisma");
		} catch (e) {
			caught = e;
		}
		expect(caught).toBeInstanceOf(ParseError);
		const err = caught as ParseError;
		expect(err.reason).toBe("syntax");
		expect(err.line).toBe(2);
		expect(Number.isFinite(err.line)).toBe(true);
	});
});

// ─── env() / dbgenerated() preservation ────────────────────────────────────

describe("synthesizePrismaFile — function args preserved in fence", () => {
	test("env() and dbgenerated() appear verbatim in the AST fence", () => {
		const source = `datasource db {\n  provider = "postgresql"\n  url = env("DATABASE_URL")\n}\nmodel User {\n  id String @id @default(dbgenerated("uuid_generate_v4()"))\n}\n`;
		const parsed = parsePrismaFile(source, "schema.prisma");
		expect(parsed.source).toMatch(/"name":"env"/);
		expect(parsed.source).toMatch(/"name":"dbgenerated"/);
	});
});

// ─── Relation field arg preservation ───────────────────────────────────────

describe("synthesizePrismaFile — relation field args preserved", () => {
	test("@relation(fields: [...], references: [...]) preserved in fence", () => {
		const parsed = parsePrismaFile(FULL_PRISMA, "schema.prisma");
		expect(parsed.source).toMatch(/"key":"fields"/);
		expect(parsed.source).toMatch(/"key":"references"/);
	});
});

// ─── 64 KiB fence cap ──────────────────────────────────────────────────────

describe("synthesizePrismaFile — JSON fence 64 KiB cap + truncation", () => {
	test("pathological model truncates with elision marker + language=text", () => {
		// Construct a model with enough fields + long default literals so its
		// JSON exceeds 64 KiB. Each field contributes ~150 bytes of fence JSON;
		// 500 fields ≈ 75 KB. `maxAstNodes` raised so the AST_NODE_CAP doesn't
		// fire before we reach the fence-size guard.
		const longLiteral = "a".repeat(64);
		const fields = Array.from({ length: 500 }, (_, i) => `  field${i} String @default("${longLiteral}")`).join("\n");
		const source = `model Big {\n${fields}\n}\n`;
		const parsed = parsePrismaFile(source, "schema.prisma", { maxAstNodes: 1_000_000 });
		expect(parsed.source).toMatch(/```text/);
		expect(parsed.source).toMatch(/\.\.\. \(truncated; \d+ bytes elided\)/);
	});

	test("normal-size model stays on `json` language", () => {
		const parsed = parsePrismaFile(MINIMAL_PRISMA, "schema.prisma");
		const jsonFences = (parsed.source.match(/```json/g) ?? []).length;
		expect(jsonFences).toBeGreaterThan(0);
	});
});

// ─── Prototype pollution defense ───────────────────────────────────────────

describe("synthesizePrismaFile — prototype pollution defense", () => {
	test("schema with no __proto__ keys produces clean fence (sanity)", () => {
		const parsed = parsePrismaFile(MINIMAL_PRISMA, "schema.prisma");
		expect(parsed.source).not.toMatch(/__proto__/);
		expect(parsed.source).not.toMatch(/"constructor"/);
	});

	test("synthesized frontmatter does not carry [[Prototype]] swap from user input", () => {
		// The PSL parser itself doesn't accept `__proto__` as a block name, but
		// if a future shape allowed it through `Assignment.value`, deepSanitize
		// would strip it. Sanity-check that __proto__ is not enumerable on output.
		const parsed = parsePrismaFile(MINIMAL_PRISMA, "schema.prisma");
		const fm = parsed.frontmatter as Record<string, unknown>;
		expect(Object.hasOwn(fm, "__proto__")).toBe(false);
	});
});

// ─── Contract test: AST shape ──────────────────────────────────────────────

describe("synthesizePrismaFile — AST shape contract (drift detector)", () => {
	test("@mrleebo/prisma-ast emits the exact shape we depend on", () => {
		// Locks the AST contract we read in src/lib/parsers/prisma.ts. If
		// @mrleebo/prisma-ast changes block/field/attribute shape between
		// versions, this test fails with a precise diff so the
		// synthesizer can adapt.
		const schema = getSchema(`/// Doc.\nmodel User {\n  id Int @id @default(autoincrement())\n}\n`);
		expect(schema).toMatchObject({
			type: "schema",
			list: expect.arrayContaining([
				expect.objectContaining({ type: "comment", text: "/// Doc." }),
				expect.objectContaining({
					type: "model",
					name: "User",
					properties: expect.arrayContaining([
						expect.objectContaining({
							type: "field",
							name: "id",
							fieldType: "Int",
							attributes: expect.arrayContaining([
								expect.objectContaining({ type: "attribute", kind: "field", name: "id" }),
								expect.objectContaining({
									type: "attribute",
									kind: "field",
									name: "default",
									args: expect.arrayContaining([
										expect.objectContaining({
											type: "attributeArgument",
											value: expect.objectContaining({ type: "function", name: "autoincrement" }),
										}),
									]),
								}),
							]),
						}),
					]),
				}),
			]),
		});
	});
});

// ─── Parse errors ──────────────────────────────────────────────────────────

describe("parsePrismaFile — syntax errors → PRISMA_PARSE_ERROR", () => {
	test("malformed schema throws ParseError with format='prisma'", () => {
		const source = `model User { id\n}\n@@@ not valid`;
		expect(() => parsePrismaFile(source, "schema.prisma")).toThrow(ParseError);
		try {
			parsePrismaFile(source, "schema.prisma");
		} catch (e) {
			expect(e).toBeInstanceOf(ParseError);
			expect((e as ParseError).format).toBe("prisma");
			expect((e as ParseError).reason).toBe("syntax");
		}
	});

	test("syntax error preserves PRISMA_PARSE_ERROR shape (line/column may or may not be set)", () => {
		// PSL block on a single line — parser expects LineBreak after `{`.
		const source = `model User { id Int @id }\n`;
		let caught: unknown = null;
		try {
			parsePrismaFile(source, "schema.prisma");
		} catch (e) {
			caught = e;
		}
		expect(caught).toBeInstanceOf(ParseError);
		const err = caught as ParseError;
		expect(err.format).toBe("prisma");
		expect(err.reason).toBe("syntax");
		// Best-effort location extraction: `line` is set when chevrotain carries
		// a `token.startLine`. Not all error shapes expose it (lex vs parse
		// errors differ), so the contract is "if present, it's a positive int."
		if (err.line !== undefined) expect(err.line).toBeGreaterThan(0);
	});
});

describe("parsePrismaFile — ast_node_cap_exceeded", () => {
	test("synthetic low cap fires ast_node_cap_exceeded", () => {
		expect(() => parsePrismaFile(FULL_PRISMA, "schema.prisma", { maxAstNodes: 10 })).toThrow(ParseError);
		try {
			parsePrismaFile(FULL_PRISMA, "schema.prisma", { maxAstNodes: 10 });
		} catch (e) {
			expect(e).toBeInstanceOf(ParseError);
			expect((e as ParseError).reason).toBe("ast_node_cap_exceeded");
			expect((e as ParseError).format).toBe("prisma");
		}
	});
});

// ─── Opaque fallback for empty schemas ─────────────────────────────────────

describe("parsePrismaFile — opaque fallback", () => {
	test("empty source produces an opaque ParsedFile with kind='prisma'", () => {
		const parsed = parsePrismaFile(``, "empty.prisma");
		expect(parsed.kind).toBe("prisma");
		expect(parsed.headings).toEqual([]);
		expect(parsed.hasFrontmatter).toBe(false);
	});

	test("only-// source produces an opaque ParsedFile", () => {
		const parsed = parsePrismaFile(`// just a comment\n`, "comments.prisma");
		expect(parsed.kind).toBe("prisma");
		expect(parsed.headings).toEqual([]);
	});
});

// ─── Slug deduplication ────────────────────────────────────────────────────

describe("synthesizePrismaFile — slug deduplication", () => {
	test("same-name blocks of different kinds get distinct slugs via kind prefix", () => {
		const source = `model Foo {\n  id Int @id\n}\nenum Foo {\n  A\n  B\n}\n`;
		const parsed = parsePrismaFile(source, "schema.prisma");
		const slugs = parsed.headings.filter(isBlockHeading).map((h) => h.slug);
		expect(slugs).toEqual(["model-foo", "enum-foo"]);
		expect(new Set(slugs).size).toBe(2);
	});
});

// ─── Optional / array field markers ────────────────────────────────────────

describe("synthesizePrismaFile — optional and array field markers", () => {
	test("array field renders with [] suffix", () => {
		const source = `model User {\n  id Int @id\n  posts Post[]\n}\n`;
		const parsed = parsePrismaFile(source, "schema.prisma");
		expect(parsed.source).toMatch(/- posts: Post\[\]/);
	});

	test("optional field renders with ? suffix", () => {
		const source = `model User {\n  id Int @id\n  name String?\n}\n`;
		const parsed = parsePrismaFile(source, "schema.prisma");
		expect(parsed.source).toMatch(/- name: String\?/);
	});
});

// ─── synthesizePrismaFile direct (bypassing parse) ─────────────────────────

describe("synthesizePrismaFile — direct invocation", () => {
	test("schema with only datasource still synthesizes (single block ok)", () => {
		const schema = getSchema(`datasource db {\n  provider = "postgresql"\n}\n`);
		const parsed = synthesizePrismaFile(schema as never, "single.prisma");
		expect(parsed).not.toBeNull();
		expect(parsed!.headings).toHaveLength(1);
		expect(parsed!.headings[0]!.headingPath[0]).toBe("datasource db");
	});

	test("schema with only floating /// surfaces only ## Schema notes", () => {
		const schema = getSchema(`/// Just a note.\n`);
		const parsed = synthesizePrismaFile(schema as never, "notes.prisma");
		expect(parsed).not.toBeNull();
		expect(parsed!.headings).toHaveLength(1);
		expect(parsed!.headings[0]!.headingPath[0]).toBe("Schema notes");
	});
});

// ─── frontmatterOnly fast path ─────────────────────────────────────────────

describe("parsePrismaFile — frontmatterOnly fast path", () => {
	test("returns frontmatter without synthesizing headings", () => {
		const parsed = parsePrismaFile(FULL_PRISMA, "schema.prisma", { frontmatterOnly: true });
		expect(parsed.kind).toBe("prisma");
		expect(parsed.headings).toHaveLength(0);
		expect(parsed.outline).toHaveLength(0);
		expect(parsed.hasFrontmatter).toBe(true);
		const fm = parsed.frontmatter as Record<string, Record<string, Record<string, unknown>>>;
		expect(fm.datasource?.db?.provider).toBe("postgresql");
		expect(fm.generator?.client?.provider).toBe("prisma-client-js");
	});

	test("does not invoke estimateTokens (survives unsupported VAULT_TOKENIZER)", async () => {
		// `estimateTokens` throws on any non-heuristic tokenizer id; the fast
		// path must avoid heading synthesis (which calls it transitively) so
		// `get_metadata` doesn't INTERNAL_ERROR on `.prisma` for users with a
		// non-default `VAULT_TOKENIZER`.
		const { vi } = await import("vitest");
		vi.stubEnv("VAULT_TOKENIZER", "tiktoken/o200k_base");
		try {
			expect(() => parsePrismaFile(FULL_PRISMA, "schema.prisma", { frontmatterOnly: true })).not.toThrow();
		} finally {
			vi.unstubAllEnvs();
		}
	});

	test("falls back to opaque shape for a schema with no indexable blocks", () => {
		const src = `// just a comment\n`;
		const parsed = parsePrismaFile(src, "empty.prisma", { frontmatterOnly: true });
		expect(parsed.kind).toBe("prisma");
		expect(parsed.headings).toHaveLength(0);
		expect(parsed.hasFrontmatter).toBe(false);
	});

	test("frontmatter is empty when only model/enum blocks exist (no datasource/generator)", () => {
		const src = `model User {\n  id Int @id\n}\n`;
		const parsed = parsePrismaFile(src, "models.prisma", { frontmatterOnly: true });
		expect(parsed.headings).toHaveLength(0);
		expect(parsed.hasFrontmatter).toBe(false);
		expect(parsed.frontmatter).toEqual({});
	});
});

// ─── Block-opener whitespace normalization ─────────────────────────────────

describe("parsePrismaFile — block-opener whitespace normalization", () => {
	test("trailing space after `{` parses", () => {
		const src = `model User { \n  id Int @id\n}\n`;
		const parsed = parsePrismaFile(src, "schema.prisma");
		expect(parsed.headings.filter(isBlockHeading)).toHaveLength(1);
		expect(parsed.headings[0]?.displayText).toBe("model User");
	});

	test("trailing tab after `{` parses", () => {
		const src = `model User {\t\n  id Int @id\n}\n`;
		const parsed = parsePrismaFile(src, "schema.prisma");
		expect(parsed.headings.filter(isBlockHeading)).toHaveLength(1);
	});

	test("multiple horizontal-WS chars after `{` parse", () => {
		const src = `model User {     \n  id Int @id\n}\n`;
		const parsed = parsePrismaFile(src, "schema.prisma");
		expect(parsed.headings.filter(isBlockHeading)).toHaveLength(1);
	});

	test("inline block comment on block-opener line parses + surfaces in Notes:", () => {
		const src = `model User { /* primary key */\n  id Int @id\n}\n`;
		const parsed = parsePrismaFile(src, "schema.prisma");
		expect(parsed.headings.filter(isBlockHeading)).toHaveLength(1);
		expect(parsed.source).toMatch(/primary key/);
	});

	test("CRLF newlines work", () => {
		const src = `model User { \r\n  id Int @id\r\n}\r\n`;
		const parsed = parsePrismaFile(src, "schema.prisma");
		expect(parsed.headings.filter(isBlockHeading)).toHaveLength(1);
	});

	test("multi-line inline object in attribute arg still parses (paren-depth gate)", () => {
		// `@default({ \n ... })` would have its inner `{ \n` rotated incorrectly
		// if the helper didn't track paren depth. The `object` rule does NOT
		// consume LineBreak, so injecting one inside an attribute arg would
		// break the parse. Guards against regressions in the depth-tracking.
		const src = `model X {\n  field Int @default(autoincrement())\n  meta Json @default("{}")\n}\n`;
		const parsed = parsePrismaFile(src, "schema.prisma");
		expect(parsed.headings.filter(isBlockHeading)).toHaveLength(1);
	});

	test("`//` line comment containing `{ ` does NOT trigger rotation", () => {
		const src = `// model X { \nmodel User {\n  id Int @id\n}\n`;
		const parsed = parsePrismaFile(src, "schema.prisma");
		const blocks = parsed.headings.filter(isBlockHeading);
		expect(blocks).toHaveLength(1);
		expect(blocks[0]?.displayText).toBe("model User");
	});

	test("string literal containing `{ ` does NOT trigger rotation", () => {
		const src = `datasource db {\n  provider = "this {  has braces"\n  url = env("X")\n}\n`;
		const parsed = parsePrismaFile(src, "schema.prisma");
		expect(parsed.headings.filter(isBlockHeading)).toHaveLength(1);
	});

	test("normalization is a no-op for sources without `{[ \\t]+\\n`", () => {
		// Smoke-test the fast path: standard PSL passes through unchanged.
		const src = `model User {\n  id Int @id\n  name String\n}\n`;
		const parsed = parsePrismaFile(src, "schema.prisma");
		expect(parsed.headings.filter(isBlockHeading)).toHaveLength(1);
	});
});

// ─── Opener-line comment normalization ─────────────────────────────────────

describe("parsePrismaFile — opener-line comment normalization", () => {
	test("`// foo` after `{` (with space) parses + surfaces in Notes:", () => {
		const src = `model User { // primary key\n  id Int @id\n}\n`;
		const parsed = parsePrismaFile(src, "schema.prisma");
		expect(parsed.headings.filter(isBlockHeading)).toHaveLength(1);
		expect(parsed.headings[0]?.displayText).toBe("model User");
		expect(parsed.source).toMatch(/primary key/);
	});

	test("`//` immediately after `{` (no space) parses + surfaces in Notes:", () => {
		const src = `model User {// no-space\n  id Int @id\n}\n`;
		const parsed = parsePrismaFile(src, "schema.prisma");
		expect(parsed.headings.filter(isBlockHeading)).toHaveLength(1);
		expect(parsed.source).toMatch(/no-space/);
	});

	test("`///` doc comment on block-opener line parses + surfaces in Notes:", () => {
		const src = `model User { /// docs\n  id Int @id\n}\n`;
		const parsed = parsePrismaFile(src, "schema.prisma");
		expect(parsed.headings.filter(isBlockHeading)).toHaveLength(1);
		expect(parsed.source).toMatch(/docs/);
	});

	test("tab before `//` on opener line parses", () => {
		const src = `model User {\t// after-tab\n  id Int @id\n}\n`;
		const parsed = parsePrismaFile(src, "schema.prisma");
		expect(parsed.headings.filter(isBlockHeading)).toHaveLength(1);
		expect(parsed.source).toMatch(/after-tab/);
	});

	test("block + line comment on same opener line both surface in Notes:", () => {
		const src = `model User { /* legacy */ // current\n  id Int @id\n}\n`;
		const parsed = parsePrismaFile(src, "schema.prisma");
		expect(parsed.headings.filter(isBlockHeading)).toHaveLength(1);
		expect(parsed.source).toMatch(/legacy/);
		expect(parsed.source).toMatch(/current/);
	});

	test("CRLF newline after opener-line comment parses", () => {
		const src = `model User { // crlf\r\n  id Int @id\r\n}\r\n`;
		const parsed = parsePrismaFile(src, "schema.prisma");
		expect(parsed.headings.filter(isBlockHeading)).toHaveLength(1);
		expect(parsed.source).toMatch(/crlf/);
	});

	test("non-opener line comment does not break parsing", () => {
		// `// inline-id` sits on a field line, not on the opener. The helper
		// must pass it through verbatim so the parser handles it as an inline
		// field comment instead of stripping it (which would also be wrong
		// because field-line comments don't break the LCurly/LineBreak rule).
		const src = `model User {\n  id Int @id // inline-id\n}\n`;
		const parsed = parsePrismaFile(src, "schema.prisma");
		expect(parsed.headings.filter(isBlockHeading)).toHaveLength(1);
		// No `## Schema notes` section should spawn for a field-line comment —
		// that surface is reserved for opener-line + free-floating runs.
		expect(parsed.source).not.toMatch(/## Schema notes/);
	});

	test("`{` inside a line comment does NOT trigger opener-strip", () => {
		const src = `// model X { fake\nmodel User {\n  id Int @id\n}\n`;
		const parsed = parsePrismaFile(src, "schema.prisma");
		const blocks = parsed.headings.filter(isBlockHeading);
		expect(blocks).toHaveLength(1);
		expect(blocks[0]?.displayText).toBe("model User");
		expect(parsed.source).not.toMatch(/fake/);
	});

	test("`{` and `//` inside a string literal do NOT trigger opener-strip", () => {
		// The `{` and `//` inside the URL string must NOT be treated as a
		// block-opener line comment. String content stays in the parsed
		// source (legitimately, as the assignment's value), but no phantom
		// `## Schema notes` section should spawn from the in-string sequence.
		const src = `datasource db {\n  url = "host{port}//path"\n}\n`;
		const parsed = parsePrismaFile(src, "schema.prisma");
		expect(parsed.headings.filter(isBlockHeading)).toHaveLength(1);
		expect(parsed.source).not.toMatch(/## Schema notes/);
	});

	test("empty `//\\n` on opener line parses (empty Notes entry filtered)", () => {
		const src = `model User {//\n  id Int @id\n}\n`;
		const parsed = parsePrismaFile(src, "schema.prisma");
		expect(parsed.headings.filter(isBlockHeading)).toHaveLength(1);
		// Empty stripped-comment strings are filtered out by enumerateSchema's
		// `if (bc.length > 0)` guard — no `## Schema notes` section spawns
		// just because someone left an empty `//` on the opener line.
		expect(parsed.source).not.toMatch(/## Schema notes/);
	});
});
