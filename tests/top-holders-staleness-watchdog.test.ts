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
  readTopHoldersArtifactState,
  runTopHoldersStalenessWatchdog,
  TOP_HOLDERS_STALENESS_THRESHOLD_MS,
  type TopHoldersArtifactState,
} from "../src/top-holders-staleness-watchdog.ts";
import {
  TOP_HOLDERS_ARTIFACT_KEY,
  topHoldersArtifactRows,
} from "../src/top-holders-artifact.ts";
import { TOP_HOLDERS_FLOW_PROJECTION_KEY } from "../src/top-holders-flow-tier.ts";
import { TOP_HOLDERS_STALENESS_WATCHDOG_CRON } from "../workers/config.ts";

const HOUR = 3_600_000;
const NOW = Date.parse("2026-08-05T02:00:00.000Z");

/** The `generated_at` of the one-shot pre-decommission materialization sitting
 * in R2 today. A literal, deliberately NOT a constant imported from source:
 * #9475 deleted that constant because keying the alarm off it is what kept the
 * alarm quiet on the live defect. Here it is only a fixture. */
const FROZEN_GENERATED_AT = "2026-08-02T22:38:17.501738+00:00";

/** A present artifact carrying `rows` rows, generated at `generatedAt`. */
function present(
  generatedAt: string | null,
  rowCount = 2_965,
): TopHoldersArtifactState {
  return { present: true, generatedAt, rowCount };
}

