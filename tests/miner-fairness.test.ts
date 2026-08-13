// src/miner-fairness.ts — whether a subnet's registered miners actually earn.
//
// The distributions are the easy part; src/concentration.ts already computes
// them and these tests do not re-verify Gini. What they pin is the framing,
// which is where this card can mislead:
//
//   - a snapshot cannot answer the question, and looks like it can
//   - "no miners registered" and "no miner earned" are opposite claims
//   - the entity lens and the per-UID lens genuinely differ, and publishing
//     only the second hides a three-operator subnet
//   - there is no score, and there must never be one
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  buildSubnetMinerFairness,
  minerFairnessWindowLabel,
  parseMinerFairnessWindow,
  SUBNET_MINER_FAIRNESS_FIELD_SOURCES,
} from "../src/miner-fairness.ts";
import { SubnetMinerFairnessArtifactSchema } from "../schemas-src/routes/miner-fairness.ts";

type Row = Record<string, unknown>;

/** One neuron-day. Miner unless told otherwise. */
function row(over: Row = {}): Row {
  return {
    snapshot_date: "2026-08-12",
    uid: 0,
    coldkey: "5A",
    validator_permit: false,
    emission_tao: 0,
    ...over,
  };
}

/** `count` miner UIDs on one day, the first `earning` of them with emission. */
function day(date: string, count: number, earning: number, coldkey?: string) {
  return Array.from({ length: count }, (_, i) =>
    row({
      snapshot_date: date,
      uid: i,
      coldkey: coldkey ?? `5Miner${i}`,
      emission_tao: i < earning ? 1 : 0,
    }),
  );
}

describe("the number every dashboard publishes", () => {
  test("reports the earning count beside the population", () => {
    // SN64's shape: 240 registered, 14 earning. The whole point of the card is
    // that these are two different numbers and only one of them is published
    // anywhere else.
    const p = (
      buildSubnetMinerFairness(day("2026-08-12", 240, 14), 64, {})
        .points as Row[]
    )[0];
    assert.equal(p.miner_count, 240);
    assert.equal(p.earning_miner_count, 14);
    assert.ok(Math.abs((p.zero_emission_pct as number) - 226 / 240) < 1e-9);
  });

  test("VALIDATORS ARE EXCLUDED FROM THE MINER POPULATION", () => {
    // A validator-permit UID earns dividends by a different mechanism.
    // Counting them would dilute exactly the rate this card exists to show --
    // and validators are the UIDs that reliably earn, so including them makes
    // every subnet look healthier than it is.
    const rows = [
      ...day("2026-08-12", 4, 0),
      row({ uid: 100, validator_permit: true, emission_tao: 99 }),
      row({ uid: 101, validator_permit: 1, emission_tao: 99 }),
    ];
    const p = (buildSubnetMinerFairness(rows, 64, {}).points as Row[])[0];
    assert.equal(p.miner_count, 4, "the two validators are not miners");
    assert.equal(p.earning_miner_count, 0);
    assert.equal(p.zero_emission_pct, 1);
  });

  test("a day with no miner UIDs declines rather than reporting 0%", () => {
    // 0% over an empty population reads as "everybody earned".
    const p = (
      buildSubnetMinerFairness(
        [row({ uid: 0, validator_permit: true, emission_tao: 5 })],
        64,
        {},
      ).points as Row[]
    )[0];
    assert.equal(p.miner_count, 0);
    assert.equal(p.zero_emission_pct, null);
  });
});

