// A silent lane's last verdict is not a current one (#10232).
//
// `loadLatestLaneHealth` takes the newest row per lane with no liveness bound,
// so a lane that stopped reporting keeps serving whatever it last said. That
// is wrong in BOTH directions, which is why neither a "hide stale rows" nor a
// "trust the newest row" rule is sufficient:
//
//   - a lane whose last word was `ok` and then died reads healthy forever,
//     while nothing runs;
//   - one whose last word was `stale` reads as an alarm nobody can clear.
//
// A single cutoff cannot work either: cadences here differ by >100x. The bound
// has to be the lane's OWN, which is what these assert.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { buildSelfHealth, withLaneHealth } from "../src/self-health.ts";
import {
  LANE_ALARM_MIN_SILENCE_MS,
  laneSilenceThresholdMs,
} from "../src/lane-alarm.ts";
import type { LaneHealthRecord } from "../src/lane-health.ts";
import { LANE_PRODUCER } from "../src/producer-cadence.ts";

const NOW = 1_786_300_000_000;
const MIN = 60_000;

const record = (over: Partial<LaneHealthRecord> = {}): LaneHealthRecord => ({
  lane: "neurons",
  verdict: "ok",
  age_ms: 1_000,
  detail: "fresh",
  checked_at: NOW - MIN,
  ...over,
});

const card = () => buildSelfHealth([], []);
const view = (
  rows: Record<string, LaneHealthRecord>,
  cadences?: Record<string, number | null>,
) => withLaneHealth(card(), rows, { cadences, nowMs: NOW }).lanes;

describe("a lane past its own silence bound reads unknown", () => {
  test("an OK lane that died stops reporting ok", () => {
    // The direction that matters most: the card said healthy while nothing ran.
    //
    // Every quiet period here is DERIVED from laneSilenceThresholdMs rather
    // than multiplied out by hand: a 15-minute lane's three intervals are 45
    // minutes, which the floor lifts to 90, so an arithmetic guess lands
    // inside the bound and asserts nothing.
    const cadence = 15 * MIN;
    const quiet = laneSilenceThresholdMs(cadence) + MIN;
    const [lane] = view(
      { neurons: record({ verdict: "ok", checked_at: NOW - quiet }) },
      { neurons: cadence },
    );
    assert.equal(lane!.verdict, "unknown");
  });

  test("a STALE lane that died stops reporting an alarm nobody can clear", () => {
    const cadence = 15 * MIN;
    const quiet = laneSilenceThresholdMs(cadence) + MIN;
    const [lane] = view(
      { neurons: record({ verdict: "stale", checked_at: NOW - quiet }) },
      { neurons: cadence },
    );
    assert.equal(lane!.verdict, "unknown");
  });

  test("age_ms becomes the age of the SILENCE, not the dead verdict's", () => {
    // The old number described whatever the lane was measuring when it last
    // ran, and says nothing about now.
    const cadence = 15 * MIN;
    const quiet = laneSilenceThresholdMs(cadence) * 2;
    const [lane] = view(
      { neurons: record({ age_ms: 42, checked_at: NOW - quiet }) },
      { neurons: cadence },
    );
    assert.equal(lane!.age_ms, quiet);
    assert.match(lane!.detail ?? "", /no verdict for/);
  });
});

describe("the bound is the lane's own cadence, not a global one", () => {
  test("a 24h lane quiet for 3h is NOT silent", () => {
    // A cutoff tight enough for a 30-second lane would mark this absent
    // between every pair of ticks -- the #9301 shape.
    const [lane] = view(
      {
        hotkey_alpha: record({
          lane: "hotkey_alpha",
          checked_at: NOW - 3 * 60 * MIN,
        }),
      },
      { hotkey_alpha: 24 * 60 * MIN },
    );
    assert.equal(lane!.verdict, "ok");
  });

  test("a 30s lane quiet for 3h IS silent", () => {
    const [lane] = view(
      {
        chain_detail: record({
          lane: "chain_detail",
          checked_at: NOW - 3 * 60 * MIN,
        }),
      },
      { chain_detail: 30_000 },
    );
    assert.equal(lane!.verdict, "unknown");
  });

  test("the 90-minute floor holds for a very fast lane", () => {
    // 3 intervals of a 30s cadence is 90 SECONDS; without the floor a lane
    // would read silent between two ordinary ticks after a deploy.
    const [lane] = view(
      {
        chain_detail: record({
          lane: "chain_detail",
          checked_at: NOW - (LANE_ALARM_MIN_SILENCE_MS - MIN),
        }),
      },
      { chain_detail: 30_000 },
    );
    assert.equal(lane!.verdict, "ok");
  });
});

