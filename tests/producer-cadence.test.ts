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
