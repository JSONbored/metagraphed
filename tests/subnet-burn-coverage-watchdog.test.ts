// The coverage alarm for subnet_burn_history (#10308).
//
// The case that matters is the one production actually produced: a tick that
// is RECENT and SHORT. `table-freshness` read the table as 0.09h fresh
// throughout the 34-hour loss because three of 129 netuids kept writing, and
// `lane_health` said `captured 129` because the lane counted rows read rather
// than written. So the assertions below are mostly about that one state --
// everything else is boundary work around it.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  SUBNET_BURN_COVERAGE_FLOOR_RATIO,
  SUBNET_BURN_COVERAGE_LANE,
  SUBNET_BURN_COVERAGE_TABLES,
  SUBNET_BURN_COVERAGE_THRESHOLD_MS,
  evaluateSubnetBurnCoverage,
  runSubnetBurnCoverageWatchdog,
} from "../src/subnet-burn-coverage-watchdog.ts";

const NOW = 1_786_300_000_000;

const verdict = (
  over: Partial<Parameters<typeof evaluateSubnetBurnCoverage>[0]> = {},
) =>
  evaluateSubnetBurnCoverage({
    latestObservedAtMs: NOW - 60_000,
    coveredNetuids: 129,
    expectedNetuids: 129,
    nowMs: NOW,
    thresholdMs: SUBNET_BURN_COVERAGE_THRESHOLD_MS,
    coverageFloorRatio: SUBNET_BURN_COVERAGE_FLOOR_RATIO,
    ...over,
  });

describe("the state that read as healthy for 34 hours", () => {
  test("a RECENT tick carrying 3 of 129 netuids is stale, reason partial", () => {
    // The exact production numbers. A freshness check passes this; that is the
    // whole reason this module exists.
    const out = verdict({ coveredNetuids: 3 });
    assert.equal(out.stale, true);
    assert.equal(out.reason, "partial");
    assert.equal(out.covered_netuids, 3);
    assert.equal(out.expected_netuids, 129);
  });

  test("a complete tick is not stale", () => {
    const out = verdict();
    assert.equal(out.stale, false);
    assert.equal(out.reason, null);
  });

  test("the floor tracks the live subnet set, it is not a constant", () => {
    // 129 is today's count and the network sits at SubnetLimit, so every
    // registration evicts one. A hand-set floor would be wrong on first churn.
    const shrunk = verdict({ coveredNetuids: 100, expectedNetuids: 100 });
    assert.equal(shrunk.stale, false, "100 of 100 is complete");
    assert.equal(shrunk.coverage_floor_netuids, 95);
    const grown = verdict({ coveredNetuids: 129, expectedNetuids: 200 });
    assert.equal(grown.stale, true, "129 of 200 is not");
  });
});

describe("the ladder's order", () => {
  test("a DEAD lane reports stale, not partial -- the producer is the headline", () => {
    // With nothing written in hours, the coverage number describes an old tick.
    const out = verdict({
      latestObservedAtMs: NOW - 5 * SUBNET_BURN_COVERAGE_THRESHOLD_MS,
      coveredNetuids: 3,
    });
    assert.equal(out.reason, "stale");
  });

  test("an empty table is a stall of infinite age, not a healthy quiet one", () => {
    const out = verdict({ latestObservedAtMs: null });
    assert.equal(out.stale, true);
    assert.equal(out.reason, "no_rows");
    assert.equal(out.age_ms, null);
  });

  test("an unreadable subnet set SKIPS the clause rather than dividing by nothing", () => {
    // A floor of zero marks every tick complete, including no tick at all --
    // and subnet_hyperparams has its own lane, so restating its verdict here
    // would put two lanes' names on one fault.
    const out = verdict({ coveredNetuids: 0, expectedNetuids: 0 });
    assert.equal(out.coverage_floor_netuids, null);
    assert.equal(out.stale, false);
    assert.equal(out.reason, null);
  });

  test("exactly at the floor passes; one under does not", () => {
    assert.equal(
      verdict({ coveredNetuids: 123 }).stale,
      false,
      "123/129 == floor",
    );
    assert.equal(verdict({ coveredNetuids: 122 }).stale, true);
  });
});

describe("the lane record", () => {
  function fakeEnv(row: Record<string, unknown> | undefined) {
    const recorded: unknown[] = [];
    const db = {
      prepare: () => ({ all: async () => ({ results: row ? [row] : [] }) }),
    };
    return {
      recorded,
      env: {
        NEON_SOLE_STORE_TABLES: SUBNET_BURN_COVERAGE_TABLES.join(","),
        HYPERDRIVE: { connectionString: "postgres://x" },
        __db: db,
      } as unknown as Env,
      record: async (_db: unknown, r: unknown) => {
        recorded.push(r);
        return true;
      },
    };
  }

  test("the detail carries the NUMBERS, not just the word", async () => {
    // "stale" alone sends an operator looking for a dead lane; "3 of 129
    // netuids (partial)" is the finding itself.
    const f = fakeEnv({ latest: NOW - 60_000, covered: 3, expected: 129 });
    // readStore resolves from env; when it declines the watchdog returns null,
    // which is a legitimate outcome this test does not exercise.
    const out = await runSubnetBurnCoverageWatchdog(f.env, {
      now: () => NOW,
      recordVerdict: f.record as never,
    });
    if (out === null) {
      assert.equal(f.recorded.length, 0, "a declined read records nothing");
      return;
    }
    assert.equal(out.reason, "partial");
    const rec = f.recorded[0] as {
      lane: string;
      verdict: string;
      detail: string;
    };
    assert.equal(rec.lane, SUBNET_BURN_COVERAGE_LANE);
    assert.equal(rec.verdict, "stale");
    assert.match(rec.detail, /3 of 129 netuids/);
    assert.match(rec.detail, /partial/);
  });

  test("both tables are declared -- readStore is all-or-nothing", () => {
    // A half-declared pair returns undefined, and the watchdog then reads as
    // silence rather than as a verdict. Naming both here is what makes the
    // neon-sole-store gate police them.
    assert.deepEqual(
      [...SUBNET_BURN_COVERAGE_TABLES],
      ["subnet_burn_history", "subnet_hyperparams"],
    );
  });
});
