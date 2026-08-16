// The top-holders leaderboard's alarm (#9464).
//
// The case that matters is the one it was written for: on 2026-08-05 the route
// answered 200 with 2,965 accounts and `captured_at: 2026-08-02T00:05:06.441Z`,
// and the only thing that noticed was a caller reading the timestamp. The
// first test below replays that exact artifact.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  evaluateTopHoldersStaleness,
  TOP_HOLDERS_FLOW_STALENESS_THRESHOLD_MS,
  TOP_HOLDERS_HOLDINGS_STALENESS_THRESHOLD_MS,
  readTopHoldersArtifactState,
  runTopHoldersStalenessWatchdog,
  type TopHoldersArtifactState,
} from "../src/top-holders-staleness-watchdog.ts";
import {
  TOP_HOLDERS_FLOW_PROJECTION_KEY,
  topHoldersFlowRows,
} from "../src/top-holders-flow-tier.ts";
import { runStalenessLane } from "./helpers/staleness-lane.ts";

const HOUR = 3_600_000;
const NOW = Date.parse("2026-08-05T02:00:00.000Z");

/** The `generated_at` of the one-shot pre-decommission materialization sitting
 * in R2 today. A literal, deliberately NOT a constant imported from source:
 * #9475 deleted that constant because keying the alarm off it is what kept the
 * alarm quiet on the live defect. Here it is only a fixture. */
const FROZEN_GENERATED_AT = "2026-08-02T22:38:17.501738+00:00";

/** A present artifact carrying `rows` rows, generated at `generatedAt`.
 *
 * `holdingsGeneratedAt` defaults to the flow stamp, which is what
 * readTopHoldersArtifactState produces for a body written before #9632 and for
 * one the daily lane wrote whole -- so every assertion below that predates the
 * split keeps asking exactly the question it was asking. */
function present(
  generatedAt: string | null,
  rowCount = 2_965,
  holdingsGeneratedAt: string | null = generatedAt,
): TopHoldersArtifactState {
  return { present: true, generatedAt, holdingsGeneratedAt, rowCount };
}

function verdictFor(
  artifact: TopHoldersArtifactState,
  nowMs = NOW,
  thresholdMs = TOP_HOLDERS_FLOW_STALENESS_THRESHOLD_MS,
) {
  return evaluateTopHoldersStaleness({ artifact, nowMs, thresholdMs });
}

