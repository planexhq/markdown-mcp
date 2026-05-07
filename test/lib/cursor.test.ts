/**
 * Cursor encode/decode + validation tests. Covers the score-desc and
 * filter-keyset-v1 sort variants used by `search` in W3, plus the
 * mismatch error class that drives `CURSOR_INVALID` at the handler.
 */

import { describe, expect, test } from "vitest";

import {
	CursorDecodeError,
	type CursorEnvelope,
	CursorMismatchError,
	decodeCursor,
	encodeCursor,
	type ScoreDescKey,
	validateCursor,
} from "../../src/lib/cursor.js";

function makeScoreDesc(requestHash = "", snapshot = 1): CursorEnvelope {
	return {
		v: 1,
		sort: "score-desc",
		request_hash: requestHash,
		snapshot_mtime: snapshot,
		after_key: { score: 0.42, file: "a.md", heading_path: ["A", "B"], anchor_kind: "heading", id: 7 },
	};
}

function makeFilterKeyset(requestHash = "abc", snapshot = 1): CursorEnvelope {
	return {
		v: 1,
		sort: "filter-keyset-v1",
		request_hash: requestHash,
		snapshot_mtime: snapshot,
		after_key: { file: "a.md", heading_path: null, anchor_kind: "preamble", id: 13 },
	};
}

describe("cursor — encode/decode round-trip", () => {
	test("score-desc round-trips exact shape", () => {
		const env = makeScoreDesc("abc", 100);
		const encoded = encodeCursor(env);
		expect(typeof encoded).toBe("string");
		const decoded = decodeCursor(encoded);
		expect(decoded).toEqual(env);
	});

	test("filter-keyset-v1 round-trips with null heading_path", () => {
		const env = makeFilterKeyset("def", 200);
		const encoded = encodeCursor(env);
		const decoded = decodeCursor(encoded);
		expect(decoded).toEqual(env);
	});
});

describe("cursor — decode failures", () => {
	test("empty string", () => {
		expect(() => decodeCursor("")).toThrow(CursorDecodeError);
	});

	test("forged random base64", () => {
		const random = Buffer.from("not-a-cursor", "utf8").toString("base64url");
		expect(() => decodeCursor(random)).toThrow(CursorDecodeError);
	});

	test("non-object payload", () => {
		const encoded = Buffer.from('"a string"', "utf8").toString("base64url");
		expect(() => decodeCursor(encoded)).toThrow(CursorDecodeError);
	});

	test("v != 1", () => {
		const env = { ...makeScoreDesc(), v: 99 };
		const encoded = Buffer.from(JSON.stringify(env), "utf8").toString("base64url");
		expect(() => decodeCursor(encoded)).toThrow(CursorDecodeError);
	});

	test("missing sort", () => {
		const broken = { v: 1, request_hash: "", snapshot_mtime: 1, after_key: {} };
		const encoded = Buffer.from(JSON.stringify(broken), "utf8").toString("base64url");
		expect(() => decodeCursor(encoded)).toThrow(CursorDecodeError);
	});

	test("missing request_hash", () => {
		const env = makeScoreDesc();
		const { request_hash: _request_hash, ...withoutHash } = env;
		const encoded = Buffer.from(JSON.stringify(withoutHash), "utf8").toString("base64url");
		expect(() => decodeCursor(encoded)).toThrow(CursorDecodeError);
	});

	test("unknown sort", () => {
		const env = { ...makeScoreDesc(), sort: "made-up-sort" };
		const encoded = Buffer.from(JSON.stringify(env), "utf8").toString("base64url");
		expect(() => decodeCursor(encoded)).toThrow(CursorDecodeError);
	});

	test("score-desc missing score", () => {
		const env = makeScoreDesc();
		const broken = { ...env, after_key: { file: "a.md", heading_path: null, anchor_kind: "heading" } };
		const encoded = Buffer.from(JSON.stringify(broken), "utf8").toString("base64url");
		expect(() => decodeCursor(encoded)).toThrow(CursorDecodeError);
	});

	test("bad anchor_kind", () => {
		const env = makeScoreDesc();
		const broken = { ...env, after_key: { ...env.after_key, anchor_kind: "wat" } };
		const encoded = Buffer.from(JSON.stringify(broken), "utf8").toString("base64url");
		expect(() => decodeCursor(encoded)).toThrow(CursorDecodeError);
	});

	test("score-desc missing id", () => {
		const env = makeScoreDesc();
		const { id: _id, ...afterWithoutId } = env.after_key as ScoreDescKey;
		const broken = { ...env, after_key: afterWithoutId };
		const encoded = Buffer.from(JSON.stringify(broken), "utf8").toString("base64url");
		expect(() => decodeCursor(encoded)).toThrow(CursorDecodeError);
	});

	test("filter-keyset-v1 non-integer id", () => {
		const env = makeFilterKeyset();
		const broken = { ...env, after_key: { ...env.after_key, id: 1.5 } };
		const encoded = Buffer.from(JSON.stringify(broken), "utf8").toString("base64url");
		expect(() => decodeCursor(encoded)).toThrow(CursorDecodeError);
	});
});

describe("cursor — validation context", () => {
	test("sort mismatch throws CursorMismatchError(sort)", () => {
		const env = makeScoreDesc("h", 1);
		expect(() =>
			validateCursor(env, {
				expectedSort: "filter-keyset-v1",
				currentRequestHash: "h",
				currentSnapshotMtime: 1,
			}),
		).toThrowError(CursorMismatchError);
	});

	test("request_hash drift throws CursorMismatchError(request_hash)", () => {
		const env = makeScoreDesc("OLD", 1);
		expect(() =>
			validateCursor(env, {
				expectedSort: "score-desc",
				currentRequestHash: "NEW",
				currentSnapshotMtime: 1,
			}),
		).toThrowError(CursorMismatchError);
	});

	test("snapshot_mtime drift throws CursorMismatchError(snapshot_mtime)", () => {
		const env = makeScoreDesc("h", 100);
		expect(() =>
			validateCursor(env, {
				expectedSort: "score-desc",
				currentRequestHash: "h",
				currentSnapshotMtime: 200,
			}),
		).toThrowError(CursorMismatchError);
	});

	test("matching context passes", () => {
		const env = makeScoreDesc("h", 100);
		expect(() =>
			validateCursor(env, {
				expectedSort: "score-desc",
				currentRequestHash: "h",
				currentSnapshotMtime: 100,
			}),
		).not.toThrow();
	});
});
