import assert from "node:assert/strict";
import { test } from "vitest";
import {
  INDEXED_EVENT_KINDS,
  INGESTED_EVENT_KINDS,
  formatAccountEvent,
  formatAccountActivity,
  formatAccountDay,
  formatRegistration,
  buildAccountSummary,
  buildAccountEvents,
  buildSubnetEventSummary,
  buildAccountSubnets,
  loadAccountHistory,
  ACCOUNT_EVENT_SUMMARY_SCAN_CAP,
  buildAccountTransfers,
} from "../src/account-events.mjs";

test("INDEXED_EVENT_KINDS covers the core entity events", () => {
  for (const k of [
    "NeuronRegistered",
    "StakeAdded",
    "StakeRemoved",
    "WeightsSet",
    "AxonServed",
    "PrometheusServed",
  ]) {
    assert.ok(INDEXED_EVENT_KINDS.includes(k), `missing ${k}`);
  }
});

test("INGESTED_EVENT_KINDS accepts PrometheusServed for kind filters", () => {
  assert.ok(INGESTED_EVENT_KINDS.includes("PrometheusServed"));
});

test("INGESTED_EVENT_KINDS accepts AxonInfoRemoved for kind filters", () => {
  assert.ok(INGESTED_EVENT_KINDS.includes("AxonInfoRemoved"));
});

test("INGESTED_EVENT_KINDS accepts BurnSet (subnet registration cost) for kind filters", () => {
  assert.ok(INGESTED_EVENT_KINDS.includes("BurnSet"));
});

test("INGESTED_EVENT_KINDS accepts expanded Subtensor lifecycle event filters", () => {
  for (const kind of [
    "NeuronDeregistered",
    "RegistrationAllowed",
    "PowRegistrationAllowed",
    "SubnetOwnerHotkeySet",
  ]) {
    assert.ok(INGESTED_EVENT_KINDS.includes(kind), `missing ${kind}`);
  }
});

test("INGESTED_EVENT_KINDS accepts ColdkeySwapScheduled for kind filters", () => {
  assert.ok(INGESTED_EVENT_KINDS.includes("ColdkeySwapScheduled"));
});

test("INGESTED_EVENT_KINDS accepts Faucet for testnet account credit filters", () => {
  assert.ok(INGESTED_EVENT_KINDS.includes("Faucet"));
});

test("INGESTED_EVENT_KINDS accepts StakeTransferred (cross-coldkey stake move) for kind filters", () => {
  assert.ok(INGESTED_EVENT_KINDS.includes("StakeTransferred"));
});

test("INGESTED_EVENT_KINDS accepts the kinds found by the 2026-07-14/15 exhaustive decode audit (indexer-rs has always curated these; the JS allowlist never learned their names)", () => {
  for (const kind of [
    "CRV3WeightsCommitted",
    "CRV3WeightsRevealed",
    "TimelockedWeightsCommitted",
    "TimelockedWeightsRevealed",
    "AutoStakeAdded",
    "StakeSwapped",
    "Deposit",
    "Withdraw",
    "Reserved",
    "Unreserved",
    "Endowed",
    "DustLost",
    "Issued",
  ]) {
    assert.ok(INGESTED_EVENT_KINDS.includes(kind), `missing ${kind}`);
  }
});

test("INGESTED_EVENT_KINDS accepts subnet leasing + crowdloan kinds (#6718)", () => {
  for (const kind of [
    "SubnetLeaseCreated",
    "SubnetLeaseTerminated",
    "SubnetLeaseDividendsDistributed",
    "Contributed",
    "Withdrew",
  ]) {
    assert.ok(INGESTED_EVENT_KINDS.includes(kind), `missing ${kind}`);
  }
});

test("buildSubnetEventSummary categorizes subnet leasing + crowdloan kinds as governance, not other (#6718)", () => {
  const out = buildSubnetEventSummary(
    [
      { event_kind: "SubnetLeaseCreated", event_count: 4 },
      { event_kind: "SubnetLeaseTerminated", event_count: 1 },
      { event_kind: "SubnetLeaseDividendsDistributed", event_count: 6 },
      { event_kind: "Contributed", event_count: 9 },
      { event_kind: "Withdrew", event_count: 2 },
    ],
    [],
    7,
  );
  const byKind = Object.fromEntries(
    out.event_kinds.map((row) => [row.event_kind, row.category]),
  );
  assert.equal(byKind.SubnetLeaseCreated, "governance");
  assert.equal(byKind.SubnetLeaseTerminated, "governance");
  assert.equal(byKind.SubnetLeaseDividendsDistributed, "governance");
  assert.equal(byKind.Contributed, "governance");
  assert.equal(byKind.Withdrew, "governance");
  assert.ok(
    !out.categories.some((row) => row.category === "other"),
    "none of these kinds should fall into the other category",
  );
});

