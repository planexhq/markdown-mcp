import { describe, expect, test } from "vitest";

import { chooseStartupState, computePolicyMismatch } from "../../src/lib/startup.js";

describe("chooseStartupState", () => {
	test("preexisted + scan_complete → warm + log mentions count", () => {
		const decision = chooseStartupState({
			preexisted: true,
			scanComplete: true,
			everComplete: true,
			fileCount: 42,
		});
		expect(decision.state).toBe("warm");
		expect(decision.log).toContain("warm (preexisted; 42 files indexed)");
	});

	test("preexisted + !scan_complete + ever_complete + rows → warm + log mentions 'last scan incomplete'", () => {
		// SIGTERM mid-reconcile or a failed-subtree clean reconcile leaves
		// `scan_complete=false` but the prior snapshot is still usable
		// because some earlier scan flipped `ever_complete=true`.
		const decision = chooseStartupState({
			preexisted: true,
			scanComplete: false,
			everComplete: true,
			fileCount: 7,
		});
		expect(decision.state).toBe("warm");
		expect(decision.log).toContain("last scan incomplete");
		expect(decision.log).toContain("7 files indexed");
	});

	test("preexisted + !scan_complete + !ever_complete + rows → cold + log mentions partial first scan", () => {
		// Partial first scan (interrupted before any clean finish) —
		// rows exist but they only cover a subset of the vault.
		// Going warm would silently truncate vault-wide search.
		const decision = chooseStartupState({
			preexisted: true,
			scanComplete: false,
			everComplete: false,
			fileCount: 100,
		});
		expect(decision.state).toBe("cold");
		expect(decision.log).toContain("100 partial rows");
		expect(decision.log).toContain("interrupted first scan");
	});

	test("preexisted + !scan_complete + 0 rows → cold + log mentions 'no indexed rows'", () => {
		const decision = chooseStartupState({
			preexisted: true,
			scanComplete: false,
			everComplete: false,
			fileCount: 0,
		});
		expect(decision.state).toBe("cold");
		expect(decision.log).toContain("no indexed rows");
	});

	test("preexisted + !scan_complete + ever_complete + 0 rows → warm (empty-vault warm-restart)", () => {
		// Empty vault that previously scanned cleanly (ever_complete=true)
		// then was interrupted mid-reconcile must stay warm, not fall
		// through to cold and wedge vault-wide tools at INDEX_WARMING.
		const decision = chooseStartupState({
			preexisted: true,
			scanComplete: false,
			everComplete: true,
			fileCount: 0,
		});
		expect(decision.state).toBe("warm");
		expect(decision.log).toContain("0 files indexed");
		expect(decision.log).toContain("last scan incomplete");
	});

	test("fresh DB (!preexisted) → cold + no log", () => {
		const decision = chooseStartupState({
			preexisted: false,
			scanComplete: false,
			everComplete: false,
			fileCount: 0,
		});
		expect(decision.state).toBe("cold");
		expect(decision.log).toBeNull();
	});
});

