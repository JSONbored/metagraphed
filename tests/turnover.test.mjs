import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { buildTurnover } from "../src/turnover.mjs";

describe("buildTurnover", () => {
  test("cold / empty / no-boundary rows yield a schema-stable empty block", () => {
    for (const opts of [
      { window: "30d" },
      { window: "30d", startDate: null, endDate: null },
      { window: "30d", startDate: "2026-06-01", endDate: "2026-06-30" }, // dates but no rows
    ]) {
      const data = buildTurnover([], 7, opts);
      assert.equal(data.netuid, 7);
      assert.equal(data.comparable, false);
      assert.equal(data.validators_entered, 0);
      assert.equal(data.validator_retention, null);
      assert.equal(data.neuron_retention, null);
      assert.equal(data.stability_score, null);
    }
  });

  test("computes validator churn, deregistrations, and retention between two snapshots", () => {
    const rows = [
      // start: validators V1 (uid0), V2 (uid1); miner M1 (uid2)
      {
        snapshot_date: "2026-06-01",
        uid: 0,
        hotkey: "V1",
        validator_permit: 1,
      },
      {
        snapshot_date: "2026-06-01",
        uid: 1,
        hotkey: "V2",
        validator_permit: 1,
      },
      {
        snapshot_date: "2026-06-01",
        uid: 2,
        hotkey: "M1",
        validator_permit: 0,
      },
      // end: V1 retained; uid1's key swapped V2→V3 (a dereg) and V3 holds a permit;
      // miner M1 retained.
      {
        snapshot_date: "2026-06-30",
        uid: 0,
        hotkey: "V1",
        validator_permit: 1,
      },
      {
        snapshot_date: "2026-06-30",
        uid: 1,
        hotkey: "V3",
        validator_permit: 1,
      },
      {
        snapshot_date: "2026-06-30",
        uid: 2,
        hotkey: "M1",
        validator_permit: 0,
      },
    ];
    const data = buildTurnover(rows, 9, {
      window: "30d",
      startDate: "2026-06-01",
      endDate: "2026-06-30",
    });
    assert.equal(data.comparable, true);
    assert.equal(data.start_date, "2026-06-01");
    assert.equal(data.end_date, "2026-06-30");
    assert.equal(data.validators_start, 2); // V1, V2
    assert.equal(data.validators_end, 2); // V1, V3
    assert.equal(data.validators_entered, 1); // V3
    assert.equal(data.validators_exited, 1); // V2
    assert.equal(data.validator_retention, 0.3333); // {V1} / {V1,V2,V3}
    assert.equal(data.neurons_start, 3);
    assert.equal(data.neurons_end, 3);
    assert.equal(data.uids_deregistered, 1); // uid1: V2 → V3
    assert.equal(data.neuron_retention, 0.5); // {0:V1,2:M1} of 4 distinct ids
    assert.equal(data.stability_score, 42); // round((0.3333 + 0.5)/2 * 100)
  });

  test("a single snapshot (start === end) is flagged not comparable but trivially stable", () => {
    const rows = [
      {
        snapshot_date: "2026-06-30",
        uid: 0,
        hotkey: "V1",
        validator_permit: 1,
      },
      {
        snapshot_date: "2026-06-30",
        uid: 1,
        hotkey: "M1",
        validator_permit: 0,
      },
    ];
    const data = buildTurnover(rows, 1, {
      window: "7d",
      startDate: "2026-06-30",
      endDate: "2026-06-30",
    });
    assert.equal(data.comparable, false);
    assert.equal(data.validators_entered, 0);
    assert.equal(data.validators_exited, 0);
    assert.equal(data.validator_retention, 1);
    assert.equal(data.uids_deregistered, 0);
    assert.equal(data.neuron_retention, 1);
    assert.equal(data.stability_score, 100);
  });

  test("a fully-rotated validator set scores zero retention", () => {
    const rows = [
      { snapshot_date: "2026-05-01", uid: 0, hotkey: "A", validator_permit: 1 },
      { snapshot_date: "2026-06-01", uid: 0, hotkey: "B", validator_permit: 1 },
    ];
    const data = buildTurnover(rows, 1, {
      window: "30d",
      startDate: "2026-05-01",
      endDate: "2026-06-01",
    });
    assert.equal(data.validators_entered, 1);
    assert.equal(data.validators_exited, 1);
    assert.equal(data.validator_retention, 0); // {A} vs {B}, disjoint
    assert.equal(data.uids_deregistered, 1); // uid0: A → B
    assert.equal(data.neuron_retention, 0);
    assert.equal(data.stability_score, 0);
  });

  test("an all-miner subnet has empty validator sets → retention 1 (nothing to lose)", () => {
    const rows = [
      {
        snapshot_date: "2026-05-01",
        uid: 0,
        hotkey: "M1",
        validator_permit: 0,
      },
      {
        snapshot_date: "2026-06-01",
        uid: 0,
        hotkey: "M1",
        validator_permit: 0,
      },
    ];
    const data = buildTurnover(rows, 1, {
      window: "30d",
      startDate: "2026-05-01",
      endDate: "2026-06-01",
    });
    assert.equal(data.validators_start, 0);
    assert.equal(data.validators_end, 0);
    assert.equal(data.validator_retention, 1); // jaccard(∅, ∅) := 1
    assert.equal(data.neuron_retention, 1); // {0:M1} retained
    assert.equal(data.stability_score, 100);
  });

  test("rows without a hotkey are skipped from both the validator set and the map", () => {
    const rows = [
      {
        snapshot_date: "2026-05-01",
        uid: 0,
        hotkey: null,
        validator_permit: 1,
      },
      {
        snapshot_date: "2026-06-01",
        uid: 0,
        hotkey: "V1",
        validator_permit: 1,
      },
    ];
    const data = buildTurnover(rows, 1, {
      window: "30d",
      startDate: "2026-05-01",
      endDate: "2026-06-01",
    });
    assert.equal(data.validators_start, 0); // null hotkey skipped
    assert.equal(data.validators_end, 1); // V1
    assert.equal(data.neurons_start, 0);
    assert.equal(data.neurons_end, 1);
  });
});
