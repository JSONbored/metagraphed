import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { buildSubnetConviction } from "../src/subnet-conviction.ts";

// Real-shaped subnet_locks row (post-sync shape: conviction_bits is a
// decimal-string u128, matching what the Postgres NUMERIC column and
// fetch-subnet-locks.py both emit).
function lockRow(overrides = {}) {
  return {
    netuid: 1,
    hotkey: "5CsvRJXuR955WojnGMdok1hbhffZyB4N5ocrv82f3p5A2zVp",
    is_owner: false,
    is_perpetual: true,
    locked_mass: 12801009134,
    conviction_bits: "103052736623230389324344213370",
    last_update: 8639094,
    captured_at: 1784360818505,
    ...overrides,
  };
}

describe("buildSubnetConviction — empty / cold-store input", () => {
  test("empty, null, and undefined rows all yield a schema-stable empty leaderboard", () => {
    for (const rows of [[], null, undefined]) {
      const data = buildSubnetConviction(rows, 7, {
        now: 100,
        unlockRate: 934866,
        maturityRate: 311622,
      });
      assert.equal(data.schema_version, 1);
      assert.equal(data.netuid, 7);
      assert.equal(data.count, 0);
      assert.deepEqual(data.leaderboard, []);
      assert.equal(data.king, null);
    }
  });
});

describe("buildSubnetConviction — real live-verified reconciliation (2026-07-18)", () => {
  // Live-verified against mainnet finney 2026-07-18: this exact row, rolled
  // forward from block 8639094 to 8647076 with the live unlock_rate=934866/
  // maturity_rate=311622, was cross-checked by hand against the pallet's
  // own formula (see docs/conviction-lock-mechanism.md) -- conviction grows
  // from its stored 5586500046.37... toward locked_mass (perpetual lock:
  // mass frozen, conviction still matures), landing at ~5768948497.6.
  test("a real perpetual (HotkeyLock) row rolls forward correctly: mass frozen, conviction matures toward it", () => {
    const data = buildSubnetConviction([lockRow()], 1, {
      now: 8647076,
      unlockRate: 934866,
      maturityRate: 311622,
    });
    assert.equal(data.count, 1);
    const entry = data.leaderboard[0];
    assert.equal(
      entry.hotkey,
      "5CsvRJXuR955WojnGMdok1hbhffZyB4N5ocrv82f3p5A2zVp",
    );
    assert.equal(entry.is_owner, false);
    // Perpetual lock: locked_mass never decays, stays exactly as captured.
    assert.equal(entry.locked_mass, 12801009134);
    // Conviction grew from ~5.5865e9 toward locked_mass, landing close to
    // but still below it (hasn't fully matured yet at this dt).
    assert.ok(
      entry.conviction > 5586500046,
      "conviction must grow, not shrink, for a perpetual lock",
    );
    assert.ok(
      entry.conviction < 12801009134,
      "conviction hasn't fully matured to locked_mass yet",
    );
    assert.ok(
      Math.abs(entry.conviction - 5768948497.63) < 1,
      `expected ~5768948497.63, got ${entry.conviction}`,
    );
  });

  test("an owner row's conviction is forced to equal its rolled locked_mass exactly (the pallet's owner special-case)", () => {
    // Live-verified 2026-07-18: OwnerLock(netuid=7).conviction.bits / 2**64
    // matched locked_mass almost exactly for a real owner row -- this is
    // the pallet's own `if owner_lock { conviction = locked_mass }` rule
    // (lock.rs's roll_forward_lock), not a coincidence of the data.
    const row = lockRow({
      is_owner: true,
      is_perpetual: true,
      locked_mass: 3211260531444,
      conviction_bits: "59237301177551992230895109013504",
      last_update: 8486593,
    });
    const data = buildSubnetConviction([row], 7, {
      now: 8486593, // now === last_update: no time-based rolling, isolates the owner rule
      unlockRate: 934866,
      maturityRate: 311622,
    });
    assert.equal(
      data.leaderboard[0].conviction,
      data.leaderboard[0].locked_mass,
    );
    assert.equal(data.leaderboard[0].conviction, 3211260531444);
  });
});

