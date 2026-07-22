import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  buildChainIdleStake,
  buildSubnetIdleStake,
} from "../src/subnet-idle-stake.ts";

describe("buildSubnetIdleStake", () => {
  test("sums stake_tao only across neurons with dividends == 0", () => {
    const out = buildSubnetIdleStake(
      [
        { stake_tao: 100, dividends: 0 },
        { stake_tao: 50, dividends: 0.5 },
        { stake_tao: 25, dividends: 0 },
      ],
      7,
    );
    assert.equal(out.netuid, 7);
    assert.equal(out.neuron_count, 3);
    assert.equal(out.idle_neuron_count, 2);
    assert.equal(out.idle_stake_tao, 125);
  });

  test("a neuron with no validator_permit and no weight-setting output are both just dividends == 0", () => {
    const out = buildSubnetIdleStake(
      [
        { stake_tao: 10, dividends: 0, validator_permit: 0 },
        { stake_tao: 20, dividends: 0, validator_permit: 1 },
      ],
      7,
    );
    assert.equal(out.idle_neuron_count, 2);
    assert.equal(out.idle_stake_tao, 30);
  });

  test("a neuron with positive dividends is never counted as idle", () => {
    const out = buildSubnetIdleStake([{ stake_tao: 100, dividends: 0.01 }], 7);
    assert.equal(out.idle_neuron_count, 0);
    assert.equal(out.idle_stake_tao, 0);
  });

  test("empty/cold rows yield a schema-stable zero, never throws", () => {
    for (const rows of [[], null, undefined]) {
      const out = buildSubnetIdleStake(rows, 7);
      assert.equal(out.netuid, 7);
      assert.equal(out.captured_at, null);
      assert.equal(out.neuron_count, 0);
      assert.equal(out.idle_neuron_count, 0);
      assert.equal(out.idle_stake_tao, 0);
    }
  });

  test("captured_at is the newest captured_at across every row, tolerating a numeric-string epoch", () => {
    const out = buildSubnetIdleStake(
      [
        { stake_tao: 1, dividends: 0, captured_at: "1750000000000" },
        { stake_tao: 1, dividends: 0, captured_at: 1750000060000 },
      ],
      7,
    );
    assert.equal(out.captured_at, new Date(1750000060000).toISOString());
  });

  test("a malformed captured_at is ignored rather than treated as the newest", () => {
    const out = buildSubnetIdleStake(
      [{ stake_tao: 1, dividends: 0, captured_at: "not-a-date" }],
      7,
    );
    assert.equal(out.captured_at, null);
  });

  test("captured_at tolerates a real ISO string (not just a numeric-string epoch)", () => {
    const out = buildSubnetIdleStake(
      [
        {
          stake_tao: 1,
          dividends: 0,
          captured_at: "2026-01-01T00:00:00.000Z",
        },
      ],
      7,
    );
    assert.equal(out.captured_at, "2026-01-01T00:00:00.000Z");
  });

  test("a non-positive numeric-string epoch is ignored, not treated as a real timestamp", () => {
    const out = buildSubnetIdleStake(
      [{ stake_tao: 1, dividends: 0, captured_at: "0" }],
      7,
    );
    assert.equal(out.captured_at, null);
  });

  test("a finite but out-of-Date-range epoch is ignored, not treated as a real timestamp", () => {
    const out = buildSubnetIdleStake(
      [{ stake_tao: 1, dividends: 0, captured_at: 1e20 }],
      7,
    );
    assert.equal(out.captured_at, null);
  });

  test("a captured_at that is neither a string nor a number is ignored", () => {
    const out = buildSubnetIdleStake(
      [{ stake_tao: 1, dividends: 0, captured_at: true }],
      7,
    );
    assert.equal(out.captured_at, null);
  });

  test("an idle neuron with a malformed/non-finite stake_tao contributes 0, not NaN, to the total", () => {
    const out = buildSubnetIdleStake(
      [
        { stake_tao: "not-a-number", dividends: 0 },
        { stake_tao: 10, dividends: 0 },
      ],
      7,
    );
    assert.equal(out.idle_neuron_count, 2);
    assert.equal(out.idle_stake_tao, 10);
  });

  test("a missing/null dividends value is NOT treated as idle (dividends must be present and exactly 0)", () => {
    const out = buildSubnetIdleStake(
      [{ stake_tao: 100, dividends: null }, { stake_tao: 50 }],
      7,
    );
    assert.equal(out.idle_neuron_count, 0);
  });

  test("a numeric-string dividends value (Postgres NUMERIC's real over-the-wire shape) is coerced correctly", () => {
    const out = buildSubnetIdleStake(
      [
        { stake_tao: "100", dividends: "0" },
        { stake_tao: "50", dividends: "0.001" },
      ],
      7,
    );
    assert.equal(out.idle_neuron_count, 1);
    assert.equal(out.idle_stake_tao, 100);
  });

  test("sums in rao-integer precision, avoiding float drift across many neurons", () => {
    const rows = Array.from({ length: 10_000 }, () => ({
      stake_tao: 0.1,
      dividends: 0,
    }));
    const out = buildSubnetIdleStake(rows, 7);
    assert.equal(out.idle_stake_tao, 1000);
  });
});

describe("buildChainIdleStake", () => {
  test("captured_at is the newest captured_at across every row, network-wide", () => {
    const out = buildChainIdleStake([
      { netuid: 1, stake_tao: 1, dividends: 0, captured_at: 1750000000000 },
      { netuid: 2, stake_tao: 1, dividends: 0, captured_at: 1750000060000 },
    ]);
    assert.equal(out.captured_at, new Date(1750000060000).toISOString());
  });

  test("groups by netuid and ranks subnets by idle_stake_tao descending", () => {
    const out = buildChainIdleStake([
      { netuid: 1, stake_tao: 10, dividends: 0 },
      { netuid: 2, stake_tao: 50, dividends: 0 },
      { netuid: 1, stake_tao: 5, dividends: 0.1 },
      { netuid: 2, stake_tao: 5, dividends: 0 },
    ]);
    assert.equal(out.subnet_count, 2);
    assert.deepEqual(
      out.subnets.map((s) => s.netuid),
      [2, 1],
    );
    assert.equal(out.subnets[0].idle_stake_tao, 55);
    assert.equal(out.subnets[0].neuron_count, 2);
    assert.equal(out.subnets[1].idle_stake_tao, 10);
    assert.equal(out.subnets[1].neuron_count, 2);
    assert.equal(out.total_idle_stake_tao, 65);
  });

  test("a tie in idle_stake_tao breaks by netuid ascending (stable, deterministic order)", () => {
    const out = buildChainIdleStake([
      { netuid: 2, stake_tao: 10, dividends: 0 },
      { netuid: 1, stake_tao: 10, dividends: 0 },
    ]);
    assert.deepEqual(
      out.subnets.map((s) => s.netuid),
      [1, 2],
    );
  });

  test("a row with a non-integer netuid is skipped, not thrown on", () => {
    const out = buildChainIdleStake([
      { netuid: "not-a-number", stake_tao: 10, dividends: 0 },
    ]);
    assert.equal(out.subnet_count, 0);
  });

  test("empty/cold rows yield a schema-stable zero, never throws", () => {
    for (const rows of [[], null, undefined]) {
      const out = buildChainIdleStake(rows);
      assert.equal(out.subnet_count, 0);
      assert.equal(out.total_idle_stake_tao, 0);
      assert.deepEqual(out.subnets, []);
    }
  });
});
