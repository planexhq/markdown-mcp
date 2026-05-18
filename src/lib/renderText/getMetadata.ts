/**
 * Prose renderer for `get_metadata`. Round-trips parsed frontmatter
 * through `yaml.stringify`; status header and `_meta` footer are
 * `# `-prefixed so the whole `content[0].text` reparses as YAML.
 */

import { stringify as yamlStringify } from "yaml";

import type { GetMetadataResult, MetaEnvelope } from "../../types.js";
import { formatMeta, joinLines } from "./_shared.js";

// yaml.stringify's trailing `\n` doubles as the `|+` block scalar's last
// value newline (not a separable doc terminator). `.trimEnd()` stripped
// all trailing whitespace — flattening `field: "foo\n\n\n"` to `"foo"`
// and eating the `|+` marker. Peeling exactly one preserves the marker
// and the N-1 inner newlines; JSON `structuredContent.metadata` carries
// the verbatim value for agents needing exact round-trip.
const TRAILING_NEWLINE_RE = /\n$/;

// yaml.stringify emits U+0085 (NEL), U+2028 (LS), U+2029 (PS) LITERALLY
// in every scalar style (plain, double-quoted, JSON-shaped) because
// Node's JSON.stringify — which the lib's doubleQuotedString uses as a
// base — doesn't escape any of the three. Many chat/terminal UIs render
// them as line breaks; a frontmatter value `title: "x<U+2028>next:
// forged"` would otherwise forge a dedicated `next:` line in
// `content[0].text`. A `\xHH` / `\uHHHH` escape would be ACTIVE in
// double-quoted scalars (`\x85` IS the YAML 1.2 escape for U+0085 —
// round-trips back to the hostile char). Angle-bracket markers carry
// no YAML semantics in any style, are reversible by pattern match, and
// preserve distinct codepoints so `key<U+0085>A` and `key<U+2028>A`
// stay separate keys (load-bearing under `--prose-only`, where the
// structured channel is dropped and the strip-walker's
// `out[safeYamlString(k)] = …` would overwrite collided keys).
//
// Injectivity: a literal `<U+…>` substring in the input must not
// collide with the substituted marker for the corresponding codepoint.
// Pre-escape `<U+` → `\<U+` (`\<` is YAML-inert in both plain and
// double-quoted styles, so it survives `yaml.stringify` verbatim).
// Decoders reverse the two passes IN ORDER: strip the `\` escape
// FIRST, then map remaining `<U+HHHH>` back to codepoints.
//
// Split test vs. replace forms mirror `sanitizePathForProse` — a `/g`
// regex's `lastIndex` is stateful across `.test()` calls, so reusing
// one form for both would let a later `test` start scanning past a
// leading hostile char and miss it.
const YAML_LINE_BREAK_CHARS = ["\u0085", "\u2028", "\u2029"] as const;
const YAML_LINE_BREAK_CLASS = YAML_LINE_BREAK_CHARS.join("");
const YAML_LINE_BREAK_TEST_RE = new RegExp(`[${YAML_LINE_BREAK_CLASS}]`);
const YAML_LINE_BREAK_REPLACE_RE = new RegExp(`[${YAML_LINE_BREAK_CLASS}]`, "g");
const YAML_MARKER_PREFIX = "<U+";
const YAML_MARKER_PREFIX_ESCAPE = `\\${YAML_MARKER_PREFIX}`;
const YAML_LINE_BREAK_MARKERS: Record<string, string> = Object.fromEntries(
	YAML_LINE_BREAK_CHARS.map((c) => [
		c,
		`${YAML_MARKER_PREFIX}${c.charCodeAt(0).toString(16).toUpperCase().padStart(4, "0")}>`,
	]),
);

function safeYamlString(s: string): string {
	const hasMarker = s.includes(YAML_MARKER_PREFIX);
	const hasHostile = YAML_LINE_BREAK_TEST_RE.test(s);
	if (!hasMarker && !hasHostile) return s;
	let out = s;
	if (hasMarker) out = out.replaceAll(YAML_MARKER_PREFIX, YAML_MARKER_PREFIX_ESCAPE);
	if (hasHostile) out = out.replace(YAML_LINE_BREAK_REPLACE_RE, (c) => YAML_LINE_BREAK_MARKERS[c] ?? c);
	return out;
}

function stripYamlHostileChars(v: unknown): unknown {
	if (typeof v === "string") return safeYamlString(v);
	if (Array.isArray(v)) return v.map(stripYamlHostileChars);
	// Recurse only into plain objects (Object.prototype or null-proto from
	// `normalizeForJson`). Tagged scalars like Date pass through unchanged
	// — `Object.entries(new Date())` is `[]`, so a blanket recurse would
	// flatten them to `{}` and yaml.stringify would emit `due: {}` instead
	// of the ISO string. Output uses null-proto so a user `__proto__:`
	// frontmatter key (preserved as own by `normalizeForJson`) stays own
	// instead of triggering the legacy `__proto__` setter.
	if (v !== null && typeof v === "object") {
		const proto = Object.getPrototypeOf(v);
		if (proto === Object.prototype || proto === null) {
			const out = Object.create(null) as Record<string, unknown>;
			for (const [k, val] of Object.entries(v as object)) {
				out[safeYamlString(k)] = stripYamlHostileChars(val);
			}
			return out;
		}
	}
	return v;
}

export function renderMetadata(sc: GetMetadataResult, meta: MetaEnvelope): string {
	const header = sc.has_frontmatter ? "# metadata · has frontmatter" : "# metadata · no frontmatter";

	const sections: Array<string | null> = [header];
	let yaml: string | null = null;
	if (sc.has_frontmatter && Object.keys(sc.metadata).length > 0) {
		yaml = yamlStringify(stripYamlHostileChars(sc.metadata), { lineWidth: 0 }).replace(TRAILING_NEWLINE_RE, "");
		sections.push("", yaml);
	}
	const metaLine = formatMeta(meta);
	if (metaLine) {
		// `#` prefix so an agent reparsing `content[0].text` as YAML (the
		// design intent — see module doc) treats the footer as a comment,
		// not a synthetic top-level `meta:` key. Without the prefix, the
		// footer parses as `{..., meta: "state=warming files=3 · ..."}` and
		// a real user-defined `meta:` frontmatter field collides with it.
		//
		// When the preceding yaml body ends with `\n` (a `|+` block scalar
		// with preserved trailing newlines after the single-strip), the
		// scalar's reparse semantics absorb any blank line BEFORE the
		// terminator into the value's trailing-newline encoding. A `""`
		// separator here would push that blank line and inflate
		// round-tripped values (`"foo\n\n"` → `"foo\n\n\n"`). Skip the
		// separator in that case; yaml's surviving `\n` plus joinLines's
		// `\n` already provide the visual blank line.
		if (!yaml?.endsWith("\n")) sections.push("");
		sections.push(`# ${metaLine}`);
	}

	return joinLines(sections);
}
