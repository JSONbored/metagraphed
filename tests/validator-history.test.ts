import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { buildValidatorHistory } from "../src/validator-history.ts";
import { ValidatorHistoryArtifactSchema } from "../schemas-src/routes/validator-history.ts";
import type { Row } from "./row-type.ts";
import { handleRequest } from "../workers/api.ts";
import { createLocalArtifactEnv } from "../scripts/lib.ts";

const HOTKEY = "5G9hfkx9wGB1CLMT9WXkpHSAiYzjZb5o1Boyq4KAdDhjwrc5";

// Stub METAGRAPH_HEALTH_DB whose .all() returns the given rows and records the
// SQL — mirrors historyEnv in tests/neuron-history.test.ts.
function historyEnv(rows: Row[], captured: Row = {}) {
  return {
    ...createLocalArtifactEnv(),
    METAGRAPH_HEALTH_DB: {
      prepare(sql: string) {
        captured.sql = sql;
        return {
          bind(...params: unknown[]) {
            captured.params = params;
            return { all: () => Promise.resolve({ results: rows }) };
          },
        };
      },
    },
  };
}

const ctx = { waitUntil: (p: Promise<unknown>) => p };

describe("buildValidatorHistory", () => {
  test("shapes per-day aggregates", () => {
    const out = buildValidatorHistory(
      [
        {
          snapshot_date: "2026-06-20",
          subnet_count: 3,
          total_stake_tao: 1000,
          total_emission_tao: 12.3,
        },
      ],
      HOTKEY,
      { window: "90d" },
    ) as Row;
    assert.equal(out.schema_version, 1);
    assert.equal(out.hotkey, HOTKEY);
    assert.equal(out.window, "90d");
    assert.equal(out.point_count, 1);
    assert.equal(out.points[0].snapshot_date, "2026-06-20");
    assert.equal(out.points[0].subnet_count, 3);
    assert.equal(out.points[0].total_stake_tao, 1000);
    assert.equal(out.points[0].total_emission_tao, 12.3);
  });

  test("computes rewards_per_1000_tao from the day's totals", () => {
    const out = buildValidatorHistory(
      [
        {
          snapshot_date: "2026-06-20",
          subnet_count: 1,
          total_stake_tao: 2000,
          total_emission_tao: 10,
        },
      ],
      HOTKEY,
    ) as Row;
    // 10 / 2000 * 1000 = 5
    assert.equal(out.points[0].rewards_per_1000_tao, 5);
  });

  test("rewards_per_1000_tao is null when stake is zero, negative, or absent", () => {
    for (const total_stake_tao of [0, -5, null, undefined]) {
      const out = buildValidatorHistory(
        [
          {
            snapshot_date: "2026-06-20",
            total_stake_tao,
            total_emission_tao: 10,
          },
        ],
        HOTKEY,
      ) as Row;
      assert.equal(
        out.points[0].rewards_per_1000_tao,
        null,
        `total_stake_tao=${JSON.stringify(total_stake_tao)}`,
      );
    }
  });

  test("rewards_per_1000_tao is null when emission is absent, even with real stake", () => {
    const out = buildValidatorHistory(
      [
        {
          snapshot_date: "2026-06-20",
          total_stake_tao: 100,
          total_emission_tao: null,
        },
      ],
      HOTKEY,
    ) as Row;
    assert.equal(out.points[0].rewards_per_1000_tao, null);
  });

  test("rounds the per-day TAO sums to drop float noise", () => {
    const out = buildValidatorHistory(
      [
        {
          snapshot_date: "2026-06-20",
          total_stake_tao: 0.1 + 0.2, // 0.30000000000000004
          total_emission_tao: 1.005 + 2.005, // 3.0100000000000002
        },
      ],
      HOTKEY,
    ) as Row;
    assert.equal(out.points[0].total_stake_tao, 0.3);
    assert.equal(out.points[0].total_emission_tao, 3.01);
  });

  test("a null SUM (cold/sparse day) stays null, never coerced to 0", () => {
    const out = buildValidatorHistory(
      [
        {
          snapshot_date: "2026-06-19",
          total_stake_tao: null,
          total_emission_tao: null,
        },
      ],
      HOTKEY,
    ) as Row;
    assert.equal(out.points[0].total_stake_tao, null);
    assert.equal(out.points[0].total_emission_tao, null);
  });

  test("defaults window to null and every aggregate to null on a sparse row", () => {
    const out = buildValidatorHistory(
      [{ snapshot_date: "2026-06-20" }],
      HOTKEY,
    ) as Row;
    assert.equal(out.window, null);
    assert.equal(out.points[0].subnet_count, null);
    assert.equal(out.points[0].total_stake_tao, null);
    assert.equal(out.points[0].total_emission_tao, null);
    assert.equal(out.points[0].rewards_per_1000_tao, null);
  });

  test("coerces string-typed subnet_count to an integer", () => {
    const out = buildValidatorHistory(
      [{ snapshot_date: "2026-06-20", subnet_count: "3" }],
      HOTKEY,
    ) as Row;
    assert.equal(out.points[0].subnet_count, 3);
  });

  test("rejects an invalid subnet_count to null (negative, fractional, non-numeric, blank)", () => {
    for (const subnet_count of [-1, 1.5, "abc", "", "   "]) {
      const out = buildValidatorHistory(
        [{ snapshot_date: "2026-06-20", subnet_count }],
        HOTKEY,
      ) as Row;
      assert.equal(
        out.points[0].subnet_count,
        null,
        `subnet_count=${JSON.stringify(subnet_count)}`,
      );
    }
  });

  test("drops malformed (non-object) rows and the count tracks the array", () => {
    const out = buildValidatorHistory(
      [
        null,
        undefined,
        "nope",
        { snapshot_date: "2026-06-20" },
      ] as unknown as Row[],
      HOTKEY,
    ) as Row;
    assert.equal(out.point_count, 1);
    assert.equal(out.points.length, 1);
  });

  test("is cold-safe for non-array/empty input", () => {
    for (const rows of [[], null, undefined]) {
      const out = buildValidatorHistory(rows, HOTKEY) as Row;
      assert.equal(out.hotkey, HOTKEY);
      assert.equal(out.point_count, 0);
      assert.deepEqual(out.points, []);
    }
  });
});

