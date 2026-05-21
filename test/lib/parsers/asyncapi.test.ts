/**
 * AsyncAPI 3.x synthesizer unit tests.
 *
 * Covers:
 *   - Detection: `asyncapi: "3.*"` → synthesize; `asyncapi: "2.*"` → opaque fallback.
 *   - Operation enumeration: sorted alphabetically by opName; `action` prefix
 *     drives heading text; intra-doc `$ref` for channel + messages resolved.
 *   - Stable ID format: `structuralPath` = `"op[<sha14(opName)>]"`, stable
 *     across operation reorder (name-based slots).
 *   - Heading metadata: pathText = "send userSignedUp", level=2, flat outline.
 *   - Preamble emission: info + servers; full top-level as frontmatter.
 *   - Synthesized source content: prose + JSON fences in excludedRanges.
 *   - Channels + Components catch-all sections.
 *   - Spec metadata residual catch-all.
 *   - Reply + bindings + messages rendering.
 *   - Opaque fallback for sparse 3.x AND for AsyncAPI 2.x.
 */

import { describe, expect, test } from "vitest";
import { MAX_FILE_BYTES } from "../../../src/lib/limits.js";
import { detectAsyncApi } from "../../../src/lib/parsers/asyncapi.js";
import { parseYamlFile } from "../../../src/lib/parsers/yaml.js";

const isOperationHeading = (h: { structuralPath: string }): boolean => h.structuralPath.startsWith("op[");

const STREETLIGHTS_YAML = `asyncapi: "3.0.0"
info:
  title: Streetlights API
  version: 1.0.0
  description: Streetlight control over MQTT.
  tags:
    - name: streetlight
      description: Streetlight ops
servers:
  production:
    host: mqtt.example.com
    protocol: mqtt
    description: Production broker
channels:
  lightMeasured:
    address: smartylighting/streetlights/event/lighting/measured
    messages:
      lightMeasuredMsg:
        name: lightMeasured
        title: Light measured
        summary: Inform about environmental lighting.
        payload:
          type: object
          properties:
            lumens: { type: integer }
  lightTurnOn:
    address: smartylighting/streetlights/action/turn/on
    messages:
      turnOnMsg:
        name: turnOn
        title: Turn on
        payload:
          type: object
operations:
  receiveLightMeasured:
    action: receive
    channel:
      $ref: "#/channels/lightMeasured"
    summary: Receive lighting measurements
    description: Subscribes to streetlight measurement events.
    messages:
      - $ref: "#/channels/lightMeasured/messages/lightMeasuredMsg"
    tags:
      - name: streetlight
  sendTurnOn:
    action: send
    channel:
      $ref: "#/channels/lightTurnOn"
    summary: Turn streetlight on
    messages:
      - $ref: "#/channels/lightTurnOn/messages/turnOnMsg"
`;

describe("detectAsyncApi", () => {
	test("returns true for asyncapi 3.0.x", () => {
		expect(detectAsyncApi({ asyncapi: "3.0.0" })).toBe(true);
		expect(detectAsyncApi({ asyncapi: "3.0.0", info: {} })).toBe(true);
	});

	test("returns true for asyncapi 3.1.x", () => {
		expect(detectAsyncApi({ asyncapi: "3.1.0" })).toBe(true);
	});

	test("returns false for asyncapi 2.x", () => {
		expect(detectAsyncApi({ asyncapi: "2.6.0" })).toBe(false);
		expect(detectAsyncApi({ asyncapi: "2.0.0" })).toBe(false);
	});

	test("returns false for openapi documents", () => {
		expect(detectAsyncApi({ openapi: "3.0.3" })).toBe(false);
	});

	test("returns false for missing or non-string asyncapi version", () => {
		expect(detectAsyncApi({})).toBe(false);
		expect(detectAsyncApi({ asyncapi: 3 })).toBe(false);
		expect(detectAsyncApi({ asyncapi: null })).toBe(false);
	});

	test("returns false for non-objects", () => {
		expect(detectAsyncApi(null)).toBe(false);
		expect(detectAsyncApi("hello")).toBe(false);
		expect(detectAsyncApi(42)).toBe(false);
		expect(detectAsyncApi([])).toBe(false);
	});
});

describe("synthesizeAsyncApiFile — operation enumeration", () => {
	test("enumerates all operations sorted alphabetically by opName", () => {
		const parsed = parseYamlFile(STREETLIGHTS_YAML, "api/streetlights.yaml");
		const texts = parsed.headings.filter(isOperationHeading).map((h) => h.pathText);
		expect(texts).toEqual(["receive receiveLightMeasured", "send sendTurnOn"]);
	});

	test("each operation gets one heading row at level 2 with single-element headingPath", () => {
		const parsed = parseYamlFile(STREETLIGHTS_YAML, "api/streetlights.yaml");
		const ops = parsed.headings.filter(isOperationHeading);
		expect(ops.length).toBe(2);
		for (const h of ops) {
			expect(h.level).toBe(2);
			expect(h.headingPath.length).toBe(1);
		}
	});

	test("flat outline — every operation is a top-level node", () => {
		const parsed = parseYamlFile(STREETLIGHTS_YAML, "api/streetlights.yaml");
		for (const node of parsed.outline) {
			expect(node.children).toBeUndefined();
			expect(node.level).toBe(2);
		}
	});

	test("channel $ref is resolved to channel.address in operation prose", () => {
		const parsed = parseYamlFile(STREETLIGHTS_YAML, "api/streetlights.yaml");
		const receive = parsed.headings.find((h) => h.pathText === "receive receiveLightMeasured");
		if (!receive) throw new Error("expected receive heading");
		const body = parsed.source.slice(receive.bodyOffsetRange.start, receive.bodyOffsetRange.end);
		expect(body).toContain("Channel: smartylighting/streetlights/event/lighting/measured");
	});

	test("message $ref resolves to message name", () => {
		const parsed = parseYamlFile(STREETLIGHTS_YAML, "api/streetlights.yaml");
		const send = parsed.headings.find((h) => h.pathText === "send sendTurnOn");
		if (!send) throw new Error("expected send heading");
		const body = parsed.source.slice(send.bodyOffsetRange.start, send.bodyOffsetRange.end);
		expect(body).toContain("Messages:");
		expect(body).toContain("- turnOnMsg");
	});

	test("external $ref is preserved verbatim in prose (no exception)", () => {
		const yaml = `asyncapi: "3.0.0"
info: { title: T, version: "1" }
channels: {}
operations:
  externalOp:
    action: send
    channel:
      $ref: "./shared.yaml#/channels/Remote"
`;
		const parsed = parseYamlFile(yaml, "x.yaml");
		const heading = parsed.headings.find((h) => h.pathText === "send externalOp");
		if (!heading) throw new Error("expected send externalOp heading");
		const body = parsed.source.slice(heading.bodyOffsetRange.start, heading.bodyOffsetRange.end);
		// Channel renders as the raw $ref string since we couldn't resolve intra-doc.
		expect(body).toContain("Channel: ./shared.yaml#/channels/Remote");
	});

	test("operation with missing or invalid action is skipped (no heading)", () => {
		const yaml = `asyncapi: "3.0.0"
info: { title: T, version: "1" }
operations:
  noAction:
    summary: Has no action
  bogusAction:
    action: subscribe
    summary: Action from AsyncAPI 2.x — not valid in 3.x
  validOp:
    action: send
    summary: Real send op
`;
		const parsed = parseYamlFile(yaml, "x.yaml");
		const texts = parsed.headings.filter(isOperationHeading).map((h) => h.pathText);
		expect(texts).toEqual(["send validOp"]);
	});
});

describe("synthesizeAsyncApiFile — stable IDs (name-based slots)", () => {
	test("structuralPath uses op[<sha14>] format (matches markdown stable_id width)", () => {
		const parsed = parseYamlFile(STREETLIGHTS_YAML, "api/streetlights.yaml");
		const ops = parsed.headings.filter(isOperationHeading);
		expect(ops.length).toBeGreaterThan(0);
		for (const h of ops) {
			expect(h.structuralPath).toMatch(/^op\[[0-9a-f]{14}\]$/);
		}
	});

	test("stable_id survives operation reorder (name-based, not source-order)", () => {
		const yamlA = `asyncapi: "3.0.0"
info: { title: T, version: "1" }
operations:
  alpha:
    action: send
  beta:
    action: receive
`;
		const yamlB = `asyncapi: "3.0.0"
info: { title: T, version: "1" }
operations:
  beta:
    action: receive
  alpha:
    action: send
`;
		const parsedA = parseYamlFile(yamlA, "x.yaml");
		const parsedB = parseYamlFile(yamlB, "x.yaml");
		const idsA = new Map(parsedA.headings.map((h) => [h.pathText, h.stable_id]));
		const idsB = new Map(parsedB.headings.map((h) => [h.pathText, h.stable_id]));
		expect(idsA.get("send alpha")).toBe(idsB.get("send alpha"));
		expect(idsA.get("receive beta")).toBe(idsB.get("receive beta"));
	});

	test("inserting a new operation does NOT shift existing stable_ids", () => {
		const before = `asyncapi: "3.0.0"
info: { title: T, version: "1" }
operations:
  alpha: { action: send }
  gamma: { action: receive }
`;
		const after = `asyncapi: "3.0.0"
info: { title: T, version: "1" }
operations:
  alpha: { action: send }
  beta:  { action: send }
  gamma: { action: receive }
`;
		const a = parseYamlFile(before, "x.yaml");
		const b = parseYamlFile(after, "x.yaml");
		const alphaA = a.headings.find((h) => h.pathText === "send alpha")?.stable_id;
		const alphaB = b.headings.find((h) => h.pathText === "send alpha")?.stable_id;
		expect(alphaA).toBeDefined();
		expect(alphaB).toBe(alphaA);
		const gammaA = a.headings.find((h) => h.pathText === "receive gamma")?.stable_id;
		const gammaB = b.headings.find((h) => h.pathText === "receive gamma")?.stable_id;
		expect(gammaB).toBe(gammaA);
	});

	test("renaming an operation retires the old stable_id", () => {
		const before = `asyncapi: "3.0.0"
info: { title: T, version: "1" }
operations:
  oldName: { action: send }
`;
		const after = `asyncapi: "3.0.0"
info: { title: T, version: "1" }
operations:
  newName: { action: send }
`;
		const a = parseYamlFile(before, "x.yaml");
		const b = parseYamlFile(after, "x.yaml");
		expect(a.headings[0]?.stable_id).not.toBe(b.headings[0]?.stable_id);
	});

	test("action change with same opName keeps the stable_id (action is a property, not identity)", () => {
		// `op[sha14(opName)]` is the slot — only the name participates. An
		// agent renaming the action (e.g. flipping a send→receive) gets the
		// same slot ID, which is the intended semantic for an opName-based
		// addressing scheme.
		const before = `asyncapi: "3.0.0"
info: { title: T, version: "1" }
operations:
  ping: { action: send }
`;
		const after = `asyncapi: "3.0.0"
info: { title: T, version: "1" }
operations:
  ping: { action: receive }
`;
		const a = parseYamlFile(before, "x.yaml");
		const b = parseYamlFile(after, "x.yaml");
		expect(a.headings[0]?.pathText).toBe("send ping");
		expect(b.headings[0]?.pathText).toBe("receive ping");
		expect(a.headings[0]?.stable_id).toBe(b.headings[0]?.stable_id);
	});
});

describe("synthesizeAsyncApiFile — preamble + frontmatter", () => {
	test("info block emits preamble row with title/version/description/tags prose", () => {
		const parsed = parseYamlFile(STREETLIGHTS_YAML, "api/streetlights.yaml");
		const preamble = parsed.preamble;
		if (preamble === null) throw new Error("expected preamble to be present");
		const slice = parsed.source.slice(preamble.offsetRange.start, preamble.offsetRange.end);
		expect(slice).toContain("Streetlights API");
		expect(slice).toContain("1.0.0");
		expect(slice).toContain("Streetlight control over MQTT.");
		expect(slice).toContain("streetlight"); // info.tags name
	});

	test("servers render in preamble with name + protocol", () => {
		const parsed = parseYamlFile(STREETLIGHTS_YAML, "api/streetlights.yaml");
		const preamble = parsed.preamble;
		if (preamble === null) throw new Error("expected preamble");
		const slice = parsed.source.slice(preamble.offsetRange.start, preamble.offsetRange.end);
		expect(slice).toContain("Servers:");
		expect(slice).toContain("- production (mqtt): mqtt.example.com");
	});

	test("missing info AND no servers → no preamble row", () => {
		const yaml = `asyncapi: "3.0.0"
operations:
  ping:
    action: send
`;
		const parsed = parseYamlFile(yaml, "x.yaml");
		expect(parsed.preamble).toBeNull();
	});

	test("frontmatter exposes entire top-level AsyncAPI object for nested-path access", () => {
		const parsed = parseYamlFile(STREETLIGHTS_YAML, "api/streetlights.yaml");
		expect(parsed.hasFrontmatter).toBe(true);
		const fm = parsed.frontmatter as Record<string, unknown>;
		expect(fm.asyncapi).toBe("3.0.0");
		const info = fm.info as Record<string, unknown>;
		expect(info.title).toBe("Streetlights API");
		expect(info.version).toBe("1.0.0");
		expect(fm.operations).toBeTruthy();
		expect(fm.channels).toBeTruthy();
	});
});

describe("synthesizeAsyncApiFile — synthesized source + excludedRanges", () => {
	test("synthesized source contains operation headings and prose", () => {
		const parsed = parseYamlFile(STREETLIGHTS_YAML, "api/streetlights.yaml");
		expect(parsed.source).toContain("## receive receiveLightMeasured\n");
		expect(parsed.source).toContain("## send sendTurnOn\n");
		expect(parsed.source).toContain("Receive lighting measurements");
		expect(parsed.source).toContain("Subscribes to streetlight measurement events.");
		expect(parsed.source).toContain("Action: receive");
		expect(parsed.source).toContain("Action: send");
		expect(parsed.source).toContain("Messages:");
		expect(parsed.source).toContain("- lightMeasuredMsg");
	});

	test("each operation has a JSON fence covered by excludedRanges", () => {
		const parsed = parseYamlFile(STREETLIGHTS_YAML, "api/streetlights.yaml");
		// 2 operations + 1 channels fence + 1 spec-metadata fence
		// (info.tags descriptions + server descriptions flow into the residual).
		expect(parsed.excludedRanges.length).toBe(4);
		for (const range of parsed.excludedRanges) {
			const slice = parsed.source.slice(range.offsetStart, range.offsetEnd);
			expect(slice.startsWith("```json")).toBe(true);
			expect(slice.endsWith("```\n\n")).toBe(true);
		}
	});

	test("heading offsetRange covers the operation section through the next heading", () => {
		const parsed = parseYamlFile(STREETLIGHTS_YAML, "api/streetlights.yaml");
		for (let i = 0; i < parsed.headings.length; i++) {
			const h = parsed.headings[i];
			if (!h) continue;
			const next = parsed.headings[i + 1];
			if (next) {
				expect(h.offsetRange.end).toBe(next.offsetRange.start);
			} else {
				expect(h.offsetRange.end).toBe(parsed.source.length);
			}
			expect(h.bodyOffsetRange.start).toBeGreaterThan(h.offsetRange.start);
			expect(h.bodyOffsetRange.end).toBe(h.offsetRange.end);
		}
	});

	test("kind: 'yaml' on every synthesized ParsedFile", () => {
		const parsed = parseYamlFile(STREETLIGHTS_YAML, "api/streetlights.yaml");
		expect(parsed.kind).toBe("yaml");
	});
});

describe("synthesizeAsyncApiFile — channels + components sections", () => {
	test("non-empty channels emits ## Channels with structuralPath 'channels'", () => {
		const parsed = parseYamlFile(STREETLIGHTS_YAML, "api/streetlights.yaml");
		const heading = parsed.headings.find((h) => h.pathText === "Channels");
		if (!heading) throw new Error("expected Channels heading");
		expect(heading.structuralPath).toBe("channels");
		expect(heading.level).toBe(2);
	});

	test("non-empty components emits ## Components with structuralPath 'components'", () => {
		const yaml = `asyncapi: "3.0.0"
info: { title: T, version: "1" }
operations:
  ping: { action: send }
components:
  schemas:
    User:
      type: object
      properties:
        id: { type: string }
`;
		const parsed = parseYamlFile(yaml, "x.yaml");
		const heading = parsed.headings.find((h) => h.pathText === "Components");
		if (!heading) throw new Error("expected Components heading");
		expect(heading.structuralPath).toBe("components");
		expect(heading.level).toBe(2);
		// FTS reaches User schema content via the code fence.
		expect(parsed.source).toContain('"User"');
	});

	test("channels and components omitted when respective object missing or empty", () => {
		const yaml = `asyncapi: "3.0.0"
info: { title: T, version: "1" }
operations:
  ping: { action: send }
`;
		const parsed = parseYamlFile(yaml, "x.yaml");
		expect(parsed.headings.find((h) => h.pathText === "Channels")).toBeUndefined();
		expect(parsed.headings.find((h) => h.pathText === "Components")).toBeUndefined();
		expect(parsed.source).not.toContain("## Channels");
		expect(parsed.source).not.toContain("## Components");
	});

	test("oversized channels → fence truncates and language drops to text", () => {
		const channels: Record<string, unknown> = {};
		for (let i = 0; i < 500; i++) {
			channels[`chan${i}`] = { address: "x".repeat(200), messages: {} };
		}
		const yaml = `asyncapi: "3.0.0"
info: { title: T, version: "1" }
operations: {}
channels: ${JSON.stringify(channels)}
`;
		const parsed = parseYamlFile(yaml, "x.yaml");
		const heading = parsed.headings.find((h) => h.pathText === "Channels");
		if (!heading) throw new Error("expected Channels heading");
		const body = parsed.source.slice(heading.bodyOffsetRange.start, heading.bodyOffsetRange.end);
		expect(body).toContain("truncated;");
		expect(body).toContain("```text\n");
		expect(body).not.toContain("```json\n");
	});
});

describe("synthesizeAsyncApiFile — spec metadata catch-all", () => {
	test("residual top-level fields (id, defaultContentType, externalDocs, x-*) reach source", () => {
		const yaml = `asyncapi: "3.0.0"
id: urn:example:streetlights
defaultContentType: application/json
externalDocs:
  url: https://example.com/docs
  description: Full reference
x-org: planex
info: { title: T, version: "1" }
operations:
  ping: { action: send }
`;
		const parsed = parseYamlFile(yaml, "x.yaml");
		expect(parsed.source).toContain("## Spec metadata\n");
		expect(parsed.source).toContain("urn:example:streetlights");
		expect(parsed.source).toContain("application/json");
		expect(parsed.source).toContain("https://example.com/docs");
		expect(parsed.source).toContain("Full reference");
		expect(parsed.source).toContain("planex");
	});

	test("info residual fields (license, contact, info.tags descriptions) reach spec metadata", () => {
		const yaml = `asyncapi: "3.0.0"
info:
  title: T
  version: "1"
  license:
    name: Apache 2.0
  tags:
    - name: streetlight
      description: Streetlight operations and their descriptions
operations:
  ping: { action: send }
`;
		const parsed = parseYamlFile(yaml, "x.yaml");
		expect(parsed.source).toContain("Tags: streetlight");
		// Tag name in preamble; description survives in residual fence.
		expect(parsed.source).toContain("Streetlight operations and their descriptions");
		expect(parsed.source).toContain("Apache 2.0");
	});

	test("Spec metadata heading omitted when no residual fields present", () => {
		const yaml = `asyncapi: "3.0.0"
info: { title: T, version: "1" }
operations:
  ping: { action: send }
`;
		const parsed = parseYamlFile(yaml, "x.yaml");
		expect(parsed.headings.find((h) => h.pathText === "Spec metadata")).toBeUndefined();
	});
});

