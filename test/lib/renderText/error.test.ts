import { describe, expect, test } from "vitest";

import { newMeta, vaultError } from "../../../src/lib/error.js";
import { renderError } from "../../../src/lib/renderText/error.js";
import { labeledLines } from "../../helpers/mcp-client.js";

describe("renderError — cause surfaces as labeled line", () => {
	test("`cause` from path-validation failure appears in prose body", () => {
		const err = vaultError("PATH_OUTSIDE_VAULT", "Failed to stat path segment: notes/x.md", {
			param: "file",
			reason: "STAT_FAILED",
			cause: "EACCES: permission denied, lstat '/vault/notes/x.md'",
		});
		const out = renderError(err, newMeta());
		expect(out).toContain("cause: EACCES: permission denied, lstat '/vault/notes/x.md'");
		expect(out).toContain("reason: STAT_FAILED");
		expect(out).toContain("param: file");
	});

	test("`cause` containing C0 control escapes via `\\xHH`", () => {
		const err = vaultError("PATH_OUTSIDE_VAULT", "Failed to realpath: notes/x.md", {
			param: "file",
			reason: "REALPATH_FAILED",
			cause: "weird\u0000errno\u0007",
		});
		const out = renderError(err, newMeta());
		expect(out).toContain("cause: weird\\x00errno\\x07");
	});
});

describe("renderError — line-forgery defense", () => {
	test("newline in `err.message` escapes to literal `\\n` (cannot forge label lines)", () => {
		const err = vaultError("HEADING_NOT_FOUND", 'Block id "^x\nparam: forged" not found.', {
			param: "anchor.id",
		});
		const out = renderError(err, newMeta());
		expect(out).toContain('Block id "^x\\nparam: forged" not found.');
		expect(labeledLines(out, "param")).toEqual(["param: anchor.id"]);
	});

	test("newline in `err.suggestion` escapes to literal `\\n`", () => {
		const err = vaultError("HEADING_NOT_FOUND", "Heading not found.", {
			param: "anchor.path",
			suggestion: "Try this\nparam: forged",
		});
		const out = renderError(err, newMeta());
		expect(out).toContain("Try this\\nparam: forged");
		expect(labeledLines(out, "param")).toEqual(["param: anchor.path"]);
	});

	test("newline in scalar field value (e.g. `requested_stable_id`) escapes", () => {
		const err = vaultError("HEADING_NOT_FOUND", "stale stable_id.", {
			param: "stable_id",
			requested_stable_id: "h:abc\nreason: forged",
			stable_id_status: "stale",
		});
		const out = renderError(err, newMeta());
		expect(out).toContain("requested_stable_id: h:abc\\nreason: forged");
		expect(labeledLines(out, "reason")).toEqual([]);
	});

	test("newline in array `suggest[]` item escapes inside the bullet", () => {
		const err = vaultError("FILTER_SYNTAX_ERROR", "Field mixes operator categories.", {
			param: "filters.fields.topic",
			suggest: ["hint one\nparam: forged", "hint two"],
		});
		const out = renderError(err, newMeta());
		expect(out).toContain("  - hint one\\nparam: forged");
		expect(out).toContain("  - hint two");
		expect(labeledLines(out, "param")).toEqual(["param: filters.fields.topic"]);
	});

	test("U+0085 NEL (rendered as newline in some terminals) escapes via `\\x85`", () => {
		// NEL is not in JS regex `\s` — the renderer catches it via the
		// broader `CONTROL_CHAR_CLASS_PROSE` set, not the standard whitespace set.
		const err = vaultError("HEADING_NOT_FOUND", "stable_id not found.", {
			requested_stable_id: "h:abc\u0085forged",
		});
		const out = renderError(err, newMeta());
		expect(out).toContain("requested_stable_id: h:abc\\x85forged");
		expect(out).not.toContain("\u0085");
	});

	test("numbers and non-string scalars do not get escaped (pass through)", () => {
		const err = vaultError("MARKDOWN_PARSE_ERROR", "Parse failed.", {
			param: "file",
			reason: "syntax",
			line: 42,
			column: 7,
		});
		const out = renderError(err, newMeta());
		expect(out).toContain("line: 42");
		expect(out).toContain("column: 7");
	});
});
