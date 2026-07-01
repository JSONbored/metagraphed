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
  test("rejects the 100.64.0.0/10 CGNAT range, dotted and ::ffff:-mapped", () => {
    assert.equal(isPrivateOrLocalHostname("100.64.0.1"), true);
    assert.equal(isPrivateOrLocalHostname("100.100.0.1"), true);
    assert.equal(isPrivateOrLocalHostname("100.127.255.255"), true);
    assert.equal(isPrivateOrLocalHostname("::ffff:100.64.0.1"), true);
  });

  test("does not reject public addresses just outside the CGNAT range", () => {
    assert.equal(isPrivateOrLocalHostname("100.63.255.255"), false);
    assert.equal(isPrivateOrLocalHostname("100.128.0.0"), false);
    assert.equal(isPrivateOrLocalHostname("8.8.8.8"), false);
  });
});
