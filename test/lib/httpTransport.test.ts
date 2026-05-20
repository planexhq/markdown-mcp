/**
 * Unit tests for `httpTransport.ts` helpers that don't need a live
 * server. End-to-end behavior lives in
 * `test/integration/http-transport.test.ts`; this file targets pure
 * functions whose correctness is hard to observe through the integration
 * layer (e.g. allowlist composition under default ports).
 */

import { describe, expect, test } from "vitest";

import { bracketIpv6Host, buildLoopbackEndpoints } from "../../src/lib/httpTransport.js";

describe("bracketIpv6Host", () => {
	test("returns IPv4 / hostname inputs unchanged", () => {
		expect(bracketIpv6Host("127.0.0.1")).toBe("127.0.0.1");
		expect(bracketIpv6Host("localhost")).toBe("localhost");
	});

	test("brackets bare IPv6", () => {
		expect(bracketIpv6Host("::1")).toBe("[::1]");
		expect(bracketIpv6Host("0:0:0:0:0:0:0:1")).toBe("[0:0:0:0:0:0:0:1]");
	});

	test("is idempotent on already-bracketed input", () => {
		expect(bracketIpv6Host("[::1]")).toBe("[::1]");
	});
});

describe("buildLoopbackEndpoints", () => {
	test("non-default port keeps only `:port` shapes", () => {
		// Position 3 is `bindAddress` echoed back through `bracketIpv6Host`
		// — it duplicates position 0 when the caller binds 127.0.0.1. The
		// SDK's `allowedHosts.includes()` compare tolerates duplicates;
		// the slot's purpose is to match curl `--resolve` style binds
		// where `bindAddress` may be an arbitrary loopback alias.
		const hosts = buildLoopbackEndpoints("127.0.0.1", 3000, "");
		expect(hosts).toEqual(["127.0.0.1:3000", "localhost:3000", "[::1]:3000", "127.0.0.1:3000"]);

		const origins = buildLoopbackEndpoints("127.0.0.1", 3000, "http://");
		expect(origins).toEqual([
			"http://127.0.0.1:3000",
			"http://localhost:3000",
			"http://[::1]:3000",
			"http://127.0.0.1:3000",
		]);
	});

	test("port 80 ALSO produces bare-host shapes (RFC 7230 §5.4)", () => {
		// Standard clients strip `:80` from Host headers — without the
		// bare-host entries, `--port 80` would 403 every spec-compliant
		// request because the SDK validates verbatim.
		const hosts = buildLoopbackEndpoints("127.0.0.1", 80, "");
		expect(hosts).toContain("127.0.0.1:80");
		expect(hosts).toContain("localhost:80");
		expect(hosts).toContain("[::1]:80");
		expect(hosts).toContain("127.0.0.1");
		expect(hosts).toContain("localhost");
		expect(hosts).toContain("[::1]");
	});

	test("port 80 Origins ALSO produce bare `http://host` shapes", () => {
		// http:// Origin serialization for default-port URLs drops the
		// port — `http://127.0.0.1:80` becomes `http://127.0.0.1`.
		const origins = buildLoopbackEndpoints("127.0.0.1", 80, "http://");
		expect(origins).toContain("http://127.0.0.1:80");
		expect(origins).toContain("http://localhost:80");
		expect(origins).toContain("http://[::1]:80");
		expect(origins).toContain("http://127.0.0.1");
		expect(origins).toContain("http://localhost");
		expect(origins).toContain("http://[::1]");
	});

	test("IPv6 bind on port 80 brackets the bare form too", () => {
		const hosts = buildLoopbackEndpoints("::1", 80, "");
		expect(hosts).toContain("[::1]:80");
		expect(hosts).toContain("[::1]");
		// No naked `::1` form leaks through — the SDK's strict-includes
		// compare would never match a bracketless IPv6 anyway.
		expect(hosts).not.toContain("::1");
	});
});
