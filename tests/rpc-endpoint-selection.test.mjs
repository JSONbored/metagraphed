import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  isPrivateOrLocalHostname,
  orderSafeRpcEndpoints,
  selectSafeRpcEndpoint,
  weightedPickEndpoint,
} from "../workers/api.mjs";

// Origins in TRUSTED_RPC_UPSTREAM_ORIGINS.
const SAFE_A = "https://bittensor-finney.api.onfinality.io/public";
const SAFE_B = "https://bittensor-public.nodies.app/rpc";
const UNSAFE = "https://evil.example.com/rpc";

const ep = (id, url, extra = {}) => ({
  id,
  url,
  provider: "fixture",
  pool_eligible: true,
  score: 100,
  status: "ok",
  ...extra,
});

describe("selectSafeRpcEndpoint", () => {
  test("returns the single eligible+safe endpoint", () => {
    const { endpoint, unsafeEndpoint } = selectSafeRpcEndpoint({
      endpoints: [ep("a", SAFE_A)],
    });
    assert.equal(endpoint.id, "a");
    assert.equal(unsafeEndpoint, null);
  });

  test("skips ineligible endpoints", () => {
    const { endpoint } = selectSafeRpcEndpoint({
      endpoints: [ep("x", SAFE_A, { pool_eligible: false }), ep("b", SAFE_B)],
    });
    assert.equal(endpoint.id, "b");
  });

  test("reports an unsafe endpoint (502) when every eligible URL is unsafe", () => {
    const { endpoint, unsafeEndpoint } = selectSafeRpcEndpoint({
      endpoints: [ep("u", UNSAFE)],
    });
    assert.equal(endpoint, null);
    assert.equal(unsafeEndpoint.id, "u");
  });

  test("returns null endpoint (503) when none are eligible", () => {
    const { endpoint, unsafeEndpoint } = selectSafeRpcEndpoint({
      endpoints: [ep("x", SAFE_A, { pool_eligible: false })],
    });
    assert.equal(endpoint, null);
    assert.equal(unsafeEndpoint, null);
  });

  test("load-balances across multiple safe endpoints (injected randomFn)", () => {
    const pool = { endpoints: [ep("a", SAFE_A), ep("b", SAFE_B)] };
    assert.equal(selectSafeRpcEndpoint(pool, () => 0).endpoint.id, "a");
    assert.equal(selectSafeRpcEndpoint(pool, () => 0.99).endpoint.id, "b");
  });

  test("tolerates an empty/missing pool", () => {
    assert.deepEqual(selectSafeRpcEndpoint(null), {
      endpoint: null,
      unsafeEndpoint: null,
    });
    assert.deepEqual(selectSafeRpcEndpoint({ endpoints: [] }), {
      endpoint: null,
      unsafeEndpoint: null,
    });
  });
});

describe("weightedPickEndpoint", () => {
  test("returns the only endpoint without consulting randomFn", () => {
    const only = ep("a", SAFE_A);
    assert.equal(
      weightedPickEndpoint([only], () => {
        throw new Error("randomFn should not be called");
      }),
      only,
    );
  });

  test("weights selection by score", () => {
    const eps = [ep("a", SAFE_A, { score: 3 }), ep("b", SAFE_B, { score: 1 })];
    // total weight 4: cursor in [0,3) -> a, [3,4) -> b
    assert.equal(weightedPickEndpoint(eps, () => 0).id, "a");
    assert.equal(weightedPickEndpoint(eps, () => 0.7).id, "a"); // 2.8 < 3
    assert.equal(weightedPickEndpoint(eps, () => 0.9).id, "b"); // 3.6 >= 3
  });

  test("falls back to uniform weighting when scores are absent", () => {
    const eps = [
      ep("a", SAFE_A, { score: null }),
      ep("b", SAFE_B, { score: null }),
    ];
    assert.equal(weightedPickEndpoint(eps, () => 0).id, "a");
    assert.equal(weightedPickEndpoint(eps, () => 0.6).id, "b");
  });
});

