import assert from "node:assert/strict";
import { test } from "vitest";
import {
  EVENT_INSERT_COLUMNS,
  INDEXED_EVENT_KINDS,
  EVENT_RETENTION_MS,
  formatAccountEvent,
  utcDayBounds,
  rollupAccountEventsDaily,
  pruneAccountEvents,
} from "../src/account-events.mjs";

test("EVENT_INSERT_COLUMNS is the stable load contract (#1346)", () => {
  assert.deepEqual(EVENT_INSERT_COLUMNS, [
    "block_number",
    "event_index",
    "event_kind",
    "hotkey",
    "coldkey",
    "netuid",
    "uid",
    "amount_tao",
    "observed_at",
  ]);
});

test("INDEXED_EVENT_KINDS covers the core entity events", () => {
  for (const k of [
    "NeuronRegistered",
    "StakeAdded",
    "StakeRemoved",
    "WeightsSet",
    "AxonServed",
  ]) {
    assert.ok(INDEXED_EVENT_KINDS.includes(k), `missing ${k}`);
  }
});

test("formatAccountEvent maps a D1 row to an API event (ISO time)", () => {
  const out = formatAccountEvent({
    block_number: 1000,
    event_index: 3,
    event_kind: "StakeAdded",
    hotkey: "5Hk",
    coldkey: "5Co",
    netuid: 1,
    uid: null,
    amount_tao: 12.5,
    observed_at: 1750000000000,
  });
  assert.equal(out.event_kind, "StakeAdded");
  assert.equal(out.amount_tao, 12.5);
  assert.equal(out.observed_at, new Date(1750000000000).toISOString());
});

test("formatAccountEvent is null-safe on junk + sparse rows", () => {
  assert.equal(formatAccountEvent(null), null);
  assert.equal(formatAccountEvent("x"), null);
  const out = formatAccountEvent({ block_number: 1 });
  assert.equal(out.hotkey, null);
  assert.equal(out.observed_at, null);
});

test("utcDayBounds returns the UTC day window", () => {
  const b = utcDayBounds(Date.UTC(2026, 5, 21, 14, 30, 0));
  assert.equal(b.date, "2026-06-21");
  assert.equal(b.start, Date.UTC(2026, 5, 21));
  assert.equal(b.end - b.start, 86400000);
});

test("rollupAccountEventsDaily rolls today + yesterday via upsert", async () => {
  const binds = [];
  const env = {
    METAGRAPH_HEALTH_DB: {
      prepare(sql) {
        return {
          bind: (...v) => {
            binds.push(v);
            return { sql, v };
          },
        };
      },
      async batch(stmts) {
        return stmts;
      },
    },
  };
  const r = await rollupAccountEventsDaily(env, {
    now: () => Date.UTC(2026, 5, 21, 12),
  });
  assert.equal(r.rolled, true);
  assert.deepEqual(r.days, ["2026-06-21", "2026-06-20"]);
  assert.equal(binds.length, 2);
});

test("rollupAccountEventsDaily no-ops without D1", async () => {
  assert.equal((await rollupAccountEventsDaily({})).rolled, false);
});

test("pruneAccountEvents deletes below the retention cutoff", async () => {
  let boundCutoff;
  const env = {
    METAGRAPH_HEALTH_DB: {
      prepare() {
        return {
          bind: (c) => {
            boundCutoff = c;
            return { run: async () => ({ meta: { changes: 7 } }) };
          },
        };
      },
    },
  };
  const now = 1_800_000_000_000;
  const r = await pruneAccountEvents(env, { now: () => now });
  assert.equal(r.pruned, true);
  assert.equal(r.changes, 7);
  assert.equal(boundCutoff, now - EVENT_RETENTION_MS);
});

test("pruneAccountEvents no-ops without D1", async () => {
  assert.equal((await pruneAccountEvents({})).pruned, false);
});

test("rollupAccountEventsDaily returns rolled:false when D1 throws", async () => {
  const env = {
    METAGRAPH_HEALTH_DB: {
      prepare() {
        return { bind: () => ({}) };
      },
      async batch() {
        throw new Error("d1 down");
      },
    },
  };
  assert.equal(
    (await rollupAccountEventsDaily(env, { now: () => 0 })).rolled,
    false,
  );
});

test("pruneAccountEvents returns pruned:false when D1 throws", async () => {
  const env = {
    METAGRAPH_HEALTH_DB: {
      prepare() {
        return {
          bind: () => ({
            run: async () => {
              throw new Error("d1 down");
            },
          }),
        };
      },
    },
  };
  assert.equal((await pruneAccountEvents(env, { now: () => 0 })).pruned, false);
});
