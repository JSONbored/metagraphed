// A lane that RUNS and produces nothing reads as healthy (#11226).
//
// The attribution sweep wrote a row for all 128 subnets, reported ok, and
// produced nothing for its entire life. Every watchdog said healthy, and none
// of them was wrong -- they ask whether a lane RAN.
//
// The dangerous direction for THIS check is the other one: an alarm that fires
// on a working classifier gets ignored (#9301), and then the lane it was built
// for goes quiet again behind it. So most of these pin what it must NOT report.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  CLASSIFYING_LANES,
  DEGENERATE_OUTPUT_LANE,
  degenerateFault,
  runDegenerateOutputWatchdog,
  tallySql,
  type ClassifyingLane,
} from "../src/degenerate-output-watchdog.ts";

const SWEEP = CLASSIFYING_LANES[0]!;

/** A lane with no work counter, to exercise the barren rule on its own. */
const CLASSIFIER: ClassifyingLane = {
  table: "some_lane",
  verdictColumn: "status",
  barren: "skipped",
  reason: "declared for the test",
};

const tally = (verdict: string, rows: number, work = 1) => ({
  verdict,
  rows,
  work,
});

describe("degenerateFault", () => {
  test("THE PRODUCTION SIGNAL: one verdict, 128 rows, zero work", () => {
    // Byte for byte what `SELECT verdict, count(*), max(sources_checked) FROM
    // attribution_sweeps GROUP BY verdict` returned on the day #11226 was
    // filed. This is the assertion the whole file exists for.
    const fault = degenerateFault(SWEEP, [tally("no-sources", 128, 0)]);
    assert.equal(fault?.fault, "idle");
    assert.match(fault!.detail, /sources_checked is 0 across all 128 row\(s\)/);
  });

  test("IDLE outranks BARREN, so one fault is not named twice", () => {
    // A lane that reached nothing REPORTS the null verdict as a consequence.
    // Emitting both would send a reader to two places for one cause, and the
    // work counter is the one that says which.
    assert.equal(
      degenerateFault(SWEEP, [tally("no-sources", 128, 0)])?.fault,
      "idle",
    );
  });

  test("a uniform null verdict alarms even with no work counter declared", () => {
    const fault = degenerateFault(CLASSIFIER, [tally("skipped", 40)]);
    assert.equal(fault?.fault, "barren");
    assert.match(fault!.detail, /all 40 row\(s\) report status=skipped/);
  });

  test("A UNIFORM NON-NULL VERDICT IS NOT A FAULT", () => {
    // Every subnet reachable and every sweep finding nothing is a legitimate
    // state of the world. Only collapse onto the verdict that means "I
    // classified nothing" counts -- uniformity alone would alarm on a healthy
    // fleet the day nothing changed.
    assert.equal(
      degenerateFault(SWEEP, [tally("none-published", 128, 5)]),
      null,
    );
  });

  test("ONE ROW OFF THE NULL VERDICT CLEARS IT -- no threshold", () => {
    // 127 of 128 is a fact about the world often enough that a ratio here would
    // fire on working lanes. The rule is total collapse or nothing.
    assert.equal(
      degenerateFault(SWEEP, [
        tally("no-sources", 127, 0),
        tally("candidates-found", 1, 3),
      ]),
      null,
    );
  });

  test("a single subnet with zero sources is legitimate and stays quiet", () => {
    // The schema says so in as many words: a subnet publishing no surface has
    // not been searched, and must not read as "searched, found nothing". It is
    // the FLEET-WIDE zero that is impossible.
    assert.equal(
      degenerateFault(SWEEP, [
        tally("no-sources", 1, 0),
        tally("none-published", 127, 9),
      ]),
      null,
    );
  });

  test("an EMPTY table is not this watchdog's question", () => {
    // Freshness already owns "no rows arrived". Answering it here too would put
    // two alarms on one fact, neither able to clear the other.
    assert.equal(degenerateFault(SWEEP, []), null);
    assert.equal(degenerateFault(SWEEP, [tally("no-sources", 0, 0)]), null);
  });
});