describe("synthesizeAsyncApiFile — reply + bindings + messages", () => {
	test("reply.channel.$ref resolved + rendered in operation prose", () => {
		const yaml = `asyncapi: "3.0.0"
info: { title: T, version: "1" }
channels:
  request:
    address: rpc/request
    messages:
      msg: { name: req }
  response:
    address: rpc/response
    messages:
      msg: { name: resp }
operations:
  rpcCall:
    action: send
    channel:
      $ref: "#/channels/request"
    messages:
      - $ref: "#/channels/request/messages/msg"
    reply:
      channel:
        $ref: "#/channels/response"
      messages:
        - $ref: "#/channels/response/messages/msg"
`;
		const parsed = parseYamlFile(yaml, "x.yaml");
		const op = parsed.headings.find((h) => h.pathText === "send rpcCall");
		if (!op) throw new Error("expected send rpcCall heading");
		const body = parsed.source.slice(op.bodyOffsetRange.start, op.bodyOffsetRange.end);
		expect(body).toContain("Channel: rpc/request");
		expect(body).toContain("Reply:");
		expect(body).toContain("- Channel: rpc/response");
		expect(body).toContain("- Message: msg");
	});

	test("operation bindings appear in the JSON fence (not as prose)", () => {
		const yaml = `asyncapi: "3.0.0"
info: { title: T, version: "1" }
operations:
  publishEvent:
    action: send
    bindings:
      kafka:
        groupId: streetlight-consumers
        clientId: srv-1
`;
		const parsed = parseYamlFile(yaml, "x.yaml");
		const op = parsed.headings.find((h) => h.pathText === "send publishEvent");
		if (!op) throw new Error("expected send publishEvent heading");
		const body = parsed.source.slice(op.bodyOffsetRange.start, op.bodyOffsetRange.end);
		// Bindings reach FTS via the JSON fence — kafka group id is searchable.
		expect(body).toContain("streetlight-consumers");
		// But not as a "Bindings:" prose section.
		expect(body).not.toContain("Bindings:");
	});

	test("multiple message refs each render as a bullet in prose", () => {
		const yaml = `asyncapi: "3.0.0"
info: { title: T, version: "1" }
channels:
  events:
    address: events/topic
    messages:
      first: { name: first }
      second: { name: second }
      third: { name: third }
operations:
  multiSend:
    action: send
    channel:
      $ref: "#/channels/events"
    messages:
      - $ref: "#/channels/events/messages/first"
      - $ref: "#/channels/events/messages/second"
      - $ref: "#/channels/events/messages/third"
`;
		const parsed = parseYamlFile(yaml, "x.yaml");
		const op = parsed.headings.find((h) => h.pathText === "send multiSend");
		if (!op) throw new Error("expected send multiSend heading");
		const body = parsed.source.slice(op.bodyOffsetRange.start, op.bodyOffsetRange.end);
		expect(body).toContain("Messages:\n- first\n- second\n- third\n");
	});
});

describe("synthesizeAsyncApiFile — edge cases + fallback", () => {
	test("empty operations → preamble only, 0 operation headings", () => {
		const yaml = `asyncapi: "3.0.0"
info: { title: T, version: "1" }
operations: {}
`;
		const parsed = parseYamlFile(yaml, "x.yaml");
		expect(parsed.headings.filter(isOperationHeading)).toEqual([]);
		expect(parsed.preamble).toBeTruthy();
	});

	test("sparse asyncapi 3.x (no operations + no info + no channels) → opaque fallback (no silent drop)", () => {
		const yaml = 'asyncapi: "3.0.0"\nfoo: bar\n';
		const parsed = parseYamlFile(yaml, "x.yaml");
		expect(parsed.headings).toEqual([]);
		// Opaque emission: whole-source preamble covers the raw YAML.
		expect(parsed.preamble?.offsetRange).toEqual({ start: 0, end: yaml.length });
		const fm = parsed.frontmatter as Record<string, unknown>;
		expect(fm.asyncapi).toBe("3.0.0");
		expect(fm.foo).toBe("bar");
	});

	test("asyncapi 2.x falls through to opaque YAML emission", () => {
		const yaml = `asyncapi: "2.6.0"
info: { title: Legacy, version: "1" }
channels:
  legacy:
    publish:
      summary: 2.x publish op
      message:
        payload:
          type: object
`;
		const parsed = parseYamlFile(yaml, "x.yaml");
		// No synthesized operation headings — opaque emission.
		expect(parsed.headings).toEqual([]);
		// Whole-source preamble per the opaque pathway.
		expect(parsed.preamble?.offsetRange).toEqual({ start: 0, end: yaml.length });
		// Frontmatter still carries the document for filter queries.
		const fm = parsed.frontmatter as Record<string, unknown>;
		expect(fm.asyncapi).toBe("2.6.0");
	});

	test("channels-only spec (no operations) still synthesizes — Channels heading present", () => {
		const yaml = `asyncapi: "3.0.0"
info: { title: T, version: "1" }
channels:
  events:
    address: events/topic
    messages:
      msg: { name: m }
`;
		const parsed = parseYamlFile(yaml, "x.yaml");
		expect(parsed.headings.filter(isOperationHeading)).toEqual([]);
		expect(parsed.headings.find((h) => h.pathText === "Channels")).toBeDefined();
	});

	test("preamble caps at MAX_PREAMBLE_SERVERS with overflow marker", () => {
		const servers: Record<string, unknown> = {};
		for (let i = 0; i < 25; i++) {
			servers[`srv${i}`] = { host: `host${i}.example.com`, protocol: "kafka" };
		}
		const yaml = `asyncapi: "3.0.0"
info: { title: T, version: "1" }
servers: ${JSON.stringify(servers)}
operations:
  ping: { action: send }
`;
		const parsed = parseYamlFile(yaml, "x.yaml");
		const preamble = parsed.preamble;
		if (preamble === null) throw new Error("expected preamble");
		const slice = parsed.source.slice(preamble.offsetRange.start, preamble.offsetRange.end);
		// First 20 servers listed individually + overflow line.
		expect(slice).toContain("- srv0 (kafka): host0.example.com");
		expect(slice).toContain("- srv19 (kafka): host19.example.com");
		expect(slice).not.toContain("- srv20 (kafka): host20.example.com");
		expect(slice).toContain("- ... and 5 more");
	});

	test("servers with no host or protocol do not consume MAX_PREAMBLE_SERVERS slots", () => {
		// Partial inline shapes (description-only / bindings-only) carry no
		// endpoint info — gating them out of the cap stops them from pushing
		// real brokers past the 20-entry limit.
		const servers: Record<string, unknown> = {};
		for (let i = 0; i < 20; i++) {
			servers[`junk${i}`] = { description: `partial server ${i}` };
		}
		servers.real = { host: "real.example.com", protocol: "kafka" };
		const yaml = `asyncapi: "3.0.0"
info: { title: T, version: "1" }
servers: ${JSON.stringify(servers)}
operations:
  ping: { action: send }
`;
		const parsed = parseYamlFile(yaml, "x.yaml");
		const preamble = parsed.preamble;
		if (preamble === null) throw new Error("expected preamble");
		const slice = parsed.source.slice(preamble.offsetRange.start, preamble.offsetRange.end);
		expect(slice).toContain("- real (kafka): real.example.com");
		expect(slice).not.toContain("- junk0\n");
		expect(slice).not.toMatch(/and \d+ more/);
	});

	test("minimal draft with only non-renderable servers falls back to opaque YAML", () => {
		// Without the renderability gate, this draft emits a useless
		// `Servers:` block that blocks the opaque-YAML fallback.
		const yaml = 'asyncapi: "3.0.0"\nservers:\n  broker: 1\n';
		const parsed = parseYamlFile(yaml, "x.yaml");
		expect(parsed.headings).toEqual([]);
		expect(parsed.preamble?.offsetRange).toEqual({ start: 0, end: yaml.length });
		expect(parsed.source).not.toContain("Servers:");
	});

	test("synthesized source past MAX_SYNTHESIZED_SOURCE_BYTES falls back to opaque YAML", () => {
		// Fixture amplification computed from the cap so it scales if
		// `MAX_FILE_BYTES` moves. One shared trait description is referenced
		// by N ops; the YAML input stays small (~descBytes) while synthesis
		// would duplicate the description per op.
		const opCount = 250;
		const descBytes = Math.ceil((2 * MAX_FILE_BYTES) / opCount) + 1024;
		const traitDescription = "x".repeat(descBytes);
		const ops: Record<string, unknown> = {};
		for (let i = 0; i < opCount; i++) {
			ops[`op${i}`] = {
				action: "send",
				channel: { $ref: "#/channels/main" },
				traits: [{ $ref: "#/components/operationTraits/shared" }],
			};
		}
		const yaml = `asyncapi: "3.0.0"
info: { title: T, version: "1" }
channels:
  main:
    address: /main
operations: ${JSON.stringify(ops)}
components:
  operationTraits:
    shared:
      description: ${JSON.stringify(traitDescription)}
`;
		const parsed = parseYamlFile(yaml, "x.yaml");
		// `source === yaml` is stronger than just `headings: []` — pins that
		// synthesis tried and bailed, not that detection failed.
		expect(parsed.source).toBe(yaml);
		expect(parsed.headings).toEqual([]);
		expect(parsed.preamble?.offsetRange).toEqual({ start: 0, end: yaml.length });
	});
});

describe("synthesizeAsyncApiFile — Reference Object form for operations", () => {
	test("intra-doc $ref to components.operations.X is dereferenced and the op gets a heading", () => {
		const yaml = `asyncapi: "3.0.0"
info: { title: T, version: "1" }
channels:
  signup:
    address: user/signup
operations:
  receiveSignup:
    $ref: "#/components/operations/receiveSignup"
components:
  operations:
    receiveSignup:
      action: receive
      channel:
        $ref: "#/channels/signup"
      summary: Listen for sign-ups
`;
		const parsed = parseYamlFile(yaml, "x.yaml");
		const heading = parsed.headings.find((h) => h.pathText === "receive receiveSignup");
		if (!heading) throw new Error("expected receive receiveSignup heading");
		expect(heading.structuralPath).toMatch(/^op\[[0-9a-f]{14}\]$/);
		const body = parsed.source.slice(heading.bodyOffsetRange.start, heading.bodyOffsetRange.end);
		expect(body).toContain("Listen for sign-ups");
		expect(body).toContain("Channel: user/signup");
	});

	test("external $ref-form operation emits a degraded `external <name>` heading + raw $ref fence", () => {
		const yaml = `asyncapi: "3.0.0"
info: { title: T, version: "1" }
operations:
  foo:
    $ref: "./shared.yaml#/operations/foo"
  realOp:
    action: send
    summary: A real local operation
`;
		const parsed = parseYamlFile(yaml, "x.yaml");
		const texts = parsed.headings.filter(isOperationHeading).map((h) => h.pathText);
		// External-ref ops now get their own heading so per-op navigation works
		// for specs that factor operations into shared YAML.
		expect(texts).toEqual(["external foo", "send realOp"]);
	});

	test("stable_id uses the outer map-key opName, not the ref target", () => {
		const inlineYaml = `asyncapi: "3.0.0"
info: { title: T, version: "1" }
operations:
  outerName:
    action: send
`;
		const refYaml = `asyncapi: "3.0.0"
info: { title: T, version: "1" }
operations:
  outerName:
    $ref: "#/components/operations/inner"
components:
  operations:
    inner:
      action: send
`;
		const a = parseYamlFile(inlineYaml, "x.yaml");
		const b = parseYamlFile(refYaml, "x.yaml");
		// Same outer map key → same stable_id, regardless of where the body lives.
		expect(a.headings[0]?.stable_id).toBe(b.headings[0]?.stable_id);
	});
});

describe("synthesizeAsyncApiFile — reply.address.location", () => {
	test("address-only reply renders the runtime expression as `- Address:`", () => {
		const yaml = `asyncapi: "3.0.0"
info: { title: T, version: "1" }
channels:
  ping:
    address: rpc/ping
operations:
  askPing:
    action: send
    channel:
      $ref: "#/channels/ping"
    reply:
      address:
        location: "$message.header#/replyTo"
`;
		const parsed = parseYamlFile(yaml, "x.yaml");
		const op = parsed.headings.find((h) => h.pathText === "send askPing");
		if (!op) throw new Error("expected send askPing heading");
		const body = parsed.source.slice(op.bodyOffsetRange.start, op.bodyOffsetRange.end);
		expect(body).toContain("Reply:");
		expect(body).toContain("- Address: $message.header#/replyTo");
		// No channel line under Reply since reply.channel was omitted.
		const replyLines = body.slice(body.indexOf("Reply:")).split("\n");
		expect(replyLines.some((line) => line.startsWith("- Channel:"))).toBe(false);
	});

	test("address + channel + messages reply emits all three lines, address first", () => {
		const yaml = `asyncapi: "3.0.0"
info: { title: T, version: "1" }
channels:
  req:
    address: rpc/req
    messages:
      m: {}
  rsp:
    address: rpc/rsp
    messages:
      m: {}
operations:
  full:
    action: send
    channel:
      $ref: "#/channels/req"
    reply:
      address:
        location: "$message.header#/replyTo"
      channel:
        $ref: "#/channels/rsp"
      messages:
        - $ref: "#/channels/rsp/messages/m"
`;
		const parsed = parseYamlFile(yaml, "x.yaml");
		const op = parsed.headings.find((h) => h.pathText === "send full");
		if (!op) throw new Error("expected send full heading");
		const body = parsed.source.slice(op.bodyOffsetRange.start, op.bodyOffsetRange.end);
		const replyBlock = body.slice(body.indexOf("Reply:"));
		const addrIdx = replyBlock.indexOf("- Address: $message.header#/replyTo");
		const chanIdx = replyBlock.indexOf("- Channel: rpc/rsp");
		const msgIdx = replyBlock.indexOf("- Message: m");
		expect(addrIdx).toBeGreaterThan(-1);
		expect(chanIdx).toBeGreaterThan(addrIdx);
		expect(msgIdx).toBeGreaterThan(chanIdx);
	});
});

describe("synthesizeAsyncApiFile — Message.name vs messageId", () => {
	test("declared Message.name differs from messageId → bullet shows `messageId (name)`", () => {
		const yaml = `asyncapi: "3.0.0"
info: { title: T, version: "1" }
channels:
  events:
    address: events/topic
    messages:
      createdEvent:
        name: user.created
        summary: User created event
operations:
  emitCreated:
    action: send
    channel:
      $ref: "#/channels/events"
    messages:
      - $ref: "#/channels/events/messages/createdEvent"
`;
		const parsed = parseYamlFile(yaml, "x.yaml");
		const op = parsed.headings.find((h) => h.pathText === "send emitCreated");
		if (!op) throw new Error("expected send emitCreated heading");
		const body = parsed.source.slice(op.bodyOffsetRange.start, op.bodyOffsetRange.end);
		expect(body).toContain("- createdEvent (user.created)");
	});

	test("Message.name equal to messageId → no parenthesized suffix", () => {
		const yaml = `asyncapi: "3.0.0"
info: { title: T, version: "1" }
channels:
  events:
    address: events/topic
    messages:
      foo:
        name: foo
operations:
  send:
    action: send
    channel:
      $ref: "#/channels/events"
    messages:
      - $ref: "#/channels/events/messages/foo"
`;
		const parsed = parseYamlFile(yaml, "x.yaml");
		const op = parsed.headings.find((h) => h.pathText === "send send");
		if (!op) throw new Error("expected send send heading");
		const body = parsed.source.slice(op.bodyOffsetRange.start, op.bodyOffsetRange.end);
		expect(body).toContain("Messages:\n- foo\n");
		expect(body).not.toContain("- foo (foo)");
	});

	test("missing Message.name → fall back to messageId alone (no parens)", () => {
		const yaml = `asyncapi: "3.0.0"
info: { title: T, version: "1" }
channels:
  events:
    address: events/topic
    messages:
      bar:
        summary: No name field
operations:
  emit:
    action: send
    channel:
      $ref: "#/channels/events"
    messages:
      - $ref: "#/channels/events/messages/bar"
`;
		const parsed = parseYamlFile(yaml, "x.yaml");
		const op = parsed.headings.find((h) => h.pathText === "send emit");
		if (!op) throw new Error("expected send emit heading");
		const body = parsed.source.slice(op.bodyOffsetRange.start, op.bodyOffsetRange.end);
		expect(body).toContain("- bar\n");
		expect(body).not.toContain("- bar (");
	});
});

describe("synthesizeAsyncApiFile — slug deduplication", () => {
	test("colliding slugs deduplicate within the file (github-slugger algorithm)", () => {
		// `send my.op` and `send my-op` both slug to `send-my-op`.
		const yaml = `asyncapi: "3.0.0"
info: { title: T, version: "1" }
operations:
  "my-op": { action: send }
  "my.op": { action: send }
`;
		const parsed = parseYamlFile(yaml, "x.yaml");
		const slugs = parsed.headings.filter(isOperationHeading).map((h) => h.slug);
		expect(new Set(slugs).size).toBe(slugs.length);
		expect(slugs[0]).toBe("send-my-op");
		expect(slugs[1]).toBe("send-my-op-1");
	});
});

describe("synthesizeAsyncApiFile — Reference Object channels", () => {
	test("root channel entry as $ref → dereferences through components.channels", () => {
		const yaml = `asyncapi: "3.0.0"
info: { title: T, version: "1" }
channels:
  signup:
    $ref: "#/components/channels/signup"
operations:
  receive:
    action: receive
    channel:
      $ref: "#/channels/signup"
components:
  channels:
    signup:
      address: user/signup
      messages:
        signedUp:
          name: user.signedUp
`;
		const parsed = parseYamlFile(yaml, "x.yaml");
		const op = parsed.headings.find((h) => h.pathText === "receive receive");
		if (!op) throw new Error("expected receive receive heading");
		const body = parsed.source.slice(op.bodyOffsetRange.start, op.bodyOffsetRange.end);
		expect(body).toContain("Channel: user/signup");
		expect(body).not.toContain("Channel: #/channels/signup");
	});
});

describe("synthesizeAsyncApiFile — Reference Object reply / reply.address", () => {
	test("operation.reply as $ref → dereferences through components.replies", () => {
		const yaml = `asyncapi: "3.0.0"
info: { title: T, version: "1" }
channels:
  req:
    address: rpc/req
  rsp:
    address: rpc/rsp
operations:
  ask:
    action: send
    channel:
      $ref: "#/channels/req"
    reply:
      $ref: "#/components/replies/standardAck"
components:
  replies:
    standardAck:
      address:
        location: "$message.header#/replyTo"
      channel:
        $ref: "#/channels/rsp"
`;
		const parsed = parseYamlFile(yaml, "x.yaml");
		const op = parsed.headings.find((h) => h.pathText === "send ask");
		if (!op) throw new Error("expected send ask heading");
		const body = parsed.source.slice(op.bodyOffsetRange.start, op.bodyOffsetRange.end);
		expect(body).toContain("Reply:");
		expect(body).toContain("- Address: $message.header#/replyTo");
		expect(body).toContain("- Channel: rpc/rsp");
	});

	test("reply.address as $ref → dereferences through components.replyAddresses", () => {
		const yaml = `asyncapi: "3.0.0"
info: { title: T, version: "1" }
channels:
  ping:
    address: rpc/ping
operations:
  beat:
    action: send
    channel:
      $ref: "#/channels/ping"
    reply:
      address:
        $ref: "#/components/replyAddresses/dynamicReply"
components:
  replyAddresses:
    dynamicReply:
      location: "$message.header#/replyTo"
`;
		const parsed = parseYamlFile(yaml, "x.yaml");
		const op = parsed.headings.find((h) => h.pathText === "send beat");
		if (!op) throw new Error("expected send beat heading");
		const body = parsed.source.slice(op.bodyOffsetRange.start, op.bodyOffsetRange.end);
		expect(body).toContain("Reply:");
		expect(body).toContain("- Address: $message.header#/replyTo");
	});
});

describe("synthesizeAsyncApiFile — implicit messages from channel", () => {
	test("omitted op.messages → all channel messages rendered as bullets", () => {
		const yaml = `asyncapi: "3.0.0"
info: { title: T, version: "1" }
channels:
  bus:
    address: events/bus
    messages:
      alpha:
        name: alpha.event
      beta: {}
operations:
  broadcast:
    action: send
    channel:
      $ref: "#/channels/bus"
`;
		const parsed = parseYamlFile(yaml, "x.yaml");
		const op = parsed.headings.find((h) => h.pathText === "send broadcast");
		if (!op) throw new Error("expected send broadcast heading");
		const body = parsed.source.slice(op.bodyOffsetRange.start, op.bodyOffsetRange.end);
		expect(body).toContain("Messages:");
		expect(body).toContain("- alpha (alpha.event)");
		expect(body).toContain("- beta");
	});

	test("explicit empty op.messages: [] → no Messages block (distinguishes from omitted)", () => {
		const yaml = `asyncapi: "3.0.0"
info: { title: T, version: "1" }
channels:
  bus:
    address: events/bus
    messages:
      alpha: {}
operations:
  quiet:
    action: send
    channel:
      $ref: "#/channels/bus"
    messages: []
`;
		const parsed = parseYamlFile(yaml, "x.yaml");
		const op = parsed.headings.find((h) => h.pathText === "send quiet");
		if (!op) throw new Error("expected send quiet heading");
		const body = parsed.source.slice(op.bodyOffsetRange.start, op.bodyOffsetRange.end);
		expect(body).not.toContain("Messages:");
		expect(body).not.toContain("- alpha");
	});
});

describe("synthesizeAsyncApiFile — external-ref operations surface as own headings", () => {
	test("external-ref operation has its own heading with the raw $ref preserved in source", () => {
		const yaml = `asyncapi: "3.0.0"
info: { title: T, version: "1" }
channels:
  ping:
    address: rpc/ping
operations:
  local:
    action: send
    channel:
      $ref: "#/channels/ping"
  remote:
    $ref: "./external.yaml#/operations/foo"
`;
		const parsed = parseYamlFile(yaml, "x.yaml");
		const opHeadings = parsed.headings.filter(isOperationHeading).map((h) => h.pathText);
		// External-ref op emits a degraded heading instead of falling through to
		// `## Spec metadata` — preserves per-op `get_fragment` navigability.
		// Ops sorted alphabetically by opName, NOT by action prefix: local < remote.
		expect(opHeadings).toEqual(["send local", "external remote"]);
		expect(parsed.source).toContain("./external.yaml#/operations/foo");
	});
});