describe("orderSafeRpcEndpoints — block-height routing", () => {
  const opts = { healthMap: new Map(), now: 0 };

  test("demotes a node lagging the freshest tip behind the synced set", () => {
    const pool = {
      endpoints: [
        ep("lag", SAFE_A, { latest_block: 8_399_000 }), // 1000 behind → lagging
        ep("fresh", SAFE_B, { latest_block: 8_400_000 }), // at the tip
      ],
    };
    const { endpoints } = orderSafeRpcEndpoints(pool, () => 0, opts);
    assert.equal(endpoints[0].id, "fresh");
    assert.equal(endpoints[endpoints.length - 1].id, "lag");
  });

  test("keeps nodes within tolerance together in the synced band", () => {
    const pool = {
      endpoints: [
        ep("a", SAFE_A, { latest_block: 8_400_000 }),
        ep("b", SAFE_B, { latest_block: 8_399_995 }), // 5 behind → within tolerance
      ],
    };
    const { endpoints } = orderSafeRpcEndpoints(pool, () => 0, opts);
    assert.equal(endpoints.length, 2);
    assert.deepEqual(endpoints.map((e) => e.id).sort(), ["a", "b"]);
  });

  test("does not judge endpoints with no readable block height", () => {
    const pool = {
      endpoints: [
        ep("known", SAFE_A, { latest_block: 8_400_000 }),
        ep("nullblock", SAFE_B, { latest_block: null }),
      ],
    };
    const { endpoints } = orderSafeRpcEndpoints(pool, () => 0, opts);
    // null-block endpoint isn't demoted (can't judge) — both stay in the pool.
    assert.equal(endpoints.length, 2);
  });
});