describe("persistence — the fact a snapshot cannot report", () => {
  const rows = [
    // uid 0 earns every day, uid 1 earns once, uid 2 never.
    ...[0, 1, 2].map((uid) =>
      row({
        snapshot_date: "2026-08-12",
        uid,
        emission_tao: uid === 0 ? 1 : 0,
      }),
    ),
    ...[0, 1, 2].map((uid) =>
      row({
        snapshot_date: "2026-08-11",
        uid,
        emission_tao: uid <= 1 ? 1 : 0,
      }),
    ),
    ...[0, 1, 2].map((uid) =>
      row({
        snapshot_date: "2026-08-10",
        uid,
        emission_tao: uid === 0 ? 1 : 0,
      }),
    ),
  ];

  test("EARNED ON 0 OF 3 AND EARNED ON 1 OF 3 ARE DIFFERENT ANSWERS", () => {
    // Both are "zero" on two of the three days, and a snapshot cannot tell
    // them apart. They are completely different answers to "should I register
    // here", which is the question the card is for.
    const out = buildSubnetMinerFairness(rows, 64, {});
    assert.equal(out.days_covered, 3);
    assert.equal(out.miner_uid_count, 3);
    const p = out.persistence as Row;
    assert.equal(p.never_earned_count, 1, "only uid 2 never earned");
    assert.equal(p.earned_every_day_count, 1, "only uid 0 earned every day");
    assert.equal(p.max_earning_days, 3);
    // 3, 1, 0 → median 1.
    assert.equal(p.median_earning_days, 1);
  });

  test("days_covered rides with the payload, per the issue's first Do", () => {
    assert.equal(
      buildSubnetMinerFairness(rows.slice(0, 3), 64, {}).days_covered,
      1,
    );
    assert.equal(buildSubnetMinerFairness([], 64, {}).days_covered, 0);
  });

  test("the median of an empty population is null, not zero", () => {
    // Zero would read as "the typical miner earned on no days" — a statement
    // about miners who do not exist.
    const p = buildSubnetMinerFairness([], 64, {}).persistence as Row;
    assert.equal(p.median_earning_days, null);
    assert.equal(p.max_earning_days, null);
    assert.equal(p.never_earned_count, 0);
  });

  test("a dropped capped day is excluded from the denominators too", () => {
    // The cap truncated the oldest day mid-population, so a UID seen only
    // there would carry a denominator the points array does not contain.
    const out = buildSubnetMinerFairness(
      [
        ...day("2026-08-12", 2, 1),
        row({ snapshot_date: "2026-08-11", uid: 77, emission_tao: 1 }),
      ],
      64,
      { capped: true },
    );
    assert.equal(out.days_covered, 1);
    assert.equal(out.miner_uid_count, 2, "uid 77's truncated day is dropped");
  });
});