describe("synthesizeAsyncApiFile — percent-decoded ref segments", () => {
	test("$ref with %20 in segment decodes to literal space and resolves the channel", () => {
		const yaml = `asyncapi: "3.0.0"
info: { title: T, version: "1" }
channels:
  "user signups":
    address: queue/user signups
operations:
  receive:
    action: receive
    channel:
      $ref: "#/channels/user%20signups"
`;
		const parsed = parseYamlFile(yaml, "x.yaml");
		const op = parsed.headings.find((h) => h.pathText === "receive receive");
		if (!op) throw new Error("expected receive receive heading");
		const body = parsed.source.slice(op.bodyOffsetRange.start, op.bodyOffsetRange.end);
		expect(body).toContain("Channel: queue/user signups");
	});
});

describe("synthesizeAsyncApiFile — components-bucket channel refs", () => {
	test("operation channel referencing #/components/channels/X resolves the address", () => {
		const yaml = `asyncapi: "3.0.0"
info: { title: T, version: "1" }
components:
  channels:
    shared:
      address: events/shared
      messages:
        ping:
          name: ping.event
operations:
  notify:
    action: send
    channel:
      $ref: "#/components/channels/shared"
`;
		const parsed = parseYamlFile(yaml, "x.yaml");
		const op = parsed.headings.find((h) => h.pathText === "send notify");
		if (!op) throw new Error("expected send notify heading");
		const body = parsed.source.slice(op.bodyOffsetRange.start, op.bodyOffsetRange.end);
		expect(body).toContain("Channel: events/shared");
	});

	test("message ref via #/components/channels/<chan>/messages/<msg> resolves the bullet", () => {
		const yaml = `asyncapi: "3.0.0"
info: { title: T, version: "1" }
components:
  channels:
    shared:
      address: events/shared
      messages:
        ping:
          name: ping.event
operations:
  notify:
    action: send
    channel:
      $ref: "#/components/channels/shared"
    messages:
      - $ref: "#/components/channels/shared/messages/ping"
`;
		const parsed = parseYamlFile(yaml, "x.yaml");
		const op = parsed.headings.find((h) => h.pathText === "send notify");
		if (!op) throw new Error("expected send notify heading");
		const body = parsed.source.slice(op.bodyOffsetRange.start, op.bodyOffsetRange.end);
		expect(body).toContain("Messages:");
		expect(body).toContain("- ping (ping.event)");
	});

	test("omitted messages inherits from a #/components/channels/X channel", () => {
		const yaml = `asyncapi: "3.0.0"
info: { title: T, version: "1" }
components:
  channels:
    shared:
      address: events/shared
      messages:
        alpha:
          name: alpha.event
        beta: {}
operations:
  broadcast:
    action: send
    channel:
      $ref: "#/components/channels/shared"
`;
		const parsed = parseYamlFile(yaml, "x.yaml");
		const op = parsed.headings.find((h) => h.pathText === "send broadcast");
		if (!op) throw new Error("expected send broadcast heading");
		const body = parsed.source.slice(op.bodyOffsetRange.start, op.bodyOffsetRange.end);
		expect(body).toContain("- alpha (alpha.event)");
		expect(body).toContain("- beta");
	});
});

describe("synthesizeAsyncApiFile — channel address null/absent disambiguation", () => {
	test('resolved channel with address: null renders "<id> (address unknown)"', () => {
		const yaml = `asyncapi: "3.0.0"
info: { title: T, version: "1" }
channels:
  userSignup:
    address: null
    messages:
      signup: {}
operations:
  notify:
    action: send
    channel:
      $ref: "#/channels/userSignup"
`;
		const parsed = parseYamlFile(yaml, "x.yaml");
		const op = parsed.headings.find((h) => h.pathText === "send notify");
		if (!op) throw new Error("expected send notify heading");
		const body = parsed.source.slice(op.bodyOffsetRange.start, op.bodyOffsetRange.end);
		expect(body).toContain("Channel: userSignup (address unknown)");
		expect(body).not.toContain("Channel: #/channels/userSignup");
	});

	test('resolved channel with address omitted entirely renders "<id> (address unknown)"', () => {
		const yaml = `asyncapi: "3.0.0"
info: { title: T, version: "1" }
channels:
  emitOnly:
    messages:
      ping: {}
operations:
  emit:
    action: send
    channel:
      $ref: "#/channels/emitOnly"
`;
		const parsed = parseYamlFile(yaml, "x.yaml");
		const op = parsed.headings.find((h) => h.pathText === "send emit");
		if (!op) throw new Error("expected send emit heading");
		const body = parsed.source.slice(op.bodyOffsetRange.start, op.bodyOffsetRange.end);
		expect(body).toContain("Channel: emitOnly (address unknown)");
		expect(body).not.toContain("Channel: #/channels/emitOnly");
	});

	test("resolved channel WITH address renders the address verbatim (no disambiguator)", () => {
		const yaml = `asyncapi: "3.0.0"
info: { title: T, version: "1" }
channels:
  measured:
    address: /v1/events
operations:
  emit:
    action: send
    channel:
      $ref: "#/channels/measured"
`;
		const parsed = parseYamlFile(yaml, "x.yaml");
		const op = parsed.headings.find((h) => h.pathText === "send emit");
		if (!op) throw new Error("expected send emit heading");
		const body = parsed.source.slice(op.bodyOffsetRange.start, op.bodyOffsetRange.end);
		expect(body).toContain("Channel: /v1/events");
		expect(body).not.toContain("(address unknown)");
	});

	test("truly external channel ref still renders the raw $ref string (no disambiguator)", () => {
		const yaml = `asyncapi: "3.0.0"
info: { title: T, version: "1" }
operations:
  notify:
    action: send
    channel:
      $ref: "./other.yaml#/channels/foreign"
`;
		const parsed = parseYamlFile(yaml, "x.yaml");
		const op = parsed.headings.find((h) => h.pathText === "send notify");
		if (!op) throw new Error("expected send notify heading");
		const body = parsed.source.slice(op.bodyOffsetRange.start, op.bodyOffsetRange.end);
		expect(body).toContain("Channel: ./other.yaml#/channels/foreign");
		expect(body).not.toContain("(address unknown)");
	});

	test('reply channel with null address renders "- Channel: <id> (address unknown)"', () => {
		const yaml = `asyncapi: "3.0.0"
info: { title: T, version: "1" }
channels:
  q:
    address: rpc/q
  chatRoom:
    address: null
operations:
  call:
    action: send
    channel:
      $ref: "#/channels/q"
    reply:
      channel:
        $ref: "#/channels/chatRoom"
`;
		const parsed = parseYamlFile(yaml, "x.yaml");
		const op = parsed.headings.find((h) => h.pathText === "send call");
		if (!op) throw new Error("expected send call heading");
		const body = parsed.source.slice(op.bodyOffsetRange.start, op.bodyOffsetRange.end);
		expect(body).toContain("- Channel: chatRoom (address unknown)");
	});
});

describe("synthesizeAsyncApiFile — external reply refs render verbatim", () => {
	test("external $ref on op.reply renders a single Reply line with the raw ref", () => {
		const yaml = `asyncapi: "3.0.0"
info: { title: T, version: "1" }
channels:
  q:
    address: rpc/q
operations:
  call:
    action: send
    channel:
      $ref: "#/channels/q"
    reply:
      $ref: "./external.yaml#/replies/standardAck"
`;
		const parsed = parseYamlFile(yaml, "x.yaml");
		const op = parsed.headings.find((h) => h.pathText === "send call");
		if (!op) throw new Error("expected send call heading");
		const body = parsed.source.slice(op.bodyOffsetRange.start, op.bodyOffsetRange.end);
		expect(body).toContain("Reply: ./external.yaml#/replies/standardAck");
	});

	test("external $ref on reply.address renders an Address bullet with the raw ref", () => {
		const yaml = `asyncapi: "3.0.0"
info: { title: T, version: "1" }
channels:
  q:
    address: rpc/q
  replyChan:
    address: rpc/reply
operations:
  call:
    action: send
    channel:
      $ref: "#/channels/q"
    reply:
      channel:
        $ref: "#/channels/replyChan"
      address:
        $ref: "./external.yaml#/replyAddresses/standardReplyTo"
`;
		const parsed = parseYamlFile(yaml, "x.yaml");
		const op = parsed.headings.find((h) => h.pathText === "send call");
		if (!op) throw new Error("expected send call heading");
		const body = parsed.source.slice(op.bodyOffsetRange.start, op.bodyOffsetRange.end);
		expect(body).toContain("Reply:");
		expect(body).toContain("- Address: ./external.yaml#/replyAddresses/standardReplyTo");
		expect(body).toContain("- Channel: rpc/reply");
	});

	test("intra-doc reply ref still resolves through components.replies", () => {
		const yaml = `asyncapi: "3.0.0"
info: { title: T, version: "1" }
channels:
  q:
    address: rpc/q
  replyChan:
    address: rpc/reply
components:
  replies:
    ack:
      channel:
        $ref: "#/channels/replyChan"
      address:
        location: $message.header#/correlationId
operations:
  call:
    action: send
    channel:
      $ref: "#/channels/q"
    reply:
      $ref: "#/components/replies/ack"
`;
		const parsed = parseYamlFile(yaml, "x.yaml");
		const op = parsed.headings.find((h) => h.pathText === "send call");
		if (!op) throw new Error("expected send call heading");
		const body = parsed.source.slice(op.bodyOffsetRange.start, op.bodyOffsetRange.end);
		expect(body).toContain("Reply:");
		expect(body).toContain("- Address: $message.header#/correlationId");
		expect(body).toContain("- Channel: rpc/reply");
		expect(body).not.toContain("Reply: #/components/replies/ack");
	});
});

describe("synthesizeAsyncApiFile — operation trait merge", () => {
	test("summary, description, and tags from a referenced trait surface in prose", () => {
		const yaml = `asyncapi: "3.0.0"
info: { title: T, version: "1" }
channels:
  q:
    address: rpc/q
components:
  operationTraits:
    common:
      summary: Common operation summary
      description: Shared description for reuse.
      tags:
        - name: shared
        - name: rpc
operations:
  notify:
    action: send
    channel:
      $ref: "#/channels/q"
    traits:
      - $ref: "#/components/operationTraits/common"
`;
		const parsed = parseYamlFile(yaml, "x.yaml");
		const op = parsed.headings.find((h) => h.pathText === "send notify");
		if (!op) throw new Error("expected send notify heading");
		const body = parsed.source.slice(op.bodyOffsetRange.start, op.bodyOffsetRange.end);
		expect(body).toContain("Summary: Common operation summary");
		expect(body).toContain("Shared description for reuse.");
		expect(body).toContain("Tags: shared, rpc");
	});

	test("inline operation field overrides a colliding trait field (target wins)", () => {
		const yaml = `asyncapi: "3.0.0"
info: { title: T, version: "1" }
channels:
  q:
    address: rpc/q
components:
  operationTraits:
    common:
      summary: Trait summary
operations:
  notify:
    action: send
    channel:
      $ref: "#/channels/q"
    summary: Inline summary
    traits:
      - $ref: "#/components/operationTraits/common"
`;
		const parsed = parseYamlFile(yaml, "x.yaml");
		const op = parsed.headings.find((h) => h.pathText === "send notify");
		if (!op) throw new Error("expected send notify heading");
		const body = parsed.source.slice(op.bodyOffsetRange.start, op.bodyOffsetRange.end);
		expect(body).toContain("Summary: Inline summary");
		expect(body).not.toContain("Summary: Trait summary");
	});

	test("op `field: null` over a trait-provided value preserves null (atomic-leaf, NOT RFC 7396 delete)", () => {
		// AsyncAPI 3 references JSON Merge Patch for trait merging but is silent
		// on RFC 7396 §2.2's null-as-delete clause; ecosystem parsers (parser-js,
		// Studio, code generators) treat null as an atomic scalar leaf.
		const yaml = `asyncapi: "3.0.0"
info: { title: T, version: "1" }
channels:
  q:
    address: rpc/q
components:
  operationTraits:
    withSummary:
      summary: should_not_appear
operations:
  emit:
    action: send
    channel:
      $ref: "#/channels/q"
    summary: null
    traits:
      - $ref: "#/components/operationTraits/withSummary"
`;
		const parsed = parseYamlFile(yaml, "x.yaml");
		expect(parsed.source).not.toContain("Summary: should_not_appear");
		const fenceJson = JSON.parse(readFenceBody(parsed, "send emit"));
		expect(fenceJson.summary).toBeNull();
	});

	test("later trait wins on collision among multiple traits", () => {
		const yaml = `asyncapi: "3.0.0"
info: { title: T, version: "1" }
channels:
  q:
    address: rpc/q
components:
  operationTraits:
    earlier:
      summary: Earlier summary
    later:
      summary: Later summary
operations:
  notify:
    action: send
    channel:
      $ref: "#/channels/q"
    traits:
      - $ref: "#/components/operationTraits/earlier"
      - $ref: "#/components/operationTraits/later"
`;
		const parsed = parseYamlFile(yaml, "x.yaml");
		const op = parsed.headings.find((h) => h.pathText === "send notify");
		if (!op) throw new Error("expected send notify heading");
		const body = parsed.source.slice(op.bodyOffsetRange.start, op.bodyOffsetRange.end);
		expect(body).toContain("Summary: Later summary");
		expect(body).not.toContain("Summary: Earlier summary");
	});

	test("inline traits (no $ref) merge into the operation", () => {
		const yaml = `asyncapi: "3.0.0"
info: { title: T, version: "1" }
channels:
  q:
    address: rpc/q
operations:
  notify:
    action: send
    channel:
      $ref: "#/channels/q"
    traits:
      - description: Inline-trait description
`;
		const parsed = parseYamlFile(yaml, "x.yaml");
		const op = parsed.headings.find((h) => h.pathText === "send notify");
		if (!op) throw new Error("expected send notify heading");
		const body = parsed.source.slice(op.bodyOffsetRange.start, op.bodyOffsetRange.end);
		expect(body).toContain("Inline-trait description");
	});
});

describe("synthesizeAsyncApiFile — ref-form servers in preamble", () => {
	test("server entry as Reference Object resolves protocol/host from components.servers", () => {
		const yaml = `asyncapi: "3.0.0"
info: { title: T, version: "1" }
servers:
  production:
    $ref: "#/components/servers/prod"
components:
  servers:
    prod:
      host: broker.example.com
      protocol: kafka
channels:
  q:
    address: rpc/q
operations:
  notify:
    action: send
    channel:
      $ref: "#/channels/q"
`;
		const parsed = parseYamlFile(yaml, "x.yaml");
		if (parsed.preamble === null) throw new Error("expected preamble");
		const preamble = parsed.source.slice(parsed.preamble.offsetRange.start, parsed.preamble.offsetRange.end);
		expect(preamble).toContain("- production (kafka): broker.example.com");
		expect(preamble).not.toMatch(/- production\n/);
	});

	test("inline server still works alongside ref-form siblings", () => {
		const yaml = `asyncapi: "3.0.0"
info: { title: T, version: "1" }
servers:
  staging:
    host: staging.example.com
    protocol: amqp
  production:
    $ref: "#/components/servers/prod"
components:
  servers:
    prod:
      host: broker.example.com
      protocol: kafka
channels:
  q:
    address: rpc/q
operations:
  notify:
    action: send
    channel:
      $ref: "#/channels/q"
`;
		const parsed = parseYamlFile(yaml, "x.yaml");
		if (parsed.preamble === null) throw new Error("expected preamble");
		const preamble = parsed.source.slice(parsed.preamble.offsetRange.start, parsed.preamble.offsetRange.end);
		expect(preamble).toContain("- staging (amqp): staging.example.com");
		expect(preamble).toContain("- production (kafka): broker.example.com");
	});
});

describe("synthesizeAsyncApiFile — heading text normalization", () => {
	test("operation name with repeated whitespace collapses in pathText + headingPath; displayText raw", () => {
		const yaml = `asyncapi: "3.0.0"
info: { title: T, version: "1" }
channels:
  q:
    address: rpc/q
operations:
  "user  signedUp":
    action: send
    channel:
      $ref: "#/channels/q"
`;
		const parsed = parseYamlFile(yaml, "x.yaml");
		const ops = parsed.headings.filter(isOperationHeading);
		expect(ops.length).toBe(1);
		const op = ops[0];
		if (!op) throw new Error("expected one operation heading");
		expect(op.pathText).toBe("send user signedUp");
		expect(op.displayText).toBe("send user  signedUp");
		expect(op.headingPath).toEqual(["send user signedUp"]);
	});
});

describe("synthesizeAsyncApiFile — chained-ref handling", () => {
	test("chained reply ref (components.replies.X is itself a $ref) renders the op-level ref verbatim", () => {
		const yaml = `asyncapi: "3.0.0"
info: { title: T, version: "1" }
channels:
  q:
    address: rpc/q
components:
  replies:
    ack:
      $ref: "./shared.yaml#/replies/ack"
operations:
  call:
    action: send
    channel:
      $ref: "#/channels/q"
    reply:
      $ref: "#/components/replies/ack"
`;
		const parsed = parseYamlFile(yaml, "x.yaml");
		const op = parsed.headings.find((h) => h.pathText === "send call");
		if (!op) throw new Error("expected send call heading");
		const body = parsed.source.slice(op.bodyOffsetRange.start, op.bodyOffsetRange.end);
		expect(body).toContain("Reply: #/components/replies/ack");
		// The chained intermediate (the external pointer the component aliased
		// to) must not surface — only one Reply: line with the op-level ref.
		expect(body).not.toContain("./shared.yaml");
	});

	test("chained reply.address ref renders inside Reply block as raw $ref bullet", () => {
		const yaml = `asyncapi: "3.0.0"
info: { title: T, version: "1" }
channels:
  q:
    address: rpc/q
  replyChan:
    address: rpc/reply
components:
  replyAddresses:
    standard:
      $ref: "./shared.yaml#/replyAddresses/standard"
operations:
  call:
    action: send
    channel:
      $ref: "#/channels/q"
    reply:
      channel:
        $ref: "#/channels/replyChan"
      address:
        $ref: "#/components/replyAddresses/standard"
`;
		const parsed = parseYamlFile(yaml, "x.yaml");
		const op = parsed.headings.find((h) => h.pathText === "send call");
		if (!op) throw new Error("expected send call heading");
		const body = parsed.source.slice(op.bodyOffsetRange.start, op.bodyOffsetRange.end);
		expect(body).toContain("Reply:");
		expect(body).toContain("- Address: #/components/replyAddresses/standard");
		expect(body).toContain("- Channel: rpc/reply");
	});

	test("external root channel ref renders the op-level $ref verbatim (no map-key fabrication)", () => {
		const yaml = `asyncapi: "3.0.0"
info: { title: T, version: "1" }
channels:
  q:
    $ref: "./shared.yaml#/channels/q"
operations:
  call:
    action: send
    channel:
      $ref: "#/channels/q"
`;
		const parsed = parseYamlFile(yaml, "x.yaml");
		const op = parsed.headings.find((h) => h.pathText === "send call");
		if (!op) throw new Error("expected send call heading");
		const body = parsed.source.slice(op.bodyOffsetRange.start, op.bodyOffsetRange.end);
		expect(body).toContain("Channel: #/channels/q");
		// Map-key fallback (`Channel: q`) must NOT fire when the channel is
		// itself an unresolvable ref — the channel isn't actually inline.
		expect(body).not.toMatch(/Channel: q\n/);
	});

	test("external server ref renders raw $ref in preamble (not bare `- name`)", () => {
		const yaml = `asyncapi: "3.0.0"
info: { title: T, version: "1" }
servers:
  production:
    $ref: "./shared.yaml#/servers/prod"
channels:
  q:
    address: rpc/q
operations:
  notify:
    action: send
    channel:
      $ref: "#/channels/q"
`;
		const parsed = parseYamlFile(yaml, "x.yaml");
		if (parsed.preamble === null) throw new Error("expected preamble");
		const preamble = parsed.source.slice(parsed.preamble.offsetRange.start, parsed.preamble.offsetRange.end);
		expect(preamble).toContain("- production: ./shared.yaml#/servers/prod");
		expect(preamble).not.toMatch(/- production\n/);
	});

	test("chained intra-doc server ref renders the input ref verbatim in preamble", () => {
		const yaml = `asyncapi: "3.0.0"
info: { title: T, version: "1" }
servers:
  staging:
    $ref: "#/components/servers/staging"
components:
  servers:
    staging:
      $ref: "./shared.yaml#/servers/staging"
channels:
  q:
    address: rpc/q
operations:
  notify:
    action: send
    channel:
      $ref: "#/channels/q"
`;
		const parsed = parseYamlFile(yaml, "x.yaml");
		if (parsed.preamble === null) throw new Error("expected preamble");
		const preamble = parsed.source.slice(parsed.preamble.offsetRange.start, parsed.preamble.offsetRange.end);
		expect(preamble).toContain("- staging: #/components/servers/staging");
		// The chained external target must not leak into the preamble.
		expect(preamble).not.toContain("./shared.yaml");
	});

	test("component-bucket tag ref resolves to inline target on both info and operation", () => {
		const yaml = `asyncapi: "3.0.0"
info:
  title: T
  version: "1"
  tags:
    - $ref: "#/components/tags/auth"
components:
  tags:
    auth:
      name: auth
      description: Authentication-related operations.
channels:
  q:
    address: rpc/q
operations:
  notify:
    action: send
    channel:
      $ref: "#/channels/q"
    tags:
      - $ref: "#/components/tags/auth"
`;
		const parsed = parseYamlFile(yaml, "x.yaml");
		if (parsed.preamble === null) throw new Error("expected preamble");
		const preamble = parsed.source.slice(parsed.preamble.offsetRange.start, parsed.preamble.offsetRange.end);
		expect(preamble).toContain("Tags: auth");
		const op = parsed.headings.find((h) => h.pathText === "send notify");
		if (!op) throw new Error("expected send notify heading");
		const body = parsed.source.slice(op.bodyOffsetRange.start, op.bodyOffsetRange.end);
		expect(body).toContain("Tags: auth");
	});

	test("chained-ref tag drops silently (no Tags: line, no fabricated text)", () => {
		const yaml = `asyncapi: "3.0.0"
info:
  title: T
  version: "1"
  tags:
    - $ref: "#/components/tags/chained"
components:
  tags:
    chained:
      $ref: "./shared.yaml#/tags/chained"
channels:
  q:
    address: rpc/q
operations:
  notify:
    action: send
    channel:
      $ref: "#/channels/q"
`;
		const parsed = parseYamlFile(yaml, "x.yaml");
		if (parsed.preamble === null) throw new Error("expected preamble");
		const preamble = parsed.source.slice(parsed.preamble.offsetRange.start, parsed.preamble.offsetRange.end);
		// Anchor: preamble rendered (title line present) but the tag specifically dropped.
		expect(preamble).toContain("# T");
		expect(preamble).not.toContain("Tags:");
		expect(preamble).not.toContain("./shared.yaml");
	});

	test("inline reply with inline components.replies entry still renders the full Reply block", () => {
		// Regression guard: the chained-ref guard must NOT make
		// `dereferenceComponent` return null for genuinely inline targets.
		const yaml = `asyncapi: "3.0.0"
info: { title: T, version: "1" }
channels:
  q:
    address: rpc/q
  replyChan:
    address: rpc/reply
components:
  replies:
    ack:
      channel:
        $ref: "#/channels/replyChan"
      address:
        location: $message.header#/correlationId
operations:
  call:
    action: send
    channel:
      $ref: "#/channels/q"
    reply:
      $ref: "#/components/replies/ack"
`;
		const parsed = parseYamlFile(yaml, "x.yaml");
		const op = parsed.headings.find((h) => h.pathText === "send call");
		if (!op) throw new Error("expected send call heading");
		const body = parsed.source.slice(op.bodyOffsetRange.start, op.bodyOffsetRange.end);
		expect(body).toContain("Reply:");
		expect(body).toContain("- Address: $message.header#/correlationId");
		expect(body).toContain("- Channel: rpc/reply");
		// Verbatim Reply: line must NOT fire when the chain resolves to inline.
		expect(body).not.toContain("Reply: #/components/replies/ack");
	});
});