describe("computePolicyMismatch", () => {
	test("fresh DB never mismatches", () => {
		expect(
			computePolicyMismatch({
				preexisted: false,
				scanComplete: false,
				includeHiddenPolicy: null,
				inflightIncludeHidden: null,
				argIncludeHidden: true,
			}),
		).toBe(false);
	});

	test("last-clean mismatch: persisted differs from args", () => {
		expect(
			computePolicyMismatch({
				preexisted: true,
				scanComplete: true,
				includeHiddenPolicy: false,
				inflightIncludeHidden: null,
				argIncludeHidden: true,
			}),
		).toBe(true);
	});

	test("NULL persisted coerces to false (legacy / pre-column upgrade)", () => {
		// Upgrade case: legacy cache opened with --include-hidden=on for
		// the first time. Persisted is NULL → coerce to false → mismatch.
		expect(
			computePolicyMismatch({
				preexisted: true,
				scanComplete: true,
				includeHiddenPolicy: null,
				inflightIncludeHidden: null,
				argIncludeHidden: true,
			}),
		).toBe(true);
	});

	test("interrupted-mismatch: inflight differs from args during a partial scan", () => {
		// Revert-during-flip: persisted last-clean matches args, but an
		// in-flight scan ran under the opposite policy and was interrupted.
		// The last-clean signal alone misses this.
		expect(
			computePolicyMismatch({
				preexisted: true,
				scanComplete: false,
				includeHiddenPolicy: false,
				inflightIncludeHidden: true,
				argIncludeHidden: false,
			}),
		).toBe(true);
	});

	test("interrupted-mismatch fires symmetric direction (on→off→on revert)", () => {
		expect(
			computePolicyMismatch({
				preexisted: true,
				scanComplete: false,
				includeHiddenPolicy: true,
				inflightIncludeHidden: false,
				argIncludeHidden: true,
			}),
		).toBe(true);
	});

	test("no-mismatch when scan_complete=false but inflight matches args", () => {
		// Same-policy interrupted reconcile: keep warm semantics, no cold
		// rescan. The fix must not over-fire on routine SIGTERMs.
		expect(
			computePolicyMismatch({
				preexisted: true,
				scanComplete: false,
				includeHiddenPolicy: false,
				inflightIncludeHidden: false,
				argIncludeHidden: false,
			}),
		).toBe(false);
	});

	test("no-mismatch when scan_complete=false and inflight is NULL (legacy DB)", () => {
		// Legacy DB upgrading: inflight column wasn't tracked, so NULL
		// is the only signal. Don't force cold on every upgrade — the
		// last-clean check still catches genuine policy flips.
		expect(
			computePolicyMismatch({
				preexisted: true,
				scanComplete: false,
				includeHiddenPolicy: false,
				inflightIncludeHidden: null,
				argIncludeHidden: false,
			}),
		).toBe(false);
	});

	test("scan_complete=true: inflight is ignored even if mismatched (defensive)", () => {
		// `markScanFinalized` clears inflight atomically with
		// `scan_complete=1`, so this state is unreachable in practice. If
		// it ever occurred (e.g., direct DB tampering), the last-clean
		// policy is the authoritative signal — trust it.
		expect(
			computePolicyMismatch({
				preexisted: true,
				scanComplete: true,
				includeHiddenPolicy: true,
				inflightIncludeHidden: false, // mismatched but ignored
				argIncludeHidden: true,
			}),
		).toBe(false);
	});

	// ─── VAULT_EXTENSIONS mismatch ───────────────────────────────

	test("vaultExtensionsPolicy='md' vs argVaultExtensions='md,yaml,yml' → mismatch", () => {
		expect(
			computePolicyMismatch({
				preexisted: true,
				scanComplete: true,
				includeHiddenPolicy: false,
				inflightIncludeHidden: null,
				argIncludeHidden: false,
				vaultExtensionsPolicy: "md",
				argVaultExtensions: "md,yaml,yml",
			}),
		).toBe(true);
	});

	test("pre-column legacy DB (NULL extensions) opened with VAULT_EXTENSIONS=md,yaml,yml → mismatch", () => {
		// Pre-column caches default to NULL `vault_extensions`. Coerced to `"md"`
		// (the pre-column default) — non-default `argVaultExtensions` fires.
		expect(
			computePolicyMismatch({
				preexisted: true,
				scanComplete: true,
				includeHiddenPolicy: false,
				inflightIncludeHidden: null,
				argIncludeHidden: false,
				vaultExtensionsPolicy: null,
				argVaultExtensions: "md,yaml,yml",
			}),
		).toBe(true);
	});

	test("pre-column legacy DB (NULL extensions) opened with default 'md' → no mismatch", () => {
		expect(
			computePolicyMismatch({
				preexisted: true,
				scanComplete: true,
				includeHiddenPolicy: false,
				inflightIncludeHidden: null,
				argIncludeHidden: false,
				vaultExtensionsPolicy: null,
				argVaultExtensions: "md",
			}),
		).toBe(false);
	});

	test("extensions match exactly → no mismatch even when arg sorted", () => {
		// Production callers canonicalize via `[...getVaultExtensions()].sort().join(",")`
		// before comparing, so the persisted value is already sorted.
		expect(
			computePolicyMismatch({
				preexisted: true,
				scanComplete: true,
				includeHiddenPolicy: false,
				inflightIncludeHidden: null,
				argIncludeHidden: false,
				vaultExtensionsPolicy: "md,yaml,yml",
				argVaultExtensions: "md,yaml,yml",
			}),
		).toBe(false);
	});

	test("removing yaml from VAULT_EXTENSIONS also triggers mismatch (symmetric)", () => {
		// 'md,yaml,yml' → 'md' must prune YAML rows from search via cold rescan.
		expect(
			computePolicyMismatch({
				preexisted: true,
				scanComplete: true,
				includeHiddenPolicy: false,
				inflightIncludeHidden: null,
				argIncludeHidden: false,
				vaultExtensionsPolicy: "md,yaml,yml",
				argVaultExtensions: "md",
			}),
		).toBe(true);
	});

	// ─── PARSER_SHAPE_VERSION mismatch ───────────────────────────

	test("persisted shape version less than arg → mismatch (upgrade past synthesizer bump)", () => {
		expect(
			computePolicyMismatch({
				preexisted: true,
				scanComplete: true,
				includeHiddenPolicy: false,
				inflightIncludeHidden: null,
				argIncludeHidden: false,
				parserShapeVersion: 0,
				argParserShapeVersion: 1,
			}),
		).toBe(true);
	});

	test("pre-column legacy DB (NULL shape) opened with non-zero arg → mismatch", () => {
		// Pre-column caches default to NULL parser_shape_version. Coerced to 0;
		// any non-zero in-code constant triggers the cold rescan that lets
		// previously-indexed YAML files pick up new synthesizer output.
		expect(
			computePolicyMismatch({
				preexisted: true,
				scanComplete: true,
				includeHiddenPolicy: false,
				inflightIncludeHidden: null,
				argIncludeHidden: false,
				parserShapeVersion: null,
				argParserShapeVersion: 1,
			}),
		).toBe(true);
	});

	test("shape versions equal → no mismatch", () => {
		expect(
			computePolicyMismatch({
				preexisted: true,
				scanComplete: true,
				includeHiddenPolicy: false,
				inflightIncludeHidden: null,
				argIncludeHidden: false,
				parserShapeVersion: 1,
				argParserShapeVersion: 1,
			}),
		).toBe(false);
	});

	test("pre-column legacy DB opened with arg=0 → no mismatch", () => {
		// Symmetric to the 'NULL persisted + default arg = no mismatch'
		// case: omitting argParserShapeVersion (or stubbing 0) shouldn't
		// fire on a pre-column cache.
		expect(
			computePolicyMismatch({
				preexisted: true,
				scanComplete: true,
				includeHiddenPolicy: false,
				inflightIncludeHidden: null,
				argIncludeHidden: false,
				parserShapeVersion: null,
				argParserShapeVersion: 0,
			}),
		).toBe(false);
	});

	test("both axes (extensions + shape) mismatching → mismatch (any axis triggers)", () => {
		expect(
			computePolicyMismatch({
				preexisted: true,
				scanComplete: true,
				includeHiddenPolicy: false,
				inflightIncludeHidden: null,
				argIncludeHidden: false,
				vaultExtensionsPolicy: "md",
				argVaultExtensions: "md,yaml,yml",
				parserShapeVersion: 0,
				argParserShapeVersion: 1,
			}),
		).toBe(true);
	});

	test("shape downgrade (persisted > arg) also fires (symmetric)", () => {
		// Defensive: if a contributor accidentally lowers PARSER_SHAPE_VERSION
		// or a user downgrades the binary, force a cold rescan rather than
		// trusting an unknown-future-shape snapshot.
		expect(
			computePolicyMismatch({
				preexisted: true,
				scanComplete: true,
				includeHiddenPolicy: false,
				inflightIncludeHidden: null,
				argIncludeHidden: false,
				parserShapeVersion: 2,
				argParserShapeVersion: 1,
			}),
		).toBe(true);
	});

	test("downgrade after interrupted-shape-Y rescan forces cold when inflight differs from arg", () => {
		// T0 clean scan at shape X=1 → parser_shape_version=1, everComplete=true.
		// T1 upgrade to shape Y=2 starts cold rescan, sets inflight=2.
		// T2 SIGTERM mid-pass; parser_shape_version still 1.
		// T3 user reverts to shape X=1 binary; finalized stamp matches (1==1)
		// but inflight (2) differs → mismatch → cold rescan over the partial
		// shape-Y rows.
		expect(
			computePolicyMismatch({
				preexisted: true,
				scanComplete: false,
				includeHiddenPolicy: false,
				inflightIncludeHidden: false,
				argIncludeHidden: false,
				parserShapeVersion: 1,
				argParserShapeVersion: 1,
				inflightParserShapeVersion: 2,
			}),
		).toBe(true);
	});

	test("interrupted scan at same parser shape as the running binary is not a mismatch", () => {
		// Interrupted scan ran at the same shape we now boot under — no
		// mixed-shape hazard. The warm `everComplete` branch correctly
		// serves the prior snapshot while reconcile resumes.
		expect(
			computePolicyMismatch({
				preexisted: true,
				scanComplete: false,
				includeHiddenPolicy: false,
				inflightIncludeHidden: false,
				argIncludeHidden: false,
				parserShapeVersion: 1,
				argParserShapeVersion: 1,
				inflightParserShapeVersion: 1,
			}),
		).toBe(false);
	});

	test("clean finalize ignores inflight parser-shape regardless of value", () => {
		// scanComplete=true short-circuits before the inflight check; the
		// inflight column should be NULL post-finalize anyway, but a stale
		// non-null value must not cause a spurious mismatch.
		expect(
			computePolicyMismatch({
				preexisted: true,
				scanComplete: true,
				includeHiddenPolicy: false,
				inflightIncludeHidden: null,
				argIncludeHidden: false,
				parserShapeVersion: 1,
				argParserShapeVersion: 1,
				inflightParserShapeVersion: 99, // stale but ignored
			}),
		).toBe(false);
	});
});
