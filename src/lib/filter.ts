/**
 * `Filter` → parameterized SQL compiler (D12 + D30). Emits WHERE
 * fragments referencing the `f` (fragments) and `fm` (frontmatter)
 * aliases — the IndexHandle query MUST `LEFT JOIN frontmatter fm ON
 * fm.file = f.file` for the `fm.*` references to bind.
 *
 * Reserved `date` resolves via COALESCE chain `fields_json."date" →
 * fm.updated → fm.created → file mtime ISO` (D30 Note 2). Custom date
 * comparisons (`fields["created"]`) skip the chain.
 *
 * Tag literals must match `[a-zA-Z0-9_/-]+` — defends SQL injection
 * before any binding. The LIKE prefix uses `escapeLike` so `_`/`%`/`\`
 * inside legitimate tags don't widen the match (D30 Note 3c).
 *
 * `filterHash` is SHA-1 of canonical JSON with object keys sorted
 * recursively but arrays preserved in source order — `and: [A,B]` and
 * `and: [B,A]` deliberately hash differently for cursor stability.
 */

import { createHash } from "node:crypto";

import type { DateOps, FieldOps, Filter, ScalarOps, TagOps } from "../types.js";

/** Output of {@link compileFilter}. */
export interface CompiledFilter {
	/** SQL fragment to AND into a WHERE clause. */
	whereSql: string;
	/** Named parameters keyed by the `:name` form (without the colon). */
	params: Record<string, unknown>;
	/**
	 * Stable hash of the input filter; bound to cursor envelopes for
	 * pagination drift detection. `""` when filter is empty / null.
	 */
	filterHash: string;
}

/** Thrown for any input shape rejection — dotted-path validation,
 * mixed-category fields, charset-rejected tag literal. The `param` /
 * `expected` fields populate the `FILTER_SYNTAX_ERROR` envelope. */
export class FilterSyntaxError extends Error {
	override readonly name = "FilterSyntaxError";
	readonly param: string;
	readonly expected: string;
	readonly suggest?: string[];
	constructor(opts: { param: string; expected: string; message?: string; suggest?: string[] }) {
		super(opts.message ?? `Invalid filter at ${opts.param}: expected ${opts.expected}.`);
		this.param = opts.param;
		this.expected = opts.expected;
		if (opts.suggest !== undefined) this.suggest = opts.suggest;
	}
}

/**
 * Reserved frontmatter date keys. `date` resolves via the COALESCE chain
 * built below; `created`/`updated` get dedicated columns. Scanner imports
 * this list to normalize the same three keys at index time so lex-compares
 * stay consistent with what the filter compiler expects.
 */
export const RESERVED_DATE_KEYS = ["date", "created", "updated"] as const;

/** Date COALESCE chain SQL — referenced by reserved `date` filter only.
 * `iso_calendar_valid(s)` (UDF registered in `sqlite.ts`) returns `s`
 * when it's an exactly-canonical `YYYY-MM-DDTHH:MM:SSZ` AND the date is
 * calendar-valid; else NULL. Replaces an earlier GLOB shape-check whose
 * character classes admitted calendar-invalid typos like
 * `"2024-99-99T00:00:00Z"` into the chain (brief line 593: invalid
 * dates must be skipped, not lex-compared). */
const RESERVED_DATE_EXPR =
	`COALESCE(` +
	`iso_calendar_valid(json_extract(fm.fields_json, '$."date"')), ` +
	`fm.updated, fm.created, ` +
	`strftime('%Y-%m-%dT%H:%M:%SZ', f.mtime/1000, 'unixepoch'))`;

/** Validation regex for dotted-path segments — printable Unicode (no
 * controls), 1–256 chars. Defends against control-byte and length DoS. */
const SEGMENT_RE = /^[\u0020-\u007E\u00A0-\uFFFF]{1,256}$/;

/** Tag literals: reject anything outside `[a-zA-Z0-9_/-]`. Pre-empts SQL
 * injection at the boundary; the LIKE-escape pass below handles the
 * accepted set's `_` properly. */
const TAG_LITERAL_RE = /^[a-zA-Z0-9_/-]+$/;