describe("synthesizeAsyncApiFile — components-bucket message refs", () => {
	test("#/components/messages/<msg> ref renders bullet using component-key name", () => {
		const yaml = `asyncapi: "3.0.0"
info:
  title: T
  version: "1"
channels:
  q:
    address: /q
operations:
  send_auth:
    action: send
    channel:
      $ref: "#/channels/q"
    messages:
      - $ref: "#/components/messages/auth"
components:
  messages:
    auth:
      name: auth
      payload:
        type: object
`;
		const parsed = parseYamlFile(yaml, "x.yaml");
		const op = parsed.headings.find((h) => h.pathText === "send send_auth");
		if (!op) throw new Error("expected send send_auth heading");
		const body = parsed.source.slice(op.bodyOffsetRange.start, op.bodyOffsetRange.end);
		expect(body).toContain("Messages:");
		expect(body).toContain("- auth");
		// Must not surface the raw ref pointer that pre-fix code emitted.
		expect(body).not.toContain("- #/components/messages/auth");
	});

	test("components.messages target with name !== bucketKey renders `bucketKey (name)`", () => {
		const yaml = `asyncapi: "3.0.0"
info:
  title: T
  version: "1"
channels:
  q:
    address: /q
operations:
  send_user:
    action: send
    channel:
      $ref: "#/channels/q"
    messages:
      - $ref: "#/components/messages/authMsg"
components:
  messages:
    authMsg:
      name: AuthenticatedUser
      payload:
        type: object
`;
		const parsed = parseYamlFile(yaml, "x.yaml");
		const op = parsed.headings.find((h) => h.pathText === "send send_user");
		if (!op) throw new Error("expected send send_user heading");
		const body = parsed.source.slice(op.bodyOffsetRange.start, op.bodyOffsetRange.end);
		expect(body).toContain("- authMsg (AuthenticatedUser)");
	});

	test("chained components.messages ref renders bare bucketKey (no name suffix)", () => {
		// Single-level invariant: `maybeDereference` returns null when the
		// target is `{$ref: "..."}`. `formatMessageBullet(name, null)` then
		// renders `- name` without the `(Name)` suffix.
		const yaml = `asyncapi: "3.0.0"
info:
  title: T
  version: "1"
channels:
  q:
    address: /q
operations:
  send_x:
    action: send
    channel:
      $ref: "#/channels/q"
    messages:
      - $ref: "#/components/messages/X"
components:
  messages:
    X:
      $ref: "./shared.yaml#/messages/X"
`;
		const parsed = parseYamlFile(yaml, "x.yaml");
		const op = parsed.headings.find((h) => h.pathText === "send send_x");
		if (!op) throw new Error("expected send send_x heading");
		const body = parsed.source.slice(op.bodyOffsetRange.start, op.bodyOffsetRange.end);
		expect(body).toContain("Messages:\n- X\n");
	});

	test("channel-scoped message ref still resolves alongside components-bucket form (regression)", () => {
		const yaml = `asyncapi: "3.0.0"
info:
  title: T
  version: "1"
channels:
  q:
    address: /q
    messages:
      ping:
        name: Ping
        payload:
          type: object
operations:
  send_ping:
    action: send
    channel:
      $ref: "#/channels/q"
    messages:
      - $ref: "#/channels/q/messages/ping"
`;
		const parsed = parseYamlFile(yaml, "x.yaml");
		const op = parsed.headings.find((h) => h.pathText === "send send_ping");
		if (!op) throw new Error("expected send send_ping heading");
		const body = parsed.source.slice(op.bodyOffsetRange.start, op.bodyOffsetRange.end);
		expect(body).toContain("- ping (Ping)");
	});

	test("external ref (./shared.yaml#/messages/X) surfaces verbatim", () => {
		const yaml = `asyncapi: "3.0.0"
info:
  title: T
  version: "1"
channels:
  q:
    address: /q
operations:
  send_ext:
    action: send
    channel:
      $ref: "#/channels/q"
    messages:
      - $ref: "./shared.yaml#/messages/auth"
`;
		const parsed = parseYamlFile(yaml, "x.yaml");
		const op = parsed.headings.find((h) => h.pathText === "send send_ext");
		if (!op) throw new Error("expected send send_ext heading");
		const body = parsed.source.slice(op.bodyOffsetRange.start, op.bodyOffsetRange.end);
		expect(body).toContain("- ./shared.yaml#/messages/auth");
	});
});

describe("synthesizeAsyncApiFile — root-bucket Reference Object aliases", () => {
	test("operations.<alias>: $ref #/operations/<real> resolves and emits a heading", () => {
		const yaml = `asyncapi: "3.0.0"
info:
  title: T
  version: "1"
channels:
  q:
    address: /q
operations:
  realOp:
    action: send
    channel:
      $ref: "#/channels/q"
  aliasOp:
    $ref: "#/operations/realOp"
`;
		const parsed = parseYamlFile(yaml, "x.yaml");
		const opHeadings = parsed.headings.filter(isOperationHeading).map((h) => h.pathText);
		expect(opHeadings).toContain("send realOp");
		expect(opHeadings).toContain("send aliasOp");
	});

	test("channels.<alias>: $ref #/channels/<real> renders the real channel's address in operation prose", () => {
		const yaml = `asyncapi: "3.0.0"
info:
  title: T
  version: "1"
channels:
  realChan:
    address: /v1/events
  aliasChan:
    $ref: "#/channels/realChan"
operations:
  send_e:
    action: send
    channel:
      $ref: "#/channels/aliasChan"
`;
		const parsed = parseYamlFile(yaml, "x.yaml");
		const op = parsed.headings.find((h) => h.pathText === "send send_e");
		if (!op) throw new Error("expected send send_e heading");
		const body = parsed.source.slice(op.bodyOffsetRange.start, op.bodyOffsetRange.end);
		expect(body).toContain("Channel: /v1/events");
		// Pre-fix would surface the raw `$ref` of the alias.
		expect(body).not.toContain("Channel: #/channels/aliasChan");
	});

	test("servers.<alias>: $ref #/servers/<real> renders the real server's host/protocol in the preamble", () => {
		const yaml = `asyncapi: "3.0.0"
info:
  title: T
  version: "1"
servers:
  realBroker:
    host: broker.example.com
    protocol: mqtt
  aliasBroker:
    $ref: "#/servers/realBroker"
channels:
  q:
    address: /q
operations:
  send_e:
    action: send
    channel:
      $ref: "#/channels/q"
`;
		const parsed = parseYamlFile(yaml, "x.yaml");
		expect(parsed.preamble).not.toBeNull();
		if (parsed.preamble === null) throw new Error("expected preamble");
		const preamble = parsed.source.slice(parsed.preamble.offsetRange.start, parsed.preamble.offsetRange.end);
		expect(preamble).toContain("- aliasBroker (mqtt): broker.example.com");
		// Pre-fix would surface `- aliasBroker: #/servers/realBroker`.
		expect(preamble).not.toContain("- aliasBroker: #/servers/realBroker");
	});

	test("chained root-ref (a → b → c) stays unresolved per the single-level invariant", () => {
		// `dereferenceRoot` has the same chained-ref guard as
		// `dereferenceComponent`: target IS a ref-stub → null.
		const yaml = `asyncapi: "3.0.0"
info:
  title: T
  version: "1"
channels:
  a:
    $ref: "#/channels/b"
  b:
    $ref: "#/channels/c"
  c:
    address: /c
operations:
  send_e:
    action: send
    channel:
      $ref: "#/channels/a"
`;
		const parsed = parseYamlFile(yaml, "x.yaml");
		const op = parsed.headings.find((h) => h.pathText === "send send_e");
		if (!op) throw new Error("expected send send_e heading");
		const body = parsed.source.slice(op.bodyOffsetRange.start, op.bodyOffsetRange.end);
		// First hop's target (b) is itself a ref → chained-ref guard fires
		// → resolveChannelText falls through to the raw $ref.
		expect(body).toContain("Channel: #/channels/a");
		expect(body).not.toContain("Channel: /c");
	});

	test("components-bucket preferred over root when both buckets share a name", () => {
		// dereferenceComponent runs first; the root-bucket fallback only fires
		// when components-bucket resolution misses. So `#/components/channels/q`
		// always resolves to the components copy, never the root.
		const yaml = `asyncapi: "3.0.0"
info:
  title: T
  version: "1"
channels:
  q:
    address: /root-q
components:
  channels:
    q:
      address: /components-q
operations:
  send_components:
    action: send
    channel:
      $ref: "#/components/channels/q"
  send_root:
    action: send
    channel:
      $ref: "#/channels/q"
`;
		const parsed = parseYamlFile(yaml, "x.yaml");
		const opC = parsed.headings.find((h) => h.pathText === "send send_components");
		const opR = parsed.headings.find((h) => h.pathText === "send send_root");
		if (!opC || !opR) throw new Error("expected both operations");
		const bodyC = parsed.source.slice(opC.bodyOffsetRange.start, opC.bodyOffsetRange.end);
		const bodyR = parsed.source.slice(opR.bodyOffsetRange.start, opR.bodyOffsetRange.end);
		expect(bodyC).toContain("Channel: /components-q");
		expect(bodyR).toContain("Channel: /root-q");
	});
});

describe("synthesizeAsyncApiFile — server target composition", () => {
	/** Wrap a `servers:` block in the minimal AsyncAPI 3 shape that exercises the preamble. */
	const buildServerYaml = (serversBlock: string): string =>
		`asyncapi: "3.0.0"\ninfo:\n  title: T\n  version: "1"\n${serversBlock}channels:\n  q:\n    address: /q\noperations:\n  send_e:\n    action: send\n    channel:\n      $ref: "#/channels/q"\n`;

	const readPreamble = (yaml: string): string => {
		const parsed = parseYamlFile(yaml, "x.yaml");
		if (parsed.preamble === null) throw new Error("expected preamble");
		return parsed.source.slice(parsed.preamble.offsetRange.start, parsed.preamble.offsetRange.end);
	};

	test("host + pathname (with leading slash) renders as `host<pathname>`", () => {
		const preamble = readPreamble(
			buildServerYaml("servers:\n  broker:\n    host: broker.example.com\n    pathname: /mqtt\n    protocol: mqtt\n"),
		);
		expect(preamble).toContain("- broker (mqtt): broker.example.com/mqtt");
	});

	test("pathname without a leading slash gets one inserted", () => {
		const preamble = readPreamble(
			buildServerYaml("servers:\n  broker:\n    host: broker.example.com\n    pathname: mqtt\n    protocol: mqtt\n"),
		);
		expect(preamble).toContain("- broker (mqtt): broker.example.com/mqtt");
	});

	test("pathname absent → preamble line shows bare host (regression of pre-pathname behavior)", () => {
		const preamble = readPreamble(
			buildServerYaml("servers:\n  broker:\n    host: broker.example.com\n    protocol: mqtt\n"),
		);
		expect(preamble).toContain("- broker (mqtt): broker.example.com");
	});

	test("non-spec `url` field is ignored (no longer read since AsyncAPI 3 dropped it)", () => {
		// Malformed 3.x specs carrying `url` lose the rendered target line.
		// The raw value still appears in the `## Spec metadata` fence.
		const preamble = readPreamble(
			buildServerYaml("servers:\n  legacy:\n    url: wss://legacy.example.com/socket\n    protocol: wss\n"),
		);
		expect(preamble).toContain("- legacy (wss)\n");
		expect(preamble).not.toContain("wss://legacy.example.com/socket");
	});

	test("host present alongside non-spec url: host wins, url ignored", () => {
		const preamble = readPreamble(
			buildServerYaml(
				"servers:\n  mix:\n    host: broker.example.com\n    url: wss://other.example.com\n    protocol: mqtt\n",
			),
		);
		expect(preamble).toContain("- mix (mqtt): broker.example.com");
		expect(preamble).not.toContain("wss://other.example.com");
	});
});

/** Extract the JSON fence body (between ```json and ```) under the named heading. Works for per-op headings (`send foo`) and catch-all sections (`Spec metadata`, `Aliased operations`, `Components`). */
const readFenceBody = (parsed: ReturnType<typeof parseYamlFile>, pathText: string): string => {
	const heading = parsed.headings.find((h) => h.pathText === pathText);
	if (!heading) throw new Error(`expected heading: ${pathText}`);
	const section = parsed.source.slice(heading.bodyOffsetRange.start, heading.bodyOffsetRange.end);
	const m = /```(?:json|text)\n([\s\S]*?)\n```/.exec(section);
	if (!m || m[1] === undefined) throw new Error(`no fence in ${pathText} section`);
	return m[1];
};

describe("synthesizeAsyncApiFile — $ref-only fence for aliased operations", () => {
	const ALIAS_YAML = `asyncapi: "3.0.0"
info: { title: T, version: "1" }
channels:
  q:
    address: rpc/q
    messages:
      ping: { name: ping }
components:
  operations:
    shared:
      action: send
      channel:
        $ref: "#/channels/q"
      summary: Shared op summary
      messages:
        - $ref: "#/channels/q/messages/ping"
operations:
  aliasA:
    $ref: "#/components/operations/shared"
  aliasB:
    $ref: "#/components/operations/shared"
  inlineOp:
    action: send
    channel:
      $ref: "#/channels/q"
    summary: Inline op summary
`;

	test("aliased operation's fence body is the raw $ref, not the deref'd target", () => {
		const parsed = parseYamlFile(ALIAS_YAML, "x.yaml");
		expect(readFenceBody(parsed, "send aliasA")).toBe('{"$ref":"#/components/operations/shared"}');
		expect(readFenceBody(parsed, "send aliasB")).toBe('{"$ref":"#/components/operations/shared"}');
	});

	test("aliased operation's prose still expands channel + messages from the deref'd target", () => {
		const parsed = parseYamlFile(ALIAS_YAML, "x.yaml");
		const aliasA = parsed.headings.find((h) => h.pathText === "send aliasA");
		if (!aliasA) throw new Error("expected send aliasA heading");
		const body = parsed.source.slice(aliasA.bodyOffsetRange.start, aliasA.bodyOffsetRange.end);
		expect(body).toContain("Summary: Shared op summary");
		expect(body).toContain("Channel: rpc/q");
		expect(body).toContain("Messages:");
		expect(body).toContain("- ping");
	});

	test("inline operation's fence carries the full op JSON (no top-level $ref shortcut)", () => {
		const parsed = parseYamlFile(ALIAS_YAML, "x.yaml");
		const fenceJson = JSON.parse(readFenceBody(parsed, "send inlineOp"));
		const topLevelKeys = Object.keys(fenceJson);
		expect(topLevelKeys).not.toEqual(["$ref"]);
		expect(fenceJson.action).toBe("send");
		expect(fenceJson.summary).toBe("Inline op summary");
	});
});

describe("synthesizeAsyncApiFile — contentKinds covers reply-only bullets", () => {
	const findOpKinds = (yaml: string, pathText: string): readonly string[] => {
		const parsed = parseYamlFile(yaml, "x.yaml");
		const op = parsed.headings.find((h) => h.pathText === pathText);
		if (!op) throw new Error(`expected heading: ${pathText}`);
		return op.contentKinds;
	};

	test("reply with only address (no messages) marks list", () => {
		const kinds = findOpKinds(
			`asyncapi: "3.0.0"
info: { title: T, version: "1" }
channels:
  q:
    address: rpc/q
operations:
  call:
    action: send
    channel:
      $ref: "#/channels/q"
    reply:
      address:
        location: $message.header#/replyTo
`,
			"send call",
		);
		expect(kinds).toEqual(["code", "list"]);
	});

	test("reply with only channel (no address, no messages) marks list", () => {
		const kinds = findOpKinds(
			`asyncapi: "3.0.0"
info: { title: T, version: "1" }
channels:
  q:
    address: rpc/q
  replyChan:
    address: rpc/reply
operations:
  call:
    action: send
    channel:
      $ref: "#/channels/q"
    reply:
      channel:
        $ref: "#/channels/replyChan"
`,
			"send call",
		);
		expect(kinds).toContain("list");
	});

	test("reply with only messages marks list (regression-negative — old predicate already covered)", () => {
		const kinds = findOpKinds(
			`asyncapi: "3.0.0"
info: { title: T, version: "1" }
channels:
  q:
    address: rpc/q
    messages:
      ack: { name: ack }
operations:
  call:
    action: send
    channel:
      $ref: "#/channels/q"
    reply:
      messages:
        - $ref: "#/channels/q/messages/ack"
`,
			"send call",
		);
		expect(kinds).toContain("list");
	});

	test("operation with no reply and no messages marks code only", () => {
		const kinds = findOpKinds(
			`asyncapi: "3.0.0"
info: { title: T, version: "1" }
channels:
  q:
    address: rpc/q
operations:
  emit:
    action: send
    channel:
      $ref: "#/channels/q"
`,
			"send emit",
		);
		expect(kinds).toEqual(["code"]);
	});

	test("operation with external reply $ref suppresses bullets — contentKinds stays code-only", () => {
		const kinds = findOpKinds(
			`asyncapi: "3.0.0"
info: { title: T, version: "1" }
channels:
  q:
    address: rpc/q
operations:
  call:
    action: send
    channel:
      $ref: "#/channels/q"
    reply:
      $ref: "./external.yaml#/replies/x"
`,
			"send call",
		);
		expect(kinds).toEqual(["code"]);
	});
});

