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
  readTopHoldersArtifactState,
  runTopHoldersStalenessWatchdog,
  TOP_HOLDERS_STALENESS_THRESHOLD_MS,
  type TopHoldersArtifactState,
} from "../src/top-holders-staleness-watchdog.ts";
import {
  TOP_HOLDERS_ARTIFACT_KEY,
  TOP_HOLDERS_FROZEN_GENERATED_AT,
  topHoldersArtifactRows,
} from "../src/top-holders-artifact.ts";
import { TOP_HOLDERS_STALENESS_WATCHDOG_CRON } from "../workers/config.ts";

const HOUR = 3_600_000;
const NOW = Date.parse("2026-08-05T02:00:00.000Z");

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
  // The production state, replayed. It is stale, it is recorded, and it
  // deliberately does NOT page: the condition is permanent and declared in
  // source, and an alarm that fires twice an hour forever stops being read.
  test("the frozen pre-decommission snapshot is stale but not an alert", () => {
    const verdict = verdictFor(present(TOP_HOLDERS_FROZEN_GENERATED_AT));
    assert.equal(verdict.stale, true);
    assert.equal(verdict.alert, false);
    assert.equal(verdict.reason, "frozen");
    assert.equal(verdict.generated_at, TOP_HOLDERS_FROZEN_GENERATED_AT);
    // The age is still measured, so the durable row carries how long this has
    // been going on even though nobody is paged about it.
    assert.ok(verdict.age_ms !== null && verdict.age_ms > 2 * 24 * HOUR);
  });

  // The branch that is dead today and is the whole point of the file: the day
  // a Cloudflare-native sink writes this key, `generated_at` stops matching the
  // constant and this becomes an ordinary staleness alarm with no code change.
  test("once the artifact moves off the frozen constant it alerts on age", () => {
    const refreshed = verdictFor(
      present(new Date(NOW - 3 * HOUR).toISOString()),
    );
    assert.equal(refreshed.stale, false);
    assert.equal(refreshed.alert, false);
    assert.equal(refreshed.reason, null);
    assert.equal(refreshed.age_ms, 3 * HOUR);

    const stalled = verdictFor(
      present(new Date(NOW - 20 * HOUR).toISOString()),
    );
    assert.equal(stalled.stale, true);
    assert.equal(stalled.alert, true, "a lane WITH a producer must page");
    assert.equal(stalled.reason, "stale");
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
      [present(TOP_HOLDERS_FROZEN_GENERATED_AT, 0), "empty"],
    ] as const) {
      const verdict = verdictFor(artifact);
      assert.equal(verdict.stale, true, reason);
      assert.equal(verdict.alert, true, reason);
      assert.equal(verdict.reason, reason);
    }
  });

  // An artifact emptied in place still serves nobody. Reporting that as
  // "frozen, as expected" would be the watchdog agreeing with the outage.
  test("empty beats frozen even at the frozen timestamp", () => {
    const verdict = verdictFor(present(TOP_HOLDERS_FROZEN_GENERATED_AT, 0));
    assert.equal(verdict.reason, "empty");
    assert.equal(verdict.alert, true);
    assert.notEqual(verdict.age_ms, null, "age is still measurable here");
  });

  test("an absent or unparseable artifact reports no age rather than zero", () => {
    assert.equal(verdictFor({ present: false, reason: "absent" }).age_ms, null);
    assert.equal(verdictFor(present("nope")).age_ms, null);
  });

  test("the threshold travels on every verdict", () => {
    const verdict = verdictFor(
      present(TOP_HOLDERS_FROZEN_GENERATED_AT),
      NOW,
      7,
    );
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
    generated_at: TOP_HOLDERS_FROZEN_GENERATED_AT,
    rows: [{ ss58: "5A", free_tao: "1" }],
  };

  test("reads the real artifact shape", async () => {
    assert.deepEqual(await readTopHoldersArtifactState(bucket(frozenBody)), {
      present: true,
      generatedAt: TOP_HOLDERS_FROZEN_GENERATED_AT,
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

  function envWith(body: unknown, extra: Record<string, unknown> = {}) {
    return {
      METAGRAPH_ARCHIVE: {
        async get() {
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

  const frozenBody = {
    schema_version: 1,
    generated_at: TOP_HOLDERS_FROZEN_GENERATED_AT,
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

  // The heart of the design: the frozen lane is written down on every tick and
  // pages nobody. Without the row there is nothing anywhere that distinguishes
  // a permanently dead leaderboard from one nobody has looked at.
  test("the frozen lane records every tick and notifies on none", async () => {
    const events: unknown[] = [];
    const spy = laneHealthSpy();
    const result = (await runTopHoldersStalenessWatchdog(envWith(frozenBody), {
      now: () => NOW,
      laneHealthDb: spy.db,
      recordException: (async (_e: unknown, ev: unknown) => {
        events.push(ev);
        return true;
      }) as never,
    })) as Record<string, unknown>;
    assert.equal(result.ok, true);
    assert.equal(result.stale, true);
    assert.equal(result.alerted, false);
    assert.equal(result.reason, "frozen");
    assert.deepEqual(events, [], "a permanent, documented state must not page");
    assert.equal(spy.rows.length, 1);
    assert.equal(spy.rows[0]!.lane, "top-holders-staleness");
    assert.equal(spy.rows[0]!.verdict, "stale");
    assert.equal(spy.rows[0]!.detail, "frozen");
    assert.equal(spy.rows[0]!.checked_at, NOW);
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

  // A watchdog whose alarm-recording broke its alarm would be worse than the
  // bug it reports, so both sinks are allowed to fail independently.
  test("a failing notifier and a failing recorder both still complete the tick", async () => {
    const result = (await runTopHoldersStalenessWatchdog(envWith(undefined), {
      now: () => NOW,
      laneHealthDb: {
        prepare() {
          throw new Error("no such table: lane_health");
        },
      },
      recordException: (async () => {
        throw new Error("posthog unreachable");
      }) as never,
    })) as Record<string, unknown>;
    assert.equal(result.ok, true);
    assert.equal(result.alerted, true);
  });

  // No `deps` at all: the real Date.now, the real recordExceptionEvent (a
  // no-op without a token) and the env's own D1 binding.
  test("runs on its defaults with no injected seams", async () => {
    const spy = laneHealthSpy();
    const result = (await runTopHoldersStalenessWatchdog(
      envWith(frozenBody, { METAGRAPH_HEALTH_DB: spy.db }),
    )) as Record<string, unknown>;
    assert.equal(result.ok, true);
    assert.equal(result.reason, "frozen");
    assert.equal(spy.rows.length, 1, "falls back to env.METAGRAPH_HEALTH_DB");
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
                  generated_at: TOP_HOLDERS_FROZEN_GENERATED_AT,
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
    assert.equal(read, 1);
    assert.equal(result.ok, true);
    assert.equal(result.reason, "frozen");
    assert.equal(result.alerted, false);
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
