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

function dataApi(handler) {
  return { fetch: handler };
}

function req() {
  return new Request("https://api.metagraph.sh/api/v1/blocks");
}

test("tryPostgresTier: flag not set to 'postgres' returns null without touching DATA_API or bumping the fallback generation", async () => {
  const before = currentPostgresTierFallbackGeneration();
  let called = false;
  const env = {
    METAGRAPH_BLOCKS_SOURCE: "d1",
    DATA_API: dataApi(async () => {
      called = true;
      return Response.json({});
    }),
  };
  const result = await tryPostgresTier(env, req(), "METAGRAPH_BLOCKS_SOURCE");
  assert.equal(result, null);
  assert.equal(called, false);
  assert.equal(currentPostgresTierFallbackGeneration(), before);
});

test("tryPostgresTier: no DATA_API binding falls back and bumps the fallback generation", async () => {
  const before = currentPostgresTierFallbackGeneration();
  const env = { METAGRAPH_BLOCKS_SOURCE: "postgres" };
  const result = await tryPostgresTier(env, req(), "METAGRAPH_BLOCKS_SOURCE");
  assert.equal(result, null);
  assert.equal(currentPostgresTierFallbackGeneration(), before + 1);
});

test("tryPostgresTier: DATA_API.fetch throwing falls back and bumps the fallback generation", async () => {
  const before = currentPostgresTierFallbackGeneration();
  const env = {
    METAGRAPH_BLOCKS_SOURCE: "postgres",
    DATA_API: dataApi(async () => {
      throw new Error("network down");
    }),
  };
  const result = await tryPostgresTier(env, req(), "METAGRAPH_BLOCKS_SOURCE");
  assert.equal(result, null);
  assert.equal(currentPostgresTierFallbackGeneration(), before + 1);
});

test("tryPostgresTier: a non-2xx DATA_API response falls back and bumps the fallback generation", async () => {
  const before = currentPostgresTierFallbackGeneration();
  const env = {
    METAGRAPH_BLOCKS_SOURCE: "postgres",
    DATA_API: dataApi(async () => new Response(null, { status: 502 })),
  };
  const result = await tryPostgresTier(env, req(), "METAGRAPH_BLOCKS_SOURCE");
  assert.equal(result, null);
  assert.equal(currentPostgresTierFallbackGeneration(), before + 1);
});

test("tryPostgresTier: an unparseable response body falls back and bumps the fallback generation", async () => {
  const before = currentPostgresTierFallbackGeneration();
  const env = {
    METAGRAPH_BLOCKS_SOURCE: "postgres",
    DATA_API: dataApi(
      async () =>
        new Response("not json", {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    ),
  };
  const result = await tryPostgresTier(env, req(), "METAGRAPH_BLOCKS_SOURCE");
  assert.equal(result, null);
  assert.equal(currentPostgresTierFallbackGeneration(), before + 1);
});

test("tryPostgresTier: a JSON body that isn't an object (a bare string) falls back and bumps the fallback generation", async () => {
  const before = currentPostgresTierFallbackGeneration();
  const env = {
    METAGRAPH_BLOCKS_SOURCE: "postgres",
    DATA_API: dataApi(async () => Response.json("unexpected")),
  };
  const result = await tryPostgresTier(env, req(), "METAGRAPH_BLOCKS_SOURCE");
  assert.equal(result, null);
  assert.equal(currentPostgresTierFallbackGeneration(), before + 1);
});

test("tryPostgresTier: a successful JSON object response is returned as-is without bumping the fallback generation", async () => {
  const before = currentPostgresTierFallbackGeneration();
  const env = {
    METAGRAPH_BLOCKS_SOURCE: "postgres",
    DATA_API: dataApi(async () =>
      Response.json({ schema_version: 1, block_count: 5 }),
    ),
  };
  const result = await tryPostgresTier(env, req(), "METAGRAPH_BLOCKS_SOURCE");
  assert.deepEqual(result, { schema_version: 1, block_count: 5 });
  assert.equal(currentPostgresTierFallbackGeneration(), before);
});

test("tryPostgresTier: rewrites a HEAD request to GET before forwarding to DATA_API", async () => {
  let receivedMethod;
  const env = {
    METAGRAPH_BLOCKS_SOURCE: "postgres",
    DATA_API: dataApi(async (request) => {
      receivedMethod = request.method;
      return Response.json({ ok: true });
    }),
  };
  await tryPostgresTier(
    env,
    new Request("https://api.metagraph.sh/api/v1/blocks", { method: "HEAD" }),
    "METAGRAPH_BLOCKS_SOURCE",
  );
  assert.equal(receivedMethod, "GET");
});
