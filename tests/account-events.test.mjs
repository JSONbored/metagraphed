import assert from "node:assert/strict";
import { test } from "vitest";
import {
  ACCOUNT_EVENT_COLUMNS,
  EVENT_INSERT_COLUMNS,
  INDEXED_EVENT_KINDS,
  EVENT_RETENTION_MS,
  formatAccountEvent,
  formatRegistration,
  buildAccountSummary,
  buildAccountEvents,
  buildAccountSubnets,
  loadAccountSummary,
  ACCOUNT_ACTIVITY_RECENT_LIMIT,
  eventInsertStatements,
  utcDayBounds,
  rollupAccountEventsDaily,
  pruneAccountEvents,
  validEventRows,
} from "../src/account-events.mjs";

test("validEventRows enforces the strict row shape (#1371)", () => {
  assert.deepEqual(validEventRows("not-an-array"), []);
  assert.deepEqual(validEventRows(null), []);
  const good = {
    block_number: 1,
    event_index: 0,
    event_kind: "StakeAdded",
    observed_at: 5,
  };
  assert.equal(validEventRows([good]).length, 1);
  assert.equal(validEventRows([{ block_number: 1, event_index: 0 }]).length, 0); // no kind/observed_at
  assert.equal(
    validEventRows([{ ...good, event_kind: 7 }]).length,
    0, // event_kind must be a string
  );
  assert.equal(
    validEventRows([{ ...good, observed_at: "x" }]).length,
    0, // observed_at must be an integer
  );
});

test("eventInsertStatements builds chunked parameterized INSERT OR IGNORE", () => {
  const prepared = [];
  const db = {
    prepare(sql) {
      prepared.push(sql);
      return { bind: (...v) => ({ sql, v }) };
    },
  };
  const rows = Array.from({ length: 12 }, (_, i) => ({
    block_number: i,
    event_index: 0,
    event_kind: "X",
    observed_at: 1,
  }));
  const stmts = eventInsertStatements(db, rows);
  assert.equal(stmts.length, 2); // 12 rows / 10 per statement
  assert.ok(prepared[0].startsWith("INSERT OR IGNORE INTO account_events ("));
  assert.ok(prepared[0].includes("VALUES (?"));
});

test("EVENT_INSERT_COLUMNS is the stable load contract (#1346/#1849/#1856)", () => {
  assert.deepEqual(EVENT_INSERT_COLUMNS, [
    "block_number",
    "event_index",
    "event_kind",
    "hotkey",
    "coldkey",
    "netuid",
    "uid",
    "amount_tao",
    "alpha_amount",
    "observed_at",
    "extrinsic_index",
  ]);
  // 11 cols x ROWS_PER_STMT(9) = 99 bound params — under D1's 100 ceiling.
  assert.equal(EVENT_INSERT_COLUMNS.length, 11);
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
    alpha_amount: 9.25,
    observed_at: 1750000000000,
    extrinsic_index: 2,
  });
  assert.equal(out.event_kind, "StakeAdded");
  assert.equal(out.amount_tao, 12.5);
  assert.equal(out.alpha_amount, 9.25);
  assert.equal(out.observed_at, new Date(1750000000000).toISOString());
  assert.equal(out.extrinsic_index, 2);
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

test("rollupAccountEventsDaily returns rolled:false when prepare throws", async () => {
  const env = {
    METAGRAPH_HEALTH_DB: {
      prepare() {
        throw new Error("prepare exploded");
      },
    },
  };
  assert.equal(
    (await rollupAccountEventsDaily(env, { now: () => 0 })).rolled,
    false,
  );
});

test("ACCOUNT_EVENT_COLUMNS lists the served event columns", () => {
  for (const c of [
    "block_number",
    "event_kind",
    "hotkey",
    "coldkey",
    "amount_tao",
  ]) {
    assert.ok(ACCOUNT_EVENT_COLUMNS.includes(c), `missing ${c}`);
  }
});

test("formatRegistration coerces flags + is null-safe (#1347)", () => {
  const r = formatRegistration({
    netuid: 7,
    uid: 3,
    stake_tao: 100,
    validator_permit: 1,
    active: 0,
  });
  assert.equal(r.netuid, 7);
  assert.equal(r.validator_permit, true);
  assert.equal(r.active, false);
  assert.equal(formatRegistration(null), null);
});

test("buildAccountSummary joins aggregates + registrations (#1347)", () => {
  const out = buildAccountSummary("5Hk", {
    agg: { c: 5, sc: 2, fb: 1, lb: 9, fo: 1750000000000, lo: 1750009000000 },
    kinds: [{ kind: "StakeAdded", count: 5 }, { kind: null }],
    registrations: [
      { netuid: 7, uid: 1, stake_tao: 10, validator_permit: 1, active: 1 },
    ],
    recent: [
      { block_number: 9, event_kind: "StakeAdded", observed_at: 1750009000000 },
    ],
  });
  assert.equal(out.ss58, "5Hk");
  assert.equal(out.event_count, 5);
  assert.equal(out.subnet_count, 2);
  assert.equal(out.first_seen_at, new Date(1750000000000).toISOString());
  assert.equal(out.event_kinds.length, 1); // the {kind:null} row is dropped
  assert.equal(out.registrations[0].validator_permit, true);
  assert.equal(out.recent_events[0].event_kind, "StakeAdded");
});