describe("synthesizeAsyncApiFile — per-op fence serializes the trait-merged view", () => {
	test("trait-sourced summary surfaces in the fence JSON", () => {
		const parsed = parseYamlFile(
			`asyncapi: "3.0.0"
info: { title: T, version: "1" }
channels:
  q:
    address: rpc/q
components:
  operationTraits:
    common:
      summary: Trait summary
      description: Trait description
operations:
  notify:
    action: send
    channel:
      $ref: "#/channels/q"
    traits:
      - $ref: "#/components/operationTraits/common"
`,
			"x.yaml",
		);
		const fenceJson = JSON.parse(readFenceBody(parsed, "send notify"));
		expect(fenceJson.summary).toBe("Trait summary");
		expect(fenceJson.description).toBe("Trait description");
	});

	test("target's own value wins in the fence (target-wins matches prose)", () => {
		const parsed = parseYamlFile(
			`asyncapi: "3.0.0"
info: { title: T, version: "1" }
channels:
  q:
    address: rpc/q
components:
  operationTraits:
    common:
      description: Trait description
operations:
  notify:
    action: send
    channel:
      $ref: "#/channels/q"
    description: Inline description
    traits:
      - $ref: "#/components/operationTraits/common"
`,
			"x.yaml",
		);
		const fenceJson = JSON.parse(readFenceBody(parsed, "send notify"));
		expect(fenceJson.description).toBe("Inline description");
	});

	test("operation with no traits — fence equals the raw op JSON (regression-negative)", () => {
		const parsed = parseYamlFile(
			`asyncapi: "3.0.0"
info: { title: T, version: "1" }
channels:
  q:
    address: rpc/q
operations:
  emit:
    action: send
    channel:
      $ref: "#/channels/q"
    summary: Just summary
`,
			"x.yaml",
		);
		const fenceJson = JSON.parse(readFenceBody(parsed, "send emit"));
		expect(fenceJson.action).toBe("send");
		expect(fenceJson.summary).toBe("Just summary");
		expect(fenceJson.description).toBeUndefined();
	});

	test("chained-ref trait (unresolved per dereferenceTraits guard) leaves the fence trait-field-free", () => {
		const parsed = parseYamlFile(
			`asyncapi: "3.0.0"
info: { title: T, version: "1" }
channels:
  q:
    address: rpc/q
components:
  operationTraits:
    chained:
      $ref: "./external.yaml#/operationTraits/x"
operations:
  notify:
    action: send
    channel:
      $ref: "#/channels/q"
    traits:
      - $ref: "#/components/operationTraits/chained"
`,
			"x.yaml",
		);
		const fenceJson = JSON.parse(readFenceBody(parsed, "send notify"));
		expect(fenceJson.summary).toBeUndefined();
		expect(fenceJson.description).toBeUndefined();
	});
});

describe("synthesizeAsyncApiFile — target's explicit empty string overrides trait", () => {
	test('`summary: ""` on target prevents trait summary from leaking into prose', () => {
		const parsed = parseYamlFile(
			`asyncapi: "3.0.0"
info: { title: T, version: "1" }
channels:
  q:
    address: rpc/q
components:
  operationTraits:
    common:
      summary: Trait summary
operations:
  notify:
    action: send
    channel:
      $ref: "#/channels/q"
    summary: ""
    traits:
      - $ref: "#/components/operationTraits/common"
`,
			"x.yaml",
		);
		const op = parsed.headings.find((h) => h.pathText === "send notify");
		if (!op) throw new Error("expected send notify heading");
		const body = parsed.source.slice(op.bodyOffsetRange.start, op.bodyOffsetRange.end);
		expect(body).not.toContain("Summary:");
	});

	test('`summary: ""` on target surfaces as `"summary":""` in the fence JSON (patch-present)', () => {
		const parsed = parseYamlFile(
			`asyncapi: "3.0.0"
info: { title: T, version: "1" }
channels:
  q:
    address: rpc/q
components:
  operationTraits:
    common:
      summary: Trait summary
operations:
  notify:
    action: send
    channel:
      $ref: "#/channels/q"
    summary: ""
    traits:
      - $ref: "#/components/operationTraits/common"
`,
			"x.yaml",
		);
		const fenceJson = JSON.parse(readFenceBody(parsed, "send notify"));
		expect(fenceJson.summary).toBe("");
	});

	test('`description: ""` on target prevents trait description from leaking (mirror of summary case)', () => {
		const parsed = parseYamlFile(
			`asyncapi: "3.0.0"
info: { title: T, version: "1" }
channels:
  q:
    address: rpc/q
components:
  operationTraits:
    common:
      description: Trait description
operations:
  notify:
    action: send
    channel:
      $ref: "#/channels/q"
    description: ""
    traits:
      - $ref: "#/components/operationTraits/common"
`,
			"x.yaml",
		);
		const op = parsed.headings.find((h) => h.pathText === "send notify");
		if (!op) throw new Error("expected send notify heading");
		const body = parsed.source.slice(op.bodyOffsetRange.start, op.bodyOffsetRange.end);
		expect(body).not.toContain("Trait description");
		const fenceJson = JSON.parse(readFenceBody(parsed, "send notify"));
		expect(fenceJson.description).toBe("");
	});

	test("target without the field still inherits from trait (regression-negative)", () => {
		const parsed = parseYamlFile(
			`asyncapi: "3.0.0"
info: { title: T, version: "1" }
channels:
  q:
    address: rpc/q
components:
  operationTraits:
    common:
      summary: Trait summary
operations:
  notify:
    action: send
    channel:
      $ref: "#/channels/q"
    traits:
      - $ref: "#/components/operationTraits/common"
`,
			"x.yaml",
		);
		const op = parsed.headings.find((h) => h.pathText === "send notify");
		if (!op) throw new Error("expected send notify heading");
		const body = parsed.source.slice(op.bodyOffsetRange.start, op.bodyOffsetRange.end);
		expect(body).toContain("Summary: Trait summary");
		const fenceJson = JSON.parse(readFenceBody(parsed, "send notify"));
		expect(fenceJson.summary).toBe("Trait summary");
	});
});

describe("synthesizeAsyncApiFile — channel-scoped message ref resolution", () => {
	const readOpBody = (parsed: ReturnType<typeof parseYamlFile>, pathText: string): string => {
		const op = parsed.headings.find((h) => h.pathText === pathText);
		if (!op) throw new Error(`expected heading: ${pathText}`);
		return parsed.source.slice(op.bodyOffsetRange.start, op.bodyOffsetRange.end);
	};

	test("implicit-all: channel.messages entry $ref'ing another channel's message resolves to inline target", () => {
		const parsed = parseYamlFile(
			`asyncapi: "3.0.0"
info: { title: T, version: "1" }
channels:
  base:
    address: base/topic
    messages:
      ping:
        name: Ping
        payload:
          type: string
  aliasChan:
    address: alias/topic
    messages:
      pingAlias:
        $ref: "#/channels/base/messages/ping"
operations:
  emit:
    action: send
    channel:
      $ref: "#/channels/aliasChan"
`,
			"x.yaml",
		);
		expect(readOpBody(parsed, "send emit")).toContain("- pingAlias (Ping)");
	});

	test("explicit op.messages: channel-scoped ref whose channel-map entry is itself a channel-scoped $ref resolves single-level", () => {
		const parsed = parseYamlFile(
			`asyncapi: "3.0.0"
info: { title: T, version: "1" }
channels:
  base:
    address: base/topic
    messages:
      ping:
        name: Ping
  aliasChan:
    address: alias/topic
    messages:
      pingAlias:
        $ref: "#/channels/base/messages/ping"
operations:
  emit:
    action: send
    channel:
      $ref: "#/channels/aliasChan"
    messages:
      - $ref: "#/channels/aliasChan/messages/pingAlias"
`,
			"x.yaml",
		);
		expect(readOpBody(parsed, "send emit")).toContain("- pingAlias (Ping)");
	});

	test("chained channel-scoped ref (target is itself a $ref) renders bare msgId per single-level invariant", () => {
		const parsed = parseYamlFile(
			`asyncapi: "3.0.0"
info: { title: T, version: "1" }
channels:
  hop1:
    address: a
    messages:
      m:
        $ref: "#/channels/hop2/messages/m"
  hop2:
    address: b
    messages:
      m:
        $ref: "#/channels/hop3/messages/m"
  hop3:
    address: c
    messages:
      m:
        name: Final
operations:
  emit:
    action: send
    channel:
      $ref: "#/channels/hop1"
`,
			"x.yaml",
		);
		const body = readOpBody(parsed, "send emit");
		expect(body).toContain("- m");
		expect(body).not.toContain("- m (Final)");
	});

	test("components-bucket channel-scoped ref resolves", () => {
		const parsed = parseYamlFile(
			`asyncapi: "3.0.0"
info: { title: T, version: "1" }
components:
  channels:
    base:
      address: components-base/topic
      messages:
        ping:
          name: Ping
channels:
  q:
    address: q/topic
    messages:
      pingAlias:
        $ref: "#/components/channels/base/messages/ping"
operations:
  emit:
    action: send
    channel:
      $ref: "#/channels/q"
`,
			"x.yaml",
		);
		expect(readOpBody(parsed, "send emit")).toContain("- pingAlias (Ping)");
	});

	test("external ref entry renders bare msgId (regression-negative)", () => {
		const parsed = parseYamlFile(
			`asyncapi: "3.0.0"
info: { title: T, version: "1" }
channels:
  q:
    address: q/topic
    messages:
      pingAlias:
        $ref: "external.yaml#/components/messages/ping"
operations:
  emit:
    action: send
    channel:
      $ref: "#/channels/q"
`,
			"x.yaml",
		);
		const body = readOpBody(parsed, "send emit");
		expect(body).toContain("- pingAlias");
		expect(body).not.toContain("(Ping)");
	});

	test("components-messages canonical form still resolves (regression-negative)", () => {
		const parsed = parseYamlFile(
			`asyncapi: "3.0.0"
info: { title: T, version: "1" }
components:
  messages:
    Ping:
      name: Ping
channels:
  q:
    address: q/topic
    messages:
      pingAlias:
        $ref: "#/components/messages/Ping"
operations:
  emit:
    action: send
    channel:
      $ref: "#/channels/q"
`,
			"x.yaml",
		);
		expect(readOpBody(parsed, "send emit")).toContain("- pingAlias (Ping)");
	});

	test("inline channel-map message uses its inline name (regression-negative)", () => {
		const parsed = parseYamlFile(
			`asyncapi: "3.0.0"
info: { title: T, version: "1" }
channels:
  q:
    address: q/topic
    messages:
      ping:
        name: Ping
operations:
  emit:
    action: send
    channel:
      $ref: "#/channels/q"
`,
			"x.yaml",
		);
		expect(readOpBody(parsed, "send emit")).toContain("- ping (Ping)");
	});
});

describe("synthesizeAsyncApiFile — full trait merge (all AsyncAPI 3 OperationTrait fields)", () => {
	test("trait-provided bindings merge into the per-op fence", () => {
		const parsed = parseYamlFile(
			`asyncapi: "3.0.0"
info: { title: T, version: "1" }
channels:
  q:
    address: rpc/q
components:
  operationTraits:
    kafkaBindings:
      bindings:
        kafka:
          topic: user-events
operations:
  emit:
    action: send
    channel:
      $ref: "#/channels/q"
    traits:
      - $ref: "#/components/operationTraits/kafkaBindings"
`,
			"x.yaml",
		);
		const fenceJson = JSON.parse(readFenceBody(parsed, "send emit"));
		expect(fenceJson.bindings).toEqual({ kafka: { topic: "user-events" } });
	});

	test("trait-provided title merges into the fence", () => {
		const parsed = parseYamlFile(
			`asyncapi: "3.0.0"
info: { title: T, version: "1" }
channels:
  q:
    address: rpc/q
components:
  operationTraits:
    common:
      title: From trait
operations:
  emit:
    action: send
    channel:
      $ref: "#/channels/q"
    traits:
      - $ref: "#/components/operationTraits/common"
`,
			"x.yaml",
		);
		const fenceJson = JSON.parse(readFenceBody(parsed, "send emit"));
		expect(fenceJson.title).toBe("From trait");
	});

	test("trait-provided externalDocs merges into the fence", () => {
		const parsed = parseYamlFile(
			`asyncapi: "3.0.0"
info: { title: T, version: "1" }
channels:
  q:
    address: rpc/q
components:
  operationTraits:
    docs:
      externalDocs:
        url: https://example.test/docs
        description: External
operations:
  emit:
    action: send
    channel:
      $ref: "#/channels/q"
    traits:
      - $ref: "#/components/operationTraits/docs"
`,
			"x.yaml",
		);
		const fenceJson = JSON.parse(readFenceBody(parsed, "send emit"));
		expect(fenceJson.externalDocs).toEqual({
			url: "https://example.test/docs",
			description: "External",
		});
	});

	test("trait-provided security merges into the fence", () => {
		const parsed = parseYamlFile(
			`asyncapi: "3.0.0"
info: { title: T, version: "1" }
channels:
  q:
    address: rpc/q
components:
  operationTraits:
    auth:
      security:
        - type: oauth2
          flows:
            implicit:
              authorizationUrl: https://example.test/oauth
              scopes:
                read: read scope
operations:
  emit:
    action: send
    channel:
      $ref: "#/channels/q"
    traits:
      - $ref: "#/components/operationTraits/auth"
`,
			"x.yaml",
		);
		const fenceJson = JSON.parse(readFenceBody(parsed, "send emit"));
		expect(Array.isArray(fenceJson.security)).toBe(true);
		expect(fenceJson.security[0].type).toBe("oauth2");
	});

	test("target wins on collision: op.bindings overrides trait.bindings", () => {
		const parsed = parseYamlFile(
			`asyncapi: "3.0.0"
info: { title: T, version: "1" }
channels:
  q:
    address: rpc/q
components:
  operationTraits:
    common:
      bindings:
        kafka:
          topic: from-trait
operations:
  emit:
    action: send
    channel:
      $ref: "#/channels/q"
    bindings:
      kafka:
        topic: from-op
    traits:
      - $ref: "#/components/operationTraits/common"
`,
			"x.yaml",
		);
		const fenceJson = JSON.parse(readFenceBody(parsed, "send emit"));
		expect(fenceJson.bindings).toEqual({ kafka: { topic: "from-op" } });
	});

	test("later trait wins on collision among multiple traits (target absent)", () => {
		const parsed = parseYamlFile(
			`asyncapi: "3.0.0"
info: { title: T, version: "1" }
channels:
  q:
    address: rpc/q
components:
  operationTraits:
    first:
      bindings:
        kafka:
          topic: first
    second:
      bindings:
        kafka:
          topic: second
operations:
  emit:
    action: send
    channel:
      $ref: "#/channels/q"
    traits:
      - $ref: "#/components/operationTraits/first"
      - $ref: "#/components/operationTraits/second"
`,
			"x.yaml",
		);
		const fenceJson = JSON.parse(readFenceBody(parsed, "send emit"));
		expect(fenceJson.bindings).toEqual({ kafka: { topic: "second" } });
	});

	test("trait-provided reply flows into the merged fence (reply is spec-permitted in OperationTrait)", () => {
		const parsed = parseYamlFile(
			`asyncapi: "3.0.0"
info: { title: T, version: "1" }
channels:
  q:
    address: rpc/q
components:
  operationTraits:
    common:
      reply:
        address:
          location: $message.header#/replyTo
      summary: Legit summary
operations:
  emit:
    action: send
    channel:
      $ref: "#/channels/q"
    traits:
      - $ref: "#/components/operationTraits/common"
`,
			"x.yaml",
		);
		const fenceJson = JSON.parse(readFenceBody(parsed, "send emit"));
		expect(fenceJson.reply).toEqual({ address: { location: "$message.header#/replyTo" } });
		expect(fenceJson.summary).toBe("Legit summary");
	});

	test("multi-field trait merges title + description + bindings together", () => {
		const parsed = parseYamlFile(
			`asyncapi: "3.0.0"
info: { title: T, version: "1" }
channels:
  q:
    address: rpc/q
components:
  operationTraits:
    full:
      title: T
      description: D
      bindings:
        kafka:
          topic: events
operations:
  emit:
    action: send
    channel:
      $ref: "#/channels/q"
    traits:
      - $ref: "#/components/operationTraits/full"
`,
			"x.yaml",
		);
		const fenceJson = JSON.parse(readFenceBody(parsed, "send emit"));
		expect(fenceJson.title).toBe("T");
		expect(fenceJson.description).toBe("D");
		expect(fenceJson.bindings).toEqual({ kafka: { topic: "events" } });
	});

	test("empty-string override on target still beats trait (regression-pin for patch-present)", () => {
		const parsed = parseYamlFile(
			`asyncapi: "3.0.0"
info: { title: T, version: "1" }
channels:
  q:
    address: rpc/q
components:
  operationTraits:
    common:
      summary: Trait summary
operations:
  emit:
    action: send
    channel:
      $ref: "#/channels/q"
    summary: ""
    traits:
      - $ref: "#/components/operationTraits/common"
`,
			"x.yaml",
		);
		const fenceJson = JSON.parse(readFenceBody(parsed, "send emit"));
		expect(fenceJson.summary).toBe("");
		const op = parsed.headings.find((h) => h.pathText === "send emit");
		if (!op) throw new Error("expected send emit heading");
		const body = parsed.source.slice(op.bodyOffsetRange.start, op.bodyOffsetRange.end);
		expect(body).not.toContain("Summary: Trait summary");
	});
});