function verdictFor(
  artifact: TopHoldersArtifactState,
  nowMs = NOW,
  thresholdMs = TOP_HOLDERS_STALENESS_THRESHOLD_MS,
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
    const old = new Date(NOW - 20 * HOUR).toISOString();
    // Same instant, expressed the way the frozen artifact expresses it and the
    // way an ISO writer would: neither spelling changes the verdict.
    for (const stamp of [old, "2026-08-04T06:00:00.000000+00:00"]) {
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
  // polls every 6h (ACCOUNT_BALANCES_POLL_SECS=21600).
  test("a lane anywhere in its normal six-hour swing is healthy", () => {
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
    assert.equal(at(TOP_HOLDERS_STALENESS_THRESHOLD_MS - 1), false);
    assert.equal(at(TOP_HOLDERS_STALENESS_THRESHOLD_MS), false);
    assert.equal(at(TOP_HOLDERS_STALENESS_THRESHOLD_MS + 1), true);
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
        assert.equal(key, TOP_HOLDERS_ARTIFACT_KEY, "reads the served key");
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
      assert.equal(topHoldersArtifactRows(body), null);
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
      { present: true, generatedAt: null, rowCount: 0 },
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
        prepare(sql: string) {
          return {
            bind(...values: unknown[]) {
              return {
                async run() {
                  if (sql.startsWith("INSERT")) {
                    rows.push({
                      lane: values[0],
                      verdict: values[1],
                      age_ms: values[2],
                      detail: values[3],
                      checked_at: values[4],
                    });
                  }
                },
              };
            },
          };
        },
      },
    };
  }

  /** A FRESH live-flow artifact (#9469). Supplied by default so the existing
   * assertions below stay about the frozen holdings half: a stale flow lane
   * would add its own event and change every count here for reasons that have
   * nothing to do with the case under test. */
  const freshFlowBody = {
    schema_version: 1,
    generated_at: new Date(NOW - HOUR).toISOString(),
    rows: [{ ss58: "5A", net_flow_7d: 1 }],
  };

  /** Explicit "there is no flow object". Passing `undefined` cannot say this:
   * an omitted argument and an explicit `undefined` both take the default. */
  const ABSENT_FLOW = Symbol("absent-flow");

  function envWith(
    body: unknown,
    extra: Record<string, unknown> = {},
    flowBody: unknown = freshFlowBody,
  ) {
    const flow = flowBody === ABSENT_FLOW ? undefined : flowBody;
    const bodyFor = (key: string) =>
      key === TOP_HOLDERS_FLOW_PROJECTION_KEY ? flow : body;
    return {
      METAGRAPH_ARCHIVE: {
        async get(key: string) {
          const found = bodyFor(key);
          return found === undefined
            ? null
            : {
                async json() {
                  return found;
                },
              };
        },
      },
      ...extra,
    } as unknown as Record<string, unknown>;
  }

  const frozenBody = {
    schema_version: 1,
    generated_at: FROZEN_GENERATED_AT,
    rows: [{ ss58: "5A" }, { ss58: "5B" }],
  };

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

  // The heart of the correction (#9475): the lane in production today BOTH
  // records and notifies. Recording alone is what let #9464 ship a watchdog
  // that was silent on the very defect it was built for.
  test("the live frozen artifact notifies AND records, every tick", async () => {
    const events: { route?: string; errorCode?: string; error?: Error }[] = [];
    const spy = laneHealthSpy();
    const result = (await runTopHoldersStalenessWatchdog(envWith(frozenBody), {
      now: () => NOW,
      laneHealthDb: spy.db,
      recordException: (async (_e: unknown, ev: never) => {
        events.push(ev);
        return true;
      }) as never,
    })) as Record<string, unknown>;
    assert.equal(result.ok, true);
    assert.equal(result.stale, true);
    assert.equal(result.alerted, true);
    assert.equal(result.reason, "stale");
    assert.equal(events.length, 1, "the production state must page");
    assert.equal(events[0]!.route, "watchdog:top-holders-staleness");
    assert.equal(events[0]!.errorCode, "stale_lane");
    assert.equal(spy.rows.length, 2, "one row per artifact since #9469");
    assert.equal(spy.rows[0]!.lane, "top-holders-staleness");
    assert.equal(spy.rows[0]!.verdict, "stale");
    assert.equal(spy.rows[0]!.detail, "stale");
    assert.equal(spy.rows[0]!.checked_at, NOW);
  });

  // Two consecutive ticks over the unchanged artifact: neither goes quiet.
  // Nothing in this module carries state that would let the second tick
  // decide the first one already covered it.
  test("a repeat tick over the same artifact alerts again", async () => {
    const events: unknown[] = [];
    const spy = laneHealthSpy();
    const run = () =>
      runTopHoldersStalenessWatchdog(envWith(frozenBody), {
        now: () => NOW,
        laneHealthDb: spy.db,
        recordException: (async () => {
          events.push(1);
          return true;
        }) as never,
      });
    await run();
    await run();
    assert.equal(events.length, 2);
    assert.equal(spy.rows.length, 4, "two artifacts x two ticks");
  });

  test("an absent artifact pages, because the route then serves an empty list", async () => {
    const events: { route?: string; errorCode?: string; error?: Error }[] = [];
    const spy = laneHealthSpy();
    const result = (await runTopHoldersStalenessWatchdog(envWith(undefined), {
      now: () => NOW,
      laneHealthDb: spy.db,
      recordException: (async (_e: unknown, ev: never) => {
        events.push(ev);
        return true;
      }) as never,
    })) as Record<string, unknown>;
    assert.equal(result.alerted, true);
    assert.equal(result.reason, "absent");
    assert.equal(events.length, 1);
    assert.equal(events[0]!.route, "watchdog:top-holders-staleness");
    assert.equal(events[0]!.errorCode, "stale_lane");
    assert.match(String(events[0]!.error?.message), /age unknown/);
    assert.match(String(events[0]!.error?.message), /EMPTY leaderboard/);
    assert.equal(spy.rows[0]!.age_ms, null);
    assert.equal(spy.rows[0]!.detail, "absent");
  });

  test("a stalled refreshed lane pages with its measured age", async () => {
    const events: { error?: Error }[] = [];
    const spy = laneHealthSpy();
    const result = (await runTopHoldersStalenessWatchdog(
      envWith({
        schema_version: 1,
        generated_at: new Date(NOW - 20 * HOUR).toISOString(),
        rows: [{ ss58: "5A" }],
      }),
      {
        now: () => NOW,
        laneHealthDb: spy.db,
        recordException: (async (_e: unknown, ev: never) => {
          events.push(ev);
          return true;
        }) as never,
      },
    )) as Record<string, unknown>;
    assert.equal(result.alerted, true);
    assert.equal(result.reason, "stale");
    assert.match(String(events[0]!.error?.message), /20\.0 h old/);
    assert.match(String(events[0]!.error?.message), /threshold 12\.0 h/);
    assert.equal(spy.rows[0]!.age_ms, 20 * HOUR);
  });

  test("a fresh lane records ok and stays silent", async () => {
    const events: unknown[] = [];
    const spy = laneHealthSpy();
    const result = (await runTopHoldersStalenessWatchdog(
      envWith({
        schema_version: 1,
        generated_at: new Date(NOW - HOUR).toISOString(),
        rows: [{ ss58: "5A" }],
      }),
      {
        now: () => NOW,
        laneHealthDb: spy.db,
        recordException: (async () => {
          events.push(1);
          return true;
        }) as never,
      },
    )) as Record<string, unknown>;
    assert.equal(result.stale, false);
    assert.equal(result.alerted, false);
    assert.deepEqual(events, []);
    assert.equal(spy.rows[0]!.verdict, "ok");
    assert.equal(spy.rows[0]!.detail, null);
  });

  test("the threshold is overridable per-deployment", async () => {
    const spy = laneHealthSpy();
    const result = (await runTopHoldersStalenessWatchdog(
      envWith(
        {
          schema_version: 1,
          generated_at: new Date(NOW - 3 * HOUR).toISOString(),
          rows: [{ ss58: "5A" }],
        },
        { TOP_HOLDERS_STALENESS_THRESHOLD_MS: String(HOUR) },
      ),
      {
        now: () => NOW,
        laneHealthDb: spy.db,
        recordException: (async () => true) as never,
      },
    )) as Record<string, unknown>;
    assert.equal(result.threshold_ms, HOUR);
    assert.equal(result.stale, true);
  });

  // #9469: the live half. It is a SECOND artifact on a SECOND cadence, so it
  // gets its own verdict, its own row and its own routed exception -- and the
  // frozen half's verdict must not move because of it.
  test("a fresh flow artifact records ok and pages nobody", async () => {
    const events: { route?: string }[] = [];
    const spy = laneHealthSpy();
    const result = (await runTopHoldersStalenessWatchdog(envWith(frozenBody), {
      now: () => NOW,
      laneHealthDb: spy.db,
      recordException: (async (_e: unknown, ev: never) => {
        events.push(ev);
        return true;
      }) as never,
    })) as Record<string, unknown>;
    const flow = result.flow as Record<string, unknown>;
    assert.equal(flow.stale, false);
    assert.equal(flow.reason, null);
    assert.equal(flow.threshold_ms, TOP_HOLDERS_FLOW_STALENESS_THRESHOLD_MS);
    assert.equal(spy.rows[1]!.lane, "top-holders-flow-staleness");
    assert.equal(spy.rows[1]!.verdict, "ok");
    // Only the frozen half paged.
    assert.deepEqual(
      events.map((e) => e.route),
      ["watchdog:top-holders-staleness"],
    );
  });

  // The failure this half exists to catch: with no flow artifact the route
  // falls back to the frozen one, whose net_flow_* cells are null on every
  // row -- so `?sort=net_flow_30d` silently answers in ss58 order again.
  test("an absent flow artifact pages under its own route label", async () => {
    const events: { route?: string; errorCode?: string }[] = [];
    const spy = laneHealthSpy();
    const result = (await runTopHoldersStalenessWatchdog(
      envWith(frozenBody, {}, ABSENT_FLOW),
      {
        now: () => NOW,
        laneHealthDb: spy.db,
        recordException: (async (_e: unknown, ev: never) => {
          events.push(ev);
          return true;
        }) as never,
      },
    )) as Record<string, unknown>;
    assert.equal((result.flow as Record<string, unknown>).reason, "absent");
    assert.equal(result.alerted, true);
    assert.equal(spy.rows[1]!.verdict, "stale");
    assert.equal(spy.rows[1]!.detail, "absent");
    assert.deepEqual(
      events.map((e) => e.route),
      ["watchdog:top-holders-staleness", "watchdog:top-holders-flow-staleness"],
    );
    assert.equal(events[1]!.errorCode, "stale_lane");
  });

  // A day-old flow ranking is FINE -- the lane is daily. Sizing the bound to
  // one cadence instead of two is the #9301 alarm-that-always-fires mistake.
  test("a day-old flow ranking is healthy; three days is not", async () => {
    const flowAt = (hoursAgo: number) => ({
      schema_version: 1,
      generated_at: new Date(NOW - hoursAgo * HOUR).toISOString(),
      rows: [{ ss58: "5A", net_flow_7d: 1 }],
    });
    const verdictAt = async (hoursAgo: number) => {
      const result = (await runTopHoldersStalenessWatchdog(
        envWith(frozenBody, {}, flowAt(hoursAgo)),
        {
          now: () => NOW,
          laneHealthDb: laneHealthSpy().db,
          recordException: (async () => true) as never,
        },
      )) as Record<string, unknown>;
      return result.flow as Record<string, unknown>;
    };
    assert.equal(
      (await verdictAt(25)).stale,
      false,
      "one missed pass is slack",
    );
    assert.equal((await verdictAt(72)).stale, true);
    assert.equal((await verdictAt(72)).reason, "stale");
  });

  test("the flow threshold is overridable per-deployment", async () => {
    const result = (await runTopHoldersStalenessWatchdog(
      envWith(
        frozenBody,
        { TOP_HOLDERS_FLOW_STALENESS_THRESHOLD_MS: String(HOUR) },
        {
          schema_version: 1,
          generated_at: new Date(NOW - 3 * HOUR).toISOString(),
          rows: [{ ss58: "5A", net_flow_7d: 1 }],
        },
      ),
      {
        now: () => NOW,
        laneHealthDb: laneHealthSpy().db,
        recordException: (async () => true) as never,
      },
    )) as Record<string, unknown>;
    const flow = result.flow as Record<string, unknown>;
    assert.equal(flow.threshold_ms, HOUR);
    assert.equal(flow.stale, true);
  });

  // An emptied-in-place flow artifact serves the same ss58-ordered fallback as
  // a missing one, and is a different repair.
  test("an empty flow artifact is reported as empty, not stale", async () => {
    const result = (await runTopHoldersStalenessWatchdog(
      envWith(
        frozenBody,
        {},
        {
          schema_version: 1,
          generated_at: new Date(NOW - HOUR).toISOString(),
          rows: [],
        },
      ),
      {
        now: () => NOW,
        laneHealthDb: laneHealthSpy().db,
        recordException: (async () => true) as never,
      },
    )) as Record<string, unknown>;
    assert.equal((result.flow as Record<string, unknown>).reason, "empty");
  });

  // A watchdog whose alarm-recording broke its alarm would be worse than the
  // bug it reports, so both sinks are allowed to fail independently.
  test("a failing notifier and a failing recorder both still complete the tick", async () => {
    // BOTH artifacts absent, so both halves try to notify and both try to
    // record -- four independent failure points in one tick.
    const result = (await runTopHoldersStalenessWatchdog(
      envWith(undefined, {}, ABSENT_FLOW),
      {
        now: () => NOW,
        laneHealthDb: {
          prepare() {
            throw new Error("no such table: lane_health");
          },
        },
        recordException: (async () => {
          throw new Error("posthog unreachable");
        }) as never,
      },
    )) as Record<string, unknown>;
    assert.equal(result.ok, true);
    assert.equal(result.alerted, true);
    assert.equal((result.flow as Record<string, unknown>).reason, "absent");
  });

  // No `deps` at all: the real Date.now, the real recordExceptionEvent (a
  // no-op without a token) and the env's own D1 binding.
  test("runs on its defaults with no injected seams", async () => {
    const spy = laneHealthSpy();
    const result = (await runTopHoldersStalenessWatchdog(
      envWith(frozenBody, { METAGRAPH_HEALTH_DB: spy.db }),
    )) as Record<string, unknown>;
    assert.equal(result.ok, true);
    assert.equal(result.reason, "stale");
    assert.equal(spy.rows.length, 2, "falls back to env.METAGRAPH_HEALTH_DB");
    assert.ok(Number(spy.rows[0]!.checked_at) > 0, "uses the real clock");
  });
});

