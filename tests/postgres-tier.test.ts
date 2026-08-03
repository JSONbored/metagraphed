// Direct unit tests for workers/postgres-tier.ts's tryPostgresTier -- every
// caller across workers/request-handlers/*.mjs shares this one function, so
// its fallback branches (each of which now also bumps
// currentPostgresTierFallbackGeneration() to invalidate an in-flight
// withEdgeCache write, #5090) are tested directly here rather than only
// incidentally through individual handler tests.
import assert from "node:assert/strict";
import { test } from "vitest";
import {
  currentPostgresTierFallbackGeneration,
  tryPostgresTier,
} from "../workers/postgres-tier.ts";
import { mockEnv, type AnyFn } from "./row-type.ts";

function dataApi(handler: AnyFn) {
  return { fetch: handler };
}

function req() {
  return new Request("https://api.metagraph.sh/api/v1/blocks");
}

test("tryPostgresTier: flag not set to 'postgres' returns null without touching DATA_API or bumping the fallback generation", async () => {
  const before = currentPostgresTierFallbackGeneration();
  let called = false;
  const env = mockEnv({
    METAGRAPH_BLOCKS_SOURCE: "d1",
    DATA_API: dataApi(async () => {
      called = true;
      return Response.json({});
    }),
  });
  const result = await tryPostgresTier(env, req(), "METAGRAPH_BLOCKS_SOURCE");
  assert.equal(result, null);
  assert.equal(called, false);
  assert.equal(currentPostgresTierFallbackGeneration(), before);
});

test("tryPostgresTier: a DATA_API-D1 flag set to 'd1' FORWARDS to DATA_API", async () => {
  // The neurons dispatcher lives in DATA_API ahead of its Hyperdrive gate, so
  // "d1" on this flag must still forward -- short-circuiting here would make
  // the fully-seeded D1 tables unreachable and serve empties.
  let called = false;
  const env = mockEnv({
    METAGRAPH_NEURONS_SOURCE: "d1",
    DATA_API: dataApi(async () => {
      called = true;
      return Response.json({ data: { neurons: [1] } });
    }),
  });
  const result = await tryPostgresTier(env, req(), "METAGRAPH_NEURONS_SOURCE");
  assert.equal(called, true);
  assert.deepEqual(result, { data: { neurons: [1] } });
});

test("tryPostgresTier: the hyperparams and account-identity flags set to 'd1' FORWARD to DATA_API", async () => {
  // Their dispatchers (matchHyperparamsIdentityD1Route) live in DATA_API
  // ahead of its Hyperdrive gate, same as the neurons one -- and the
  // cold-tier fallback depends on the forward too: DATA_API 503s while its
  // table is empty, which is what sends the serving handler on to the
  // lakehouse cold-tier reader instead of a schema-stable mask.
  for (const flagName of [
    "METAGRAPH_SUBNET_HYPERPARAMS_SOURCE",
    "METAGRAPH_ACCOUNT_IDENTITY_SOURCE",
  ] as const) {
    let called = false;
    const env = mockEnv({
      [flagName]: "d1",
      DATA_API: dataApi(async () => {
        called = true;
        return Response.json({ data: { ok: true } });
      }),
    });
    const result = await tryPostgresTier(env, req(), flagName);
    assert.equal(called, true, `${flagName} must forward on "d1"`);
    assert.deepEqual(result, { data: { ok: true } });
  }
});

test("tryPostgresTier: a non-2xx from a forwarded 'd1' flag degrades to null (the cold-tier handoff)", async () => {
  // The D1 dispatcher answers 503 while its table is pre-first-sync empty;
  // the null return is what lets the serving handler fall through to the
  // lakehouse cold-tier snapshot.
  const env = mockEnv({
    METAGRAPH_SUBNET_HYPERPARAMS_SOURCE: "d1",
    DATA_API: dataApi(
      async () =>
        new Response(JSON.stringify({ error: "d1 tier cold" }), {
          status: 503,
        }),
    ),
  });
  const result = await tryPostgresTier(
    env,
    req(),
    "METAGRAPH_SUBNET_HYPERPARAMS_SOURCE",
  );
  assert.equal(result, null);
});

test("tryPostgresTier: 'd1' on a NON-DATA-API-D1 flag still short-circuits", async () => {
  // Health and subnet-snapshot D1 loaders live in THIS worker; forwarding
  // their "d1" to DATA_API would hit Postgres-only legs there. The allowlist
  // is per-flag on purpose.
  let called = false;
  const env = mockEnv({
    METAGRAPH_HEALTH_SOURCE: "d1",
    DATA_API: dataApi(async () => {
      called = true;
      return Response.json({});
    }),
  });
  const result = await tryPostgresTier(env, req(), "METAGRAPH_HEALTH_SOURCE");
  assert.equal(result, null);
  assert.equal(called, false);
});

