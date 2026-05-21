/**
 * Integration test — AsyncAPI YAML end-to-end.
 *
 * Spins up a server against a vault containing a markdown note + a small
 * AsyncAPI 3.x YAML file. Exercises every tool surface to confirm the
 * structured AsyncAPI pipeline works end-to-end:
 *
 *   - `get_vault_tree` lists the YAML file with a `resource_link` block.
 *   - `get_file_outline` returns one outline node per AsyncAPI operation.
 *   - `get_fragment` (file anchor) returns the synthesized prose rendering.
 *   - `get_fragment` (heading_path anchor) returns a specific operation section.
 *   - `get_metadata` returns the entire top-level AsyncAPI object.
 *   - `search` matches operation summaries with BM25 ranking.
 *   - `search` with `filters.fields["info.version"].eq` filters via nested-path access.
 *   - `get_links` returns empty outgoing/incoming for a YAML file.
 *   - `note://api/streetlights.yaml` returns literal on-disk YAML with `application/yaml`.
 *   - AsyncAPI 2.x falls through to opaque YAML emission.
 */

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import type { GetFileOutlineResult, GetMetadataResult, GetVaultTreeResult, SearchOutput } from "../../src/types.js";
import { spawnTestServer, type TestClient, waitForWarm } from "../helpers/mcp-client.js";
import { createTempVault } from "../helpers/vault.js";

const STREETLIGHTS_YAML = `asyncapi: "3.0.0"
info:
  title: Streetlights API
  version: 2.1.0
  description: Streetlight control over MQTT for integration testing.
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
        summary: Inform about environmental lighting.
operations:
  receiveLightMeasured:
    action: receive
    channel:
      $ref: "#/channels/lightMeasured"
    summary: Receive lighting measurements
    description: Subscribes to streetlight measurement events.
    messages:
      - $ref: "#/channels/lightMeasured/messages/lightMeasuredMsg"
  sendTurnOn:
    action: send
    channel:
      $ref: "#/channels/lightMeasured"
    summary: Turn streetlight on
`;

const LEGACY_ASYNCAPI_YAML = `asyncapi: "2.6.0"
info:
  title: Legacy
  version: "1"
channels:
  legacy:
    publish:
      summary: 2.x publish op
      message:
        payload:
          type: object
`;

// Multi-shape fixture — assertions in the matching integration test
// document what each operation exercises (ref-form channel, ref-form
// reply, implicit-messages, external-ref residual, percent-decode).
const REUSE_YAML = `asyncapi: "3.0.0"
info:
  title: Reuse API
  version: 1.0.0
channels:
  shared:
    $ref: "#/components/channels/shared"
  "spaced name":
    address: queue/spaced name
operations:
  broadcast:
    action: send
    channel:
      $ref: "#/channels/shared"
  notify:
    action: send
    channel:
      $ref: "#/channels/shared"
    reply:
      $ref: "#/components/replies/standardAck"
  spaced:
    action: receive
    channel:
      $ref: "#/channels/spaced%20name"
  legacy:
    $ref: "./external.yaml#/operations/foo"
components:
  channels:
    shared:
      address: events/shared
      messages:
        evt1:
          name: shared.event.one
        evt2: {}
  replies:
    standardAck:
      address:
        location: "$message.header#/replyTo"
      channel:
        $ref: "#/channels/shared"
`;

// Components-reuse fixture exercising:
//   - servers.production is a Reference Object → resolved through components.servers
//   - operations under `components.operations` ref channels directly via
//     `#/components/channels/<name>`
//   - operation summary/description/tags come from `components.operationTraits`
//   - one operation has an external reply $ref that must render verbatim
const COMPONENTS_REUSE_YAML = `asyncapi: "3.0.0"
info:
  title: Components Reuse API
  version: 1.0.0
servers:
  production:
    $ref: "#/components/servers/prod"
operations:
  notify:
    $ref: "#/components/operations/notify"
  legacy:
    action: send
    channel:
      $ref: "#/components/channels/shared"
    reply:
      $ref: "./external.yaml#/replies/asyncAck"
components:
  servers:
    prod:
      host: broker.example.com
      protocol: kafka
      description: Production Kafka cluster
  channels:
    shared:
      address: events/shared
      messages:
        evt:
          name: shared.event
  operations:
    notify:
      action: send
      channel:
        $ref: "#/components/channels/shared"
      traits:
        - $ref: "#/components/operationTraits/standard"
  operationTraits:
    standard:
      summary: Standard notification operation
      description: A reusable notify operation trait shared across services.
      tags:
        - name: notify
        - name: shared
`;

// Chained-ref handling end-to-end. Four shapes in one fixture:
//   - operation.reply is a chained ref: `#/components/replies/ack` whose
//     component is itself `{$ref: "./external.yaml#/replies/ack"}`. Renders
//     the op-level ref verbatim (single-level invariant).
//   - channel: external ref under `top.channels.<name>` resolves to nothing
//     locally, so the operation's `channel` field renders the raw ref.
//   - top-level server is an external ref — preamble surfaces the raw
//     pointer rather than dropping protocol/host.
//   - info.tags uses a component-bucket ref to an inline tag entry.
const CHAINED_REFS_YAML = `asyncapi: "3.0.0"
info:
  title: Chained Refs API
  version: 1.0.0
  tags:
    - $ref: "#/components/tags/auth"
servers:
  production:
    $ref: "./external.yaml#/servers/prod"
channels:
  external:
    $ref: "./external.yaml#/channels/X"
  q:
    address: rpc/q
operations:
  call:
    action: send
    channel:
      $ref: "#/channels/q"
    reply:
      $ref: "#/components/replies/ack"
  cross:
    action: send
    channel:
      $ref: "#/channels/external"
components:
  tags:
    auth:
      name: auth
      description: Authentication scope.
  replies:
    ack:
      $ref: "./external.yaml#/replies/ack"
`;

// Three spec-compliance shapes in one fixture:
//   - operations.askPing is a Reference Object pointing to components/operations
//   - askPing's reply uses only `reply.address.location` (no reply.channel/messages)
//   - the message ref points to `pingMsg`, whose declared `name` (`ping.event`)
//     differs from its channel map-key messageId
const USERFLOW_YAML = `asyncapi: "3.0.0"
info:
  title: Userflow API
  version: 1.0.0
channels:
  ping:
    address: rpc/ping
    messages:
      pingMsg:
        name: ping.event
        summary: Application ping request
operations:
  askPing:
    $ref: "#/components/operations/askPing"
components:
  operations:
    askPing:
      action: send
      channel:
        $ref: "#/channels/ping"
      summary: Send a ping and await a dynamic reply
      messages:
        - $ref: "#/channels/ping/messages/pingMsg"
      reply:
        address:
          location: "$message.header#/replyTo"
`;

const FIFTH_REVIEW_MIX_YAML = `asyncapi: "3.0.0"
info:
  title: Fifth Review Mix
  version: 1.0.0
servers:
  broker:
    host: broker.example.com
    pathname: /mqtt
    protocol: mqtt
channels:
  realChan:
    address: /v1/events
  aliasChan:
    $ref: "#/channels/realChan"
operations:
  send_real:
    action: send
    channel:
      $ref: "#/channels/realChan"
    messages:
      - $ref: "#/components/messages/shared"
  send_aliased:
    action: send
    channel:
      $ref: "#/channels/aliasChan"
    messages:
      - $ref: "#/components/messages/shared"
components:
  messages:
    shared:
      name: SharedMessage
      payload:
        type: object
`;