describe("the watchdog's cron", () => {
  // Dispatch keys on the LITERAL cron string, so a duplicate would silently
  // route this lane's tick to whichever branch is checked first.
  test("is twice hourly, off the */5 and */15 grids, and unique", async () => {
    const config = (await import("../workers/config.ts")) as Record<
      string,
      unknown
    >;
    const others = Object.entries(config)
      .filter(
        ([key, value]) =>
          key.endsWith("_CRON") &&
          key !== "TOP_HOLDERS_STALENESS_WATCHDOG_CRON" &&
          typeof value === "string",
      )
      .map(([, value]) => value);
    assert.ok(
      !others.includes(TOP_HOLDERS_STALENESS_WATCHDOG_CRON),
      "cron string must be unique across workers/config.ts",
    );
    const minutes = TOP_HOLDERS_STALENESS_WATCHDOG_CRON.split(" ")[0]!
      .split(",")
      .map(Number);
    assert.deepEqual(minutes, [22, 52]);
    for (const minute of minutes) {
      assert.notEqual(minute % 5, 0, "stays off the */5 raw-capture grid");
      assert.notEqual(minute % 15, 0, "stays off the */15 probe grid");
    }
  });

  test("wrangler.jsonc declares the trigger", async () => {
    // A cron the Worker dispatches on but wrangler never fires is dead code,
    // and the failure is silent: the branch simply never runs.
    const { readFileSync } = await import("node:fs");
    const raw = readFileSync(
      new URL("../wrangler.jsonc", import.meta.url),
      "utf8",
    )
      .replace(/^\s*\/\/.*$/gm, "")
      .replace(/,(\s*[}\]])/g, "$1");
    const parsed = JSON.parse(raw) as { triggers?: { crons?: string[] } };
    assert.ok(
      parsed.triggers?.crons?.includes(TOP_HOLDERS_STALENESS_WATCHDOG_CRON),
      `wrangler.jsonc must fire ${TOP_HOLDERS_STALENESS_WATCHDOG_CRON}`,
    );
  });

  test("handleScheduled dispatches to the watchdog and returns its summary", async () => {
    const { handleScheduled } = await import("../workers/api.ts");
    let read = 0;
    const result = (await handleScheduled(
      { cron: TOP_HOLDERS_STALENESS_WATCHDOG_CRON } as never,
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
    // The POSITIVE: the branch actually reached the artifacts. A summary from
    // a watchdog that read nothing is the failure this module exists to
    // prevent. Two gets since #9469 -- the frozen key and the flow key.
    assert.equal(read, 2);
    assert.equal(result.ok, true);
    assert.equal(result.reason, "stale");
    assert.equal(result.alerted, true);
  });

  test("an unbound bucket still reports through the cron wrapper", async () => {
    const { handleScheduled } = await import("../workers/api.ts");
    const result = (await handleScheduled(
      { cron: TOP_HOLDERS_STALENESS_WATCHDOG_CRON } as never,
      {} as never,
      {} as never,
    )) as Record<string, unknown>;
    assert.equal(result.ok, false);
    assert.equal(result.reason, "r2 binding unavailable");
  });
});