describe("without a cadence sample, nothing changes", () => {
  // These two are about a lane with NO cadence from either source -- no
  // observation AND no declaration. They used `neurons` for that, which stopped
  // being true when LANE_PRODUCER learned that lane's producer: it had a
  // staleness floor and no silence floor, and closing that gap is what made a
  // 30-day-old record read `unknown` here instead of `ok`. The behaviour change
  // is the fix; the fixture just needed a lane that is genuinely undeclared.
  //
  // Asserted rather than assumed, so this cannot quietly start leaning on a
  // mapped lane again.
  const UNDECLARED = "lane-with-no-declared-producer";

  test("the fixture lane really has no declared producer", () => {
    assert.equal(LANE_PRODUCER[UNDECLARED], undefined);
  });

  test("no cadences at all leaves every verdict alone", () => {
    // A caller that has not paid for the cadence query gets exactly today's
    // behaviour -- inventing a bound would invent alarms.
    const ancient = record({
      lane: UNDECLARED,
      verdict: "ok",
      checked_at: NOW - 30 * 24 * 60 * MIN,
    });
    assert.equal(view({ [UNDECLARED]: ancient })[0]!.verdict, "ok");
  });

  test("a lane with too little history to derive a cadence is left alone", () => {
    // loadLaneCadence returns null for a lane under the sample floor.
    const ancient = record({
      lane: UNDECLARED,
      verdict: "ok",
      checked_at: NOW - 30 * 24 * 60 * MIN,
    });
    assert.equal(
      view({ [UNDECLARED]: ancient }, { [UNDECLARED]: null })[0]!.verdict,
      "ok",
    );
  });

  test("a DECLARED lane is not left alone -- that is the floor doing its job", () => {
    // The other side of the two above, and the regression that matters: with
    // no cadence sample at all, `neurons` still gets a bound because
    // LANE_PRODUCER declares its producer. Before that mapping this read `ok`
    // after thirty days of silence.
    const ancient = record({
      lane: "neurons",
      verdict: "ok",
      checked_at: NOW - 30 * 24 * 60 * MIN,
    });
    assert.equal(LANE_PRODUCER["neurons"], "metagraph");
    assert.equal(view({ neurons: ancient })[0]!.verdict, "unknown");
  });

  test("a lane that has never been checked is left alone", () => {
    // checked_at 0 is "no row", not "silent since 1970".
    const [lane] = view(
      { neurons: record({ checked_at: 0 }) },
      { neurons: 15 * MIN },
    );
    assert.equal(lane!.verdict, "ok");
  });
});

describe("stale_lane_count", () => {
  test("a silent lane does NOT count as stale", () => {
    // We do not know it is behind; we know it is quiet. Counting it as stale
    // would assert a measurement nobody made.
    const cadence = 15 * MIN;
    const out = withLaneHealth(
      card(),
      {
        neurons: record({
          verdict: "stale",
          checked_at: NOW - laneSilenceThresholdMs(cadence) * 2,
        }),
      },
      { cadences: { neurons: cadence }, nowMs: NOW },
    );
    assert.equal(out.stale_lane_count, 0);
    assert.equal(out.lanes.length, 1, "but it stays LISTED, never dropped");
  });

  test("a live stale lane still counts", () => {
    const out = withLaneHealth(
      card(),
      { neurons: record({ verdict: "stale" }) },
      { cadences: { neurons: 15 * MIN }, nowMs: NOW },
    );
    assert.equal(out.stale_lane_count, 1);
  });
});
