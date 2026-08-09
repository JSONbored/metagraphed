// A freshness bound must clear one full tick of its producer (#10329).
//
// TABLE_FRESHNESS's own header states the rule -- "A threshold under one
// producer interval alarms forever; one at ten times it never alarms at all"
// -- and nothing enforced it, because the interval was not in this repo. It
// reached the file as prose beside each constant, so `12 * HOUR` next to
// `reason: "identity sync"` looked exactly like a considered bound and was in
// fact half a tick: `account_identity` read `stale` for the back half of every
// 24-hour cycle while its own lane verdict said `ok | 129 scanned, 456
// written, 0 error(s)`.
//
// With `producer` declared on each derived entry, the relationship is data and
// the rule is checkable. That is the whole point of the field -- a bound alone
// cannot be audited, since 12 hours is generous or guaranteed-to-alarm
// depending on a number stored somewhere else.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { TABLE_FRESHNESS } from "../src/table-freshness-watchdog.ts";
import {
  PRODUCER_CADENCE_SECS,
  cadenceMs,
  type ProducerLane,
} from "../src/producer-cadence.ts";

const HOUR = 60 * 60 * 1000;

const derived = Object.entries(TABLE_FRESHNESS).filter(
  ([, spec]) => spec.producer !== undefined,
) as [
  string,
  { maxAgeMs: number | null; producer: ProducerLane; reason: string },
][];

describe("every cadence-derived bound", () => {
  test("names a producer this repo actually knows the cadence of", () => {
    // A typo'd lane would otherwise be a silent `undefined` cadence and the
    // checks below would compare against NaN, which passes nothing and fails
    // nothing.
    assert.ok(derived.length >= 14, `only ${derived.length} derived bounds`);
    for (const [table, spec] of derived) {
      assert.ok(
        spec.producer in PRODUCER_CADENCE_SECS,
        `${table} names an unknown producer ${spec.producer}`,
      );
    }
  });

  test("clears ONE FULL TICK -- the rule account_identity broke", () => {
    // Under one tick the table is guaranteed to breach between two ordinary
    // passes, so the alarm is on for part of every cycle no matter how healthy
    // the lane is. That is #9301's shape and it is what makes an alarm
    // unreadable.
    for (const [table, spec] of derived) {
      const ticks = spec.maxAgeMs! / cadenceMs(spec.producer);
      assert.ok(
        ticks >= 1,
        `${table}: ${spec.maxAgeMs! / HOUR}h is ${ticks.toFixed(2)} ticks of ` +
          `${spec.producer} (${cadenceMs(spec.producer) / HOUR}h) -- alarms every cycle`,
      );
    }
  });

  test("is not so loose it can never alarm", () => {
    // The other half of the same sentence. Twelve is the current ceiling and
    // `subnet_hyperparams` sits exactly there deliberately (its own lane
    // verdict plus #10232's silence bound cover the gap); anything past it is
    // a bound that has stopped being one.
    for (const [table, spec] of derived) {
      const ticks = spec.maxAgeMs! / cadenceMs(spec.producer);
      assert.ok(
        ticks <= 12,
        `${table}: ${ticks.toFixed(2)} ticks of ${spec.producer} never alarms`,
      );
    }
  });

  test("declares a real bound, never null", () => {
    // `maxAgeMs: null` means "staleness is meaningless here" -- true of the
    // append-on-change histories, and incompatible with having named a
    // producer whose cadence you are deriving from.
    for (const [table, spec] of derived) {
      assert.notEqual(
        spec.maxAgeMs,
        null,
        `${table} derives from a cadence but bounds nothing`,
      );
    }
  });
});

describe("account_identity specifically", () => {
  test("is bounded above its 24-hour producer, not below it", () => {
    // The regression this file exists for, pinned by name: 12h against an
    // 86,400s producer is the exact state found in production 2026-08-09.
    const spec = TABLE_FRESHNESS.account_identity!;
    assert.equal(spec.producer, "account_identity");
    assert.ok(
      spec.maxAgeMs! > 24 * HOUR,
      `${spec.maxAgeMs! / HOUR}h does not clear the 24h cadence`,
    );
  });
});