test("buildSubnetEventSummary categorizes the newly-added kinds instead of dumping them in other (2026-07-14/15 audit fix)", () => {
  const out = buildSubnetEventSummary(
    [
      { event_kind: "TimelockedWeightsCommitted", event_count: 5 },
      { event_kind: "AutoStakeAdded", event_count: 3 },
      { event_kind: "Deposit", event_count: 2 },
    ],
    [],
    7,
  );
  const byKind = Object.fromEntries(
    out.event_kinds.map((row) => [row.event_kind, row.category]),
  );
  assert.equal(byKind.TimelockedWeightsCommitted, "consensus");
  assert.equal(byKind.AutoStakeAdded, "stake");
  assert.equal(byKind.Deposit, "transfer");
  assert.ok(
    !out.categories.some((row) => row.category === "other"),
    "none of these kinds should fall into the other category",
  );
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

test("formatAccountEvent coerces string-typed observed_at cells to ISO timestamps", () => {
  const out = formatAccountEvent({
    block_number: 1,
    event_kind: "Transfer",
    observed_at: "1750000000000",
  });
  assert.equal(out.observed_at, new Date(1750000000000).toISOString());
});

test("formatAccountEvent preserves null observed_at as null (not epoch 1970)", () => {
  const out = formatAccountEvent({
    block_number: 1,
    event_kind: "Transfer",
    observed_at: null,
  });
  assert.equal(out.observed_at, null);
});

test("formatAccountEvent drops invalid observed_at strings to null", () => {
  const out = formatAccountEvent({
    block_number: 1,
    event_kind: "Transfer",
    observed_at: "not-a-timestamp",
  });
  assert.equal(out.observed_at, null);
});

test("formatAccountEvent drops zero/blank observed_at to null (not epoch 1970)", () => {
  for (const observed_at of [0, "0", "", "   "]) {
    const out = formatAccountEvent({
      block_number: 1,
      event_kind: "Transfer",
      observed_at,
    });
    assert.equal(
      out.observed_at,
      null,
      `observed_at=${JSON.stringify(observed_at)} must not become epoch 1970`,
    );
  }
});

test("formatAccountEvent drops out-of-range observed_at to null", () => {
  for (const observed_at of ["8640000000000001", 8640000000000001]) {
    const out = formatAccountEvent({
      block_number: 1,
      event_kind: "Transfer",
      observed_at,
    });
    assert.equal(
      out.observed_at,
      null,
      `observed_at=${JSON.stringify(observed_at)} must not leak an invalid ISO string`,
    );
  }
});

test("buildAccountTransfers coerces string-typed observed_at cells to ISO timestamps", () => {
  const out = buildAccountTransfers(
    [
      {
        hotkey: "5A",
        coldkey: "5B",
        amount_tao: 1,
        observed_at: "1750000000000",
      },
    ],
    "5A",
  );
  assert.equal(
    out.transfers[0].observed_at,
    new Date(1750000000000).toISOString(),
  );
});

test("formatAccountActivity coerces string-typed last_tx_at to ISO timestamps", () => {
  const out = formatAccountActivity({ last_tx_at: "1750000000000" }, []);
  assert.equal(out.last_tx_at, new Date(1750000000000).toISOString());
});

test("buildAccountSummary coerces string-typed first/last seen timestamps", () => {
  const out = buildAccountSummary("5Hk", {
    agg: { fo: "1750000000000", lo: "1750009000000" },
  });
  assert.equal(out.first_seen_at, new Date(1750000000000).toISOString());
  assert.equal(out.last_seen_at, new Date(1750009000000).toISOString());
});

test("formatAccountEvent coerces string-typed netuid and uid cells to Numbers", () => {
  // D1 can return an INTEGER column as a numeric string ("7" not 7); the bare
  // `?? null` pass-through this replaced would have leaked strings into the API
  // payload. Mirrors the coercion in blocks.mjs (#2435) and extrinsics.mjs
  // (#2439) — and the block_number / event_index / extrinsic_index coercion
  // already applied in this same function.
  const out = formatAccountEvent({ netuid: "7", uid: "42", block_number: 1 });
  assert.equal(out.netuid, 7);
  assert.equal(typeof out.netuid, "number");
  assert.equal(out.uid, 42);
  assert.equal(typeof out.uid, "number");
});

test("formatAccountEvent rejects non-integer or negative netuid/uid cells to null", () => {
  // Guard the toBlockNumber helper for these fields: netuids are never negative
  // on-chain, and a uid above Number.MAX_SAFE_INTEGER would lose precision.
  assert.equal(formatAccountEvent({ netuid: -1 }).netuid, null);
  assert.equal(formatAccountEvent({ uid: 1.5 }).uid, null);
  assert.equal(formatAccountEvent({ netuid: "abc" }).netuid, null);
});

test("formatAccountEvent rejects blank integer cells that coerce to 0 (not block 0 / subnet 0 / uid 0)", () => {
  // Mirrors the blank-cell guard in blocks.mjs (#2879): Number("") and
  // Number("   ") are 0, which would fabricate genesis height / subnet / uid 0.
  for (const blank of ["", "   "]) {
    const out = formatAccountEvent({
      block_number: blank,
      event_index: blank,
      netuid: blank,
      uid: blank,
      extrinsic_index: blank,
    });
    assert.equal(
      out.block_number,
      null,
      `block_number for ${JSON.stringify(blank)}`,
    );
    assert.equal(
      out.event_index,
      null,
      `event_index for ${JSON.stringify(blank)}`,
    );
    assert.equal(out.netuid, null, `netuid for ${JSON.stringify(blank)}`);
    assert.equal(out.uid, null, `uid for ${JSON.stringify(blank)}`);
    assert.equal(
      out.extrinsic_index,
      null,
      `extrinsic_index for ${JSON.stringify(blank)}`,
    );
  }
});

test("formatAccountEvent coerces string-typed amount_tao and alpha_amount cells to Numbers", () => {
  // D1 can return a REAL column as a numeric string; the bare `?? null`
  // pass-through this replaced would have leaked strings into the JSON payload.
  // Mirrors the coercion in blocks.mjs (#2435), extrinsics.mjs (#2439), and
  // metagraph-neurons.mjs (#2503). Rounded to rao precision (9 dp) so the
  // IEEE-754 float noise from SUM() never carries into the payload.
  const out = formatAccountEvent({
    block_number: 1,
    amount_tao: "1.5",
    alpha_amount: "2.25",
  });
  assert.equal(out.amount_tao, 1.5);
  assert.equal(typeof out.amount_tao, "number");
  assert.equal(out.alpha_amount, 2.25);
  assert.equal(typeof out.alpha_amount, "number");
});

test("formatAccountEvent coerces null amount_tao and alpha_amount to null (not 0)", () => {
  // amount_tao / alpha_amount are nullable REAL columns. Null must surface
  // as null, never coerced to 0 by the bare `?? null` fallback this replaced.
  const out = formatAccountEvent({ block_number: 1 });
  assert.equal(out.amount_tao, null);
  assert.equal(out.alpha_amount, null);
});

test("formatAccountEvent rejects blank amount_tao/alpha_amount cells that coerce to 0", () => {
  // Mirrors the blank-cell guard in extrinsics.mjs (#3030): Number("") is 0.
  for (const blank of ["", "   "]) {
    const out = formatAccountEvent({
      block_number: 1,
      amount_tao: blank,
      alpha_amount: blank,
    });
    assert.equal(
      out.amount_tao,
      null,
      `amount_tao for ${JSON.stringify(blank)}`,
    );
    assert.equal(
      out.alpha_amount,
      null,
      `alpha_amount for ${JSON.stringify(blank)}`,
    );
  }
  // A literal zero amount is still valid — only blank strings are rejected.
  const zero = formatAccountEvent({
    block_number: 1,
    amount_tao: 0,
    alpha_amount: "0",
  });
  assert.equal(zero.amount_tao, 0);
  assert.equal(zero.alpha_amount, 0);
});

test("formatAccountEvent rounds amount_tao and alpha_amount to rao precision", () => {
  // The rao is the smallest TAO unit (1e-9). A SUM() over many REAL rows
  // accumulates IEEE-754 noise below the rao floor; toTaoOrNull rounds to
  // 9 dp so the payload never carries a long floating-point tail.
  const out = formatAccountEvent({
    block_number: 1,
    amount_tao: 1.1234567899,
    alpha_amount: 2.9876543211,
  });
  assert.equal(out.amount_tao, 1.12345679);
  assert.equal(out.alpha_amount, 2.987654321);
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

test("formatRegistration coerces D1 string flag cells to booleans", () => {
  const out = formatRegistration({
    netuid: 1,
    uid: 0,
    stake_tao: null,
    validator_permit: "0",
    active: "1",
  });
  assert.equal(out.validator_permit, false);
  assert.equal(out.active, true);
});

test("formatRegistration drops invalid netuid and uid cells instead of leaking strings", () => {
  const out = formatRegistration({
    netuid: "not-a-netuid",
    uid: "-1",
    stake_tao: "not-a-number",
    validator_permit: 0,
    active: 0,
  });
  assert.equal(out.netuid, null);
  assert.equal(out.uid, null);
  assert.equal(out.stake_tao, null);
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

test("buildAccountTransfers coerces string-typed amount_tao cells to Numbers", () => {
  const out = buildAccountTransfers(
    [
      {
        block_number: 1,
        event_index: 0,
        hotkey: "5A",
        coldkey: "5B",
        amount_tao: "4.2",
        observed_at: null,
      },
    ],
    "5A",
  );
  assert.equal(typeof out.transfers[0].amount_tao, "number");
  assert.equal(out.transfers[0].amount_tao, 4.2);
});

test("buildAccountTransfers preserves null amount_tao as null (not 0)", () => {
  const out = buildAccountTransfers(
    [{ hotkey: "5A", coldkey: "5B", amount_tao: null }],
    "5A",
  );
  assert.equal(out.transfers[0].amount_tao, null);
});

test("buildAccountTransfers rounds amount_tao to rao precision", () => {
  const out = buildAccountTransfers(
    [
      {
        hotkey: "5A",
        coldkey: "5B",
        amount_tao: "1.0000000004",
        observed_at: null,
      },
    ],
    "5A",
  );
  assert.equal(out.transfers[0].amount_tao, 1);
});

test("buildAccountTransfers drops invalid amount_tao strings", () => {
  const out = buildAccountTransfers(
    [{ hotkey: "5A", coldkey: "5B", amount_tao: "not-a-number" }],
    "5A",
  );
  assert.equal(out.transfers[0].amount_tao, null);
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

// loadAccountTransfers (the D1-querying account_events reader) was deleted
// (2026-07-17, D1 fully eliminated) -- see src/account-events.mjs's own
// comment. Coverage for buildAccountTransfers direction-labeling / cursor
// shaping lives in the tests above this block (calling buildAccountTransfers
// directly with hand-built rows).

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

test("buildAccountSummary coerces D1 numeric-string aggregates to integers", () => {
  const out = buildAccountSummary("5Hk", {
    agg: { c: "42", sc: "3", fb: "100", lb: "200" },
    scanned: "42",
    kinds: [{ kind: "Transfer", count: "7" }],
    activity: { tx_count: "9", last_tx_block: "500" },
    modules: [{ call_module: "Balances", count: "4" }],
  });
  assert.equal(out.event_count, 42);
  assert.equal(out.subnet_count, 3);
  assert.equal(out.first_block, 100);
  assert.equal(out.last_block, 200);
  assert.equal(out.event_scan_capped, false);
  assert.deepEqual(out.event_kinds, [{ kind: "Transfer", count: 7 }]);
  assert.equal(out.activity.tx_count, 9);
  assert.equal(out.activity.last_tx_block, 500);
  assert.deepEqual(out.activity.modules_called, [
    { call_module: "Balances", count: 4 },
  ]);
});

test("buildAccountSummary rejects junk D1 count cells to 0/null", () => {
  const out = buildAccountSummary("5Hk", {
    agg: { c: "nope", sc: "-1" },
    kinds: [{ kind: "Transfer", count: "abc" }],
    activity: { tx_count: "x" },
    modules: [{ call_module: "Balances", count: null }],
  });
  assert.equal(out.event_count, 0);
  assert.equal(out.subnet_count, 0);
  assert.deepEqual(out.event_kinds, [{ kind: "Transfer", count: 0 }]);
  assert.equal(out.activity.tx_count, 0);
  assert.equal(out.activity.modules_called[0].count, 0);
});

test("buildAccountSummary coerces a string scanned probe for the cap flag", () => {
  const capped = buildAccountSummary("5Hk", {
    agg: { c: 100 },
    scanned: String(ACCOUNT_EVENT_SUMMARY_SCAN_CAP + 1),
  });
  assert.equal(capped.event_scan_capped, true);
  assert.equal(capped.first_block, null);
});

test("buildAccountSummary treats a junk scanned probe as zero for cap detection", () => {
  // scanned is present but non-numeric → toBlockNumber returns null → ?? 0,
  // so the cap probe does not false-positive from a garbage D1 cell.
  const out = buildAccountSummary("5Hk", {
    agg: { c: "42" },
    scanned: "nope",
  });
  assert.equal(out.event_count, 42);
  assert.equal(out.event_scan_capped, false);
});

test("buildAccountSummary uses coerced event_count when scanned is omitted", () => {
  const out = buildAccountSummary("5Hk", { agg: { c: "12", sc: "2" } });
  assert.equal(out.event_count, 12);
  assert.equal(out.subnet_count, 2);
  assert.equal(out.event_scan_capped, false);
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

test("buildAccountSummary nulls all-time first_* when the event scan is capped", async () => {
  // The probe (scanned) found a row past the cap, so the account genuinely has
  // more than CAP events: the aggregate window (agg.c === CAP) is a lower bound and
  // MIN(block)/MIN(observed) are its floor, not the account's true first — null them.
  const capped = buildAccountSummary("5Hk", {
    agg: {
      c: ACCOUNT_EVENT_SUMMARY_SCAN_CAP,
      sc: 3,
      fb: 100,
      lb: 900,
      fo: 1000,
      lo: 9000,
    },
    scanned: ACCOUNT_EVENT_SUMMARY_SCAN_CAP + 1,
  });
  // event_count is exactly the CAP window (not CAP+1); event_scan_capped labels it
  // so a consumer never reads it as an all-time total.
  assert.equal(capped.event_count, ACCOUNT_EVENT_SUMMARY_SCAN_CAP);
  assert.equal(capped.event_scan_capped, true);
  assert.equal(capped.first_block, null);
  assert.equal(capped.first_seen_at, null);
  // last_* stay exact — the newest events include the latest.
  assert.equal(capped.last_block, 900);

  // Boundary: an account with EXACTLY CAP events — the probe found no extra row
  // (scanned === CAP) — is complete, so not capped and first_* are the true first.
  const exactlyCap = buildAccountSummary("5Hk", {
    agg: {
      c: ACCOUNT_EVENT_SUMMARY_SCAN_CAP,
      sc: 3,
      fb: 100,
      lb: 900,
      fo: 1000,
    },
    scanned: ACCOUNT_EVENT_SUMMARY_SCAN_CAP,
  });
  assert.equal(exactlyCap.event_scan_capped, false);
  assert.equal(exactlyCap.first_block, 100);
  assert.ok(exactlyCap.first_seen_at);

  // Well under the cap the aggregate spans the account's full history, so the
  // totals are exact all-time values and first_* are reported.
  const full = buildAccountSummary("5Hk", {
    agg: { c: 10, sc: 2, fb: 100, lb: 900, fo: 1000, lo: 9000 },
    scanned: 10,
  });
  assert.equal(full.event_scan_capped, false);
  assert.equal(full.first_block, 100);
  assert.ok(full.first_seen_at);
});

test("buildSubnetEventSummary groups event kinds into coarse categories", () => {
  const out = buildSubnetEventSummary(
    [
      {
        event_kind: "StakeAdded",
        event_count: "3",
        hotkey_count: "2",
        coldkey_count: "1",
        amount_tao: 1.1 + 2.2,
        alpha_amount: "0.4",
        first_block: "100",
        last_block: "120",
        first_observed_at: 1_750_000_000_000,
        last_observed_at: 1_750_000_010_000,
      },
      {
        event_kind: "WeightsSet",
        event_count: 2,
        hotkey_count: 1,
        coldkey_count: 0,
        amount_tao: null,
        alpha_amount: null,
        first_block: 90,
        last_block: 119,
        first_observed_at: 1_749_999_000_000,
        last_observed_at: 1_750_000_005_000,
      },
      { event_kind: "", event_count: 99 },
    ],
    [
      {
        block_number: 120,
        event_index: 2,
        event_kind: "StakeAdded",
        netuid: 7,
        observed_at: 1_750_000_010_000,
      },
    ],
    7,
    { window: "7d", limit: 5 },
  );
  assert.equal(out.total_events, 5);
  assert.equal(out.kind_count, 2);
  assert.equal(out.category_count, 2);
  assert.equal(out.event_kinds[0].event_kind, "StakeAdded");
  assert.equal(out.event_kinds[0].amount_tao, 3.3);
  assert.equal(out.categories[0].category, "stake");
  assert.equal(out.categories[0].event_count, 3);
  assert.equal(out.recent_event_count, 1);
  assert.equal(out.observed_at, "2025-06-15T15:06:50.000Z");
});

test("buildSubnetEventSummary merges same-category bounds and tie-sorts deterministically", () => {
  const out = buildSubnetEventSummary(
    [
      {
        event_kind: "StakeAdded",
        event_count: 2,
        amount_tao: 1,
        alpha_amount: 0.1,
        first_block: 200,
        last_block: 210,
        first_observed_at: 1_750_000_200_000,
        last_observed_at: 1_750_000_210_000,
      },
      {
        event_kind: "StakeRemoved",
        event_count: 2,
        amount_tao: 2,
        alpha_amount: 0.2,
        first_block: null,
        last_block: null,
        first_observed_at: null,
        last_observed_at: null,
      },
      {
        event_kind: "StakeMoved",
        event_count: 2,
        amount_tao: 3,
        alpha_amount: 0.3,
        first_block: 150,
        last_block: 250,
        first_observed_at: 1_750_000_150_000,
        last_observed_at: 1_750_000_260_000,
      },
      {
        event_kind: "WeightsSet",
        event_count: 2,
        first_block: 180,
        last_block: 181,
      },
      {
        event_kind: "AxonServed",
        event_count: 2,
        first_block: 190,
        last_block: 191,
      },
    ],
    [{ block_number: 250, event_index: 0, event_kind: "StakeMoved" }],
    7,
    { window: "30d", limit: 1 },
  );
  assert.deepEqual(
    out.event_kinds.map((row) => row.event_kind),
    ["WeightsSet", "AxonServed", "StakeAdded", "StakeMoved", "StakeRemoved"],
  );
  assert.deepEqual(
    out.categories.map((row) => row.category),
    ["stake", "consensus", "serving"],
  );
  assert.deepEqual(
    {
      event_count: out.categories[0].event_count,
      amount_tao: out.categories[0].amount_tao,
      alpha_amount: out.categories[0].alpha_amount,
      first_block: out.categories[0].first_block,
      last_block: out.categories[0].last_block,
      first_observed_at: out.categories[0].first_observed_at,
      last_observed_at: out.categories[0].last_observed_at,
    },
    {
      event_count: 6,
      amount_tao: 6,
      alpha_amount: 0.6,
      first_block: 150,
      last_block: 250,
      first_observed_at: "2025-06-15T15:09:10.000Z",
      last_observed_at: "2025-06-15T15:11:00.000Z",
    },
  );
});

test("buildSubnetEventSummary is schema-stable for malformed cold inputs", () => {
  const out = buildSubnetEventSummary(null, null, 7);
  assert.equal(out.window, null);
  assert.equal(out.observed_at, null);
  assert.equal(out.total_events, 0);
  assert.equal(out.limit, null);
  assert.deepEqual(out.categories, []);
  assert.deepEqual(out.event_kinds, []);
  assert.deepEqual(out.recent_events, []);
});

test("buildSubnetEventSummary keeps unknown future kinds in the other category", () => {
  const out = buildSubnetEventSummary(
    [{ event_kind: "FutureRuntimeEvent", event_count: 1 }],
    [],
    7,
  );
  assert.equal(out.event_kinds[0].event_kind, "FutureRuntimeEvent");
  assert.equal(out.event_kinds[0].category, "other");
  assert.equal(out.categories[0].category, "other");
});

test("loadAccountHistory is schema-stable when the D1 read yields nothing", async () => {
  // D1 fully eliminated (2026-07-17): account_events_daily is Postgres-only
  // now, so loadAccountHistory no longer takes a `d1` runner and always
  // returns the cold/empty shape.
  const out = await loadAccountHistory("5Hk", {
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
