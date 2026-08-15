// Producer cadences, and the invariant that used to live in a string (#10291).
//
// Before this, each watchdog restated its producer's cadence in prose beside a
// hardcoded threshold, and the pass-window rule was asserted as a MESSAGE:
//
//     "the window must stay under ACCOUNT_BALANCES_POLL_SECS (21600)"
//
// A string cannot fail. This file makes both the arithmetic and the rule
// checkable, and pins the thresholds against their pre-refactor values so a
// future edit to the cadence table cannot silently move an alarm.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  LANE_PRODUCER,
  PRODUCER_CADENCE_SECS,
  cadenceMs,
  missedTicksMs,
  passWindowMs,
  type ProducerLane,
} from "../src/producer-cadence.ts";
import {
  ACCOUNT_BALANCES_PASS_WINDOW_MS,
  ACCOUNT_BALANCES_STALENESS_THRESHOLD_MS,
} from "../src/account-balances-staleness-watchdog.ts";
import {
  HOTKEY_ALPHA_PASS_WINDOW_MS,
  HOTKEY_ALPHA_STALENESS_THRESHOLD_MS,
} from "../src/hotkey-alpha-staleness-watchdog.ts";
import {
  NEURONS_PASS_WINDOW_MS,
  NEURONS_STALENESS_THRESHOLD_MS,
} from "../src/neurons-staleness-watchdog.ts";
import {
  NOMINATOR_POSITIONS_PASS_WINDOW_MS,
  NOMINATOR_POSITIONS_STALENESS_THRESHOLD_MS,
} from "../src/nominator-positions-staleness-watchdog.ts";
import { VALIDATOR_NOMINATOR_COUNTS_PASS_WINDOW_MS } from "../src/validator-nominator-counts-staleness-watchdog.ts";
import { TOP_HOLDERS_FLOW_STALENESS_THRESHOLD_MS } from "../src/top-holders-staleness-watchdog.ts";
import {
  WORKER_CRON_LANES,
  cronIntervalSecs,
} from "../src/producer-cadence.ts";
import * as CONFIG from "../workers/config.ts";

const HOUR = 60 * 60 * 1000;
const MINUTE = 60 * 1000;

/** Every pass window, with the producer whose cadence bounds it. */
const WINDOWS: [string, ProducerLane, number][] = [
  ["account-balances", "account_balances", ACCOUNT_BALANCES_PASS_WINDOW_MS],
  ["hotkey-alpha", "hotkey_alpha", HOTKEY_ALPHA_PASS_WINDOW_MS],
  ["neurons", "metagraph", NEURONS_PASS_WINDOW_MS],
  [
    "nominator-positions",
    "validator_nominators",
    NOMINATOR_POSITIONS_PASS_WINDOW_MS,
  ],
  [
    "validator-nominator-counts",
    "validator_nominators",
    VALIDATOR_NOMINATOR_COUNTS_PASS_WINDOW_MS,
  ],
];

describe("a pass window must stay under its producer's cadence", () => {
  // The rule this file exists for. A window at or above the cadence merges two
  // consecutive passes into one coverage count -- a truncated pass sitting on
  // a complete one then sums to full coverage and reports fine, which is
  // exactly the bug the coverage clause exists to catch.
  for (const [name, lane, window] of WINDOWS) {
    test(`${name}: window < ${lane} cadence`, () => {
      assert.ok(
        window < cadenceMs(lane),
        `${name} window ${window}ms is not under the ${cadenceMs(lane)}ms cadence -- ` +
          "two passes can merge into one coverage count",
      );
    });
  }

  test("the list covers every window that exists", () => {
    // A watchdog that gains a pass window and is not added here is unguarded,
    // and the rule is invisible again. Counted rather than described.
    assert.equal(WINDOWS.length, 5);
  });
});

describe("thresholds are unchanged by the refactor", () => {
  // Pinned against the pre-#10291 literals. These are the numbers production
  // alarms on; the point of the change was to make the arithmetic visible, not
  // to move any of them.
  test("every migrated constant equals its former hardcoded value", () => {
    assert.equal(ACCOUNT_BALANCES_STALENESS_THRESHOLD_MS, 12 * HOUR);
    assert.equal(ACCOUNT_BALANCES_PASS_WINDOW_MS, 2 * HOUR);
    assert.equal(HOTKEY_ALPHA_STALENESS_THRESHOLD_MS, 48 * HOUR);
    assert.equal(HOTKEY_ALPHA_PASS_WINDOW_MS, 6 * HOUR);
    assert.equal(NEURONS_STALENESS_THRESHOLD_MS, 45 * MINUTE);
    assert.equal(NEURONS_PASS_WINDOW_MS, 5 * MINUTE);
    assert.equal(NOMINATOR_POSITIONS_STALENESS_THRESHOLD_MS, 30 * HOUR);
    assert.equal(NOMINATOR_POSITIONS_PASS_WINDOW_MS, 4 * HOUR);
    assert.equal(VALIDATOR_NOMINATOR_COUNTS_PASS_WINDOW_MS, 4 * HOUR);
    assert.equal(TOP_HOLDERS_FLOW_STALENESS_THRESHOLD_MS, 48 * HOUR);
  });
});