describe("evaluateTopHoldersStaleness", () => {
  // The production state, replayed. #9475: this is `stale` with no
  // special-casing, so the tick notifies -- the snapshot's own timestamp buys
  // it no exemption, which is the whole correction.
  test("the frozen pre-decommission snapshot is plainly stale", () => {
    const verdict = verdictFor(present(FROZEN_GENERATED_AT));
    assert.equal(verdict.stale, true);
    assert.equal(verdict.reason, "stale");
    assert.equal(verdict.generated_at, FROZEN_GENERATED_AT);
    assert.ok(verdict.age_ms !== null && verdict.age_ms > 2 * 24 * HOUR);
  });

  // The regression guard for #9475 itself. A rule that reads any particular
  // `generated_at` as a reason to stay quiet is the bug; the ONLY thing that
  // decides a present, non-empty artifact's verdict is its age.
  test("no timestamp is exempt -- only age decides", () => {
    const fresh = new Date(NOW - HOUR).toISOString();
    const old = new Date(NOW - 72 * HOUR).toISOString();
    // Same instant, expressed with a microsecond fraction and the way an ISO
    // writer would: neither spelling changes the verdict.
    for (const stamp of [old, "2026-08-02T02:00:00.000000+00:00"]) {
      const verdict = verdictFor(present(stamp));
      assert.equal(verdict.stale, true, stamp);
      assert.equal(verdict.reason, "stale", stamp);
    }
    assert.equal(verdictFor(present(fresh)).stale, false);
    assert.equal(verdictFor(present(fresh)).reason, null);
    assert.equal(verdictFor(present(fresh)).age_ms, HOUR);
    // And the production timestamp specifically is not treated differently
    // from any other artifact of the same age.
    const sameAgeAsFrozen = verdictFor(
      present(new Date(Date.parse(FROZEN_GENERATED_AT)).toISOString()),
    );
    assert.deepEqual(
      { stale: sameAgeAsFrozen.stale, reason: sameAgeAsFrozen.reason },
      {
        stale: verdictFor(present(FROZEN_GENERATED_AT)).stale,
        reason: "stale",
      },
    );
  });

  // The sizing rule #9301 corrected the nominator-positions threshold for: a
  // healthy lane's age swings across its whole producer interval, so a bound
  // near one interval alerts on a lane that is working. This lane's producer
  // is TOP_HOLDERS_FLOW_CRON, daily, so the bound is 48h -- a full day of
  // normal swing plus one whole cadence of slack.
  test("a lane anywhere in its normal daily swing is healthy", () => {
    for (const hours of [0, 1, 3, 5.9, 6, 8, 11.9]) {
      const verdict = verdictFor(
        present(new Date(NOW - hours * HOUR).toISOString()),
      );
      assert.equal(verdict.stale, false, `${hours}h old must be healthy`);
    }
  });

  test("fires only once past the threshold, not before", () => {
    const at = (ms: number) =>
      verdictFor(present(new Date(NOW - ms).toISOString())).stale;
    assert.equal(at(TOP_HOLDERS_FLOW_STALENESS_THRESHOLD_MS - 1), false);
    assert.equal(at(TOP_HOLDERS_FLOW_STALENESS_THRESHOLD_MS), false);
    assert.equal(at(TOP_HOLDERS_FLOW_STALENESS_THRESHOLD_MS + 1), true);
  });

  // These are the conditions the route CANNOT show a caller: it falls through
  // to buildTopHoldersList([]) and answers 200 with account_count 0.
  test("absent, unreadable and empty all page", () => {
    for (const [artifact, reason] of [
      [{ present: false, reason: "absent" } as const, "absent"],
      [{ present: false, reason: "unreadable" } as const, "unreadable"],
      [present(null), "unreadable"],
      [present("not a timestamp"), "unreadable"],
      [present(FROZEN_GENERATED_AT, 0), "empty"],
    ] as const) {
      const verdict = verdictFor(artifact);
      assert.equal(verdict.stale, true, reason);
      assert.equal(verdict.reason, reason);
    }
  });

  // An artifact present and well-formed with no rows serves an empty
  // leaderboard NOW, whatever its age, which is a different repair from one
  // that merely stopped being refreshed -- so it keeps its own reason even
  // when the age alone would already have said `stale`.
  test("empty outranks age, and still reports the age", () => {
    const verdict = verdictFor(present(FROZEN_GENERATED_AT, 0));
    assert.equal(verdict.stale, true);
    assert.equal(verdict.reason, "empty");
    assert.notEqual(verdict.age_ms, null, "age is still measurable here");
    // Even a FRESH artifact with no rows is a stall, which age alone misses.
    const freshButEmpty = verdictFor(
      present(new Date(NOW - HOUR).toISOString(), 0),
    );
    assert.equal(freshButEmpty.stale, true);
    assert.equal(freshButEmpty.reason, "empty");
  });

  test("an absent or unparseable artifact reports no age rather than zero", () => {
    assert.equal(verdictFor({ present: false, reason: "absent" }).age_ms, null);
    assert.equal(verdictFor(present("nope")).age_ms, null);
  });

  test("the threshold travels on every verdict", () => {
    const verdict = verdictFor(present(FROZEN_GENERATED_AT), NOW, 7);
    assert.equal(verdict.threshold_ms, 7);
  });
});

