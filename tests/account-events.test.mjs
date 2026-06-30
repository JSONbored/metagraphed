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
  loadAccountExtrinsics,
  loadAccountSubnets,
  ACCOUNT_ACTIVITY_RECENT_LIMIT,
  eventInsertStatements,
  utcDayBounds,
  rollupAccountEventsDaily,
  pruneAccountEvents,
  validEventRows,
  buildAccountTransfers,
  loadAccountTransfers,
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

test("formatRegistration coerces D1 numeric-string cells to schema types", () => {
  const out = formatRegistration({
    netuid: "7",
    uid: "3",
    stake_tao: "100.5",
    validator_permit: 1,
    active: 1,
  });
  assert.equal(typeof out.netuid, "number");
  assert.equal(typeof out.uid, "number");
  assert.equal(typeof out.stake_tao, "number");
  assert.equal(out.netuid, 7);
  assert.equal(out.uid, 3);
  assert.equal(out.stake_tao, 100.5);
});

test("formatRegistration drops invalid netuid and uid cells instead of leaking strings", () => {
  const out = formatRegistration({
    netuid: "not-a-netuid",
    uid: "-1",
    stake_tao: null,
    validator_permit: 0,
    active: 0,
  });
  assert.equal(out.netuid, null);
  assert.equal(out.uid, null);
});

