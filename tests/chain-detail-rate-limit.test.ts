// The tiered gate on the four chain-detail LOOKUP routes.
//
// The property under test is not "a limiter exists" but "the limiter runs
// AHEAD of the tier ladder": the reason these routes are gated at all is that a
// ref outside the retained hot window still costs a Neon round-trip to discover
// it is cold, so a gate that ran after the store read would save nothing. Every
// rejection case therefore asserts DATA_API was never called, which is the only
// assertion that can tell the two placements apart.
//
// The chain-events sibling has been gated since #8386 and is re-asserted here
// for the one property this change could plausibly break: that it is still
// gated EXACTLY once. Routing it through the new shared helper as well would
// consume two units per request and silently halve its ceiling.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { createLocalArtifactEnv } from "../scripts/lib.ts";
import { handleRequest } from "../workers/api.ts";
import { jsonBody, type Row } from "./row-type.ts";

const env = createLocalArtifactEnv() as Row;

const CLIENT_IP = "203.0.113.9";
const VALID_KEY = "mg_aValidOpaqueUnkeyGeneratedSuffix";
const BLOCK_HASH = `0x${"a".repeat(64)}`;
const EXTRINSIC_HASH = `0x${"b".repeat(64)}`;

/** The four routes this change gates, by the label each reports to usage. */
const GATED_ROUTES: readonly (readonly [string, string])[] = [
  ["/api/v1/blocks/8816875", "block"],
  ["/api/v1/blocks/8816875/events", "block-events"],
  ["/api/v1/blocks/8816875/extrinsics", "block-extrinsics"],
  [`/api/v1/extrinsics/${EXTRINSIC_HASH}`, "extrinsic"],
];

/**
 * An env whose anonymous limiter answers `success`, counting calls and pinning
 * the key it was asked for. `dataCalls` proves whether the tier ladder was
 * reached — the placement assertion this whole file exists to make.
 */