describe("readTopHoldersArtifactState", () => {
  /** A bucket serving `body` at the artifact key, or throwing. */
  function bucket(
    body: unknown,
    opts: {
      missing?: boolean;
      throwOnGet?: boolean;
      throwOnJson?: boolean;
    } = {},
  ) {
    return {
      async get(key: string) {
        assert.equal(
          key,
          TOP_HOLDERS_FLOW_PROJECTION_KEY,
          "reads the served key",
        );
        if (opts.throwOnGet) throw new Error("r2 unreachable");
        if (opts.missing) return null;
        return {
          async json() {
            if (opts.throwOnJson) throw new Error("malformed body");
            return body;
          },
        };
      },
    };
  }

  const frozenBody = {
    schema_version: 1,
    generated_at: FROZEN_GENERATED_AT,
    rows: [{ ss58: "5A", free_tao: "1" }],
  };

  test("reads the real artifact shape", async () => {
    assert.deepEqual(await readTopHoldersArtifactState(bucket(frozenBody)), {
      present: true,
      generatedAt: FROZEN_GENERATED_AT,
      // A body with no `holdings_generated_at` is one written before #9632
      // split the lane, and for such a body the holdings columns really were
      // written at `generated_at` -- so it reads as that, not as null.
      holdingsGeneratedAt: FROZEN_GENERATED_AT,
      rowCount: 1,
    });
  });

  test("a missing object is absent; a throw is unreadable", async () => {
    assert.deepEqual(
      await readTopHoldersArtifactState(bucket(null, { missing: true })),
      { present: false, reason: "absent" },
    );
    assert.deepEqual(
      await readTopHoldersArtifactState(bucket(null, { throwOnGet: true })),
      { present: false, reason: "unreadable" },
    );
    assert.deepEqual(
      await readTopHoldersArtifactState(bucket(null, { throwOnJson: true })),
      { present: false, reason: "unreadable" },
    );
  });

  // The watchdog must judge the artifact by the SAME test the read path
  // applies, or it reports healthy on exactly the object the route declines.
  test("a body the reader would decline is unreadable, not present", async () => {
    for (const body of [
      null,
      {},
      { schema_version: 2, rows: [] },
      { schema_version: 1, rows: "not an array" },
    ]) {
      assert.equal(topHoldersFlowRows(body), null);
      assert.deepEqual(await readTopHoldersArtifactState(bucket(body)), {
        present: false,
        reason: "unreadable",
      });
    }
  });

  test("a non-string generated_at reads as absent rather than coerced", async () => {
    assert.deepEqual(
      await readTopHoldersArtifactState(
        bucket({ schema_version: 1, generated_at: 17, rows: [] }),
      ),
      {
        present: true,
        generatedAt: null,
        holdingsGeneratedAt: null,
        rowCount: 0,
      },
    );
  });
});