/**
 * Heuristic: matches ISO 8601 date-only or datetime forms. Conservative —
 * `Date.parse` alone is too lenient (e.g., `Date.parse("1")` succeeds).
 * Used by the filter disambiguator (date vs scalar) AND by the scanner's
 * index-time normalization (which fields to canonicalize in `fields_json`).
 */
export const ISO_LIKELY_RE = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})?)?$/;

const SCALAR_OPS = ["eq", "ne", "in", "nin", "contains", "is_empty"] as const;
const TAG_OPS_KEYS = ["has", "has_any", "has_all"] as const;
const DATE_OPS_KEYS = ["gte", "lte", "gt", "lt"] as const;

/** Range operators paired with their SQL form, shared by date-typed and
 * scalar-typed comparisons (the latter when the disambiguator routes
 * non-ISO `gte/lte/gt/lt` to the scalar branch). */
const RANGE_OPS = [
	["gte", ">="],
	["lte", "<="],
	["gt", ">"],
	["lt", "<"],
] as const satisfies ReadonlyArray<readonly [(typeof DATE_OPS_KEYS)[number], string]>;

type ScalarKey = (typeof SCALAR_OPS)[number];
type TagKey = (typeof TAG_OPS_KEYS)[number];
type DateKey = (typeof DATE_OPS_KEYS)[number];

/**
 * Compile a `Filter` into a parameterized SQL fragment + filterHash.
 * Returns `null` if the filter is empty (no operator clauses anywhere).
 */
export function compileFilter(filter: Filter | undefined): CompiledFilter | null {
	if (filter === undefined || filter === null) return null;
	if (!hasAnyClause(filter)) return null;
	const ctx = new CompileContext();
	const where = ctx.compileFilter(filter, "filters");
	return {
		whereSql: where,
		params: ctx.params,
		filterHash: hashFilter(filter),
	};
}

/**
 * SHA-1 hex of canonical JSON. Public so cursor validation can compare
 * filter hashes without re-running the full compiler.
 */
export function hashFilter(filter: Filter | undefined | null): string {
	if (filter === undefined || filter === null || !hasAnyClause(filter)) return "";
	return createHash("sha1").update(canonicalJson(filter)).digest("hex");
}

/** Combine WHERE-fragment parts with `op`. Empty → vacuous TRUE; one
 * part → unwrapped; many → parenthesized. */
function joinParts(parts: string[], op: "AND" | "OR"): string {
	if (parts.length === 0) return "(1=1)";
	if (parts.length === 1) return parts[0] ?? "(1=1)";
	return `(${parts.join(` ${op} `)})`;
}

class CompileContext {
	readonly params: Record<string, unknown> = {};
	private counter = 0;

	private bind(value: unknown): string {
		const name = `p${this.counter++}`;
		this.params[name] = value;
		return `:${name}`;
	}

	compileFilter(f: Filter, paramPath: string): string {
		const parts: string[] = [];
		if (f.tags) parts.push(this.compileTagOps(f.tags, `${paramPath}.tags`));
		if (f.date) parts.push(this.compileDateOps(f.date, RESERVED_DATE_EXPR, `${paramPath}.date`));
		if (f.fields) {
			for (const [name, ops] of Object.entries(f.fields)) {
				parts.push(this.compileFieldOps(name, ops, `${paramPath}.fields["${name}"]`));
			}
		}
		if (f.and) parts.push(this.compileGroup(f.and, "AND", `${paramPath}.and`));
		if (f.or) parts.push(this.compileGroup(f.or, "OR", `${paramPath}.or`));
		if (f.not) parts.push(`NOT (${this.compileFilter(f.not, `${paramPath}.not`)})`);
		return joinParts(parts, "AND");
	}

	private compileGroup(branches: Filter[], op: "AND" | "OR", paramPath: string): string {
		if (branches.length === 0) {
			// `and: []` → vacuously TRUE; `or: []` → vacuously FALSE.
			return op === "AND" ? "(1=1)" : "(1=0)";
		}
		const parts = branches.map((b, i) => this.compileFilter(b, `${paramPath}[${i}]`));
		return `(${parts.join(` ${op} `)})`;
	}

	/**
	 * Reserved-tag operator. Resolves to the `frontmatter_tags` side-table
	 * with D30 prefix-match SQL (`tag = :v OR tag LIKE :prefix ESCAPE '\'`).
	 */
	private compileTagOps(ops: TagOps, paramPath: string): string {
		return this.compileTagOpsCommon(ops, paramPath, (tag, p) => this.reservedTagPredicate(tag, p));
	}