describe("GET /api/v1/validators/{hotkey}/history via the Worker", () => {
  test("an unsupported ?window is a 400, never a silent coerce", async () => {
    const res = await handleRequest(
      new Request(
        `https://api.metagraph.sh/api/v1/validators/${HOTKEY}/history?window=400d`,
      ),
      historyEnv([]) as unknown as Env,
      ctx,
    );
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error.code, "invalid_query");
    assert.equal(body.meta.parameter, "window");
  });

  test("an unsupported query param is a 400", async () => {
    const res = await handleRequest(
      new Request(
        `https://api.metagraph.sh/api/v1/validators/${HOTKEY}/history?foo=bar`,
      ),
      historyEnv([]) as unknown as Env,
      ctx,
    );
    assert.equal(res.status, 400);
  });

  test("is schema-stable when D1 is cold (never 404)", async () => {
    const res = await handleRequest(
      new Request(
        `https://api.metagraph.sh/api/v1/validators/${HOTKEY}/history`,
      ),
      historyEnv([]) as unknown as Env,
      ctx,
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.data.points, []);
    assert.equal(body.data.point_count, 0);
  });
});

// #9383: the per-subnet scope. The unscoped series is unchanged — every assertion
// above still holds — and the scoped one answers the questions the totals hide.
describe("buildValidatorHistory — scoped to one subnet (#9383)", () => {
  const scopedRow = {
    snapshot_date: "2026-08-04",
    subnet_count: 1,
    netuid: 64,
    uid: 12,
    stake_alpha: 2120377.1,
    emission_alpha: 80.6312,
    validator_trust: 1,
    consensus: 0.4321,
    dividends: 0.54627,
    take: 0.18,
    validator_permit: 1,
    total_stake_tao: 179750.8,
    total_emission_tao: 6.83,
  };

  test("carries the per-subnet facts the totals hide", () => {
    const card = buildValidatorHistory([scopedRow], HOTKEY, {
      window: "30d",
      netuid: 64,
    });
    assert.equal(card.netuid, 64);
    const point = (card.points as Row[])[0];
    assert.equal(point.netuid, 64);
    assert.equal(point.uid, 12);
    assert.equal(point.validator_trust, 1);
    assert.equal(point.consensus, 0.4321);
    assert.equal(point.dividends, 0.54627);
    assert.equal(point.take, 0.18);
    assert.equal(point.validator_permit, true);
  });

  test("alpha is reported as alpha, beside the TAO conversion", () => {
    // #8945 is the standing reminder: an alpha value in a `*_tao` field is how
    // this goes wrong. Both units are present and they are NOT equal.
    const point = (
      buildValidatorHistory([scopedRow], HOTKEY, { netuid: 64 }).points as Row[]
    )[0];
    assert.equal(point.stake_alpha, 2120377.1);
    assert.equal(point.emission_alpha, 80.6312);
    assert.equal(point.total_stake_tao, 179750.8);
    assert.notEqual(point.stake_alpha, point.total_stake_tao);
    // The alpha-denominated reward rate, computed from the alpha pair rather
    // than borrowed from the TAO one.
    assert.equal(
      point.rewards_per_1000_alpha,
      Math.round((80.6312 / 2120377.1) * 1000 * 1e6) / 1e6,
    );
  });

  test("a lost permit is reported, not dropped", () => {
    // The scoped query deliberately omits the `validator_permit = 1` filter: a day
    // the permit was lost is the event an operator most needs, and filtering it
    // makes it indistinguishable from a day the poller missed.
    const point = (
      buildValidatorHistory([{ ...scopedRow, validator_permit: 0 }], HOTKEY, {
        netuid: 64,
      }).points as Row[]
    )[0];
    assert.equal(point.validator_permit, false);
    assert.equal(point.snapshot_date, "2026-08-04");
  });

  test("the unscoped series does NOT invent cross-subnet vTrust", () => {
    // Averaging vTrust across subnets would report a validator with 1.0 on one
    // subnet and 0.2 on another as "0.6", erasing the one signal that matters.
    const card = buildValidatorHistory([scopedRow], HOTKEY, { window: "30d" });
    assert.equal(card.netuid, null);
    const point = (card.points as Row[])[0];
    assert.ok(!("validator_trust" in point));
    assert.ok(!("consensus" in point));
    assert.ok(!("stake_alpha" in point));
    // The cross-subnet fields it DOES own are untouched.
    assert.equal(point.total_stake_tao, 179750.8);
    assert.equal(point.subnet_count, 1);
  });

  test("both shapes satisfy the published response schema", () => {
    // The point schema is .strict(), so an undeclared field fails the contract.
    for (const netuid of [64, null]) {
      const card = buildValidatorHistory([scopedRow], HOTKEY, {
        window: "30d",
        netuid,
      });
      const parsed = ValidatorHistoryArtifactSchema.safeParse(card);
      assert.equal(
        parsed.success,
        true,
        parsed.success
          ? ""
          : `netuid=${netuid}: ${JSON.stringify(parsed.error.issues)}`,
      );
    }
  });

  test("a null-heavy scoped row degrades to nulls, never to zeroes", () => {
    const point = (
      buildValidatorHistory(
        [{ snapshot_date: "2026-08-04", netuid: 64 }],
        HOTKEY,
        { netuid: 64 },
      ).points as Row[]
    )[0];
    assert.equal(point.validator_trust, null);
    assert.equal(point.stake_alpha, null);
    assert.equal(point.validator_permit, null);
    assert.equal(point.rewards_per_1000_alpha, null);
  });
});

