import assert from "node:assert/strict";
import { describe, test, vi } from "vitest";
import {
  buildTurnover,
  buildTurnoverChanges,
  loadSubnetTurnover,
} from "../src/turnover.mjs";

describe("buildTurnover", () => {
  test("two distinct snapshot dates still compute a real score (the #6352 guard is not over-broad)", () => {
    const rows = [
      { snapshot_date: "2026-06-01", hotkey: "A", uid: 1, validator_permit: 1 },
      { snapshot_date: "2026-06-30", hotkey: "A", uid: 1, validator_permit: 1 },
    ];
    const data = buildTurnover(rows, 7, {
      window: "30d",
      startDate: "2026-06-01",
      endDate: "2026-06-30",
    });
    assert.equal(data.comparable, true);
    assert.equal(data.validator_retention, 1);
    assert.equal(data.stability_score, 100);
  });

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

  test("rows present but neither boundary date resolves is not comparable (#2415)", () => {
    // Only a mid-window snapshot exists; the requested boundary dates have no
    // rows. jaccard(empty, empty) = 1 must NOT surface as perfect retention.
    const data = buildTurnover(
      [
        {
          snapshot_date: "2026-06-15",
          uid: 0,
          hotkey: "H0",
          validator_permit: 1,
        },
      ],
      1,
      { window: "30d", startDate: "2026-06-01", endDate: "2026-06-30" },
    );
    assert.equal(data.comparable, false);
    assert.equal(data.validator_retention, null);
    assert.equal(data.neuron_retention, null);
    assert.equal(data.stability_score, null);
    assert.equal(data.validators_start, 0);
    assert.equal(data.neurons_end, 0);
  });

  test("a missing end snapshot is not read as total churn (#2415)", () => {
    // Start resolves, end does not — without the guard this would report
    // validator_retention 0 (everyone "exited") instead of no-data.
    const data = buildTurnover(
      [
        {
          snapshot_date: "2026-06-01",
          uid: 0,
          hotkey: "V1",
          validator_permit: 1,
        },
      ],
      1,
      { window: "30d", startDate: "2026-06-01", endDate: "2026-06-30" },
    );
    assert.equal(data.comparable, false);
    assert.equal(data.validator_retention, null);
    assert.equal(data.stability_score, null);
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

  // #6352: this case previously asserted the fabricated scores the guard now
  // prevents (validator_retention 1 / neuron_retention 1 / stability_score 100
  // from scoring a snapshot against itself). comparable:false was already set,
  // but a caller not checking that flag read a flawless subnet.
  test("a single snapshot (start === end) is not comparable and scores null, not a trivial 100", () => {
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
    assert.equal(data.validator_retention, null);
    assert.equal(data.uids_deregistered, 0);
    assert.equal(data.neuron_retention, null);
    assert.equal(data.stability_score, null);
  });

  test("blank uid cells are skipped (not counted as uid 0)", () => {
    // Mirrors the blank-cell guard in subnet-yield.mjs (#3022): Number("") is 0.
    for (const blank of ["", "   "]) {
      const data = buildTurnover(
        [
          {
            snapshot_date: "2026-06-01",
            uid: blank,
            hotkey: "H0",
            validator_permit: 0,
          },
          {
            snapshot_date: "2026-06-30",
            uid: 1,
            hotkey: "H1",
            validator_permit: 0,
          },
        ],
        7,
        {
          window: "30d",
          startDate: "2026-06-01",
          endDate: "2026-06-30",
        },
      );
      assert.equal(
        data.neurons_start,
        0,
        `neurons_start for uid ${JSON.stringify(blank)}`,
      );
      assert.equal(data.neurons_end, 1);
    }
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

describe("buildTurnoverChanges", () => {
  // #6352: same missing guard. Comparing a snapshot to itself yields zero
  // entered/exited/reassigned, which reads as "no churn observed" rather than
  // "not comparable".
  test("a single snapshot (start === end) with rows yields the empty changes block", () => {
    const day = "2026-06-30";
    const rows = [
      { snapshot_date: day, hotkey: "A", uid: 1, validator_permit: 1 },
      { snapshot_date: day, hotkey: "B", uid: 2, validator_permit: 1 },
    ];
    const data = buildTurnoverChanges(rows, 7, {
      window: "30d",
      startDate: day,
      endDate: day,
    });
    assert.equal(data.comparable, false);
    assert.deepEqual(data.validators_entered, []);
    assert.deepEqual(data.validators_exited, []);
    assert.deepEqual(data.uid_reassignments, []);
    assert.equal(data.validators_entered_count, 0);
    assert.equal(data.validators_exited_count, 0);
    assert.equal(data.uid_reassignment_count, 0);
  });

  test("cold / empty / non-array inputs yield schema-stable empty detail", () => {
    for (const rows of [[], null, undefined]) {
      const data = buildTurnoverChanges(rows, 7, { window: "30d" });
      assert.equal(data.netuid, 7);
      assert.equal(data.comparable, false);
      assert.equal(data.validators_entered_count, 0);
      assert.deepEqual(data.validators_entered, []);
      assert.deepEqual(data.validators_exited, []);
      assert.deepEqual(data.uid_reassignments, []);
    }
  });

  test("rows present but neither boundary date resolves yields empty detail (#2415)", () => {
    const data = buildTurnoverChanges(
      [
        {
          snapshot_date: "2026-06-15",
          uid: 0,
          hotkey: "H0",
          validator_permit: 1,
        },
      ],
      7,
      { window: "30d", startDate: "2026-06-01", endDate: "2026-06-30" },
    );
    assert.equal(data.comparable, false);
    assert.equal(data.validators_entered_count, 0);
    assert.deepEqual(data.validators_entered, []);
    assert.deepEqual(data.validators_exited, []);
    assert.deepEqual(data.uid_reassignments, []);
  });

  test("blank uid cells do not fabricate uid 0 in validator change lists", () => {
    const data = buildTurnoverChanges(
      [
        {
          snapshot_date: "2026-06-01",
          uid: 1,
          hotkey: "VOLD",
          validator_permit: 1,
        },
        {
          snapshot_date: "2026-06-30",
          uid: 1,
          hotkey: "VOLD",
          validator_permit: 1,
        },
        {
          snapshot_date: "2026-06-30",
          uid: "",
          hotkey: "VNEW",
          validator_permit: 1,
        },
      ],
      9,
      {
        window: "30d",
        startDate: "2026-06-01",
        endDate: "2026-06-30",
      },
    );
    assert.equal(data.validators_entered_count, 1);
    assert.equal(data.validators_entered[0].hotkey, "VNEW");
    assert.equal(data.validators_entered[0].uid, null);
  });

  test("lists validator entries, exits, and UID reassignments", () => {
    const data = buildTurnoverChanges(
      [
        {
          snapshot_date: "2026-06-01",
          uid: "0",
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
        {
          snapshot_date: "2026-06-01",
          uid: 3,
          hotkey: "V4",
          validator_permit: 1,
        },
        {
          snapshot_date: "2026-06-30",
          uid: "0",
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
        {
          snapshot_date: "2026-06-30",
          uid: 4,
          hotkey: "V0",
          validator_permit: 1,
        },
      ],
      9,
      {
        window: "30d",
        startDate: "2026-06-01",
        endDate: "2026-06-30",
      },
    );
    assert.equal(data.comparable, true);
    assert.equal(data.validators_entered_count, 2);
    assert.equal(data.validators_exited_count, 2);
    assert.deepEqual(data.validators_entered, [
      { hotkey: "V0", uid: 4 },
      { hotkey: "V3", uid: 1 },
    ]);
    assert.deepEqual(data.validators_exited, [
      { hotkey: "V2", uid: 1 },
      { hotkey: "V4", uid: 3 },
    ]);
    assert.deepEqual(data.uid_reassignments, [
      { uid: 1, from_hotkey: "V2", to_hotkey: "V3" },
    ]);
  });
});

describe("turnover loaders", () => {
  function d1(rowsBySql = {}, captures = { sql: [], params: [] }) {
    return async (sql, params) => {
      captures.sql.push(sql);
      captures.params.push(params);
      for (const [pattern, rows] of Object.entries(rowsBySql)) {
        if (new RegExp(pattern).test(sql)) return rows;
      }
      return [];
    };
  }

  test("loadSubnetTurnover returns schema-stable empty on cold D1", async () => {
    const data = await loadSubnetTurnover(d1(), 7, {
      windowLabel: "30d",
      windowDays: 30,
    });
    assert.equal(data.netuid, 7);
    assert.equal(data.window, "30d");
    assert.equal(data.comparable, false);
    assert.equal(data.validator_retention, null);
    assert.equal(data.stability_score, null);
  });

  test("loadSubnetTurnover computes churn between boundary snapshots", async () => {
    const data = await loadSubnetTurnover(
      d1({
        "MIN\\(snapshot_date\\)": [
          { start_date: "2026-06-01", end_date: "2026-06-30" },
        ],
        "snapshot_date IN": [
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
        ],
      }),
      9,
      { windowLabel: "30d", windowDays: 30 },
    );
    assert.equal(data.comparable, true);
    assert.equal(data.start_date, "2026-06-01");
    assert.equal(data.end_date, "2026-06-30");
    assert.equal(data.validators_entered, 1);
    assert.equal(data.validators_exited, 1);
    assert.equal(data.uids_deregistered, 1);
    assert.equal(data.stability_score, 42);
  });

  test("loadSubnetTurnover omits the date cutoff for the all window", async () => {
    const captures = { sql: [], params: [] };
    await loadSubnetTurnover(
      d1(
        {
          "MIN\\(snapshot_date\\)": [
            { start_date: "2026-06-01", end_date: "2026-06-30" },
          ],
          "snapshot_date IN": [],
        },
        captures,
      ),
      9,
      { windowLabel: "all", windowDays: null },
    );
    assert.match(captures.sql[0], /MIN\(snapshot_date\)/);
    assert.deepEqual(captures.params[0], [9]);
    assert.doesNotMatch(captures.sql[0], /snapshot_date >=/);
  });

  test("anchors the window to the newest stored snapshot for the subnet, not wall clock", async () => {
    // Worker clock is mid-2026 but the store's newest snapshot is months older; a
    // now-relative cutoff would return comparable:false despite real churn data.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-30T12:00:00.000Z"));
    const captures = { sql: [], params: [] };
    const data = await loadSubnetTurnover(
      d1(
        {
          "MIN\\(snapshot_date\\)": [
            { start_date: "2026-01-01", end_date: "2026-01-31" },
          ],
          "snapshot_date IN": [
            {
              snapshot_date: "2026-01-01",
              uid: 0,
              hotkey: "V1",
              validator_permit: 1,
            },
            {
              snapshot_date: "2026-01-31",
              uid: 0,
              hotkey: "V2",
              validator_permit: 1,
            },
          ],
        },
        captures,
      ),
      9,
      { windowLabel: "30d", windowDays: 30 },
    );
    assert.match(captures.sql[0], /date\(MAX\(snapshot_date\), \?\)/);
    assert.equal(captures.params[0][0], 9);
    assert.equal(captures.params[0][1], "-30 days");
    assert.equal(captures.params[0][2], 9);
    assert.equal(data.start_date, "2026-01-01");
    assert.equal(data.end_date, "2026-01-31");
    assert.equal(data.comparable, true);
    assert.equal(data.validators_entered, 1);
    vi.useRealTimers();
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

  test("neuron_retention rounds to < 1 when sub-perfect jaccard would otherwise round up to 1 (round() clamp path)", () => {
    // 20000 neurons at start, 19999 at end (1 exits): jaccard = 19999/20000 = 0.99995,
    // which Math.round(0.99995 * 10000) = 10000 / 10000 = 1 without the clamp.
    // The round() guard must intercept it and return 0.9999 (not 1).
    const rows = [];
    for (let uid = 0; uid < 20000; uid++) {
      rows.push({
        snapshot_date: "2026-05-01",
        uid,
        hotkey: `M${uid}`,
        validator_permit: 0,
      });
    }
    for (let uid = 0; uid < 19999; uid++) {
      rows.push({
        snapshot_date: "2026-06-01",
        uid,
        hotkey: `M${uid}`,
        validator_permit: 0,
      });
    }
    const data = buildTurnover(rows, 1, {
      window: "30d",
      startDate: "2026-05-01",
      endDate: "2026-06-01",
    });
    assert.ok(
      data.neuron_retention < 1,
      "sub-perfect retention must not round up to 1",
    );
    assert.equal(data.neuron_retention, 0.9999); // clamped; naïve Math.round gives 1
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