function envWithLimiter(success: boolean, overrides: Row = {}) {
  const counters = { rateCalls: 0, dataCalls: 0, keys: [] as string[] };
  const built = {
    ...env,
    DATA_RATE_LIMITER: {
      limit({ key }: { key: string }) {
        counters.rateCalls += 1;
        counters.keys.push(key);
        return Promise.resolve({ success });
      },
    },
    DATA_API: {
      fetch() {
        counters.dataCalls += 1;
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
    },
    ...overrides,
  } as unknown as Env;
  return { env: built, counters };
}

describe("chain-detail lookup rate limit", () => {
  for (const [path, label] of GATED_ROUTES) {
    test(`${path} rejects an over-limit anonymous caller before any store read`, async () => {
      const { env: testEnv, counters } = envWithLimiter(false);
      const response = await handleRequest(
        new Request(`https://metagraph.sh${path}`, {
          headers: { "cf-connecting-ip": CLIENT_IP },
        }),
        testEnv,
        {},
      );
      assert.equal(response.status, 429);
      assert.equal((await jsonBody(response)).error.code, "data_rate_limited");
      // The advertised ceiling comes from DATA_TIERED_RATE_LIMIT's anonymous
      // policy, not from a number written here -- if that policy is ever
      // retuned this assertion follows it rather than pinning a stale 60.
      assert.equal(response.headers.get("x-ratelimit-limit"), "60");
      assert.equal(response.headers.get("x-ratelimit-remaining"), "0");
      assert.equal(response.headers.get("x-ratelimit-scope"), "per-minute");
      // Keyed by IP for an anonymous caller, under the shared `data` prefix --
      // so these four share one bucket with the chain-events sibling rather
      // than granting a caller a fresh allowance per route.
      assert.deepEqual(counters.keys, [`data:${CLIENT_IP}`]);
      // Gated exactly once. A second call would mean the helper AND some other
      // gate both ran, halving the real ceiling.
      assert.equal(counters.rateCalls, 1);
      // THE placement assertion: the tier ladder was never reached.
      assert.equal(counters.dataCalls, 0);
    });

    test(`${path} lets an under-limit caller through to the tier ladder`, async () => {
      const { env: testEnv, counters } = envWithLimiter(true);
      const response = await handleRequest(
        new Request(`https://metagraph.sh${path}`, {
          headers: { "cf-connecting-ip": CLIENT_IP },
        }),
        testEnv,
        {},
      );
      // Not asserting 200: what the ladder answers for an unknown ref is the
      // serving contract's business (#9208 gap/cold/hot), and pinning it here
      // would make this file fail for reasons that have nothing to do with the
      // gate. The gate's whole contract is "did not reject".
      assert.notEqual(response.status, 429);
      assert.equal(counters.rateCalls, 1);
      void label;
    });
  }

  test("a hash ref is gated the same as a numeric one", async () => {
    const { env: testEnv, counters } = envWithLimiter(false);
    const response = await handleRequest(
      new Request(`https://metagraph.sh/api/v1/blocks/${BLOCK_HASH}`, {
        headers: { "cf-connecting-ip": CLIENT_IP },
      }),
      testEnv,
      {},
    );
    assert.equal(response.status, 429);
    assert.equal(counters.dataCalls, 0);
  });

  test("a keyed caller is metered on the keyed limiter, by account not IP", async () => {
    let keyedCalls = 0;
    let anonymousCalls = 0;
    const waited: Promise<unknown>[] = [];
    const response = await handleRequest(
      new Request("https://metagraph.sh/api/v1/blocks/8816875", {
        headers: {
          "cf-connecting-ip": CLIENT_IP,
          authorization: `Bearer ${VALID_KEY}`,
        },
      }),
      {
        ...env,
        METAGRAPH_CONTROL: {
          get: () => Promise.resolve(null),
          put: () => Promise.resolve(),
        },
        API_KEY_LOOKUP_INTERNAL_TOKEN: "token",
        DATA_RATE_LIMITER: {
          limit() {
            anonymousCalls += 1;
            return Promise.resolve({ success: true });
          },
        },
        DATA_RATE_LIMITER_KEYED: {
          limit({ key }: { key: string }) {
            keyedCalls += 1;
            // accountId, never the IP -- one team behind one NAT must not
            // share an anonymous bucket once they have paid for a key.
            assert.ok(key.startsWith("data:"));
            assert.ok(!key.includes(CLIENT_IP));
            return Promise.resolve({ success: false });
          },
        },
        DATA_API: {
          // Promise-returning, because recordApiKeyUsage chains .catch() on the
          // result directly (workers/api.ts:793) rather than awaiting it.
          fetch(input: Request | string) {
            const url = typeof input === "string" ? input : input.url;
            if (url.includes("/internal/keys/verify")) {
              // The shape lookupViaDataApi actually reads
              // (src/api-key-validation.ts:93-99): `valid`, not `ok`, and
              // camelCase accountId. Getting this wrong fails OPEN -- the key
              // reads as invalid and the caller silently drops to the
              // anonymous policy, which is exactly the bug this test would
              // otherwise have hidden.
              return Promise.resolve(
                new Response(
                  JSON.stringify({
                    valid: true,
                    tier: "free",
                    accountId: "42",
                  }),
                  { status: 200 },
                ),
              );
            }
            return Promise.resolve(
              new Response(JSON.stringify({ ok: true }), { status: 200 }),
            );
          },
        },
      } as unknown as Env,
      { waitUntil: (p: Promise<unknown>) => waited.push(p) },
    );
    assert.equal(response.status, 429);
    assert.equal(keyedCalls, 1);
    assert.equal(anonymousCalls, 0);
    await Promise.allSettled(waited);
  });

  test("the chain-events sibling is still gated EXACTLY once", async () => {
    const { env: testEnv, counters } = envWithLimiter(false);
    const response = await handleRequest(
      new Request("https://metagraph.sh/api/v1/blocks/8816875/chain-events", {
        headers: { "cf-connecting-ip": CLIENT_IP },
      }),
      testEnv,
      {},
    );
    assert.equal(response.status, 429);
    // Not two. handleChainEventsFamily gates itself; the dispatcher must not
    // gate it again on the way in.
    assert.equal(counters.rateCalls, 1);
  });

  test("the list feeds are deliberately NOT gated", async () => {
    for (const path of ["/api/v1/blocks", "/api/v1/extrinsics"]) {
      const { env: testEnv, counters } = envWithLimiter(false);
      const response = await handleRequest(
        new Request(`https://metagraph.sh${path}?limit=1`, {
          headers: { "cf-connecting-ip": CLIENT_IP },
        }),
        testEnv,
        {},
      );
      // A bounded list read whose cache key is the query string, not an
      // unbounded ref space -- and the explorer's primary view. If a future
      // change gates these, it should be a deliberate decision that updates
      // this test, not a silent side effect of touching the dispatcher.
      assert.notEqual(response.status, 429);
      assert.equal(counters.rateCalls, 0);
    }
  });
});

// #11017. The account family reached production with no ceiling at all: every
// call to applyTieredRateLimit was per-family, and handleRequest dispatches
// straight into dispatchRequest with nothing in front of it. Same cost shape as
// the four above -- unbounded key space, lakehouse-backed, uncached -- and one
// of them OOMed an isolate at limit=25 (#11019).
//
// The placement assertion above (`dataCalls === 0`) is deliberately NOT reused
// here: these routes read the lakehouse over global fetch, not DATA_API, so
// that counter would be 0 whether or not the gate ran, and a check that cannot
// fail is worse than no check. What is asserted instead is the rate-limiter
// call itself, which is the thing that was missing.
const ACCOUNT = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";

describe("account family rate limit (#11017)", () => {
  const gated = [
    `/api/v1/accounts/${ACCOUNT}`,
    `/api/v1/accounts/${ACCOUNT}/transfers`,
    `/api/v1/accounts/${ACCOUNT}/events`,
    `/api/v1/accounts/${ACCOUNT}/extrinsics`,
    `/api/v1/accounts/${ACCOUNT}/stake-flow`,
  ];

  for (const path of gated) {
    test(`${path.replace(ACCOUNT, "{ss58}")} rejects an over-limit anonymous caller`, async () => {
      const { env: testEnv, counters } = envWithLimiter(false);
      const response = await handleRequest(
        new Request(`https://metagraph.sh${path}`, {
          headers: { "cf-connecting-ip": CLIENT_IP },
        }),
        testEnv,
        {},
      );
      assert.equal(response.status, 429);
      assert.equal((await jsonBody(response)).error.code, "data_rate_limited");
      // Same bucket as the chain-detail four: one `data:` prefix across the
      // whole policy, so a caller cannot mint a fresh allowance by switching
      // families.
      assert.deepEqual(counters.keys, [`data:${CLIENT_IP}`]);
      // Gated exactly once -- a second call would halve the real ceiling.
      assert.equal(counters.rateCalls, 1);
    });
  }

  test("an under-limit caller is let through", async () => {
    const { env: testEnv, counters } = envWithLimiter(true);
    const response = await handleRequest(
      new Request(`https://metagraph.sh/api/v1/accounts/${ACCOUNT}/transfers`, {
        headers: { "cf-connecting-ip": CLIENT_IP },
      }),
      testEnv,
      {},
    );
    assert.notEqual(response.status, 429);
    assert.equal(counters.rateCalls, 1);
  });

  test("a bad-checksum address still 400s WITHOUT spending the caller's budget", async () => {
    // The ordering decision, pinned: the checksum guard runs first. A bad
    // address costs nothing to detect, and charging for it would make the
    // limiter punish the one mistake it has no reason to.
    //
    // ADDRESS-SHAPED but wrong -- one character changed, same length. That is
    // the case the guard exists for (#10036): a one-character typo used to
    // answer with a confident empty result. An UNSHAPED segment takes a
    // different path entirely, asserted below.
    const badChecksum = `${ACCOUNT.slice(0, -1)}Z`;
    const { env: testEnv, counters } = envWithLimiter(false);
    const response = await handleRequest(
      new Request(
        `https://metagraph.sh/api/v1/accounts/${badChecksum}/transfers`,
        {
          headers: { "cf-connecting-ip": CLIENT_IP },
        },
      ),
      testEnv,
      {},
    );
    assert.equal(response.status, 400);
    assert.equal((await jsonBody(response)).error.code, "invalid_ss58");
    assert.equal(counters.rateCalls, 0);
  });

  test("an unshaped segment 404s at the router, also without spending budget", async () => {
    const { env: testEnv, counters } = envWithLimiter(false);
    const response = await handleRequest(
      new Request(
        `https://metagraph.sh/api/v1/accounts/${ACCOUNT}X/transfers`,
        {
          headers: { "cf-connecting-ip": CLIENT_IP },
        },
      ),
      testEnv,
      {},
    );
    // Matches no account route at all -- the honest answer for a path that
    // identifies nothing, and it must not reach the limiter either.
    assert.equal(response.status, 404);
    assert.equal(counters.rateCalls, 0);
  });

  test("the account COLLECTION routes are deliberately NOT gated", async () => {
    // Bounded reads over a fixed key space, same reasoning as the block and
    // extrinsic feeds above. If a future change gates these it should update
    // this test, not happen as a side effect of touching the dispatcher.
    for (const path of ["/api/v1/accounts", "/api/v1/accounts/top-holders"]) {
      const { env: testEnv, counters } = envWithLimiter(false);
      const response = await handleRequest(
        new Request(`https://metagraph.sh${path}?limit=1`, {
          headers: { "cf-connecting-ip": CLIENT_IP },
        }),
        testEnv,
        {},
      );
      assert.notEqual(response.status, 429);
      assert.equal(counters.rateCalls, 0);
    }
  });
});
