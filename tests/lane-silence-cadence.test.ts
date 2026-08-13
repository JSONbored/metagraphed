// The silence bound's cadence: observed maximum gap, floored by the declared
// one (#10333).
//
// #10232 shipped with `laneCadenceMs` -- span / (n-1), the MEAN gap -- and put
// 14 of 49 healthy production lanes into `unknown`. Two structural reasons, and
// both matter for any future estimator here:
//
//   1. Container reboots fire every lane's first tick immediately, so every
//      slow lane's sample carries a cluster of near-zero gaps.
//   2. A mirror lane writes many rows PER PASS -- `neon:account-balances`
//      logged 6,268 in seven days against a six-hour producer -- so "gap
//      between rows" is not "gap between passes" there at all.
//
// Measured over seven days of production, in minutes:
//
//     lane                    rows  declared   mean  median   MAX
//     hotkey-alpha              15      1440    286      76   973
//     neon:account-balances   6268       360      1       0   359
//     metagraph                353        15     16      15    46
//
// The max survives all of them; the mean is wrong on six of seven. The
// declared cadence then floors it, for the case the max cannot reach: a lane
// whose seven days are a burst followed by silence reads a max of ~48 minutes
// against a 24-hour producer.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { describe, test } from "vitest";
import {
  LANE_PRODUCER,
  PRODUCER_CADENCE_SECS,
  cadenceMs,
  laneSilenceCadenceMs,
} from "../src/producer-cadence.ts";
import {
  LANE_ALARM_MIN_CADENCE_SAMPLES,
  LANE_MAX_GAP_SQL,
  loadLaneMaxGap,
} from "../src/lane-alarm.ts";

const MIN = 60_000;

describe("laneSilenceCadenceMs", () => {
  test("takes the observed gap when it exceeds the declared cadence", () => {
    // Observation is the half that notices a real interval drifting away from
    // the configured one -- the floor must not throw that away.
    const observed = 40 * 60 * MIN; // 40h, past hotkey_alpha's declared 24h
    assert.equal(laneSilenceCadenceMs("hotkey-alpha", observed), observed);
  });

  test("takes the declared cadence when the observation reads short", () => {
    // The `neon:*-pass` case: a burst then silence, so the max gap inside the
    // burst is minutes against a 24-hour producer.
    assert.equal(
      laneSilenceCadenceMs("neon:hotkey-alpha-pass", 48 * MIN),
      cadenceMs("hotkey_alpha"),
    );
  });

  test("a mirror writing many rows per pass cannot drive the bound to zero", () => {
    // The measured `neon:account-balances` pathology: mean 1 minute, median 0.
    // Even handed a 1-minute observation the bound stays at its producer's 6h.
    assert.equal(
      laneSilenceCadenceMs("neon:account-balances", 1 * MIN),
      cadenceMs("account_balances"),
    );
  });

  test("an undeclared lane still gets its observation", () => {
    assert.equal(laneSilenceCadenceMs("table-freshness", 25 * MIN), 25 * MIN);
  });

  test("no observation and no declaration is NO BOUND, not a guess", () => {
    // withLaneHealth leaves the verdict alone on null, which is the whole
    // safety property: a lane we cannot calibrate is never called silent.
    assert.equal(laneSilenceCadenceMs("table-freshness", null), null);
    assert.equal(laneSilenceCadenceMs("table-freshness", undefined), null);
    assert.equal(laneSilenceCadenceMs("table-freshness", 0), null);
  });

  test("no observation but a declaration still bounds the lane", () => {
    assert.equal(
      laneSilenceCadenceMs("account-identity", null),
      cadenceMs("account_identity"),
    );
  });
});

