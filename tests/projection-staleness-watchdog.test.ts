// The projection lanes' alarm (#9423).
//
// The case that matters is the one it was written for: chain-stake-moves and
// chain-stake-transfers stopped writing on 2026-08-03T09:13 and nothing
// noticed for 31 hours, because a lane that cannot compute leaves the previous
// artifact in place and the route serves it. The first test below replays
// those exact timestamps.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  cronIntervalMs,
  evaluateProjectionStaleness,
  PROJECTION_STALENESS_MISSED_TICKS,
  PROJECTION_STALENESS_THRESHOLD_MS,
  projectionStalenessThresholdMs,
  runProjectionStalenessWatchdog,
} from "../src/projection-staleness-watchdog.ts";
import {
  PROJECTION_LANES,
  PROJECTION_NETWORKS,
} from "../src/projection-lanes.ts";
import {
  PROJECTION_LANES_CRON,
  PROJECTION_STALENESS_WATCHDOG_CRON,
} from "../workers/config.ts";
import { projectionKey } from "../src/chain-network.ts";

const HOUR = 3_600_000;

describe("evaluateProjectionStaleness", () => {
  // The production incident, replayed. 31 hours of silence, and the only
  // signal available was an R2 object timestamp nobody was reading.
  test("catches the 31-hour stall it was written for", () => {
    const now = Date.parse("2026-08-04T16:45:00.000Z");
    const verdict = evaluateProjectionStaleness({
      artifacts: [
        { lane: "blocks-summary", generatedAt: "2026-08-04T16:41:19.088Z" },
        { lane: "chain-stake-moves", generatedAt: "2026-08-03T09:13:53.426Z" },
        {
          lane: "chain-stake-transfers",
          generatedAt: "2026-08-03T09:13:22.352Z",
        },
      ],
      nowMs: now,
      thresholdMs: PROJECTION_STALENESS_THRESHOLD_MS,
    });
    assert.equal(verdict.stale, true);
    assert.deepEqual(verdict.stale_lanes, [
      "chain-stake-moves",
      "chain-stake-transfers",
    ]);
    // The healthy lane on the same tick is NOT swept up: an alarm that fires
    // on everything names nothing.
    assert.equal(verdict.checked, 3);
    const healthy = verdict.entries.find((e) => e.lane === "blocks-summary")!;
    assert.equal(healthy.stale, false);
    assert.equal(healthy.reason, null);
    assert.ok((healthy.age_ms ?? 0) < HOUR);
  });

  // The sizing rule #9301 corrected the sibling watchdog for: a healthy lane's
  // age swings across its whole producer interval, so a threshold near one
  // interval alerts on a lane that is working.
  test("a lane anywhere in its normal 30-minute swing is healthy", () => {
    const now = Date.parse("2026-08-04T17:00:00.000Z");
    for (const minutes of [0, 5, 17, 29, 35]) {
      const verdict = evaluateProjectionStaleness({
        artifacts: [
          {
            lane: "chain-transfers",
            generatedAt: new Date(now - minutes * 60_000).toISOString(),
          },
        ],
        nowMs: now,
        thresholdMs: PROJECTION_STALENESS_THRESHOLD_MS,
      });
      assert.equal(verdict.stale, false, `${minutes} min old must be healthy`);
    }
  });

  test("fires only once past the threshold, not before", () => {
    const now = Date.parse("2026-08-04T17:00:00.000Z");
    const at = (ms: number) =>
      evaluateProjectionStaleness({
        artifacts: [
          {
            lane: "chain-transfers",
            generatedAt: new Date(now - ms).toISOString(),
          },
        ],
        nowMs: now,
        thresholdMs: PROJECTION_STALENESS_THRESHOLD_MS,
      }).stale;
    assert.equal(at(PROJECTION_STALENESS_THRESHOLD_MS - 1), false);
    assert.equal(at(PROJECTION_STALENESS_THRESHOLD_MS), false);
    assert.equal(at(PROJECTION_STALENESS_THRESHOLD_MS + 1), true);
  });

  // An artifact that is not there and one whose timestamp cannot be read are
  // both stalls, and they are told apart because the fixes differ.
  test("absent and unreadable are distinct stall reasons", () => {
    const verdict = evaluateProjectionStaleness({
      artifacts: [
        { lane: "chain-fees", generatedAt: null },
        { lane: "chain-calls", generatedAt: undefined },
        { lane: "chain-signers", generatedAt: "not a timestamp" },
      ],
      nowMs: Date.now(),
      thresholdMs: PROJECTION_STALENESS_THRESHOLD_MS,
    });
    assert.deepEqual(
      verdict.entries.map((e) => e.reason),
      ["absent", "absent", "unreadable"],
    );
    assert.equal(verdict.stale_lanes.length, 3);
  });
});

