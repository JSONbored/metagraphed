import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { createLocalArtifactEnv } from "../scripts/lib.ts";
import { CONTRACT_VERSION } from "../src/contracts.ts";
import worker, { handleRequest, recordApiKeyUsage } from "../workers/api.ts";
import { EXPOSED_RESPONSE_HEADERS_VALUE } from "../workers/http.ts";
import { jsonBody, type Row } from "./row-type.ts";
import { R2_SQL_TOKEN_ENV } from "../src/r2-sql.ts";
import {
  decodeWatermarkKey,
  resetDecodeWatermarkCache,
} from "../src/decode-watermark.ts";

const env = createLocalArtifactEnv() as Row;

// `caches` is `declare const caches: CacheStorage` -- a module-scope const,
// not a `globalThis` property -- so stubbing/restoring it for a test needs
// this cast (matches workers/request-handlers/analytics.ts's own precedent).
const globalWithCaches = globalThis as unknown as { caches: Row | undefined };

function r2ArchiveFixture(artifactsByKey: Row) {
  return {
    async get(key: string) {
      const artifact =
        artifactsByKey[key] || artifactsByKey[key.replace(/^latest\//, "")];
      if (!artifact) {
        return null;
      }
      return {
        async json() {
          return artifact;
        },
      };
    },
  };
}

describe("Worker runtime", () => {
  test("default export delegates to handleRequest", async () => {
    const response = await worker.fetch(
      new Request("https://metagraph.sh/api/v1/build"),
      env as unknown as Env,
      {},
    );
    assert.equal(response.status, 200);
    assert.equal((await jsonBody(response)).ok, true);
  });

  test("applies a dedicated rate limiter before forwarding chain-events to DATA_API", async () => {
    let dataCalls = 0;
    let rateCalls = 0;
    const response = await handleRequest(
      new Request("https://metagraph.sh/api/v1/chain-events", {
        headers: { "cf-connecting-ip": "203.0.113.9" },
      }),
      {
        ...env,
        DATA_RATE_LIMITER: {
          limit({ key }: { key: string }) {
            rateCalls += 1;
            assert.equal(key, "data:203.0.113.9");
            return Promise.resolve({ success: false });
          },
        },
        DATA_API: {
          fetch() {
            dataCalls += 1;
            return new Response(JSON.stringify({ ok: true }), { status: 200 });
          },
        },
      } as unknown as Env,
      {},
    );
    assert.equal(response.status, 429);
    assert.equal((await response.json()).error.code, "data_rate_limited");
    assert.equal(response.headers.get("x-ratelimit-limit"), "60");
    assert.equal(rateCalls, 1);
    assert.equal(dataCalls, 0);
  });

  test("#8386: a valid API key uses the keyed tier's limiter, keyed by accountId not IP", async () => {
    let keyedLimiterCalls = 0;
    let anonymousLimiterCalls = 0;
    let usageIncrementCalls = 0;
    const waited: Promise<unknown>[] = [];
    const ctx = { waitUntil: (p: Promise<unknown>) => waited.push(p) };
    const response = await handleRequest(
      new Request("https://metagraph.sh/api/v1/chain-events", {
        headers: {
          "cf-connecting-ip": "203.0.113.9",
          authorization: "Bearer mg_aValidOpaqueUnkeyGeneratedSuffix",
        },
      }),
      {
        ...env,
        API_KEY_LOOKUP_INTERNAL_TOKEN: "test-lookup-token",
        DATA_RATE_LIMITER: {
          limit() {
            anonymousLimiterCalls += 1;
            return Promise.resolve({ success: false });
          },
        },
        DATA_RATE_LIMITER_KEYED: {
          limit({ key }: { key: string }) {
            keyedLimiterCalls += 1;
            // #8608 made the key TIER-scoped as well, so moving an account
            // between tiers starts a fresh window on the new ceiling instead
            // of inheriting the old tier's partly-spent one. The property
            // #8386 actually guards is unchanged and still asserted here: the
            // key is derived from the ACCOUNT ID, never from the client IP.
            assert.equal(key, "data:free:99");
            assert.ok(key.endsWith(":99"), "keyed by accountId");
            assert.ok(!/\d+\.\d+\.\d+\.\d+/.test(key), "never keyed by IP");
            return Promise.resolve({ success: true });
          },
        },
        DATA_API: {
          async fetch(request: Request) {
            const path = new URL(request.url).pathname;
            if (path === "/api/v1/internal/keys/verify") {
              return new Response(
                JSON.stringify({ valid: true, tier: "free", accountId: "99" }),
                { status: 200 },
              );
            }
            if (path === "/api/v1/internal/keys/usage") {
              usageIncrementCalls += 1;
              return new Response(JSON.stringify({ ok: true }), {
                status: 200,
              });
            }
            return new Response(JSON.stringify({ ok: true }), { status: 200 });
          },
        },
      } as unknown as Env,
      ctx,
    );
    assert.equal(response.status, 200);
    assert.equal(keyedLimiterCalls, 1);
    assert.equal(anonymousLimiterCalls, 0);
    await Promise.all(waited);
    assert.equal(usageIncrementCalls, 1);
  });

  test("#8609: a KEYED request that is rate-limited records a REJECTION, not usage", async () => {
    // A 429 was never served. Counting it as usage would overstate what the
    // tenant consumed and make the dashboard disagree with the enforcement
    // layer's own counters -- the exact thing #8609's acceptance bar forbids.
    const usageBodies: Record<string, unknown>[] = [];
    const waited: Promise<unknown>[] = [];
    const ctx = { waitUntil: (p: Promise<unknown>) => waited.push(p) };
    const response = await handleRequest(
      new Request("https://metagraph.sh/api/v1/chain-events", {
        headers: {
          "cf-connecting-ip": "203.0.113.9",
          authorization: "Bearer mg_aValidOpaqueUnkeyGeneratedSuffix",
        },
      }),
      {
        ...env,
        API_KEY_LOOKUP_INTERNAL_TOKEN: "test-lookup-token",
        DATA_RATE_LIMITER: { limit: () => Promise.resolve({ success: true }) },
        DATA_RATE_LIMITER_KEYED: {
          limit: () => Promise.resolve({ success: false }),
        },
        DATA_API: {
          async fetch(request: Request) {
            const path = new URL(request.url).pathname;
            if (path === "/api/v1/internal/keys/verify") {
              return new Response(
                JSON.stringify({ valid: true, tier: "free", accountId: "99" }),
                { status: 200 },
              );
            }
            if (path === "/api/v1/internal/keys/usage") {
              usageBodies.push(
                (await request.clone().json()) as Record<string, unknown>,
              );
            }
            return new Response(JSON.stringify({ ok: true }), { status: 200 });
          },
        },
      } as unknown as Env,
      ctx,
    );
    assert.equal(response.status, 429);
    await Promise.all(waited);
    const usage = usageBodies.find((b) => b.route === "chain-events");
    assert.ok(usage, "recorded against the account");
    assert.equal(usage!.rejected, true, "recorded as a REJECTION");
    assert.equal(usage!.account_id, 99);
  });

  test("#8609: an ANONYMOUS rate-limited request records nothing", async () => {
    // There is no account to attribute it to, and inventing one would put
    // keyless traffic into a per-tenant table.
    const usageCalls: unknown[] = [];
    const waited: Promise<unknown>[] = [];
    const response = await handleRequest(
      new Request("https://metagraph.sh/api/v1/chain-events", {
        headers: { "cf-connecting-ip": "203.0.113.9" },
      }),
      {
        ...env,
        API_KEY_LOOKUP_INTERNAL_TOKEN: "test-lookup-token",
        DATA_RATE_LIMITER: { limit: () => Promise.resolve({ success: false }) },
        DATA_API: {
          async fetch(request: Request) {
            const path = new URL(request.url).pathname;
            if (path === "/api/v1/internal/keys/usage") usageCalls.push(1);
            return new Response(JSON.stringify({ ok: true }), { status: 200 });
          },
        },
      } as unknown as Env,
      { waitUntil: (p: Promise<unknown>) => waited.push(p) },
    );
    assert.equal(response.status, 429);
    await Promise.all(waited);
    assert.deepEqual(usageCalls, []);
  });

  test("recordApiKeyUsage: no-ops when the DATA_API binding is absent", () => {
    const waited: Promise<unknown>[] = [];
    recordApiKeyUsage(
      { API_KEY_LOOKUP_INTERNAL_TOKEN: "t" } as unknown as Env,
      { waitUntil: (p) => waited.push(p) },
      "42",
      "chain-events",
    );
    assert.equal(waited.length, 0);
  });

  test("recordApiKeyUsage: no-ops when API_KEY_LOOKUP_INTERNAL_TOKEN is absent", () => {
    const waited: Promise<unknown>[] = [];
    recordApiKeyUsage(
      { DATA_API: { fetch: async () => new Response("{}") } } as unknown as Env,
      { waitUntil: (p) => waited.push(p) },
      "42",
      "chain-events",
    );
    assert.equal(waited.length, 0);
  });

  test("recordApiKeyUsage: fires the internal usage call via ctx.waitUntil when both are present", async () => {
    let fetchCalls = 0;
    const waited: Promise<unknown>[] = [];
    recordApiKeyUsage(
      {
        DATA_API: {
          fetch: async (req: Request) => {
            fetchCalls += 1;
            assert.equal(
              new URL(req.url).pathname,
              "/api/v1/internal/keys/usage",
            );
            return new Response(JSON.stringify({ ok: true }), { status: 200 });
          },
        },
        API_KEY_LOOKUP_INTERNAL_TOKEN: "t",
      } as unknown as Env,
      { waitUntil: (p) => waited.push(p) },
      "42",
      "chain-events",
    );
    assert.equal(waited.length, 1);
    await Promise.all(waited);
    assert.equal(fetchCalls, 1);
  });

  test("recordApiKeyUsage: fires the call directly (no waitUntil) when ctx is undefined", () => {
    let fetchCalls = 0;
    recordApiKeyUsage(
      {
        DATA_API: {
          fetch: async () => {
            fetchCalls += 1;
            return new Response(JSON.stringify({ ok: true }), { status: 200 });
          },
        },
        API_KEY_LOOKUP_INTERNAL_TOKEN: "t",
      } as unknown as Env,
      undefined,
      "42",
      "chain-events",
    );
    assert.equal(fetchCalls, 1);
  });

  /**
   * The chain-events family's tier, as it actually is.
   *
   * These used to stub DATA_API, which is what let them pass while the route was
   * broken in production: the binding's Postgres store was destroyed (#9186 /
   * #9193) so the real one could only 503, and a stub that answers 200 asserts
   * the code's assumption rather than the world. #8700 removed the forward, so
   * the tier under test is R2 SQL plus the published decode watermark that gives
   * page one its ceiling.
   *
   * Returns the queries issued, so a test can assert the tier was READ and not
   * merely that some envelope came back.
   */
  function lakehouseEnv(rows: Row[], extra: Row = {}) {
    const queries: string[] = [];
    globalThis.fetch = (async (_u: string, init: RequestInit) => {
      queries.push(JSON.parse(String(init.body)).query);
      return {
        ok: true,
        status: 200,
        json: async () => ({ success: true, result: { rows } }),
      } as unknown as Response;
    }) as unknown as typeof fetch;
    resetDecodeWatermarkCache();
    return {
      queries,
      env: {
        ...env,
        [R2_SQL_TOKEN_ENV]: "cfut_test",
        METAGRAPH_ARCHIVE: {
          async get(key: string) {
            if (key !== decodeWatermarkKey("mainnet")) return null;
            return {
              async text() {
                return JSON.stringify({ decoded_through: 8_771_082 });
              },
            };
          },
        },
        ...extra,
      } as unknown as Env,
    };
  }

  test("rewraps the tier's bare rows in the canonical envelope", async () => {
    const { env: testEnv, queries } = lakehouseEnv([
      { pallet: "System", method: "Event", count: 3 },
    ]);
    const response = await handleRequest(
      new Request("https://metagraph.sh/api/v1/chain-events/stats?blocks=500"),
      testEnv,
      {},
    );
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("access-control-allow-origin"), "*");
    assert.ok(response.headers.get("etag"));
    assert.equal(queries.length, 1, "the lakehouse was never queried");
    const body = await response.json();
    assert.equal(body.ok, true);
    assert.equal(body.schema_version, 1);
    assert.equal(body.data.window_blocks, 500);
    assert.equal(body.data.activity[0].pallet, "System");
    assert.equal(body.meta.source, "lakehouse-cold-tier");
  });

  test("caches a chain-events GET at the edge and skips a second tier read (#6767)", async () => {
    // THE CACHE WAS DEAD IN PRODUCTION until #8700. It was written only
    // `if (upstreamOk)` on a DATA_API forward that always 503'd, so every
    // request paid a full 18.6 MB R2 SQL scan. This asserts the tier is read
    // ONCE across two identical requests, against the real tier.
    const store = new Map();
    globalWithCaches.caches = {
      default: {
        async match(request: Request) {
          const cached = store.get(request.url);
          return cached ? cached.clone() : undefined;
        },
        async put(request: Request, response: Response) {
          store.set(request.url, response.clone());
        },
      },
    };
    try {
      const { env: testEnv, queries } = lakehouseEnv([
        { pallet: "System", method: "Event", count: 3 },
      ]);
      const waited: Promise<unknown>[] = [];
      const ctx = { waitUntil: (p: Promise<unknown>) => waited.push(p) };
      const url = "https://metagraph.sh/api/v1/chain-events/stats?blocks=500";
      const first = await handleRequest(new Request(url), testEnv, ctx);
      assert.equal(first.status, 200);
      assert.equal(queries.length, 1);
      // The cache.put is scheduled via ctx.waitUntil, not awaited inline --
      // drain it before the second request expects a warm cache.
      await Promise.all(waited);
      assert.equal(store.size, 1);

      const second = await handleRequest(new Request(url), testEnv, ctx);
      assert.equal(second.status, 200);
      assert.equal(
        queries.length,
        1,
        "second request must not re-read the tier",
      );
      const body = await second.json();
      assert.equal(body.data.window_blocks, 500);
      // The tier label survives the cache: it travels WITH the payload, so a
      // hit cannot report a different store than the miss did.
      assert.equal(body.meta.source, "lakehouse-cold-tier");
    } finally {
      globalWithCaches.caches = undefined;
    }
  });

  // The cache key carries the network, so the two chains cannot share an entry.
  // Their block numbers overlap, so a leak would be well-formed and invisible.
  test("a testnet request never receives the mainnet cache entry", async () => {
    const store = new Map();
    globalWithCaches.caches = {
      default: {
        async match(request: Request) {
          const cached = store.get(request.url);
          return cached ? cached.clone() : undefined;
        },
        async put(request: Request, response: Response) {
          store.set(request.url, response.clone());
        },
      },
    };
    try {
      const { env: testEnv, queries } = lakehouseEnv([
        { pallet: "System", method: "Event", count: 3 },
      ]);
      const waited: Promise<unknown>[] = [];
      const ctx = { waitUntil: (p: Promise<unknown>) => waited.push(p) };
      await handleRequest(
        new Request(
          "https://metagraph.sh/api/v1/chain-events/stats?blocks=500",
        ),
        testEnv,
        ctx,
      );
      await Promise.all(waited);
      assert.equal(store.size, 1);
      const testnet = await handleRequest(
        new Request(
          "https://metagraph.sh/api/v1/testnet/chain-events/stats?blocks=500",
        ),
        testEnv,
        ctx,
      );
      assert.equal(testnet.status, 200);
      // Testnet publishes no watermark in this env, so its reader declines and
      // the floor answers -- which is only observable because the mainnet entry
      // was NOT handed to it.
      assert.equal(
        testnet.headers.get("x-metagraph-degraded"),
        "tier_unavailable",
      );
      assert.equal(queries.length, 1, "testnet must not reuse mainnet's read");
    } finally {
      globalWithCaches.caches = undefined;
    }
  });

  test("never caches a failed tier read, degraded or not (#6767)", async () => {
    const store = new Map();
    globalWithCaches.caches = {
      default: {
        async match(request: Request) {
          const cached = store.get(request.url);
          return cached ? cached.clone() : undefined;
        },
        async put(request: Request, response: Response) {
          store.set(request.url, response.clone());
        },
      },
    };
    try {
      let reads = 0;
      globalThis.fetch = (async () => {
        reads += 1;
        throw new Error("r2 sql unreachable");
      }) as unknown as typeof fetch;
      resetDecodeWatermarkCache();
      const testEnv = {
        ...env,
        [R2_SQL_TOKEN_ENV]: "cfut_test",
      } as unknown as Env;
      const waited: Promise<unknown>[] = [];
      const ctx = { waitUntil: (p: Promise<unknown>) => waited.push(p) };
      const response = await handleRequest(
        new Request("https://metagraph.sh/api/v1/chain-events/stats?blocks=1"),
        testEnv,
        ctx,
      );
      // #9146: a failed tier degrades to the schema-stable empty rather than
      // erroring. The CACHE invariant is the load-bearing half here -- a
      // degraded empty must never be cached, or one blip pins zeros in for the
      // whole TTL.
      assert.equal(response.status, 200);
      assert.equal(
        response.headers.get("x-metagraph-degraded"),
        "tier_unavailable",
      );
      await Promise.all(waited);
      assert.equal(
        store.size,
        0,
        "neither an error NOR a degraded empty may be cached",
      );
      assert.ok(reads > 0, "the tier must have been attempted");
    } finally {
      globalWithCaches.caches = undefined;
    }
  });

  test("routes /api/v1/subnets/:netuid/ownership-history through the same tier (#6637)", async () => {
    const { env: testEnv, queries } = lakehouseEnv([]);
    const response = await handleRequest(
      new Request("https://metagraph.sh/api/v1/subnets/7/ownership-history"),
      testEnv,
      {},
    );
    assert.equal(response.status, 200);
    assert.ok(queries.length > 0, "the lakehouse was never queried");
    // Two tables: the raw event stream and the captured ownership projection.
    for (const q of queries) assert.match(q, /FROM chain\.\w+/);
    const body = await response.json();
    assert.equal(body.ok, true);
    assert.equal(body.data.netuid, 7);
    assert.deepEqual(body.data.ownership_changes, []);
    assert.equal(body.meta.source, "lakehouse-cold-tier");
  });

  test("routes /api/v1/subnets/:netuid/conviction through the LIVE chain tier (#6638)", async () => {
    // The one member of the family that is not a lakehouse read: it queries
    // chain storage at request time (#9319), and `meta.source` has to say so.
    const calls: string[] = [];
    globalThis.fetch = (async (_u: unknown, init: unknown) => {
      const body = JSON.parse(
        String((init as { body?: string })?.body ?? "{}"),
      );
      calls.push(String(body.method));
      const result =
        body.method === "chain_getHeader"
          ? { number: "0x85d1db" }
          : body.method === "state_getKeysPaged"
            ? []
            : null;
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }));
    }) as unknown as typeof fetch;
    const response = await handleRequest(
      new Request("https://metagraph.sh/api/v1/subnets/1/conviction"),
      env as unknown as Env,
      {},
    );
    assert.equal(response.status, 200);
    assert.ok(calls.length > 0, "the chain was never read");
    const body = await response.json();
    assert.equal(body.ok, true);
    assert.equal(body.data.netuid, 1);
    assert.deepEqual(body.data.leaderboard, []);
    assert.equal(body.meta.source, "live-chain-storage");
  });

  const CHAIN_EVENTS_CSV_HEADER =
    "block_number,event_index,pallet,method,phase,extrinsic_index,observed_at";

  test("serializes the chain-events feed to CSV on ?format=csv", async () => {
    const { env: testEnv, queries } = lakehouseEnv([
      {
        block_number: 8454388,
        event_index: 3,
        pallet: "Balances",
        method: "Transfer",
        args: '{"from":"5A","to":"5B"}',
        phase: "ApplyExtrinsic",
        extrinsic_index: 2,
        observed_at: 1751500800000,
      },
    ]);
    const response = await handleRequest(
      new Request("https://metagraph.sh/api/v1/chain-events?format=csv"),
      testEnv,
      {},
    );
    assert.equal(response.status, 200);
    assert.equal(queries.length, 1, "the lakehouse was never queried");
    assert.match(response.headers.get("content-type"), /text\/csv/);
    assert.match(
      response.headers.get("content-disposition") ?? "",
      /attachment; filename="/,
    );
    const lines = (await response.text()).trim().split("\r\n");
    assert.equal(lines[0], CHAIN_EVENTS_CSV_HEADER);
    assert.equal(lines.length, 2);
    const cells = lines[1].split(",");
    assert.equal(cells[0], "8454388"); // block_number
    assert.equal(cells[2], "Balances"); // pallet
    assert.equal(cells[3], "Transfer"); // method
    // The nested `args` value is intentionally not a CSV column.
    assert.equal(cells.length, CHAIN_EVENTS_CSV_HEADER.split(",").length);
  });

  test("emits a header-only chain-events CSV when the feed is empty", async () => {
    const { env: testEnv } = lakehouseEnv([]);
    const response = await handleRequest(
      new Request(
        "https://metagraph.sh/api/v1/chain-events?pallet=Balances&format=csv",
      ),
      testEnv,
      {},
    );
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /text\/csv/);
    assert.equal((await response.text()).trim(), CHAIN_EVENTS_CSV_HEADER);
  });

  test("emits a header-only chain-events CSV when the cached payload has no events", async () => {
    // Defensive path for the `Array.isArray(...) ? … : []` guard. It is
    // reachable through the CACHE: an entry written by an earlier deploy in a
    // different payload shape outlives that deploy by its whole TTL, and a CSV
    // export must yield a header-only file rather than throw on it.
    globalWithCaches.caches = {
      default: {
        async match() {
          return new Response(
            JSON.stringify({
              data: { count: 0 },
              source: "lakehouse-cold-tier",
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        },
        async put() {},
      },
    };
    try {
      const response = await handleRequest(
        new Request("https://metagraph.sh/api/v1/chain-events?format=csv"),
        { ...env, [R2_SQL_TOKEN_ENV]: "cfut_test" } as unknown as Env,
        {},
      );
      assert.equal(response.status, 200);
      assert.match(response.headers.get("content-type"), /text\/csv/);
      assert.equal((await response.text()).trim(), CHAIN_EVENTS_CSV_HEADER);
    } finally {
      globalWithCaches.caches = undefined;
    }
  });

  test("chain-events rejects a typo'd filter instead of serving unfiltered data", async () => {
    // #9149. This proxy forwards path+search verbatim and DATA_API ignores what
    // it does not recognise, so `?palet=Balances` used to return the UNFILTERED
    // feed as a 200 -- and it never reached DATA_API's notice at all.
    //
    // The DATA_API binding below throws: if validation is removed, this test
    // fails by surfacing that throw rather than by a quiet assertion, because a
    // rejected request must never reach the upstream (nor mint a cache entry
    // keyed on the typo).
    const response = await handleRequest(
      new Request(
        "https://metagraph.sh/api/v1/chain-events?pallet=Balances&methd=Transfer",
      ),
      {
        ...env,
        DATA_API: {
          fetch() {
            throw new Error("upstream must not be called for a rejected query");
          },
        },
      } as unknown as Env,
      {},
    );
    assert.equal(response.status, 400);
    const body = await response.json();
    assert.equal(body.ok, false);
    assert.equal(body.error.code, "invalid_query");
    assert.equal(body.meta.parameter, "methd");
  });

  test("chain-events still serves a request whose params are all declared", async () => {
    // The other direction: a validator that rejected real parameters would
    // break the route more visibly than the bug it replaced.
    const response = await handleRequest(
      new Request(
        "https://metagraph.sh/api/v1/chain-events?pallet=Balances&method=Transfer&limit=5",
      ),
      {
        ...env,
        DATA_API: {
          fetch() {
            return new Response(JSON.stringify({ events: [] }), {
              status: 200,
              headers: { "content-type": "application/json" },
            });
          },
        },
      } as unknown as Env,
      {},
    );
    assert.equal(response.status, 200);
    assert.equal((await response.json()).ok, true);
  });

  test("chain-events/stats ignores ?format=csv and keeps the JSON envelope", async () => {
    // Only the feed exposes a top-level row array; the stats aggregate has none,
    // so a CSV request must fall through to the enveloped JSON, not a bogus export.
    const response = await handleRequest(
      new Request(
        "https://metagraph.sh/api/v1/chain-events/stats?blocks=500&format=csv",
      ),
      {
        ...env,
        DATA_API: {
          fetch() {
            return new Response(
              JSON.stringify({ window_blocks: 500, groups: 0, activity: [] }),
              { status: 200, headers: { "content-type": "application/json" } },
            );
          },
        },
      } as unknown as Env,
      {},
    );
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /application\/json/);
    assert.equal((await response.json()).ok, true);
  });

  test("a HEAD chain-events probe gets the bodiless 200, not a 405", async () => {
    // This used to need a workaround: DATA_API was GET-only, so the proxy had
    // to forward a GET on HEAD's behalf or the probe got the data Worker's 405
    // instead of the bodiless 200 every other GET route gives. With the
    // forward gone the tier is read directly and envelopeResponse strips the
    // body -- the guarantee is the same, the workaround is not needed.
    const { env: testEnv, queries } = lakehouseEnv([
      { pallet: "System", method: "Event", count: 3 },
    ]);
    const response = await handleRequest(
      new Request("https://metagraph.sh/api/v1/chain-events/stats", {
        method: "HEAD",
      }),
      testEnv,
      {},
    );
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "");
    assert.ok(response.headers.get("etag"));
    assert.equal(queries.length, 1, "the tier must still be read for HEAD");
  });

  test("degrades a DATA_API upstream 5xx instead of erroring", async () => {
    const response = await handleRequest(
      new Request("https://metagraph.sh/api/v1/chain-events"),
      {
        ...env,
        DATA_API: {
          fetch() {
            return new Response(
              JSON.stringify({ error: "data query failed" }),
              {
                status: 502,
                headers: { "content-type": "application/json" },
              },
            );
          },
        },
      } as unknown as Env,
      {},
    );
    // #9146: a 5xx from the tier degrades. A 4xx still surfaces as an error
    // envelope -- covered in tests/chain-events-degraded.test.ts.
    assert.equal(response.status, 200);
    assert.equal(
      response.headers.get("x-metagraph-degraded"),
      "tier_unavailable",
    );
    const degraded = (await response.json()) as {
      ok: boolean;
      data?: { events?: unknown[] };
    };
    assert.equal(degraded.ok, true);
    assert.deepEqual(degraded.data?.events, []);
  });

  test("degrades when the DATA_API binding is absent", async () => {
    const response = await handleRequest(
      new Request("https://metagraph.sh/api/v1/chain-events"),
      env as unknown as Env,
      {},
    );
    // #9146: an absent binding degrades for these READ routes too. The
    // user-state write proxies (alerts/auth/keys) keep their 503 -- see
    // tests/data-api-unreachable.test.ts.
    assert.equal(response.status, 200);
    assert.equal(
      response.headers.get("x-metagraph-degraded"),
      "tier_unavailable",
    );
  });

  test("serves API envelopes with cache and CORS headers", async () => {
    const response = await handleRequest(
      new Request("https://metagraph.sh/api/v1/subnets/7"),
      env as unknown as Env,
      {},
    );
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("access-control-allow-origin"), "*");
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.equal(response.headers.get("x-metagraph-cache-profile"), "standard");
    assert.ok(response.headers.get("etag"));
    const body = await response.json();
    assert.equal(body.ok, true);
    assert.equal(body.data.subnet.netuid, 7);
    // published_at is null when no control KV pointer is bound.
    assert.equal(body.meta.published_at, null);
  });

  test("surfaces meta.published_at from the KV latest pointer", async () => {
    const publishedAt = "2026-06-09T13:57:16.231Z";
    const controlEnv = {
      ...env,
      METAGRAPH_CONTROL: {
        async get(key: string, options?: { type?: string }) {
          assert.equal(key, "metagraph:latest");
          assert.equal(options?.type, "json");
          return { latest_prefix: "latest/", published_at: publishedAt };
        },
      },
    };
    const response = await handleRequest(
      new Request("https://metagraph.sh/api/v1/subnets/7"),
      controlEnv as unknown as Env,
      {},
    );
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.meta.published_at, publishedAt);
    // generated_at is now served LIVE as the real publish time (serve-time overlay);
    // the baked epoch marker (issue #349) is never exposed to consumers.
    assert.equal(body.meta.generated_at, publishedAt);
  });

  test("/api/v1/build serves published_at + generated_at from the KV pointer (live, not the baked marker)", async () => {
    const publishedAt = "2026-06-12T21:06:24.956Z";
    const controlEnv = {
      ...env,
      METAGRAPH_CONTROL: {
        async get(key: string, options?: { type?: string }) {
          assert.equal(key, "metagraph:latest");
          assert.equal(options?.type, "json");
          return { latest_prefix: "latest/", published_at: publishedAt };
        },
      },
    };
    const response = await handleRequest(
      new Request("https://api.metagraph.sh/api/v1/build"),
      controlEnv as unknown as Env,
      {},
    );
    assert.equal(response.status, 200);
    const body = await response.json();
    // The committed build-summary body carries published_at:null; serve overlays
    // the real publish pointer so a body-reading agent sees genuine freshness.
    assert.equal(body.data.published_at, publishedAt);
    assert.equal(body.meta.published_at, publishedAt);
    // generated_at is served LIVE as the real publish time (serve-time overlay), so
    // a body-reading agent sees the true date, not the baked epoch marker (#349).
    assert.equal(body.data.generated_at, publishedAt);
  });

  test("/api/v1/economics serves the live KV blob (meta.source: live-kv)", async () => {
    const liveBlob = {
      schema_version: 1,
      contract_version: CONTRACT_VERSION,
      generated_at: "1970-01-01T00:00:00.000Z",
      captured_at: new Date(Date.now() - 60_000).toISOString(), // fresh
      network: "finney",
      summary: { subnet_count: 1, with_economics_count: 1 },
      subnets: [{ netuid: 7, slug: "x", name: "X", emission_share: 1 }],
    };
    const liveEnv = {
      ...env,
      METAGRAPH_CONTROL: {
        async get(key: string, options?: { type?: string }) {
          if (key === "economics:current") {
            assert.equal(options?.type, "json");
            return liveBlob;
          }
          return null;
        },
      },
    };
    const response = await handleRequest(
      new Request("https://api.metagraph.sh/api/v1/economics"),
      liveEnv as unknown as Env,
      {},
    );
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.meta.source, "live-kv");
    assert.equal(body.data.subnets[0].netuid, 7);
    assert.equal(body.data.summary.with_economics_count, 1);
  });

  test("/api/v1/economics falls back to the R2 artifact when KV is cold (meta.source: r2-fallback)", async () => {
    // Base env has no METAGRAPH_CONTROL → resolveLiveEconomics returns null →
    // the committed R2 economics.json serves, exactly as before this tier existed.
    const response = await handleRequest(
      new Request("https://api.metagraph.sh/api/v1/economics"),
      env as unknown as Env,
      {},
    );
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.meta.source, "r2-fallback");
    assert.ok(Array.isArray(body.data.subnets));
  });

  test("/api/v1/economics rejects a stale KV blob and falls back to R2", async () => {
    const staleEnv = {
      ...env,
      METAGRAPH_CONTROL: {
        async get(key: string) {
          if (key === "economics:current") {
            return {
              schema_version: 1,
              contract_version: CONTRACT_VERSION,
              captured_at: "2020-01-01T00:00:00.000Z", // way past the 8h window
              summary: { with_economics_count: 1 },
              subnets: [{ netuid: 7, emission_share: 1 }],
            };
          }
          return null;
        },
      },
    };
    const response = await handleRequest(
      new Request("https://api.metagraph.sh/api/v1/economics"),
      staleEnv as unknown as Env,
      {},
    );
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.meta.source, "r2-fallback");
  });

  test("/.well-known/mcp/server-card.json overlays published_at from the KV pointer", async () => {
    const publishedAt = "2026-06-12T21:06:24.956Z";
    const controlEnv = {
      ...env,
      METAGRAPH_CONTROL: {
        async get(key: string, options?: { type?: string }) {
          assert.equal(key, "metagraph:latest");
          assert.equal(options?.type, "json");
          return { latest_prefix: "latest/", published_at: publishedAt };
        },
      },
    };
    const response = await handleRequest(
      new Request("https://api.metagraph.sh/.well-known/mcp/server-card.json"),
      controlEnv as unknown as Env,
      {},
    );
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "application/json");
    assert.ok(response.headers.get("etag"));
    const card = await response.json();
    // The committed card carries published_at:null; serve overlays the real
    // publish pointer. generated_at (the build marker, epoch-0 in CI / real in a
    // production refresh) must not be clobbered by the overlay; content_hash +
    // serverInfo are preserved.
    assert.equal(card.published_at, publishedAt);
    assert.notEqual(card.generated_at, publishedAt);
    assert.ok(card.content_hash, "card must keep its content_hash");
    assert.ok(card.serverInfo?.name, "card must keep serverInfo");

    // Cold (no KV pointer): published_at stays null, card still serves.
    const cold = await handleRequest(
      new Request("https://api.metagraph.sh/.well-known/mcp/server-card.json"),
      env as unknown as Env,
      {},
    );
    assert.equal(cold.status, 200);
    assert.equal((await cold.json()).published_at, null);
  });

  test("serves a health readiness probe", async () => {
    const response = await handleRequest(
      new Request("https://metagraph.sh/health"),
      env as unknown as Env,
      {},
    );
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.status, "ok");
    assert.equal(body.service, "metagraphed");
    assert.equal(body.bindings.assets, true);
    assert.equal(typeof body.bindings.r2, "boolean");
    assert.equal(typeof body.bindings.kv, "boolean");

    const head = await handleRequest(
      new Request("https://metagraph.sh/health", { method: "HEAD" }),
      env as unknown as Env,
      {},
    );
    assert.equal(head.status, 200);

    const post = await handleRequest(
      new Request("https://metagraph.sh/health", { method: "POST" }),
      env as unknown as Env,
      {},
    );
    assert.equal(post.status, 405);
  });

  test("returns 504 when an R2 read exceeds the timeout", async () => {
    const slowEnv = {
      ...env,
      METAGRAPH_R2_TIMEOUT_MS: "20",
      METAGRAPH_ARCHIVE: {
        async get() {
          await new Promise((resolve) => setTimeout(resolve, 250));
          return {
            async json() {
              return {};
            },
          };
        },
      },
    };
    const response = await handleRequest(
      new Request("https://metagraph.sh/metagraph/subnets/7.json"),
      slowEnv as unknown as Env,
      {},
    );
    assert.equal(response.status, 504);
    assert.equal((await response.json()).error.code, "r2_timeout");
  });

  test("renders a self-hosted SVG health badge for a subnet", async () => {
    const response = await handleRequest(
      new Request("https://metagraph.sh/metagraph/health/badges/7.svg"),
      env as unknown as Env,
      {},
    );
    assert.equal(response.status, 200);
    assert.equal(
      response.headers.get("content-type"),
      "image/svg+xml; charset=utf-8",
    );
    assert.equal(response.headers.get("access-control-allow-origin"), "*");
    const etag = response.headers.get("etag");
    assert.ok(etag);
    const svg = await response.text();
    assert.match(svg, /^<svg/);
    assert.match(svg, /SN7/);

    const cached = await handleRequest(
      new Request("https://metagraph.sh/metagraph/health/badges/7.svg", {
        headers: { "if-none-match": etag },
      }),
      env as unknown as Env,
      {},
    );
    assert.equal(cached.status, 304);
  });

  test("renders a graceful badge for a subnet without a badge artifact", async () => {
    const response = await handleRequest(
      new Request("https://metagraph.sh/metagraph/health/badges/99999.svg"),
      env as unknown as Env,
      {},
    );
    assert.equal(response.status, 200);
    assert.equal(
      response.headers.get("content-type"),
      "image/svg+xml; charset=utf-8",
    );
    const svg = await response.text();
    assert.match(svg, /SN99999/);
    assert.match(svg, /unavailable/);
  });

  test("serves raw R2-tier artifacts from archive storage", async () => {
    const response = await handleRequest(
      new Request("https://metagraph.sh/metagraph/subnets/7.json"),
      env as unknown as Env,
      {},
    );
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-metagraph-artifact-source"), "r2");
    assert.equal(response.headers.get("x-metagraph-storage-tier"), "r2");
    assert.equal((await response.json()).subnet.netuid, 7);

    const candidates = await handleRequest(
      new Request("https://metagraph.sh/metagraph/candidates.json"),
      env as unknown as Env,
      {},
    );
    assert.equal(candidates.status, 200);
    assert.equal(candidates.headers.get("x-metagraph-artifact-source"), "r2");
    assert.equal(candidates.headers.get("x-metagraph-storage-tier"), "r2");
    assert.equal(Array.isArray((await candidates.json()).candidates), true);

    const reviewQueue = await handleRequest(
      new Request("https://metagraph.sh/metagraph/review-queue.json"),
      env as unknown as Env,
      {},
    );
    assert.equal(reviewQueue.status, 200);
    assert.equal(reviewQueue.headers.get("x-metagraph-artifact-source"), "r2");
    assert.equal(reviewQueue.headers.get("x-metagraph-storage-tier"), "r2");
    assert.equal(Array.isArray((await reviewQueue.json()).candidates), true);

    const missingArchive = await handleRequest(
      new Request("https://metagraph.sh/metagraph/subnets/7.json"),
      {
        ASSETS: env.ASSETS,
      } as unknown as Env,
      {},
    );
    assert.equal(missingArchive.status, 404);
    assert.equal(
      (await missingArchive.json()).error.code,
      "r2_binding_missing",
    );

    const assetMissing = await env.ASSETS.fetch(
      new Request("https://assets.local/metagraph/nope.json"),
    );
    assert.equal(assetMissing.status, 404);
  });

  test("allows explicit static fallback for R2-only artifacts in local mode", async () => {
    const response = await handleRequest(
      new Request("https://metagraph.sh/metagraph/endpoints.json"),
      {
        ASSETS: {
          async fetch() {
            return Response.json({
              schema_version: 1,
              generated_at: "1970-01-01T00:00:00.000Z",
              endpoints: [{ id: "local-fallback", status: "unknown" }],
            });
          },
        },
        METAGRAPH_ARCHIVE: {
          async get() {
            return null;
          },
        },
        METAGRAPH_ALLOW_R2_STATIC_FALLBACK: "true",
      } as unknown as Env,
      {},
    );

    assert.equal(response.status, 200);
    assert.equal(
      response.headers.get("x-metagraph-artifact-source"),
      "static-assets",
    );
    assert.equal(response.headers.get("x-metagraph-storage-tier"), "r2");
    assert.equal((await response.json()).endpoints[0].id, "local-fallback");
  });

  test("serves coverage/subnets from R2 (R2-only, no committed copy)", async () => {
    const fresh = {
      schema_version: 1,
      generated_at: "1970-01-01T00:00:00.000Z",
      native_snapshot_captured_at: "2026-06-14T14:06:28.000Z",
    };

    // subnets/coverage are R2-only (#1003): R2 warm → the published copy serves.
    const warm = await handleRequest(
      new Request("https://metagraph.sh/metagraph/coverage.json"),
      {
        ASSETS: {
          async fetch() {
            return new Response("not found", { status: 404 });
          },
        },
        METAGRAPH_ARCHIVE: {
          async get(key: string) {
            assert.equal(key, "latest/coverage.json");
            return {
              async json() {
                return fresh;
              },
            };
          },
        },
      } as unknown as Env,
      {},
    );
    assert.equal(warm.status, 200);
    assert.equal(warm.headers.get("x-metagraph-artifact-source"), "r2");
    assert.equal(
      (await warm.json()).native_snapshot_captured_at,
      "2026-06-14T14:06:28.000Z",
    );

    // R2 cold → 404. There is no committed copy to fall back to anymore, and the
    // static-asset fallback is opt-in (METAGRAPH_ALLOW_R2_STATIC_FALLBACK),
    // covered by the local-mode test above.
    const cold = await handleRequest(
      new Request("https://metagraph.sh/metagraph/subnets.json"),
      {
        ASSETS: {
          async fetch() {
            return new Response("not found", { status: 404 });
          },
        },
        METAGRAPH_ARCHIVE: {
          async get() {
            return null;
          },
        },
      } as unknown as Env,
      {},
    );
    assert.equal(cold.status, 404);
  });

  test("serves metagraph latest as an R2-backed raw artifact", async () => {
    const r2KeysRequested: string[] = [];
    const metagraphLatest = {
      schema_version: 1,
      generated_at: "1970-01-01T00:00:00.000Z",
      network: "finney",
      subnets: [],
    };
    const response = await handleRequest(
      new Request("https://metagraph.sh/metagraph/metagraph/latest.json"),
      {
        ASSETS: env.ASSETS,
        METAGRAPH_ARCHIVE: {
          async get(key: string) {
            r2KeysRequested.push(key);
            assert.equal(key, "latest/metagraph/latest.json");
            return {
              async json() {
                return metagraphLatest;
              },
            };
          },
        },
      } as unknown as Env,
      {},
    );

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-metagraph-artifact-source"), "r2");
    assert.equal(response.headers.get("x-metagraph-storage-tier"), "r2");
    assert.deepEqual(r2KeysRequested, ["latest/metagraph/latest.json"]);
    assert.equal((await response.json()).network, "finney");
  });

  test("serves raw R2-backed schema snapshot artifacts", async () => {
    const r2KeysRequested: string[] = [];
    const schemaSnapshot = {
      schema_version: 1,
      contract_version: CONTRACT_VERSION,
      generated_at: "1970-01-01T00:00:00.000Z",
      observed_at: "2999-01-01T00:00:00.000Z",
      surface_id: "example-openapi",
      schema_url: "https://example.com/openapi.json",
      hash: "abc123",
      openapi_version: "3.1.0",
      title: "Example API",
    };
    const response = await handleRequest(
      new Request(
        "https://metagraph.sh/metagraph/schemas/example-openapi.json",
      ),
      {
        ASSETS: env.ASSETS,
        METAGRAPH_ARCHIVE: {
          async get(key: string) {
            r2KeysRequested.push(key);
            assert.equal(key, "latest/schemas/example-openapi.json");
            return {
              async json() {
                return schemaSnapshot;
              },
            };
          },
        },
      } as unknown as Env,
      {},
    );

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-metagraph-artifact-source"), "r2");
    assert.equal(response.headers.get("x-metagraph-storage-tier"), "r2");
    assert.deepEqual(r2KeysRequested, ["latest/schemas/example-openapi.json"]);
    assert.equal((await response.json()).title, "Example API");
  });

  test("rejects raw artifact paths outside public contracts before storage lookup", async () => {
    const assetRequests: string[] = [];
    const r2KeysRequested: string[] = [];
    const response = await handleRequest(
      new Request("https://metagraph.sh/metagraph/internal/control.json"),
      {
        ASSETS: {
          async fetch(request: Request) {
            assetRequests.push(new URL(request.url).pathname);
            return Response.json({ secret_token: "should-not-be-public" });
          },
        },
        METAGRAPH_ARCHIVE: {
          async get(key: string) {
            r2KeysRequested.push(key);
            return {
              async json() {
                return { secret_token: "should-not-be-public" };
              },
            };
          },
        },
      } as unknown as Env,
      {},
    );

    assert.equal(response.status, 404);
    assert.equal(response.headers.get("x-metagraph-error-code"), "not_found");
    assert.deepEqual(assetRequests, []);
    assert.deepEqual(r2KeysRequested, []);
    assert.equal(
      (await response.json()).meta.artifact_path,
      "/metagraph/internal/control.json",
    );
  });

  test("supports HEAD, ETag revalidation, and CORS preflight", async () => {
    const head = await handleRequest(
      new Request("https://metagraph.sh/api/v1/subnets", { method: "HEAD" }),
      env as unknown as Env,
      {},
    );
    assert.equal(head.status, 200);
    assert.equal(await head.text(), "");
    assert.ok(head.headers.get("etag"));

    const source = await handleRequest(
      new Request("https://metagraph.sh/api/v1/contracts"),
      env as unknown as Env,
      {},
    );
    const cached = await handleRequest(
      new Request("https://metagraph.sh/api/v1/contracts", {
        headers: { "if-none-match": source.headers.get("etag") },
      }),
      env as unknown as Env,
      {},
    );
    assert.equal(cached.status, 304);
    assert.equal(await cached.text(), "");

    // The raw artifact path revalidates too (a separate call site from the
    // envelope path); `*` matches any current representation.
    const raw = await handleRequest(
      new Request("https://metagraph.sh/metagraph/subnets/7.json"),
      env as unknown as Env,
      {},
    );
    const rawConditional = await handleRequest(
      new Request("https://metagraph.sh/metagraph/subnets/7.json", {
        headers: { "if-none-match": "*" },
      }),
      env as unknown as Env,
      {},
    );
    assert.ok(raw.headers.get("etag"));
    assert.equal(rawConditional.status, 304);

    const options = await handleRequest(
      new Request("https://metagraph.sh/api/v1/contracts", {
        method: "OPTIONS",
      }),
      env as unknown as Env,
      {},
    );
    assert.equal(options.status, 204);
    assert.equal(
      options.headers.get("access-control-allow-methods"),
      "GET, HEAD, OPTIONS",
    );

    const rpcOptions = await handleRequest(
      new Request("https://metagraph.sh/rpc/v1/finney", { method: "OPTIONS" }),
      env as unknown as Env,
      {},
    );
    assert.equal(rpcOptions.status, 204);
    assert.equal(
      rpcOptions.headers.get("access-control-allow-methods"),
      "POST, OPTIONS",
    );
  });

  test("validates list query parameters with route-specific contracts", async () => {
    const invalidCases = [
      ["/api/v1/subnets?limit=0", "limit"],
      ["/api/v1/subnets?limit=1001", "limit"],
      ["/api/v1/subnets?cursor=nope", "cursor"],
      ["/api/v1/subnets?order=sideways", "order"],
      ["/api/v1/subnets?sort=nope", "sort"],
      ["/api/v1/subnets?fields=netuid,nope", "fields"],
      ["/api/v1/subnets?netuid=nope", "netuid"],
      ["/api/v1/subnets?subnet_type=nope", "subnet_type"],
      ["/api/v1/subnets/7/endpoints?netuid=7", "netuid"],
      ["/api/v1/subnets?statuss=active", "statuss"],
    ];

    for (const [path, parameter] of invalidCases) {
      const response = await handleRequest(
        new Request(`https://metagraph.sh${path}`),
        env as unknown as Env,
        {},
      );
      assert.equal(response.status, 400);
      const body = await response.json();
      assert.equal(body.error.code, "invalid_query");
      assert.equal(body.meta.parameter, parameter);
    }

    const response = await handleRequest(
      new Request(
        "https://metagraph.sh/api/v1/subnets?q=allways&sort=netuid&order=desc&limit=1&cursor=0",
      ),
      env as unknown as Env,
      {},
    );
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.meta.pagination.collection, "subnets");
    assert.equal(body.meta.pagination.limit, 1);
    assert.equal(body.meta.pagination.sort, "netuid");
  });

  test("projects list rows with ?fields while preserving pagination and filters", async () => {
    const response = await handleRequest(
      new Request(
        "https://metagraph.sh/api/v1/subnets?domain=inference&fields=netuid,name,slug&limit=2&sort=netuid",
      ),
      env as unknown as Env,
      {},
    );
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.meta.pagination.collection, "subnets");
    assert.ok(body.meta.pagination.returned > 0);
    assert.ok(body.meta.pagination.returned <= 2);
    assert.deepEqual(body.meta.projection.fields, ["netuid", "name", "slug"]);
    assert.equal(body.data.subnets.length, body.meta.pagination.returned);
    assert.deepEqual(Object.keys(body.data.subnets[0]).sort(), [
      "name",
      "netuid",
      "slug",
    ]);
    assert.equal("categories" in body.data.subnets[0], false);
  });

  test("returns deterministic API errors", async () => {
    const post = await handleRequest(
      new Request("https://metagraph.sh/api/v1/subnets", { method: "POST" }),
      env as unknown as Env,
      {},
    );
    assert.equal(post.status, 405);
    assert.equal(post.headers.get("allow"), "GET, HEAD, OPTIONS");
    assert.equal(
      post.headers.get("x-metagraph-error-code"),
      "method_not_allowed",
    );

    const missingRoute = await handleRequest(
      new Request("https://metagraph.sh/api/v1/nope"),
      env as unknown as Env,
      {},
    );
    assert.equal(missingRoute.status, 404);
    assert.equal((await missingRoute.json()).error.code, "not_found");

    const missingArtifact = await handleRequest(
      new Request("https://metagraph.sh/api/v1/subnets/999999"),
      env as unknown as Env,
      {},
    );
    assert.equal(missingArtifact.status, 404);
    assert.equal(
      (await missingArtifact.json()).meta.artifact_path,
      "/metagraph/subnets/999999.json",
    );

    const noAssets = await handleRequest(
      new Request("https://metagraph.sh/anything"),
      {} as unknown as Env,
      {},
    );
    assert.equal(noAssets.status, 404);
    assert.equal((await noAssets.json()).error.code, "not_found");

    const staticFallback = await handleRequest(
      new Request("https://metagraph.sh/static.json"),
      {
        ASSETS: {
          async fetch() {
            return new Response(JSON.stringify({ ok: true }), {
              status: 200,
              headers: { "content-type": "application/json" },
            });
          },
        },
      } as unknown as Env,
      {},
    );
    assert.equal(staticFallback.status, 200);
  });

  test("falls back to R2 using KV latest pointer", async () => {
    const response = await handleRequest(
      new Request("https://metagraph.sh/api/v1/changelog"),
      {
        ASSETS: {
          async fetch() {
            return new Response("not found", { status: 404 });
          },
        },
        METAGRAPH_CONTROL: {
          async get(key: string) {
            assert.equal(key, "metagraph:latest");
            return { latest_prefix: "latest/" };
          },
        },
        METAGRAPH_ARCHIVE: {
          async get(key: string) {
            assert.equal(key, "latest/changelog.json");
            return {
              async json() {
                return {
                  schema_version: 1,
                  contract_version: CONTRACT_VERSION,
                  generated_at: "1970-01-01T00:00:00.000Z",
                  source: "generated-artifact-diff",
                };
              },
            };
          },
        },
      } as unknown as Env,
      {},
    );
    assert.equal(response.status, 200);
    assert.equal((await response.json()).meta.source, "r2");

    const r2Miss = await handleRequest(
      new Request("https://metagraph.sh/api/v1/changelog"),
      {
        ASSETS: {
          async fetch() {
            return new Response("not found", { status: 404 });
          },
        },
        METAGRAPH_CONTROL: {
          async get() {
            throw new Error("kv unavailable");
          },
        },
        METAGRAPH_R2_LATEST_PREFIX: "latest/",
        METAGRAPH_ARCHIVE: {
          async get(key: string) {
            assert.equal(key, "latest/changelog.json");
            return null;
          },
        },
      } as unknown as Env,
      {},
    );
    assert.equal(r2Miss.status, 404);
    assert.equal((await r2Miss.json()).error.code, "artifact_not_found");
  });

  test("serves operational endpoint indexes from R2", async () => {
    const r2KeysRequested: string[] = [];
    const endpointArtifact = {
      schema_version: 1,
      generated_at: "1970-01-01T00:00:00.000Z",
      endpoints: [
        {
          id: "endpoint-r2",
          status: "ok",
          provider: "r2",
        },
      ],
    };
    const response = await handleRequest(
      new Request("https://metagraph.sh/api/v1/endpoints"),
      {
        ASSETS: {
          async fetch() {
            return new Response("not found", { status: 404 });
          },
        },
        METAGRAPH_ARCHIVE: {
          async get(key: string) {
            r2KeysRequested.push(key);
            assert.equal(key, "latest/endpoints.json");
            return {
              async json() {
                return endpointArtifact;
              },
            };
          },
        },
      } as unknown as Env,
      {},
    );

    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.meta.source, "r2");
    assert.deepEqual(r2KeysRequested, ["latest/endpoints.json"]);
    assert.equal(body.data.endpoints[0].id, "endpoint-r2");

    const missing = await handleRequest(
      new Request("https://metagraph.sh/api/v1/endpoints"),
      {
        ASSETS: {
          async fetch() {
            return new Response("not found", { status: 404 });
          },
        },
        METAGRAPH_ARCHIVE: {
          async get(key: string) {
            r2KeysRequested.push(key);
            assert.equal(key, "latest/endpoints.json");
            return null;
          },
        },
      } as unknown as Env,
      {},
    );

    assert.equal(missing.status, 404);
    assert.equal((await missing.json()).error.code, "artifact_not_found");
  });

  test("keeps RPC proxy disabled and blocks unsafe methods", async () => {
    const wrongMethod = await handleRequest(
      new Request("https://metagraph.sh/rpc/v1/finney", { method: "GET" }),
      env as unknown as Env,
      {},
    );
    assert.equal(wrongMethod.status, 405);
    assert.equal(wrongMethod.headers.get("allow"), "POST, OPTIONS");

    const disabled = await handleRequest(
      new Request("https://metagraph.sh/rpc/v1/finney", { method: "POST" }),
      env as unknown as Env,
      {},
    );
    assert.equal(disabled.status, 501);
    assert.equal((await disabled.json()).error.code, "rpc_proxy_disabled");

    const invalid = await handleRequest(
      new Request("https://metagraph.sh/rpc/v1/finney", {
        method: "POST",
        body: "{not json",
      }),
      { ...env, METAGRAPH_ENABLE_RPC_PROXY: "true" } as unknown as Env,
      {},
    );
    assert.equal(invalid.status, 400);

    const invalidRequest = await handleRequest(
      new Request("https://metagraph.sh/rpc/v1/finney", {
        method: "POST",
        body: JSON.stringify([{ method: "chain_getHeader" }]),
      }),
      { ...env, METAGRAPH_ENABLE_RPC_PROXY: "true" } as unknown as Env,
      {},
    );
    assert.equal(invalidRequest.status, 400);
    assert.equal(
      (await invalidRequest.json()).error.code,
      "rpc_invalid_request",
    );

    const blocked = await handleRequest(
      new Request("https://metagraph.sh/rpc/v1/finney", {
        method: "POST",
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "author_submitExtrinsic",
          params: [],
        }),
      }),
      { ...env, METAGRAPH_ENABLE_RPC_PROXY: "true" } as unknown as Env,
      {},
    );
    assert.equal(blocked.status, 403);
    assert.equal((await blocked.json()).error.code, "rpc_method_blocked");

    const tooLargeByHeader = await handleRequest(
      new Request("https://metagraph.sh/rpc/v1/finney", {
        method: "POST",
        headers: { "content-length": "70000" },
        body: "{}",
      }),
      { ...env, METAGRAPH_ENABLE_RPC_PROXY: "true" } as unknown as Env,
      {},
    );
    assert.equal(tooLargeByHeader.status, 413);

    const tooLargeByBody = await handleRequest(
      new Request("https://metagraph.sh/rpc/v1/finney", {
        method: "POST",
        body: JSON.stringify({
          method: "chain_getHeader",
          payload: "x".repeat(70000),
        }),
      }),
      { ...env, METAGRAPH_ENABLE_RPC_PROXY: "true" } as unknown as Env,
      {},
    );
    assert.equal(tooLargeByBody.status, 413);
  });

  test("reports RPC pool artifact and endpoint availability failures", async () => {
    const noPoolArtifact = await handleRequest(
      new Request("https://metagraph.sh/rpc/v1/finney", {
        method: "POST",
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "chain_getHeader",
          params: [],
        }),
      }),
      { METAGRAPH_ENABLE_RPC_PROXY: "true" } as unknown as Env,
      {},
    );
    assert.equal(noPoolArtifact.status, 404);
    assert.equal(
      (await noPoolArtifact.json()).meta.artifact_path,
      "/metagraph/rpc/pools.json",
    );

    const noEligibleEndpoint = await handleRequest(
      new Request("https://metagraph.sh/rpc/v1/finney", {
        method: "POST",
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "chain_getHeader",
          params: [],
        }),
      }),
      {
        METAGRAPH_ENABLE_RPC_PROXY: "true",
        METAGRAPH_ARCHIVE: r2ArchiveFixture({
          "rpc/pools.json": {
            schema_version: 1,
            generated_at: "1970-01-01T00:00:00.000Z",
            pools: [
              {
                id: "finney-rpc",
                endpoints: [{ id: "bad", pool_eligible: false }],
              },
            ],
          },
        }),
      } as unknown as Env,
      {},
    );
    assert.equal(noEligibleEndpoint.status, 503);

    const originalFetch = globalThis.fetch;
    let unsafeFetchCalled = false;
    globalThis.fetch = async () => {
      unsafeFetchCalled = true;
      throw new Error("unsafe endpoint should not be fetched");
    };

    try {
      for (const unsafeUrl of [
        "http://127.0.0.1:9650/internal",
        "http://10.0.0.2:9650/internal",
        "http://169.254.169.254/latest/meta-data",
      ]) {
        const unsafeEndpoint = await handleRequest(
          new Request("https://metagraph.sh/rpc/v1/finney", {
            method: "POST",
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              method: "chain_getHeader",
              params: [],
            }),
          }),
          {
            METAGRAPH_ENABLE_RPC_PROXY: "true",
            METAGRAPH_ARCHIVE: r2ArchiveFixture({
              "rpc/pools.json": {
                schema_version: 1,
                generated_at: "1970-01-01T00:00:00.000Z",
                pools: [
                  {
                    id: "finney-rpc",
                    endpoints: [
                      {
                        id: "unsafe",
                        pool_eligible: true,
                        provider: "fixture",
                        url: unsafeUrl,
                      },
                    ],
                  },
                ],
              },
            }),
          } as unknown as Env,
          {},
        );
        assert.equal(unsafeEndpoint.status, 502);
        assert.equal(
          (await unsafeEndpoint.json()).error.code,
          "rpc_endpoint_unsafe",
        );
      }
      assert.equal(unsafeFetchCalled, false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("rejects unsafe RPC upstreams and falls back to the next trusted endpoint", async () => {
    const originalFetch = globalThis.fetch;
    const fetchedUrls: string[] = [];
    globalThis.fetch = async (url, init) => {
      fetchedUrls.push(String(url));
      assert.equal(init!.method, "POST");
      return new Response(
        JSON.stringify({ jsonrpc: "2.0", id: 1, result: { ok: true } }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    };

    const rpcRequest = () =>
      new Request("https://metagraph.sh/rpc/v1/finney", {
        method: "POST",
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "chain_getHeader",
          params: [],
        }),
      });

    const poolEnv = (endpoints: Row[]) => ({
      METAGRAPH_ENABLE_RPC_PROXY: "true",
      METAGRAPH_ARCHIVE: r2ArchiveFixture({
        "rpc/pools.json": {
          schema_version: 1,
          generated_at: "1970-01-01T00:00:00.000Z",
          pools: [{ id: "finney-rpc", endpoints }],
        },
      }),
    });

    try {
      const unsafeOnlyCases = [
        null,
        "http://bittensor-finney.api.onfinality.io/public",
        "https://localhost/internal",
        "https://metadata.localhost/internal",
        "https://bittensor-finney.api.onfinality.io.evil.example/public",
        "not a url",
      ];

      for (const unsafeUrl of unsafeOnlyCases) {
        const response = await handleRequest(
          rpcRequest(),
          poolEnv([
            {
              id: "unsafe",
              pool_eligible: true,
              provider: "fixture",
              url: unsafeUrl,
            },
          ]) as unknown as Env,
          {},
        );
        assert.equal(response.status, 502);
        assert.equal((await response.json()).error.code, "rpc_endpoint_unsafe");
      }

      const response = await handleRequest(
        rpcRequest(),
        poolEnv([
          {
            id: "unsafe",
            pool_eligible: true,
            provider: "fixture",
            url: "https://localhost/internal",
          },
          {
            id: "safe",
            pool_eligible: true,
            provider: "fixture",
            url: "https://bittensor-finney.api.onfinality.io/public",
          },
        ]) as unknown as Env,
        {},
      );

      assert.equal(response.status, 200);
      assert.deepEqual(fetchedUrls, [
        "https://bittensor-finney.api.onfinality.io/public",
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("proxies explicitly enabled safe RPC methods through eligible pools", async () => {
    const originalFetch = globalThis.fetch;
    let called = false;
    globalThis.fetch = async (_url, init) => {
      called = true;
      assert.equal(init!.method, "POST");
      const method = JSON.parse(init!.body as string).method;
      assert.equal(["chain_getHeader", "system_health"].includes(method), true);
      return new Response(
        JSON.stringify({ jsonrpc: "2.0", id: 1, result: { number: "0x1" } }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    };

    try {
      const rpcPoolArtifact = {
        schema_version: 1,
        contract_version: CONTRACT_VERSION,
        generated_at: "1970-01-01T00:00:00.000Z",
        pools: [
          {
            id: "finney-rpc",
            endpoints: [
              {
                id: "fixture-rpc",
                pool_eligible: true,
                provider: "fixture",
                status: "ok",
                url: "https://bittensor-finney.api.onfinality.io/public",
              },
            ],
          },
          {
            id: "finney-wss",
            endpoints: [
              {
                id: "fixture-wss",
                pool_eligible: true,
                provider: "fixture",
                status: "ok",
                url: "wss://lite.chain.opentensor.ai:443",
              },
            ],
          },
        ],
      };
      const proxyEnv = {
        ...env,
        METAGRAPH_ENABLE_RPC_PROXY: "true",
        ASSETS: {
          async fetch(request: Request) {
            const url = new URL(request.url);
            if (url.pathname === "/metagraph/rpc/pools.json") {
              return Response.json(rpcPoolArtifact);
            }
            return env.ASSETS.fetch(request);
          },
        },
        METAGRAPH_ARCHIVE: {
          async get(key: string) {
            assert.equal(key, "latest/rpc/pools.json");
            return {
              async json() {
                return rpcPoolArtifact;
              },
            };
          },
        },
      };
      const response = await handleRequest(
        new Request("https://metagraph.sh/rpc/v1/finney", {
          method: "POST",
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "chain_getHeader",
            params: [],
          }),
        }),
        proxyEnv as unknown as Env,
        {},
      );
      assert.equal(response.status, 200);
      assert.equal(called, true);
      assert.ok(response.headers.get("x-metagraph-rpc-provider"));
      // The proxy's rate-limit and x-metagraph-rpc-* headers must be CORS-readable.
      assert.equal(
        response.headers.get("access-control-expose-headers"),
        EXPOSED_RESPONSE_HEADERS_VALUE,
      );

      // The /wss route targets WebSocket-only endpoints that cannot be
      // HTTP-POSTed, so it is rejected with a clean 400 rather than proxied.
      const wssResponse = await handleRequest(
        new Request("https://metagraph.sh/rpc/v1/wss", {
          method: "POST",
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 2,
            method: "system_health",
            params: [],
          }),
        }),
        proxyEnv as unknown as Env,
        {},
      );
      assert.equal(wssResponse.status, 400);
      assert.equal(
        (await wssResponse.json()).error.code,
        "rpc_websocket_unsupported",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("applies supported query filters across artifact families", async () => {
    // health/latest.json is no longer generated (live-only health); derive the
    // history date from a stable committed artifact's generated_at instead.
    const subnetsObject = await env.METAGRAPH_ARCHIVE.get(
      "latest/subnets.json",
    );
    const latestHealthHistoryDate = String(
      (await subnetsObject.json()).generated_at,
    ).slice(0, 10);
    const checks: [string, (body: Row) => boolean][] = [
      [
        "https://metagraph.sh/api/v1/subnets?netuid=7",
        (body) => body.data.subnets.every((row: Row) => row.netuid === 7),
      ],
      [
        "https://metagraph.sh/api/v1/surfaces?kind=openapi",
        (body) =>
          body.data.surfaces.every((row: Row) => row.kind === "openapi"),
      ],
      [
        "https://metagraph.sh/api/v1/providers?authority=official",
        (body) =>
          body.data.providers.every((row: Row) => row.authority === "official"),
      ],
      [
        "https://metagraph.sh/api/v1/candidates?state=schema-valid",
        (body) =>
          body.data.candidates.every(
            (row: Row) => row.state === "schema-valid",
          ),
      ],
      [
        "https://metagraph.sh/api/v1/curation?coverage_level=probed",
        (body) =>
          body.data.curation.every(
            (row: Row) => row.coverage_level === "probed",
          ),
      ],
      [
        "https://metagraph.sh/api/v1/gaps?curation_level=adapter-backed",
        (body) =>
          body.data.gaps.every(
            (row: Row) => row.curation_level === "adapter-backed",
          ),
      ],
      [
        "https://metagraph.sh/api/v1/profiles?curation_level=adapter-backed",
        (body) =>
          body.data.profiles.length > 0 &&
          body.data.profiles.every(
            (row: Row) => row.curation_level === "adapter-backed",
          ),
      ],
      [
        "https://metagraph.sh/api/v1/evidence?q=allways",
        (body) => body.data.claims.length > 0,
      ],
      [
        "https://metagraph.sh/api/v1/source-snapshots?q=native",
        (body) => body.data.sources.length > 0,
      ],
      [
        "https://metagraph.sh/api/v1/search?q=allways",
        (body) => body.data.documents.length > 0,
      ],
      [
        "https://metagraph.sh/api/v1/subnets?limit=2&sort=netuid&order=desc",
        (body) =>
          body.data.subnets.length === 2 &&
          body.meta.pagination.returned === 2 &&
          body.meta.pagination.next_cursor === 2 &&
          body.data.subnets[0].netuid > body.data.subnets[1].netuid,
      ],
      [
        "https://metagraph.sh/api/v1/subnets/7/surfaces?kind=subnet-api&limit=3",
        (body) =>
          body.data.surfaces.length <= 3 &&
          body.data.surfaces.every(
            (surface: Row) =>
              surface.netuid === 7 && surface.kind === "subnet-api",
          ),
      ],
      [
        "https://metagraph.sh/api/v1/subnets/7/candidates?limit=2",
        (body) =>
          body.data.candidates.length <= 2 &&
          body.data.candidates.every(
            (candidate: Row) => candidate.netuid === 7,
          ),
      ],
      [
        "https://metagraph.sh/api/v1/review/adapter-candidates?recommended_adapter_kind=generic-openapi-or-custom",
        (body) =>
          body.data.candidates.length > 0 &&
          body.data.candidates.every(
            (candidate: Row) =>
              candidate.recommended_adapter_kind ===
              "generic-openapi-or-custom",
          ),
      ],
      [
        "https://metagraph.sh/api/v1/review/adapter-candidates?operational_kinds=openapi",
        (body) =>
          body.data.candidates.length > 0 &&
          body.data.candidates.every((candidate: Row) =>
            candidate.operational_kinds.includes("openapi"),
          ),
      ],
      [
        "https://metagraph.sh/api/v1/review/adapter-candidates?reason_codes=existing-adapter",
        (body) =>
          body.data.candidates.length > 0 &&
          body.data.candidates.every((candidate: Row) =>
            candidate.reason_codes.includes("existing-adapter"),
          ),
      ],
      [
        "https://metagraph.sh/api/v1/review/profile-completeness?identity_level=partial",
        (body) =>
          body.data.profiles.length > 0 &&
          body.data.profiles.every(
            (profile: Row) => profile.identity_level === "partial",
          ),
      ],
      [
        // identity_promotion is a transient, drainable queue — once every
        // subnet's source-repo identity is curated it is legitimately empty
        // (as the SN20/53/89/95… enrichment did). Assert the filter only ever
        // returns matching profiles, not that any remain.
        "https://metagraph.sh/api/v1/review/profile-completeness?identity_promotion_kinds=source-repo&sort=identity_promotion_kind_count&order=desc",
        (body) =>
          Array.isArray(body.data.profiles) &&
          body.data.profiles.every((profile: Row) =>
            profile.identity_promotion_kinds.includes("source-repo"),
          ),
      ],
      [
        "https://metagraph.sh/api/v1/review/enrichment-queue?identity_level=partial",
        (body) =>
          body.data.queue.length > 0 &&
          body.data.queue.every(
            (entry: Row) => entry.identity_level === "partial",
          ),
      ],
      [
        "https://metagraph.sh/api/v1/review/enrichment-queue?direct_submission_kinds=openapi",
        (body) =>
          body.data.queue.length > 0 &&
          body.data.queue.every((entry: Row) =>
            entry.direct_submission_kinds.includes("openapi"),
          ),
      ],
      [
        "https://metagraph.sh/api/v1/review/enrichment-queue?missing_kinds=source-repo",
        (body) =>
          body.data.queue.length > 0 &&
          body.data.queue.every((entry: Row) =>
            entry.missing_kinds.includes("source-repo"),
          ),
      ],
      // #6240: review-gap-priorities advertised sort=missing_kinds but had no matching filter, unlike the
      // enrichment-queue/enrichment-targets siblings that already narrow on the exact same array field.
      [
        "https://metagraph.sh/api/v1/review/gaps?missing_kinds=openapi",
        (body) =>
          body.data.priorities.length > 0 &&
          body.data.priorities.every((entry: Row) =>
            entry.missing_kinds.includes("openapi"),
          ),
      ],
      [
        "https://metagraph.sh/api/v1/subnets/1/gaps?missing_kinds=sse",
        (body) =>
          body.data.priorities.every((entry: Row) =>
            entry.missing_kinds.includes("sse"),
          ),
      ],
      [
        "https://metagraph.sh/api/v1/review/enrichment-evidence?missing_kinds=openapi",
        (body) =>
          body.data.entries.length > 0 &&
          body.data.entries.every((entry: Row) =>
            entry.missing_kinds.includes("openapi"),
          ),
      ],
      [
        "https://metagraph.sh/api/v1/review/enrichment-targets?target_type=surface-candidate&kind=openapi",
        (body) =>
          body.data.targets.length > 0 &&
          body.data.targets.every(
            (target: Row) =>
              target.target_type === "surface-candidate" &&
              target.kind === "openapi",
          ),
      ],
      [
        "https://metagraph.sh/api/v1/subnets/7/health?status=ok",
        (body) =>
          body.data.surfaces.every(
            (surface: Row) => surface.netuid === 7 && surface.status === "ok",
          ),
      ],
      [
        `https://metagraph.sh/api/v1/health/history/${latestHealthHistoryDate}?limit=2`,
        (body) =>
          body.data.date === latestHealthHistoryDate &&
          body.data.surfaces.length <= 2 &&
          body.meta.pagination.collection === "surfaces",
      ],
      [
        "https://metagraph.sh/api/v1/providers/allways",
        (body) => body.data.provider.id === "allways",
      ],
    ];

    for (const [url, predicate] of checks) {
      const response = await handleRequest(
        new Request(url),
        env as unknown as Env,
        {},
      );
      assert.equal(response.status, 200, url);
      assert.equal(predicate(await response.json()), true, url);
    }
  });

  test("rejects malformed documented query parameters", async () => {
    const routes = [
      "https://metagraph.sh/api/v1/subnets?limit=0",
      "https://metagraph.sh/api/v1/subnets?cursor=-1",
      "https://metagraph.sh/api/v1/subnets?order=sideways",
      "https://metagraph.sh/api/v1/subnets?sort=unknown_field",
      "https://metagraph.sh/api/v1/subnets?fields=netuid,unknown_field",
      "https://metagraph.sh/api/v1/subnets?netuid=not-a-number",
      "https://metagraph.sh/api/v1/subnets?coverage_level=fake",
      "https://metagraph.sh/api/v1/candidates?state=approved",
      "https://metagraph.sh/api/v1/review/adapter-candidates?recommended_adapter_kind=generic",
      "https://metagraph.sh/api/v1/review/profile-completeness?identity_level=unknown",
      "https://metagraph.sh/api/v1/review/enrichment-queue?direct_submission_kinds=seed-node",
      "https://metagraph.sh/api/v1/review/enrichment-queue?identity_level=unknown",
      "https://metagraph.sh/api/v1/review/enrichment-evidence?missing_kinds=seed-node",
      "https://metagraph.sh/api/v1/review/enrichment-targets?target_type=unknown",
      "https://metagraph.sh/api/v1/subnets/7/health?status=alive",
      // #6240: the new missing_kinds filter rejects an off-vocabulary kind through the same enum path
      // its enrichment-queue/enrichment-targets siblings already use -- no new error shape.
      "https://metagraph.sh/api/v1/review/gaps?missing_kinds=seed-node",
    ];

    for (const url of routes) {
      const response = await handleRequest(
        new Request(url),
        env as unknown as Env,
        {},
      );
      assert.equal(response.status, 400, url);
      assert.equal(
        response.headers.get("x-metagraph-error-code"),
        "invalid_query",
      );
      assert.equal((await response.json()).error.code, "invalid_query");
    }
  });

  test("rejects unknown list query parameters before overlay cache reads", async () => {
    const store = new Map();
    const cachePutKeys: string[] = [];
    let r2Gets = 0;
    const originalCaches = globalWithCaches.caches;
    globalWithCaches.caches = {
      default: {
        async match(request: Request) {
          return store.get(request.url)?.clone();
        },
        async put(request: Request, response: Response) {
          cachePutKeys.push(request.url);
          store.set(request.url, response.clone());
        },
      },
    };
    const endpointArtifact = {
      schema_version: 1,
      generated_at: "1970-01-01T00:00:00.000Z",
      endpoints: [
        {
          id: "endpoint-cache",
          kind: "axon",
          netuid: 1,
          provider: "cache-test",
          status: "ok",
          surface_id: "surface-cache",
        },
      ],
    };
    const overlayEnv = {
      ...env,
      METAGRAPH_CONTROL: {
        async get(key: string) {
          if (key === "health:meta") {
            return { last_run_at: "2026-06-18T00:00:00.000Z" };
          }
          if (key === "health:current") {
            return {
              last_run_at: "2026-06-18T00:00:00.000Z",
              surfaces: [],
              subnets: [],
            };
          }
          return null;
        },
      },
      METAGRAPH_ARCHIVE: {
        async get(key: string) {
          r2Gets += 1;
          assert.equal(key, "latest/endpoints.json");
          return {
            async json() {
              return endpointArtifact;
            },
          };
        },
      },
    };
    const ctx = { waitUntil: (promise: Promise<unknown>) => promise };
    try {
      const first = await handleRequest(
        new Request("https://metagraph.sh/api/v1/endpoints?junk=a"),
        overlayEnv as unknown as Env,
        ctx,
      );
      await Promise.resolve();
      const second = await handleRequest(
        new Request("https://metagraph.sh/api/v1/endpoints?junk=b"),
        overlayEnv as unknown as Env,
        ctx,
      );
      assert.equal(first.status, 400);
      assert.equal(second.status, 400);
      assert.equal((await first.json()).meta.parameter, "junk");
      assert.equal((await second.json()).meta.parameter, "junk");
      assert.equal(r2Gets, 0, "invalid list queries do not read R2 overlays");
      assert.equal(store.size, 0, "invalid list queries are not cached");
      assert.deepEqual(cachePutKeys, []);
    } finally {
      globalWithCaches.caches = originalCaches;
    }
  });

  test("edge-caches pure static-artifact GETs but never live-overlay routes", async () => {
    const store = new Map();
    let puts = 0;
    let matchHits = 0;
    const originalCaches = globalWithCaches.caches;
    globalWithCaches.caches = {
      default: {
        async match(request: Request) {
          const cached = store.get(request.url);
          if (cached) matchHits += 1;
          return cached ? cached.clone() : undefined;
        },
        async put(request: Request, response: Response) {
          puts += 1;
          store.set(request.url, response.clone());
        },
      },
    };
    const ctx = { waitUntil: (promise: Promise<unknown>) => promise };
    try {
      // Pure static-artifact route: cached on first GET, served on repeat.
      const first = await handleRequest(
        new Request("https://metagraph.sh/api/v1/schemas"),
        env as unknown as Env,
        ctx,
      );
      await Promise.resolve();
      const firstBody = await first.text();
      const etag = first.headers.get("etag");
      assert.equal(first.status, 200);
      assert.equal(puts, 1, "a pure-artifact 200 GET should be cached");
      assert.equal(matchHits, 0, "first GET is a cache miss");

      const second = await handleRequest(
        new Request("https://metagraph.sh/api/v1/schemas"),
        env as unknown as Env,
        ctx,
      );
      assert.equal(matchHits, 1, "repeat GET is served from the edge cache");
      assert.equal(await second.text(), firstBody);

      // Conditional GET against the cached weak ETag → 304 (no body).
      const conditional = await handleRequest(
        new Request("https://metagraph.sh/api/v1/schemas", {
          headers: { "if-none-match": etag },
        }),
        env as unknown as Env,
        ctx,
      );
      assert.equal(conditional.status, 304);
      assert.equal(await conditional.text(), "");

      // Live-overlay route MUST NOT be cached — live status stays fresh.
      const putsBeforeHealth = puts;
      const health = await handleRequest(
        new Request("https://metagraph.sh/api/v1/health"),
        env as unknown as Env,
        ctx,
      );
      await Promise.resolve();
      assert.equal(health.status, 200);
      assert.equal(
        puts,
        putsBeforeHealth,
        "live-overlay routes (health) must never be edge-cached",
      );

      // Live-overlay fallback routes must also avoid the edge cache when KV/D1
      // live data is cold and the handler serves the static artifact.
      const putsBeforeColdFallback = puts;
      const hitsBeforeColdFallback = matchHits;
      const coldOverlayEnv = {
        ...env,
        METAGRAPH_ARCHIVE: r2ArchiveFixture({
          "rpc-endpoints.json": {
            endpoints: [{ id: "archive-rpc", status: "unknown" }],
            generated_at: "1970-01-01T00:00:00.000Z",
          },
        }),
      };
      const rpcEndpoints = await handleRequest(
        new Request("https://metagraph.sh/api/v1/rpc/endpoints"),
        coldOverlayEnv as unknown as Env,
        ctx,
      );
      await Promise.resolve();
      assert.equal(rpcEndpoints.status, 200);
      assert.equal(
        puts,
        putsBeforeColdFallback,
        "cold live-overlay fallbacks must not be edge-cached",
      );
      assert.equal(
        matchHits,
        hitsBeforeColdFallback,
        "cold live-overlay fallbacks must bypass edge-cache lookup",
      );

      // Non-GET requests are never cached.
      const putsBeforeHead = puts;
      await handleRequest(
        new Request("https://metagraph.sh/api/v1/schemas", { method: "HEAD" }),
        env as unknown as Env,
        ctx,
      );
      await Promise.resolve();
      assert.equal(puts, putsBeforeHead, "non-GET requests must not be cached");
    } finally {
      globalWithCaches.caches = originalCaches;
    }
  });
});

describe("Agent discovery surfaces", () => {
  test("homepage serves HTML with RFC 8288 Link headers (no env needed)", async () => {
    const response = await handleRequest(
      new Request("https://api.metagraph.sh/"),
      {} as unknown as Env,
      {},
    );
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /text\/html/);
    assert.equal(response.headers.get("access-control-allow-origin"), "*");
    const link = response.headers.get("link");
    assert.match(link, /rel="api-catalog"/);
    assert.match(link, /rel="service-desc"/);
    assert.match(link, /rel="service-doc"/);
    assert.match(await response.text(), /metagraphed API/);
  });

  test("homepage HEAD returns the Link header with an empty body", async () => {
    const response = await handleRequest(
      new Request("https://api.metagraph.sh/", { method: "HEAD" }),
      {} as unknown as Env,
      {},
    );
    assert.equal(response.status, 200);
    assert.match(response.headers.get("link"), /rel="api-catalog"/);
    assert.equal(await response.text(), "");
  });

  test("/.well-known/api-catalog is a valid RFC 9727 linkset", async () => {
    const response = await handleRequest(
      new Request("https://api.metagraph.sh/.well-known/api-catalog"),
      {} as unknown as Env,
      {},
    );
    assert.equal(response.status, 200);
    assert.equal(
      response.headers.get("content-type"),
      "application/linkset+json",
    );
    assert.equal(response.headers.get("access-control-allow-origin"), "*");
    const body = await response.json();
    assert.equal(Array.isArray(body.linkset), true);
    const context = body.linkset[0];
    // Anchor + the relations the API-catalog spec requires (service-desc,
    // service-doc); each target carries an absolute href on the request origin.
    assert.equal(context.anchor, "https://api.metagraph.sh/api/v1");
    assert.equal(
      context["service-desc"][0].href,
      "https://api.metagraph.sh/metagraph/openapi.json",
    );
    assert.equal(
      context["service-doc"][0].href,
      "https://api.metagraph.sh/llms.txt",
    );
    assert.ok(
      context["service-doc"].some(
        (entry: Row) =>
          entry.href === "https://api.metagraph.sh/agent-workflows.md",
      ),
    );
    assert.equal(context.status[0].href, "https://api.metagraph.sh/health");
  });

  test("api-catalog hrefs are canonical (api.metagraph.sh), not the request host", async () => {
    // The apex (metagraph.sh) routes /.well-known/* to this worker too, so both
    // the linkset body AND the HTTP Link header must reference the real API host
    // regardless of which host served the request — origin-relative refs would
    // resolve to metagraph.sh (the wrong host).
    const response = await handleRequest(
      new Request("https://metagraph.sh/.well-known/api-catalog"),
      {} as unknown as Env,
      {},
    );
    const body = await response.json();
    assert.equal(body.linkset[0].anchor, "https://api.metagraph.sh/api/v1");
    assert.equal(
      body.linkset[0]["service-desc"][0].href,
      "https://api.metagraph.sh/metagraph/openapi.json",
    );
    const link = response.headers.get("link");
    assert.match(
      link,
      /<https:\/\/api\.metagraph\.sh\/metagraph\/openapi\.json>; rel="service-desc"/,
    );
    // No origin-relative refs that would resolve to the apex host.
    assert.doesNotMatch(link, /<\/[a-z.]/);
  });

  test("serves OpenAI tool specs as a paste-ready function array", async () => {
    const response = await handleRequest(
      new Request(
        "https://api.metagraph.sh/.well-known/agent-tools/openai.json",
      ),
      {} as unknown as Env,
      {},
    );
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "application/json");
    assert.equal(response.headers.get("access-control-allow-origin"), "*");
    const tools = await response.json();
    assert.equal(Array.isArray(tools), true);
    assert.ok(tools.length >= 14);
    for (const tool of tools) {
      assert.equal(tool.type, "function");
      assert.equal(typeof tool.function.name, "string");
      assert.equal(typeof tool.function.description, "string");
      assert.equal(tool.function.parameters.type, "object");
    }
  });

  test("serves Anthropic tool specs with input_schema", async () => {
    const response = await handleRequest(
      new Request(
        "https://api.metagraph.sh/.well-known/agent-tools/anthropic.json",
      ),
      {} as unknown as Env,
      {},
    );
    assert.equal(response.status, 200);
    const tools = await response.json();
    assert.equal(Array.isArray(tools), true);
    for (const tool of tools) {
      assert.equal(typeof tool.name, "string");
      assert.equal(tool.input_schema.type, "object");
      assert.equal("parameters" in tool, false);
    }
  });

  test("agent-tools index points at the MCP executor and is discoverable", async () => {
    const indexResponse = await handleRequest(
      new Request(
        "https://api.metagraph.sh/.well-known/agent-tools/index.json",
      ),
      {} as unknown as Env,
      {},
    );
    assert.equal(indexResponse.status, 200);
    const index = await indexResponse.json();
    assert.equal(index.executor.endpoint, "https://api.metagraph.sh/mcp");
    assert.equal(index.executor.jsonrpc_method, "tools/call");
    assert.equal(
      index.specs.openai,
      "https://api.metagraph.sh/.well-known/agent-tools/openai.json",
    );
    assert.ok(Array.isArray(index.tools) && index.tools.length >= 14);

    // The api-catalog linkset advertises the index under describedby.
    const catalog = await (
      await handleRequest(
        new Request("https://api.metagraph.sh/.well-known/api-catalog"),
        {} as unknown as Env,
        {},
      )
    ).json();
    const describedby = catalog.linkset[0].describedby.map(
      (entry: Row) => entry.href,
    );
    assert.ok(
      describedby.includes(
        "https://api.metagraph.sh/.well-known/agent-tools/index.json",
      ),
    );
  });

  test("agent-tools specs are served on the apex host too", async () => {
    const response = await handleRequest(
      new Request("https://metagraph.sh/.well-known/agent-tools/openai.json"),
      {} as unknown as Env,
      {},
    );
    assert.equal(response.status, 200);
    const tools = await response.json();
    assert.equal(Array.isArray(tools), true);
    assert.ok(tools.length >= 14);
  });

  test("routes /api/v1/icon to the icon proxy (allowlist-gated, no fetch on miss)", async () => {
    let fetched = false;
    const orig = globalThis.fetch;
    globalThis.fetch = async () => {
      fetched = true;
      return new Response("", { status: 200 });
    };
    try {
      // A syntactically valid host that is NOT in the artifact/env allowlist:
      // the proxy fails closed with a 404 and never reaches an upstream fetch.
      const response = await handleRequest(
        new Request(
          "https://api.metagraph.sh/api/v1/icon?host=definitely-not-allowlisted.example",
        ),
        env as unknown as Env,
        {},
      );
      assert.equal(response.status, 404);
      assert.equal(fetched, false);
    } finally {
      globalThis.fetch = orig;
    }
  });
});

// GitHub OAuth (metagraphed#7151): confirms api.ts actually dispatches
// these two GET-only paths to src/github-oauth.ts's handlers -- the
// handlers' own logic (state validation, GitHub token exchange, the
// DATA_API upsert, error branches) is exhaustively covered directly in
// tests/github-oauth.test.ts; this only proves the routing wire-up. The
// shared `env` above has no OAUTH_KV, so both hit that handler's very
// first branch -- enough to prove the route reaches the right function
// without re-testing OAuth logic already covered elsewhere.
describe("GitHub OAuth route dispatch", () => {
  test("GET /authorize reaches handleAuthorizeRequest", async () => {
    const response = await handleRequest(
      new Request("https://api.metagraph.sh/authorize"),
      env as unknown as Env,
      {},
    );
    assert.equal(response.status, 503);
    assert.match(await response.text(), /oauth is not provisioned/);
  });

  test("POST /authorize is not routed (GET-only)", async () => {
    const response = await handleRequest(
      new Request("https://api.metagraph.sh/authorize", { method: "POST" }),
      env as unknown as Env,
      {},
    );
    assert.notEqual(response.status, 503);
  });

  test("GET /oauth/callback/github reaches handleGithubOAuthCallback", async () => {
    const response = await handleRequest(
      new Request("https://api.metagraph.sh/oauth/callback/github"),
      env as unknown as Env,
      {},
    );
    assert.equal(response.status, 503);
    assert.match(await response.text(), /oauth is not provisioned/);
  });
});