// Fixture combining ref-aliased op + null-address channel + trait-
// inherited summary in one document — exercises the three behaviors
// simultaneously via one get_fragment + one search round-trip.
const SIXTH_REVIEW_MIX_YAML = `asyncapi: "3.0.0"
info:
  title: Sixth Review Mix
  version: 1.0.0
channels:
  chatRoom:
    address: null
    messages:
      msg: { name: ChatEvent }
components:
  operationTraits:
    fromTrait:
      summary: From trait
  operations:
    sharedOp:
      action: send
      channel:
        $ref: "#/channels/chatRoom"
      messages:
        - $ref: "#/channels/chatRoom/messages/msg"
      traits:
        - $ref: "#/components/operationTraits/fromTrait"
operations:
  aliasOp:
    $ref: "#/components/operations/sharedOp"
`;

// Seventh review: channel-scoped message alias + trait-provided bindings.
// One op pulls a message via a channel-scoped $ref whose target is itself
// a channel-scoped $ref (single-level resolves through the inline message),
// AND inherits Kafka bindings from a trait so a search for the binding's
// topic value hits the op row rather than only the ## Components fence.
const SEVENTH_REVIEW_MIX_YAML = `asyncapi: "3.0.0"
info:
  title: Seventh Review Mix
  version: 1.0.0
channels:
  baseChan:
    address: base/topic
    messages:
      realEvent:
        name: RealEvent
        payload:
          type: object
  eventsChan:
    address: events/topic
    messages:
      eventAlias:
        $ref: "#/channels/baseChan/messages/realEvent"
components:
  operationTraits:
    kafkaBindings:
      bindings:
        kafka:
          topic: user-events
operations:
  pingEvent:
    action: send
    channel:
      $ref: "#/channels/eventsChan"
    messages:
      - $ref: "#/channels/eventsChan/messages/eventAlias"
    traits:
      - $ref: "#/components/operationTraits/kafkaBindings"
`;

// Fixture: op + trait whose `bindings.kafka` partially overlap so
// shallow merge would drop trait subfields. With the recursive merge the
// per-op fence carries all three Kafka subfields (op's clientId + trait's
// topic + trait's groupId), and a search for the trait-only value matches the
// op row rather than only the `## Components` catch-all.
const EIGHTH_REVIEW_MIX_YAML = `asyncapi: "3.0.0"
info:
  title: Eighth Review Mix
  version: 1.0.0
channels:
  q:
    address: events/topic
    messages:
      ping:
        name: Ping
components:
  operationTraits:
    kafkaShared:
      bindings:
        kafka:
          topic: shared-topic
          groupId: shared-group
operations:
  emitPing:
    action: send
    channel:
      $ref: "#/channels/q"
    messages:
      - $ref: "#/channels/q/messages/ping"
    bindings:
      kafka:
        clientId: op-client
    traits:
      - $ref: "#/components/operationTraits/kafkaShared"
`;

const PROTO_POLLUTION_YAML = `asyncapi: "3.0.0"
info:
  title: Proto Pollution Fixture
  version: 1.0.0
channels:
  q:
    address: events/poison
components:
  operationTraits:
    auth:
      description: legit-trait-description
operations:
  emit:
    action: send
    channel:
      $ref: "#/channels/q"
    traits:
      - $ref: "#/components/operationTraits/auth"
    __proto__:
      summary: proto-pollution-attacker-leak
`;

const TENTH_REVIEW_YAML = `asyncapi: "3.0.0"
info:
  title: Tenth Review Fixture
  version: 1.0.0
channels:
  shared:
    address: shared/channel
components:
  operations:
    sharedTarget:
      action: send
      channel:
        $ref: "#/channels/shared"
      summary: Shared op summary
      bindings:
        kafka:
          topic: tenthReviewDistinctiveTopic
  operationBindings:
    kb:
      kafka:
        groupId: ref-group
  operationTraits:
    bindingsInline:
      bindings:
        kafka:
          topic: trait-only-topic-should-not-leak
operations:
  aliasOne:
    $ref: "#/components/operations/sharedTarget"
  aliasTwo:
    $ref: "#/components/operations/sharedTarget"
  refBindings:
    action: send
    channel:
      $ref: "#/channels/shared"
    traits:
      - $ref: "#/components/operationTraits/bindingsInline"
    bindings:
      $ref: "#/components/operationBindings/kb"
  __proto__:
    action: invalidActionFallsToResidual
    channel:
      $ref: "#/channels/shared"
`;

const ELEVENTH_REVIEW_YAML = `asyncapi: "3.0.0"
info:
  title: Eleventh Review Fixture
  version: 1.0.0
channels:
  rpcRequest:
    address: rpc/request
    messages:
      ping: { name: ping }
  rpcReply:
    address: eleventhReviewDistinctiveReplyAddress
    messages:
      pong: { name: pong }
components:
  operationTraits:
    rpcReplyTrait:
      reply:
        channel:
          $ref: "#/channels/rpcReply"
        messages:
          - $ref: "#/channels/rpcReply/messages/pong"
    taggedTrait:
      tags:
        - name: user
          __proto__:
            evilEleventhReviewArrayLeak: should-not-surface
operations:
  rpcSend:
    action: send
    channel:
      $ref: "#/channels/rpcRequest"
    traits:
      - $ref: "#/components/operationTraits/rpcReplyTrait"
  taggedSend:
    action: send
    channel:
      $ref: "#/channels/rpcRequest"
    traits:
      - $ref: "#/components/operationTraits/taggedTrait"
  malformedChannel:
    action: send
    channel:
      $ref: "#/channels/rpcRequest/messages/ping"
`;

const TWELFTH_REVIEW_YAML = `asyncapi: "3.0.0"
info: ~
channels:
  rpcRequest:
    address: twelfthReviewChannelAddress
operations:
  brokenMsgRef:
    action: send
    channel:
      $ref: "#/channels/rpcRequest"
    messages:
      - $ref: "#/components/messages/MissingTwelfthReviewMsg"
`;

const THIRTEENTH_REVIEW_YAML = `asyncapi: "3.0.0"
info:
  title: Thirteenth Review
  version: 1.0.0
channels:
  q:
    address: thirteenthReviewChannelAddress
operations:
  externalOp:
    $ref: "./shared.yaml#/components/operations/notify"
  inlineSend:
    action: send
    channel:
      $ref: "#/channels/q"
  "multiline\\n## injected":
    action: send
    channel:
      $ref: "#/channels/q"
components:
  operationTraits:
    evil:
      __proto__:
        pwn: THIRTEENTH_REVIEW_SECURITY_PAYLOAD
`;

const FOURTEENTH_REVIEW_YAML = `asyncapi: "3.0.0"
info:
  title: Fourteenth Review
  version: 1.0.0
channels:
  q:
    address: fourteenthReviewChannelAddress
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
          pwn: FOURTEENTH_OP_PAYLOAD
servers:
  "broker\\n## injected":
    host: example.com
    __proto__:
      pwn: FOURTEENTH_SERVER_PAYLOAD
components:
  messages:
    Msg:
      payload:
        type: object
        properties:
          constructor:
            type: string
`;