describe("synthesizeAsyncApiFile — recursive JSON Merge Patch over nested trait fields", () => {
	test("nested partial override: op.bindings.kafka.clientId + trait.bindings.kafka.topic both survive", () => {
		const parsed = parseYamlFile(
			`asyncapi: "3.0.0"
info: { title: T, version: "1" }
channels:
  q:
    address: rpc/q
components:
  operationTraits:
    common:
      bindings:
        kafka:
          topic: from-trait
operations:
  emit:
    action: send
    channel:
      $ref: "#/channels/q"
    bindings:
      kafka:
        clientId: from-op
    traits:
      - $ref: "#/components/operationTraits/common"
`,
			"x.yaml",
		);
		const fenceJson = JSON.parse(readFenceBody(parsed, "send emit"));
		expect(fenceJson.bindings).toEqual({ kafka: { clientId: "from-op", topic: "from-trait" } });
	});

	test("multi-level recursion: op.bindings.amqp.exchange.durable + trait.bindings.amqp.exchange.autoDelete + trait.bindings.amqp.queue all survive", () => {
		const parsed = parseYamlFile(
			`asyncapi: "3.0.0"
info: { title: T, version: "1" }
channels:
  q:
    address: rpc/q
components:
  operationTraits:
    common:
      bindings:
        amqp:
          exchange:
            autoDelete: false
          queue:
            name: shared-queue
operations:
  emit:
    action: send
    channel:
      $ref: "#/channels/q"
    bindings:
      amqp:
        exchange:
          durable: true
    traits:
      - $ref: "#/components/operationTraits/common"
`,
			"x.yaml",
		);
		const fenceJson = JSON.parse(readFenceBody(parsed, "send emit"));
		expect(fenceJson.bindings).toEqual({
			amqp: {
				exchange: { durable: true, autoDelete: false },
				queue: { name: "shared-queue" },
			},
		});
	});

	test("target wins at deep leaf: op.bindings.kafka.topic beats trait's identically-keyed leaf while trait.bindings.kafka.groupId survives", () => {
		const parsed = parseYamlFile(
			`asyncapi: "3.0.0"
info: { title: T, version: "1" }
channels:
  q:
    address: rpc/q
components:
  operationTraits:
    common:
      bindings:
        kafka:
          topic: from-trait
          groupId: G
operations:
  emit:
    action: send
    channel:
      $ref: "#/channels/q"
    bindings:
      kafka:
        topic: from-op
    traits:
      - $ref: "#/components/operationTraits/common"
`,
			"x.yaml",
		);
		const fenceJson = JSON.parse(readFenceBody(parsed, "send emit"));
		expect(fenceJson.bindings).toEqual({ kafka: { topic: "from-op", groupId: "G" } });
	});

	test("multi-trait nested merge: trait1.bindings.kafka.topic + trait2.bindings.kafka.clientId both survive (op absent)", () => {
		const parsed = parseYamlFile(
			`asyncapi: "3.0.0"
info: { title: T, version: "1" }
channels:
  q:
    address: rpc/q
components:
  operationTraits:
    first:
      bindings:
        kafka:
          topic: T1
    second:
      bindings:
        kafka:
          clientId: C2
operations:
  emit:
    action: send
    channel:
      $ref: "#/channels/q"
    traits:
      - $ref: "#/components/operationTraits/first"
      - $ref: "#/components/operationTraits/second"
`,
			"x.yaml",
		);
		const fenceJson = JSON.parse(readFenceBody(parsed, "send emit"));
		expect(fenceJson.bindings).toEqual({ kafka: { topic: "T1", clientId: "C2" } });
	});

	test("later trait wins at nested leaf when both define the same key", () => {
		const parsed = parseYamlFile(
			`asyncapi: "3.0.0"
info: { title: T, version: "1" }
channels:
  q:
    address: rpc/q
components:
  operationTraits:
    first:
      bindings:
        kafka:
          topic: T1
    second:
      bindings:
        kafka:
          topic: T2
operations:
  emit:
    action: send
    channel:
      $ref: "#/channels/q"
    traits:
      - $ref: "#/components/operationTraits/first"
      - $ref: "#/components/operationTraits/second"
`,
			"x.yaml",
		);
		const fenceJson = JSON.parse(readFenceBody(parsed, "send emit"));
		expect(fenceJson.bindings).toEqual({ kafka: { topic: "T2" } });
	});

	test("arrays stay atomic (RFC 7396 §1): op.tags wins as a whole, trait.tags discarded", () => {
		const parsed = parseYamlFile(
			`asyncapi: "3.0.0"
info: { title: T, version: "1" }
channels:
  q:
    address: rpc/q
components:
  operationTraits:
    common:
      tags:
        - name: from-trait
        - name: also-from-trait
operations:
  emit:
    action: send
    channel:
      $ref: "#/channels/q"
    tags:
      - name: from-op
    traits:
      - $ref: "#/components/operationTraits/common"
`,
			"x.yaml",
		);
		const fenceJson = JSON.parse(readFenceBody(parsed, "send emit"));
		expect(fenceJson.tags).toEqual([{ name: "from-op" }]);
	});

	test("externalDocs deep merge: op.externalDocs.description + trait.externalDocs.url both survive (op's description wins)", () => {
		const parsed = parseYamlFile(
			`asyncapi: "3.0.0"
info: { title: T, version: "1" }
channels:
  q:
    address: rpc/q
components:
  operationTraits:
    common:
      externalDocs:
        url: https://docs.example.com
        description: trait-desc
operations:
  emit:
    action: send
    channel:
      $ref: "#/channels/q"
    externalDocs:
      description: op-desc
    traits:
      - $ref: "#/components/operationTraits/common"
`,
			"x.yaml",
		);
		const fenceJson = JSON.parse(readFenceBody(parsed, "send emit"));
		expect(fenceJson.externalDocs).toEqual({ url: "https://docs.example.com", description: "op-desc" });
	});

	test("patch-present extended to nested: op.bindings.kafka.topic='' beats trait's non-empty value", () => {
		const parsed = parseYamlFile(
			`asyncapi: "3.0.0"
info: { title: T, version: "1" }
channels:
  q:
    address: rpc/q
components:
  operationTraits:
    common:
      bindings:
        kafka:
          topic: from-trait
operations:
  emit:
    action: send
    channel:
      $ref: "#/channels/q"
    bindings:
      kafka:
        topic: ""
    traits:
      - $ref: "#/components/operationTraits/common"
`,
			"x.yaml",
		);
		const fenceJson = JSON.parse(readFenceBody(parsed, "send emit"));
		expect(fenceJson.bindings).toEqual({ kafka: { topic: "" } });
	});

	test("no-traits early return preserves shallow identity: applyTraitMerge(op, []) returns the op reference unchanged", () => {
		const parsed = parseYamlFile(
			`asyncapi: "3.0.0"
info: { title: T, version: "1" }
channels:
  q:
    address: rpc/q
operations:
  emit:
    action: send
    channel:
      $ref: "#/channels/q"
    bindings:
      kafka:
        topic: only-op
`,
			"x.yaml",
		);
		const fenceJson = JSON.parse(readFenceBody(parsed, "send emit"));
		expect(fenceJson.bindings).toEqual({ kafka: { topic: "only-op" } });
	});

	test("forbidden-field filter still fires under deep merge: trait.action is dropped while trait.bindings flows", () => {
		const parsed = parseYamlFile(
			`asyncapi: "3.0.0"
info: { title: T, version: "1" }
channels:
  q:
    address: rpc/q
components:
  operationTraits:
    common:
      action: receive
      bindings:
        kafka:
          topic: from-trait
operations:
  emit:
    action: send
    channel:
      $ref: "#/channels/q"
    traits:
      - $ref: "#/components/operationTraits/common"
`,
			"x.yaml",
		);
		const fenceJson = JSON.parse(readFenceBody(parsed, "send emit"));
		expect(fenceJson.action).toBe("send");
		expect(fenceJson.bindings).toEqual({ kafka: { topic: "from-trait" } });
	});
});

describe("synthesizeAsyncApiFile — empty-string channel address preserved", () => {
	test('channel with address: "" renders "Channel: " with no disambiguator', () => {
		const parsed = parseYamlFile(
			`asyncapi: "3.0.0"
info: { title: T, version: "1" }
channels:
  defaultTopic:
    address: ""
    messages:
      m: {}
operations:
  emit:
    action: send
    channel:
      $ref: "#/channels/defaultTopic"
`,
			"x.yaml",
		);
		const op = parsed.headings.find((h) => h.pathText === "send emit");
		if (!op) throw new Error("expected send emit heading");
		const body = parsed.source.slice(op.bodyOffsetRange.start, op.bodyOffsetRange.end);
		expect(body).toContain("Channel: \n");
		expect(body).not.toContain("(address unknown)");
		expect(body).not.toContain("Channel: defaultTopic");
	});

	test('reply channel with address: "" renders "- Channel: " with no disambiguator', () => {
		const parsed = parseYamlFile(
			`asyncapi: "3.0.0"
info: { title: T, version: "1" }
channels:
  q:
    address: rpc/q
  defaultReply:
    address: ""
operations:
  call:
    action: send
    channel:
      $ref: "#/channels/q"
    reply:
      channel:
        $ref: "#/channels/defaultReply"
`,
			"x.yaml",
		);
		const op = parsed.headings.find((h) => h.pathText === "send call");
		if (!op) throw new Error("expected send call heading");
		const body = parsed.source.slice(op.bodyOffsetRange.start, op.bodyOffsetRange.end);
		expect(body).toContain("- Channel: \n");
		expect(body).not.toContain("(address unknown)");
		expect(body).not.toContain("- Channel: defaultReply");
	});

	test('regression-pin: address: null still renders "<id> (address unknown)"', () => {
		const parsed = parseYamlFile(
			`asyncapi: "3.0.0"
info: { title: T, version: "1" }
channels:
  c:
    address: null
operations:
  emit:
    action: send
    channel:
      $ref: "#/channels/c"
`,
			"x.yaml",
		);
		const op = parsed.headings.find((h) => h.pathText === "send emit");
		if (!op) throw new Error("expected send emit heading");
		const body = parsed.source.slice(op.bodyOffsetRange.start, op.bodyOffsetRange.end);
		expect(body).toContain("Channel: c (address unknown)");
	});

	test('regression-pin: address absent still renders "<id> (address unknown)"', () => {
		const parsed = parseYamlFile(
			`asyncapi: "3.0.0"
info: { title: T, version: "1" }
channels:
  c:
    messages:
      m: {}
operations:
  emit:
    action: send
    channel:
      $ref: "#/channels/c"
`,
			"x.yaml",
		);
		const op = parsed.headings.find((h) => h.pathText === "send emit");
		if (!op) throw new Error("expected send emit heading");
		const body = parsed.source.slice(op.bodyOffsetRange.start, op.bodyOffsetRange.end);
		expect(body).toContain("Channel: c (address unknown)");
	});
});

describe("synthesizeAsyncApiFile — prototype pollution defense", () => {
	test("op with own __proto__ + traits non-empty: prose does not leak attacker summary via prototype walk", () => {
		const parsed = parseYamlFile(
			`asyncapi: "3.0.0"
info: { title: T, version: "1" }
channels:
  q:
    address: rpc/q
components:
  operationTraits:
    auth:
      description: legit trait desc
operations:
  emit:
    action: send
    channel:
      $ref: "#/channels/q"
    traits:
      - $ref: "#/components/operationTraits/auth"
    __proto__:
      summary: attacker-leak-summary
`,
			"x.yaml",
		);
		const op = parsed.headings.find((h) => h.pathText === "send emit");
		if (!op) throw new Error("expected send emit heading");
		const body = parsed.source.slice(op.bodyOffsetRange.start, op.bodyOffsetRange.end);
		expect(body).toContain("legit trait desc");
		expect(body).not.toContain("Summary: attacker-leak-summary");
		expect(body).not.toContain("attacker-leak-summary");
		const fenceJson = JSON.parse(readFenceBody(parsed, "send emit"));
		expect(Object.hasOwn(fenceJson, "summary")).toBe(false);
		expect(Object.hasOwn(fenceJson, "__proto__")).toBe(false);
	});

	test("trait with own __proto__: prose contains legitimate trait field; no attacker leak", () => {
		const parsed = parseYamlFile(
			`asyncapi: "3.0.0"
info: { title: T, version: "1" }
channels:
  q:
    address: rpc/q
components:
  operationTraits:
    poisoned:
      description: legit description
      __proto__:
        summary: trait-attacker-leak
operations:
  emit:
    action: send
    channel:
      $ref: "#/channels/q"
    traits:
      - $ref: "#/components/operationTraits/poisoned"
`,
			"x.yaml",
		);
		const op = parsed.headings.find((h) => h.pathText === "send emit");
		if (!op) throw new Error("expected send emit heading");
		const body = parsed.source.slice(op.bodyOffsetRange.start, op.bodyOffsetRange.end);
		expect(body).toContain("legit description");
		expect(body).not.toContain("Summary: trait-attacker-leak");
		const fenceJson = JSON.parse(readFenceBody(parsed, "send emit"));
		expect(fenceJson.description).toBe("legit description");
		expect(fenceJson.summary).toBeUndefined();
	});

	test("constructor as YAML key on op flows through to merged fence as own data", () => {
		const parsed = parseYamlFile(
			`asyncapi: "3.0.0"
info: { title: T, version: "1" }
channels:
  q:
    address: rpc/q
operations:
  emit:
    action: send
    channel:
      $ref: "#/channels/q"
    constructor: hijacked
`,
			"x.yaml",
		);
		const fenceJson = JSON.parse(readFenceBody(parsed, "send emit"));
		expect(Object.hasOwn(fenceJson, "constructor")).toBe(true);
		expect(fenceJson.constructor).toBe("hijacked");
	});

	test("nested __proto__ inside a recursive-merge target does not corrupt the legitimate merge", () => {
		const parsed = parseYamlFile(
			`asyncapi: "3.0.0"
info: { title: T, version: "1" }
channels:
  q:
    address: rpc/q
components:
  operationTraits:
    bindings:
      bindings:
        kafka:
          topic: real-topic
operations:
  emit:
    action: send
    channel:
      $ref: "#/channels/q"
    traits:
      - $ref: "#/components/operationTraits/bindings"
    bindings:
      kafka:
        clientId: real-client
        __proto__:
          topic: nested-attacker-leak
`,
			"x.yaml",
		);
		const fenceJson = JSON.parse(readFenceBody(parsed, "send emit"));
		expect(fenceJson.bindings.kafka.topic).toBe("real-topic");
		expect(fenceJson.bindings.kafka.clientId).toBe("real-client");
		expect(Object.hasOwn(fenceJson.bindings.kafka, "__proto__")).toBe(false);
	});

	test("regression-pin: clean inputs preserve nested-merge behavior", () => {
		const parsed = parseYamlFile(
			`asyncapi: "3.0.0"
info: { title: T, version: "1" }
channels:
  q:
    address: rpc/q
components:
  operationTraits:
    bindings:
      bindings:
        kafka:
          topic: from-trait
operations:
  emit:
    action: send
    channel:
      $ref: "#/channels/q"
    traits:
      - $ref: "#/components/operationTraits/bindings"
    bindings:
      kafka:
        clientId: from-op
`,
			"x.yaml",
		);
		const fenceJson = JSON.parse(readFenceBody(parsed, "send emit"));
		expect(fenceJson.bindings.kafka).toEqual({
			topic: "from-trait",
			clientId: "from-op",
		});
	});
});

describe("synthesizeAsyncApiFile — nested __proto__ removed at every depth", () => {
	test("trait nested __proto__ removed from merged tree fence", () => {
		const parsed = parseYamlFile(
			`asyncapi: "3.0.0"
info: { title: T, version: "1" }
channels:
  q:
    address: rpc/q
components:
  operationTraits:
    poisoned:
      bindings:
        kafka:
          __proto__:
            topic: nested-attacker
operations:
  emit:
    action: send
    channel:
      $ref: "#/channels/q"
    traits:
      - $ref: "#/components/operationTraits/poisoned"
`,
			"x.yaml",
		);
		const fenceJson = JSON.parse(readFenceBody(parsed, "send emit"));
		expect(Object.hasOwn(fenceJson.bindings.kafka, "__proto__")).toBe(false);
		expect(JSON.stringify(fenceJson)).not.toContain("nested-attacker");
	});

	test("__proto__ at depth 4 still removed", () => {
		const parsed = parseYamlFile(
			`asyncapi: "3.0.0"
info: { title: T, version: "1" }
channels:
  q:
    address: rpc/q
operations:
  emit:
    action: send
    channel:
      $ref: "#/channels/q"
    bindings:
      kafka:
        nested:
          deeper:
            __proto__:
              z: deep-leak
`,
			"x.yaml",
		);
		const fenceJson = JSON.parse(readFenceBody(parsed, "send emit"));
		expect(JSON.stringify(fenceJson)).not.toContain("deep-leak");
	});

	test("regression-pin: clean nested trait inputs unchanged", () => {
		const parsed = parseYamlFile(
			`asyncapi: "3.0.0"
info: { title: T, version: "1" }
channels:
  q:
    address: rpc/q
components:
  operationTraits:
    bindings:
      bindings:
        kafka:
          topic: from-trait
operations:
  emit:
    action: send
    channel:
      $ref: "#/channels/q"
    traits:
      - $ref: "#/components/operationTraits/bindings"
    bindings:
      kafka:
        clientId: from-op
`,
			"x.yaml",
		);
		const fenceJson = JSON.parse(readFenceBody(parsed, "send emit"));
		expect(fenceJson.bindings.kafka).toEqual({
			topic: "from-trait",
			clientId: "from-op",
		});
	});
});

describe("synthesizeAsyncApiFile — ## Aliased operations section", () => {
	const ALIASED_YAML = `asyncapi: "3.0.0"
info: { title: T, version: "1" }
channels:
  q:
    address: rpc/q
components:
  operations:
    shared:
      action: send
      channel:
        $ref: "#/channels/q"
      summary: Shared op summary
      bindings:
        kafka:
          topic: distinctive-shared-topic
    other:
      action: receive
      channel:
        $ref: "#/channels/q"
      summary: Other shared op
operations:
  aliasA:
    $ref: "#/components/operations/shared"
  aliasB:
    $ref: "#/components/operations/shared"
  aliasC:
    $ref: "#/components/operations/shared"
`;

	test("three aliases to one target produce exactly one aliased-bodies entry", () => {
		const parsed = parseYamlFile(ALIASED_YAML, "x.yaml");
		const fenceJson = JSON.parse(readFenceBody(parsed, "Aliased operations"));
		const keys = Object.keys(fenceJson);
		expect(keys).toEqual(["#/components/operations/shared"]);
		expect(fenceJson["#/components/operations/shared"].summary).toBe("Shared op summary");
	});

	test("per-op fences still emit only $ref", () => {
		const parsed = parseYamlFile(ALIASED_YAML, "x.yaml");
		expect(readFenceBody(parsed, "send aliasA")).toBe('{"$ref":"#/components/operations/shared"}');
		expect(readFenceBody(parsed, "send aliasB")).toBe('{"$ref":"#/components/operations/shared"}');
		expect(readFenceBody(parsed, "send aliasC")).toBe('{"$ref":"#/components/operations/shared"}');
	});

	test("aliased target body content searchable via the new section", () => {
		const parsed = parseYamlFile(ALIASED_YAML, "x.yaml");
		const section = readFenceBody(parsed, "Aliased operations");
		expect(section).toContain("distinctive-shared-topic");
	});

	test("two distinct shared targets emit two entries", () => {
		const yaml = `asyncapi: "3.0.0"
info: { title: T, version: "1" }
channels:
  q:
    address: rpc/q
components:
  operations:
    sharedA:
      action: send
      channel:
        $ref: "#/channels/q"
      summary: A
    sharedB:
      action: receive
      channel:
        $ref: "#/channels/q"
      summary: B
operations:
  alpha:
    $ref: "#/components/operations/sharedA"
  beta:
    $ref: "#/components/operations/sharedB"
`;
		const parsed = parseYamlFile(yaml, "x.yaml");
		const fenceJson = JSON.parse(readFenceBody(parsed, "Aliased operations"));
		expect(Object.keys(fenceJson).sort()).toEqual([
			"#/components/operations/sharedA",
			"#/components/operations/sharedB",
		]);
	});

	test("no aliased ops: section omitted entirely", () => {
		const yaml = `asyncapi: "3.0.0"
info: { title: T, version: "1" }
channels:
  q:
    address: rpc/q
operations:
  inline:
    action: send
    channel:
      $ref: "#/channels/q"
`;
		const parsed = parseYamlFile(yaml, "x.yaml");
		expect(parsed.headings.find((h) => h.pathText === "Aliased operations")).toBeUndefined();
		expect(parsed.source).not.toContain("## Aliased operations");
	});
});

describe("synthesizeAsyncApiFile — atomic Reference Object during trait merge", () => {
	test("op bindings $ref + trait bindings inline: op $ref wins atomically", () => {
		const parsed = parseYamlFile(
			`asyncapi: "3.0.0"
info: { title: T, version: "1" }
channels:
  q:
    address: rpc/q
components:
  operationBindings:
    kb:
      kafka:
        groupId: ref-group
  operationTraits:
    bindingsTrait:
      bindings:
        kafka:
          topic: from-trait-only
operations:
  emit:
    action: send
    channel:
      $ref: "#/channels/q"
    traits:
      - $ref: "#/components/operationTraits/bindingsTrait"
    bindings:
      $ref: "#/components/operationBindings/kb"
`,
			"x.yaml",
		);
		const fenceJson = JSON.parse(readFenceBody(parsed, "send emit"));
		expect(fenceJson.bindings).toEqual({ $ref: "#/components/operationBindings/kb" });
		expect(JSON.stringify(fenceJson.bindings)).not.toContain("from-trait-only");
	});

	test("op bindings inline + trait bindings $ref: op inline wins (trait $ref dropped)", () => {
		const parsed = parseYamlFile(
			`asyncapi: "3.0.0"
info: { title: T, version: "1" }
channels:
  q:
    address: rpc/q
components:
  operationTraits:
    refTrait:
      bindings:
        $ref: "#/components/operationBindings/kb"
operations:
  emit:
    action: send
    channel:
      $ref: "#/channels/q"
    traits:
      - $ref: "#/components/operationTraits/refTrait"
    bindings:
      kafka:
        topic: op-inline-topic
`,
			"x.yaml",
		);
		const fenceJson = JSON.parse(readFenceBody(parsed, "send emit"));
		expect(fenceJson.bindings).toEqual({ kafka: { topic: "op-inline-topic" } });
		expect(Object.hasOwn(fenceJson.bindings, "$ref")).toBe(false);
	});

	test("externalDocs $ref + trait inline: same atomic rule", () => {
		const parsed = parseYamlFile(
			`asyncapi: "3.0.0"
info: { title: T, version: "1" }
channels:
  q:
    address: rpc/q
components:
  operationTraits:
    docsTrait:
      externalDocs:
        url: https://trait.example.com
        description: trait-docs
operations:
  emit:
    action: send
    channel:
      $ref: "#/channels/q"
    traits:
      - $ref: "#/components/operationTraits/docsTrait"
    externalDocs:
      $ref: "#/components/externalDocs/main"
`,
			"x.yaml",
		);
		const fenceJson = JSON.parse(readFenceBody(parsed, "send emit"));
		expect(fenceJson.externalDocs).toEqual({ $ref: "#/components/externalDocs/main" });
	});
});

