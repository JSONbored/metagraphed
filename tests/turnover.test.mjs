import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { buildTurnover } from "../src/turnover.mjs";

describe("buildTurnover", () => {
  test("cold / empty / non-array / no-window inputs yield a schema-stable empty block", () => {
    const cases = [
      { rows: [], opts: { window: "30d" } },
      { rows: [], opts: { window: "30d", startDate: null, endDate: null } },
      // dates present but no rows:
      {
        rows: [],
        opts: { window: "30d", startDate: "2026-06-01", endDate: "2026-06-30" },
      },
      // non-array rows → coerced to []:
      {
        rows: null,
        opts: { window: "7d", startDate: "2026-06-01", endDate: "2026-06-30" },
      },
      { rows: undefined, opts: {} }, // also exercises the window ?? null default
    ];
    for (const { rows, opts } of cases) {
      const data = buildTurnover(rows, 7, opts);
      assert.equal(data.netuid, 7);
      assert.equal(data.comparable, false);
      assert.equal(data.validators_entered, 0);
      assert.equal(data.validator_retention, null);
      assert.equal(data.neuron_retention, null);
      assert.equal(data.stability_score, null);
    }
    // An omitted window resolves to null in the envelope.
    assert.equal(buildTurnover([], 7, {}).window, null);
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

describe("buildTurnover — invariants", () => {
  test("retentions are in [0,1], stability in [0,100], and entered/exited stay consistent with the set sizes", () => {
    const rows = [
      {
        snapshot_date: "2026-05-01",
        uid: 0,
        hotkey: "V1",
        validator_permit: 1,
      },
      {
        snapshot_date: "2026-05-01",
        uid: 1,
        hotkey: "V2",
        validator_permit: 1,
      },
      {
        snapshot_date: "2026-06-01",
        uid: 0,
        hotkey: "V1",
        validator_permit: 1,
      },
      {
        snapshot_date: "2026-06-01",
        uid: 1,
        hotkey: "V3",
        validator_permit: 1,
      },
    ];
    const data = buildTurnover(rows, 1, {
      window: "30d",
      startDate: "2026-05-01",
      endDate: "2026-06-01",
    });
    assert.ok(data.validator_retention >= 0 && data.validator_retention <= 1);
    assert.ok(data.neuron_retention >= 0 && data.neuron_retention <= 1);
    assert.ok(data.stability_score >= 0 && data.stability_score <= 100);
    // retained validators == start − exited == end − entered (set-diff identity).
    assert.equal(
      data.validators_start - data.validators_exited,
      data.validators_end - data.validators_entered,
    );
  });
});

describe("buildTurnover — regressions", () => {
  test("a validator that moves UID slot but keeps its hotkey is retained (keyed by hotkey)", () => {
    const rows = [
      {
        snapshot_date: "2026-05-01",
        uid: 0,
        hotkey: "V1",
        validator_permit: 1,
      },
      {
        snapshot_date: "2026-06-01",
        uid: 7,
        hotkey: "V1",
        validator_permit: 1,
      }, // same key, new UID
    ];
    const data = buildTurnover(rows, 1, {
      window: "30d",
      startDate: "2026-05-01",
      endDate: "2026-06-01",
    });
    assert.equal(data.validators_entered, 0); // V1 still validates
    assert.equal(data.validators_exited, 0);
    assert.equal(data.validator_retention, 1);
    // The UID→hotkey identity changed (uid 0 → uid 7), so the neuron set churned.
    assert.equal(data.uids_deregistered, 0); // no UID present at both with a new key
    assert.equal(data.neuron_retention, 0);
  });

  test("a sub-perfect retention mean must not round stability_score up to a perfect 100", () => {
    // A fully-retained validator set (retention 1.0) plus ~1% neuron churn yields a
    // mean of ~0.995, which a bare Math.round lifts to 100 — reporting flawless
    // stability for a subnet that demonstrably rotated. Build 100 retained neurons
    // (one of them a retained validator) and one brand-new neuron at the end:
    // neuron_retention = 100/101 ≈ 0.9901, mean ≈ 0.99505 → must clamp to 99.
    const rows = [];
    for (let uid = 0; uid < 100; uid += 1) {
      const validator_permit = uid === 0 ? 1 : 0;
      rows.push({
        snapshot_date: "2026-05-01",
        uid,
        hotkey: `H${uid}`,
        validator_permit,
      });
      rows.push({
        snapshot_date: "2026-06-01",
        uid,
        hotkey: `H${uid}`,
        validator_permit,
      });
    }
    // A new neuron appears only at the end → union 101, intersection 100.
    rows.push({
      snapshot_date: "2026-06-01",
      uid: 100,
      hotkey: "Hnew",
      validator_permit: 0,
    });
    const data = buildTurnover(rows, 1, {
      window: "30d",
      startDate: "2026-05-01",
      endDate: "2026-06-01",
    });
    assert.equal(data.validator_retention, 1); // the lone validator is retained
    assert.equal(data.neuron_retention, 0.9901); // 100/101, churned
    assert.equal(data.stability_score, 99); // clamped, never an overstated 100
  });

  test("a validator that loses its permit counts as exited; its neuron stays retained", () => {
    const rows = [
      {
        snapshot_date: "2026-05-01",
        uid: 0,
        hotkey: "V1",
        validator_permit: 1,
      },
      {
        snapshot_date: "2026-06-01",
        uid: 0,
        hotkey: "V1",
        validator_permit: 0,
      }, // demoted
    ];
    const data = buildTurnover(rows, 1, {
      window: "30d",
      startDate: "2026-05-01",
      endDate: "2026-06-01",
    });
    assert.equal(data.validators_start, 1);
    assert.equal(data.validators_end, 0);
    assert.equal(data.validators_exited, 1); // dropped from the validator set
    assert.equal(data.validator_retention, 0);
    assert.equal(data.uids_deregistered, 0); // uid 0 kept its hotkey
    assert.equal(data.neuron_retention, 1); // {0:V1} retained
  });
});