describe("isPrivateOrLocalHostname — CGNAT parity (#2312/#2313)", () => {
  test("rejects localhost and its subdomains", () => {
    assert.equal(isPrivateOrLocalHostname("localhost"), true);
    assert.equal(isPrivateOrLocalHostname("foo.localhost"), true);
    assert.equal(
      isPrivateOrLocalHostname("bittensor-finney.api.onfinality.io"),
      false,
    );
  });

  test("rejects the 100.64.0.0/10 CGNAT range as a plain dotted IPv4 hostname", () => {
    assert.equal(isPrivateOrLocalHostname("100.64.0.1"), true);
    assert.equal(isPrivateOrLocalHostname("100.100.0.1"), true);
    assert.equal(isPrivateOrLocalHostname("100.127.255.255"), true);
  });

  test("does not reject public addresses just outside the CGNAT range", () => {
    assert.equal(isPrivateOrLocalHostname("100.63.255.255"), false);
    assert.equal(isPrivateOrLocalHostname("100.128.0.0"), false);
    assert.equal(isPrivateOrLocalHostname("8.8.8.8"), false);
  });

  // isPrivateIpv4Octets was factored out of the inline IPv4 branch in this PR,
  // so every one of its range clauses is new to the patch even though most of
  // the ranges themselves predate this change. Exercise each clause true, not
  // just the new CGNAT one, so patch/branch coverage reflects the real logic.
  test("rejects every pre-existing private IPv4 range this guard already covered", () => {
    assert.equal(isPrivateOrLocalHostname("0.1.2.3"), true); // 0.0.0.0/8
    assert.equal(isPrivateOrLocalHostname("10.1.2.3"), true); // 10.0.0.0/8
    assert.equal(isPrivateOrLocalHostname("127.0.0.1"), true); // 127.0.0.0/8
    assert.equal(isPrivateOrLocalHostname("169.254.1.1"), true); // 169.254.0.0/16
    assert.equal(isPrivateOrLocalHostname("172.16.0.1"), true); // 172.16.0.0/12
    assert.equal(isPrivateOrLocalHostname("172.31.255.255"), true); // 172.16.0.0/12
    assert.equal(isPrivateOrLocalHostname("192.168.1.1"), true); // 192.168.0.0/16
    assert.equal(isPrivateOrLocalHostname("172.15.255.255"), false); // just below
    assert.equal(isPrivateOrLocalHostname("172.32.0.0"), false); // just above
    assert.equal(isPrivateOrLocalHostname("169.253.255.255"), false); // just below 169.254
    assert.equal(isPrivateOrLocalHostname("192.167.1.1"), false); // first ok, second not 168
  });

  // The WHATWG URL parser re-serializes an IPv4-mapped IPv6 literal into
  // hex-tail form — [::ffff:100.64.0.1] becomes hostname "::ffff:6440:1", NOT
  // the dotted "::ffff:100.64.0.1" string. Route the literal through the same
  // `new URL(...).hostname` step isSafeRpcEndpointUrl uses so this test can't
  // drift from what the real request path actually evaluates.
  test("rejects an IPv4-mapped CGNAT IPv6 literal via the real new URL(...).hostname form", () => {
    const hostname = new URL("https://[::ffff:100.64.0.1]/").hostname;
    // URL.hostname keeps the brackets for an IPv6 literal; pin the exact
    // normalized form so this test can't silently drift from reality.
    assert.equal(hostname, "[::ffff:6440:1]");
    assert.equal(isPrivateOrLocalHostname(hostname), true);
  });

  test("still rejects the dotted-quad ::ffff: form directly (non-URL callers)", () => {
    assert.equal(isPrivateOrLocalHostname("::ffff:100.64.0.1"), true);
  });

  test("rejects native (non-v4-mapped) unique-local and link-local IPv6 literals", () => {
    assert.equal(isPrivateOrLocalHostname("::1"), true);
    assert.equal(isPrivateOrLocalHostname("::"), true);
    assert.equal(isPrivateOrLocalHostname("fc00::1"), true);
    assert.equal(isPrivateOrLocalHostname("fd12::1"), true);
    assert.equal(isPrivateOrLocalHostname("fe80::1"), true);
  });

  test("does not reject a public IPv6 literal with no embedded v4", () => {
    assert.equal(isPrivateOrLocalHostname("2606:4700:4700::1111"), false);
  });

  test("rejects IPv4-mapped forms of the other private ranges too", () => {
    // ::ffff:127.0.0.1 -> hex-tail ::ffff:7f00:1
    assert.equal(
      isPrivateOrLocalHostname(new URL("https://[::ffff:127.0.0.1]/").hostname),
      true,
    );
    // ::ffff:192.168.1.1 -> hex-tail ::ffff:c0a8:101
    assert.equal(
      isPrivateOrLocalHostname(
        new URL("https://[::ffff:192.168.1.1]/").hostname,
      ),
      true,
    );
  });

  // ipv6EmbeddedIpv4 (src/ip-safety.mjs) recognizes three other textual forms
  // that tunnel an IPv4 address inside IPv6 besides the ::ffff: mapped one
  // exercised above; pin each so the RPC guard is verified for every form it
  // now claims to handle, not just the mapped one.
  test("rejects the deprecated IPv4-compatible ::a.b.c.d form (127.0.0.1)", () => {
    const hostname = new URL("https://[::127.0.0.1]/").hostname;
    assert.equal(hostname, "[::7f00:1]");
    assert.equal(isPrivateOrLocalHostname(hostname), true);
  });

  test("rejects a 6to4 (2002::/16) literal embedding a private v4 (127.0.0.1)", () => {
    const hostname = new URL("https://[2002:7f00:1::]/").hostname;
    assert.equal(isPrivateOrLocalHostname(hostname), true);
  });

  test("rejects a NAT64 (64:ff9b::/96) literal embedding a private v4 (127.0.0.1)", () => {
    const hostname = new URL("https://[64:ff9b::7f00:1]/").hostname;
    assert.equal(isPrivateOrLocalHostname(hostname), true);
  });
});
