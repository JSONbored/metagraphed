import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  formatAccountEvent,
  formatAccountActivity,
  buildSubnetEvents,
  buildBlockEvents,
  formatAccountDay,
  buildAccountHistory,
  buildAccountTransfers,
  pruneAccountEvents,
  loadAccountTransfers,
} from "../src/account-events.mjs";

// Local D1 (sql, params) => rows runner factory — captures every call so a test
// can assert the WHERE clause + bound params it produced. Mirrors the loader
// runner contract: a cold store yields [].
function makeD1(rowsBySql = []) {
  const calls = [];
  const d1 = async (sql, params) => {
    calls.push({ sql, params });
    return rowsBySql.shift() ?? [];
  };
  d1.calls = calls;
  return d1;
}

describe("formatAccountEvent block_number fallback", () => {
  test("formatAccountEvent falls back block_number to null when nullish", () => {
    // A row object lacking block_number must surface null (the right arm of
    // `row.block_number ?? null`), not undefined.
    const out = formatAccountEvent({ event_kind: "StakeAdded" });
    assert.equal(out.block_number, null);
    assert.equal(out.event_kind, "StakeAdded");
  });
});

describe("formatAccountActivity count fallback", () => {
  test("formatAccountActivity defaults a module count to 0 when absent", () => {
    // A module row with call_module but no count must surface count:0 (the right
    // arm of `m.count ?? 0`), never undefined.
    const out = formatAccountActivity({ tx_count: 2 }, [
      { call_module: "SubtensorModule" },
    ]);
    assert.equal(out.modules_called.length, 1);
    assert.equal(out.modules_called[0].count, 0);
    assert.equal(out.tx_count, 2);
  });
});

describe("buildSubnetEvents", () => {
  test("buildSubnetEvents is schema-stable for a cold/unknown subnet", () => {
    // No rows + no options → empty feed, null pagination markers.
    const out = buildSubnetEvents(null, 99);
    assert.equal(out.event_count, 0);
    assert.deepEqual(out.events, []);
    assert.equal(out.limit, null);
    assert.equal(out.offset, null);
    assert.equal(out.next_cursor, null);
  });
});

describe("buildBlockEvents", () => {
  test("buildBlockEvents is schema-stable for a cold/unknown ref", () => {
    // null rows + undefined ref/blockNumber → schema-stable zero (null markers).
    const out = buildBlockEvents(null, undefined, undefined);
    assert.equal(out.ref, null);
    assert.equal(out.block_number, null);
    assert.equal(out.event_count, 0);
    assert.deepEqual(out.events, []);
    assert.equal(out.limit, null);
    assert.equal(out.offset, null);
  });
});

describe("formatAccountDay", () => {
  test("formatAccountDay yields empty kinds + null day for a sparse row", () => {
    // Non-string event_kinds → the `typeof === string && length>0` guard is false
    // → [] (the false arm). An object lacking `day` exercises the null fallback
    // of `day ?? null`, and other absent fields fall back to null too.
    const out = formatAccountDay({ event_kinds: "" });
    assert.deepEqual(out.event_kinds, []);
    assert.equal(out.day, null);
    assert.equal(out.netuid, null);
    assert.equal(out.event_count, null);
    assert.equal(out.first_block, null);
    assert.equal(out.last_block, null);
  });

  test("formatAccountDay is null-safe on junk rows", () => {
    assert.equal(formatAccountDay(null), null);
    assert.equal(formatAccountDay("x"), null);
  });
});

describe("buildAccountHistory", () => {
  test("buildAccountHistory is schema-stable for a coldkey-only/cold store", () => {
    const out = buildAccountHistory(undefined, "5Hk");
    assert.equal(out.day_count, 0);
    assert.deepEqual(out.days, []);
    assert.equal(out.limit, null);
    assert.equal(out.offset, null);
    assert.equal(out.next_cursor, null);
  });
});