test("buildAccountSummary and buildAccountSubnets keep coerced registration types", () => {
  const row = {
    netuid: "14",
    uid: "2",
    stake_tao: "12.25",
    validator_permit: 1,
    active: 1,
  };
  const summary = buildAccountSummary("5Hk", { registrations: [row] });
  const subnets = buildAccountSubnets([row], "5Hk");
  for (const reg of [summary.registrations[0], subnets.subnets[0]]) {
    assert.equal(typeof reg.netuid, "number");
    assert.equal(typeof reg.uid, "number");
    assert.equal(typeof reg.stake_tao, "number");
    assert.equal(reg.netuid, 14);
    assert.equal(reg.uid, 2);
    assert.equal(reg.stake_tao, 12.25);
  }
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

test("buildAccountSummary rounds activity.total_fee_tao to rao precision (#2351)", () => {
  // A D1 SUM(fee_tao) over many REAL cells accumulates float noise; the activity
  // shaper must round it to 9 dp (rao) like toTao does for /chain/signers +
  // /chain/fees, instead of leaking the long fractional tail.
  const noisy = 0.1 + 0.2; // 0.30000000000000004
  const out = buildAccountSummary("5Hk", {
    activity: { tx_count: 2, total_fee_tao: noisy },
  });
  assert.equal(out.activity.total_fee_tao, 0.3);

  // A sub-rao tail is rounded away, not preserved verbatim.
  const out2 = buildAccountSummary("5Hk", {
    activity: { tx_count: 1, total_fee_tao: 0.0123456789012 },
  });
  assert.equal(out2.activity.total_fee_tao, 0.012345679);

  // Absent aggregate stays null (cold store), never coerced to 0.
  const cold = buildAccountSummary("5Hk", {
    activity: { tx_count: 0, total_fee_tao: null },
  });
  assert.equal(cold.activity.total_fee_tao, null);

  // A non-finite aggregate (e.g. a non-numeric cell) is nulled, not NaN.
  const bad = buildAccountSummary("5Hk", {
    activity: { tx_count: 1, total_fee_tao: "not-a-number" },
  });
  assert.equal(bad.activity.total_fee_tao, null);
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

  // Null block_number and event_index are preserved as null in the output.
  const nullTransfers = buildAccountTransfers(
    [{ block_number: null, event_index: null, hotkey: "5A", coldkey: "5B" }],
    "5A",
  );
  assert.equal(nullTransfers.transfers[0].block_number, null);
  assert.equal(nullTransfers.transfers[0].event_index, null);

  // Fractional values are non-integer and therefore treated as malformed (null).
  const fracTransfers = buildAccountTransfers(
    [{ block_number: 3.7, event_index: 1.9, hotkey: "5A", coldkey: "5B" }],
    "5A",
  );
  assert.equal(fracTransfers.transfers[0].block_number, null);
  assert.equal(fracTransfers.transfers[0].event_index, null);
});

test("buildAccountTransfers labels a self-transfer by the requested side (#2362)", () => {
  // A self-transfer (from === to === ss58, i.e. hotkey === coldkey === ss58) is
  // returned by BOTH the sent-side and received-side queries. Without the
  // requested direction the hotkey-first per-row derivation always labels it
  // "sent" — so a ?direction=received page would contain a row whose direction
  // contradicts the filter. The requested side must win.
  const selfRow = {
    block_number: 5,
    event_index: 0,
    hotkey: "5SELF",
    coldkey: "5SELF",
    amount_tao: 1,
    observed_at: null,
  };

  // received-side query → labeled "received" (was "sent" before the fix).
  const received = buildAccountTransfers([selfRow], "5SELF", {
    direction: "received",
  });
  assert.equal(received.transfers[0].direction, "received");

  // sent-side query → labeled "sent".
  const sent = buildAccountTransfers([selfRow], "5SELF", { direction: "sent" });
  assert.equal(sent.transfers[0].direction, "sent");

  // No side filter (both/all/omitted) keeps the per-row hotkey-first derivation.
  const both = buildAccountTransfers([selfRow], "5SELF");
  assert.equal(both.transfers[0].direction, "sent");
  // Only the exact strings "sent"/"received" force a label; every other value
  // ("all", "both", junk) falls back to the per-row hotkey-first derivation.
  for (const value of ["all", "both", "BOTH", "", "weird"]) {
    const out = buildAccountTransfers([selfRow], "5SELF", { direction: value });
    assert.equal(out.transfers[0].direction, "sent");
  }
});

test("buildAccountTransfers explicit side never flips a normal row (#2362)", () => {
  // For a non-self transfer the requested side already matches the per-row
  // derivation, so forcing the label is a no-op — the fix only changes the
  // self-transfer edge, never a genuine counterparty row.
  const out = buildAccountTransfers(
    [
      {
        block_number: 9,
        event_index: 1,
        hotkey: "5SENDER",
        coldkey: "5ME",
        amount_tao: 2,
        observed_at: null,
      },
    ],
    "5ME",
    { direction: "received" },
  );
  assert.equal(out.transfers[0].direction, "received");
  assert.equal(out.transfers[0].from, "5SENDER");
  assert.equal(out.transfers[0].to, "5ME");
});

test("loadAccountTransfers threads the requested direction into the label (#2362)", async () => {
  // End-to-end through the shared MCP/REST loader: the received-side query yields
  // the self-transfer row, and the loader must hand the requested direction to
  // buildAccountTransfers so the row is labeled "received", not "sent".
  const selfRow = {
    block_number: 5,
    event_index: 0,
    hotkey: "5SELF",
    coldkey: "5SELF",
    amount_tao: 1,
    observed_at: null,
  };
  const d1 = async (sql) =>
    /coldkey = \?/.test(sql) && !/hotkey <>/.test(sql) ? [selfRow] : [];
  const out = await loadAccountTransfers(d1, "5SELF", {
    direction: "received",
  });
  assert.equal(out.transfers.length, 1);
  assert.equal(out.transfers[0].direction, "received");
});

test("loadAccountTransfers applies the block_start/block_end range to both sides", async () => {
  let captured;
  await loadAccountTransfers(
    async (sql, params) => {
      captured = { sql, params };
      return [];
    },
    "5Hk",
    { blockStart: 100, blockEnd: 900 },
  );
  assert.equal((captured.sql.match(/block_number >= \?/g) || []).length, 2);
  assert.equal((captured.sql.match(/block_number <= \?/g) || []).length, 2);
  assert.deepEqual(captured.params, [
    "5Hk",
    100,
    900,
    "5Hk",
    "5Hk",
    100,
    900,
    100,
    0,
  ]);
});

test("loadAccountExtrinsics applies the block_start/block_end range as bound params", async () => {
  let captured;
  await loadAccountExtrinsics(
    async (sql, params) => {
      captured = { sql, params };
      return [];
    },
    "5Hk",
    { blockStart: 100, blockEnd: 900 },
  );
  assert.ok(/AND block_number >= \?/.test(captured.sql));
  assert.ok(/AND block_number <= \?/.test(captured.sql));
  assert.deepEqual(captured.params, ["5Hk", 100, 900, 100, 0]);
});

test("loadAccountExtrinsics emits next_cursor for a full page", async () => {
  const out = await loadAccountExtrinsics(
    async () => [
      {
        block_number: 150,
        extrinsic_index: 4,
        extrinsic_hash: `0x${"a".repeat(64)}`,
        observed_at: 1,
      },
    ],
    "5Hk",
    { limit: 1 },
  );
  assert.equal(out.next_cursor, encodeCursor([150, 4]));
});

test("loadAccountExtrinsics uses cursor keyset pagination over offset", async () => {
  let captured;
  const out = await loadAccountExtrinsics(
    async (sql, params) => {
      captured = { sql, params };
      return [
        {
          block_number: 150,
          extrinsic_index: 4,
          extrinsic_hash: `0x${"a".repeat(64)}`,
          observed_at: 1,
        },
      ];
    },
    "5Hk",
    {
      blockStart: 100,
      blockEnd: 900,
      cursor: encodeCursor([200, 2]),
      limit: 1,
      offset: 99,
    },
  );
  assert.ok(
    /\(block_number, extrinsic_index\) < \(\?, \?\)/.test(captured.sql),
  );
  assert.ok(!/OFFSET/.test(captured.sql));
  assert.deepEqual(captured.params, ["5Hk", 100, 900, 200, 2, 1]);
  assert.equal(out.next_cursor, encodeCursor([150, 4]));
});

test("loadAccountExtrinsics ignores malformed cursors and falls back to offset", async () => {
  let captured;
  await loadAccountExtrinsics(
    async (sql, params) => {
      captured = { sql, params };
      return [];
    },
    "5Hk",
    { cursor: "not-a-cursor", limit: 7, offset: 5 },
  );
  assert.ok(/OFFSET \?/.test(captured.sql));
  assert.ok(!/\(block_number, extrinsic_index\) </.test(captured.sql));
  assert.deepEqual(captured.params, ["5Hk", 7, 5]);
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

test("loadAccountSummary tie-breaks leaderboard aggregates for stable output", async () => {
  const calls = [];
  await loadAccountSummary(async (sql) => {
    calls.push({ sql });
    return [];
  }, "5Hk");

  const kinds = calls.find((c) => /GROUP BY event_kind/.test(c.sql));
  const modules = calls.find((c) => /GROUP BY call_module/.test(c.sql));
  // `count DESC` alone is not a total order. Without a stable secondary key the
  // per-kind ordering — and, for the trailing LIMIT 10, the membership of the
  // top call modules — would vary with D1/SQLite group order on tied counts.
  assert.ok(
    /GROUP BY event_kind ORDER BY count DESC, event_kind ASC/.test(kinds.sql),
  );
  assert.ok(
    /GROUP BY call_module ORDER BY count DESC, call_module ASC LIMIT 10/.test(
      modules.sql,
    ),
  );
});

test("loadAccountSummary uses indexed union seeks for account_events (#2059)", async () => {
  const calls = [];
  await loadAccountSummary(async (sql, params) => {
    calls.push({ sql, params });
    return [];
  }, "5Hk");

  const eventReads = calls.filter((c) =>
    /idx_account_events_hotkey/.test(c.sql),
  );
  assert.equal(eventReads.length, 3);
  for (const { sql } of eventReads) {
    assert.doesNotMatch(sql, /hotkey = \? OR coldkey = \?/);
    assert.match(sql, /INDEXED BY idx_account_events_hotkey/);
    assert.match(sql, /INDEXED BY idx_account_events_coldkey/);
    assert.match(sql, /UNION ALL/);
    assert.match(sql, /hotkey IS NULL OR hotkey <> \?/);
  }
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
  assert.deepEqual(captured.params, ["5Hk", "5Hk", "5Hk", 1000, 0]);
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
  assert.deepEqual(captured.params, [
    "5Hk",
    "StakeAdded",
    "5Hk",
    "5Hk",
    "StakeAdded",
    100,
    0,
  ]);
});

test("loadAccountEvents applies the block_start/block_end range as bound params", async () => {
  let captured;
  await loadAccountEvents(
    async (sql, params) => {
      captured = { sql, params };
      return [];
    },
    "5Hk",
    { blockStart: 100, blockEnd: 900 },
  );
  assert.ok(/AND block_number >= \?/.test(captured.sql));
  assert.ok(/AND block_number <= \?/.test(captured.sql));
  assert.deepEqual(captured.params, [
    "5Hk",
    100,
    900,
    "5Hk",
    "5Hk",
    100,
    900,
    100,
    0,
  ]);
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
  assert.deepEqual(captured.params, [
    "5Hk",
    1000,
    3,
    "5Hk",
    "5Hk",
    1000,
    3,
    50,
  ]);
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
  assert.deepEqual(captured.params, ["5Hk", "5Hk", "5Hk", 100, 20]);
});

test("loadAccountEvents uses indexed union seeks instead of hotkey OR coldkey (#2059)", async () => {
  let captured;
  await loadAccountEvents(
    async (sql, params) => {
      captured = { sql, params };
      return [];
    },
    "5Hk",
    {},
  );
  assert.doesNotMatch(captured.sql, /hotkey = \? OR coldkey = \?/);
  assert.match(captured.sql, /INDEXED BY idx_account_events_hotkey/);
  assert.match(captured.sql, /INDEXED BY idx_account_events_coldkey/);
  assert.match(captured.sql, /UNION ALL/);
  assert.match(captured.sql, /hotkey IS NULL OR hotkey <> \?/);
});

test("loadAccountEvents includes coldkey-only rows when hotkey is NULL (#2059)", async () => {
  const nullHotkeyRow = {
    block_number: 42,
    event_index: 1,
    event_kind: "Transfer",
    hotkey: null,
    coldkey: "5Hk",
    netuid: 1,
    uid: null,
    amount_tao: 1.5,
    alpha_amount: null,
    observed_at: 1_700_000_000_000,
    extrinsic_index: 0,
  };
  const out = await loadAccountEvents(async () => [nullHotkeyRow], "5Hk", {
    limit: 10,
  });
  assert.equal(out.event_count, 1);
  assert.equal(out.events[0].coldkey, "5Hk");
  assert.equal(out.events[0].hotkey, null);
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
