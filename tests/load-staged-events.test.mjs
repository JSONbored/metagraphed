import assert from "node:assert/strict";
import { test } from "vitest";
import { handleScheduled, loadStagedEvents } from "../workers/api.mjs";
import { EVENTS_LOAD_CRON } from "../workers/config.mjs";

function eventRow(block_number, event_index) {
  return {
    block_number,
    event_index,
    event_kind: "StakeAdded",
    hotkey: `5Hk${event_index}`,
    coldkey: `5Co${event_index}`,
    netuid: 1,
    uid: null,
    amount_tao: 12.5,
    observed_at: 1750000000000,
  };
}

function mockEnv({
  rows,
  bad = false,
  getCalls = [],
  deleted = [],
  prepared = [],
  batches = [],
}) {
  return {
    env: {
      METAGRAPH_ARCHIVE: {
        async get(key) {
          getCalls.push(key);
          if (rows == null) return null;
          return {
            async json() {
              if (bad) throw new Error("bad json");
              return rows;
            },
          };
        },
        async delete(key) {
          deleted.push(key);
        },
      },
      METAGRAPH_HEALTH_DB: {
        prepare(sql) {
          prepared.push(sql);
          return { bind: (...v) => ({ sql, v }) };
        },
        async batch(stmts) {
          batches.push(stmts.length);
        },
      },
    },
    getCalls,
    deleted,
    prepared,
    batches,
  };
}

test("loadStagedEvents loads JSON via parameterized batches + deletes it (#1346)", async () => {
  const rows = Array.from({ length: 12 }, (_, i) => eventRow(1000 + i, i));
  const m = mockEnv({ rows });
  const r = await loadStagedEvents(m.env);
  assert.equal(r.ok, true);
  assert.equal(r.rows, 12);
  assert.deepEqual(m.getCalls, ["events/account-events-pending.json"]);
  // 12 rows / 10 per statement = 2 statements, one batch (<=50).
  assert.deepEqual(m.batches, [2]);
  // Idempotent + parameterized: INSERT OR IGNORE keyed (block,index), values bound.
  assert.ok(m.prepared[0].startsWith("INSERT OR IGNORE INTO account_events ("));
  assert.ok(m.prepared[0].includes("VALUES (?"));
  assert.ok(
    !m.prepared.some((s) => s.includes("5Hk")),
    "row values must never appear in the SQL text",
  );
  assert.deepEqual(m.deleted, ["events/account-events-pending.json"]);
});

test("loadStagedEvents no-ops when nothing is staged", async () => {
  const m = mockEnv({ rows: null });
  const r = await loadStagedEvents(m.env);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "none");
  assert.equal(m.batches.length, 0);
  assert.equal(m.deleted.length, 0);
});

test("loadStagedEvents deletes + bails on unparseable JSON", async () => {
  const m = mockEnv({ rows: [], bad: true });
  const r = await loadStagedEvents(m.env);
  assert.equal(r.reason, "parse_failed");
  assert.deepEqual(m.deleted, ["events/account-events-pending.json"]);
});

test("loadStagedEvents drops rows lacking the (block, index) key", async () => {
  const m = mockEnv({ rows: [{ event_kind: "X" }] }); // no block_number/event_index
  const r = await loadStagedEvents(m.env);
  assert.equal(r.reason, "empty");
  assert.equal(m.batches.length, 0);
  assert.deepEqual(m.deleted, ["events/account-events-pending.json"]);
});

test("loadStagedEvents drops rows missing required insert fields", async () => {
  const valid = eventRow(1000, 0);
  const m = mockEnv({
    rows: [
      { ...valid, observed_at: null },
      { ...valid, event_index: 1, event_kind: null },
      { ...valid, event_index: 2 },
    ],
  });
  const r = await loadStagedEvents(m.env);
  assert.equal(r.ok, true);
  assert.equal(r.rows, 1);
  assert.deepEqual(m.batches, [1]);
  assert.deepEqual(m.deleted, ["events/account-events-pending.json"]);
});

test("loadStagedEvents is a safe no-op without bindings", async () => {
  const r = await loadStagedEvents({});
  assert.equal(r.ok, false);
  assert.equal(r.reason, "unavailable");
});

test("handleScheduled fast-load cron drains staged batches + skips the probe (#1346 Option A)", async () => {
  const drained = [];
  const env = {
    METAGRAPH_ARCHIVE: {
      async get(key) {
        // Only the events batch is staged; the neuron key returns nothing.
        return key === "events/account-events-pending.json"
          ? {
              async json() {
                return [
                  {
                    block_number: 1,
                    event_index: 0,
                    event_kind: "StakeAdded",
                    observed_at: 1,
                  },
                ];
              },
            }
          : null;
      },
      async delete(key) {
        drained.push(key);
      },
    },
    METAGRAPH_HEALTH_DB: {
      prepare() {
        return { bind: () => ({}) };
      },
      async batch() {},
    },
  };
  const r = await handleScheduled({ cron: EVENTS_LOAD_CRON }, env, {});
  // Early-returns the fast-load marker (i.e. never falls through to the prober).
  assert.deepEqual(r, { ok: true, fast_load: true });
  assert.ok(
    drained.includes("events/account-events-pending.json"),
    "the staged event batch was loaded + deleted",
  );
});