	private reservedTagPredicate(tag: unknown, paramPath: string): string {
		if (typeof tag !== "string" || !TAG_LITERAL_RE.test(tag)) {
			throw new FilterSyntaxError({
				param: paramPath,
				expected: "tag literal matching [a-zA-Z0-9_/-]+",
				suggest: ["Tags are lowercased and slash-separated, e.g., 'api/v1'."],
			});
		}
		const normalized = tag.toLowerCase();
		const tagParam = this.bind(normalized);
		const prefixParam = this.bind(`${escapeLike(normalized)}/%`);
		return `EXISTS (SELECT 1 FROM frontmatter_tags ft WHERE ft.file = f.file AND (ft.tag = ${tagParam} OR ft.tag LIKE ${prefixParam} ESCAPE '\\'))`;
	}

	/**
	 * Common skeleton for `has` / `has_any` / `has_all` over a tag-like
	 * collection. Predicate emits the per-tag SQL fragment (reserved
	 * vs custom-field semantics differ; both share this loop structure).
	 */
	private compileTagOpsCommon(
		ops: TagOps,
		paramPath: string,
		predicate: (tag: unknown, paramPath: string) => string,
	): string {
		const parts: string[] = [];
		if (ops.has !== undefined) {
			parts.push(predicate(ops.has, `${paramPath}.has`));
		}
		if (ops.has_any !== undefined) {
			if (ops.has_any.length === 0) parts.push("(1=0)");
			else {
				const inner = ops.has_any.map((t, i) => predicate(t, `${paramPath}.has_any[${i}]`));
				parts.push(`(${inner.join(" OR ")})`);
			}
		}
		if (ops.has_all !== undefined) {
			if (ops.has_all.length === 0) parts.push("(1=1)");
			else {
				const inner = ops.has_all.map((t, i) => predicate(t, `${paramPath}.has_all[${i}]`));
				parts.push(`(${inner.join(" AND ")})`);
			}
		}
		return joinParts(parts, "AND");
	}

	private compileDateOps(ops: DateOps, expr: string, paramPath: string): string {
		const parts: string[] = [];
		for (const [opKey, sqlOp] of RANGE_OPS) {
			const v = ops[opKey];
			if (v === undefined) continue;
			if (typeof v !== "string") {
				throw new FilterSyntaxError({
					param: `${paramPath}.${opKey}`,
					expected: "ISO 8601 date string",
				});
			}
			const normalized = normalizeDateBound(v, opKey);
			if (normalized === null) {
				throw new FilterSyntaxError({
					param: `${paramPath}.${opKey}`,
					expected: "ISO 8601 date string",
				});
			}
			parts.push(`${expr} ${sqlOp} ${this.bind(normalized)}`);
		}
		return joinParts(parts, "AND");
	}

	private compileFieldOps(name: string, ops: FieldOps, paramPath: string): string {
		const present = collectPresentOps(ops);
		const categories = categorizeFieldOps(present, ops, paramPath);
		if (categories.size > 1) {
			throw new FilterSyntaxError({
				param: paramPath,
				expected: "single category (tag-ops OR date-ops OR scalar-ops)",
				message: `Field "${name}" mixes operator categories: ${[...categories].join(", ")}.`,
				suggest: [
					"Split into nested filters: { and: [ { fields: { x: { has: 'a' } } }, { fields: { x: { contains: 'b' } } } ] }",
				],
			});
		}
		const segments = parseDottedPath(name, paramPath);
		const jsonPath = renderJsonPath(segments);
		const pathLiteral = this.bindRaw(jsonPath);
		const expr = `json_extract(fm.fields_json, ${pathLiteral})`;
		// Two-arg form: `json_extract` returns SQL TEXT (bare `foo`, not
		// `"foo"`), so `json_type(json_extract(...))` would re-parse and
		// crash on scalar values — same failure mode as `json_each`.
		const typeExpr = `json_type(fm.fields_json, ${pathLiteral})`;
		const cat = [...categories][0] ?? "scalar";
		switch (cat) {
			case "tag":
				return this.compileFieldTagOps(ops as TagOps, expr, typeExpr, paramPath);
			case "date":
				// Mirrors RESERVED_DATE_EXPR's UDF gate so non-canonical stored
				// values become NULL → comparison UNKNOWN → row filtered out.
				return this.compileDateOps(ops as DateOps, `iso_calendar_valid(${expr})`, paramPath);
			case "scalar":
				return this.compileScalarOps(ops as ScalarOps & Partial<DateOps>, expr, typeExpr, paramPath);
		}
	}