describe("runProjectionStalenessWatchdog", () => {
  /** A bucket whose objects carry the given ages, keyed by artifact key. */
  function bucketWith(ages: Record<string, string | null>, fail = false) {
    return {
      METAGRAPH_ARCHIVE: {
        async get(key: string) {
          if (fail) throw new Error("r2 unreachable");
          const generated = ages[key];
          if (generated === undefined || generated === null) return null;
          return {
            async json() {
              return { schema_version: 1, generated_at: generated };
            },
          };
        },
      },
    } as unknown as Record<string, unknown>;
  }

  /** Every lane on every network, all written `minutes` ago. */
  function allFresh(minutes: number, now: number) {
    const at = new Date(now - minutes * 60_000).toISOString();
    const out: Record<string, string> = {};
    for (const network of PROJECTION_NETWORKS) {
      for (const lane of PROJECTION_LANES) {
        out[projectionKey(lane.artifactKey, network)] = at;
      }
    }
    return out;
  }

  test("a healthy fleet records nothing at all", async () => {
    const now = Date.parse("2026-08-04T17:00:00.000Z");
    const events: string[] = [];
    const result = (await runProjectionStalenessWatchdog(
      bucketWith(allFresh(12, now)),
      {
        now: () => now,
        recordException: (async (_e: unknown, ev: { route?: string }) => {
          events.push(String(ev.route));
          return true;
        }) as never,
      },
    )) as { ok: boolean; stale: boolean; checked: number };
    assert.equal(result.ok, true);
    assert.equal(result.stale, false);
    // The POSITIVE: it actually looked at every lane on every network. A
    // "nothing was stale" verdict from a watchdog that read nothing is the
    // failure this whole module exists to prevent.
    assert.equal(
      result.checked,
      PROJECTION_LANES.length * PROJECTION_NETWORKS.length,
    );
    assert.deepEqual(events, [], "zero alerts is the healthy steady state");
  });

  test("one event names every stale lane, rather than one event each", async () => {
    const now = Date.parse("2026-08-04T17:00:00.000Z");
    const ages = allFresh(12, now);
    const stale = new Date(now - 31 * HOUR).toISOString();
    ages[projectionKey("metagraph/projections/chain-stake-moves.json")] = stale;
    ages[projectionKey("metagraph/projections/chain-stake-transfers.json")] =
      stale;
    const events: { route?: string; error?: Error }[] = [];
    const result = (await runProjectionStalenessWatchdog(bucketWith(ages), {
      now: () => now,
      recordException: (async (_e: unknown, ev: never) => {
        events.push(ev);
        return true;
      }) as never,
    })) as { stale: boolean; stale_lanes: string[] };
    assert.equal(result.stale, true);
    // Registry order, not alphabetical -- the alert reads in the same order
    // the run summary does.
    assert.deepEqual(result.stale_lanes, [
      "chain-stake-transfers",
      "chain-stake-moves",
    ]);
    // Twenty-six alerts for one dead cron is the failure mode where an alarm
    // stops being read.
    assert.equal(events.length, 1);
    assert.equal(events[0]!.route, "watchdog:projection-staleness");
    assert.match(String(events[0]!.error?.message), /chain-stake-moves/);
    assert.match(String(events[0]!.error?.message), /chain-stake-transfers/);
    assert.match(String(events[0]!.error?.message), /31\.0 h old/);
    // The bound is quoted in the unit the judgement is about.
    assert.match(
      String(events[0]!.error?.message),
      new RegExp(`${PROJECTION_STALENESS_MISSED_TICKS} missed ticks`),
    );
  });

  test("a testnet lane is watched under its own label", async () => {
    const now = Date.parse("2026-08-04T17:00:00.000Z");
    const ages = allFresh(12, now);
    const [nonDefault] = PROJECTION_NETWORKS.filter((n) => n !== "mainnet");
    if (!nonDefault) return;
    ages[projectionKey("metagraph/projections/chain-fees.json", nonDefault)] =
      new Date(now - 9 * HOUR).toISOString();
    const result = (await runProjectionStalenessWatchdog(bucketWith(ages), {
      now: () => now,
      recordException: (async () => true) as never,
    })) as { stale_lanes: string[] };
    assert.deepEqual(result.stale_lanes, [`chain-fees:${nonDefault}`]);
  });

  test("an unreadable bucket is a stall, never a silent pass", async () => {
    const now = Date.parse("2026-08-04T17:00:00.000Z");
    const result = (await runProjectionStalenessWatchdog(bucketWith({}, true), {
      now: () => now,
      recordException: (async () => true) as never,
    })) as { stale: boolean; stale_lanes: string[] };
    assert.equal(result.stale, true);
    assert.equal(
      result.stale_lanes.length,
      PROJECTION_LANES.length * PROJECTION_NETWORKS.length,
    );
  });

  // A bucket that answers with no object at all, as distinct from one that
  // throws: the lane simply has not written yet, which is still a stall.
  test("a missing object is a stall, not a skipped lane", async () => {
    const now = Date.parse("2026-08-04T17:00:00.000Z");
    const env = {
      METAGRAPH_ARCHIVE: {
        async get() {
          return null;
        },
      },
    } as unknown as Record<string, unknown>;
    let recorded = 0;
    const result = (await runProjectionStalenessWatchdog(env, {
      now: () => now,
      recordException: (async () => {
        recorded += 1;
        return true;
      }) as never,
    })) as { stale: boolean; entries: { reason: string | null }[] };
    assert.equal(result.stale, true);
    assert.ok(result.entries.every((e) => e.reason === "absent"));
    assert.equal(recorded, 1);
  });

  // The alert must never take the tick down with it: a telemetry sink that
  // rejects is one missed report, not an outage.
  test("a rejecting telemetry sink does not fail the tick", async () => {
    const now = Date.parse("2026-08-04T17:00:00.000Z");
    const result = (await runProjectionStalenessWatchdog(
      {
        METAGRAPH_ARCHIVE: {
          async get() {
            return null;
          },
        },
      } as unknown as Record<string, unknown>,
      {
        now: () => now,
        recordException: (() =>
          Promise.reject(new Error("telemetry down"))) as never,
      },
    )) as { ok: boolean; stale: boolean };
    assert.equal(result.ok, true);
    assert.equal(result.stale, true);
  });

  test("an unbound archive reports why, rather than a healthy verdict", async () => {
    const result = (await runProjectionStalenessWatchdog({})) as {
      ok: boolean;
      reason: string;
    };
    assert.equal(result.ok, false);
    assert.match(result.reason, /r2 binding/);
  });

  test("the threshold is overridable per deployment", async () => {
    const now = Date.parse("2026-08-04T17:00:00.000Z");
    const env = {
      ...bucketWith(allFresh(90, now)),
      PROJECTION_STALENESS_THRESHOLD_MS: String(HOUR),
    };
    const result = (await runProjectionStalenessWatchdog(env, {
      now: () => now,
      recordException: (async () => true) as never,
    })) as { stale: boolean; threshold_ms: number };
    assert.equal(result.threshold_ms, HOUR);
    assert.equal(
      result.stale,
      true,
      "90 min must be stale against a 1 h bound",
    );
  });
});