describe("tallySql", () => {
  test("it is the query the issue was filed with", () => {
    const sql = tallySql(SWEEP);
    assert.match(sql, /SELECT verdict AS verdict, count\(\*\) AS rows/);
    assert.match(sql, /max\(sources_checked\) AS work/);
    assert.match(sql, /FROM attribution_sweeps GROUP BY verdict/);
  });

  test("a lane with no counter still yields the same row shape", () => {
    // So the caller reads `work` unconditionally rather than branching on a
    // column that may not be there.
    assert.match(tallySql(CLASSIFIER), /1 AS work/);
  });
});

describe("the declared lanes", () => {
  test("attribution_sweeps declares the verdict its own type names", () => {
    // The barren value has to be one the producer can actually write, or the
    // check silently never matches. `SweepVerdict` in src/attribution-sweep.ts
    // is the union; `no-sources` is its "publishes nothing fetchable" member.
    assert.equal(SWEEP.table, "attribution_sweeps");
    assert.equal(SWEEP.barren, "no-sources");
    assert.equal(SWEEP.workColumn, "sources_checked");
  });

  test("every declared lane says WHY a collapse is a defect", () => {
    // The reason rides into `lane_health.detail`, which is what a human reads
    // at 3am deciding whether this is the lane or the world.
    for (const lane of CLASSIFYING_LANES) {
      assert.ok(lane.reason.length > 40, lane.table);
    }
  });
});

/** A store answering one `GROUP BY` with the given rows. */
function db(rows: Record<string, unknown>[] | Error) {
  const asked: string[] = [];
  return {
    asked,
    query: async (sql: string) => {
      asked.push(sql);
      if (rows instanceof Error) throw rows;
      return rows;
    },
  };
}

function laneHealth() {
  const written: Record<string, unknown>[] = [];
  return {
    written,
    db: { query: async () => [], run: async () => ({ changes: 1 }) },
  };
}

describe("runDegenerateOutputWatchdog", () => {
  test("records a STALE verdict naming the lane and the fault", async () => {
    const health = laneHealth();
    const result = await runDegenerateOutputWatchdog(
      {},
      {
        db: db([{ verdict: "no-sources", rows: 128, work: 0 }]),
        laneHealthDb: {
          query: async () => [],
          run: async (_sql: string, values?: unknown[]) => {
            health.written.push({ values });
            return { changes: 1 };
          },
        },
        now: () => 1_785_000_000_000,
      },
    );
    assert.equal(result.ok, false);
    assert.equal(result.faults[0]?.fault, "idle");
    const values = health.written[0]?.values as unknown[];
    assert.equal(values[0], DEGENERATE_OUTPUT_LANE);
    assert.equal(values[1], "stale");
  });

  test("records OK, and says how many lanes it checked", async () => {
    // A watchdog that only ever writes on failure cannot be told from one that
    // stopped running -- which is the class this whole file is about.
    const written: unknown[][] = [];
    const result = await runDegenerateOutputWatchdog(
      {},
      {
        db: db([
          { verdict: "no-sources", rows: 100, work: 4 },
          { verdict: "candidates-found", rows: 28, work: 9 },
        ]),
        laneHealthDb: {
          query: async () => [],
          run: async (_sql: string, values?: unknown[]) => {
            written.push(values ?? []);
            return { changes: 1 };
          },
        },
      },
    );
    assert.equal(result.ok, true);
    assert.equal(result.checked, CLASSIFYING_LANES.length);
    assert.equal(written[0]?.[1], "ok");
    assert.match(
      String(written[0]?.[3]),
      /1 classifying lane\(s\), none degenerate/,
    );
  });

  test("A FAILED QUERY DOES NOT STOP THE TICK", async () => {
    // Migrations here are applied by hand, so a table that does not exist yet
    // is a state this must survive -- and it must not report the lanes it never
    // reached as healthy either, which is why `checked` is counted rather than
    // assumed.
    const seen: unknown[] = [];
    const result = await runDegenerateOutputWatchdog(
      {},
      {
        db: db(new Error("relation does not exist")),
        laneHealthDb: {
          query: async () => [],
          run: async () => ({ changes: 1 }),
        },
        recordException: async (_env: unknown, event: unknown) => {
          seen.push(event);
          return true;
        },
      },
    );
    assert.equal(result.ok, true, "no fault was observed, so none is reported");
    assert.equal(result.checked, 0, "and it does not claim to have checked it");
    assert.equal(seen.length, 1);
  });

  test("no store bound declines rather than reporting healthy", async () => {
    const result = await runDegenerateOutputWatchdog({}, { db: null });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "no read store bound");
  });
});