describe("synthesizeAsyncApiFile — draft top-level sections preserved", () => {
	test("operations: [] (array) preserved in spec metadata", () => {
		const parsed = parseYamlFile(
			`asyncapi: "3.0.0"
info: { title: T, version: "1" }
operations: []
`,
			"x.yaml",
		);
		const fenceJson = JSON.parse(readFenceBody(parsed, "Spec metadata"));
		expect(fenceJson.operations).toEqual([]);
	});

	test("channels: null preserved in spec metadata", () => {
		const parsed = parseYamlFile(
			`asyncapi: "3.0.0"
info: { title: T, version: "1" }
channels: null
operations:
  ping: { action: send }
`,
			"x.yaml",
		);
		const fenceJson = JSON.parse(readFenceBody(parsed, "Spec metadata"));
		expect(fenceJson.channels).toBeNull();
	});

	test("all three non-object sections flow through spec metadata", () => {
		const parsed = parseYamlFile(
			`asyncapi: "3.0.0"
info: { title: T, version: "1" }
operations: []
channels: null
components: 42
`,
			"x.yaml",
		);
		const fenceJson = JSON.parse(readFenceBody(parsed, "Spec metadata"));
		expect(fenceJson.operations).toEqual([]);
		expect(fenceJson.channels).toBeNull();
		expect(fenceJson.components).toBe(42);
	});

	test("regression-pin: well-formed spec doesn't duplicate rendered keys in spec metadata", () => {
		const parsed = parseYamlFile(
			`asyncapi: "3.0.0"
info: { title: T, version: "1" }
channels:
  q:
    address: rpc/q
components:
  schemas:
    A: {}
operations:
  ping:
    action: send
    channel:
      $ref: "#/channels/q"
`,
			"x.yaml",
		);
		const specMeta = parsed.headings.find((h) => h.pathText === "Spec metadata");
		if (specMeta) {
			const fenceJson = JSON.parse(readFenceBody(parsed, "Spec metadata"));
			expect(fenceJson.channels).toBeUndefined();
			expect(fenceJson.components).toBeUndefined();
		}
	});
});

describe("synthesizeAsyncApiFile — safeSet preserves __proto__-named user content", () => {
	test("__proto__-named operation that falls to residual is preserved", () => {
		const parsed = parseYamlFile(
			`asyncapi: "3.0.0"
info: { title: T, version: "1" }
channels:
  q:
    address: rpc/q
operations:
  __proto__:
    action: invalid-action-falls-to-residual
    channel:
      $ref: "#/channels/q"
  realOp:
    action: send
    channel:
      $ref: "#/channels/q"
`,
			"x.yaml",
		);
		const fenceJson = JSON.parse(readFenceBody(parsed, "Spec metadata"));
		expect(Object.hasOwn(fenceJson.operations, "__proto__")).toBe(true);
		expect((fenceJson.operations as Record<string, unknown>)["__proto__"]).toBeDefined();
	});

	test("regression-pin: __proto__-named op with valid action still renders dedicated heading", () => {
		const parsed = parseYamlFile(
			`asyncapi: "3.0.0"
info: { title: T, version: "1" }
channels:
  q:
    address: rpc/q
operations:
  __proto__:
    action: send
    channel:
      $ref: "#/channels/q"
`,
			"x.yaml",
		);
		const heading = parsed.headings.find((h) => h.pathText === "send __proto__");
		expect(heading).toBeDefined();
	});

	test("top-level __proto__ key preserved in spec metadata", () => {
		const parsed = parseYamlFile(
			`asyncapi: "3.0.0"
info: { title: T, version: "1" }
operations:
  ping: { action: send }
__proto__:
  custom: top-level-leak-test
`,
			"x.yaml",
		);
		const fenceJson = JSON.parse(readFenceBody(parsed, "Spec metadata"));
		expect(Object.hasOwn(fenceJson, "__proto__")).toBe(true);
		expect((fenceJson as Record<string, unknown>)["__proto__"]).toEqual({ custom: "top-level-leak-test" });
	});

	test("info.__proto__ residual key preserved", () => {
		const parsed = parseYamlFile(
			`asyncapi: "3.0.0"
info:
  title: T
  version: "1"
  __proto__:
    arbitrary: info-residual-leak-test
operations:
  ping: { action: send }
`,
			"x.yaml",
		);
		const fenceJson = JSON.parse(readFenceBody(parsed, "Spec metadata"));
		const infoRes = fenceJson.info as Record<string, unknown>;
		expect(Object.hasOwn(infoRes, "__proto__")).toBe(true);
		expect(infoRes["__proto__"]).toEqual({ arbitrary: "info-residual-leak-test" });
	});
});

describe("synthesizeAsyncApiFile — eleventh review", () => {
	// `reply` is spec-permitted in OperationTrait; trait-contributed reply
	// must land in both the JSON fence AND the prose Reply block.

	test("op missing reply, trait carrying reply → merged fence + prose surface trait reply", () => {
		const parsed = parseYamlFile(
			`asyncapi: "3.0.0"
info: { title: T, version: "1" }
channels:
  q:
    address: rpc/q
  qReply:
    address: rpc/q/reply
    messages:
      pong: { name: pong }
components:
  operationTraits:
    rpcReply:
      reply:
        channel:
          $ref: "#/channels/qReply"
        messages:
          - $ref: "#/channels/qReply/messages/pong"
operations:
  emit:
    action: send
    channel:
      $ref: "#/channels/q"
    traits:
      - $ref: "#/components/operationTraits/rpcReply"
`,
			"x.yaml",
		);
		const fenceJson = JSON.parse(readFenceBody(parsed, "send emit"));
		expect(fenceJson.reply).toBeDefined();
		expect(fenceJson.reply.channel).toEqual({ $ref: "#/channels/qReply" });

		const op = parsed.headings.find((h) => h.pathText === "send emit");
		if (!op) throw new Error("expected send emit heading");
		const body = parsed.source.slice(op.bodyOffsetRange.start, op.bodyOffsetRange.end);
		expect(body).toContain("Reply:");
		expect(body).toContain("- Channel: rpc/q/reply");
		expect(body).toContain("- Message: pong");
	});

	test("op carrying reply wins over trait-carrying-reply (target-wins per RFC 7396 + spec)", () => {
		const parsed = parseYamlFile(
			`asyncapi: "3.0.0"
info: { title: T, version: "1" }
channels:
  q:
    address: rpc/q
  opReply:
    address: rpc/from-op
  traitReply:
    address: rpc/from-trait
components:
  operationTraits:
    common:
      reply:
        channel:
          $ref: "#/channels/traitReply"
operations:
  emit:
    action: send
    channel:
      $ref: "#/channels/q"
    reply:
      channel:
        $ref: "#/channels/opReply"
    traits:
      - $ref: "#/components/operationTraits/common"
`,
			"x.yaml",
		);
		const op = parsed.headings.find((h) => h.pathText === "send emit");
		if (!op) throw new Error("expected send emit heading");
		const body = parsed.source.slice(op.bodyOffsetRange.start, op.bodyOffsetRange.end);
		expect(body).toContain("- Channel: rpc/from-op");
		expect(body).not.toContain("- Channel: rpc/from-trait");
	});

	test("trait action / channel / messages / traits still defensively dropped (forbidden set unchanged)", () => {
		const parsed = parseYamlFile(
			`asyncapi: "3.0.0"
info: { title: T, version: "1" }
channels:
  q:
    address: rpc/q
  other:
    address: rpc/other
components:
  operationTraits:
    malformed:
      action: receive
      channel:
        $ref: "#/channels/other"
      messages:
        - $ref: "#/channels/other/messages/x"
      traits:
        - $ref: "#/components/operationTraits/self"
      summary: Legit
operations:
  emit:
    action: send
    channel:
      $ref: "#/channels/q"
    traits:
      - $ref: "#/components/operationTraits/malformed"
`,
			"x.yaml",
		);
		const fenceJson = JSON.parse(readFenceBody(parsed, "send emit"));
		// trait.action filtered → op's action wins
		expect(fenceJson.action).toBe("send");
		// trait.channel filtered → op's channel wins
		expect(fenceJson.channel).toEqual({ $ref: "#/channels/q" });
		// trait.messages filtered → no messages field (op didn't declare one)
		expect(fenceJson.messages).toBeUndefined();
		// trait.traits filtered → only the op's own traits array survives
		expect(fenceJson.traits).toEqual([{ $ref: "#/components/operationTraits/malformed" }]);
		// non-forbidden field still flows
		expect(fenceJson.summary).toBe("Legit");
	});

	// deepSanitize recurses into arrays. Array-element `__proto__` keys
	// must NOT survive into the per-op JSON fence.

	test("trait tags array with __proto__-laden elements → fence has no __proto__ keys", () => {
		const parsed = parseYamlFile(
			`asyncapi: "3.0.0"
info: { title: T, version: "1" }
channels:
  q:
    address: rpc/q
components:
  operationTraits:
    tagged:
      tags:
        - name: user
          __proto__:
            pwn: leaked-X
        - name: signup
operations:
  emit:
    action: send
    channel:
      $ref: "#/channels/q"
    traits:
      - $ref: "#/components/operationTraits/tagged"
`,
			"x.yaml",
		);
		const fenceRaw = readFenceBody(parsed, "send emit");
		expect(fenceRaw).not.toContain("__proto__");
		expect(fenceRaw).not.toContain("leaked-X");
		const fenceJson = JSON.parse(fenceRaw);
		expect(Array.isArray(fenceJson.tags)).toBe(true);
		expect(fenceJson.tags).toHaveLength(2);
		expect(Object.hasOwn(fenceJson.tags[0], "__proto__")).toBe(false);
		expect(fenceJson.tags[0].name).toBe("user");
	});

	test("nested array-of-array-of-object recursion still scrubs at every depth", () => {
		const parsed = parseYamlFile(
			`asyncapi: "3.0.0"
info: { title: T, version: "1" }
channels:
  q:
    address: rpc/q
components:
  operationTraits:
    deepBindings:
      bindings:
        kafka:
          schemaRegistry:
            - - name: inner
                __proto__:
                  evil: deeply-leaked
operations:
  emit:
    action: send
    channel:
      $ref: "#/channels/q"
    traits:
      - $ref: "#/components/operationTraits/deepBindings"
`,
			"x.yaml",
		);
		const fenceRaw = readFenceBody(parsed, "send emit");
		expect(fenceRaw).not.toContain("__proto__");
		expect(fenceRaw).not.toContain("deeply-leaked");
	});

	test("regression-pin — array of scalars passes through unchanged", () => {
		const parsed = parseYamlFile(
			`asyncapi: "3.0.0"
info: { title: T, version: "1" }
channels:
  q:
    address: rpc/q
components:
  operationTraits:
    tagged:
      tags:
        - name: alpha
        - name: beta
operations:
  emit:
    action: send
    channel:
      $ref: "#/channels/q"
    traits:
      - $ref: "#/components/operationTraits/tagged"
`,
			"x.yaml",
		);
		const fenceJson = JSON.parse(readFenceBody(parsed, "send emit"));
		expect(fenceJson.tags).toEqual([{ name: "alpha" }, { name: "beta" }]);
	});

	// Intra-doc ref parsers reject trailing path segments. Malformed
	// refs (extra `/...` past the expected last name) flow to raw-`$ref`
	// rendering rather than being silently truncated to a wrong target.

	test("malformed channel ref with trailing /messages/x falls through to raw-$ref render", () => {
		const parsed = parseYamlFile(
			`asyncapi: "3.0.0"
info: { title: T, version: "1" }
channels:
  q:
    address: rpc/q
operations:
  emit:
    action: send
    channel:
      $ref: "#/channels/q/messages/ping"
`,
			"x.yaml",
		);
		const op = parsed.headings.find((h) => h.pathText === "send emit");
		if (!op) throw new Error("expected send emit heading");
		const body = parsed.source.slice(op.bodyOffsetRange.start, op.bodyOffsetRange.end);
		expect(body).toContain("Channel: #/channels/q/messages/ping");
		expect(body).not.toContain("Channel: rpc/q");
	});

	test("malformed message ref with trailing /name falls through to raw-$ref bullet", () => {
		const parsed = parseYamlFile(
			`asyncapi: "3.0.0"
info: { title: T, version: "1" }
channels:
  q:
    address: rpc/q
    messages:
      Ping:
        name: ping-message
operations:
  emit:
    action: send
    channel:
      $ref: "#/channels/q"
    messages:
      - $ref: "#/components/messages/Ping/name"
`,
			"x.yaml",
		);
		const op = parsed.headings.find((h) => h.pathText === "send emit");
		if (!op) throw new Error("expected send emit heading");
		const body = parsed.source.slice(op.bodyOffsetRange.start, op.bodyOffsetRange.end);
		expect(body).toContain("- #/components/messages/Ping/name");
		expect(body).not.toContain("- ping-message");
		expect(body).not.toMatch(/^- Ping$/m);
	});

	test("malformed channel-message ref with extra trailer falls through to raw-$ref bullet", () => {
		const parsed = parseYamlFile(
			`asyncapi: "3.0.0"
info: { title: T, version: "1" }
channels:
  q:
    address: rpc/q
    messages:
      ping: { name: ping }
operations:
  emit:
    action: send
    channel:
      $ref: "#/channels/q"
    messages:
      - $ref: "#/channels/q/messages/ping/extra"
`,
			"x.yaml",
		);
		const op = parsed.headings.find((h) => h.pathText === "send emit");
		if (!op) throw new Error("expected send emit heading");
		const body = parsed.source.slice(op.bodyOffsetRange.start, op.bodyOffsetRange.end);
		expect(body).toContain("- #/channels/q/messages/ping/extra");
	});

	test("well-formed refs continue to resolve (regression-pin)", () => {
		const parsed = parseYamlFile(
			`asyncapi: "3.0.0"
info: { title: T, version: "1" }
channels:
  q:
    address: rpc/q
    messages:
      ping: { name: ping }
components:
  messages:
    Pong:
      name: pong-message
operations:
  emit:
    action: send
    channel:
      $ref: "#/channels/q"
    messages:
      - $ref: "#/channels/q/messages/ping"
      - $ref: "#/components/messages/Pong"
`,
			"x.yaml",
		);
		const op = parsed.headings.find((h) => h.pathText === "send emit");
		if (!op) throw new Error("expected send emit heading");
		const body = parsed.source.slice(op.bodyOffsetRange.start, op.bodyOffsetRange.end);
		expect(body).toContain("Channel: rpc/q");
		expect(body).toContain("- ping");
		expect(body).toContain("- Pong (pong-message)");
	});
});

describe("synthesizeAsyncApiFile — twelfth review", () => {
	// R1: unresolved message refs surface raw $ref so callers can distinguish
	// "real message named Missing" from "ref to nonexistent #/components/messages/Missing".
	// Chained refs preserve the bare-msgId behavior because their slot IS a plain object.

	test("missing components.messages target → bullet renders raw $ref, not bare name", () => {
		const parsed = parseYamlFile(
			`asyncapi: "3.0.0"
info: { title: T, version: "1" }
channels:
  q:
    address: rpc/q
operations:
  emit:
    action: send
    channel:
      $ref: "#/channels/q"
    messages:
      - $ref: "#/components/messages/Missing"
`,
			"x.yaml",
		);
		const op = parsed.headings.find((h) => h.pathText === "send emit");
		if (!op) throw new Error("expected send emit heading");
		const body = parsed.source.slice(op.bodyOffsetRange.start, op.bodyOffsetRange.end);
		expect(body).toContain("- #/components/messages/Missing");
		expect(body).not.toMatch(/^- Missing$/m);
	});

	test("shape-invalid components.messages target (scalar) → bullet renders raw $ref", () => {
		const parsed = parseYamlFile(
			`asyncapi: "3.0.0"
info: { title: T, version: "1" }
channels:
  q:
    address: rpc/q
components:
  messages:
    X: not-an-object
operations:
  emit:
    action: send
    channel:
      $ref: "#/channels/q"
    messages:
      - $ref: "#/components/messages/X"
`,
			"x.yaml",
		);
		const op = parsed.headings.find((h) => h.pathText === "send emit");
		if (!op) throw new Error("expected send emit heading");
		const body = parsed.source.slice(op.bodyOffsetRange.start, op.bodyOffsetRange.end);
		expect(body).toContain("- #/components/messages/X");
		expect(body).not.toMatch(/^- X$/m);
	});

	test("channel-scoped ref with missing channel → bullet renders raw $ref", () => {
		const parsed = parseYamlFile(
			`asyncapi: "3.0.0"
info: { title: T, version: "1" }
channels:
  q:
    address: rpc/q
operations:
  emit:
    action: send
    channel:
      $ref: "#/channels/q"
    messages:
      - $ref: "#/channels/missingChan/messages/X"
`,
			"x.yaml",
		);
		const op = parsed.headings.find((h) => h.pathText === "send emit");
		if (!op) throw new Error("expected send emit heading");
		const body = parsed.source.slice(op.bodyOffsetRange.start, op.bodyOffsetRange.end);
		expect(body).toContain("- #/channels/missingChan/messages/X");
		expect(body).not.toMatch(/^- X$/m);
	});

	test("channel-scoped ref with missing message in existing channel → bullet renders raw $ref", () => {
		const parsed = parseYamlFile(
			`asyncapi: "3.0.0"
info: { title: T, version: "1" }
channels:
  q:
    address: rpc/q
    messages:
      realMsg: { name: real }
operations:
  emit:
    action: send
    channel:
      $ref: "#/channels/q"
    messages:
      - $ref: "#/channels/q/messages/Missing"
`,
			"x.yaml",
		);
		const op = parsed.headings.find((h) => h.pathText === "send emit");
		if (!op) throw new Error("expected send emit heading");
		const body = parsed.source.slice(op.bodyOffsetRange.start, op.bodyOffsetRange.end);
		expect(body).toContain("- #/channels/q/messages/Missing");
		expect(body).not.toMatch(/^- Missing$/m);
	});

	test("regression-pin: well-formed components.messages ref still renders 'msgId (name)'", () => {
		const parsed = parseYamlFile(
			`asyncapi: "3.0.0"
info: { title: T, version: "1" }
channels:
  q:
    address: rpc/q
components:
  messages:
    Pong:
      name: pong-display
operations:
  emit:
    action: send
    channel:
      $ref: "#/channels/q"
    messages:
      - $ref: "#/components/messages/Pong"
`,
			"x.yaml",
		);
		const op = parsed.headings.find((h) => h.pathText === "send emit");
		if (!op) throw new Error("expected send emit heading");
		const body = parsed.source.slice(op.bodyOffsetRange.start, op.bodyOffsetRange.end);
		expect(body).toContain("- Pong (pong-display)");
	});

	test("regression-pin: external $ref still renders the raw ref string", () => {
		const parsed = parseYamlFile(
			`asyncapi: "3.0.0"
info: { title: T, version: "1" }
channels:
  q:
    address: rpc/q
operations:
  emit:
    action: send
    channel:
      $ref: "#/channels/q"
    messages:
      - $ref: "./other.yaml#/components/messages/Remote"
`,
			"x.yaml",
		);
		const op = parsed.headings.find((h) => h.pathText === "send emit");
		if (!op) throw new Error("expected send emit heading");
		const body = parsed.source.slice(op.bodyOffsetRange.start, op.bodyOffsetRange.end);
		expect(body).toContain("- ./other.yaml#/components/messages/Remote");
	});

	test("regression-pin: implicit-all rendering (omitted op.messages) unaffected by the refactor", () => {
		const parsed = parseYamlFile(
			`asyncapi: "3.0.0"
info: { title: T, version: "1" }
channels:
  q:
    address: rpc/q
    messages:
      msgA:
        name: msgA-display
operations:
  emit:
    action: send
    channel:
      $ref: "#/channels/q"
`,
			"x.yaml",
		);
		const op = parsed.headings.find((h) => h.pathText === "send emit");
		if (!op) throw new Error("expected send emit heading");
		const body = parsed.source.slice(op.bodyOffsetRange.start, op.bodyOffsetRange.end);
		expect(body).toContain("- msgA (msgA-display)");
	});

	// R2: non-object info preserved in `## Spec metadata` so live-editing
	// recall doesn't lose draft bytes.

	test("info: null → preserved in Spec metadata fence", () => {
		const parsed = parseYamlFile(
			`asyncapi: "3.0.0"
info: ~
channels:
  q:
    address: rpc/q
operations:
  emit:
    action: send
    channel:
      $ref: "#/channels/q"
`,
			"x.yaml",
		);
		const fenceJson = JSON.parse(readFenceBody(parsed, "Spec metadata"));
		expect(fenceJson.info).toBeNull();
	});

	test("info: [] draft → preserved in Spec metadata fence", () => {
		const parsed = parseYamlFile(
			`asyncapi: "3.0.0"
info: []
channels:
  q:
    address: rpc/q
operations:
  emit:
    action: send
    channel:
      $ref: "#/channels/q"
`,
			"x.yaml",
		);
		const fenceJson = JSON.parse(readFenceBody(parsed, "Spec metadata"));
		expect(fenceJson.info).toEqual([]);
	});
});