describe("buildAccountTransfers", () => {
  test("buildAccountTransfers derives direction=received when coldkey matches", () => {
    // hotkey !== ss58 but coldkey === ss58 → received (the middle ternary arm).
    const out = buildAccountTransfers(
      [{ hotkey: "5Other", coldkey: "5Hk" }],
      "5Hk",
    );
    assert.equal(out.transfers[0].direction, "received");
  });

  test("buildAccountTransfers yields direction=null when neither key matches", () => {
    // hotkey !== ss58 AND coldkey !== ss58 → null (the else arm of both ternaries).
    const out = buildAccountTransfers([{ hotkey: "5A", coldkey: "5B" }], "5Hk");
    assert.equal(out.transfers[0].direction, null);
  });

  test("buildAccountTransfers falls back from/to to null when keys absent", () => {
    // A transfer row lacking hotkey/coldkey must surface from:null and to:null
    // (the right arms of `r.hotkey ?? null` / `r.coldkey ?? null`), and with
    // neither key matching ss58 the direction is null.
    const out = buildAccountTransfers([{ amount_tao: 2 }], "5Hk");
    const t = out.transfers[0];
    assert.equal(t.from, null);
    assert.equal(t.to, null);
    assert.equal(t.direction, null);
    assert.equal(t.amount_tao, 2);
  });

  test("buildAccountTransfers drops non-object rows and is cold-safe", () => {
    // The `r && typeof r === object` filter drops junk; null rows → empty feed.
    const out = buildAccountTransfers([null, "x", 7], "5Hk");
    assert.equal(out.transfer_count, 0);
    assert.deepEqual(out.transfers, []);
    const cold = buildAccountTransfers(null, "5Hk");
    assert.equal(cold.transfer_count, 0);
    assert.equal(cold.limit, null);
    assert.equal(cold.offset, null);
    assert.equal(cold.next_cursor, null);
  });
});

describe("pruneAccountEvents changes fallback", () => {
  test("pruneAccountEvents reports changes:null when meta is absent", async () => {
    // result.meta?.changes nullish → the right arm of `?? null` (changes:null).
    const env = {
      METAGRAPH_HEALTH_DB: {
        prepare() {
          return { bind: () => ({ run: async () => ({}) }) };
        },
      },
    };
    const r = await pruneAccountEvents(env, { now: () => 0 });
    assert.equal(r.pruned, true);
    assert.equal(r.changes, null);
  });
});

describe("loadAccountTransfers direction clauses", () => {
  test("loadAccountTransfers narrows to hotkey for direction=sent", async () => {
    const d1 = makeD1([[]]);
    await loadAccountTransfers(d1, "5Hk", { direction: "sent" });
    const { sql, params } = d1.calls[0];
    assert.ok(/INDEXED BY idx_account_events_hotkey/.test(sql));
    assert.ok(/hotkey = \?/.test(sql));
    assert.ok(!/coldkey = \?/.test(sql)); // only the sent (hotkey) side clause
    // sideParams=[ss58] then lim, off bound.
    assert.deepEqual(params, ["5Hk", 100, 0]);
  });

  test("loadAccountTransfers unions both sides when direction is absent", async () => {
    const d1 = makeD1([[{ block_number: 1, hotkey: "5Hk", observed_at: 1 }]]);
    const out = await loadAccountTransfers(d1, "5Hk", {});
    const { sql, params } = d1.calls[0];
    assert.ok(/UNION ALL/.test(sql));
    assert.ok(/INDEXED BY idx_account_events_hotkey/.test(sql));
    assert.ok(/INDEXED BY idx_account_events_coldkey/.test(sql));
    assert.ok(/coldkey = \? AND hotkey <> \?/.test(sql));
    assert.equal(sql.includes(" OR "), false);
    assert.deepEqual(params, ["5Hk", "5Hk", "5Hk", 100, 0]);
    assert.equal(out.transfer_count, 1);
  });
});