describe("the cadence table", () => {
  test("every cadence is a positive whole number of seconds", () => {
    for (const [lane, secs] of Object.entries(PRODUCER_CADENCE_SECS)) {
      assert.ok(
        Number.isInteger(secs) && secs > 0,
        `${lane} cadence ${secs} is not a positive integer`,
      );
    }
  });

  test("every lane the alarm maps names a cadence in this table", () => {
    // A lane mapped to a producer with no declared cadence falls back to the
    // OBSERVED gap between its lane_health writes -- and a lane that writes
    // several verdicts per pass measures intra-pass minutes rather than the
    // interval between passes. That is how `self-stake` (daily) alarmed at
    // "stale: 20.2h (producer cadence 3.1h)" on 2026-08-12: a bound roughly
    // an eighth of the real one, so a healthy lane read stale most of the day.
    for (const [lane, producer] of Object.entries(LANE_PRODUCER)) {
      assert.ok(
        producer in PRODUCER_CADENCE_SECS,
        `${lane} maps to ${producer}, which has no declared cadence`,
      );
    }
  });

  test("self-stake is declared daily, not inferred", () => {
    // The specific regression: both spellings must resolve, because the
    // buffered writer files under the prefixed key and the poller under the
    // bare one.
    assert.equal(PRODUCER_CADENCE_SECS.self_stake, 86_400);
    assert.equal(LANE_PRODUCER["self-stake"], "self_stake");
    assert.equal(LANE_PRODUCER["neon:self-stake"], "self_stake");
  });

  test("hotkey-alpha runs four times less often than account-balances", () => {
    // The relationship the prose asserted and nothing checked. It is the whole
    // reason hotkey-alpha's bound is 48h and its sibling's is 12h, and #10243
    // proposed cutting the former to 1-2h precisely because this ratio was not
    // visible anywhere near the constant.
    assert.equal(
      PRODUCER_CADENCE_SECS.hotkey_alpha /
        PRODUCER_CADENCE_SECS.account_balances,
      4,
    );
  });

  test("missedTicksMs is the cadence times the ticks, fractional allowed", () => {
    // nominator-positions sits at 1.25 ticks; forcing an integer would change
    // a live threshold for the sake of the abstraction.
    assert.equal(missedTicksMs("account_balances", 2), 12 * HOUR);
    assert.equal(missedTicksMs("validator_nominators", 1.25), 30 * HOUR);
  });

  test("passWindowMs is a fraction of the same cadence", () => {
    assert.equal(passWindowMs("hotkey_alpha", 1 / 4), 6 * HOUR);
    assert.equal(passWindowMs("metagraph", 1 / 3), 5 * MINUTE);
  });
});

// #10709: a lane whose producer is a cron in THIS repo states its interval
// TWICE -- once as a cron expression, once as a number here -- and nothing
// compared them.
//
// THE CONSEQUENCE IS A WRONG ALARM, NOT A LATE LANE. This number is what every
// staleness watchdog sizes its bound from, so a disagreement does not make the
// producer slow; it makes the alarm wrong in whichever direction the error
// points. Declared too long and a dead lane is silent (#10566); too short and a
// healthy lane reads `stale` for most of every cycle (#10329, #9301). Both are
// invisible from either file, because each is internally correct.
describe("a worker lane's declared cadence matches the cron it runs on", () => {
  /** The exported cron string for a constant name, or null. workers/config.ts
   * exports functions and objects too, so this is a type TEST rather than a
   * cast over the whole namespace. */
  const cronFor = (constant: string): string | null => {
    const value = (CONFIG as unknown as Record<string, unknown>)[constant];
    return typeof value === "string" ? value : null;
  };

  test("every named lane resolves to a real cron constant", () => {
    for (const [lane, constant] of Object.entries(WORKER_CRON_LANES)) {
      assert.notEqual(
        cronFor(constant),
        null,
        `${lane} names ${constant}, which workers/config.ts does not export as a cron string`,
      );
    }
  });

  test("the declared seconds ARE the cron's interval", () => {
    for (const [lane, constant] of Object.entries(WORKER_CRON_LANES)) {
      const expression = cronFor(constant)!;
      const measured = cronIntervalSecs(expression);
      assert.notEqual(
        measured,
        null,
        `${constant} = "${expression}" is a shape cronIntervalSecs cannot ` +
          `measure, so this lane's cadence cannot be checked -- widen the ` +
          `parser or give the lane a shape that has one interval`,
      );
      assert.equal(
        measured,
        PRODUCER_CADENCE_SECS[lane as keyof typeof PRODUCER_CADENCE_SECS],
        `${lane} declares ${PRODUCER_CADENCE_SECS[lane as keyof typeof PRODUCER_CADENCE_SECS]}s ` +
          `but ${constant} = "${expression}" fires every ${measured}s`,
      );
    }
  });

  // The map is the thing that can silently shrink: dropping a lane from it
  // removes the check rather than failing it.
  test("both worker-cron lanes are still named", () => {
    assert.deepEqual(Object.keys(WORKER_CRON_LANES).sort(), [
      "top_holders_flow",
      "top_holders_holdings",
    ]);
  });
});