// THE THRESHOLD IS NOT A WALL-CLOCK CONSTANT. It is N missed ticks of whatever
// cadence the lane cron currently declares, so moving the producer moves the
// bound with it -- a second hand-maintained number would go silently wrong,
// and "silently wrong" here means an alarm that never fires or always does.
describe("the threshold follows the producer's cadence", () => {
  test("it is exactly N missed ticks of the lane cron", () => {
    const interval = cronIntervalMs(PROJECTION_LANES_CRON);
    assert.ok(interval, "the lane cron must yield an interval");
    assert.equal(
      PROJECTION_STALENESS_THRESHOLD_MS,
      PROJECTION_STALENESS_MISSED_TICKS * interval!,
    );
    // And it clears a healthy lane's whole swing by a wide margin.
    assert.ok(PROJECTION_STALENESS_THRESHOLD_MS > interval! * 2);
  });

  test("it would move if the lane cron did", () => {
    // The property that makes this not-a-constant: change the cadence, the
    // bound follows. A quarter-hourly lane gets a two-hour bound, not four.
    assert.equal(cronIntervalMs("11,41 * * * *"), 30 * 60_000);
    assert.equal(cronIntervalMs("0,15,30,45 * * * *"), 15 * 60_000);
    assert.equal(cronIntervalMs("17 * * * *"), 60 * 60_000);
  });

  test("an uneven minute list is measured by its NARROWEST gap", () => {
    // `5,10,50` ticks 5 minutes apart and then 15, then 40. A healthy lane has
    // to clear the bound on the WIDE gap, so only the narrow one tells you
    // what a tick is worth -- taking the average would under-size the bound
    // and alert on a lane that is working.
    assert.equal(cronIntervalMs("5,10,50 * * * *"), 5 * 60_000);
    // Including the wrap across the hour boundary.
    assert.equal(cronIntervalMs("1,58 * * * *"), 3 * 60_000);
  });

  test("an unparseable cron falls back to the cadence the lane has always had", () => {
    // Not a guess at the unreadable cron's cadence: 30 minutes is what
    // PROJECTION_LANES_CRON has always been, kept as the conservative floor so
    // a cron this parser cannot read degrades to today's bound rather than to
    // no bound at all.
    assert.equal(
      projectionStalenessThresholdMs("*/5 * * * *"),
      PROJECTION_STALENESS_MISSED_TICKS * 30 * 60_000,
    );
    assert.equal(
      projectionStalenessThresholdMs("0,15,30,45 * * * *"),
      PROJECTION_STALENESS_MISSED_TICKS * 15 * 60_000,
    );
  });

  test("an unparseable cron yields null rather than a wrong number", () => {
    for (const cron of [
      "*/5 * * * *",
      "",
      "abc * * * *",
      "-1 * * * *",
      // A minute past the end of the hour is not a minute -- and it would
      // otherwise produce a negative gap and a bound below zero.
      "60 * * * *",
      "1,90 * * * *",
      "1,,5 * * * *",
    ]) {
      assert.equal(cronIntervalMs(cron), null, JSON.stringify(cron));
    }
  });
});