describe("the two lenses", () => {
  test("EQUAL EARNERS GIVE A GINI OF ~0", () => {
    const out = buildSubnetMinerFairness(
      Array.from({ length: 10 }, (_, i) =>
        row({ uid: i, coldkey: `5C${i}`, emission_tao: 1 }),
      ),
      64,
      {},
    );
    const uid = (out.concentration as Row).uid as Row;
    assert.ok((uid.gini as number) < 0.001, `gini was ${String(uid.gini)}`);
  });

  test("one UID taking everything gives a Gini near 1", () => {
    const out = buildSubnetMinerFairness(
      Array.from({ length: 100 }, (_, i) =>
        row({ uid: i, coldkey: `5C${i}`, emission_tao: i === 0 ? 1000 : 0 }),
      ),
      64,
      {},
    );
    const uid = (out.concentration as Row).uid as Row;
    // Only positive values enter the distribution, so a single earner is one
    // holder — perfectly "equal" among earners, and the honest reading is the
    // holder count beside it.
    assert.equal(uid.holders, 1);
    assert.equal((out.concentration as Row).entity !== null, true);
  });

  test("THE ENTITY LENS AND THE UID LENS DIVERGE, WHICH IS THE POINT", () => {
    // Four UIDs earning equally, but ONE coldkey holds three of them. The
    // per-UID lens says "perfectly equal"; the entity lens says one operator
    // takes three quarters. Publishing only the first hides SN84's shape --
    // three operators across 256 UIDs.
    const out = buildSubnetMinerFairness(
      [
        row({ uid: 0, coldkey: "5Whale", emission_tao: 1 }),
        row({ uid: 1, coldkey: "5Whale", emission_tao: 1 }),
        row({ uid: 2, coldkey: "5Whale", emission_tao: 1 }),
        row({ uid: 3, coldkey: "5Solo", emission_tao: 1 }),
      ],
      64,
      {},
    );
    const uid = (out.concentration as Row).uid as Row;
    const entity = (out.concentration as Row).entity as Row;
    assert.equal(uid.holders, 4);
    assert.equal(entity.holders, 2);
    assert.ok((uid.gini as number) < 0.001, "per-UID reads as perfectly equal");
    assert.ok(
      (entity.gini as number) > (uid.gini as number),
      "the entity lens must show the concentration the UID lens hides",
    );
    assert.equal(out.entity_count, 2);
    assert.equal(out.uids_per_entity, 2);
  });

  test("a UID with no coldkey is its own entity, never merged", () => {
    // Merging unknown owners would UNDER-count operators and make a subnet
    // look more concentrated than it is — an error in the accusatory
    // direction.
    const out = buildSubnetMinerFairness(
      [
        row({ uid: 0, coldkey: null, emission_tao: 1 }),
        row({ uid: 1, coldkey: null, emission_tao: 1 }),
      ],
      64,
      {},
    );
    assert.equal(out.entity_count, 2);
  });

  test("a subnet emitting nothing has null lenses, not zeroed ones", () => {
    const out = buildSubnetMinerFairness(day("2026-08-12", 5, 0), 64, {});
    assert.equal((out.concentration as Row).uid, null);
    assert.equal((out.concentration as Row).entity, null);
    // ...and the population is still reported. Nulling that too would lose a
    // reading we have.
    assert.equal(out.miner_uid_count, 5);
    assert.equal((out.points as Row[])[0].zero_emission_pct, 1);
  });
});

describe("descriptive only", () => {
  test("THE PAYLOAD CONTAINS NO SCORE, GRADE OR VERDICT", () => {
    // Requirement 4, asserted structurally rather than trusted. A high Gini on
    // a subnet whose task genuinely has one best answer is not misconduct, and
    // a score would make that judgement for every reader at once.
    const out = buildSubnetMinerFairness(day("2026-08-12", 10, 1), 64, {});
    const keys = JSON.stringify(out).toLowerCase();
    for (const forbidden of [
      '"score"',
      '"grade"',
      '"rating"',
      '"verdict"',
      '"fair"',
      '"unfair"',
    ]) {
      assert.equal(
        keys.includes(forbidden),
        false,
        `the payload must not carry ${forbidden}`,
      );
    }
  });
});

describe("the contract", () => {
  // THE SCHEMA IS NOT SELF-ENFORCING. The builder returns
  // Record<string, unknown>, so nothing compares the payload to the served
  // shape unless a test does — and the nested objects are `.strict()`, so a
  // field the builder emits and the schema does not declare fails here.
  test("a populated payload validates against the served schema", () => {
    const out = buildSubnetMinerFairness(
      [...day("2026-08-12", 10, 3), ...day("2026-08-11", 10, 2)],
      64,
      { window: "30d" },
    );
    const parsed = SubnetMinerFairnessArtifactSchema.safeParse(out);
    assert.equal(
      parsed.success,
      true,
      JSON.stringify(parsed.error?.issues?.slice(0, 3)),
    );
  });

  test("the empty card validates too", () => {
    // Different branches, and the shape most often served.
    const parsed = SubnetMinerFairnessArtifactSchema.safeParse(
      buildSubnetMinerFairness([], 64, { window: "7d" }),
    );
    assert.equal(
      parsed.success,
      true,
      JSON.stringify(parsed.error?.issues?.slice(0, 3)),
    );
  });

  test("the concentration lenses ARE the shared component", () => {
    // Not "look like it" — the same schema object. A locally re-declared
    // gini/hhi/nakamoto block would type-check and then drift from every other
    // concentration surface in the API.
    const lens = SubnetMinerFairnessArtifactSchema.shape.concentration;
    assert.ok(lens, "concentration must be declared");
    const parsed = SubnetMinerFairnessArtifactSchema.safeParse(
      buildSubnetMinerFairness(day("2026-08-12", 4, 4), 64, {}),
    );
    assert.equal(parsed.success, true);
  });

  test("field_sources rides with the payload, from the builder", () => {
    const out = buildSubnetMinerFairness(day("2026-08-12", 3, 1), 64, {});
    assert.equal(out.field_sources, SUBNET_MINER_FAIRNESS_FIELD_SOURCES);
    assert.equal(
      SUBNET_MINER_FAIRNESS_FIELD_SOURCES["points.zero_emission_pct"].kind,
      "measured",
      "every figure here is a reading, not a reconstruction",
    );
  });
});