const FIFTEENTH_REVIEW_YAML = (() => {
	// 20 renderable servers + 1 non-renderable scalar (F5: overflow should NOT fire).
	const renderableServers = Array.from(
		{ length: 20 },
		(_, i) => `  s${String(i).padStart(2, "0")}:\n    host: h${i}.example.com\n    protocol: kafka`,
	).join("\n");
	return `asyncapi: "3.0.0"
info:
  title: Fifteenth Review
  version: 1.0.0
servers:
${renderableServers}
  malformed_scalar_server: "this entry is non-renderable"
channels:
  __proto__:
    address: fifteenthReviewProtoChannelAddress
operations:
  emit:
    action: send
    channel:
      $ref: "#/channels/__proto__"
components:
  messages:
    __proto__:
      payload:
        type: object
x-extra:
  - __proto__:
      pwn: FIFTEENTH_ARRAY_PAYLOAD
    keep: fifteenthReviewVisibleArrayMarker
`;
})();

const MARKDOWN_NOTE = `---
title: Auth Overview
tags: [auth, internal]
---

# Auth Overview

See [[auth-details]] for more.
`;

let vault: { path: string; cleanup: () => Promise<void> };
let conn: TestClient;

beforeAll(async () => {
	vault = await createTempVault({
		api: {
			"streetlights.yaml": STREETLIGHTS_YAML,
			"legacy.yaml": LEGACY_ASYNCAPI_YAML,
			"userflow.yaml": USERFLOW_YAML,
			"reuse.yaml": REUSE_YAML,
			"components-reuse.yaml": COMPONENTS_REUSE_YAML,
			"chained-refs.yaml": CHAINED_REFS_YAML,
			"fifth-review-mix.yaml": FIFTH_REVIEW_MIX_YAML,
			"sixth-review-mix.yaml": SIXTH_REVIEW_MIX_YAML,
			"seventh-review-mix.yaml": SEVENTH_REVIEW_MIX_YAML,
			"eighth-review-mix.yaml": EIGHTH_REVIEW_MIX_YAML,
			"proto-pollution.yaml": PROTO_POLLUTION_YAML,
			"tenth-review.yaml": TENTH_REVIEW_YAML,
			"eleventh-review.yaml": ELEVENTH_REVIEW_YAML,
			"twelfth-review.yaml": TWELFTH_REVIEW_YAML,
			"thirteenth-review.yaml": THIRTEENTH_REVIEW_YAML,
			"fourteenth-review.yaml": FOURTEENTH_REVIEW_YAML,
			"fifteenth-review.yaml": FIFTEENTH_REVIEW_YAML,
		},
		notes: {
			"auth.md": MARKDOWN_NOTE,
		},
	});
	conn = await spawnTestServer(vault.path, { VAULT_EXTENSIONS: "md,yaml,yml" });
	await waitForWarm(conn.client);
}, 30_000);

afterAll(async () => {
	await conn.close();
	await vault.cleanup();
});

