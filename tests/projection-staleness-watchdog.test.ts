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
import { PROJECTION_LANES_CRON } from "../workers/config.ts";
import { DEFAULT_CHAIN_NETWORK, projectionKey } from "../src/chain-network.ts";
import { runStalenessLane } from "./helpers/staleness-lane.ts";

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

/**
 * The OTHER shape: a lane that runs on time and computes nothing.
 *
 * The age check cannot see it -- `generated_at` is minutes old on every tick
 * -- so this went unreported for a day while the site served an em-dash.
 */
describe("evaluateProjectionStaleness -- fresh but empty", () => {
  const FRESH = "2026-08-16T11:46:31.923Z";
  const NOW = Date.parse("2026-08-16T12:00:00.000Z");

  test("catches the real chain-alpha-volume artifact, verbatim", () => {
    // Read out of R2 on 2026-08-16 while /api/v1/chain/alpha-volume was
    // answering total_volume_tao: 0 with observed_at: null. Minutes old, and
    // empty because its rolling 24h window queried a lakehouse whose newest
    // data was ~29h back -- the raw-capture stall #11406 fixed.
    const verdict = evaluateProjectionStaleness({
      artifacts: [
        { lane: "chain-alpha-volume", generatedAt: FRESH, rowCount: 0 },
      ],
      nowMs: NOW,
      thresholdMs: PROJECTION_STALENESS_THRESHOLD_MS,
    });
    assert.equal(verdict.stale, true, "the watchdog reported ok for a day");
    assert.deepEqual(verdict.stale_lanes, ["chain-alpha-volume"]);
    const entry = verdict.entries[0]!;
    assert.equal(entry.reason, "empty");
    assert.equal(entry.row_count, 0);
    assert.ok(
      (entry.age_ms ?? 0) < PROJECTION_STALENESS_THRESHOLD_MS,
      "premise: it is FRESH -- the age rule could never have caught this",
    );
  });

  test("a lane with rows is healthy, so the rule is not vacuous", () => {
    const verdict = evaluateProjectionStaleness({
      artifacts: [
        { lane: "chain-alpha-volume", generatedAt: FRESH, rowCount: 128 },
      ],
      nowMs: NOW,
      thresholdMs: PROJECTION_STALENESS_THRESHOLD_MS,
    });
    assert.equal(verdict.stale, false);
    assert.equal(verdict.entries[0]!.reason, null);
    assert.equal(verdict.entries[0]!.row_count, 128);
  });

  test("a QUIET TEST CHAIN is not a fault -- emptyIsFault gates it", () => {
    // "Empty means broken" is a claim about ACTIVITY LEVEL, not about the lane.
    // It holds for mainnet -- a block every 12s with continuous staking, where
    // 24h of zero stake events would itself be the incident -- and not for a
    // test chain, which is allowed to be idle for a day.
    //
    // Measured on the tick after this rule shipped: it flagged
    // `chain-alpha-volume:testnet`, fresh at 12:24 with row_count 0. A rule
    // that stands permanently on testnet turns the whole lane into wallpaper.
    const verdict = evaluateProjectionStaleness({
      artifacts: [
        { lane: "chain-alpha-volume", generatedAt: FRESH, rowCount: 0 },
        {
          lane: "chain-alpha-volume:testnet",
          generatedAt: FRESH,
          rowCount: 0,
          emptyIsFault: false,
        },
      ],
      nowMs: NOW,
      thresholdMs: PROJECTION_STALENESS_THRESHOLD_MS,
    });
    assert.deepEqual(
      verdict.stale_lanes,
      ["chain-alpha-volume"],
      "mainnet still faults on the identical payload",
    );
    assert.equal(verdict.entries[1]!.reason, null);
    assert.equal(
      verdict.entries[1]!.row_count,
      0,
      "the count is still reported -- exempt from the verdict, not from the record",
    );
  });

  test("an exempt lane keeps every OTHER rule", () => {
    // The exemption is for emptiness alone. A testnet lane that stops being
    // written, or goes unreadable, must still fire -- which is what happened to
    // `chain-stake-moves:testnet` in the same production tick, correctly.
    const verdict = evaluateProjectionStaleness({
      artifacts: [
        {
          lane: "stale:testnet",
          generatedAt: "2026-08-14T09:00:00.000Z",
          rowCount: 0,
          emptyIsFault: false,
        },
        { lane: "absent:testnet", generatedAt: null, emptyIsFault: false },
      ],
      nowMs: NOW,
      thresholdMs: PROJECTION_STALENESS_THRESHOLD_MS,
    });
    assert.deepEqual(verdict.stale_lanes, ["stale:testnet", "absent:testnet"]);
    assert.equal(verdict.entries[0]!.reason, "stale");
    assert.equal(verdict.entries[1]!.reason, "absent");
  });

  test("a MISSING row_count is not read as zero", () => {
    // Silence is not a claim. An envelope that predates the field would
    // otherwise fire this on every lane at once, which is how a new alarm gets
    // muted on the day it ships.
    const verdict = evaluateProjectionStaleness({
      artifacts: [{ lane: "chain-fees", generatedAt: FRESH }],
      nowMs: NOW,
      thresholdMs: PROJECTION_STALENESS_THRESHOLD_MS,
    });
    assert.equal(verdict.stale, false);
    assert.equal(verdict.entries[0]!.reason, null);
    assert.equal(verdict.entries[0]!.row_count, null);
  });

  test("an OLD and empty lane still reports its AGE, not its emptiness", () => {
    // Both are true; the age is the bigger fact, and reporting "0 rows" for a
    // lane nothing has written in two days would name the wrong problem.
    const verdict = evaluateProjectionStaleness({
      artifacts: [
        {
          lane: "chain-stake-moves",
          generatedAt: "2026-08-14T09:13:53.426Z",
          rowCount: 0,
        },
      ],
      nowMs: NOW,
      thresholdMs: PROJECTION_STALENESS_THRESHOLD_MS,
    });
    assert.equal(verdict.stale, true);
    assert.equal(verdict.entries[0]!.reason, "stale");
    assert.equal(verdict.entries[0]!.row_count, 0, "still reported, not lost");
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

  /** Like bucketWith, but every object also carries a `row_count`. */
  function bucketWithRows(
    ages: Record<string, string>,
    rows: Record<string, number>,
  ) {
    return {
      METAGRAPH_ARCHIVE: {
        async get(key: string) {
          const generated = ages[key];
          if (generated === undefined) return null;
          return {
            async json() {
              return {
                schema_version: 1,
                generated_at: generated,
                ...(key in rows ? { row_count: rows[key] } : {}),
              };
            },
          };
        },
      },
    } as unknown as Record<string, unknown>;
  }

  test("reads row_count off the SAME body and names the empty lane", async () => {
    // The wiring, not the rule: the runner has to pull `row_count` out of the
    // artifact it already parsed for `generated_at`, or the rule above is
    // exercised by tests alone and never by production.
    const now = Date.parse("2026-08-16T12:00:00.000Z");
    const ages = allFresh(12, now);
    const emptyKey = projectionKey(
      PROJECTION_LANES.find((l) => l.name === "chain-alpha-volume")!
        .artifactKey,
      DEFAULT_CHAIN_NETWORK,
    );
    const messages: string[] = [];
    const result = (await runProjectionStalenessWatchdog(
      bucketWithRows(ages, { [emptyKey]: 0 }),
      {
        now: () => now,
        recordException: (async (_env: unknown, ev: { error?: unknown }) => {
          messages.push(String((ev.error as Error)?.message));
          return true;
        }) as never,
        laneHealthDb: null,
      },
    )) as { stale?: boolean; stale_lanes?: string[] };
    assert.equal(result.stale, true, "a fresh, empty lane is not healthy");
    assert.deepEqual(result.stale_lanes, ["chain-alpha-volume"]);
    assert.equal(messages.length, 1, "one event, naming the lane");
    assert.match(
      messages[0]!,
      /chain-alpha-volume \(fresh, 0 rows\)/,
      "the detail must not report an AGE for the one entry whose age is fine",
    );
  });

  test("a body with NO generated_at is absent, not silently fresh", async () => {
    // The artifact exists and parses, but carries no timestamp. Reading that
    // as anything other than "absent" would let a lane whose writer stopped
    // stamping its output sit in the fleet looking healthy forever -- the
    // schema's per-field `.catch` deliberately keeps the OBJECT parseable so
    // this stays a verdict rather than a thrown read.
    const now = Date.parse("2026-08-16T12:00:00.000Z");
    const ages = allFresh(12, now);
    const untimed = projectionKey(
      PROJECTION_LANES.find((l) => l.name === "chain-fees")!.artifactKey,
      DEFAULT_CHAIN_NETWORK,
    );
    const bucket = {
      METAGRAPH_ARCHIVE: {
        async get(key: string) {
          if (ages[key] === undefined) return null;
          return {
            async json() {
              return key === untimed
                ? { schema_version: 1, row_count: 12 }
                : { schema_version: 1, generated_at: ages[key] };
            },
          };
        },
      },
    } as unknown as Record<string, unknown>;
    const result = (await runProjectionStalenessWatchdog(bucket, {
      now: () => now,
      recordException: (async () => true) as never,
      laneHealthDb: null,
    })) as { stale?: boolean; stale_lanes?: string[] };
    assert.equal(result.stale, true);
    assert.deepEqual(result.stale_lanes, ["chain-fees"]);
  });

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

// #9330/#9340. This watchdog shipped notifying through recordExceptionEvent
// alone -- the channel that has already discarded three outages, because
// PostHog drops $exception once the free-tier quota is exhausted. Its healthy
// output is silence, so without a row per tick nothing distinguishes "all 26
// lanes were fresh" from "the watchdog has not run since the deploy".
describe("every tick leaves a durable verdict, not just a notification", () => {
  /** A lane_health sink that records what was written. */
  function laneHealth() {
    const rows: Record<string, unknown>[] = [];
    return {
      rows,
      db: {
        // Only the INSERT is recorded: recordLaneVerdict also prunes expired
        // rows on the way through, and counting that would make this assert
        // the number of statements rather than the number of verdicts.
        async query() {
          return [];
        },
        async run(sql: string, values: unknown[] = []) {
          if (sql.startsWith("INSERT INTO lane_health")) {
            rows.push({
              lane: values[0],
              verdict: values[1],
              age_ms: values[2],
              detail: values[3],
            });
          }
          return { changes: 1 };
        },
      },
    };
  }

  function bucketAt(iso: string | null) {
    return {
      METAGRAPH_ARCHIVE: {
        async get() {
          if (iso === null) return null;
          return {
            async json() {
              return { schema_version: 1, generated_at: iso };
            },
          };
        },
      },
    } as unknown as Record<string, unknown>;
  }

  test("a HEALTHY tick still writes a row", async () => {
    const now = Date.parse("2026-08-04T17:00:00.000Z");
    const sink = laneHealth();
    const events: unknown[] = [];
    await runProjectionStalenessWatchdog(
      bucketAt(new Date(now - 12 * 60_000).toISOString()),
      {
        now: () => now,
        laneHealthDb: sink.db as never,
        recordException: (async () => {
          events.push(1);
          return true;
        }) as never,
      },
    );
    // Nothing was notified -- and that is exactly why the row has to exist.
    assert.deepEqual(events, []);
    assert.equal(sink.rows.length, 1);
    assert.equal(sink.rows[0]!.lane, "projection-staleness");
    assert.equal(sink.rows[0]!.verdict, "ok");
  });

  test("a stale tick records WHICH lanes, not just that something was stale", async () => {
    const now = Date.parse("2026-08-04T17:00:00.000Z");
    const sink = laneHealth();
    await runProjectionStalenessWatchdog(
      bucketAt(new Date(now - 31 * HOUR).toISOString()),
      {
        now: () => now,
        laneHealthDb: sink.db as never,
        recordException: (async () => true) as never,
      },
    );
    assert.equal(sink.rows.length, 1);
    assert.equal(sink.rows[0]!.verdict, "stale");
    // The OLDEST age, since one stale lane is a stale fleet.
    assert.equal(sink.rows[0]!.age_ms, 31 * HOUR);
    assert.match(String(sink.rows[0]!.detail), /chain-/);
  });

  test("a missing lane_health table never breaks the tick", async () => {
    // migrations here are applied BY HAND, so the table can legitimately be
    // absent. A watchdog whose alarm-recording broke its alarm would be worse
    // than the bug it reports.
    const now = Date.parse("2026-08-04T17:00:00.000Z");
    const result = (await runProjectionStalenessWatchdog(
      bucketAt(new Date(now - 12 * 60_000).toISOString()),
      {
        now: () => now,
        laneHealthDb: {
          query() {
            throw new Error("no such table: lane_health");
          },
          run() {
            throw new Error("no such table: lane_health");
          },
        } as never,
        recordException: (async () => true) as never,
      },
    )) as { ok: boolean; stale: boolean };
    assert.equal(result.ok, true);
    assert.equal(result.stale, false);
  });
});

describe("the watchdog lane, as the heartbeat runs it", () => {
  test("the registry entry reaches the watchdog and returns its summary", async () => {
    const reads: string[] = [];
    const result = (await runStalenessLane(
      "projection-staleness",
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
      } as unknown,
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
});

describe("a lane whose empty is DECLARED (#11484)", () => {
  test("chain-prometheus is exempt from the zero-rows rule, and says why", () => {
    const lane = PROJECTION_LANES.find((l) => l.name === "chain-prometheus");
    assert.ok(lane, "chain-prometheus must still be a watched lane");
    assert.equal(
      lane?.emptyIsExpected,
      true,
      "the chain emits PrometheusServed and account_events curation drops it, " +
        "so zero rows is the correct answer and not a stall",
    );
  });

  test("no OTHER lane is exempt — this is a named exception, not a loosened rule", () => {
    // The watchdog's own comment asks for exemption by name rather than a rule
    // that cannot fire. If this list grows, each entry needs its own reason.
    const exempt = PROJECTION_LANES.filter(
      (l) => l.emptyIsExpected === true,
    ).map((l) => l.name);
    assert.deepEqual(exempt, ["chain-prometheus"]);
  });

  test("an exempt lane still faults on absent, unreadable and stale", () => {
    // The exemption is scoped to ONE reason. A lane that stops being written
    // at all, or whose artifact goes stale, must still alarm -- otherwise this
    // trades noise for blindness, which is the worse trade.
    const nowMs = Date.UTC(2026, 7, 19, 12, 0, 0);
    const one = (generatedAt: string | null, rowCount: number | null) =>
      evaluateProjectionStaleness({
        artifacts: [
          {
            lane: "chain-prometheus",
            generatedAt,
            rowCount,
            emptyIsFault: false,
          },
        ],
        nowMs,
        thresholdMs: HOUR,
      }).entries[0];

    const absent = one(null, null);
    assert.equal(absent.stale, true);
    assert.equal(absent.reason, "absent");

    const stale = one(new Date(nowMs - 5 * HOUR).toISOString(), 12);
    assert.equal(stale.stale, true);
    assert.equal(stale.reason, "stale");

    // ...and the one reason it IS exempt from.
    const empty = one(new Date(nowMs - 60_000).toISOString(), 0);
    assert.equal(empty.stale, false);
  });
});
