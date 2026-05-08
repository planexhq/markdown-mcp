import { describe, expect, test } from "vitest";

import { chooseStartupState } from "../../src/lib/startup.js";

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

	test("preexisted + !scan_complete + ever_complete + 0 rows → warm (round 25 F5)", () => {
		// Empty vault that previously scanned cleanly (ever_complete=true)
		// then was interrupted mid-reconcile. Pre-fix this fell through to
		// `cold` because `fileCount > 0` was required, wedging vault-wide
		// tools at INDEX_WARMING during the unnecessary rescan.
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