	/**
	 * `fields[name]: TagOps` — exact-equality membership via `json_each`
	 * on the path value. Hierarchy prefix-match is reserved for the
	 * top-level `tags` operator only.
	 */
	private compileFieldTagOps(ops: TagOps, expr: string, typeExpr: string, paramPath: string): string {
		return this.compileTagOpsCommon(ops, paramPath, (tag, p) => this.fieldTagPredicate(tag, expr, typeExpr, p));
	}

	private fieldTagPredicate(tag: unknown, expr: string, typeExpr: string, paramPath: string): string {
		if (typeof tag !== "string") {
			throw new FilterSyntaxError({ param: paramPath, expected: "string tag value" });
		}
		const param = this.bind(tag);
		// YAML allows scalar OR sequence for tag-like fields (`aliases: foo`
		// vs `aliases: [foo, bar]`). `json_each` rejects scalar input with
		// "malformed JSON", so dispatch on `json_type`: arrays iterate as-is;
		// scalars wrap into a single-element array; objects and SQL NULL
		// become an empty array (no match without an error).
		const iter = `CASE ${typeExpr} WHEN 'array' THEN ${expr} WHEN 'object' THEN json_array() WHEN 'null' THEN json_array() ELSE json_array(${expr}) END`;
		return `EXISTS (SELECT 1 FROM json_each(${iter}) WHERE value = ${param})`;
	}

	private compileScalarOps(
		ops: ScalarOps & Partial<DateOps>,
		expr: string,
		typeExpr: string,
		paramPath: string,
	): string {
		const parts: string[] = [];
		// SQL three-valued logic: `expr = NULL` is never true, so explicit
		// `null` arguments must compile to `IS NULL` / `IS NOT NULL`.
		if (ops.eq !== undefined) {
			if (ops.eq === null) parts.push(`${expr} IS NULL`);
			else parts.push(`${expr} = ${this.bindScalar(ops.eq)}`);
		}
		if (ops.ne !== undefined) {
			if (ops.ne === null) parts.push(`${expr} IS NOT NULL`);
			else parts.push(`${expr} != ${this.bindScalar(ops.ne)}`);
		}
		if (ops.in !== undefined) {
			if (!Array.isArray(ops.in)) {
				throw new FilterSyntaxError({ param: `${paramPath}.in`, expected: "array of scalar values" });
			}
			parts.push(this.compileMembership(expr, ops.in, "in"));
		}
		if (ops.nin !== undefined) {
			if (!Array.isArray(ops.nin)) {
				throw new FilterSyntaxError({ param: `${paramPath}.nin`, expected: "array of scalar values" });
			}
			parts.push(this.compileMembership(expr, ops.nin, "nin"));
		}
		if (ops.contains !== undefined) {
			if (typeof ops.contains !== "string") {
				throw new FilterSyntaxError({ param: `${paramPath}.contains`, expected: "string" });
			}
			const escaped = escapeLike(ops.contains.toLowerCase());
			const param = this.bind(`%${escaped}%`);
			parts.push(`LOWER(${expr}) LIKE ${param} ESCAPE '\\'`);
		}
		if (ops.is_empty !== undefined) {
			if (typeof ops.is_empty !== "boolean") {
				throw new FilterSyntaxError({ param: `${paramPath}.is_empty`, expected: "boolean" });
			}
			if (ops.is_empty) parts.push(`(${expr} IS NULL OR ${expr} = '')`);
			else parts.push(`(${expr} IS NOT NULL AND ${expr} != '')`);
		}
		for (const [opKey, sqlOp] of RANGE_OPS) {
			const v = ops[opKey];
			if (v === undefined) continue;
			const param = this.bindScalar(v);
			if (typeof v === "number" || typeof v === "bigint") {
				// SQLite's class ordering puts TEXT > INTEGER, so a numeric
				// range like `priority.gte: 5` would lex-pass against
				// `priority: "low"` without a type guard.
				parts.push(`(${typeExpr} IN ('integer','real') AND ${expr} ${sqlOp} ${param})`);
			} else {
				parts.push(`${expr} ${sqlOp} ${param}`);
			}
		}
		return joinParts(parts, "AND");
	}