describe("buildSubnetConviction — perpetual vs. decaying sub-aggregate combination", () => {
  test("sums the perpetual (HotkeyLock) and decaying (DecayingHotkeyLock) rows for the SAME hotkey, rolling each independently", () => {
    const perpetual = lockRow({
      is_perpetual: true,
      locked_mass: 1000,
      conviction_bits: "0",
    });
    const decaying = lockRow({
      is_perpetual: false,
      locked_mass: 1000,
      conviction_bits: "0",
    });
    const data = buildSubnetConviction([perpetual, decaying], 1, {
      now: 8639094 + 100000, // dt=100,000 == tau (exp(-1) ~= 0.368, partial decay)
      unlockRate: 100000,
      maturityRate: 100000,
    });
    assert.equal(data.count, 1); // same hotkey -> one combined leaderboard entry
    const entry = data.leaderboard[0];
    // Perpetual mass never decays (stays 1000); decaying mass shrinks toward 0.
    // Combined mass must be strictly between 1000 (both frozen) and 2000
    // (neither decayed) -- proves both rows were rolled independently, not
    // summed raw before rolling (which would just be flat 2000 forever).
    assert.ok(
      entry.locked_mass > 1000 && entry.locked_mass < 2000,
      `got ${entry.locked_mass}`,
    );
  });

  test("a genuinely-zero stored row (fully unlocked, no residual conviction) is filtered out entirely", () => {
    const row = lockRow({
      is_perpetual: false,
      locked_mass: 0,
      conviction_bits: "0",
      last_update: 0,
    });
    const data = buildSubnetConviction([row], 1, {
      now: 100_000_000,
      unlockRate: 1,
      maturityRate: 1,
    });
    // Nothing to grow from (mass=0) and nothing existing to decay
    // (conviction=0) -- stays exactly zero, never a meaningless 0-row on
    // the leaderboard.
    assert.equal(data.count, 0);
  });

  test("a tiny non-zero residual conviction survives even after locked_mass has fully decayed away (genuine formula behavior, not filtered as noise)", () => {
    // conviction_from_existing = maturityDecay * conviction is independent
    // of locked_mass -- a real prior conviction value keeps decaying on its
    // own terms even once the underlying mass has unwound to 0. This is
    // intentional (conviction is a smoothed/lagging signal), not a bug.
    const row = lockRow({
      is_perpetual: false,
      locked_mass: 1,
      conviction_bits: "18446744073709551616000", // 1000.0
      last_update: 0,
    });
    const data = buildSubnetConviction([row], 1, {
      now: 100_000_000,
      unlockRate: 1,
      maturityRate: 100_000, // moderate maturity decay -- existing conviction survives partially
    });
    assert.equal(data.count, 1);
    assert.equal(data.leaderboard[0].locked_mass, 0);
    assert.ok(
      data.leaderboard[0].conviction > 0,
      "residual conviction must survive mass hitting 0",
    );
  });
});

describe("buildSubnetConviction — ranking and king", () => {
  test("sorts the leaderboard by conviction descending and reports the top hotkey as king", () => {
    // now === last_update for both rows (isolates ranking from decay/growth)
    // -- conviction_bits set directly to distinct values so the sort key
    // isn't a decay-driven tie.
    const low = lockRow({
      hotkey: "5Eo5pyNqVqdsmBJJWoPegQU7BakmNL7Ndwqo7VaZRTJdoSG5",
      locked_mass: 100,
      conviction_bits: "1844674407370955161600", // 100.0
    });
    const high = lockRow({
      hotkey: "5E6yHkmZmSpBT5aa2rNZcmeYa1y3N9jw1h7g53oNPzMUpnqG",
      locked_mass: 100000,
      conviction_bits: "1844674407370955161600000", // 100000.0
    });
    const data = buildSubnetConviction([low, high], 1, {
      now: 8639094, // now === last_update: isolates ranking from decay
      unlockRate: 934866,
      maturityRate: 311622,
    });
    assert.equal(data.king, "5E6yHkmZmSpBT5aa2rNZcmeYa1y3N9jw1h7g53oNPzMUpnqG");
    assert.equal(
      data.leaderboard[0].hotkey,
      "5E6yHkmZmSpBT5aa2rNZcmeYa1y3N9jw1h7g53oNPzMUpnqG",
    );
  });
});
