// The edge cache over the address-shaped account routes.
//
// Measured 2026-08-16 on 5EEmaGFE...5oM3qDSC: three identical back-to-back GETs
// of `/accounts/{ss58}/events?limit=5` took 16.9s, 15.2s and 16.3s, none of
// them carrying a `cf-cache-status`. A Worker's own response is not stored by
// Cloudflare unless the Cache API is used explicitly, and
// `request-handlers/entities.ts` -- 41 cold-tier call sites -- reaches
// `withEdgeCache` from none of them.
//
// These tests count the LAKEHOUSE READS, not the responses. A cache that
// returns the right body while still paying for it is exactly the failure this
// is about, and it is invisible in the payload.
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "vitest";
import { handleRequest } from "../workers/api.ts";
import { CONTRACT_VERSION } from "../src/contracts.ts";
import {
  decodeWatermarkKey,
  resetDecodeWatermarkCache,
} from "../src/decode-watermark.ts";
import { isMainnetOnlyApiPath } from "../workers/api.ts";
import { mockEnv, type Row } from "./row-type.ts";
import { readFileSync } from "node:fs";

const openapi = JSON.parse(
  readFileSync("public/metagraph/openapi.json", "utf8"),
) as { paths: Record<string, unknown> };

const ADDR = "5EYCAe5jLQhn6ofDSvqF6iY53erXNkwhyE1aCEgvi1NNs91F";
const OTHER = "5G9hfkx9wGB1CLMT9WXkpHSAiYzjZb5o1Boyq4KAdDhjwrc5";

/**
 * The Workers `caches.default`, as a Map, recording every key it is handed.
 *
 * The real global is ambient (`declare const caches: CacheStorage`) rather than
 * a `globalThis` property, so installing a stub goes through a cast -- the same
 * pattern `workers/request-handlers/analytics.ts` uses in its own handler code.
 */
function mockCaches() {
  const store = new Map<string, Response>();
  const putKeys: string[] = [];
  return {
    store,
    putKeys,
    install() {
      (globalThis as unknown as { caches: Row | undefined }).caches = {
        default: {
          async match(request: Request) {
            const hit = store.get(request.url);
            return hit ? hit.clone() : undefined;
          },
          async put(request: Request, response: Response) {
            putKeys.push(request.url);
            store.set(request.url, response.clone());
          },
        },
      } as unknown as Row;
    },
  };
}

/** An env whose archive publishes one decode watermark, and nothing else. */
function envAt(decodedThrough: number) {
  const key = decodeWatermarkKey("mainnet");
  return {
    ...mockEnv(),
    R2_SQL_TOKEN: "cfut_test",
    METAGRAPH_ARCHIVE: {
      get: async (asked: string) =>
        asked === key
          ? {
              // `.text()`, not `.json()`: readDecodeWatermark parses the string
              // itself, and a double that only offers `json` would make the
              // watermark unreadable and silently disable the whole cache --
              // every assertion below would then pass for the wrong reason.
              text: async () =>
                JSON.stringify({ decoded_through: decodedThrough }),
            }
          : null,
    },
  } as unknown as Parameters<typeof handleRequest>[1];
}