// #9390: take-change detection and dividend efficiency.
describe("buildValidatorHistory — operator signals (#9390)", () => {
  // The REAL series measured on 5G9hfkx9…/netuid 4, newest first. The take never
  // changed; a float diff reports four changes.
  const REAL_TAKE_SERIES = [
    { snapshot_date: "2026-08-03", take: 0.009994659342336155 },
    { snapshot_date: "2026-08-02", take: 0.00999466 },
    { snapshot_date: "2026-07-20", take: 0.00999466 },
    { snapshot_date: "2026-07-19", take: 0.009994659 },
    { snapshot_date: "2026-07-17", take: 0.009994659 },
    { snapshot_date: "2026-07-16", take: 0 },
    { snapshot_date: "2026-07-14", take: 0 },
    { snapshot_date: "2026-07-13", take: null },
    { snapshot_date: "2026-07-10", take: null },
  ];

  test("three float renderings of one u16 are NOT a take change", () => {
    const card = buildValidatorHistory(REAL_TAKE_SERIES, HOTKEY, { netuid: 4 });
    assert.equal(card.take_u16, 655, "all three renderings are u16 655");
    assert.equal(
      card.take_last_changed_date,
      null,
      "this validator never changed its take",
    );
  });

  test("the leading null/0 run is not read as a take of zero", () => {
    // The column simply was not being captured yet. Reporting the step out of that run
    // would manufacture a change for every validator alive when capture started.
    const card = buildValidatorHistory(REAL_TAKE_SERIES, HOTKEY, { netuid: 4 });
    assert.equal(card.take_last_changed_date, null);
    assert.equal(card.next_take_change_eligible_date, null);
  });

  test("a REAL take change is detected and dated", () => {
    const card = buildValidatorHistory(
      [
        { snapshot_date: "2026-08-03", take: 0.18 },
        { snapshot_date: "2026-08-02", take: 0.18 },
        { snapshot_date: "2026-08-01", take: 0.009994659 },
        { snapshot_date: "2026-07-31", take: 0.009994659 },
      ],
      HOTKEY,
      { netuid: 4 },
    );
    assert.equal(card.take_last_changed_date, "2026-08-02");
    // + 216,000 blocks * 12s = exactly 30 days.
    assert.equal(card.next_take_change_eligible_date, "2026-09-01");
    assert.equal(card.take_change_observable, true);
  });

  test("a validator whose take is genuinely 0 throughout keeps its series", () => {
    const card = buildValidatorHistory(
      [
        { snapshot_date: "2026-08-03", take: 0 },
        { snapshot_date: "2026-08-02", take: 0 },
      ],
      HOTKEY,
      { netuid: 4 },
    );
    assert.equal(card.take_u16, 0);
    assert.equal(card.take_change_observable, true, "two usable readings");
  });

  test("a series too short to resolve a change says so", () => {
    const card = buildValidatorHistory(
      [{ snapshot_date: "2026-08-03", take: 0.18 }],
      HOTKEY,
      { netuid: 4 },
    );
    assert.equal(card.take_last_changed_date, null);
    assert.equal(
      card.take_change_observable,
      false,
      "one reading cannot show a change -- distinct from 'stable'",
    );
  });

  test("the unscoped series reports no take at all", () => {
    const card = buildValidatorHistory(REAL_TAKE_SERIES, HOTKEY, {});
    assert.equal(card.take_u16, null);
    assert.equal(card.take_change_observable, false);
  });

  test("dividend efficiency is dividend share over stake share", () => {
    const point = (
      buildValidatorHistory(
        [
          {
            snapshot_date: "2026-08-04",
            netuid: 64,
            stake_alpha: 2_118_872,
            subnet_total_stake: 3_899_868,
            dividends: 0.546273,
          },
        ],
        HOTKEY,
        { netuid: 64 },
      ).points as Row[]
    )[0];
    // 2,118,872 / 3,899,868 = 0.54331890… -> 0.543319 at 6dp
    assert.equal(point.stake_share, 0.543319);
    // 0.546273 / 0.543319 = 1.005437 -> earning slightly above its stake share
    assert.ok(
      Math.abs((point.dividend_efficiency as number) - 1.005437) < 1e-5,
    );
  });

  test("efficiency is null rather than Infinity when there is no stake", () => {
    for (const [stake, total] of [
      [0, 3_899_868],
      [100, 0],
      [100, null],
    ] as const) {
      const point = (
        buildValidatorHistory(
          [
            {
              snapshot_date: "2026-08-04",
              netuid: 64,
              stake_alpha: stake,
              subnet_total_stake: total,
              dividends: 0.5,
            },
          ],
          HOTKEY,
          { netuid: 64 },
        ).points as Row[]
      )[0];
      assert.equal(point.dividend_efficiency, null, `${stake}/${total}`);
    }
  });

  test("a point with an unusable snapshot_date is excluded from take detection", () => {
    // A row whose date cannot be read cannot be ordered, and an unorderable row in a
    // change-detection series would attribute the change to the wrong day.
    const card = buildValidatorHistory(
      [
        { snapshot_date: 20260803, take: 0.18 },
        { snapshot_date: "2026-08-02", take: 0.009994659 },
      ],
      HOTKEY,
      { netuid: 4 },
    );
    assert.equal(card.take_last_changed_date, null);
    assert.equal(card.take_change_observable, false, "one usable reading left");
  });

  test("the card still satisfies its published schema", () => {
    const card = buildValidatorHistory(REAL_TAKE_SERIES, HOTKEY, {
      window: "30d",
      netuid: 4,
    });
    const parsed = ValidatorHistoryArtifactSchema.safeParse(card);
    assert.equal(
      parsed.success,
      true,
      parsed.success ? "" : JSON.stringify(parsed.error.issues),
    );
  });
});
