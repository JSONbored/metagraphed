import assert from "node:assert/strict";
import { test } from "vitest";
import { CHAIN_EVENTS_DB_TTL_MS, readChainEventsDb } from "../workers/api.ts";

// readChainEventsDb reads the chain-event index heartbeat from D1's
// `chain_detail_blocks` (#8700). It went through the DATA_API binding to a
// Postgres tier until that store was destroyed (#9186/#9193) -- after which
// /health published `chain_events: {null, null, null}` forever, verified live.
// D1 is the right source rather than merely a working one: this field is the
// LIVE-FOLLOW streamer's heartbeat, and that lane is what fills the table.

/** A D1 stub over the two aggregates the heartbeat reads. */
function mkD1Env(
  row: { head: number | null; latest: number | null | undefined } | null = {
    head: 100,
    latest: 1_700_000_000_000,
  },
  behaviour: "ok" | "throw" = "ok",
) {
  let queries = 0;
  return {
    get queries() {
      return queries;
    },
    METAGRAPH_HEALTH_DB: {
      prepare() {
        return {
          async first() {
            queries += 1;
            if (behaviour === "throw") throw new Error("d1 unavailable");
            return row;
          },
        };
      },
    },
  } as unknown as Env & { readonly queries: number };
}

test("readChainEventsDb memoizes within the TTL — one D1 read for repeated calls", async () => {
  const env = mkD1Env();
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
  assert.equal(env.queries, 2, "an expired memo triggers a fresh D1 read");
});

test("readChainEventsDb never cross-reads a different env (isolation safety)", async () => {
  const envA = mkD1Env({ head: 10, latest: 1_000 });
  const envB = mkD1Env({ head: 20, latest: 2_000 });
  const t0 = 6_000_000;
  const a = await readChainEventsDb(envA, t0);
  const b = await readChainEventsDb(envB, t0);
  assert.equal(a?.block, 10);
  assert.equal(b?.block, 20);
  assert.equal(envA.queries, 1);
  assert.equal(envB.queries, 1);
});

test("readChainEventsDb returns null when the D1 binding is absent", async () => {
  const result = await readChainEventsDb({} as unknown as Env, 7_000_000);
  assert.equal(result, null);
});

test("readChainEventsDb does not cache a null result (no sticky cold miss)", async () => {
  // An empty lane is the pre-first-block state, and the chain never stops
  // producing -- memoizing it would hide the lane coming back.
  const env = mkD1Env({ head: null, latest: null });
  const t0 = 8_000_000;
  await readChainEventsDb(env, t0);
  await readChainEventsDb(env, t0 + 1000);
  assert.equal(env.queries, 2, "a null result must not be memoized");
});

test("readChainEventsDb returns null (not cached) when the D1 read throws", async () => {
  const env = mkD1Env(null, "throw");
  const t0 = 9_000_000;
  const a = await readChainEventsDb(env, t0);
  const b = await readChainEventsDb(env, t0 + 1000);
  assert.equal(a, null);
  assert.equal(b, null);
  assert.equal(env.queries, 2, "a thrown read must not be memoized");
});

test("readChainEventsDb returns null when the aggregate row is missing", async () => {
  assert.equal(await readChainEventsDb(mkD1Env(null), 10_000_000), null);
});

// Number("") is 0 and Number(null) is 0, which would publish an age of 56
// years rather than "no heartbeat" -- the guard this pins.
test("readChainEventsDb treats a blank or zero timestamp as absent", async () => {
  for (const latest of [null, undefined, 0, ""] as unknown[]) {
    const env = mkD1Env({ head: 100, latest: latest as number | null });
    assert.equal(
      await readChainEventsDb(env, 11_000_000),
      null,
      `latest=${JSON.stringify(latest)}`,
    );
  }
});

test("readChainEventsDb reports the head block alongside the timestamp", async () => {
  const env = mkD1Env({ head: 8_771_082, latest: 1_785_708_540_000 });
  assert.deepEqual(await readChainEventsDb(env, 12_000_000), {
    block: 8_771_082,
    at: 1_785_708_540_000,
  });
});