/** Counts the R2 SQL the request family actually issues. */
function countLakehouse() {
  const queries: string[] = [];
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    queries.push(String(JSON.parse(String(init.body)).query));
    return {
      ok: true,
      status: 200,
      json: async () => ({ success: true, result: { rows: [] } }),
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return queries;
}

const ctx = { waitUntil: (promise: Promise<unknown>) => promise };
const get = (path: string, env: Parameters<typeof handleRequest>[1]) =>
  handleRequest(new Request(`https://api.metagraph.sh${path}`), env, ctx);

const EVENTS = `/api/v1/accounts/${ADDR}/events?limit=5`;

/** A contract path with every parameter filled, so the route patterns match. */
const fill = (route: string) =>
  route.replace("{ss58}", ADDR).replace("{netuid}", "3");

let originalCaches: Row | undefined;
let originalFetch: typeof globalThis.fetch;
beforeEach(() => {
  // The watermark memo is module-level and survives between tests in a file, so
  // whichever test resolved it first would decide every later test's stamp.
  resetDecodeWatermarkCache();
  originalCaches = (globalThis as unknown as { caches: Row | undefined })
    .caches;
  originalFetch = globalThis.fetch;
});
afterEach(() => {
  (globalThis as unknown as { caches: Row | undefined }).caches =
    originalCaches;
  globalThis.fetch = originalFetch;
});

describe("the account edge cache", () => {
  test("THREE IDENTICAL GETS ISSUE ONE SET OF LAKEHOUSE READS", async () => {
    const cache = mockCaches();
    cache.install();
    const queries = countLakehouse();
    const env = envAt(8_800_000);

    const first = await get(EVENTS, env);
    assert.equal(first.status, 200);
    const afterFirst = queries.length;
    assert.ok(afterFirst > 0, "premise: the first request read the lakehouse");

    const second = await get(EVENTS, env);
    const third = await get(EVENTS, env);
    assert.equal(second.status, 200);
    assert.equal(third.status, 200);
    assert.equal(
      queries.length,
      afterFirst,
      `two repeats added ${queries.length - afterFirst} reads`,
    );
    assert.deepEqual(
      await second.json(),
      await first.clone().json(),
      "a hit must be the same body, not merely a fast one",
    );
  });

  test("a NEW DECODE GENERATION writes to a different key", async () => {
    // Correctness comes from the key, not from an expiry racing the data: the
    // lakehouse changes when decode publishes and at no other time, so an
    // answer belongs to a generation and a new one must never consult the old
    // entry.
    const cache = mockCaches();
    cache.install();
    countLakehouse();

    await get(EVENTS, envAt(8_800_000));
    resetDecodeWatermarkCache();
    await get(EVENTS, envAt(8_900_000));

    assert.equal(cache.putKeys.length, 2, "both answers were stored");
    assert.notEqual(cache.putKeys[0], cache.putKeys[1]);
    assert.ok(cache.putKeys[0]!.includes("8800000"), cache.putKeys[0]);
    assert.ok(cache.putKeys[1]!.includes("8900000"), cache.putKeys[1]);
  });

  test("the key carries the CONTRACT VERSION, so a deploy cannot serve across it", async () => {
    const cache = mockCaches();
    cache.install();
    countLakehouse();
    await get(EVENTS, envAt(8_800_000));
    assert.ok(
      cache.putKeys[0]!.includes(encodeURIComponent(CONTRACT_VERSION)),
      cache.putKeys[0],
    );
  });

  test("BOTH SPELLINGS OF MAINNET share one entry", async () => {
    // `/api/v1/…` and `/finney/api/v1/…` are the same request. Keying on the
    // raw path would compute the same body twice and store it twice, which is
    // a hit rate this can simply not lose.
    const cache = mockCaches();
    cache.install();
    const queries = countLakehouse();
    const env = envAt(8_800_000);

    await get(EVENTS, env);
    const afterFirst = queries.length;
    await get(`/finney${EVENTS}`, env);

    assert.equal(queries.length, afterFirst, "the prefixed form re-read");
    assert.equal(cache.putKeys.length, 1);
  });

  test("THE PARTITION IS EXACTLY the live-chain routes vs the store-backed ones", async () => {
    // The gate's whole justification, and it caught a real error in this
    // module's first draft. Four members of the family -- balance, children,
    // parents, root-claim -- read chain state through `state_getStorage` at
    // request time. Their answer changes every block and owes nothing to the
    // decode lane, so stamping them with a watermark that advances hourly would
    // hold a balance across up to an hour of blocks.
    //
    // PINNED HERE rather than asserted in prose, and read from the published
    // contract so an account route added later is covered without anyone
    // remembering to. If a store-backed route becomes network-aware, or a
    // live-chain one becomes mainnet-only, this fails and the gate is revisited
    // BEFORE anything can be served under the wrong key.
    const routes = Object.keys(openapi.paths).filter(
      (path) =>
        path.includes("/accounts/{ss58}") && !path.includes("{network}"),
    );
    assert.ok(
      routes.length >= 25,
      `found only ${routes.length} account routes`,
    );
    const live = routes
      .filter((route) => !isMainnetOnlyApiPath(fill(route)))
      .map((route) => route.replace("/api/v1/accounts/{ss58}", ""));
    assert.deepEqual(live.sort(), [
      "/balance",
      "/children",
      "/parents",
      "/root-claim",
    ]);
  });

  test("a LIVE-CHAIN account route is never cached", async () => {
    // Its answer changes every block. The decode watermark is not a stamp for
    // it, and a cache that cannot say when an answer expires must not hold one.
    const cache = mockCaches();
    cache.install();
    countLakehouse();
    await get(`/api/v1/accounts/${ADDR}/balance`, envAt(8_800_000));
    assert.deepEqual(cache.putKeys, []);
  });

  test("a TESTNET-ADDRESSED account route is not cached", async () => {
    // It 404s (mainnet-only), and a 404 must never be stored -- but the gate
    // refuses it before dispatch either way, which is the property here.
    const cache = mockCaches();
    cache.install();
    countLakehouse();
    const res = await get(`/testnet${EVENTS}`, envAt(8_800_000));
    assert.equal(res.status, 404);
    assert.deepEqual(cache.putKeys, []);
  });

  test("A DIFFERENT ADDRESS is a different entry", async () => {
    const cache = mockCaches();
    cache.install();
    const queries = countLakehouse();
    const env = envAt(8_800_000);

    await get(EVENTS, env);
    const afterFirst = queries.length;
    await get(`/api/v1/accounts/${OTHER}/events?limit=5`, env);
    assert.ok(
      queries.length > afterFirst,
      "a second address must not be served another account's body",
    );
  });

  test("NO WATERMARK DISABLES THE CACHE rather than pinning a constant", async () => {
    // An unreadable watermark means we cannot say which generation an answer
    // belongs to. A key that cannot express that would hold one generation's
    // body across the next publish -- the exact failure the stamp prevents,
    // arrived at by trying to be helpful.
    const cache = mockCaches();
    cache.install();
    const queries = countLakehouse();
    const env = {
      ...mockEnv(),
      R2_SQL_TOKEN: "cfut_test",
      METAGRAPH_ARCHIVE: { get: async () => null },
    } as unknown as Parameters<typeof handleRequest>[1];

    await get(EVENTS, env);
    const afterFirst = queries.length;
    assert.ok(afterFirst > 0, "premise: the first request read the lakehouse");
    await get(EVENTS, env);

    assert.ok(queries.length > afterFirst, "an unstamped answer was cached");
    assert.equal(cache.putKeys.length, 0);
  });

  test("CSV IS NOT CACHED", async () => {
    // Same route, different body, and a one-shot download is the traffic shape
    // a cache helps least.
    const cache = mockCaches();
    cache.install();
    countLakehouse();
    await get(`${EVENTS}&format=csv`, envAt(8_800_000));
    assert.equal(cache.putKeys.length, 0);
  });

  test("a NON-ACCOUNT route is untouched", async () => {
    // The gate is scoped to the address-shaped family. `/accounts` and
    // `/accounts/top-holders` are bounded list reads that this must not claim.
    const cache = mockCaches();
    cache.install();
    countLakehouse();
    await get("/api/v1/accounts/top-holders", envAt(8_800_000));
    assert.deepEqual(cache.putKeys, []);
  });

  test("a NON-200 IS NEVER STORED", async () => {
    // A bad-checksum address is a 400 from the guard that runs inside dispatch,
    // and persisting it would answer a later, valid request with the error.
    const cache = mockCaches();
    cache.install();
    countLakehouse();
    const bad = "5EYCAe5jLQhn6ofDSvqFmCXAEZUZ2VZbtnPZmZmnUJVEexHY";
    const res = await get(`/api/v1/accounts/${bad}/events`, envAt(8_800_000));
    assert.equal(res.status, 400);
    assert.deepEqual(cache.putKeys, []);
  });

  test("HEAD is served from the GET entry, with no body", async () => {
    // `withEdgeCache` folds HEAD into the GET key only when the builder accepts
    // the normalized request. A builder closing over the original HEAD would
    // seed the GET entry with an empty body for every later caller, so this
    // asserts the direction that is safe and the property that makes it so.
    const cache = mockCaches();
    cache.install();
    const queries = countLakehouse();
    const env = envAt(8_800_000);

    await get(EVENTS, env);
    const afterGet = queries.length;
    const head = await handleRequest(
      new Request(`https://api.metagraph.sh${EVENTS}`, { method: "HEAD" }),
      env,
      ctx,
    );

    assert.equal(head.status, 200);
    assert.equal(await head.text(), "", "a HEAD must carry no body");
    assert.equal(queries.length, afterGet, "the HEAD re-read the lakehouse");
    assert.equal(cache.putKeys.length, 1, "the HEAD stored its own entry");
  });
});