	/**
	 * `in` / `nin` membership over a list that may contain `null`. SQL
	 * three-valued logic makes `expr = NULL` always UNKNOWN, so binding
	 * `null` directly into an `IN`/`NOT IN` clause matches nothing for
	 * `in` and excludes every row for `nin` — opposite of intent. Partition
	 * `null` out and emit `IS NULL` / `IS NOT NULL` clauses alongside the
	 * non-null `IN`/`NOT IN`.
	 *
	 * Truth table:
	 *   in: []           → (1=0)
	 *   in: [null]       → expr IS NULL
	 *   in: [a,b]        → expr IN (:a, :b)
	 *   in: [a,null]     → (expr IS NULL OR expr IN (:a))
	 *   nin: []          → (1=1)
	 *   nin: [null]      → expr IS NOT NULL
	 *   nin: [a,b]       → (expr IS NULL OR expr NOT IN (:a, :b))
	 *   nin: [a,null]    → (expr IS NOT NULL AND expr NOT IN (:a))
	 */
	private compileMembership(expr: string, values: ReadonlyArray<unknown>, op: "in" | "nin"): string {
		if (values.length === 0) return op === "in" ? "(1=0)" : "(1=1)";
		const nonNull = values.filter((v) => v !== null);
		const hasNull = nonNull.length < values.length;
		if (op === "in") {
			if (nonNull.length === 0) return `${expr} IS NULL`;
			const placeholders = nonNull.map((v) => this.bindScalar(v));
			const inClause = `${expr} IN (${placeholders.join(", ")})`;
			return hasNull ? `(${expr} IS NULL OR ${inClause})` : inClause;
		}
		if (nonNull.length === 0) return `${expr} IS NOT NULL`;
		const placeholders = nonNull.map((v) => this.bindScalar(v));
		const ninClause = `${expr} NOT IN (${placeholders.join(", ")})`;
		return hasNull ? `(${expr} IS NOT NULL AND ${ninClause})` : `(${expr} IS NULL OR ${ninClause})`;
	}

	private bindScalar(value: unknown): string {
		// SQLite accepts string/number/bigint/Buffer/null. Booleans → 0/1.
		// JSON values that round-trip from frontmatter (objects, arrays)
		// are not comparable with SQL `=`; reject early so the user gets
		// a domain error not an opaque SQLite error.
		if (value === null) return this.bind(null);
		const t = typeof value;
		if (t === "string") {
			// Mirror scanner's index-time canonicalization: ISO-shaped string
			// operands canonicalize to UTC ISO so `fields.due.eq: "2024-06-01"`
			// lex-matches a stored canonical "2024-06-01T00:00:00Z" (whether
			// YAML parsed the value as Date or string). Date-typed range ops
			// already canonicalize via compileDateOps; this covers scalar
			// eq/ne/in/nin and scalar-routed gte/lte/gt/lt.
			const canonical = canonicalizeIsoLikeScalar(value as string);
			if (canonical !== null) return this.bind(canonical);
			return this.bind(value);
		}
		if (t === "number" || t === "bigint") return this.bind(value);
		if (t === "boolean") return this.bind(value ? 1 : 0);
		throw new FilterSyntaxError({
			param: "scalar value",
			expected: "string | number | boolean | null",
			message: `Unsupported scalar value type: ${t}`,
		});
	}

	/**
	 * Bind a literal SQL string (NOT a value parameter) — used for the
	 * JSON-path argument to `json_extract`, which is itself a string
	 * literal but kept out of named-param binding to avoid the SQLite
	 * parser quirk where bound JSON-path values aren't compile-time
	 * inspectable for the SQLITE_DETERMINISTIC pragma path.
	 *
	 * The path string is built from validated segments (printable
	 * Unicode + escaped `"`) so direct interpolation is safe.
	 */
	private bindRaw(path: string): string {
		return `'${path.replace(/'/g, "''")}'`;
	}
}