test("buildAccountSummary is schema-stable with no data", () => {
  const out = buildAccountSummary("5Hk");
  assert.equal(out.event_count, 0);
  assert.equal(out.subnet_count, 0);
  assert.deepEqual(out.registrations, []);
  assert.deepEqual(out.event_kinds, []);
  assert.equal(out.first_seen_at, null);
  // Activity sub-object (#1847) is always present + schema-stable.
  assert.equal(out.activity.tx_count, 0);
  assert.equal(out.activity.last_tx_block, null);
  assert.equal(out.activity.last_tx_at, null);
  assert.equal(out.activity.total_fee_tao, null);
  assert.deepEqual(out.activity.modules_called, []);
});

test("buildAccountSummary threads the signing activity sub-object (#1847)", () => {
  const out = buildAccountSummary("5Hk", {
    activity: {
      tx_count: 4,
      last_tx_block: 200,
      last_tx_at: 1750009000000,
      total_fee_tao: 0.02,
    },
    modules: [
      { call_module: "SubtensorModule", count: 3 },
      { call_module: null, count: 1 },
    ],
  });
  assert.equal(out.activity.tx_count, 4);
  assert.equal(out.activity.last_tx_block, 200);
  assert.equal(out.activity.last_tx_at, new Date(1750009000000).toISOString());
  assert.equal(out.activity.total_fee_tao, 0.02);
  // the {call_module:null} row is dropped
  assert.equal(out.activity.modules_called.length, 1);
  assert.equal(out.activity.modules_called[0].call_module, "SubtensorModule");
});

test("formatRegistration defaults every sparse field to null/false (null-safe)", () => {
  // A registration row with NONE of the optional fields must still produce a
  // fully-shaped object (nulls + coerced false), never undefined — the
  // cold/partial-neurons-row contract the account routes depend on.
  const out = formatRegistration({});
  assert.equal(out.netuid, null);
  assert.equal(out.uid, null);
  assert.equal(out.stake_tao, null);
  assert.equal(out.validator_permit, false);
  assert.equal(out.active, false);
});

test("buildAccountSummary defaults a missing event-kind count to 0", () => {
  // A kinds row with a kind but no count must surface count:0, not undefined,
  // so an agent always gets a numeric tally.
  const out = buildAccountSummary("5Hk", {
    kinds: [{ kind: "StakeAdded" }],
  });
  assert.deepEqual(out.event_kinds, [{ kind: "StakeAdded", count: 0 }]);
});

test("buildAccountEvents defaults rows/limit/offset when called bare", () => {
  // No rows array + no options object → an empty, schema-stable feed with
  // null pagination markers (exercises the rows||[] and ?? null defaults).
  const out = buildAccountEvents(undefined, "5Hk");
  assert.equal(out.event_count, 0);
  assert.deepEqual(out.events, []);
  assert.equal(out.limit, null);
  assert.equal(out.offset, null);
});

test("buildAccountEvents + buildAccountSubnets shape their artifacts", () => {
  const ev = buildAccountEvents(
    [{ block_number: 2, event_kind: "WeightsSet", observed_at: 1750000000000 }],
    "5Hk",
    { limit: 100, offset: 0 },
  );
  assert.equal(ev.event_count, 1);
  assert.equal(ev.limit, 100);
  assert.equal(ev.events[0].event_kind, "WeightsSet");

  const sn = buildAccountSubnets(
    [{ netuid: 7, uid: 1, stake_tao: 10, validator_permit: 0, active: 1 }],
    "5Hk",
  );
  assert.equal(sn.subnet_count, 1);
  assert.equal(sn.subnets[0].netuid, 7);
  assert.deepEqual(buildAccountSubnets(null, "5Hk").subnets, []);
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

test("loadAccountSummary bounds signing activity before aggregating", async () => {
  const calls = [];
  const rows = [
    [{ c: 0, sc: 0, fb: null, lb: null, fo: null, lo: null }],
    [],
    [],
    [],
    [
      {
        tx_count: 0,
        last_tx_block: null,
        last_tx_at: null,
        total_fee_tao: null,
      },
    ],
    [],
  ];
  await loadAccountSummary(async (sql, params) => {
    calls.push({ sql, params });
    return rows[calls.length - 1] || [];
  }, "5Hk");

  const activity = calls.find((c) => /AS tx_count/.test(c.sql));
  const modules = calls.find((c) => /GROUP BY call_module/.test(c.sql));
  assert.ok(
    /FROM \(SELECT block_number, observed_at, fee_tao FROM extrinsics/.test(
      activity.sql,
    ),
  );
  assert.ok(
    /ORDER BY block_number DESC, extrinsic_index DESC LIMIT \?\)/.test(
      activity.sql,
    ),
  );
  assert.deepEqual(activity.params, ["5Hk", ACCOUNT_ACTIVITY_RECENT_LIMIT]);
  assert.ok(/FROM \(SELECT call_module FROM extrinsics/.test(modules.sql));
  assert.ok(/LIMIT \?\) GROUP BY call_module/.test(modules.sql));
  assert.deepEqual(modules.params, ["5Hk", ACCOUNT_ACTIVITY_RECENT_LIMIT]);
});