describe("synthesizeAsyncApiFile — thirteenth review", () => {
	// ─ external-ref ops surface in outline ─────────────────────────────

	test("external-ref op emits `external <name>` heading + Reference line + {$ref} fence", () => {
		const parsed = parseYamlFile(
			`asyncapi: "3.0.0"
info: { title: T, version: "1" }
operations:
  notify:
    $ref: "./shared.yaml#/components/operations/notify"
`,
			"main.yaml",
		);
		const op = parsed.headings.find((h) => h.pathText === "external notify");
		if (!op) throw new Error("expected `external notify` heading");
		const body = parsed.source.slice(op.bodyOffsetRange.start, op.bodyOffsetRange.end);
		expect(body).toContain("Reference: ./shared.yaml#/components/operations/notify");
		const fenceJson = JSON.parse(readFenceBody(parsed, "external notify"));
		expect(fenceJson).toEqual({ $ref: "./shared.yaml#/components/operations/notify" });
	});

	test("multiple external-ref ops + one inline op produce 3 alphabetically-sorted headings", () => {
		const parsed = parseYamlFile(
			`asyncapi: "3.0.0"
info: { title: T, version: "1" }
channels:
  q:
    address: rpc/q
operations:
  audit:
    $ref: "./shared.yaml#/components/operations/audit"
  notify:
    $ref: "./shared.yaml#/components/operations/notify"
  zEmit:
    action: send
    channel:
      $ref: "#/channels/q"
`,
			"main.yaml",
		);
		const opHeadings = parsed.headings.filter(isOperationHeading);
		expect(opHeadings.map((h) => h.pathText)).toEqual(["external audit", "external notify", "send zEmit"]);
	});

	test("external-ref op excluded from `## Aliased operations` section", () => {
		const parsed = parseYamlFile(
			`asyncapi: "3.0.0"
info: { title: T, version: "1" }
operations:
  notify:
    $ref: "./shared.yaml#/components/operations/notify"
`,
			"main.yaml",
		);
		expect(parsed.headings.find((h) => h.pathText === "Aliased operations")).toBeUndefined();
	});

	test("regression-pin: intra-doc aliased op still routes through the aliased path (resolved action; aliased-operations entry)", () => {
		const parsed = parseYamlFile(
			`asyncapi: "3.0.0"
info: { title: T, version: "1" }
channels:
  q:
    address: rpc/q
components:
  operations:
    shared:
      action: send
      channel:
        $ref: "#/channels/q"
      summary: shared body
operations:
  aliasA:
    $ref: "#/components/operations/shared"
`,
			"x.yaml",
		);
		const op = parsed.headings.find((h) => h.pathText === "send aliasA");
		if (!op) throw new Error("expected `send aliasA` heading");
		const fenceJson = JSON.parse(readFenceBody(parsed, "send aliasA"));
		expect(fenceJson).toEqual({ $ref: "#/components/operations/shared" });
		const aliased = parsed.headings.find((h) => h.pathText === "Aliased operations");
		if (!aliased) throw new Error("expected `Aliased operations` heading");
		const aliasedFence = JSON.parse(readFenceBody(parsed, "Aliased operations"));
		expect(aliasedFence["#/components/operations/shared"]).toBeDefined();
		expect(aliasedFence["#/components/operations/shared"].summary).toBe("shared body");
	});

	test("regression-pin: inline op with invalid action still skipped", () => {
		const parsed = parseYamlFile(
			`asyncapi: "3.0.0"
info: { title: T, version: "1" }
channels:
  q:
    address: rpc/q
operations:
  bogus:
    action: invalid
    channel:
      $ref: "#/channels/q"
  valid:
    action: send
    channel:
      $ref: "#/channels/q"
`,
			"x.yaml",
		);
		const opHeadings = parsed.headings.filter(isOperationHeading);
		expect(opHeadings.map((h) => h.pathText)).toEqual(["send valid"]);
	});

	// ─ catch-all fences strip nested __proto__ ────────────────────────

	test("components.operationTraits.evil.__proto__ payload stripped from ## Components fence", () => {
		const parsed = parseYamlFile(
			`asyncapi: "3.0.0"
info: { title: T, version: "1" }
channels:
  q:
    address: rpc/q
components:
  operationTraits:
    evil:
      __proto__:
        pwn: SECURITY_PAYLOAD
operations:
  emit:
    action: send
    channel:
      $ref: "#/channels/q"
`,
			"x.yaml",
		);
		expect(parsed.source).not.toContain("SECURITY_PAYLOAD");
		const fenceJson = JSON.parse(readFenceBody(parsed, "Components"));
		expect(fenceJson.operationTraits.evil).toBeDefined();
		expect(Object.hasOwn(fenceJson.operationTraits.evil, "__proto__")).toBe(false);
	});

	test("channels.q.bindings.kafka.__proto__ payload stripped from ## Channels fence", () => {
		const parsed = parseYamlFile(
			`asyncapi: "3.0.0"
info: { title: T, version: "1" }
channels:
  q:
    address: rpc/q
    bindings:
      kafka:
        clientId: real
        __proto__:
          topic: CHAN_PAYLOAD
operations:
  emit:
    action: send
    channel:
      $ref: "#/channels/q"
`,
			"x.yaml",
		);
		expect(parsed.source).not.toContain("CHAN_PAYLOAD");
		const fenceJson = JSON.parse(readFenceBody(parsed, "Channels"));
		expect(fenceJson.q.bindings.kafka.clientId).toBe("real");
		expect(Object.hasOwn(fenceJson.q.bindings.kafka, "__proto__")).toBe(false);
	});

	test("regression-pin: op named `__proto__` still appears in operations residual", () => {
		const parsed = parseYamlFile(
			`asyncapi: "3.0.0"
info: { title: T, version: "1" }
channels:
  q:
    address: rpc/q
operations:
  emit:
    action: send
    channel:
      $ref: "#/channels/q"
  __proto__:
    action: send
    channel:
      $ref: "#/channels/q"
`,
			"x.yaml",
		);
		// __proto__ as an op name renders as a normal heading.
		const op = parsed.headings.find((h) => h.pathText === "send __proto__");
		expect(op).toBeDefined();
	});

	// ─ op-name newline collapse ────────────────────────────────────────

	test("op name with \\n produces ONE heading; phantom `## injected` does not appear", () => {
		const parsed = parseYamlFile(
			`asyncapi: "3.0.0"
info: { title: T, version: "1" }
channels:
  q:
    address: rpc/q
operations:
  "foo\\n## injected":
    action: send
    channel:
      $ref: "#/channels/q"
`,
			"x.yaml",
		);
		const opHeadings = parsed.headings.filter(isOperationHeading);
		expect(opHeadings).toHaveLength(1);
		expect(opHeadings[0]?.pathText).toBe("send foo ## injected");
		// Source must not contain a phantom `## injected` heading line.
		const lines = parsed.source.split("\n").filter((l) => l.startsWith("## "));
		expect(lines.filter((l) => l === "## injected")).toEqual([]);
	});

	test("op name with \\r\\n collapses to single space", () => {
		const parsed = parseYamlFile(
			`asyncapi: "3.0.0"
info: { title: T, version: "1" }
channels:
  q:
    address: rpc/q
operations:
  "foo\\r\\nbar":
    action: send
    channel:
      $ref: "#/channels/q"
`,
			"x.yaml",
		);
		const opHeadings = parsed.headings.filter(isOperationHeading);
		expect(opHeadings).toHaveLength(1);
		expect(opHeadings[0]?.pathText).toBe("send foo bar");
	});

	test("op name with multiple spaces / leading-trailing whitespace collapses + trims", () => {
		const parsed = parseYamlFile(
			`asyncapi: "3.0.0"
info: { title: T, version: "1" }
channels:
  q:
    address: rpc/q
operations:
  "   foo   bar   ":
    action: send
    channel:
      $ref: "#/channels/q"
`,
			"x.yaml",
		);
		const opHeadings = parsed.headings.filter(isOperationHeading);
		expect(opHeadings).toHaveLength(1);
		expect(opHeadings[0]?.pathText).toBe("send foo bar");
		// Source heading line agrees byte-for-byte with the normalized form.
		expect(parsed.source).toContain("## send foo bar\n");
	});
});

describe("synthesizeAsyncApiFile — fourteenth review", () => {
	// ─ spec-metadata nested __proto__ stripped ─────────────────────────

	test("servers.broker.__proto__ payload stripped from ## Spec metadata", () => {
		const parsed = parseYamlFile(
			`asyncapi: "3.0.0"
info: { title: T, version: "1" }
channels:
  q:
    address: rpc/q
operations:
  emit:
    action: send
    channel:
      $ref: "#/channels/q"
servers:
  broker:
    host: example.com
    __proto__:
      pwn: SERVER_PAYLOAD
`,
			"x.yaml",
		);
		expect(parsed.source).not.toContain("SERVER_PAYLOAD");
		const fenceJson = JSON.parse(readFenceBody(parsed, "Spec metadata"));
		expect(fenceJson.servers.broker.host).toBe("example.com");
		expect(Object.hasOwn(fenceJson.servers.broker, "__proto__")).toBe(false);
	});

	test("regression-pin: server literally named __proto__ preserved at the map-key layer", () => {
		const parsed = parseYamlFile(
			`asyncapi: "3.0.0"
info: { title: T, version: "1" }
channels:
  q:
    address: rpc/q
operations:
  emit:
    action: send
    channel:
      $ref: "#/channels/q"
servers:
  __proto__:
    host: legit.example.com
`,
			"x.yaml",
		);
		const fenceJson = JSON.parse(readFenceBody(parsed, "Spec metadata"));
		expect(Object.hasOwn(fenceJson.servers, "__proto__")).toBe(true);
		expect(fenceJson.servers.__proto__.host).toBe("legit.example.com");
	});

	test("info.x-custom.nested.__proto__ payload stripped from ## Spec metadata", () => {
		const parsed = parseYamlFile(
			`asyncapi: "3.0.0"
info:
  title: T
  version: "1"
  x-custom:
    nested:
      __proto__:
        pwn: INFO_PAYLOAD
channels:
  q:
    address: rpc/q
operations:
  emit:
    action: send
    channel:
      $ref: "#/channels/q"
`,
			"x.yaml",
		);
		expect(parsed.source).not.toContain("INFO_PAYLOAD");
		const fenceJson = JSON.parse(readFenceBody(parsed, "Spec metadata"));
		expect(fenceJson.info["x-custom"].nested).toBeDefined();
		expect(Object.hasOwn(fenceJson.info["x-custom"].nested, "__proto__")).toBe(false);
	});

	test("un-rendered operations.bindings.kafka.__proto__ payload stripped from spec-metadata operations residual", () => {
		const parsed = parseYamlFile(
			`asyncapi: "3.0.0"
info: { title: T, version: "1" }
channels:
  q:
    address: rpc/q
operations:
  realOp:
    action: send
    channel:
      $ref: "#/channels/q"
  invalidOp:
    action: invalid
    bindings:
      kafka:
        __proto__:
          pwn: OP_PAYLOAD
`,
			"x.yaml",
		);
		expect(parsed.source).not.toContain("OP_PAYLOAD");
		const fenceJson = JSON.parse(readFenceBody(parsed, "Spec metadata"));
		// invalidOp's op-name key still survives at the user-content map layer;
		// nested __proto__ inside its body is scrubbed.
		expect(Object.hasOwn(fenceJson.operations, "invalidOp")).toBe(true);
		expect(Object.hasOwn(fenceJson.operations.invalidOp.bindings.kafka, "__proto__")).toBe(false);
	});

	// ─ constructor as legitimate user content ──────────────────────────

	test("JSON Schema property named `constructor` flows through ## Components fence", () => {
		const parsed = parseYamlFile(
			`asyncapi: "3.0.0"
info: { title: T, version: "1" }
channels:
  q:
    address: rpc/q
operations:
  emit:
    action: send
    channel:
      $ref: "#/channels/q"
components:
  messages:
    Msg:
      payload:
        type: object
        properties:
          constructor:
            type: string
`,
			"x.yaml",
		);
		const fenceJson = JSON.parse(readFenceBody(parsed, "Components"));
		expect(fenceJson.messages.Msg.payload.properties.constructor).toEqual({ type: "string" });
	});

	// ─ prose-line newline collapse at non-heading sites ────────────────

	test("server name containing `\\n## injected` collapses in preamble; no phantom heading", () => {
		const parsed = parseYamlFile(
			`asyncapi: "3.0.0"
info: { title: T, version: "1" }
channels:
  q:
    address: rpc/q
operations:
  emit:
    action: send
    channel:
      $ref: "#/channels/q"
servers:
  "prod\\n## injected":
    host: example.com
`,
			"x.yaml",
		);
		// Source must contain exactly the real headings; no `## injected` line.
		const headingLines = parsed.source.split("\n").filter((l) => /^## /.test(l));
		expect(headingLines).not.toContain("## injected");
	});

	test("message name containing `\\n## injected` collapses in op body; no phantom heading", () => {
		const parsed = parseYamlFile(
			`asyncapi: "3.0.0"
info: { title: T, version: "1" }
channels:
  q:
    address: rpc/q
    messages:
      "msg\\n## injected":
        name: legit-msg
operations:
  emit:
    action: send
    channel:
      $ref: "#/channels/q"
    messages:
      - $ref: "#/channels/q/messages/msg\\n## injected"
`,
			"x.yaml",
		);
		const headingLines = parsed.source.split("\n").filter((l) => /^## /.test(l));
		expect(headingLines).not.toContain("## injected");
	});

	test("tag name containing `\\n## injected` collapses in Tags: line; no phantom heading", () => {
		const parsed = parseYamlFile(
			`asyncapi: "3.0.0"
info:
  title: T
  version: "1"
  tags:
    - name: "tag\\n## injected"
channels:
  q:
    address: rpc/q
operations:
  emit:
    action: send
    channel:
      $ref: "#/channels/q"
`,
			"x.yaml",
		);
		const headingLines = parsed.source.split("\n").filter((l) => /^## /.test(l));
		expect(headingLines).not.toContain("## injected");
	});

	test("external ref string containing `\\n## injected` collapses in Reference: line", () => {
		const parsed = parseYamlFile(
			`asyncapi: "3.0.0"
info: { title: T, version: "1" }
operations:
  external_op:
    $ref: "./shared.yaml#/operations/foo\\n## injected"
`,
			"main.yaml",
		);
		const headingLines = parsed.source.split("\n").filter((l) => /^## /.test(l));
		expect(headingLines).not.toContain("## injected");
	});
});

describe("synthesizeAsyncApiFile — fifteenth review", () => {
	// ─ F3: array-valued leftover sanitization ─────────────────────────

	test("array-valued x-* extension with nested __proto__ stripped from ## Spec metadata", () => {
		const parsed = parseYamlFile(
			`asyncapi: "3.0.0"
info: { title: T, version: "1" }
channels:
  q:
    address: rpc/q
operations:
  emit:
    action: send
    channel:
      $ref: "#/channels/q"
x-extra:
  - __proto__:
      pwn: ARRAY_PAYLOAD
    keep: visible_data
`,
			"x.yaml",
		);
		expect(parsed.source).not.toContain("ARRAY_PAYLOAD");
		const fenceJson = JSON.parse(readFenceBody(parsed, "Spec metadata"));
		expect(Array.isArray(fenceJson["x-extra"])).toBe(true);
		expect(fenceJson["x-extra"]).toHaveLength(1);
		expect(fenceJson["x-extra"][0].keep).toBe("visible_data");
		expect(Object.hasOwn(fenceJson["x-extra"][0], "__proto__")).toBe(false);
	});

	test("array-valued invalid `info` draft with nested __proto__ stripped from ## Spec metadata", () => {
		const parsed = parseYamlFile(
			`asyncapi: "3.0.0"
info:
  - __proto__:
      pwn: INVALID_INFO_PAYLOAD
    title_attempt: "T"
channels:
  q:
    address: rpc/q
operations:
  emit:
    action: send
    channel:
      $ref: "#/channels/q"
`,
			"x.yaml",
		);
		expect(parsed.source).not.toContain("INVALID_INFO_PAYLOAD");
		const fenceJson = JSON.parse(readFenceBody(parsed, "Spec metadata"));
		expect(Array.isArray(fenceJson.info)).toBe(true);
		expect(Object.hasOwn(fenceJson.info[0], "__proto__")).toBe(false);
	});

	// ─ F4: __proto__-named channel / component preserved in catch-all ─

	test("channel literally named __proto__ preserved in ## Channels fence", () => {
		const parsed = parseYamlFile(
			`asyncapi: "3.0.0"
info: { title: T, version: "1" }
channels:
  __proto__:
    address: legit.broker/queue
operations:
  emit:
    action: send
    channel:
      $ref: "#/channels/__proto__"
`,
			"x.yaml",
		);
		const fenceJson = JSON.parse(readFenceBody(parsed, "Channels"));
		expect(Object.hasOwn(fenceJson, "__proto__")).toBe(true);
		expect(fenceJson["__proto__"].address).toBe("legit.broker/queue");
	});

	test("component literally named __proto__ preserved in ## Components fence", () => {
		const parsed = parseYamlFile(
			`asyncapi: "3.0.0"
info: { title: T, version: "1" }
channels:
  q:
    address: rpc/q
operations:
  emit:
    action: send
    channel:
      $ref: "#/channels/q"
components:
  messages:
    __proto__:
      payload:
        type: object
`,
			"x.yaml",
		);
		const fenceJson = JSON.parse(readFenceBody(parsed, "Components"));
		expect(Object.hasOwn(fenceJson.messages, "__proto__")).toBe(true);
		expect(fenceJson.messages["__proto__"].payload.type).toBe("object");
	});

	test("regression-pin: nested __proto__ inside a legitimately-named channel still scrubbed", () => {
		const parsed = parseYamlFile(
			`asyncapi: "3.0.0"
info: { title: T, version: "1" }
channels:
  broker:
    address: rpc/broker
    bindings:
      kafka:
        __proto__:
          pwn: NESTED_CHANNEL_PAYLOAD
operations:
  emit:
    action: send
    channel:
      $ref: "#/channels/broker"
`,
			"x.yaml",
		);
		expect(parsed.source).not.toContain("NESTED_CHANNEL_PAYLOAD");
		const fenceJson = JSON.parse(readFenceBody(parsed, "Channels"));
		expect(fenceJson.broker.bindings.kafka).toBeDefined();
		expect(Object.hasOwn(fenceJson.broker.bindings.kafka, "__proto__")).toBe(false);
	});

	// ─ F5: server overflow marker counts renderable entries only ──────

	test("25 servers, 5 non-renderable scalars + 20 renderable → no overflow line", () => {
		const renderable = Array.from(
			{ length: 20 },
			(_, i) => `  s${String(i).padStart(2, "0")}: { host: h${i}.example.com, protocol: kafka }`,
		).join("\n");
		const nonRenderable = Array.from({ length: 5 }, (_, i) => `  bad${i}: "scalar_value_${i}"`).join("\n");
		const parsed = parseYamlFile(
			`asyncapi: "3.0.0"
info: { title: T, version: "1" }
channels:
  q:
    address: rpc/q
operations:
  emit:
    action: send
    channel:
      $ref: "#/channels/q"
servers:
${renderable}
${nonRenderable}
`,
			"x.yaml",
		);
		expect(parsed.source).not.toContain("... and");
		// Twenty server bullets emitted.
		expect(parsed.source.match(/^- s\d\d/gm)?.length ?? 0).toBe(20);
	});

	test("30 servers, 5 non-renderable + 25 renderable → overflow shows 5 (not 10)", () => {
		const renderable = Array.from(
			{ length: 25 },
			(_, i) => `  s${String(i).padStart(2, "0")}: { host: h${i}.example.com, protocol: kafka }`,
		).join("\n");
		const nonRenderable = Array.from({ length: 5 }, (_, i) => `  bad${i}: "scalar_${i}"`).join("\n");
		const parsed = parseYamlFile(
			`asyncapi: "3.0.0"
info: { title: T, version: "1" }
channels:
  q:
    address: rpc/q
operations:
  emit:
    action: send
    channel:
      $ref: "#/channels/q"
servers:
${renderable}
${nonRenderable}
`,
			"x.yaml",
		);
		expect(parsed.source).toContain("- ... and 5 more\n");
		// Twenty server bullets emitted (capped).
		expect(parsed.source.match(/^- s\d\d/gm)?.length ?? 0).toBe(20);
	});

	test("regression-pin: 20 renderable servers → no overflow line", () => {
		const renderable = Array.from(
			{ length: 20 },
			(_, i) => `  s${String(i).padStart(2, "0")}: { host: h${i}.example.com, protocol: kafka }`,
		).join("\n");
		const parsed = parseYamlFile(
			`asyncapi: "3.0.0"
info: { title: T, version: "1" }
channels:
  q:
    address: rpc/q
operations:
  emit:
    action: send
    channel:
      $ref: "#/channels/q"
servers:
${renderable}
`,
			"x.yaml",
		);
		expect(parsed.source).not.toContain("... and");
		expect(parsed.source.match(/^- s\d\d/gm)?.length ?? 0).toBe(20);
	});

	test("regression-pin: 21 renderable servers → overflow shows 1", () => {
		const renderable = Array.from(
			{ length: 21 },
			(_, i) => `  s${String(i).padStart(2, "0")}: { host: h${i}.example.com, protocol: kafka }`,
		).join("\n");
		const parsed = parseYamlFile(
			`asyncapi: "3.0.0"
info: { title: T, version: "1" }
channels:
  q:
    address: rpc/q
operations:
  emit:
    action: send
    channel:
      $ref: "#/channels/q"
servers:
${renderable}
`,
			"x.yaml",
		);
		expect(parsed.source).toContain("- ... and 1 more\n");
	});
});
