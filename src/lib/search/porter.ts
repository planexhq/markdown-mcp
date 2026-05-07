/**
 * Porter (1980) stemmer — used by `bm25-fragment-v1` to align body
 * tokens with FTS5's porter-tokenizer term identity for highlight
 * matching.
 *
 * Approximates the original Porter algorithm
 * (https://tartarus.org/martin/PorterStemmer/) with the five canonical
 * passes (1a, 1b, 1c, 2, 3, 4, 5a, 5b). Imperfect parity is acceptable
 * — misses degrade highlight quality only, never correctness.
 *
 * Private to the snippet algorithm; not exported through the package
 * public surface (D11 keeps the dependency footprint small — adopting
 * `natural` or `gpt-tokenizer` would pull megabytes of unused models).
 */

const STEP_2: ReadonlyArray<readonly [string, string]> = [
	["ational", "ate"],
	["tional", "tion"],
	["enci", "ence"],
	["anci", "ance"],
	["izer", "ize"],
	["bli", "ble"],
	["alli", "al"],
	["entli", "ent"],
	["eli", "e"],
	["ousli", "ous"],
	["ization", "ize"],
	["ation", "ate"],
	["ator", "ate"],
	["alism", "al"],
	["iveness", "ive"],
	["fulness", "ful"],
	["ousness", "ous"],
	["aliti", "al"],
	["iviti", "ive"],
	["biliti", "ble"],
	["logi", "log"],
];

const STEP_3: ReadonlyArray<readonly [string, string]> = [
	["icate", "ic"],
	["ative", ""],
	["alize", "al"],
	["iciti", "ic"],
	["ical", "ic"],
	["ful", ""],
	["ness", ""],
];

const STEP_4: ReadonlyArray<string> = [
	"al",
	"ance",
	"ence",
	"er",
	"ic",
	"able",
	"ible",
	"ant",
	"ement",
	"ment",
	"ent",
	"ou",
	"ism",
	"ate",
	"iti",
	"ous",
	"ive",
	"ize",
];

// Regexes encode Porter's measure (m) computation. `c` = consonant,
// `v` = vowel, `C` = consonant run, `V` = vowel run.
const C = "[^aeiouy]+";
const V = "[aeiouy]+";
const MGR0 = new RegExp(`(${C})?${V}${C}`);
const MEQ1 = new RegExp(`^(${C})?${V}${C}(${V})?$`);
const MGR1 = new RegExp(`^(${C})?${V}${C}${V}${C}`);
const HAS_VOWEL = new RegExp(`(${C})?[aeiouy]`);
const CVC = /[^aeiouy][aeiouy][^aeiouwxy]$/;

/**
 * Stem a single word via the Porter (1980) algorithm. Input is
 * lowercased before processing; non-letter inputs return as-is.
 */
export function porterStem(word: string): string {
	if (word.length < 3) return word.toLowerCase();
	let w = word.toLowerCase();

	// Pre-step: capitalize `y` where it acts as a consonant. Per Porter's
	// definition, `y` is a consonant when preceded by a vowel (or at word
	// start), and a vowel when preceded by a consonant. Capitalizing the
	// consonant-y lets the [^aeiouy] regex classes correctly skip it.
	// Lowercase Y is restored before returning.
	if (w.charAt(0) === "y") w = `Y${w.slice(1)}`;
	for (let i = 1; i < w.length; i++) {
		if (w.charAt(i) === "y" && "aeiou".includes(w.charAt(i - 1))) {
			w = `${w.slice(0, i)}Y${w.slice(i + 1)}`;
		}
	}

	// Step 1a
	if (w.endsWith("sses")) w = `${w.slice(0, -4)}ss`;
	else if (w.endsWith("ies")) w = `${w.slice(0, -3)}i`;
	else if (w.endsWith("ss")) {
		// keep
	} else if (w.endsWith("s")) w = w.slice(0, -1);

	// Step 1b
	let step1bDidSomething = false;
	if (w.endsWith("eed")) {
		const stem = w.slice(0, -3);
		if (MGR0.test(stem)) w = `${stem}ee`;
	} else if (w.endsWith("ed")) {
		const stem = w.slice(0, -2);
		if (HAS_VOWEL.test(stem)) {
			w = stem;
			step1bDidSomething = true;
		}
	} else if (w.endsWith("ing")) {
		const stem = w.slice(0, -3);
		if (HAS_VOWEL.test(stem)) {
			w = stem;
			step1bDidSomething = true;
		}
	}
	if (step1bDidSomething) {
		if (w.endsWith("at") || w.endsWith("bl") || w.endsWith("iz")) {
			w += "e";
		} else if (endsWithDoubleConsonantNotLSZ(w)) {
			w = w.slice(0, -1);
		} else if (MEQ1.test(w) && CVC.test(w)) {
			w += "e";
		}
	}

	// Step 1c
	if (w.endsWith("y")) {
		const stem = w.slice(0, -1);
		if (HAS_VOWEL.test(stem)) w = `${stem}i`;
	}

	// Step 2
	for (const [suf, repl] of STEP_2) {
		if (w.endsWith(suf)) {
			const stem = w.slice(0, -suf.length);
			if (MGR0.test(stem)) w = stem + repl;
			break;
		}
	}

	// Step 3
	for (const [suf, repl] of STEP_3) {
		if (w.endsWith(suf)) {
			const stem = w.slice(0, -suf.length);
			if (MGR0.test(stem)) w = stem + repl;
			break;
		}
	}

	// Step 4
	for (const suf of STEP_4) {
		if (w.endsWith(suf)) {
			const stem = w.slice(0, -suf.length);
			if (MGR1.test(stem)) w = stem;
			break;
		}
	}
	if (w.endsWith("ion")) {
		const stem = w.slice(0, -3);
		if (MGR1.test(stem) && (stem.endsWith("s") || stem.endsWith("t"))) w = stem;
	}

	// Step 5a
	if (w.endsWith("e")) {
		const stem = w.slice(0, -1);
		if (MGR1.test(stem) || (MEQ1.test(stem) && !CVC.test(stem))) w = stem;
	}

	// Step 5b
	if (w.endsWith("ll") && MGR1.test(w)) w = w.slice(0, -1);

	// Restore lowercase Y → y
	return w.replace(/Y/g, "y");
}

function endsWithDoubleConsonantNotLSZ(s: string): boolean {
	if (s.length < 2) return false;
	const a = s.charAt(s.length - 1);
	const b = s.charAt(s.length - 2);
	if (a !== b) return false;
	if ("aeiou".includes(a)) return false;
	return a !== "l" && a !== "s" && a !== "z";
}
