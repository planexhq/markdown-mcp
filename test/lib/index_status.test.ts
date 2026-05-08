/**
 * Index lifecycle state machine tests. Validates the transition arc
 * table from `src/lib/index_status.ts` — every legal arc returns the
 * `next` state, every illegal arc throws `IllegalStateTransitionError`.
 */

import { describe, expect, test } from "vitest";

import { IllegalStateTransitionError, transition } from "../../src/lib/index_status.js";
import type { IndexState } from "../../src/types.js";

const ALL_STATES: IndexState[] = ["cold", "warming", "warm", "reconciling"];

const LEGAL_ARCS: Array<[IndexState, IndexState]> = [
	["cold", "cold"],
	["cold", "warming"],
	["cold", "warm"],
	["warming", "warming"],
	["warming", "warm"],
	["warm", "warm"],
	["warm", "reconciling"],
	["reconciling", "reconciling"],
	["reconciling", "warm"],
];

describe("index_status — legal transitions", () => {
	for (const [from, to] of LEGAL_ARCS) {
		test(`${from} → ${to} returns ${to}`, () => {
			expect(transition(from, to)).toBe(to);
		});
	}
});

describe("index_status — illegal transitions throw", () => {
	const legal = new Set(LEGAL_ARCS.map(([f, t]) => `${f}→${t}`));
	for (const from of ALL_STATES) {
		for (const to of ALL_STATES) {
			if (legal.has(`${from}→${to}`)) continue;
			test(`${from} → ${to} throws IllegalStateTransitionError`, () => {
				try {
					transition(from, to);
					throw new Error(`expected throw on ${from} → ${to}`);
				} catch (err) {
					expect(err).toBeInstanceOf(IllegalStateTransitionError);
					if (err instanceof IllegalStateTransitionError) {
						expect(err.from).toBe(from);
						expect(err.to).toBe(to);
					}
				}
			});
		}
	}
});

describe("index_status — error shape", () => {
	test("error message includes both states", () => {
		try {
			transition("warm", "cold");
		} catch (err) {
			expect(err).toBeInstanceOf(IllegalStateTransitionError);
			if (err instanceof IllegalStateTransitionError) {
				expect(err.message).toContain("warm");
				expect(err.message).toContain("cold");
			}
		}
	});
});