describe("LANE_PRODUCER", () => {
  test("every value names a producer whose cadence is declared", () => {
    for (const [lane, producer] of Object.entries(LANE_PRODUCER)) {
      assert.ok(
        producer in PRODUCER_CADENCE_SECS,
        `${lane} -> ${producer} has no declared cadence`,
      );
    }
  });

  test("the nominator lanes map to their PRODUCER, not to their own name", () => {
    // The case that makes this table explicit rather than string surgery: one
    // poller writes both the counts and the positions, so `nominator_positions`
    // is not a producer key and a strip-the-prefix rule would miss it.
    for (const lane of [
      "neon:nominator-positions",
      "neon:nominator-positions-pass",
      "neon:nominator-positions-prune",
      "neon:validator-nominator-counts",
    ]) {
      assert.equal(LANE_PRODUCER[lane], "validator_nominators", lane);
    }
  });

  test("a lane's staleness watchdog and LANE_PRODUCER cannot disagree", () => {
    // The SAME fact is written twice: `<lane>-staleness-watchdog.ts` names the
    // producer in its own `*_STALENESS_THRESHOLD_MS`, and LANE_PRODUCER names
    // it again for the silence bound. `neurons` had the first and not the
    // second, so it got a staleness floor and NO silence floor -- and an
    // unfloored silence bound is computed from the observed sample alone,
    // which a burst-then-quiet sample makes tighter than one real tick.
    //
    // Matched on the lane's OWN threshold constant, not on any missedTicksMs
    // call: table-freshness-watchdog.ts calls it for every table it WATCHES,
    // and a looser rule read those as declarations about its own lane. The
    // first draft of this test did exactly that and reported a lane that is
    // correctly unmapped.
    const declarations: [string, string][] = [];
    for (const file of readdirSync("src")) {
      const lane = /^(.+)-staleness-watchdog\.ts$/.exec(file)?.[1];
      if (!lane) continue;
      const producer =
        /export const [A-Z0-9_]*STALENESS_THRESHOLD_MS = missedTicksMs\(\s*"([a-z_]+)"/.exec(
          readFileSync(`src/${file}`, "utf8"),
        )?.[1];
      if (!producer) continue;
      declarations.push([lane, producer]);
    }
    assert.ok(
      declarations.length >= 4,
      `expected several per-lane staleness watchdogs, found ${declarations.length}`,
    );
    for (const [lane, producer] of declarations) {
      // Only where the watchdog's file name IS a lane the table knows: a
      // watchdog may guard a lane under a different name, and asserting on a
      // name the table never claimed would be inventing a rule.
      if (!(lane in LANE_PRODUCER)) continue;
      assert.equal(
        LANE_PRODUCER[lane],
        producer,
        `${lane}-staleness-watchdog.ts declares "${producer}" but LANE_PRODUCER says ${String(LANE_PRODUCER[lane])}`,
      );
    }
  });

  test("a mapped `neon:` mirror means its bare lane is mapped too", () => {
    // The reverse of the test above, and the one that was missing. Every
    // assertion here was one-directional: values have cadences, listed mirrors
    // resolve. Nothing said a lane that ALARMS must be in the table at all.
    //
    // `neon:nominator-positions` and `neon:validator-nominator-counts` were
    // mapped; the bare sync-lane names that write the same rows from the same
    // poller were not. So `lane nominator-positions is silent: 29.4h` reached
    // Discord with no cadence beside it, reading as a dead producer when it is
    // one missed pass of a 24h poller.
    //
    // Derived from the table itself rather than a list of the pairs that were
    // fixed: a future `neon:` mirror added without its bare lane fails here.
    const unmapped: string[] = [];
    for (const lane of Object.keys(LANE_PRODUCER)) {
      if (!lane.startsWith("neon:")) continue;
      const bare = lane.slice("neon:".length).replace(/-(pass|prune)$/, "");
      if (!(bare in LANE_PRODUCER)) continue; // never mapped either way: not this rule
      assert.equal(
        LANE_PRODUCER[bare],
        LANE_PRODUCER[lane],
        `${lane} and ${bare} are the same producer under two names`,
      );
    }
    // Non-vacuity: the rule must actually be checking pairs.
    const pairs = Object.keys(LANE_PRODUCER).filter(
      (l) =>
        l.startsWith("neon:") &&
        l.slice("neon:".length).replace(/-(pass|prune)$/, "") in LANE_PRODUCER,
    );
    assert.ok(
      pairs.length >= 6,
      `expected several mirror/bare pairs, found ${pairs.length}`,
    );
    assert.deepEqual(unmapped, []);
  });

  test("the lanes that alarmed on 2026-08-13 resolve a cadence", () => {
    // Regression: both were silent for ~29h and neither alarm could say against
    // what interval, because neither name was in the table.
    for (const lane of ["nominator-positions", "validator-nominator-counts"]) {
      assert.equal(LANE_PRODUCER[lane], "validator_nominators", lane);
      assert.equal(
        laneSilenceCadenceMs(lane, null),
        cadenceMs("validator_nominators"),
        lane,
      );
    }
  });

  test("a mirror shares its parent's producer", () => {
    for (const [mirror, parent] of [
      ["neon:account-balances", "account-balances"],
      ["neon:hotkey-alpha", "hotkey-alpha"],
      ["neon:account-identity", "account-identity"],
      ["neon:subnet-hyperparams", "subnet-hyperparams"],
    ] as const) {
      assert.equal(LANE_PRODUCER[mirror], LANE_PRODUCER[parent], mirror);
    }
  });
});

// --- the loader --------------------------------------------------------------

/** A db whose `all()` returns the given rows, recording what it was asked. */
function db(rows: unknown[], onSql?: (sql: string, values: unknown[]) => void) {
  return {
    query(sql: string, values: unknown[] = []) {
      onSql?.(sql, values);
      return Promise.resolve(rows);
    },
  } as unknown as Parameters<typeof loadLaneMaxGap>[0];
}

describe("loadLaneMaxGap", () => {
  test("returns the max gap per lane, and asks Postgres for exactly that", () => {
    // The SQL is the fix. A window function over `checked_at` is the only way
    // to get a per-pass interval out of a table where a mirror writes many rows
    // per pass, and asserting it here is cheaper than discovering a rewritten
    // query has silently gone back to an aggregate over rows.
    assert.match(LANE_MAX_GAP_SQL, /LAG\(checked_at\) OVER/);
    assert.match(LANE_MAX_GAP_SQL, /PARTITION BY lane ORDER BY checked_at/);
    assert.match(LANE_MAX_GAP_SQL, /MAX\(gap\)/);
  });

  test("reads rows into a lane -> gap map", async () => {
    let asked: [string, unknown[]] | null = null;
    const out = await loadLaneMaxGap(
      db(
        [
          { lane: "neurons", n: 20, max_gap: 900_000 },
          { lane: "metagraph", n: 50, max_gap: 2_760_000 },
        ],
        (sql, values) => {
          asked = [sql, values];
        },
      ),
      1_786_000_000_000,
    );
    assert.deepEqual(out, { neurons: 900_000, metagraph: 2_760_000 });
    assert.equal(asked![0], LANE_MAX_GAP_SQL);
    assert.deepEqual(asked![1], [1_786_000_000_000]);
  });

  test("a lane under the sample floor reads null, not a bound", async () => {
    // `n` counts GAPS, one fewer than rows, so the comparison is n + 1.
    const gaps = LANE_ALARM_MIN_CADENCE_SAMPLES - 2;
    const out = await loadLaneMaxGap(
      db([{ lane: "sparse", n: gaps, max_gap: 900_000 }]),
      0,
    );
    assert.equal(out.sparse, null);
    const out2 = await loadLaneMaxGap(
      db([{ lane: "just_enough", n: gaps + 1, max_gap: 900_000 }]),
      0,
    );
    assert.equal(out2.just_enough, 900_000);
  });

  test("a non-positive gap reads null", async () => {
    const out = await loadLaneMaxGap(
      db([{ lane: "flat", n: 99, max_gap: 0 }]),
      0,
    );
    assert.equal(out.flat, null);
  });

  test("a row with no lane is skipped rather than keyed on empty string", async () => {
    const out = await loadLaneMaxGap(
      db([
        { lane: null, n: 99, max_gap: 900_000 },
        { lane: "real", n: 99, max_gap: 900_000 },
      ]),
      0,
    );
    assert.deepEqual(Object.keys(out), ["real"]);
  });

  test("declines to {} without a db, and on a throw", async () => {
    // A failed read must cost today's behaviour, never a false alarm:
    // withLaneHealth leaves every verdict alone when it gets no bound.
    assert.deepEqual(await loadLaneMaxGap(null, 0), {});
    assert.deepEqual(await loadLaneMaxGap(undefined, 0), {});
    const exploding = {
      query: async () => {
        throw new Error("neon down");
      },
    } as unknown as Parameters<typeof loadLaneMaxGap>[0];
    assert.deepEqual(await loadLaneMaxGap(exploding, 0), {});
  });

  test("a result with no results array yields an empty map", async () => {
    const empty = {
      prepare: () => ({ bind: () => ({ all: async () => null }) }),
    } as unknown as Parameters<typeof loadLaneMaxGap>[0];
    assert.deepEqual(await loadLaneMaxGap(empty, 0), {});
  });
});