test("tryPostgresTier: 'retired' on the neurons flag short-circuits too", async () => {
  let called = false;
  const env = mockEnv({
    METAGRAPH_NEURONS_SOURCE: "retired",
    DATA_API: dataApi(async () => {
      called = true;
      return Response.json({});
    }),
  });
  assert.equal(
    await tryPostgresTier(env, req(), "METAGRAPH_NEURONS_SOURCE"),
    null,
  );
  assert.equal(called, false);
});

test("tryPostgresTier: no DATA_API binding falls back and bumps the fallback generation", async () => {
  const before = currentPostgresTierFallbackGeneration();
  const env = mockEnv({ METAGRAPH_BLOCKS_SOURCE: "postgres" });
  const result = await tryPostgresTier(env, req(), "METAGRAPH_BLOCKS_SOURCE");
  assert.equal(result, null);
  assert.equal(currentPostgresTierFallbackGeneration(), before + 1);
});

test("tryPostgresTier: DATA_API.fetch throwing falls back and bumps the fallback generation", async () => {
  const before = currentPostgresTierFallbackGeneration();
  const env = mockEnv({
    METAGRAPH_BLOCKS_SOURCE: "postgres",
    DATA_API: dataApi(async () => {
      throw new Error("network down");
    }),
  });
  const result = await tryPostgresTier(env, req(), "METAGRAPH_BLOCKS_SOURCE");
  assert.equal(result, null);
  assert.equal(currentPostgresTierFallbackGeneration(), before + 1);
});

test("tryPostgresTier: a non-2xx DATA_API response falls back and bumps the fallback generation", async () => {
  const before = currentPostgresTierFallbackGeneration();
  const env = mockEnv({
    METAGRAPH_BLOCKS_SOURCE: "postgres",
    DATA_API: dataApi(async () => new Response(null, { status: 502 })),
  });
  const result = await tryPostgresTier(env, req(), "METAGRAPH_BLOCKS_SOURCE");
  assert.equal(result, null);
  assert.equal(currentPostgresTierFallbackGeneration(), before + 1);
});

test("tryPostgresTier: an unparseable response body falls back and bumps the fallback generation", async () => {
  const before = currentPostgresTierFallbackGeneration();
  const env = mockEnv({
    METAGRAPH_BLOCKS_SOURCE: "postgres",
    DATA_API: dataApi(
      async () =>
        new Response("not json", {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    ),
  });
  const result = await tryPostgresTier(env, req(), "METAGRAPH_BLOCKS_SOURCE");
  assert.equal(result, null);
  assert.equal(currentPostgresTierFallbackGeneration(), before + 1);
});

test("tryPostgresTier: a JSON body that isn't an object (a bare string) falls back and bumps the fallback generation", async () => {
  const before = currentPostgresTierFallbackGeneration();
  const env = mockEnv({
    METAGRAPH_BLOCKS_SOURCE: "postgres",
    DATA_API: dataApi(async () => Response.json("unexpected")),
  });
  const result = await tryPostgresTier(env, req(), "METAGRAPH_BLOCKS_SOURCE");
  assert.equal(result, null);
  assert.equal(currentPostgresTierFallbackGeneration(), before + 1);
});

test("tryPostgresTier: a successful JSON object response is returned as-is without bumping the fallback generation", async () => {
  const before = currentPostgresTierFallbackGeneration();
  const env = mockEnv({
    METAGRAPH_BLOCKS_SOURCE: "postgres",
    DATA_API: dataApi(async () =>
      Response.json({ schema_version: 1, block_count: 5 }),
    ),
  });
  const result = await tryPostgresTier(env, req(), "METAGRAPH_BLOCKS_SOURCE");
  assert.deepEqual(result, { schema_version: 1, block_count: 5 });
  assert.equal(currentPostgresTierFallbackGeneration(), before);
});

test("tryPostgresTier: rewrites a HEAD request to GET before forwarding to DATA_API", async () => {
  let receivedMethod: string | undefined;
  const env = mockEnv({
    METAGRAPH_BLOCKS_SOURCE: "postgres",
    DATA_API: dataApi(async (request: Request) => {
      receivedMethod = request.method;
      return Response.json({ ok: true });
    }),
  });
  await tryPostgresTier(
    env,
    new Request("https://api.metagraph.sh/api/v1/blocks", { method: "HEAD" }),
    "METAGRAPH_BLOCKS_SOURCE",
  );
  assert.equal(receivedMethod, "GET");
});