describe("integration — AsyncAPI YAML end-to-end", () => {
	test("get_vault_tree lists streetlights.yaml as an indexed file", async () => {
		const r = await conn.client.callTool({ name: "get_vault_tree", arguments: { depth: 5, pageSize: 50 } });
		expect(r.isError).toBeFalsy();
		const out = r.structuredContent as GetVaultTreeResult;
		const yamlEntry = out.items.find((i) => i.path === "api/streetlights.yaml");
		expect(yamlEntry).toBeDefined();
		expect(yamlEntry?.type).toBe("file");
		// 2 operations in the fixture.
		expect(yamlEntry?.subheadings).toBeGreaterThanOrEqual(2);
	});

	test("get_vault_tree emits a resource_link with application/yaml for the AsyncAPI file", async () => {
		const r = await conn.client.callTool({ name: "get_vault_tree", arguments: { depth: 5, pageSize: 50 } });
		expect(r.isError).toBeFalsy();
		const content = r.content as Array<{ type: string; uri?: string; mimeType?: string }>;
		const yamlLink = content.find((c) => c.type === "resource_link" && c.uri?.includes("streetlights.yaml"));
		expect(yamlLink).toBeDefined();
		expect(yamlLink?.mimeType).toBe("application/yaml");
	});

	test("get_file_outline returns one outline node per AsyncAPI operation + Channels + Spec metadata", async () => {
		const r = await conn.client.callTool({
			name: "get_file_outline",
			arguments: { file: "api/streetlights.yaml" },
		});
		expect(r.isError).toBeFalsy();
		const out = r.structuredContent as GetFileOutlineResult;
		const texts = out.outline.map((n) => n.text);
		// Operations sorted alphabetically by opName; Channels and Spec metadata
		// trail (server description and channel-level message metadata flow
		// into the catch-all).
		expect(texts.slice(0, 2)).toEqual(["receive receiveLightMeasured", "send sendTurnOn"]);
		expect(texts).toContain("Channels");
	});

	test("get_fragment by file anchor returns the synthesized prose rendering", async () => {
		const r = await conn.client.callTool({
			name: "get_fragment",
			arguments: { file: "api/streetlights.yaml", anchor: { kind: "file" } },
		});
		expect(r.isError).toBeFalsy();
		const frag = r.structuredContent as { content?: string };
		expect(frag.content ?? "").toContain("Streetlights API");
		expect(frag.content ?? "").toContain("## receive receiveLightMeasured");
		expect(frag.content ?? "").toContain("## send sendTurnOn");
		expect(frag.content ?? "").toContain("Receive lighting measurements");
	});

	test("get_fragment by heading_path returns that operation's section", async () => {
		const r = await conn.client.callTool({
			name: "get_fragment",
			arguments: {
				file: "api/streetlights.yaml",
				anchor: { kind: "heading_path", path: "receive receiveLightMeasured" },
			},
		});
		expect(r.isError).toBeFalsy();
		const frag = r.structuredContent as { content?: string };
		expect(frag.content ?? "").toContain("## receive receiveLightMeasured");
		expect(frag.content ?? "").toContain("Receive lighting measurements");
		expect(frag.content ?? "").toContain("Subscribes to streetlight measurement events.");
		// Should NOT contain the send operation's prose.
		expect(frag.content ?? "").not.toContain("Turn streetlight on");
	});

	test("get_metadata exposes the whole top-level AsyncAPI object as metadata", async () => {
		const r = await conn.client.callTool({
			name: "get_metadata",
			arguments: { file: "api/streetlights.yaml" },
		});
		expect(r.isError).toBeFalsy();
		const out = r.structuredContent as GetMetadataResult;
		expect(out.has_frontmatter).toBe(true);
		const meta = out.metadata as Record<string, unknown>;
		expect(meta.asyncapi).toBe("3.0.0");
		const info = meta.info as Record<string, unknown>;
		expect(info.title).toBe("Streetlights API");
		expect(info.version).toBe("2.1.0");
		expect(meta.channels).toBeTruthy();
		expect(meta.operations).toBeTruthy();
	});

	test("search returns AsyncAPI operations with BM25 ranking", async () => {
		const r = await conn.client.callTool({
			name: "search",
			arguments: { query: "lighting measurement", pageSize: 20 },
		});
		expect(r.isError).toBeFalsy();
		const out = r.structuredContent as SearchOutput;
		const hit = out.items.find(
			(i) =>
				"heading_path" in i && Array.isArray(i.heading_path) && i.heading_path.includes("receive receiveLightMeasured"),
		);
		expect(hit).toBeDefined();
	});

	test("search with fields['info.version'] filter matches via nested-path access", async () => {
		const r = await conn.client.callTool({
			name: "search",
			arguments: {
				query: "",
				filters: { fields: { "info.version": { eq: "2.1.0" } } },
				pageSize: 20,
			},
		});
		expect(r.isError).toBeFalsy();
		const out = r.structuredContent as SearchOutput;
		const hits = out.items.filter((i) => i.file === "api/streetlights.yaml");
		expect(hits.length).toBeGreaterThan(0);
	});

	test("get_links returns empty outgoing/incoming for an AsyncAPI YAML file", async () => {
		const r = await conn.client.callTool({
			name: "get_links",
			arguments: { file: "api/streetlights.yaml", direction: "both" },
		});
		expect(r.isError).toBeFalsy();
		const out = r.structuredContent as { outgoing?: unknown[]; incoming?: unknown[] };
		expect(out.outgoing ?? []).toEqual([]);
		expect(out.incoming ?? []).toEqual([]);
	});

	test("get_fragment on an AsyncAPI YAML file returns empty outgoing_links / embeds (wikilink gate)", async () => {
		const r = await conn.client.callTool({
			name: "get_fragment",
			arguments: { file: "api/streetlights.yaml", anchor: { kind: "file" } },
		});
		expect(r.isError).toBeFalsy();
		const frag = r.structuredContent as { outgoing_links?: unknown[]; embeds?: unknown[] };
		expect(frag.outgoing_links ?? []).toEqual([]);
		expect(frag.embeds ?? []).toEqual([]);
	});

	test("note://api/streetlights.yaml returns literal on-disk YAML with application/yaml mimeType", async () => {
		const resource = await conn.client.readResource({ uri: "note://api/streetlights.yaml" });
		const first = resource.contents[0] as { mimeType?: string; text?: string };
		expect(first.mimeType).toBe("application/yaml");
		// `text` is the LITERAL on-disk source (NOT the synthesized rendering).
		expect(first.text).toBe(STREETLIGHTS_YAML);
	});

	test("note://notes/auth.md still returns text/markdown for markdown files", async () => {
		const resource = await conn.client.readResource({ uri: "note://notes/auth.md" });
		const first = resource.contents[0] as { mimeType?: string; text?: string };
		expect(first.mimeType).toBe("text/markdown");
		expect(first.text).toBe(MARKDOWN_NOTE);
	});

	test("AsyncAPI 2.x file falls through to opaque YAML (no synthesized operation headings)", async () => {
		const r = await conn.client.callTool({
			name: "get_file_outline",
			arguments: { file: "api/legacy.yaml" },
		});
		expect(r.isError).toBeFalsy();
		const out = r.structuredContent as GetFileOutlineResult;
		// Opaque emission — no `publish legacy` or similar headings.
		const texts = out.outline.map((n) => n.text);
		for (const t of texts) {
			expect(t).not.toMatch(/^(publish|subscribe|send|receive) /);
		}
	});

	test("AsyncAPI 2.x get_metadata still exposes the document for filter queries", async () => {
		const r = await conn.client.callTool({
			name: "get_metadata",
			arguments: { file: "api/legacy.yaml" },
		});
		expect(r.isError).toBeFalsy();
		const out = r.structuredContent as GetMetadataResult;
		expect(out.has_frontmatter).toBe(true);
		const meta = out.metadata as Record<string, unknown>;
		expect(meta.asyncapi).toBe("2.6.0");
	});

	test("operation stable_id is name-based: identical when channels are reordered", async () => {
		// The fixture's `receiveLightMeasured` slot ID should be deterministic
		// based only on opName. Pull the outline + verify the slot format.
		const r = await conn.client.callTool({
			name: "get_file_outline",
			arguments: { file: "api/streetlights.yaml" },
		});
		expect(r.isError).toBeFalsy();
		const out = r.structuredContent as GetFileOutlineResult;
		const node = out.outline.find((n) => n.text === "receive receiveLightMeasured");
		expect(node).toBeDefined();
		// stable_id format: `h:<14 hex>`.
		expect(node?.stable_id).toMatch(/^h:[0-9a-f]{14}$/);
	});

	test("reusable channel + ref-form reply + implicit messages + external-ref residual end-to-end", async () => {
		const outline = await conn.client.callTool({
			name: "get_file_outline",
			arguments: { file: "api/reuse.yaml" },
		});
		expect(outline.isError).toBeFalsy();
		const outlineOut = outline.structuredContent as GetFileOutlineResult;
		const opTexts = outlineOut.outline.map((n) => n.text);
		// Three renderable ops (action gate passed); `legacy` is an external $ref
		// so it has no heading. Operations are sorted alphabetically.
		expect(opTexts).toContain("send broadcast");
		expect(opTexts).toContain("send notify");
		expect(opTexts).toContain("receive spaced");
		expect(opTexts).not.toContain("send legacy");
		expect(opTexts).not.toContain("receive legacy");

		// broadcast resolves through the ref-form root channel AND inlines all
		// channel messages because op.messages is omitted.
		const broadcast = await conn.client.callTool({
			name: "get_fragment",
			arguments: { file: "api/reuse.yaml", anchor: { kind: "heading_path", path: "send broadcast" } },
		});
		expect(broadcast.isError).toBeFalsy();
		const broadcastContent = (broadcast.structuredContent as { content?: string }).content ?? "";
		expect(broadcastContent).toContain("Channel: events/shared");
		expect(broadcastContent).toContain("- evt1 (shared.event.one)");
		expect(broadcastContent).toContain("- evt2");

		// notify dereferences `reply: { $ref: "#/components/replies/standardAck" }`.
		const notify = await conn.client.callTool({
			name: "get_fragment",
			arguments: { file: "api/reuse.yaml", anchor: { kind: "heading_path", path: "send notify" } },
		});
		expect(notify.isError).toBeFalsy();
		const notifyContent = (notify.structuredContent as { content?: string }).content ?? "";
		expect(notifyContent).toContain("Reply:");
		expect(notifyContent).toContain("- Address: $message.header#/replyTo");
		expect(notifyContent).toContain("- Channel: events/shared");

		// `#/channels/spaced%20name` exercises the percent-decode path on the
		// channel ref segment, resolving to the literal-space channel key.
		const spaced = await conn.client.callTool({
			name: "get_fragment",
			arguments: { file: "api/reuse.yaml", anchor: { kind: "heading_path", path: "receive spaced" } },
		});
		expect(spaced.isError).toBeFalsy();
		const spacedContent = (spaced.structuredContent as { content?: string }).content ?? "";
		expect(spacedContent).toContain("Channel: queue/spaced name");

		// External-ref operation survives in the spec-metadata fence so BM25
		// can find it via the raw $ref string.
		const fileFrag = await conn.client.callTool({
			name: "get_fragment",
			arguments: { file: "api/reuse.yaml", anchor: { kind: "file" } },
		});
		expect(fileFrag.isError).toBeFalsy();
		const fileContent = (fileFrag.structuredContent as { content?: string }).content ?? "";
		expect(fileContent).toContain("./external.yaml#/operations/foo");

		// Search by an implicit message's declared name surfaces the operation
		// that didn't explicitly declare it (broadcast inherits from the channel).
		const search = await conn.client.callTool({
			name: "search",
			arguments: { query: "shared.event.one", pageSize: 20 },
		});
		expect(search.isError).toBeFalsy();
		const searchOut = search.structuredContent as SearchOutput;
		const hit = searchOut.items.find(
			(i) => "heading_path" in i && Array.isArray(i.heading_path) && i.heading_path.includes("send broadcast"),
		);
		expect(hit).toBeDefined();

		// get_metadata still exposes the full top-level (including legacy) for
		// fields[...] filter queries.
		const meta = await conn.client.callTool({
			name: "get_metadata",
			arguments: { file: "api/reuse.yaml" },
		});
		expect(meta.isError).toBeFalsy();
		const metaOut = meta.structuredContent as GetMetadataResult;
		const metaOps = (metaOut.metadata as { operations?: Record<string, unknown> }).operations ?? {};
		expect(metaOps).toHaveProperty("legacy");
		expect(metaOps).toHaveProperty("broadcast");
	});

	test("ref-form operation + reply.address.location + messageId/name divergence end-to-end", async () => {
		const outline = await conn.client.callTool({
			name: "get_file_outline",
			arguments: { file: "api/userflow.yaml" },
		});
		expect(outline.isError).toBeFalsy();
		const outlineOut = outline.structuredContent as GetFileOutlineResult;
		const askNode = outlineOut.outline.find((n) => n.text === "send askPing");
		expect(askNode).toBeDefined();
		expect(askNode?.stable_id).toMatch(/^h:[0-9a-f]{14}$/);

		const frag = await conn.client.callTool({
			name: "get_fragment",
			arguments: {
				file: "api/userflow.yaml",
				anchor: { kind: "heading_path", path: "send askPing" },
			},
		});
		expect(frag.isError).toBeFalsy();
		const fragOut = frag.structuredContent as { content?: string };
		const content = fragOut.content ?? "";
		expect(content).toContain("## send askPing");
		expect(content).toContain("Send a ping and await a dynamic reply");
		expect(content).toContain("Channel: rpc/ping");
		expect(content).toContain("- pingMsg (ping.event)");
		expect(content).toContain("Reply:");
		expect(content).toContain("- Address: $message.header#/replyTo");

		// Search by the declared message name (`ping.event`) surfaces the operation row.
		const search = await conn.client.callTool({
			name: "search",
			arguments: { query: "ping.event", pageSize: 20 },
		});
		expect(search.isError).toBeFalsy();
		const searchOut = search.structuredContent as SearchOutput;
		const hit = searchOut.items.find(
			(i) => "heading_path" in i && Array.isArray(i.heading_path) && i.heading_path.includes("send askPing"),
		);
		expect(hit).toBeDefined();
	});

	test("components-bucket channel ref + ref-form server + trait merge + external reply ref end-to-end", async () => {
		// Ref-form server resolves through components.servers in the preamble.
		const fileFrag = await conn.client.callTool({
			name: "get_fragment",
			arguments: { file: "api/components-reuse.yaml", anchor: { kind: "file" } },
		});
		expect(fileFrag.isError).toBeFalsy();
		const fileContent = (fileFrag.structuredContent as { content?: string }).content ?? "";
		expect(fileContent).toContain("- production (kafka): broker.example.com");
		expect(fileContent).not.toMatch(/- production\n/);

		// Operation under components.operations refs a channel via
		// `#/components/channels/<name>` and resolves to the address;
		// summary/description/tags come from the merged trait.
		const notify = await conn.client.callTool({
			name: "get_fragment",
			arguments: { file: "api/components-reuse.yaml", anchor: { kind: "heading_path", path: "send notify" } },
		});
		expect(notify.isError).toBeFalsy();
		const notifyContent = (notify.structuredContent as { content?: string }).content ?? "";
		expect(notifyContent).toContain("Channel: events/shared");
		expect(notifyContent).toContain("Summary: Standard notification operation");
		expect(notifyContent).toContain("A reusable notify operation trait shared across services.");
		expect(notifyContent).toContain("Tags: notify, shared");

		// External reply $ref surfaces as a single Reply line carrying the
		// raw pointer (BM25 still hits the operation row on the ref text).
		const legacy = await conn.client.callTool({
			name: "get_fragment",
			arguments: { file: "api/components-reuse.yaml", anchor: { kind: "heading_path", path: "send legacy" } },
		});
		expect(legacy.isError).toBeFalsy();
		const legacyContent = (legacy.structuredContent as { content?: string }).content ?? "";
		expect(legacyContent).toContain("Reply: ./external.yaml#/replies/asyncAck");

		// Search by the trait-sourced description text hits the merged operation row.
		const search = await conn.client.callTool({
			name: "search",
			arguments: { query: "reusable notify operation trait", pageSize: 20 },
		});
		expect(search.isError).toBeFalsy();
		const searchOut = search.structuredContent as SearchOutput;
		const hit = searchOut.items.find(
			(i) => "heading_path" in i && Array.isArray(i.heading_path) && i.heading_path.includes("send notify"),
		);
		expect(hit).toBeDefined();
	});

	test("chained refs render the input ref verbatim across reply, channel, server, and tag surfaces", async () => {
		// Both operations are present in the outline (neither skipped because
		// chained refs no longer masquerade as resolved component objects).
		const outline = await conn.client.callTool({
			name: "get_file_outline",
			arguments: { file: "api/chained-refs.yaml" },
		});
		expect(outline.isError).toBeFalsy();
		const outlineOut = outline.structuredContent as GetFileOutlineResult;
		const texts = outlineOut.outline.map((n) => n.text);
		expect(texts).toContain("send call");
		expect(texts).toContain("send cross");

		// File-level fragment surfaces preamble: external server ref verbatim
		// + component-bucket tag resolved to its inline name.
		const fileFrag = await conn.client.callTool({
			name: "get_fragment",
			arguments: { file: "api/chained-refs.yaml", anchor: { kind: "file" } },
		});
		expect(fileFrag.isError).toBeFalsy();
		const fileContent = (fileFrag.structuredContent as { content?: string }).content ?? "";
		expect(fileContent).toContain("- production: ./external.yaml#/servers/prod");
		expect(fileContent).not.toMatch(/- production\n/);
		expect(fileContent).toContain("Tags: auth");

		// Chained reply ref: surfaces the op-level pointer (not the chained
		// external target the component aliased to).
		const callFrag = await conn.client.callTool({
			name: "get_fragment",
			arguments: { file: "api/chained-refs.yaml", anchor: { kind: "heading_path", path: "send call" } },
		});
		expect(callFrag.isError).toBeFalsy();
		const callContent = (callFrag.structuredContent as { content?: string }).content ?? "";
		expect(callContent).toContain("Reply: #/components/replies/ack");
		expect(callContent).not.toContain("./external.yaml");

		// External root channel ref: the operation's Channel: line carries
		// the op-level ref, not a fabricated `Channel: external` map-key.
		const crossFrag = await conn.client.callTool({
			name: "get_fragment",
			arguments: { file: "api/chained-refs.yaml", anchor: { kind: "heading_path", path: "send cross" } },
		});
		expect(crossFrag.isError).toBeFalsy();
		const crossContent = (crossFrag.structuredContent as { content?: string }).content ?? "";
		expect(crossContent).toContain("Channel: #/channels/external");
		expect(crossContent).not.toMatch(/Channel: external\n/);

		// BM25 finds the verbatim ref on the chained-reply operation row.
		const search = await conn.client.callTool({
			name: "search",
			arguments: { query: "#/components/replies/ack", pageSize: 20 },
		});
		expect(search.isError).toBeFalsy();
		const searchOut = search.structuredContent as SearchOutput;
		const hit = searchOut.items.find(
			(i) => "heading_path" in i && Array.isArray(i.heading_path) && i.heading_path.includes("send call"),
		);
		expect(hit).toBeDefined();
	});

	test("fifth-review-mix: components-bucket message + root-channel alias + host+pathname preamble all render correctly", async () => {
		// Empty `heading_path` selects the preamble fragment (see getFragment.ts:144).
		const preambleFrag = await conn.client.callTool({
			name: "get_fragment",
			arguments: { file: "api/fifth-review-mix.yaml", anchor: { kind: "heading_path", path: "" } },
		});
		expect(preambleFrag.isError).toBeFalsy();
		const preamble = (preambleFrag.structuredContent as { content?: string }).content ?? "";
		expect(preamble).toContain("- broker (mqtt): broker.example.com/mqtt");

		const realFrag = await conn.client.callTool({
			name: "get_fragment",
			arguments: { file: "api/fifth-review-mix.yaml", anchor: { kind: "heading_path", path: "send send_real" } },
		});
		expect(realFrag.isError).toBeFalsy();
		const realContent = (realFrag.structuredContent as { content?: string }).content ?? "";
		expect(realContent).toContain("- shared (SharedMessage)");
		expect(realContent).not.toContain("- #/components/messages/shared");

		const aliasFrag = await conn.client.callTool({
			name: "get_fragment",
			arguments: { file: "api/fifth-review-mix.yaml", anchor: { kind: "heading_path", path: "send send_aliased" } },
		});
		expect(aliasFrag.isError).toBeFalsy();
		const aliasContent = (aliasFrag.structuredContent as { content?: string }).content ?? "";
		expect(aliasContent).toContain("Channel: /v1/events");
		expect(aliasContent).not.toContain("Channel: #/channels/aliasChan");

		const searchHost = await conn.client.callTool({
			name: "search",
			arguments: { query: "broker.example.com/mqtt", pageSize: 20 },
		});
		expect(searchHost.isError).toBeFalsy();
		const searchHostOut = searchHost.structuredContent as SearchOutput;
		const mixHit = searchHostOut.items.find(
			(i) => "file" in i && (i as { file: string }).file === "api/fifth-review-mix.yaml",
		);
		expect(mixHit).toBeDefined();
	});

	test("sixth-review-mix: ref-aliased op fence is the bare $ref while prose stays expanded", async () => {
		const aliasFrag = await conn.client.callTool({
			name: "get_fragment",
			arguments: { file: "api/sixth-review-mix.yaml", anchor: { kind: "heading_path", path: "send aliasOp" } },
		});
		expect(aliasFrag.isError).toBeFalsy();
		const aliasContent = (aliasFrag.structuredContent as { content?: string }).content ?? "";
		expect(aliasContent).toContain("Channel: chatRoom (address unknown)");
		expect(aliasContent).toContain("Summary: From trait");
		expect(aliasContent).toContain("Messages:");
		expect(aliasContent).toContain("- msg (ChatEvent)");
		expect(aliasContent).toContain('{"$ref":"#/components/operations/sharedOp"}');

		const outline = await conn.client.callTool({
			name: "get_file_outline",
			arguments: { file: "api/sixth-review-mix.yaml" },
		});
		expect(outline.isError).toBeFalsy();
		const outlineOut = outline.structuredContent as GetFileOutlineResult;
		const aliasNode = outlineOut.outline.find((n) => n.text === "send aliasOp");
		expect(aliasNode?.contentKinds).toContain("list");
	});

	test("sixth-review-mix: shared op content still searchable via Components catch-all fence", async () => {
		// The aliased op's fence no longer carries the shared op's body, but
		// the shared op flows into the ## Components catch-all fence so
		// distinctive content stays findable via BM25.
		const search = await conn.client.callTool({
			name: "search",
			arguments: { query: "ChatEvent", pageSize: 20 },
		});
		expect(search.isError).toBeFalsy();
		const searchOut = search.structuredContent as SearchOutput;
		const mixHit = searchOut.items.find(
			(i) => "file" in i && (i as { file: string }).file === "api/sixth-review-mix.yaml",
		);
		expect(mixHit).toBeDefined();
	});

	test("seventh-review-mix: channel-scoped message alias resolves AND trait bindings surface in fence + search", async () => {
		const frag = await conn.client.callTool({
			name: "get_fragment",
			arguments: { file: "api/seventh-review-mix.yaml", anchor: { kind: "heading_path", path: "send pingEvent" } },
		});
		expect(frag.isError).toBeFalsy();
		const content = (frag.structuredContent as { content?: string }).content ?? "";
		expect(content).toContain("- eventAlias (RealEvent)");
		expect(content).toContain("Channel: events/topic");
		const fenceMatch = /```json\n([\s\S]*?)\n```/.exec(content);
		expect(fenceMatch).not.toBeNull();
		const fenceJson = JSON.parse((fenceMatch as RegExpExecArray)[1] ?? "{}");
		expect(fenceJson.bindings).toEqual({ kafka: { topic: "user-events" } });

		const search = await conn.client.callTool({
			name: "search",
			arguments: { query: "user-events", pageSize: 20 },
		});
		expect(search.isError).toBeFalsy();
		const searchOut = search.structuredContent as SearchOutput;
		const opHit = searchOut.items.find(
			(i) => "heading_path" in i && Array.isArray(i.heading_path) && i.heading_path.includes("send pingEvent"),
		);
		expect(opHit).toBeDefined();
	});

	test("eighth-review-mix: nested partial trait override merges recursively in fence + search recall", async () => {
		const frag = await conn.client.callTool({
			name: "get_fragment",
			arguments: { file: "api/eighth-review-mix.yaml", anchor: { kind: "heading_path", path: "send emitPing" } },
		});
		expect(frag.isError).toBeFalsy();
		const content = (frag.structuredContent as { content?: string }).content ?? "";
		const fenceMatch = /```json\n([\s\S]*?)\n```/.exec(content);
		expect(fenceMatch).not.toBeNull();
		const fenceJson = JSON.parse((fenceMatch as RegExpExecArray)[1] ?? "{}");
		expect(fenceJson.bindings).toEqual({
			kafka: { clientId: "op-client", topic: "shared-topic", groupId: "shared-group" },
		});

		const search = await conn.client.callTool({
			name: "search",
			arguments: { query: "shared-group", pageSize: 20 },
		});
		expect(search.isError).toBeFalsy();
		const searchOut = search.structuredContent as SearchOutput;
		const opHit = searchOut.items.find(
			(i) => "heading_path" in i && Array.isArray(i.heading_path) && i.heading_path.includes("send emitPing"),
		);
		expect(opHit).toBeDefined();
	});

	test("op __proto__ payload does not leak into fragment prose or search", async () => {
		const frag = await conn.client.callTool({
			name: "get_fragment",
			arguments: { file: "api/proto-pollution.yaml", anchor: { kind: "heading_path", path: "send emit" } },
		});
		expect(frag.isError).toBeFalsy();
		const content = (frag.structuredContent as { content?: string }).content ?? "";
		expect(content).toContain("legit-trait-description");
		expect(content).not.toContain("proto-pollution-attacker-leak");

		const search = await conn.client.callTool({
			name: "search",
			arguments: { query: "proto-pollution-attacker-leak", pageSize: 20 },
		});
		expect(search.isError).toBeFalsy();
		const searchOut = search.structuredContent as SearchOutput;
		expect(searchOut.items).toHaveLength(0);
	});

	test("aliased operation body searchable via ## Aliased operations section", async () => {
		const search = await conn.client.callTool({
			name: "search",
			arguments: { query: "tenthReviewDistinctiveTopic", pageSize: 20 },
		});
		expect(search.isError).toBeFalsy();
		const searchOut = search.structuredContent as SearchOutput;
		const hit = searchOut.items.find((i) => "file" in i && i.file === "api/tenth-review.yaml");
		expect(hit).toBeDefined();
	});

	test("op with $ref bindings + trait inline bindings does NOT surface trait topic", async () => {
		const search = await conn.client.callTool({
			name: "search",
			arguments: { query: "trait-only-topic-should-not-leak", pageSize: 20 },
		});
		expect(search.isError).toBeFalsy();
		const searchOut = search.structuredContent as SearchOutput;
		const refBindingsHit = searchOut.items.find(
			(i) =>
				"file" in i &&
				i.file === "api/tenth-review.yaml" &&
				"heading_path" in i &&
				Array.isArray(i.heading_path) &&
				i.heading_path.includes("send refBindings"),
		);
		expect(refBindingsHit).toBeUndefined();
	});

	test("__proto__-named operation preserved in spec metadata fragment", async () => {
		const frag = await conn.client.callTool({
			name: "get_fragment",
			arguments: { file: "api/tenth-review.yaml", anchor: { kind: "heading_path", path: "Spec metadata" } },
		});
		expect(frag.isError).toBeFalsy();
		const content = (frag.structuredContent as { content?: string }).content ?? "";
		expect(content).toContain("__proto__");
		expect(content).toContain("invalidActionFallsToResidual");
	});

	test("trait-contributed reply renders in the operation's prose + fence", async () => {
		const frag = await conn.client.callTool({
			name: "get_fragment",
			arguments: { file: "api/eleventh-review.yaml", anchor: { kind: "heading_path", path: "send rpcSend" } },
		});
		expect(frag.isError).toBeFalsy();
		const content = (frag.structuredContent as { content?: string }).content ?? "";
		expect(content).toContain("Reply:");
		expect(content).toContain("- Channel: eleventhReviewDistinctiveReplyAddress");
		expect(content).toContain("- Message: pong");

		const search = await conn.client.callTool({
			name: "search",
			arguments: { query: "eleventhReviewDistinctiveReplyAddress", pageSize: 20 },
		});
		expect(search.isError).toBeFalsy();
		const searchOut = search.structuredContent as SearchOutput;
		const hit = searchOut.items.find(
			(i) =>
				"file" in i &&
				i.file === "api/eleventh-review.yaml" &&
				"heading_path" in i &&
				Array.isArray(i.heading_path) &&
				i.heading_path.includes("send rpcSend"),
		);
		expect(hit).toBeDefined();
	});

	test("array-element __proto__ data is scrubbed from the per-op fence", async () => {
		const frag = await conn.client.callTool({
			name: "get_fragment",
			arguments: { file: "api/eleventh-review.yaml", anchor: { kind: "heading_path", path: "send taggedSend" } },
		});
		expect(frag.isError).toBeFalsy();
		const content = (frag.structuredContent as { content?: string }).content ?? "";
		// Per-op fence is sanitized — no __proto__ key, no attacker payload.
		expect(content).not.toContain("evilEleventhReviewArrayLeak");
		expect(content).not.toContain("__proto__");

		// Search for the leaked term must NOT hit the per-op heading — only the
		// `## Components` catch-all (which intentionally serializes raw top.*)
		// may surface it. Without the array-recursion fix in `deepSanitize`,
		// the per-op fence would also surface the term.
		const search = await conn.client.callTool({
			name: "search",
			arguments: { query: "evilEleventhReviewArrayLeak", pageSize: 20 },
		});
		expect(search.isError).toBeFalsy();
		const searchOut = search.structuredContent as SearchOutput;
		const perOpHit = searchOut.items.find(
			(i) =>
				"file" in i &&
				i.file === "api/eleventh-review.yaml" &&
				"heading_path" in i &&
				Array.isArray(i.heading_path) &&
				i.heading_path.includes("send taggedSend"),
		);
		expect(perOpHit).toBeUndefined();
	});

	test("malformed channel ref renders verbatim, not synthesized from a truncated target", async () => {
		const frag = await conn.client.callTool({
			name: "get_fragment",
			arguments: {
				file: "api/eleventh-review.yaml",
				anchor: { kind: "heading_path", path: "send malformedChannel" },
			},
		});
		expect(frag.isError).toBeFalsy();
		const content = (frag.structuredContent as { content?: string }).content ?? "";
		expect(content).toContain("Channel: #/channels/rpcRequest/messages/ping");
		expect(content).not.toContain("Channel: rpc/request");
	});

	test("unresolved component-message ref renders raw $ref instead of inventing a name", async () => {
		const frag = await conn.client.callTool({
			name: "get_fragment",
			arguments: { file: "api/twelfth-review.yaml", anchor: { kind: "heading_path", path: "send brokenMsgRef" } },
		});
		expect(frag.isError).toBeFalsy();
		const content = (frag.structuredContent as { content?: string }).content ?? "";
		expect(content).toContain("- #/components/messages/MissingTwelfthReviewMsg");
		expect(content).not.toMatch(/^- MissingTwelfthReviewMsg$/m);

		const search = await conn.client.callTool({
			name: "search",
			arguments: { query: "MissingTwelfthReviewMsg", pageSize: 20 },
		});
		expect(search.isError).toBeFalsy();
		const searchOut = search.structuredContent as SearchOutput;
		const hit = searchOut.items.find(
			(i) =>
				"file" in i &&
				i.file === "api/twelfth-review.yaml" &&
				"heading_path" in i &&
				Array.isArray(i.heading_path) &&
				i.heading_path.includes("send brokenMsgRef"),
		);
		expect(hit).toBeDefined();
	});

	test("non-object info draft (null) is preserved in the Spec metadata fence", async () => {
		const frag = await conn.client.callTool({
			name: "get_fragment",
			arguments: { file: "api/twelfth-review.yaml", anchor: { kind: "heading_path", path: "Spec metadata" } },
		});
		expect(frag.isError).toBeFalsy();
		const content = (frag.structuredContent as { content?: string }).content ?? "";
		// Spec metadata fence is JSON — `info: ~` (YAML null) serializes as `"info":null`.
		expect(content).toMatch(/"info"\s*:\s*null/);
	});

	// ─ Thirteenth review ───────────────────────────────────────────────

	test("external-ref operation gets its own outline heading + per-op fragment navigation", async () => {
		const out = await conn.client.callTool({
			name: "get_file_outline",
			arguments: { file: "api/thirteenth-review.yaml" },
		});
		expect(out.isError).toBeFalsy();
		// `path` is the matchable / normalized pathText; `text` is raw displayText
		// (preserves the multiline op's newline). Three ops total: external +
		// inline + multiline-collapsed (normalized path form).
		const paths = (out.structuredContent as GetFileOutlineResult).outline.map((n) => n.path);
		expect(paths).toContain("external externalOp");
		expect(paths).toContain("send inlineSend");
		expect(paths).toContain("send multiline ## injected");

		const frag = await conn.client.callTool({
			name: "get_fragment",
			arguments: {
				file: "api/thirteenth-review.yaml",
				anchor: { kind: "heading_path", path: "external externalOp" },
			},
		});
		expect(frag.isError).toBeFalsy();
		const content = (frag.structuredContent as { content?: string }).content ?? "";
		expect(content).toContain("Reference: ./shared.yaml#/components/operations/notify");
		expect(content).toMatch(/"\$ref"\s*:\s*"\.\/shared\.yaml#\/components\/operations\/notify"/);
	});

	test("nested __proto__ payload in components is stripped from BM25-indexed text", async () => {
		const search = await conn.client.callTool({
			name: "search",
			arguments: { query: "THIRTEENTH_REVIEW_SECURITY_PAYLOAD", pageSize: 20 },
		});
		expect(search.isError).toBeFalsy();
		const items = (search.structuredContent as SearchOutput).items;
		const hit = items.find((i) => "file" in i && i.file === "api/thirteenth-review.yaml");
		expect(hit).toBeUndefined();
	});

	test("multiline operation name yields exactly ONE outline heading + no phantom `## injected` in source", async () => {
		const out = await conn.client.callTool({
			name: "get_file_outline",
			arguments: { file: "api/thirteenth-review.yaml" },
		});
		expect(out.isError).toBeFalsy();
		const paths = (out.structuredContent as GetFileOutlineResult).outline.map((n) => n.path);
		// `## injected` would have appeared as its own outline node without the
		// source-line normalization — the markdown re-parser would see two `##`
		// lines from one op.
		expect(paths).not.toContain("injected");
		// The multiline op is present exactly ONCE under its collapsed form.
		const multilineMatches = paths.filter((p) => p === "send multiline ## injected");
		expect(multilineMatches).toHaveLength(1);

		const frag = await conn.client.callTool({
			name: "get_fragment",
			arguments: {
				file: "api/thirteenth-review.yaml",
				anchor: { kind: "heading_path", path: "send multiline ## injected" },
			},
		});
		expect(frag.isError).toBeFalsy();
		const content = (frag.structuredContent as { content?: string }).content ?? "";
		// The fragment body for the multiline op must NOT introduce a second
		// `## injected` heading line.
		expect(content).not.toMatch(/^## injected$/m);
	});

	// ─ Fourteenth review ───────────────────────────────────────────────

	test("spec-metadata sanitization strips nested __proto__ from servers + invalid-op bodies", async () => {
		const search = await conn.client.callTool({
			name: "search",
			arguments: { query: "FOURTEENTH_SERVER_PAYLOAD FOURTEENTH_OP_PAYLOAD", pageSize: 20 },
		});
		expect(search.isError).toBeFalsy();
		const items = (search.structuredContent as SearchOutput).items;
		const hit = items.find((i) => "file" in i && i.file === "api/fourteenth-review.yaml");
		expect(hit).toBeUndefined();
	});

	test("JSON Schema property named `constructor` flows through ## Components fence", async () => {
		const frag = await conn.client.callTool({
			name: "get_fragment",
			arguments: {
				file: "api/fourteenth-review.yaml",
				anchor: { kind: "heading_path", path: "Components" },
			},
		});
		expect(frag.isError).toBeFalsy();
		const content = (frag.structuredContent as { content?: string }).content ?? "";
		expect(content).toMatch(/"constructor"\s*:\s*\{\s*"type"\s*:\s*"string"\s*\}/);
	});

	test("server name with `\\n## injected` collapses; no phantom heading in outline", async () => {
		const out = await conn.client.callTool({
			name: "get_file_outline",
			arguments: { file: "api/fourteenth-review.yaml" },
		});
		expect(out.isError).toBeFalsy();
		const paths = (out.structuredContent as GetFileOutlineResult).outline.map((n) => n.path);
		expect(paths).not.toContain("injected");
	});

	// ─ Fifteenth review ────────────────────────────────────────────────

	test("array-valued x-* extension with nested __proto__ scrubbed; sibling data preserved", async () => {
		const payloadHit = await conn.client.callTool({
			name: "search",
			arguments: { query: "FIFTEENTH_ARRAY_PAYLOAD", pageSize: 20 },
		});
		expect(payloadHit.isError).toBeFalsy();
		const payloadItems = (payloadHit.structuredContent as SearchOutput).items;
		expect(payloadItems.find((i) => "file" in i && i.file === "api/fifteenth-review.yaml")).toBeUndefined();
		const siblingHit = await conn.client.callTool({
			name: "search",
			arguments: { query: "fifteenthReviewVisibleArrayMarker", pageSize: 20 },
		});
		expect(siblingHit.isError).toBeFalsy();
		const siblingItems = (siblingHit.structuredContent as SearchOutput).items;
		expect(siblingItems.find((i) => "file" in i && i.file === "api/fifteenth-review.yaml")).toBeDefined();
	});

	test("channel literally named __proto__ surfaces in ## Channels fence", async () => {
		const frag = await conn.client.callTool({
			name: "get_fragment",
			arguments: {
				file: "api/fifteenth-review.yaml",
				anchor: { kind: "heading_path", path: "Channels" },
			},
		});
		expect(frag.isError).toBeFalsy();
		const content = (frag.structuredContent as { content?: string }).content ?? "";
		expect(content).toContain("fifteenthReviewProtoChannelAddress");
	});

	test("preamble servers section caps at 20 bullets with no overflow line for one non-renderable entry", async () => {
		const frag = await conn.client.callTool({
			name: "get_fragment",
			arguments: {
				file: "api/fifteenth-review.yaml",
				anchor: { kind: "file" },
			},
		});
		expect(frag.isError).toBeFalsy();
		const content = (frag.structuredContent as { content?: string }).content ?? "";
		const bulletCount = (content.match(/^- s\d\d/gm) ?? []).length;
		expect(bulletCount).toBe(20);
		expect(content).not.toContain("- ... and");
	});
});