describe("runTopHoldersStalenessWatchdog", () => {
  /** Collects the durable rows so a test can assert the verdict was RECORDED
   * and not merely notified -- the distinction #9330/#9340 exist about. */
  function laneHealthSpy() {
    const rows: Record<string, unknown>[] = [];
    return {
      rows,
      db: {
        async query() {
          return [];
        },
        async run(sql: string, values: unknown[] = []) {
          if (sql.startsWith("INSERT")) {
            rows.push({
              lane: values[0],
              verdict: values[1],
              age_ms: values[2],
              detail: values[3],
              checked_at: values[4],
            });
          }
          return { changes: 1 };
        },
      },
    };
  }

  /** One leg's alerts / lane rows. Every assertion below is scoped to a leg
   * rather than to a total, because #9632 gave this ONE object a second writer
   * on a second cadence and therefore a second verdict: a bare `length === 1`
   * would now pass or fail on which legs happened to be stale together, which
   * is not what any of these tests are about. */
  const forRoute = <T extends { route?: string }>(events: T[], route: string) =>
    events.filter((e) => e.route === route);
  const forLane = (rows: Record<string, unknown>[], lane: string) =>
    rows.filter((r) => r.lane === lane);

  const FLOW_ROUTE = "watchdog:top-holders-flow-staleness";
  const HOLDINGS_ROUTE = "watchdog:top-holders-holdings-staleness";
  const FLOW_LANE = "top-holders-flow-staleness";
  const HOLDINGS_LANE = "top-holders-holdings-staleness";

  /** The object the route actually serves: the daily flow projection, which
   * has carried all six sortable keys since its holdings leg started proving.
   * There is no second artifact under it any more. */
  function flowBody(
    generatedAt: string,
    rows: unknown[] = [{ ss58: "5A", net_flow_7d: 1 }],
    /** #9632: the holdings half's own stamp. Omitted by default, which is what
     * a body written before the split looks like -- and what the daily lane
     * writes when its holdings leg declines. */
    extra: Record<string, unknown> = {},
  ) {
    return { schema_version: 1, generated_at: generatedAt, rows, ...extra };
  }

  function envWith(body: unknown, extra: Record<string, unknown> = {}) {
    return {
      METAGRAPH_ARCHIVE: {
        async get(key: string) {
          if (key !== TOP_HOLDERS_FLOW_PROJECTION_KEY) return null;
          return body === undefined
            ? null
            : {
                async json() {
                  return body;
                },
              };
        },
      },
      ...extra,
    } as unknown as Record<string, unknown>;
  }

  function run(body: unknown, extra: Record<string, unknown> = {}) {
    const events: { route?: string; errorCode?: string; error?: Error }[] = [];
    const spy = laneHealthSpy();
    return runTopHoldersStalenessWatchdog(envWith(body, extra), {
      now: () => NOW,
      laneHealthDb: spy.db,
      recordException: (async (_e: unknown, ev: never) => {
        events.push(ev);
        return true;
      }) as never,
    }).then((result) => ({
      result: result as Record<string, unknown> & {
        // #9632 added a second verdict beside the flow one. Named here so the
        // assertions below read it without a cast apiece.
        holdings: {
          stale: boolean;
          reason: string | null;
          age_ms: number | null;
          threshold_ms: number;
        };
      },
      events,
      rows: spy.rows,
    }));
  }

  test("an unbound bucket is a missed report, not a throw", async () => {
    assert.deepEqual(await runTopHoldersStalenessWatchdog(null), {
      ok: false,
      reason: "r2 binding unavailable",
    });
    assert.deepEqual(await runTopHoldersStalenessWatchdog({}), {
      ok: false,
      reason: "r2 binding unavailable",
    });
    assert.deepEqual(
      await runTopHoldersStalenessWatchdog({ METAGRAPH_ARCHIVE: {} }),
      { ok: false, reason: "r2 binding unavailable" },
    );
  });

  // ONE lane now, not two. The second one measured the frozen holdings
  // materialization, which could never pass a freshness bound because it did
  // not age -- it was a fixed answer to a query whose inputs were gone. That
  // artifact has a live producer now and was deleted, so a tick that recorded
  // two rows recording one `ok` and one permanent `stale` records one.
  test("writes one lane row per leg of the object that is served", async () => {
    const { result, rows, events } = await run(
      flowBody(new Date(NOW - HOUR).toISOString()),
    );
    assert.equal(result.ok, true);
    assert.equal(result.stale, false);
    assert.equal(result.alerted, false);
    // TWO rows for ONE object, which is the #9632 shape: the flow half and the
    // holdings half are written by different crons and fail independently, so
    // one row could only ever record one of them.
    assert.deepEqual(
      rows.map((r) => r.lane),
      [FLOW_LANE, HOLDINGS_LANE],
    );
    assert.deepEqual([...new Set(rows.map((r) => r.verdict))], ["ok"]);
    // ONE read, so both verdicts are stamped from the same clock -- two gets
    // would leave a window in which the legs judged different bodies.
    assert.deepEqual([...new Set(rows.map((r) => r.checked_at))], [NOW]);
    assert.deepEqual(events, [], "a healthy lane pages nobody");
  });

  // #9475's correction, which stands: a stale lane BOTH records and notifies.
  // Recording alone is what let #9464 ship a watchdog silent on the very
  // defect it was built for.
  test("a stalled lane notifies AND records, every tick", async () => {
    const { result, rows, events } = await run(
      flowBody(new Date(NOW - 72 * HOUR).toISOString()),
    );
    assert.equal(result.stale, true);
    assert.equal(result.alerted, true);
    assert.equal(result.reason, "stale");
    const flow = forRoute(events, FLOW_ROUTE);
    assert.equal(flow.length, 1, "a stalled lane must page");
    assert.equal(flow[0]!.errorCode, "stale_lane");
    const flowRows = forLane(rows, FLOW_LANE);
    assert.equal(flowRows.length, 1);
    assert.equal(flowRows[0]!.verdict, "stale");
    assert.equal(flowRows[0]!.detail, "stale");
  });

  // The message must not promise a fallback that no longer exists. It used to
  // say the route "falls back to the frozen artifact", and following that now
  // would send a reader looking for a rung that was deleted.
  test("the page says the route serves EMPTY, not that it falls back", async () => {
    const { events } = await run(
      flowBody(new Date(NOW - 72 * HOUR).toISOString()),
    );
    const message = String(
      forRoute(events, FLOW_ROUTE)[0]!.error?.message ?? "",
    );
    assert.match(message, /serve an EMPTY leaderboard/);
    assert.match(message, /no second tier under it/);
    assert.doesNotMatch(message, /frozen artifact/);
  });

  // Nothing in this module carries state that would let a second tick decide
  // the first one already covered it.
  test("a repeat tick over the same artifact alerts again", async () => {
    const stale = flowBody(new Date(NOW - 72 * HOUR).toISOString());
    const first = await run(stale);
    const second = await run(stale);
    assert.equal(forRoute(first.events, FLOW_ROUTE).length, 1);
    assert.equal(forRoute(second.events, FLOW_ROUTE).length, 1);
  });

  test("an absent artifact pages, because the route then serves an empty list", async () => {
    const { result, events, rows } = await run(undefined);
    assert.equal(result.stale, true);
    assert.equal(result.reason, "absent");
    assert.equal(result.age_ms, null);
    // BOTH legs page here, and that is the one duplicate worth having: an
    // absent object is genuinely both lanes' problem, and neither operator
    // should have to infer it from the other's alert.
    assert.equal(forRoute(events, FLOW_ROUTE).length, 1);
    assert.equal(forRoute(events, HOLDINGS_ROUTE).length, 1);
    for (const lane of [FLOW_LANE, HOLDINGS_LANE]) {
      const [row] = forLane(rows, lane);
      assert.equal(row!.detail, "absent", lane);
      assert.equal(row!.age_ms, null, "an absent object has no measurable age");
    }
  });

  test("an empty artifact is reported as empty, not stale", async () => {
    const { result } = await run(
      flowBody(new Date(NOW - HOUR).toISOString(), []),
    );
    assert.equal(result.stale, true);
    assert.equal(result.reason, "empty");
  });

  test("a day-old ranking is healthy; three days is not", async () => {
    // The 48-hour bound is one whole cadence of slack over a daily lane, so a
    // pass has to have been genuinely skipped before this fires.
    const day = await run(flowBody(new Date(NOW - 24 * HOUR).toISOString()));
    assert.equal(day.result.stale, false);
    const three = await run(flowBody(new Date(NOW - 72 * HOUR).toISOString()));
    assert.equal(three.result.stale, true);
  });

  test("the threshold is overridable per-deployment", async () => {
    const { result } = await run(
      flowBody(new Date(NOW - 2 * HOUR).toISOString()),
      {
        TOP_HOLDERS_FLOW_STALENESS_THRESHOLD_MS: String(HOUR),
      },
    );
    assert.equal(result.stale, true);
    assert.equal(result.threshold_ms, HOUR);
  });

  // #9632. THE CASE THE WHOLE SPLIT EXISTS TO MAKE VISIBLE: the daily lane is
  // writing on schedule, so the flow leg is healthy and the old single-verdict
  // watchdog would have reported `ok` -- while the store-backed columns the
  // leaderboard ranks by have quietly drifted back to a day stale, which is
  // exactly the state #9632 was filed about.
  test("a healthy flow leg does not vouch for a stalled holdings leg", async () => {
    const { result, events, rows } = await run(
      flowBody(new Date(NOW - HOUR).toISOString(), undefined, {
        holdings_generated_at: new Date(NOW - 24 * HOUR).toISOString(),
      }),
    );
    assert.equal(result.stale, false, "the flow half really is fresh");
    assert.equal(result.alerted, true, "and the tick still pages");
    assert.equal(result.holdings.stale, true);
    assert.equal(result.holdings.reason, "stale");
    assert.equal(result.holdings.age_ms, 24 * HOUR);
    assert.deepEqual(forRoute(events, FLOW_ROUTE), []);
    assert.equal(forRoute(events, HOLDINGS_ROUTE).length, 1);
    assert.equal(forLane(rows, FLOW_LANE)[0]!.verdict, "ok");
    assert.equal(forLane(rows, HOLDINGS_LANE)[0]!.verdict, "stale");
  });

  // And the converse, so the two bounds cannot be silently collapsed into one:
  // the refresh keeps ticking while the daily lakehouse scan dies.
  test("a healthy holdings leg does not vouch for a stalled flow leg", async () => {
    const { result, events } = await run(
      flowBody(new Date(NOW - 72 * HOUR).toISOString(), undefined, {
        holdings_generated_at: new Date(NOW - HOUR).toISOString(),
      }),
    );
    assert.equal(result.stale, true);
    assert.equal(result.holdings.stale, false);
    assert.equal(forRoute(events, FLOW_ROUTE).length, 1);
    assert.deepEqual(forRoute(events, HOLDINGS_ROUTE), []);
  });

  // The bound is two missed ticks of a three-hourly cron. A twelve-hour-old
  // holdings half is well past it, and a two-hour-old one is not -- the
  // asymmetry with the flow leg's 48 h is the point, and a single shared
  // threshold would lose it.
  test("the holdings bound is six hours, not the flow leg's forty-eight", async () => {
    const at = async (hours: number) =>
      (
        await run(
          flowBody(new Date(NOW - HOUR).toISOString(), undefined, {
            holdings_generated_at: new Date(NOW - hours * HOUR).toISOString(),
          }),
        )
      ).result.holdings.stale;
    assert.equal(TOP_HOLDERS_HOLDINGS_STALENESS_THRESHOLD_MS, 6 * HOUR);
    assert.equal(await at(2), false);
    assert.equal(await at(5.9), false);
    assert.equal(await at(12), true);
    // The same age the flow leg calls perfectly healthy.
    assert.equal(await at(24), true);
  });

  test("the holdings threshold is overridable per-deployment", async () => {
    const { result } = await run(
      flowBody(new Date(NOW - HOUR).toISOString(), undefined, {
        holdings_generated_at: new Date(NOW - 2 * HOUR).toISOString(),
      }),
      { TOP_HOLDERS_HOLDINGS_STALENESS_THRESHOLD_MS: String(HOUR) },
    );
    assert.equal(result.holdings.stale, true);
    assert.equal(result.holdings.threshold_ms, HOUR);
  });

  // A body written before the split carries no `holdings_generated_at`, and
  // reading it as `generated_at` is the CORRECT reading rather than a hole: the
  // daily lane wrote both halves at that instant. The consequence is deliberate
  // -- on the first tick after this deploys, the holdings half really is a day
  // old and this really should fire until the first refresh lands.
  test("a pre-split body is judged on its flow stamp, and that is not a suppression", async () => {
    const { result } = await run(
      flowBody(new Date(NOW - 24 * HOUR).toISOString()),
    );
    assert.equal(result.stale, false, "24 h is inside the flow bound");
    assert.equal(result.holdings.stale, true, "and outside the holdings one");
    assert.equal(result.holdings.age_ms, 24 * HOUR);
  });

  // The message has to name the lane an operator would go and look at. A
  // holdings alert that read like the flow one would send them to the daily
  // lakehouse scan, which is working.
  test("the holdings page names the columns and says the ranking is wrong, not missing", async () => {
    const { events } = await run(
      flowBody(new Date(NOW - HOUR).toISOString(), undefined, {
        holdings_generated_at: new Date(NOW - 24 * HOUR).toISOString(),
      }),
    );
    const message = String(
      forRoute(events, HOLDINGS_ROUTE)[0]!.error?.message ?? "",
    );
    assert.match(message, /free_tao/);
    assert.match(message, /delegated_tao/);
    assert.match(message, /still RANKS on them/);
    assert.match(message, /24\.0 h old/);
  });

  test("`flow` is still on the summary, for a reader written against the old shape", async () => {
    const { result } = await run(flowBody(new Date(NOW - HOUR).toISOString()));
    assert.deepEqual(result.flow, {
      stale: false,
      reason: null,
      age_ms: HOUR,
      generated_at: new Date(NOW - HOUR).toISOString(),
      threshold_ms: TOP_HOLDERS_FLOW_STALENESS_THRESHOLD_MS,
    });
  });

  test("a failing notifier and a failing recorder both still complete the tick", async () => {
    const result = await runTopHoldersStalenessWatchdog(
      envWith(flowBody(new Date(NOW - 72 * HOUR).toISOString())),
      {
        now: () => NOW,
        laneHealthDb: {
          prepare() {
            throw new Error("no such table: lane_health");
          },
        } as never,
        recordException: (async () => {
          throw new Error("posthog is down");
        }) as never,
      },
    );
    assert.equal((result as Record<string, unknown>).ok, true);
  });

  test("runs on its defaults with no injected seams", async () => {
    const result = await runTopHoldersStalenessWatchdog(
      envWith(flowBody(new Date(Date.now() - HOUR).toISOString())),
    );
    assert.equal((result as Record<string, unknown>).ok, true);
    assert.equal((result as Record<string, unknown>).stale, false);
  });

  test("reads the projection key, and only that key", async () => {
    const seen: string[] = [];
    await runTopHoldersStalenessWatchdog(
      {
        METAGRAPH_ARCHIVE: {
          async get(key: string) {
            seen.push(key);
            return null;
          },
        },
      } as never,
      { now: () => NOW },
    );
    assert.deepEqual(seen, [TOP_HOLDERS_FLOW_PROJECTION_KEY]);
  });
});