describe("the watchdog cron", () => {
  // Dispatch keys on the LITERAL cron string, so a duplicate silently steals
  // the other's tick.
  test("does not collide with the lane cron it watches", async () => {
    const config = await import("../workers/config.ts");
    const crons = Object.entries(config)
      .filter(([name]) => name.endsWith("_CRON"))
      .map(([, value]) => String(value));
    const mine = crons.filter((c) => c === PROJECTION_STALENESS_WATCHDOG_CRON);
    assert.equal(mine.length, 1, "the cron string must be unique in config");
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
      parsed.triggers?.crons?.includes(PROJECTION_STALENESS_WATCHDOG_CRON),
      `wrangler.jsonc must fire ${PROJECTION_STALENESS_WATCHDOG_CRON}`,
    );
  });

  test("handleScheduled dispatches to the watchdog and returns its summary", async () => {
    const { handleScheduled } = await import("../workers/api.ts");
    const reads: string[] = [];
    const result = (await handleScheduled(
      {
        cron: PROJECTION_STALENESS_WATCHDOG_CRON,
      } as unknown as ScheduledController,
      {
        METAGRAPH_ARCHIVE: {
          async get(key: string) {
            reads.push(key);
            return {
              async json() {
                return {
                  schema_version: 1,
                  generated_at: new Date().toISOString(),
                };
              },
            };
          },
        },
      } as unknown as Parameters<typeof handleScheduled>[1],
      {} as unknown as ExecutionContext,
    )) as { ok: boolean; stale: boolean; checked: number };
    assert.equal(result.ok, true);
    assert.equal(result.stale, false);
    // The POSITIVE: the tick actually read every lane on every network. A
    // healthy verdict from a dispatch that read nothing is the exact failure
    // this module exists to prevent.
    assert.equal(
      reads.length,
      PROJECTION_LANES.length * PROJECTION_NETWORKS.length,
    );
    assert.equal(result.checked, reads.length);
  });

  test("samples after a lane run has finished, not during one", () => {
    const [watchMinutes] = PROJECTION_STALENESS_WATCHDOG_CRON.split(" ");
    const minutes = watchMinutes!.split(",").map(Number);
    // The lane cron is 11,41; a run takes ~5 minutes. Judging at 2,32 leaves
    // 21 minutes of slack, so a slow run is never called stale mid-flight.
    for (const m of minutes) {
      const sinceLaneStart = (m - 11 + 60) % 30;
      assert.ok(
        sinceLaneStart >= 10,
        `minute ${m} judges only ${sinceLaneStart} min after a lane tick begins`,
      );
    }
  });
});
