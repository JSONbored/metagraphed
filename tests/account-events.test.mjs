import assert from "node:assert/strict";
import { test } from "vitest";
import {
  ACCOUNT_EVENT_COLUMNS,
  EVENT_INSERT_COLUMNS,
  INDEXED_EVENT_KINDS,
  EVENT_RETENTION_MS,
  formatAccountEvent,
  formatAccountDay,
  formatRegistration,
  buildAccountSummary,
  buildAccountEvents,
  buildAccountSubnets,
  loadAccountSummary,
  loadAccountEvents,
  loadAccountHistory,
  loadAccountSubnets,
  ACCOUNT_ACTIVITY_RECENT_LIMIT,
  eventInsertStatements,
  utcDayBounds,
  rollupAccountEventsDaily,
  pruneAccountEvents,
  validEventRows,
  buildAccountTransfers,
} from "../src/account-events.mjs";
import { encodeCursor } from "../src/cursor.mjs";

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
  // negative PK components — aligned with validBlockRows / validExtrinsicRows
  assert.equal(validEventRows([{ ...good, block_number: -1 }]).length, 0);
  assert.equal(validEventRows([{ ...good, event_index: -1 }]).length, 0);
  assert.equal(
    validEventRows([{ ...good, event_kind: "" }]).length,
    0, // event_kind must be non-empty (mirrors block_hash guard)
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

test("account builders null invalid block heights and indices", () => {
  const event = formatAccountEvent({
    block_number: -1,
    event_index: -2,
    extrinsic_index: -3,
    event_kind: "StakeAdded",
    observed_at: 1,
  });
  assert.equal(event.block_number, null);
  assert.equal(event.event_index, null);
  assert.equal(event.extrinsic_index, null);

  const summary = buildAccountSummary("5Hk", {
    agg: { fb: -5, lb: "nope" },
    activity: { last_tx_block: -99 },
  });
  assert.equal(summary.first_block, null);
  assert.equal(summary.last_block, null);
  assert.equal(summary.activity.last_tx_block, null);

  const day = formatAccountDay({
    day: "2026-01-01",
    first_block: -1,
    last_block: 100,
  });
  assert.equal(day.first_block, null);
  assert.equal(day.last_block, 100);

  const transfers = buildAccountTransfers(
    [
      {
        block_number: -5,
        event_index: -1,
        hotkey: "5A",
        coldkey: "5B",
        amount_tao: 1,
        observed_at: null,
      },
      {
        block_number: Infinity,
        event_index: NaN,
        hotkey: "5A",
        coldkey: "5B",
        amount_tao: 2,
        observed_at: null,
      },
      {
        block_number: 10,
        event_index: 2,
        hotkey: "5A",
        coldkey: "5B",
        amount_tao: 3,
        observed_at: null,
      },
    ],
    "5A",
  );
  assert.equal(transfers.transfers[0].block_number, null);
  assert.equal(transfers.transfers[0].event_index, null);
  assert.equal(transfers.transfers[1].block_number, null);
  assert.equal(transfers.transfers[1].event_index, null);
  assert.equal(transfers.transfers[2].block_number, 10);
  assert.equal(transfers.transfers[2].event_index, 2);
  assert.equal(transfers.transfers[2].amount_tao, 3);
  assert.equal(transfers.transfers[2].direction, "sent");

  // Null input preserves null (the value == null branch in toBlockNumber).
  const nullTransfers = buildAccountTransfers(
    [{ block_number: null, event_index: null, hotkey: "5A", coldkey: "5B" }],
    "5A",
  );
  assert.equal(nullTransfers.transfers[0].block_number, null);
  assert.equal(nullTransfers.transfers[0].event_index, null);
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

// ---- Async loader failure-path coverage ------------------------------------
// The shared loaders take a (sql, params) => Promise<rows[]> runner. The real
// d1All swallows a D1 timeout/schema-drift to [] (workers analytics), so from a
// loader's view a cold store, a timed-out read, and an empty subnet all arrive
// as []. These assert the loaders stay schema-stable on that empty path and that
// pagination (offset vs keyset cursor, clamping) is wired correctly.

// A d1 runner that returns [] for every query — the shape d1All hands back on a
// cold/unbound DB OR a swallowed D1 timeout/schema-drift error.
const emptyD1 = async () => [];

test("loadAccountEvents is schema-stable when the D1 read yields nothing", async () => {
  const out = await loadAccountEvents(emptyD1, "5Hk", { limit: 50, offset: 0 });
  assert.equal(out.schema_version, 1);
  assert.equal(out.ss58, "5Hk");
  assert.equal(out.event_count, 0);
  assert.deepEqual(out.events, []);
  assert.equal(out.limit, 50); // clamped value still echoed
  assert.equal(out.offset, 0);
  assert.equal(out.next_cursor, null); // no full page → no next cursor
});

test("loadAccountEvents propagates a rejecting D1 runner (no silent swallow)", async () => {
  // If the injected runner rejects (e.g. a non-swallowed downstream failure),
  // the loader must not mask it as an empty feed — the caller decides.
  await assert.rejects(
    loadAccountEvents(async () => {
      throw new Error("d1 timeout");
    }, "5Hk"),
    /d1 timeout/,
  );
});

test("loadAccountEvents clamps limit/offset and matches both account keys", async () => {
  let captured;
  await loadAccountEvents(
    async (sql, params) => {
      captured = { sql, params };
      return [];
    },
    "5Hk",
    { limit: 9999, offset: -5 }, // over max / below min
  );
  // limit clamps to the 1000 ceiling, offset clamps up to the 0 floor.
  assert.ok(captured.sql.includes("LIMIT ?"));
  assert.ok(captured.sql.includes("OFFSET ?"));
  assert.deepEqual(captured.params, ["5Hk", "5Hk", 1000, 0]);
});

test("loadAccountEvents applies the ?kind filter as a bound param", async () => {
  let captured;
  await loadAccountEvents(
    async (sql, params) => {
      captured = { sql, params };
      return [];
    },
    "5Hk",
    { kind: "StakeAdded" },
  );
  assert.ok(/AND event_kind = \?/.test(captured.sql));
  // [ss58, ss58, kind, limit(default 100), offset(default 0)]
  assert.deepEqual(captured.params, ["5Hk", "5Hk", "StakeAdded", 100, 0]);
});

test("loadAccountEvents emits a next_cursor only on a full page", async () => {
  // A full page (rows.length === limit) → keyset cursor off the last row.
  const full = await loadAccountEvents(
    async () => [
      { block_number: 9, event_index: 2, event_kind: "WeightsSet" },
      { block_number: 8, event_index: 0, event_kind: "StakeAdded" },
    ],
    "5Hk",
    { limit: 2 },
  );
  assert.equal(full.event_count, 2);
  assert.equal(full.next_cursor, encodeCursor([8, 0]));

  // A partial page (fewer than limit) → end-of-window, no cursor.
  const partial = await loadAccountEvents(
    async () => [{ block_number: 9, event_index: 2, event_kind: "WeightsSet" }],
    "5Hk",
    { limit: 2 },
  );
  assert.equal(partial.next_cursor, null);
});

test("loadAccountEvents uses a keyset seek (not OFFSET) when a cursor is given", async () => {
  let captured;
  await loadAccountEvents(
    async (sql, params) => {
      captured = { sql, params };
      return [];
    },
    "5Hk",
    { cursor: encodeCursor([1000, 3]), limit: 50 },
  );
  assert.ok(/\(block_number, event_index\) < \(\?, \?\)/.test(captured.sql));
  assert.ok(!/OFFSET/.test(captured.sql)); // cursor overrides offset
  // [ss58, ss58, curBlock, curIndex, limit]
  assert.deepEqual(captured.params, ["5Hk", "5Hk", 1000, 3, 50]);
});

test("loadAccountEvents ignores a malformed cursor and falls back to OFFSET", async () => {
  let captured;
  await loadAccountEvents(
    async (sql, params) => {
      captured = { sql, params };
      return [];
    },
    "5Hk",
    { cursor: "not-a-cursor", offset: 20 },
  );
  assert.ok(/OFFSET \?/.test(captured.sql));
  assert.ok(!/\(block_number, event_index\) </.test(captured.sql));
  assert.deepEqual(captured.params, ["5Hk", "5Hk", 100, 20]);
});

test("loadAccountHistory is schema-stable when the D1 read yields nothing", async () => {
  const out = await loadAccountHistory(emptyD1, "5Hk", {
    limit: 25,
    offset: 0,
  });
  assert.equal(out.schema_version, 1);
  assert.equal(out.ss58, "5Hk");
  assert.equal(out.day_count, 0);
  assert.deepEqual(out.days, []);
  assert.equal(out.limit, 25);
  assert.equal(out.offset, 0);
});

test("loadAccountHistory propagates a rejecting D1 runner", async () => {
  await assert.rejects(
    loadAccountHistory(async () => {
      throw new Error("d1 down");
    }, "5Hk"),
    /d1 down/,
  );
});

test("loadAccountHistory binds netuid/from/to filters and clamps pagination", async () => {
  let captured;
  await loadAccountHistory(
    async (sql, params) => {
      captured = { sql, params };
      return [];
    },
    "5Hk",
    { netuid: 7, from: "2026-06-01", to: "2026-06-30", limit: 0, offset: 5 },
  );
  assert.ok(/AND netuid = \?/.test(captured.sql));
  assert.ok(/AND day >= \?/.test(captured.sql));
  assert.ok(/AND day <= \?/.test(captured.sql));
  assert.ok(/ORDER BY day DESC LIMIT \? OFFSET \?/.test(captured.sql));
  // limit 0 is below the floor → clamps to 1; offset 5 passes through.
  assert.deepEqual(captured.params, [
    "5Hk",
    7,
    "2026-06-01",
    "2026-06-30",
    1,
    5,
  ]);
});

test("loadAccountHistory ignores a non-integer netuid filter", async () => {
  let captured;
  await loadAccountHistory(
    async (sql, params) => {
      captured = { sql, params };
      return [];
    },
    "5Hk",
    { netuid: 7.5 },
  );
  assert.ok(!/AND netuid = \?/.test(captured.sql));
  assert.deepEqual(captured.params, ["5Hk", 100, 0]);
});

test("loadAccountHistory maps sparse rollup rows null-safely", async () => {
  const out = await loadAccountHistory(
    async () => [
      { day: "2026-06-24" }, // every other column absent
      { day: "2026-06-23", netuid: 1, event_count: 4, event_kinds: "" },
    ],
    "5Hk",
  );
  assert.equal(out.day_count, 2);
  assert.equal(out.days[0].netuid, null);
  assert.equal(out.days[0].event_count, null);
  assert.deepEqual(out.days[0].event_kinds, []); // missing CSV → []
  assert.deepEqual(out.days[1].event_kinds, []); // empty CSV → []
});

test("loadAccountSubnets is schema-stable when the D1 read yields nothing", async () => {
  const out = await loadAccountSubnets(emptyD1, "5Hk");
  assert.equal(out.schema_version, 1);
  assert.equal(out.ss58, "5Hk");
  assert.equal(out.subnet_count, 0);
  assert.deepEqual(out.subnets, []);
});

test("loadAccountSubnets propagates a rejecting D1 runner", async () => {
  await assert.rejects(
    loadAccountSubnets(async () => {
      throw new Error("d1 timeout");
    }, "5Hk"),
    /d1 timeout/,
  );
});

test("loadAccountSubnets reads neurons by hotkey ordered by netuid", async () => {
  let captured;
  await loadAccountSubnets(async (sql, params) => {
    captured = { sql, params };
    return [];
  }, "5Hk");
  assert.ok(/FROM neurons WHERE hotkey = \?/.test(captured.sql));
  assert.ok(/ORDER BY netuid/.test(captured.sql));
  assert.deepEqual(captured.params, ["5Hk"]);
});

test("loadAccountSubnets maps sparse registration rows null-safely", async () => {
  const out = await loadAccountSubnets(
    async () => [{ netuid: 7 }], // uid/stake/permit/active absent
    "5Hk",
  );
  assert.equal(out.subnet_count, 1);
  assert.equal(out.subnets[0].netuid, 7);
  assert.equal(out.subnets[0].uid, null);
  assert.equal(out.subnets[0].stake_tao, null);
  assert.equal(out.subnets[0].validator_permit, false);
  assert.equal(out.subnets[0].active, false);
});

test("loadAccountSummary is schema-stable when every parallel read times out to []", async () => {
  // Mirrors d1All swallowing a timeout/cold store to [] for all six reads.
  const out = await loadAccountSummary(emptyD1, "5Hk");
  assert.equal(out.event_count, 0);
  assert.equal(out.subnet_count, 0);
  assert.deepEqual(out.registrations, []);
  assert.deepEqual(out.recent_events, []);
  assert.equal(out.activity.tx_count, 0);
});

test("loadAccountSummary propagates when any parallel D1 read rejects", async () => {
  // Promise.all rejects fast if any one of the six reads throws — the loader
  // must not swallow that into a falsely-empty summary.
  let n = 0;
  await assert.rejects(
    loadAccountSummary(async () => {
      n += 1;
      if (n === 3) throw new Error("d1 read 3 failed");
      return [];
    }, "5Hk"),
    /d1 read 3 failed/,
  );
});
