/**
 * `query-sanitize-v1` — websearch-style FTS5 sanitizer per D23.
 *
 * Preserves `"phrase"` and `prefix*` (3+ word-chars before `*`); force-
 * quotes everything else so `AND`, `body:term`, `2 + 2`, etc. cannot
 * trigger FTS5 syntax. The D23 10-row test corpus locks the contract.
 *
 * `tokens` carries the user-facing word list so downstream highlighters
 * don't have to re-parse `match`. FTS5 quotes are stripped; prefix
 * tokens keep their trailing `*` so the snippet matcher can switch from
 * exact-stem set membership to prefix-stem matching (mirrors FTS5's
 * `"x"*` semantics — body stems whose stem starts with `stem(x)`).
 */

import { MAX_QUERY_LENGTH } from "../limits.js";

export type SanitizeOutcome =
	| { kind: "ok"; match: string; tokens: string[] }
	| { kind: "empty"; reason: "empty" | "all-punctuation" }
	| { kind: "reject"; reason: "too_long" | "control_chars" };

// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control bytes is the point — D23 rejects them in `query`.
const CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
const WORD_CHAR_RE = /[\p{L}\p{N}_]/u;
const WHITESPACE_RE = /\s/;
const PREFIX_CHAR_RE = /[\p{L}\p{N}_-]/u;

export function sanitizeQuery(input: string): SanitizeOutcome {
	if (input.length > MAX_QUERY_LENGTH) return { kind: "reject", reason: "too_long" };
	if (CONTROL_RE.test(input)) return { kind: "reject", reason: "control_chars" };

	const trimmed = input.trim();
	if (trimmed.length === 0) return { kind: "empty", reason: "empty" };

	const fragments: string[] = [];
	const tokens: string[] = [];
	let i = 0;
	const len = trimmed.length;
	let droppedAny = false;

	while (i < len) {
		const ch = trimmed.charAt(i);
		if (WHITESPACE_RE.test(ch)) {
			i++;
			continue;
		}

		if (ch === '"') {
			// `""` inside escapes a literal `"`; unterminated phrase treats EOF as close.
			i++;
			let phrase = "";
			while (i < len) {
				const c = trimmed.charAt(i);
				if (c === '"') {
					if (trimmed.charAt(i + 1) === '"') {
						phrase += '"';
						i += 2;
						continue;
					}
					break;
				}
				phrase += c;
				i++;
			}
			if (i < len && trimmed.charAt(i) === '"') i++;

			if (phrase.length === 0 || !WORD_CHAR_RE.test(phrase)) {
				droppedAny = true;
				continue;
			}
			fragments.push(`"${phrase.replace(/"/g, '""')}"`);
			for (const word of phrase.split(/\s+/)) {
				const stripped = stripWildcards(word);
				if (stripped.length > 0) tokens.push(stripped);
			}
			continue;
		}

		const start = i;
		while (i < len) {
			const c = trimmed.charAt(i);
			if (WHITESPACE_RE.test(c) || c === '"') break;
			i++;
		}
		const tok = trimmed.slice(start, i);
		const emitted = sanitizeFreeToken(tok);
		if (emitted === null) {
			droppedAny = true;
			continue;
		}
		fragments.push(emitted.fragment);
		tokens.push(emitted.token);
	}

	if (fragments.length === 0) {
		return { kind: "empty", reason: droppedAny ? "all-punctuation" : "empty" };
	}
	return { kind: "ok", match: fragments.join(" "), tokens };
}

/**
 * D23 prefix rule (`auth*` → `"auth"*`): the literal `*` must be at the
 * end of an FTS5 token-char run (letters, digits, `_`, `-`) of length
 * ≥3. Mixed-content tokens (`a.b*`) fall through to a quoted literal.
 */
function sanitizeFreeToken(tok: string): { fragment: string; token: string } | null {
	if (tok.length === 0) return null;

	if (tok.endsWith("*") && tok.length >= 4) {
		const prefix = tok.slice(0, -1);
		if (prefix.length >= 3 && isAllPrefixChars(prefix)) {
			// Trailing `*` flags the snippet matcher to do prefix-stem
			// matching — without it, an exact-stem set lookup misses
			// every prefix-extended hit FTS5 returned (e.g. `auth*`
			// matches `authentication` in FTS, but stem("auth")="auth"
			// vs stem("authentication")="authent" don't set-equal).
			return { fragment: `"${prefix}"*`, token: `${prefix}*` };
		}
	}

	if (!WORD_CHAR_RE.test(tok)) return null;
	return { fragment: `"${tok.replace(/"/g, '""')}"`, token: stripWildcards(tok) };
}

/**
 * Strip every `*` from a non-prefix token. Trailing `*` is reserved
 * as the snippet matcher's prefix marker; FTS5's tokenizer also drops
 * `*` from quoted-phrase content, so the token surface — used only
 * for highlighting — must match.
 */
function stripWildcards(s: string): string {
	return s.replace(/\*/g, "");
}

function isAllPrefixChars(s: string): boolean {
	for (let i = 0; i < s.length; i++) {
		if (!PREFIX_CHAR_RE.test(s.charAt(i))) return false;
	}
	return true;
}

export const QUERY_ALGORITHM_ID = "query-sanitize-v1";