/**
 * Escape a SQL LIKE pattern literal: `%`, `_`, and `\` are doubled with
 * a leading `\`. Caller MUST issue the LIKE with `ESCAPE '\'` so SQLite
 * interprets `\%` as a literal `%`. Without escaping, a tag like
 * `api_v1` would match `apixv1` (the `_` wildcards a single char).
 */
export function escapeLike(s: string): string {
	return s.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

/**
 * Escape a SQL GLOB pattern literal. SQLite GLOB has no backslash escape
 * — literal `*`, `?`, and `[` must be wrapped in a character class `[…]`.
 * GLOB is byte-wise (case-sensitive) by default, so this is the
 * correctness fix for path-prefix scopes that LIKE silently widens on
 * ASCII case.
 */
export function globEscape(s: string): string {
	return s.replace(/[*?[]/g, (c) => `[${c}]`);
}

/**
 * Canonical UTC ISO emit shared between the scanner's index-time
 * normalization and the filter's query-time bound normalization. Both
 * sides MUST agree on this format byte-for-byte so lex-compares match.
 * Format: `YYYY-MM-DDTHH:MM:SSZ` (no fractional seconds).
 */
export function toCanonicalUtcIso(d: Date): string {
	return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/**
 * Append `Z` if no timezone designator is present, so `Date.parse` reads
 * timezone-less datetimes as UTC instead of local. Per ECMAScript spec
 * §21.4.3.2: date-only forms are interpreted as UTC, but datetime forms
 * (with `T` or space separator + time) WITHOUT an offset are interpreted
 * as local time. Without this normalization, the same input on
 * `Etc/UTC` and `America/New_York` would shift the result by hours.
 *
 * Must be called BEFORE `Date.parse`. Date-only inputs (`YYYY-MM-DD`)
 * already parse as UTC and are handled separately by `normalizeDateBound`
 * via the `T00:00:00Z` / `T23:59:59Z` suffix; this helper covers the
 * datetime fallthrough in both filter and scanner.
 */
export function ensureUtcOffset(s: string): string {
	return /[Zz]|[+-]\d{2}:?\d{2}$/.test(s) ? s : `${s}Z`;
}

/**
 * Normalize a date-filter bound for lex-compare against indexed dates.
 *
 * Index-side, the scanner stores frontmatter dates as canonical UTC ISO.
 * Filter-side, users commonly pass date-only strings (`"2024-06-01"`)
 * which lex-compare wrong against those: `"2024-06-01T00:00:00Z" <=
 * "2024-06-01"` is FALSE because the shorter string is "less". Op-aware
 * day-start/day-end suffixes fix it:
 *
 *   - `gte` / `lt` → `T00:00:00Z` (start of day; gte inclusive, lt exclusive)
 *   - `lte` / `gt` → `T23:59:59Z` (end of day; lte inclusive, gt exclusive)
 *
 * Non-date-only inputs are parsed and re-emitted via {@link toCanonicalUtcIso}.
 * Inputs that don't parse to a real date return `null` so the caller
 * can throw `FILTER_SYNTAX_ERROR` rather than bind raw user input that
 * produces silent zero-row queries.
 */
export function normalizeDateBound(v: string, op: DateKey): string | null {
	const trimmed = v.trim();
	if (isCalendarDate(trimmed)) {
		const suffix = op === "gte" || op === "lt" ? "T00:00:00Z" : "T23:59:59Z";
		return `${trimmed}${suffix}`;
	}
	return parseIsoDatetimeToCanonical(trimmed);
}

/**
 * Canonicalize a scalar string operand if it matches `ISO_LIKELY_RE`.
 * Returns `null` when the input doesn't look ISO or doesn't parse — the
 * caller binds raw in that case (e.g., a non-date string like `"hello"`,
 * or an ISO-shaped but calendar-invalid `"2024-13-99"`).
 *
 * Mirrors what {@link parseIsoDatetimeToCanonical} + the date-only branch
 * of {@link normalizeDateBound} produce, but with `T00:00:00Z` (start of
 * day) for date-only input — scalar `eq` against canonical-stored values
 * needs exact lex equality, and start-of-day matches what the scanner
 * stores for YAML date-only frontmatter.
 */
function canonicalizeIsoLikeScalar(value: string): string | null {
	const trimmed = value.trim();
	if (!ISO_LIKELY_RE.test(trimmed)) return null;
	if (isCalendarDate(trimmed)) return `${trimmed}T00:00:00Z`;
	return parseIsoDatetimeToCanonical(trimmed);
}

/**
 * Strict ISO 8601 datetime → canonical UTC ISO. Returns `null` for
 * non-ISO shapes, calendar-invalid date prefixes, or unparseable
 * components. `Date.parse` is too lenient on its own (accepts `"1"`,
 * silently rolls Feb 31 → Mar 2); pre-gating with `ISO_LIKELY_RE` and
 * `isCalendarDate` keeps both query-time bounds and index-time stored
 * values honest.
 */
export function parseIsoDatetimeToCanonical(trimmed: string): string | null {
	if (!ISO_LIKELY_RE.test(trimmed)) return null;
	if (!isCalendarDate(trimmed.slice(0, 10))) return null;
	const ms = Date.parse(ensureUtcOffset(trimmed));
	if (Number.isNaN(ms)) return null;
	return toCanonicalUtcIso(new Date(ms));
}

export function isCalendarDate(yyyymmdd: string): boolean {
	const m = yyyymmdd.match(/^(\d{4})-(\d{2})-(\d{2})$/);
	if (!m) return false;
	const y = Number(m[1]);
	const mo = Number(m[2]);
	const d = Number(m[3]);
	const dt = new Date(Date.UTC(y, mo - 1, d));
	return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

/** Strict canonical UTC ISO match: 20 chars, exact `YYYY-MM-DDTHH:MM:SSZ`,
 * AND calendar-valid date AND H/M/S in valid bounds. Used by the
 * `iso_calendar_valid` UDF (registered in `sqlite.ts`) to gate the
 * reserved-`date` COALESCE chain — raw frontmatter typos that share the
 * canonical shape but fail this check fall through to `updated`/mtime
 * instead of being lex-compared as bogus dates. Mirrors what
 * {@link toCanonicalUtcIso} emits so accept = emit. */
const CANONICAL_UTC_ISO_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})Z$/;

export function isCanonicalUtcIso(s: string): boolean {
	const m = CANONICAL_UTC_ISO_RE.exec(s);
	if (m === null) return false;
	const hi = Number(m[4]);
	const mi = Number(m[5]);
	const si = Number(m[6]);
	if (hi > 23 || mi > 59 || si > 59) return false;
	return isCalendarDate(s.slice(0, 10));
}

/**
 * Split a `fields[name]` key into JSON-path segments. Un-escaped `.`
 * separates segments; `\\.` is a literal dot inside one segment. Each
 * segment validated against {@link SEGMENT_RE}. Empty segments throw.
 */
export function parseDottedPath(name: string, paramPath: string): string[] {
	if (typeof name !== "string" || name.length === 0) {
		throw new FilterSyntaxError({
			param: paramPath,
			expected: "non-empty field name",
		});
	}
	const segments: string[] = [];
	let current = "";
	let i = 0;
	while (i < name.length) {
		const c = name.charAt(i);
		if (c === "\\" && name.charAt(i + 1) === ".") {
			current += ".";
			i += 2;
			continue;
		}
		if (c === ".") {
			if (current.length === 0) {
				throw new FilterSyntaxError({
					param: paramPath,
					expected: "non-empty path segment",
					message: `Empty segment in dotted-path: "${name}"`,
				});
			}
			validateSegment(current, name, paramPath);
			segments.push(current);
			current = "";
			i++;
			continue;
		}
		current += c;
		i++;
	}
	if (current.length === 0) {
		throw new FilterSyntaxError({
			param: paramPath,
			expected: "non-empty trailing path segment",
			message: `Trailing empty segment in dotted-path: "${name}"`,
		});
	}
	validateSegment(current, name, paramPath);
	segments.push(current);
	return segments;
}

function validateSegment(segment: string, fullName: string, paramPath: string): void {
	if (!SEGMENT_RE.test(segment)) {
		throw new FilterSyntaxError({
			param: paramPath,
			expected: "printable Unicode segment (≤256 chars, no control bytes)",
			message: `Invalid path segment in "${fullName}": ${JSON.stringify(segment)}`,
		});
	}
}

/**
 * Render a JSON-path string from validated segments. Each segment
 * quoted; embedded `"` and `\` backslash-escaped per SQLite JSON1
 * quoting rules.
 */
export function renderJsonPath(segments: string[]): string {
	let out = "$";
	for (const seg of segments) {
		const escaped = seg.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
		out += `."${escaped}"`;
	}
	return out;
}

// ─── Category disambiguation ──────────────────────────────────────────────

interface PresentOps {
	scalar: ScalarKey[];
	tag: TagKey[];
	date: DateKey[];
}

function collectPresentOps(ops: FieldOps): PresentOps {
	const scalar: ScalarKey[] = [];
	const tag: TagKey[] = [];
	const date: DateKey[] = [];
	const opsRecord = ops as Record<string, unknown>;
	for (const k of SCALAR_OPS) if (opsRecord[k] !== undefined) scalar.push(k);
	for (const k of TAG_OPS_KEYS) if (opsRecord[k] !== undefined) tag.push(k);
	for (const k of DATE_OPS_KEYS) if (opsRecord[k] !== undefined) date.push(k);
	return { scalar, tag, date };
}

/**
 * Apply D12 Note disambiguation rules. Returns the set of categories
 * present; caller throws on size > 1.
 */
function categorizeFieldOps(present: PresentOps, ops: FieldOps, paramPath: string): Set<"scalar" | "tag" | "date"> {
	const cats = new Set<"scalar" | "tag" | "date">();
	if (present.tag.length > 0) cats.add("tag");
	if (present.date.length > 0) {
		// Date keys (gte/lte/gt/lt) shadow with scalar comparisons. D12 Note
		// resolves the ambiguity by ISO-string content: if every date-op
		// value parses as ISO, the field is date-typed; otherwise the keys
		// are scalar comparisons (e.g., numeric range on a `priority` field).
		const dateOps = ops as DateOps;
		const allIso = present.date.every((k) => {
			const v = dateOps[k];
			return typeof v === "string" && ISO_LIKELY_RE.test(v);
		});
		cats.add(allIso ? "date" : "scalar");
	}
	if (present.scalar.length > 0) cats.add("scalar");
	if (cats.size === 0) {
		throw new FilterSyntaxError({
			param: paramPath,
			expected: "at least one operator key",
			message: `Field operator object has no recognized keys at ${paramPath}.`,
		});
	}
	return cats;
}

// ─── Empty-filter detection ───────────────────────────────────────────────

function hasAnyClause(f: Filter): boolean {
	if (f.tags && hasObjectKeys(f.tags)) return true;
	if (f.date && hasObjectKeys(f.date)) return true;
	if (f.fields && hasObjectKeys(f.fields)) return true;
	if (f.and && f.and.length > 0) return true;
	// Empty `or: []` is vacuously FALSE; must compile to `(1=0)` rather
	// than be dropped. Empty `and: []` stays asymmetric at the top level
	// — vacuously TRUE `(1=1)` is observably equivalent to "no clause."
	// `not` is always a clause: vacuously-TRUE inverts to FALSE inside
	// it (`NOT (1=1)` matches no rows), so a present `not` cannot be
	// elided regardless of its child's emptiness.
	if (f.or !== undefined) return true;
	if (f.not) return true;
	return false;
}

function hasObjectKeys(o: object): boolean {
	for (const k in o) {
		if (Object.hasOwn(o, k)) return true;
	}
	return false;
}

// ─── Canonical JSON for filterHash ────────────────────────────────────────

/**
 * SHA-1-stable JSON serialization with recursively sorted object keys
 * (arrays preserve source order). Internal helper for {@link hashFilter}.
 * Other request-shaping hashes (e.g. `search` cursor `request_hash`) use
 * fixed-arity NUL-separated concatenation instead — cheaper for known
 * leaf-only shapes.
 */
function canonicalJson(value: unknown): string {
	if (value === undefined) return "null";
	if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
	if (Array.isArray(value)) {
		return `[${value.map((v) => canonicalJson(v)).join(",")}]`;
	}
	const obj = value as Record<string, unknown>;
	const keys = Object.keys(obj).sort();
	const parts = keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`);
	return `{${parts.join(",")}}`;
}
