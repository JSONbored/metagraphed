import assert from "node:assert/strict";
import { test, vi } from "vitest";
import { pgMockEnv } from "./helpers/pg-mock.ts";

// The store is Postgres now (#10179), reached through `new Client(...)` inside
// src/read-store.ts, which readChainEventsDb -> readChainDetailHead reaches via
// readStore(env, ...). A caller cannot inject into that, so the module is the
// seam; see tests/helpers/pg-mock.ts for why it is a module mock and why the
// controller has to be built inside vi.hoisted.
const { pg } = await vi.hoisted(async () => ({
  pg: (await import("./helpers/pg-mock.ts")).createPgMock(),
}));
vi.mock("pg", () => pg.module);

import { CHAIN_EVENTS_DB_TTL_MS, readChainEventsDb } from "../workers/api.ts";

// readChainEventsDb reads the chain-event index heartbeat from
// `chain_detail_blocks` (#8700). It went through the DATA_API binding to a
// Postgres tier until that store was destroyed (#9186/#9193) -- after which
// /health published `chain_events: {null, null, null}` forever, verified live.
// The live-follow lane's own table is the right source rather than merely a
// working one: this field is the LIVE-FOLLOW streamer's heartbeat, and that
// lane is what fills the table.

/**
 * Arm the pg double to answer the heartbeat aggregate, and clear the query log
 * so `pg.control.queries.length` counts only the reads this test provoked.
 *
 * The count is the whole subject of most of these tests -- "the memo served it"
 * is exactly "the store was not asked a second time" -- so it is read from the
 * double's own log rather than from a per-env counter. There is one double per
 * FILE, not per env, so every arming resets the log.
 *
 * `throws` is re-armed from inside `onQuery` (which fires before the double
 * consults `failNext`) rather than set once, because `failNext` is consumed by
 * the query it fails and these tests need EVERY read to throw.
 */
function serve(
  row: { head: number | null; latest: number | null | undefined } | null,
  behaviour: "ok" | "throw" = "ok",
) {
  pg.control.queries.length = 0;
  pg.control.rows = row ? [row] : [];
  pg.control.failNext = null;
  pg.control.onQuery =
    behaviour === "throw"
      ? () => {
          pg.control.failNext = new Error("store unavailable");
        }
      : null;
}

/** A fresh env each time: the memo is keyed by env IDENTITY, so two tests
 * sharing one object would share its memo. */
function pgEnv() {
  return pgMockEnv(["chain_detail_blocks"]) as unknown as Env;
}

test("readChainEventsDb memoizes within the TTL — one store read for repeated calls", async () => {
  serve({ head: 100, latest: 1_700_000_000_000 });
  const env = pgEnv();
  const t0 = 5_000_000;
  const a = await readChainEventsDb(env, t0);
  const b = await readChainEventsDb(env, t0 + 1000);
  assert.deepEqual(a, b);
  assert.equal(
    pg.control.queries.length,
    1,
    "a second call within the TTL must be served from the in-isolate memo",
  );

  await readChainEventsDb(env, t0 + CHAIN_EVENTS_DB_TTL_MS + 1);
  assert.equal(
    pg.control.queries.length,
    2,
    "an expired memo triggers a fresh store read",
  );
});

test("readChainEventsDb never cross-reads a different env (isolation safety)", async () => {
  const envA = pgEnv();
  const envB = pgEnv();
  const t0 = 6_000_000;
  serve({ head: 10, latest: 1_000 });
  const a = await readChainEventsDb(envA, t0);
  assert.equal(pg.control.queries.length, 1);
  // Same instant, so envA's memo is still live -- envB must miss it anyway and
  // go to the store, which is now answering a DIFFERENT head.
  serve({ head: 20, latest: 2_000 });
  const b = await readChainEventsDb(envB, t0);
  assert.equal(a?.block, 10);
  assert.equal(b?.block, 20);
  assert.equal(pg.control.queries.length, 1);
});

test("readChainEventsDb returns null when no store is bound", async () => {
  const result = await readChainEventsDb({} as unknown as Env, 7_000_000);
  assert.equal(result, null);
});

test("readChainEventsDb does not cache a null result (no sticky cold miss)", async () => {
  // An empty lane is the pre-first-block state, and the chain never stops
  // producing -- memoizing it would hide the lane coming back.
  serve({ head: null, latest: null });
  const env = pgEnv();
  const t0 = 8_000_000;
  await readChainEventsDb(env, t0);
  await readChainEventsDb(env, t0 + 1000);
  assert.equal(
    pg.control.queries.length,
    2,
    "a null result must not be memoized",
  );
});

test("readChainEventsDb returns null (not cached) when the store read throws", async () => {
  serve(null, "throw");
  const env = pgEnv();
  const t0 = 9_000_000;
  const a = await readChainEventsDb(env, t0);
  const b = await readChainEventsDb(env, t0 + 1000);
  assert.equal(a, null);
  assert.equal(b, null);
  assert.equal(
    pg.control.queries.length,
    2,
    "a thrown read must not be memoized",
  );
});

test("readChainEventsDb returns null when the aggregate row is missing", async () => {
  serve(null);
  assert.equal(await readChainEventsDb(pgEnv(), 10_000_000), null);
});

// Number("") is 0 and Number(null) is 0, which would publish an age of 56
// years rather than "no heartbeat" -- the guard this pins.
test("readChainEventsDb treats a blank or zero timestamp as absent", async () => {
  for (const latest of [null, undefined, 0, ""] as unknown[]) {
    serve({ head: 100, latest: latest as number | null });
    assert.equal(
      await readChainEventsDb(pgEnv(), 11_000_000),
      null,
      `latest=${JSON.stringify(latest)}`,
    );
  }
});

test("readChainEventsDb reports the head block alongside the timestamp", async () => {
  serve({ head: 8_771_082, latest: 1_785_708_540_000 });
  assert.deepEqual(await readChainEventsDb(pgEnv(), 12_000_000), {
    block: 8_771_082,
    at: 1_785_708_540_000,
  });
});
