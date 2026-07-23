import assert from "node:assert/strict";
import { test } from "vitest";
import { CHAIN_EVENTS_DB_TTL_MS, readChainEventsDb } from "../workers/api.mjs";

// readChainEventsDb reads the chain-events heartbeat from the Postgres
// chain_events tier via the DATA_API service binding (#5357) — the D1
// `account_events` table it used to query was fully dropped by #4772.

function mkDataApiEnv(
  row: {
    block_number: number | null;
    observed_at: number | null | undefined;
  } = {
    block_number: 100,
    observed_at: 1_700_000_000_000,
  },
) {
  let queries = 0;
  return {
    get queries() {
      return queries;
    },
    DATA_API: {
      async fetch() {
        queries += 1;
        return new Response(
          JSON.stringify({
            count: row ? 1 : 0,
            events: row ? [row] : [],
          }),
          { status: 200 },
        );
      },
    },
  };
}

test("readChainEventsDb memoizes within the TTL — one DATA_API fetch for repeated calls", async () => {
  const env = mkDataApiEnv();
  const t0 = 5_000_000;
  const a = await readChainEventsDb(env, t0);
  const b = await readChainEventsDb(env, t0 + 1000);
  assert.deepEqual(a, b);
  assert.equal(
    env.queries,
    1,
    "a second call within the TTL must be served from the in-isolate memo",
  );

  await readChainEventsDb(env, t0 + CHAIN_EVENTS_DB_TTL_MS + 1);
  assert.equal(
    env.queries,
    2,
    "an expired memo triggers a fresh DATA_API fetch",
  );
});

test("readChainEventsDb never cross-reads a different env (isolation safety)", async () => {
  const envA = mkDataApiEnv({ block_number: 10, observed_at: 1_000 });
  const envB = mkDataApiEnv({ block_number: 20, observed_at: 2_000 });
  const t0 = 6_000_000;
  const a = await readChainEventsDb(envA, t0);
  const b = await readChainEventsDb(envB, t0);
  assert.equal(a?.block, 10);
  assert.equal(b?.block, 20);
  assert.equal(envA.queries, 1);
  assert.equal(envB.queries, 1);
});

test("readChainEventsDb returns null when the DATA_API binding is absent", async () => {
  const result = await readChainEventsDb({}, 7_000_000);
  assert.equal(result, null);
});

test("readChainEventsDb does not cache a null result (no sticky cold miss)", async () => {
  let queries = 0;
  const env = {
    DATA_API: {
      async fetch() {
        queries += 1;
        return new Response(JSON.stringify({ count: 0, events: [] }), {
          status: 200,
        });
      },
    },
  };
  const t0 = 8_000_000;
  await readChainEventsDb(env, t0);
  await readChainEventsDb(env, t0 + 1000);
  assert.equal(queries, 2, "a null result must not be memoized");
});

test("readChainEventsDb returns null (not cached) when DATA_API responds non-2xx", async () => {
  let queries = 0;
  const env = {
    DATA_API: {
      async fetch() {
        queries += 1;
        return new Response("upstream error", { status: 500 });
      },
    },
  };
  const t0 = 9_000_000;
  const a = await readChainEventsDb(env, t0);
  const b = await readChainEventsDb(env, t0 + 1000);
  assert.equal(a, null);
  assert.equal(b, null);
  assert.equal(queries, 2, "a non-2xx response must not be memoized");
});

test("readChainEventsDb returns null (not cached) when DATA_API.fetch throws", async () => {
  let queries = 0;
  const env = {
    DATA_API: {
      async fetch() {
        queries += 1;
        throw new Error("network error");
      },
    },
  };
  const t0 = 10_000_000;
  const a = await readChainEventsDb(env, t0);
  const b = await readChainEventsDb(env, t0 + 1000);
  assert.equal(a, null);
  assert.equal(b, null);
  assert.equal(queries, 2, "a thrown fetch error must not be memoized");
});

test("readChainEventsDb returns null when the response body's events isn't an array", async () => {
  const env = {
    DATA_API: {
      async fetch() {
        return new Response(JSON.stringify({ count: 0, events: null }), {
          status: 200,
        });
      },
    },
  };
  const result = await readChainEventsDb(env, 11_500_000);
  assert.equal(result, null);
});

test("readChainEventsDb defaults block/observed_at to null when the row omits them", async () => {
  const env = mkDataApiEnv({ block_number: null, observed_at: undefined });
  const result = await readChainEventsDb(env, 11_750_000);
  assert.deepEqual(result, { block: null, at: null });
});

test("readChainEventsDb returns null when DATA_API responds with invalid JSON", async () => {
  let queries = 0;
  const env = {
    DATA_API: {
      async fetch() {
        queries += 1;
        return new Response("not json", { status: 200 });
      },
    },
  };
  const t0 = 11_000_000;
  const result = await readChainEventsDb(env, t0);
  assert.equal(result, null);
  assert.equal(queries, 1);
});