describe("the watchdog's cron", () => {
  // Dispatch keys on the LITERAL cron string, so a duplicate would silently
  // route this lane's tick to whichever branch is checked first.
  test("handleScheduled dispatches to the watchdog and returns its summary", async () => {
    let read = 0;
    const result = (await runStalenessLane(
      "top-holders-flow-staleness",
      {
        METAGRAPH_ARCHIVE: {
          async get() {
            read += 1;
            return {
              async json() {
                return {
                  schema_version: 1,
                  generated_at: FROZEN_GENERATED_AT,
                  rows: [{ ss58: "5A" }],
                };
              },
            };
          },
        },
      } as never,
      {} as never,
    )) as Record<string, unknown>;
    // The POSITIVE: the branch actually reached the artifact. A summary from a
    // watchdog that read nothing is the failure this module exists to prevent.
    // ONE get -- the frozen holdings key it used to also read was deleted once
    // its columns got a live producer.
    assert.equal(read, 1);
    assert.equal(result.ok, true);
    assert.equal(result.reason, "stale");
    assert.equal(result.alerted, true);
  });

  test("an unbound bucket still reports through the cron wrapper", async () => {
    const result = (await runStalenessLane(
      "top-holders-flow-staleness",
      {} as never,
      {} as never,
    )) as Record<string, unknown>;
    assert.equal(result.ok, false);
    assert.equal(result.reason, "r2 binding unavailable");
  });
});