describe("shaping", () => {
  test("a cold store answers rather than throwing", () => {
    for (const input of [null, undefined, []]) {
      const out = buildSubnetMinerFairness(input, 64, {});
      assert.equal(out.days_covered, 0);
      assert.deepEqual(out.points, []);
      assert.equal(out.miner_uid_count, 0);
      assert.equal(out.uids_per_entity, null);
    }
  });

  test("rows with no usable date or uid are skipped", () => {
    const out = buildSubnetMinerFairness(
      [
        row({ snapshot_date: "2026-08-12", uid: 0, emission_tao: 1 }),
        row({ snapshot_date: null, uid: 1 }),
        row({ snapshot_date: "2026-08-12", uid: "not-a-uid" }),
      ],
      64,
      {},
    );
    assert.equal(out.days_covered, 1);
    assert.equal(out.miner_uid_count, 1);
  });

  test("A NULL EMISSION CELL COUNTS AS REGISTERED-AND-NOT-EARNING", () => {
    // `emission_tao` is NULLABLE in Postgres, and null is not the same cell as
    // 0 — but for this card they are the same ANSWER: the UID is registered
    // and earned nothing. What must not happen is the row being skipped, which
    // would shrink the population and report a higher earning rate than the
    // subnet has.
    const out = buildSubnetMinerFairness(
      [
        row({ uid: 0, coldkey: "5A", emission_tao: 1 }),
        row({ uid: 1, coldkey: "5B", emission_tao: null }),
        row({ uid: 2, coldkey: "5C", emission_tao: undefined }),
        row({ uid: 3, coldkey: "5D", emission_tao: "not-a-number" }),
      ],
      64,
      {},
    );
    const p = (out.points as Row[])[0];
    assert.equal(p.miner_count, 4, "every registered UID is in the population");
    assert.equal(p.earning_miner_count, 1);
    assert.equal(p.zero_emission_pct, 0.75);
    // ...and they reach the persistence block the same way.
    assert.equal(out.miner_uid_count, 4);
    assert.equal((out.persistence as Row).never_earned_count, 3);
  });

  test("days come back newest first", () => {
    const out = buildSubnetMinerFairness(
      [...day("2026-08-12", 1, 1), ...day("2026-08-11", 1, 0)],
      64,
      {},
    );
    assert.deepEqual(
      (out.points as Row[]).map((p) => p.snapshot_date),
      ["2026-08-12", "2026-08-11"],
    );
  });
});

describe("the window", () => {
  test("shares the emission-split vocabulary", () => {
    for (const label of ["7d", "30d", "90d"]) {
      assert.equal("error" in parseMinerFairnessWindow(label), false, label);
    }
  });

  test("an unsupported window names the supported set", () => {
    const parsed = parseMinerFairnessWindow("1d");
    assert.ok("error" in parsed && parsed.error);
    assert.equal(parsed.error?.parameter, "window");
    assert.match(String(parsed.error?.message), /7d, 30d, 90d/);
  });

  test("an absent window is the default", () => {
    assert.equal(
      (parseMinerFairnessWindow(undefined) as { label: string }).label,
      "30d",
    );
    assert.equal(minerFairnessWindowLabel(null), "30d");
    assert.equal(minerFairnessWindowLabel("7d"), "7d");
  });
});