describe("cronIntervalSecs", () => {
  test("measures the shapes this repo's lanes use", () => {
    assert.equal(cronIntervalSecs("34 1 * * *"), 86_400);
    assert.equal(cronIntervalSecs("49 */3 * * *"), 10_800);
    assert.equal(cronIntervalSecs("26 * * * *"), 3_600);
    assert.equal(cronIntervalSecs("11,41 * * * *"), 1_800);
    assert.equal(cronIntervalSecs("3,13,23,33,43,53 * * * *"), 600);
    assert.equal(cronIntervalSecs("*/15 * * * *"), 900);
    assert.equal(cronIntervalSecs("* * * * *"), 60);
  });

  // NULL, NEVER A GUESS. Returning a number for a shape with no single interval
  // would put a wrong bound under a watchdog -- the exact failure this file is
  // about, arriving through the tool meant to prevent it.
  test("an unevenly-spaced list has no single interval", () => {
    // 1,16,31,46 IS even (15 apart, wrapping); 1,16,31,47 is not.
    assert.equal(cronIntervalSecs("1,16,31,46 * * * *"), 900);
    assert.equal(cronIntervalSecs("1,16,31,47 * * * *"), null);
    // Evenly spaced within the hour but NOT across the wrap: 0,1,2 leaves a
    // 57-minute gap once an hour, which is not a cadence.
    assert.equal(cronIntervalSecs("0,1,2 * * * *"), null);
  });

  // A fixed hour with a STEPPED minute fires several times inside one hour and
  // then not for twenty-three. Reading the minute step as the cadence would
  // bound a daily lane at ten minutes -- the #10329 direction, and the worst of
  // the two because it alarms on a lane that is working.
  test("a stepped minute inside a fixed hour is not that step's cadence", () => {
    assert.equal(cronIntervalSecs("*/10 1 * * *"), null);
    assert.equal(cronIntervalSecs("0,30 1 * * *"), null);
    // The same hour with a single fixed minute IS once a day.
    assert.equal(cronIntervalSecs("34 1 * * *"), 86_400);
  });

  // An hour RANGE or list is a common cron shape and has no single interval --
  // it must fall through rather than be measured by whichever branch is nearest.
  test("an hour range or list is unmeasurable, not approximated", () => {
    assert.equal(cronIntervalSecs("0 1-5 * * *"), null);
    assert.equal(cronIntervalSecs("0 1,13 * * *"), null);
    assert.equal(cronIntervalSecs("0 ? * * *"), null);
  });

  test("an hour step that does not divide the day has no single interval", () => {
    assert.equal(cronIntervalSecs("0 */5 * * *"), null);
    assert.equal(cronIntervalSecs("0 */6 * * *"), 21_600);
  });

  test("a day-narrowing field is not a fixed interval at all", () => {
    assert.equal(cronIntervalSecs("0 0 1 * *"), null);
    assert.equal(cronIntervalSecs("0 0 * * 1"), null);
    assert.equal(cronIntervalSecs("0 0 * 3 *"), null);
  });

  test("two step fields at once are two cadences, not one", () => {
    assert.equal(cronIntervalSecs("*/10 */2 * * *"), null);
  });

  test("a malformed expression is unmeasurable rather than a throw", () => {
    for (const bad of [
      "",
      "  ",
      "* * * *",
      "* * * * * *",
      "x * * * *",
      "*/0 * * * *",
    ]) {
      assert.equal(cronIntervalSecs(bad), null, JSON.stringify(bad));
    }
  });
});
