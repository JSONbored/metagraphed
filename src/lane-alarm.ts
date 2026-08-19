// The READER for lane_health -- the half of #9330/#9340 that was never built.
//
// Every staleness watchdog in this repo writes a verdict every tick, and
// src/lane-health.ts is emphatic about why: PostHog `$exception` is a
// notification, and "did anyone get paged" is a different question from "was
// anything stale overnight". That was right, and the durable record has worked
// perfectly ever since. What nobody noticed is that answering the second
// question still requires somebody to ASK it.
//
// Measured on the 2026-08-06 metagraph outage: `neurons-staleness` recorded 112
// consecutive `stale` verdicts across 28 hours. Every one landed. The verdict
// was correct, the reason string named the fault, and GET /api/v1/self-health
// served `stale_lane_count` publicly the entire time. Nobody looked, because
// every path to that record is a PULL. Three other lanes were also stale at the
// moment this was written -- `metagraph`, `subnet-snapshot`, and
// `top-holders-staleness`, the last of them by 102 hours -- and each had been
// invisible for exactly the same reason.
//
// So this is the push. It reads what the watchdogs already wrote and opens a
// GitHub issue, which is where this project's maintainer actually works.
//
// ## Why GitHub and not another notifier
//
// GITHUB_TOKEN is already provisioned on this Worker. No Discord, Slack,
// Telegram, or Resend credential is -- checked against `wrangler secret list`,
// not assumed -- so every other channel would mean provisioning a new external
// dependency to report that an external dependency stopped reporting.
//
// An issue is also the right SHAPE. It is durable, it deduplicates against
// itself, it carries the diagnosis in a form you can reply to, and closing it
// on recovery keeps the open-issue count honest rather than accumulating alarm
// residue. This is a Worker cron calling the GitHub API -- not a GitHub Action.
//
// ## Two faults, one reader
//
// A lane can fail in two ways and only the first was ever detectable:
//
//   STALE   -- the watchdog ran and said the lane is behind.
//   SILENT  -- the watchdog itself stopped running, so the newest verdict is
//              old and still says `ok`. `staleLanes()` reports nothing, because
//              nothing it can see is stale. This is strictly worse than the
//              first fault and had no detector at all.
//
// Silence is measured against each lane's OWN observed cadence rather than a
// table of expected intervals, because such a table is a second place to
// remember to edit -- see [feedback] "size a watchdog to its producer". The
// cadences here really do span three orders of magnitude (`tao-usd-index` is
// every minute, `top-holders-flow` is daily), so one shared constant could only
// ever be wrong for most of them.

import { laneSilenceCadenceMs } from "./producer-cadence.ts";
import { DEAD_LETTER_LANE_NAMES } from "./dead-letter.ts";
import {
  loadLatestLaneHealth,
  staleLanes,
  type LaneHealthDb,
  type LaneHealthRecord,
  type LaneVerdict,
} from "./lane-health.ts";
import { recordLaneVerdict } from "./lane-health.ts";
import { recordExceptionEvent } from "./usage-telemetry.ts";
import {
  GithubCreatedIssueSchema,
  GithubIssueListSchema,
  GithubIssueSchema,
  GithubSearchResultSchema,
} from "../schemas-src/foreign-wire.ts";
import { laneHealthStore } from "./lane-health-store.ts";
import { countOrZero } from "./read-store.ts";
import type { StoreEnv } from "./read-store.ts";
import type { TelemetryEnv } from "./usage-telemetry.ts";

/**
 * What this module reads from its environment, and nothing else.
 *
 * Named rather than left as `Record<string, unknown>` (#11339): a Record
 * READS as loose but is not, because `Env` is an interface and TypeScript
 * never gives interfaces implicit index signatures -- so every caller
 * holding a real `Env` wrote `env as unknown as Record<string, unknown>`
 * to get past it. Listing the keys costs nothing and states the contract.
 */
type LaneAlarmEnv = StoreEnv &
  TelemetryEnv & {
    GITHUB_TOKEN?: unknown;
    LANE_ALARM_GITHUB_TOKEN?: unknown;
    LANE_ALARM_MIN_STALE_MS?: unknown;
    LANE_ALARM_RATE_WINDOW_MS?: unknown;
    LANE_ALARM_REPO?: unknown;
  };

/**
 * How long a lane must stay stale before it earns an issue.
 *
 * ONE HOUR. The single most important number here, and it is a floor on noise
 * rather than on latency: the #9301 rule is that an alarm which fires on a
 * working lane stops being read, and several lanes in this repo flick stale for
 * one tick during a deploy or an eviction. `chain-detail` did it 64 times in
 * the day this was written while being fundamentally healthy.
 *
 * An hour is comfortably longer than any single lane's tick, so a one-tick blip
 * can never reach it, and comfortably shorter than the outages that actually
 * matter -- the three that motivated this were 4 hours, 28 hours, and 102
 * hours. Overridable via LANE_ALARM_MIN_STALE_MS.
 */
export const LANE_ALARM_MIN_STALE_MS = 60 * 60 * 1000;

/**
 * How many issues one tick may open.
 *
 * FOUR. A platform-wide outage takes every lane stale at once, and the useful
 * report of that is not twenty issues -- it is the first few, plus the fact
 * that there were twenty, which the summary carries either way. The cap also
 * bounds the blast radius of a bug in this file, which is worth having in
 * something whose whole job is to act on its own without supervision.
 */
export const LANE_ALARM_MAX_OPENS_PER_TICK = 4;

/**
 * How far back the FLAPPING rule looks (#11488).
 *
 * A run is the unbroken tail of one verdict, so a lane that goes stale,
 * recovers, and goes stale again never accumulates one -- and this file's
 * one-hour minimum is measured on that run. Measured 2026-08-19,
 * `chain-detail-staleness` spent 12.5 minutes at 851s behind against a 300s
 * threshold, recorded `stale` in lane_health, and opened nothing, because no
 * single episode lasted the 45 minutes three consecutive quarter-hourly ticks
 * would need. `chain_detail`'s own write-latency tail says that is not rare:
 * p95 718s, p99 969s.
 *
 * A lane that is broken a third of the time is broken. Twenty-four hours is
 * long enough that a deploy's one-tick blip cannot dominate the ratio, and
 * short enough that a lane which recovered yesterday stops alarming today.
 */
export const LANE_ALARM_RATE_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * The share of ticks in that window that must be faulty.
 *
 * A THIRD. Deliberately well above the noise floor this file already
 * documents -- `chain-detail` flicked stale 64 times in one day while being
 * fundamentally healthy, which on a quarter-hourly cadence is 96 ticks and
 * about 67%... and that lane WAS the one with the real fault. The number has
 * to sit below the case it was written for and above a deploy, and a third is
 * the widest gap between those two.
 */
export const LANE_ALARM_RATE_THRESHOLD = 1 / 3;

/**
 * The fewest ticks a lane must have written in the window to be rated at all.
 *
 * TWELVE. A ratio over three samples is not a rate, it is an anecdote: a daily
 * lane that happens to have logged twice, once badly, would read as 50%
 * faulty. Twelve is half a day of quarter-hourly ticks, so a lane too slow to
 * reach it is left to the run rule, which is the right rule for a lane whose
 * episodes are longer than its cadence anyway.
 */
export const LANE_ALARM_RATE_MIN_SAMPLES = 12;

/**
 * How much history the cadence estimate reads.
 *
 * SEVEN DAYS: enough for a daily lane to show ~7 samples, and bounded so this
 * query does not get slower every day the table grows (retention is 90 days).
 */
export const LANE_ALARM_CADENCE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * How many ticks a lane must have written before its cadence is trusted.
 *
 * THREE, giving two gaps to average. Below that the estimate is one
 * measurement, and a wrong cadence here produces exactly the false alarm the
 * hour-long floor above exists to prevent. A lane with too little history is
 * reported as uncalibrated rather than guessed at.
 */
export const LANE_ALARM_MIN_CADENCE_SAMPLES = 3;

/**
 * How many missed ticks count as silence, and the floor under that.
 *
 * THREE INTERVALS, matching the threshold every staleness watchdog in this repo
 * already uses for its own lane ("one restart is routine, two could be an
 * unlucky pair, three is a stall"). The 90-minute floor keeps a fast lane --
 * `tao-usd-index` ticks every minute, so three intervals is three minutes --
 * from alarming on a deploy.
 */
export const LANE_ALARM_SILENCE_INTERVALS = 3;
export const LANE_ALARM_MIN_SILENCE_MS = 90 * 60 * 1000;

/**
 * How old a lane's newest verdict may be before the lane stops counting as one.
 *
 * THE SAME SEVEN DAYS the cadence window reads, and this exists because of a
 * state found while retiring two lanes: a RETIRED lane's last row sits in
 * `lane_health` forever, and if that row said `stale`, `staleLanes()` keeps
 * returning it for the life of the table. Without this guard the alarm would
 * re-raise a lane that no longer exists, every tick, until retention expired it
 * 90 days later -- an alarm about nothing, which is how alarms get muted.
 *
 * A lane that has written nothing in a week is residue, not an outage. It is
 * also uncalibratable by construction, since the cadence estimate reads the
 * same window -- so this guard and that one agree by sharing the constant
 * rather than by two numbers that must be kept equal.
 */
export const LANE_ALARM_MAX_VERDICT_AGE_MS = LANE_ALARM_CADENCE_WINDOW_MS;

/**
 * The one-line summary a capture carries, with the CADENCE that makes its
 * duration readable (#10809).
 *
 * "lane neon:validator-nominator-counts is stale: 7.9h" is unreadable on its
 * own, and was read wrongly in production: that lane's producer runs every 24
 * hours, so 7.9h is a third of ONE cycle after a single failed flush -- not
 * eight hours of a worsening outage. Measured 2026-08-11, the figure climbed
 * 1h per hour from 1.4h to 7.9h while nothing new failed, because a stale
 * verdict simply ages until the next pass overwrites it.
 *
 * The alarm already RESOLVES the cadence -- `cadence_ms` is on every alarm, for
 * the silence bound -- so this is the number it had all along and did not say.
 * Stating it is the whole fix: a reader can then tell "less than one cycle,
 * one failure" from "several cycles missed, the producer is gone", which is the
 * distinction the bare duration erases.
 *
 * Silence is left alone: its bound IS the cadence (three intervals), so its
 * duration is already expressed in the unit that matters.
 *
 * ## AND A DEAD-LETTER LANE IS NEITHER
 *
 * `lane revenue-probes-dlq is stale: 41.0h (producer cadence 1.0h)` reads as
 * FORTY-ONE MISSED CYCLES, and it is not that. A DLQ writes `stale` when a
 * message is lost and never writes `ok`, because nothing un-loses one -- so
 * the duration is "how long ago something was lost and nobody looked", and the
 * cadence has nothing to do with it. It ages out after seven days on its own.
 *
 * The cadence suffix therefore does to this lane exactly what the bare
 * duration did to a producer: invites a confident wrong reading. Measured
 * 2026-08-12, it worked -- 41.0h against a 1.0h cadence was triaged as the
 * most urgent lane in the fleet, ahead of six that were genuinely silent.
 *
 * What a reader needs here is the SUBJECT, and the alarm has been carrying it
 * in `detail` unread since #10739 taught the summariser to name it (`2
 * dead-lettered message(s) on revenue-probes-dlq (sn-64-...)`). Same lesson as
 * the drift alarm two floors down: the thing that was lost IS the diagnosis.
 */
export function laneAlarmSummary(alarm: LaneAlarm, nowMs: number): string {
  const elapsed = humanDuration(nowMs - alarm.since);
  const base = `lane ${alarm.lane} is ${alarm.kind}: ${elapsed}`;
  // A DEAD-LETTER lane's duration is not cycles-behind, so the cadence that
  // makes a producer's duration readable makes this one MISLEADING -- see
  // isDeadLetterLane. Its subject is what a reader needs instead, and the
  // alarm has been carrying it in `detail` unread.
  if (isDeadLetterLane(alarm.lane)) {
    return alarm.detail ? `${base} -- ${alarm.detail}` : base;
  }
  return alarm.kind === "stale" && alarm.cadence_ms
    ? `${base} (producer cadence ${humanDuration(alarm.cadence_ms)})`
    : base;
}

/**
 * Is this lane a dead-letter queue rather than a producer?
 *
 * Derived from `DEAD_LETTER_LANES` rather than matched on a `-dlq` suffix: the
 * mapping is already the one place that says which queues report as lanes, and
 * a suffix convention is a second one that can disagree with it.
 */
function isDeadLetterLane(lane: string): boolean {
  return DEAD_LETTER_LANE_NAMES.has(lane);
}

/** Title prefix. The dedup key: stable across ticks, and greppable by a human. */
export const LANE_ALARM_TITLE_PREFIX = "alarm(lane): ";

/** One issue per lane, forever, reopened only if the lane breaks again. */
export function laneAlarmTitle(lane: string): string {
  return `${LANE_ALARM_TITLE_PREFIX}${lane}`;
}

/** Which of the two faults an alarm is about. */
/** `stale` and `unknown` are VERDICTS the watchdog wrote; `silent` is this
 * module's own finding -- the absence of any verdict at all -- so it is the one
 * member not derived from the schema. */
export type LaneAlarmKind = LaneFindingVerdict | "silent" | "flapping";

export interface LaneAlarm {
  lane: string;
  kind: LaneAlarmKind;
  /** When the fault started: the first tick of the stale run, or the last
   * verdict written before the lane went quiet. */
  since: number;
  /** Consecutive stale ticks. Always 0 for `silent` -- there were none. For
   * `flapping` this is the FAULTY tick count in the window, not a run. */
  ticks: number;
  /** `flapping` only: how many ticks the lane wrote in the window, so the
   * share is reported rather than asserted. */
  sampled?: number;
  /** The watchdog's own reason string, verbatim. Null when it wrote none. */
  detail: string | null;
  /** How far behind the lane itself was, as the watchdog measured it. */
  age_ms: number | null;
  /** The lane's own observed tick interval, when there was enough history. */
  cadence_ms: number | null;
}

/**
 * The current unbroken stale run per lane.
 *
 * Everything since that lane's most recent NON-stale verdict, which is what
 * "has been stale for an hour" has to mean -- a lane that flickers ok/stale is
 * not an hour-long outage, and `MIN(checked_at) WHERE verdict='stale'` would
 * call it one for as long as the table remembers.
 *
 * COALESCE to 0 handles the lane that has never once been healthy, which is not
 * hypothetical: `subnet-snapshot` and `top-holders-staleness` each had zero `ok`
 * verdicts in the five days before this was written.
 */
/** An unbroken run of one verdict per lane: when it started and how many ticks
 * it has lasted. Named once rather than restated at each of the four places it
 * appears -- the loaders, the plan input and the plan's own reads. */
export type LaneVerdictRuns = Record<string, { since: number; ticks: number }>;

/** The verdicts that are FINDINGS -- every one except `ok`. Derived from
 * LaneVerdict (itself derived from the published self-health schema) rather than
 * restated, for the reason lane-health.ts gives about its own type: a verdict
 * added to the schema must not be able to appear in the API and be silently
 * unalarmable here. */
type LaneFindingVerdict = Exclude<LaneVerdict, "ok">;

function laneRunSql(verdict: LaneFindingVerdict): string {
  // `verdict` comes from a closed, schema-derived union, never from input --
  // interpolated because a placeholder cannot stand where the correlated
  // subquery needs the same value twice, and the alternative is two
  // near-identical strings that drift.
  return (
    "SELECT lane, MIN(checked_at) AS since, COUNT(*) AS ticks " +
    `FROM lane_health h WHERE verdict = '${verdict}' AND checked_at > COALESCE(` +
    "(SELECT MAX(checked_at) FROM lane_health x " +
    `WHERE x.lane = h.lane AND x.verdict <> '${verdict}'), 0) GROUP BY lane`
  );
}

/**
 * One entry per finding verdict, and `Record<LaneFindingVerdict, …>` is what
 * makes that a CHECKED claim rather than a comment: add a verdict to
 * LANE_VERDICTS in schemas-src/routes/self-health.ts and this object stops
 * compiling until it has a run query too.
 *
 * That is the property worth having. A verdict the API can publish but this
 * module cannot alarm on is exactly the hole #10695 fixed for `unknown` -- it
 * existed for months because nothing anywhere forced the two sets to match.
 */
const VERDICT_RUN_SQL: Record<LaneFindingVerdict, string> = {
  stale: laneRunSql("stale"),
  unknown: laneRunSql("unknown"),
};

export const LANE_STALE_RUN_SQL = VERDICT_RUN_SQL.stale;

/**
 * The same run query for `unknown` (#10695).
 *
 * WHY `unknown` NEEDS ITS OWN ALARM. The close path below already refuses to
 * treat it as recovery -- "a lane that went `unknown` has not recovered" -- and
 * migrations/neon/0006 says the same thing about the column: collapsing
 * `unknown` into `ok` "would report an unmeasured lane as a healthy one". The
 * OPEN path had no `unknown` case at all, so a lane that went from `ok` straight
 * to `unknown` and stayed there alarmed on neither loop: not stale, and not
 * silent because it kept recording. The two halves disagreed about what the
 * verdict means.
 */
export const LANE_UNKNOWN_RUN_SQL = VERDICT_RUN_SQL.unknown;

/**
 * Faulty-tick RATE per lane over the rate window (#11488).
 *
 * COUNTS BOTH FAULT VERDICTS, because the question this answers is "is this
 * lane reliable", and a lane alternating `stale` and `unknown` is no more
 * trustworthy than one doing either consistently -- while the run rule, which
 * keys on a single verdict, would see two short runs and alarm on neither.
 *
 * The window bound is a parameter rather than interpolated: it is a timestamp
 * computed at call time, which is exactly what placeholders are for. The
 * verdict list is not -- it is the same closed, schema-derived union
 * `laneRunSql` interpolates, for the same reason.
 */
export const LANE_FAULT_RATE_SQL =
  "SELECT lane, COUNT(*) AS sampled, " +
  "SUM(CASE WHEN verdict IN ('stale','unknown') THEN 1 ELSE 0 END) AS faulty, " +
  "MIN(checked_at) AS since " +
  "FROM lane_health WHERE checked_at >= ? GROUP BY lane";

export interface LaneFaultRate {
  sampled: number;
  faulty: number;
  since: number;
}

/** Faulty-tick rates keyed by lane. `{}` on any failure -- a reader that
 * throws is a reader that stops reading. */
export async function loadLaneFaultRates(
  db: LaneHealthDb | null | undefined,
  windowStartMs: number,
): Promise<Record<string, LaneFaultRate>> {
  if (!db?.query) return {};
  try {
    const rows = (await db.query(LANE_FAULT_RATE_SQL, [
      windowStartMs,
    ])) as Record<string, unknown>[];
    const out: Record<string, LaneFaultRate> = {};
    for (const row of rows) {
      const lane = row.lane == null ? "" : String(row.lane);
      if (!lane) continue;
      out[lane] = {
        sampled: countOrZero(row.sampled),
        faulty: countOrZero(row.faulty),
        since: countOrZero(row.since),
      };
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * Is this lane flapping badly enough to open on?
 *
 * Three gates, and all of them exist to keep this from becoming noise: enough
 * samples to be a rate at all, a share above the threshold, and -- the one
 * that matters most -- NOT already covered by the run rule. A lane in a long
 * unbroken stale run is also 100% faulty by this measure, and opening a second
 * issue about it would be the same fault twice.
 */
export function isFlapping(
  rate: LaneFaultRate | undefined,
  hasOpenRun: boolean,
  threshold: number = LANE_ALARM_RATE_THRESHOLD,
  minSamples: number = LANE_ALARM_RATE_MIN_SAMPLES,
): boolean {
  if (!rate || hasOpenRun) return false;
  if (rate.sampled < minSamples) return false;
  return rate.faulty / rate.sampled >= threshold;
}

/* LANE_CADENCE_SQL / laneCadenceMs / loadLaneCadence were REMOVED here (#10723).
 *
 * They computed the MEAN gap between lane_health writes, and this file's own
 * LANE_MAX_GAP_SQL comment already measured why that is the wrong number:
 * `neon:account-balances` logged 6,268 rows in seven days against a six-hour
 * producer, mean gap ONE minute. The alarm path read the mean anyway and
 * false-alarmed four Neon lanes at 1.7-1.8h against producers running every 6h
 * and 24h.
 *
 * Deleted rather than left exported. #10232 had already replaced the mean for the
 * self-health surface and the alarm path kept using it for another eight months --
 * a plausible-looking helper that is wrong for the only question left is how that
 * happens twice.
 */

/**
 * The LONGEST gap between consecutive rows, per lane (#10333).
 *
 * A DIFFERENT QUESTION FROM `laneCadenceMs`, which is why it is a second query
 * rather than a tweak to the first. The mean answers "how often does this lane
 * usually speak" and feeds the alarm; this answers "how long has it gone quiet
 * before while still being healthy", which is the only thing a silence bound
 * can honestly be built from.
 *
 * The mean cannot do it, for two structural reasons rather than incidental
 * ones:
 *
 *   - CONTAINER REBOOTS FIRE EVERY LANE'S FIRST TICK IMMEDIATELY (see
 *     src/producer-cadence.ts), so every slow lane's sample carries a cluster
 *     of near-zero gaps that drags the mean far under the real interval.
 *   - A MIRROR LANE WRITES MANY ROWS PER PASS. `neon:account-balances` logged
 *     6,268 rows in seven days against a six-hour producer, so "gap between
 *     rows" is not "gap between passes" there at all, and the mean AND the
 *     median both collapse toward zero.
 *
 * Measured over seven days, in minutes, against each lane's declared cadence:
 *
 *     lane                    rows  declared   mean  median   MAX
 *     hotkey-alpha              15      1440    286      76   973
 *     account-identity          18      1440    235      48   970
 *     neon:account-balances   6268       360      1       0   359
 *     metagraph                353        15     16      15    46
 *
 * The max is the only column that survives all of them. It reads UNDER the
 * declared cadence for the 24-hour lanes because seven days holds few passes,
 * and that is fine: the bound is three intervals, so 973 becomes 2,919 minutes
 * against a 1,440-minute cycle.
 *
 * A single long outage in the sample inflates this and makes the bound lax.
 * That is the SAFE direction -- a bound that is too loose misses a dead lane
 * for one extra cycle, while one that is too tight invents alarms on lanes
 * that are working, which is the #9301 failure the whole lane-alarm design is
 * shaped around.
 */
export const LANE_MAX_GAP_SQL =
  "SELECT lane, COUNT(*) AS n, MAX(gap) AS max_gap FROM (" +
  "SELECT lane, checked_at - LAG(checked_at) OVER " +
  "(PARTITION BY lane ORDER BY checked_at) AS gap " +
  "FROM lane_health WHERE checked_at > ?" +
  ") g WHERE gap IS NOT NULL GROUP BY lane";

/**
 * Longest observed gap per lane, or null where there is too little history.
 *
 * Declines to `{}` on any failure, exactly as loadLaneCadence does: without a
 * sample there is no bound that is not a guess, and withLaneHealth leaves every
 * verdict alone when it gets none.
 */
export async function loadLaneMaxGap(
  db: LaneHealthDb | null | undefined,
  sinceMs: number,
): Promise<Record<string, number | null>> {
  if (!db?.query) return {};
  try {
    const rows = (await db.query(LANE_MAX_GAP_SQL, [sinceMs])) as Record<
      string,
      unknown
    >[];
    const out: Record<string, number | null> = {};
    for (const row of rows) {
      const lane = row.lane == null ? "" : String(row.lane);
      if (!lane) continue;
      // The same sample floor the mean uses. `n` here counts GAPS, one fewer
      // than rows, so a lane with exactly the minimum rows still qualifies.
      const n = countOrZero(row.n);
      const gap = countOrZero(row.max_gap);
      out[lane] =
        n + 1 >= LANE_ALARM_MIN_CADENCE_SAMPLES && gap > 0 ? gap : null;
    }
    return out;
  } catch {
    return {};
  }
}

/** How long a lane may stay quiet before the silence is itself the fault. */
export function laneSilenceThresholdMs(cadenceMs: number): number {
  return Math.max(
    cadenceMs * LANE_ALARM_SILENCE_INTERVALS,
    LANE_ALARM_MIN_SILENCE_MS,
  );
}

/**
 * Lanes that report a VALUE rather than a heartbeat, so their silence carries
 * no information (#10634).
 *
 * The silence check infers cadence from a lane's own history. For a lane that
 * writes on a timer that is exactly right. For a lane that writes once per
 * process lifetime it is not a cadence at all — it is the interval between
 * DEPLOYS — and once that number exists the lane alarms for being quiet, which
 * for these lanes is the healthy state.
 *
 * Measured: `poller-build` alarmed continuously for two days ("silent: 2.0
 * days") while the poller was 31 seconds behind head and writing normally. Five
 * deploys inside the 7-day cadence window were enough to calibrate a "cadence",
 * and the first quiet stretch longer than 3× it opened an alarm.
 *
 * ── WHAT STILL COVERS THESE LANES, so this map is not a blind spot ──────────
 *
 * An exemption that removes the only check on something is worse than the false
 * alarm it silences, so each entry below has to be able to answer "then what
 * would catch it".
 *
 * `poller-build`: the poller reports EVERY periodic job through its own lane
 * (`log_job_outcome` in the indexer's poller — "ok" throttled, "stale" on a
 * failed tick), so a dead or wedged poller trips those lanes on their real
 * cadences. `/api/v1/chain/indexer-lag` shows the same thing independently as
 * head age. `poller-build` uniquely reports WHICH BUILD is running, so that a
 * container which rebooted onto a stale image is visible — a value that changes
 * only on reboot and has nothing to say on a timer.
 *
 * ── SCOPE: silence only ────────────────────────────────────────────────────
 *
 * These lanes are still fully subject to the STALE check. If the poller reports
 * `poller-build` as stale, that is the lane saying something is wrong, and it
 * alarms exactly as before. Nothing here suppresses a verdict; it only stops
 * the ABSENCE of a verdict being read as one.
 *
 * Keep this map small, and prefer fixing a lane's cadence over adding to it.
 */
export const LANE_SILENCE_EXEMPT: Record<string, string> = {
  "poller-build":
    "Written once at container startup to announce the running build. " +
    "Silence means the container has not rebooted, which is healthy. Poller " +
    "liveness is covered by every periodic job lane and by indexer-lag.",
};

export interface LaneAlarmPlanInput {
  /** Newest verdict per lane, from loadLatestLaneHealth. */
  latest: Record<string, LaneHealthRecord>;
  /** Current unbroken stale runs, keyed by lane. */
  runs: LaneVerdictRuns;
  /** Current unbroken `unknown` runs, keyed by lane (#10695). */
  unknownRuns: LaneVerdictRuns;
  /**
   * Faulty-tick rate per lane over the rate window (#11488). Optional so every
   * existing caller and fixture keeps compiling: absent means the flapping rule
   * simply does not fire, which is the same behaviour as before it existed.
   */
  faultRates?: Record<string, LaneFaultRate>;
  /**
   * Observed MAXIMUM gap per lane, keyed by lane. Null where uncalibrated.
   *
   * The max, not the mean (#10232, and this file's own LANE_MAX_GAP_SQL comment
   * measures why): a container reboot fires every lane's first tick immediately,
   * and a mirror lane writes many rows per pass -- `neon:account-balances` logged
   * 6,268 rows in seven days against a six-hour producer, so its mean gap is ONE
   * minute against a declared 360. Judged by that mean, every gap between passes
   * is an outage.
   *
   * Resolved through `laneSilenceCadenceMs`, which floors it by the producer's
   * declared cadence where LANE_PRODUCER names one -- the same function
   * src/self-health.ts already judges silence by. The alarm path was the one
   * consumer still guessing (#10723).
   */
  observedMaxGap: Record<string, number | null>;
  /** Lanes that already have an open alarm issue. */
  openAlarms: Record<string, LaneAlarmOpenIssue>;
  /**
   * When a lane's alarm was last CLOSED, in ms -- the newest close per lane.
   *
   * AN ACKNOWLEDGEMENT, and only a dead-letter lane needs one. Every other lane
   * closes itself: an `ok` verdict arrives and the alarm shuts. A `*-dlq` lane
   * has no `ok` path, so closing its issue is a human saying "these losses are
   * handled" -- and with nothing recording that, the next tick saw a stale row
   * and no open issue and filed a fresh one.
   *
   * Measured 2026-08-15: #11272 was closed at 08:32 with all three causes fixed
   * and verified, and #11293 was opened at 08:58 naming the SAME losses, the
   * newest of which was 07:26. The residue guard is seven days, so that is an
   * issue every half hour for a week over a row nothing can revise.
   *
   * Empty or absent when GitHub could not be asked, which is the safe
   * direction: an unknown acknowledgement suppresses nothing.
   */
  acknowledged?: Record<string, number>;
  nowMs: number;
  minStaleMs: number;
}

/**
 * An alarm issue that is already open, and when it was last written to.
 *
 * The timestamp is what lets a lane report a SECOND finding into an issue that
 * is already open. `updatedAt` is null when GitHub's stamp could not be read,
 * and the plan then declines to comment -- see the `update` list for why that
 * is the safe direction.
 */
export interface LaneAlarmOpenIssue {
  issue: number;
  updatedAt: number | null;
}

export interface LaneAlarmPlan {
  /** Alarms to raise, worst first, capped. */
  open: LaneAlarm[];
  /** Lanes that recovered and whose issue should close. Never carries a null
   * record: an entry only exists because a record said `ok`. */
  close: { lane: string; issue: number; record: LaneHealthRecord }[];
  /**
   * Losses to report into an alarm issue that is ALREADY OPEN (#11248's blind
   * spot, found once the alarm could finally write).
   *
   * ## WHY AN OPEN ISSUE IS NOT THE END OF THE STORY
   *
   * `fresh` below drops every lane that already has one, which is right for a
   * producer: an issue saying "this lane is stale" stays true while it stays
   * stale, and a second issue every half hour is the noise that gets an alarm
   * muted.
   *
   * A DEAD-LETTER LANE IS NOT THAT SHAPE. Nothing writes it a row except
   * `handleDeadLetterBatch`, and only when a message has just been lost -- so
   * its rows are EVENTS, not a repeated verdict about one condition. And
   * nothing ever writes it `ok`: a lost message is not un-lost, so the close
   * loop below can never fire for one, and the issue stays open by design.
   *
   * Those two facts together made a hole: the first loss opened an issue, and
   * from that moment every FURTHER loss on that queue was reported nowhere. The
   * lane was already in `openAlarms`, so `fresh` dropped it; the issue was
   * already open, so nothing reopened it; no `ok` ever arrived, so nothing
   * closed it either. The alarm went quiet exactly as the queue got worse --
   * the failure mode the whole file is shaped against, reached from the other
   * direction.
   *
   * ## THE TEST, AND WHY IT NEEDS NO STATE
   *
   * A dead-letter lane writes only on loss, so "a row newer than the last time
   * we wrote to the issue" IS "a loss we have not reported". GitHub stamps
   * `updated_at` on every write including the alarm's own comment, so the
   * comparison de-duplicates itself: one comment per loss, and the comment
   * moves the mark.
   *
   * A human commenting on the issue in the same window also moves it, and can
   * therefore swallow one report. That is the acceptable direction: it costs a
   * comment precisely when somebody is already reading the issue, whereas the
   * alternative -- keeping our own high-water mark -- is durable state this
   * reader has deliberately never had. An unreadable `updated_at` declines for
   * the same reason: no mark means no way to tell a new loss from an old one,
   * and commenting on every tick is worse than commenting on none.
   *
   * Bounded without a cap: at most one comment per dead-letter lane per tick,
   * and `DEAD_LETTER_LANES` has five entries.
   */
  update: { lane: string; issue: number; record: LaneHealthRecord }[];
  /** Alarms that qualified but lost to the per-tick cap. Reported, not dropped. */
  suppressed: number;
}

/**
 * Decide what to open and what to close. Pure: no clock, no database, no
 * network, so every branch below is reachable from a test.
 */
export function laneAlarmPlan(input: LaneAlarmPlanInput): LaneAlarmPlan {
  const {
    latest,
    runs,
    unknownRuns,
    faultRates = {},
    observedMaxGap,
    openAlarms,
    // Defaulted, and the default suppresses NOTHING. A caller that cannot read
    // closed issues -- or one written before this existed -- gets exactly the
    // previous behaviour rather than a silent mute.
    acknowledged = {},
    nowMs,
    minStaleMs,
  } = input;
  // One resolution per lane, so the stale/unknown reports and the silence bound
  // cannot disagree about what a lane's cadence is.
  const cadenceFor = (lane: string) =>
    laneSilenceCadenceMs(lane, observedMaxGap[lane]);
  const qualified: LaneAlarm[] = [];

  const stale = staleLanes(latest);
  for (const record of stale) {
    // Residue, not an outage: see LANE_ALARM_MAX_VERDICT_AGE_MS.
    if (nowMs - record.checked_at > LANE_ALARM_MAX_VERDICT_AGE_MS) continue;
    const run = runs[record.lane];
    // No run row for a lane whose newest verdict IS stale means the two reads
    // disagree -- a verdict landed between them. Treat the newest verdict as
    // the start rather than inventing a duration.
    const since = run?.since ?? record.checked_at;
    if (nowMs - since < minStaleMs) continue;
    qualified.push({
      lane: record.lane,
      kind: "stale",
      since,
      ticks: run?.ticks ?? 1,
      detail: record.detail,
      age_ms: record.age_ms,
      cadence_ms: cadenceFor(record.lane),
    });
  }

  // UNKNOWN, on the same bound as stale (#10695). A single `unknown` tick is
  // ordinary -- one unreadable table, one cross-check that could not run -- so
  // this alarms only on a run of them longer than `minStaleMs`, exactly as the
  // stale loop does. What it ends is the state where a watchdog says "I could
  // not evaluate this" every hour and nothing anywhere reads that as a fault.
  //
  // Reported as its own kind rather than folded into `stale`, because they are
  // different findings and the message has to say which: `stale` means a breach
  // was measured, `unknown` means the measurement itself did not happen.
  for (const record of Object.values(latest)) {
    if (record.verdict !== "unknown") continue;
    if (nowMs - record.checked_at > LANE_ALARM_MAX_VERDICT_AGE_MS) continue;
    // STILL RECORDING, or this is the silence loop's finding rather than ours.
    // "an `unknown` verdict is never STALE, but can still go silent" was already
    // the rule here, and it is the right one: a lane that stopped reporting is a
    // dead producer, which outranks "the producer is running but cannot
    // measure". Gating on liveness rather than de-duplicating afterwards keeps
    // the two loops mutually exclusive by construction.
    const unknownCadenceMs = cadenceFor(record.lane);
    if (
      unknownCadenceMs !== null &&
      nowMs - record.checked_at >= laneSilenceThresholdMs(unknownCadenceMs)
    ) {
      continue;
    }
    const run = unknownRuns[record.lane];
    const since = run?.since ?? record.checked_at;
    if (nowMs - since < minStaleMs) continue;
    qualified.push({
      lane: record.lane,
      kind: "unknown",
      since,
      ticks: run?.ticks ?? 1,
      detail: record.detail,
      age_ms: record.age_ms,
      cadence_ms: cadenceFor(record.lane),
    });
  }

  // FLAPPING (#11488). A lane that recovers between episodes never builds a run
  // the minimum can reach, however often it breaks: `chain-detail-staleness`
  // sat 851s behind a 300s threshold for 12.5 minutes, recorded `stale`, and
  // opened nothing, because no single episode lasted the 45 minutes three
  // consecutive quarter-hourly ticks would need.
  //
  // AFTER the run loops and gated on their output, so a lane in a long unbroken
  // run -- which is also 100% faulty by this measure -- reports once as `stale`
  // rather than twice. The run rule is the better description when it applies;
  // this only speaks where it cannot.
  const alreadyQualified = new Set(qualified.map((alarm) => alarm.lane));
  for (const [lane, rate] of Object.entries(faultRates)) {
    if (!isFlapping(rate, alreadyQualified.has(lane))) continue;
    const record = latest[lane];
    // No latest verdict for a lane with rows in the window means the two reads
    // disagree; the silence loop below is the right reporter for that.
    if (!record) continue;
    if (nowMs - record.checked_at > LANE_ALARM_MAX_VERDICT_AGE_MS) continue;
    qualified.push({
      lane,
      kind: "flapping",
      since: rate.since,
      ticks: rate.faulty,
      sampled: rate.sampled,
      detail: record.detail,
      age_ms: record.age_ms,
      cadence_ms: cadenceFor(lane),
    });
    alreadyQualified.add(lane);
  }

  for (const record of Object.values(latest)) {
    // A lane already alarming as STALE is not also alarming as SILENT. The
    // watchdog said so itself; that it then stopped saying so is the same
    // outage, and two issues for one fault is the noise this is trying to end.
    // `unknown` needs no equivalent guard: the loop above takes only lanes that
    // are still recording, and this one only lanes that have stopped.
    if (record.verdict === "stale") continue;
    // A lane whose silence carries no information (#10634). Checked here, in
    // the SILENT loop only, so the stale loop above still alarms on a verdict
    // these lanes actually report. See LANE_SILENCE_EXEMPT for what covers
    // each one instead.
    if (record.lane in LANE_SILENCE_EXEMPT) continue;
    const cadenceMs = cadenceFor(record.lane);
    if (cadenceMs === null) continue;
    const quietFor = nowMs - record.checked_at;
    if (quietFor < laneSilenceThresholdMs(cadenceMs)) continue;
    qualified.push({
      lane: record.lane,
      kind: "silent",
      since: record.checked_at,
      ticks: 0,
      detail: record.detail,
      age_ms: record.age_ms,
      cadence_ms: cadenceMs,
    });
  }

  // Worst first, so the per-tick cap keeps the longest-running faults rather
  // than whichever lane sorts first alphabetically.
  qualified.sort((a, b) => a.since - b.since);
  const fresh = qualified
    .filter((alarm) => !(alarm.lane in openAlarms))
    // ALREADY ANSWERED FOR. A dead-letter lane's loss that predates the close
    // of its last alarm has been acknowledged, and re-filing it is churn on a
    // row nothing will ever revise.
    //
    // STRICTLY NEWER re-alarms, so this cannot mute a real recurrence: a loss
    // after the close opens a fresh issue on the very next tick, which is the
    // behaviour the alarm body promises in as many words.
    //
    // Scoped to dead-letter lanes alone. Every other lane can say `ok`, so a
    // closed alarm there is either already recovered or genuinely still broken
    // -- and suppressing the second would hide an outage somebody closed by
    // mistake.
    .filter((alarm) => {
      if (!isDeadLetterLane(alarm.lane)) return true;
      const closedAt = acknowledged[alarm.lane];
      if (closedAt === undefined) return true;
      const record = latest[alarm.lane];
      return record !== undefined && record.checked_at > closedAt;
    });
  const open = fresh.slice(0, LANE_ALARM_MAX_OPENS_PER_TICK);

  const close: LaneAlarmPlan["close"] = [];
  for (const [lane, open] of Object.entries(openAlarms)) {
    const record = latest[lane] ?? null;
    // Only `ok` closes. A lane that went `unknown` has not recovered -- the
    // watchdog could not evaluate it -- and closing on an absence of
    // measurement is the confident-wrong-answer this repo avoids everywhere
    // else. A lane with no record at all keeps its issue for the same reason.
    if (record?.verdict !== "ok") continue;
    // AND AN `ok` THAT HAS STOPPED BEING SAID IS NOT A RECOVERY.
    //
    // This loop read the STORED verdict while the silence loop above reads the
    // same rows through a liveness bound, so the two disagreed about the same
    // lane on the same tick -- and the alarm fought itself. `laneSilenceCadenceMs`
    // and `laneSilenceThresholdMs` are already resolved here for the open path;
    // the close path simply never asked.
    //
    // Measured 2026-08-15, on the first day this alarm could write:
    //
    //   03:28Z  opened  #11252 validator-nominator-counts  (silent 3.2 days)
    //   03:58Z  CLOSED  "reported ok at 2026-08-11T23:27:52Z"
    //   04:28Z  opened  #11261                              (same lane, same fault)
    //   04:58Z  CLOSED  again
    //
    // Neither lane changed state at any point -- both had been silent since
    // 2026-08-11. The stored row really did say `ok` ("127 statement(s)
    // flushed"): a sync flush stamped with the producer's own pass time, four
    // days old and never revised. `GET /api/v1/self-health` showed `unknown`
    // for those lanes throughout, because `withLaneHealth` applies exactly this
    // bound before serving. The alarm was the only reader taking a four-day-old
    // `ok` at face value, and a false recovery is the worst thing it can
    // report: indistinguishable from the outage being over.
    //
    // Same predicate as the silent loop, deliberately. Two spellings of "has
    // this lane stopped speaking" is how they came to disagree in the first
    // place.
    const cadenceMs = cadenceFor(lane);
    if (
      cadenceMs !== null &&
      nowMs - record.checked_at >= laneSilenceThresholdMs(cadenceMs)
    ) {
      continue;
    }
    close.push({ lane, issue: open.issue, record });
  }

  // Further losses on a queue whose alarm is already open. See
  // LaneAlarmPlan.update for the whole argument.
  //
  // Gated on `qualified` -- not merely on having a row -- so a second report
  // still has to clear every bound the first one did: the residue guard that
  // drops a lane nothing has written in a week, and the stale floor. A lane
  // that stopped qualifying has stopped alarming, and an issue about it should
  // stop growing too. Membership rather than the alarm itself, because what a
  // recurrence needs is the NEWEST row, and `alarm.since` is the oldest.
  const qualifiedLanes = new Set(qualified.map((alarm) => alarm.lane));
  const update: LaneAlarmPlan["update"] = [];
  for (const [lane, openIssue] of Object.entries(openAlarms)) {
    if (!isDeadLetterLane(lane)) continue;
    if (!qualifiedLanes.has(lane)) continue;
    if (openIssue.updatedAt === null) continue;
    // Indexed without a guard: membership above is derived from `latest`, so a
    // qualified lane has a record by construction. A `?? continue` here would
    // be a branch no test could reach.
    const record = latest[lane];
    if (record.checked_at <= openIssue.updatedAt) continue;
    update.push({ lane, issue: openIssue.issue, record });
  }

  return { open, close, update, suppressed: fresh.length - open.length };
}

function humanDuration(ms: number): string {
  if (ms < 60_000) return `${Math.max(0, Math.round(ms / 1000))}s`;
  if (ms < 3_600_000) return `${(ms / 60_000).toFixed(0)} min`;
  if (ms < 172_800_000) return `${(ms / 3_600_000).toFixed(1)}h`;
  return `${(ms / 86_400_000).toFixed(1)} days`;
}

/**
 * The opening sentence, one per fault, and THREE FAULTS EXIST.
 *
 * This branched `stale` against everything-else, so an `unknown` alarm was
 * described as "has written no verdict at all ... its watchdog appears to have
 * stopped running", which is the opposite of what `unknown` means: the watchdog
 * IS running and IS writing, and what it is saying is that it could not
 * evaluate the lane. #10695 added the verdict to the OPEN path and this
 * sentence was not told. The three are kept apart here rather than at the call
 * site so the compiler checks the set: `LaneAlarmKind` is derived from the
 * published schema, and a fourth member stops this switch compiling.
 *
 * A DEAD-LETTER LANE OUTRANKS ITS KIND. Its rows are losses, not ticks, so
 * "reported stale on every tick (89 consecutive verdicts)" -- measured on the
 * first issue this alarm ever filed -- described 89 separate lost messages as
 * one condition observed 89 times.
 */
function issueOpening(alarm: LaneAlarm, forHow: string): string {
  if (isDeadLetterLane(alarm.lane)) {
    return (
      `\`${alarm.lane}\` has dead-lettered **${alarm.ticks} time(s)** in the **${forHow}** since the first loss. ` +
      "Each one is a batch whose messages exhausted their retries and were acked to keep them out of a second-order queue -- so this is a count of losses, not of ticks."
    );
  }
  switch (alarm.kind) {
    case "stale":
      return `\`${alarm.lane}\` has reported **stale** on every tick for **${forHow}** (${alarm.ticks} consecutive verdicts).`;
    case "unknown":
      return (
        `\`${alarm.lane}\` has reported **unknown** on every tick for **${forHow}** (${alarm.ticks} consecutive verdicts). ` +
        "The watchdog is running; what it cannot do is evaluate this lane, so nothing here is a measurement -- neither a breach nor a clean bill."
      );
    case "silent":
      return `\`${alarm.lane}\` has written **no verdict at all** for **${forHow}**. Its watchdog appears to have stopped running -- the last verdict it did write said \`${alarm.detail ?? "ok"}\`, so nothing else will report this.`;
    case "flapping": {
      const sampled = alarm.sampled ?? 0;
      const share = sampled ? Math.round((alarm.ticks / sampled) * 100) : 0;
      return (
        `\`${alarm.lane}\` has been **faulty on ${alarm.ticks} of its last ${sampled} ticks (${share}%)** over **${forHow}**, ` +
        "recovering between each one. No single episode lasted long enough for the run rule to reach it, which is why nothing opened until now -- " +
        "a lane that is broken a third of the time is broken, however short each individual break is."
      );
    }
  }
}

/**
 * The issue body. Written to be actionable without opening anything else:
 * which lane, which fault, how long, what the watchdog said, and the query that
 * shows the history.
 */
export function laneAlarmIssueBody(alarm: LaneAlarm, nowMs: number): string {
  const forHow = humanDuration(nowMs - alarm.since);
  const opening = issueOpening(alarm, forHow);
  const lines = [
    opening,
    "",
    "| | |",
    "| --- | --- |",
    `| fault | \`${alarm.kind}\` |`,
    `| since | ${new Date(alarm.since).toISOString()} |`,
  ];
  if (alarm.age_ms !== null) {
    lines.push(`| lane was behind by | ${humanDuration(alarm.age_ms)} |`);
  }
  // NOT FOR A DEAD-LETTER LANE, and this is the same call laneAlarmSummary
  // already makes one floor up (#10809, in the other direction). A cadence next
  // to a duration invites "cycles missed", and for a queue that is meaningless:
  // the producer's hourly cadence has nothing to do with when a message was
  // lost. Measured: `41.0h against a 1.0h cadence` was triaged as the most
  // urgent lane in the fleet, ahead of six that were genuinely dead. The
  // summary stopped saying it and the ISSUE BODY went on saying it -- the first
  // one this alarm ever filed carried `observed cadence | 1.0h`.
  if (alarm.cadence_ms !== null && !isDeadLetterLane(alarm.lane)) {
    lines.push(`| observed cadence | ${humanDuration(alarm.cadence_ms)} |`);
  }
  if (alarm.detail) {
    lines.push(`| watchdog said | \`${alarm.detail}\` |`);
  }
  lines.push(
    "",
    "```sql",
    `SELECT datetime(checked_at/1000,'unixepoch') at, verdict, detail`,
    `FROM lane_health WHERE lane = '${alarm.lane}'`,
    `ORDER BY checked_at DESC LIMIT 40;`,
    "```",
    "",
    // A PROMISE THIS ISSUE CAN KEEP. "Closed automatically on the first `ok`
    // verdict" is true of a producer and impossible for a dead-letter lane --
    // nothing writes one `ok`, so the sentence told the reader to wait for an
    // event that cannot happen, on the one lane whose issue a human has to
    // close.
    isDeadLetterLane(alarm.lane)
      ? "This will NOT close itself: nothing writes a dead-letter lane `ok`, because\nnothing un-loses a message. Closing it is a decision, and the next loss after\nit closes opens a fresh alarm. Until then, further losses arrive here as\ncomments."
      : "Closed automatically on the first `ok` verdict.",
    "Opened by the lane-health reader (`src/lane-alarm.ts`); the record it reads",
    "is also served at `GET /api/v1/self-health`.",
  );
  return lines.join("\n");
}

/**
 * The comment a FURTHER loss earns on an alarm issue that is already open.
 *
 * States the loss and then says why it arrived as a comment rather than as its
 * own issue, because the alternative reading -- "the alarm re-fired for the
 * same thing" -- is what would get these muted. See LaneAlarmPlan.update.
 */
export function laneAlarmLossComment(
  lane: string,
  record: LaneHealthRecord,
): string {
  const detail = record.detail ? `: \`${record.detail}\`` : "";
  return (
    `\`${lane}\` lost more at ${new Date(record.checked_at).toISOString()}${detail}.\n\n` +
    "Reported here rather than as a new issue because this one is still open. " +
    "A dead-letter lane never reports `ok` -- nothing un-loses a message -- so " +
    "this issue will not close itself; closing it is a decision, and the next " +
    "loss after it closes opens a fresh alarm."
  );
}

/** The recovery comment. States what recovered and how long it was out. */
export function laneAlarmRecoveryComment(
  lane: string,
  record: LaneHealthRecord,
): string {
  const detail = record.detail ? ` (\`${record.detail}\`)` : "";
  return (
    `\`${lane}\` reported **ok** at ${new Date(record.checked_at).toISOString()}${detail}. ` +
    `Closing automatically.`
  );
}

/** Current stale runs, keyed by lane. `{}` on any failure -- a reader that
 * throws is a reader that stops reading. */
export async function loadLaneUnknownRuns(
  db: LaneHealthDb | null | undefined,
): Promise<LaneVerdictRuns> {
  return loadLaneRuns(db, LANE_UNKNOWN_RUN_SQL);
}

export async function loadLaneStaleRuns(
  db: LaneHealthDb | null | undefined,
): Promise<LaneVerdictRuns> {
  return loadLaneRuns(db, LANE_STALE_RUN_SQL);
}

async function loadLaneRuns(
  db: LaneHealthDb | null | undefined,
  sql: string,
): Promise<LaneVerdictRuns> {
  if (!db?.query) return {};
  try {
    const rows = (await db.query(sql)) as Record<string, unknown>[];
    const out: LaneVerdictRuns = {};
    for (const row of rows) {
      const lane = row.lane == null ? "" : String(row.lane);
      if (!lane) continue;
      out[lane] = {
        since: countOrZero(row.since),
        ticks: countOrZero(row.ticks),
      };
    }
    return out;
  } catch {
    return {};
  }
}

/** The GitHub calls this needs, as one injectable seam. */
export interface LaneAlarmGitHub {
  /** The open alarms by lane, or NULL when GitHub could not be asked.
   *
   * The null is the whole contract. `{}` means "no alarm is open" and the
   * runner acts on it by opening one for every alarming lane; "we could not
   * ask" must never produce that action, and the two are indistinguishable
   * once a failure has been flattened into an empty object. */
  listOpen(): Promise<Record<string, LaneAlarmOpenIssue> | null>;
  /**
   * When each lane's alarm was last CLOSED, in ms.
   *
   * Separate from `listOpen` because the two answers have different failure
   * postures. An unreadable OPEN list must stop the tick -- acting on it means
   * re-raising every alarm. An unreadable CLOSED list is only an
   * acknowledgement we do not know about, and the safe response is to alarm
   * anyway, so this returns `{}` rather than null.
   */
  listAcknowledged(): Promise<Record<string, number>>;
  open(alarm: LaneAlarm, title: string, body: string): Promise<number | null>;
  /** Say something on an issue that stays open. Its own method rather than a
   * flag on `close`, because reporting a further loss and closing on recovery
   * are opposite outcomes that happen to share a request. */
  comment(issue: number, body: string): Promise<boolean>;
  close(issue: number, comment: string): Promise<boolean>;
}

const GITHUB_API = "https://api.github.com";

/** The real GitHub client. Every call returns a value rather than throwing, so
 * one failed request costs one alarm and not the tick. */
export function laneAlarmGitHub(
  token: string,
  repo: string,
  fetchImpl: typeof fetch = fetch,
): LaneAlarmGitHub {
  const headers = {
    authorization: `Bearer ${token}`,
    accept: "application/vnd.github+json",
    "user-agent": "metagraphed-lane-alarm",
    "content-type": "application/json",
  };
  return {
    async listAcknowledged() {
      // SEARCHED BY TITLE, because a page of closed issues cannot reach far
      // enough to matter. #11305 asked
      // /issues?state=closed&sort=updated&per_page=100, and measured on this
      // repo that page carries 100 rows of which only 38 are issues -- the
      // endpoint returns pull requests too, and the loop below then discards
      // them -- spanning about FOURTEEN HOURS. The window an acknowledgement
      // has to survive is the residue guard's SEVEN DAYS, because that is how
      // long a dead-letter record keeps qualifying.
      //
      // So that fix worked for its first night. Once the close scrolled off the
      // page the lane looked unacknowledged again and the alarm re-filed it,
      // every half hour, for the six days left on the record -- the same
      // issue-about-nothing #11305 set out to stop, arriving a day late.
      //
      // `in:title` narrows to the issues this alarm has itself filed, so one
      // request covers the whole population however busy the repo gets, and no
      // paging loop reads thousands of unrelated issues every tick to find one
      // close. Newest first still, for the same reason: only the most recent
      // close per lane matters, since an older one cannot acknowledge a loss
      // the newer one already did.
      const query = `repo:${repo} is:issue in:title "${LANE_ALARM_TITLE_PREFIX}"`;
      const response = await fetchImpl(
        `${GITHUB_API}/search/issues?q=${encodeURIComponent(query)}` +
          "&sort=updated&order=desc&per_page=100",
        { headers },
      );
      // `{}` on every failure, deliberately, and the opposite of `listOpen`:
      // an acknowledgement we cannot read must never suppress an alarm.
      if (!response.ok) return {};
      const page = GithubSearchResultSchema.safeParse(await response.json());
      if (!page.success) return {};
      const out: Record<string, number> = {};
      for (const row of page.data.items) {
        const parsed = GithubIssueSchema.safeParse(row);
        if (!parsed.success) continue;
        const issue = parsed.data;
        if (issue.pull_request) continue;
        const title = issue.title ?? "";
        if (!title.startsWith(LANE_ALARM_TITLE_PREFIX)) continue;
        const lane = title.slice(LANE_ALARM_TITLE_PREFIX.length).trim();
        if (!lane) continue;
        const closedAt = Date.parse(issue.closed_at ?? "");
        if (!Number.isFinite(closedAt)) continue;
        // The NEWEST close per lane. The list is sorted, but relying on that
        // would make this depend on a query parameter rather than on the data.
        out[lane] = Math.max(out[lane] ?? 0, closedAt);
      }
      return out;
    },
    async listOpen() {
      const response = await fetchImpl(
        `${GITHUB_API}/repos/${repo}/issues?state=open&per_page=100`,
        { headers },
      );
      // NULL, not `{}` -- runLaneAlarm's own comment says an unreadable issue
      // list must not be read as "no alarms are open", and then this returned
      // exactly that for every non-2xx. A token that cannot list issues cannot
      // create them either, so the tick would plan a full set of opens, watch
      // every create fail, and report nothing: which is the state production
      // was in, with zero `alarm(lane):` issues ever filed against days of
      // alarming lanes.
      if (!response.ok) return null;
      // PARSED, NOT CAST (#11194). The `Array.isArray` below was doing the
      // schema's job for one field and nothing for the rest; the parse does
      // both, and a body that is not a list at all now yields no alarms rather
      // than an empty loop that reads identically to "GitHub has no open
      // issues" -- the difference between "nothing to close" and "we could not
      // ask", on the lane that closes alarms.
      const page = GithubIssueListSchema.safeParse(await response.json());
      // Same reasoning as the status check: a body we cannot read is not a
      // report that nothing is open.
      if (!page.success) return null;
      const out: Record<string, LaneAlarmOpenIssue> = {};
      for (const row of page.data) {
        // Per ROW, so one issue GitHub shapes unexpectedly costs that issue
        // and not the whole page -- see GithubIssueListSchema.
        const parsed = GithubIssueSchema.safeParse(row);
        if (!parsed.success) continue;
        const issue = parsed.data;
        // The issues endpoint returns pull requests too, and a PR whose title
        // happens to match would be closed as though it were an alarm.
        if (issue.pull_request) continue;
        const title = issue.title ?? "";
        if (!title.startsWith(LANE_ALARM_TITLE_PREFIX)) continue;
        const lane = title.slice(LANE_ALARM_TITLE_PREFIX.length).trim();
        if (!lane || typeof issue.number !== "number") continue;
        // A stamp we cannot read becomes null rather than 0. Zero would date
        // the issue to 1970 and make every dead-letter row look newer than it,
        // which is a comment every tick -- see LaneAlarmPlan.update.
        const parsedAt = issue.updated_at
          ? Date.parse(issue.updated_at)
          : Number.NaN;
        out[lane] = {
          issue: issue.number,
          updatedAt: Number.isFinite(parsedAt) ? parsedAt : null,
        };
      }
      return out;
    },
    async open(_alarm, title, body) {
      const response = await fetchImpl(`${GITHUB_API}/repos/${repo}/issues`, {
        method: "POST",
        headers,
        body: JSON.stringify({ title, body }),
      });
      if (!response.ok) return null;
      const created = GithubCreatedIssueSchema.safeParse(await response.json());
      return typeof created.data?.number === "number"
        ? created.data.number
        : null;
    },
    async comment(issue, body) {
      const response = await fetchImpl(
        `${GITHUB_API}/repos/${repo}/issues/${issue}/comments`,
        { method: "POST", headers, body: JSON.stringify({ body }) },
      );
      return response.ok;
    },
    async close(issue, comment) {
      // Comment first: a close that lands without its reason is an issue whose
      // history says only that something changed its mind.
      await fetchImpl(`${GITHUB_API}/repos/${repo}/issues/${issue}/comments`, {
        method: "POST",
        headers,
        body: JSON.stringify({ body: comment }),
      }).catch(() => null);
      const response = await fetchImpl(
        `${GITHUB_API}/repos/${repo}/issues/${issue}`,
        {
          method: "PATCH",
          headers,
          body: JSON.stringify({ state: "closed", state_reason: "completed" }),
        },
      );
      return response.ok;
    },
  };
}

export interface LaneAlarmDeps {
  github?: LaneAlarmGitHub | null;
  now?: () => number;
  recordException?: typeof recordExceptionEvent;
  fetchImpl?: typeof fetch;
}

/**
 * One reader tick.
 *
 * Returns a summary rather than throwing, matching the watchdog family it
 * reads: a tick that cannot run is one missed report, not an outage.
 */
export async function runLaneAlarm(
  env: LaneAlarmEnv | null | undefined,
  deps: LaneAlarmDeps = {},
): Promise<Record<string, unknown>> {
  const now = deps.now ?? Date.now;
  const record = deps.recordException ?? recordExceptionEvent;
  // laneHealthStore, not the binding (#10154). This is the reader that opens
  // GitHub issues from lane_health verdicts, so pointing it at a store nothing
  // writes any more would replay stale verdicts forever -- filing issues for
  // lanes that recovered, and none for lanes that broke.
  // NO CAST. `laneHealthStore` already returns `LaneHealthDb | undefined`,
  // which is exactly what these readers take -- the `as unknown as` here was
  // converting a value to its own type through `unknown`, which is the one
  // form of cast that can never be checked again if either side moves.
  const db = laneHealthStore(env);
  if (!db?.query) return { ok: false, reason: "no lane_health store bound" };

  // ITS OWN SECRET, falling back to the shared one.
  //
  // `GITHUB_TOKEN` is declared, in workers/env-extra.d.ts, as the upgrade
  // radar's rate-limit token: "public-repo read-only metadata", and a lane that
  // "still runs without it". This file's header read that as "already
  // provisioned on this Worker" and inferred it could open issues. Opening an
  // issue needs `issues: write` on THIS repository, which a public-read token
  // does not carry -- and the result was an alarm that has never filed one.
  //
  // Split for the same reason GITHUB_SIGNALS_TOKEN was split off it: the two
  // want different scopes, and sharing one credential means the weaker
  // requirement silently sets the ceiling. The fallback keeps this a no-op
  // wherever the shared token does happen to have write access.
  const token =
    (typeof env?.LANE_ALARM_GITHUB_TOKEN === "string"
      ? env.LANE_ALARM_GITHUB_TOKEN
      : "") || (typeof env?.GITHUB_TOKEN === "string" ? env.GITHUB_TOKEN : "");
  const repo =
    typeof env?.LANE_ALARM_REPO === "string" && env.LANE_ALARM_REPO
      ? env.LANE_ALARM_REPO
      : "JSONbored/metagraphed";
  const github =
    deps.github ??
    (token ? laneAlarmGitHub(token, repo, deps.fetchImpl ?? fetch) : null);

  const nowMs = now();
  const minStaleMs =
    Number(env?.LANE_ALARM_MIN_STALE_MS) || LANE_ALARM_MIN_STALE_MS;

  const rateWindowMs =
    Number(env?.LANE_ALARM_RATE_WINDOW_MS) || LANE_ALARM_RATE_WINDOW_MS;

  const [latest, runs, unknownRuns, faultRates, observedMaxGap] =
    await Promise.all([
      loadLatestLaneHealth(db),
      loadLaneStaleRuns(db),
      loadLaneUnknownRuns(db),
      // #11488: the rate, for lanes that recover between episodes and so never
      // build a run the minimum can reach.
      loadLaneFaultRates(db, nowMs - rateWindowMs),
      // THE MAX GAP, not the mean (#10723). This file already owned both queries
      // and already documented why the max is the only column that survives a
      // container reboot and a many-rows-per-pass mirror lane -- but the alarm path
      // kept reading the mean, so `neon:account-balances` was judged against a
      // ONE-MINUTE cadence and alarmed on every gap between its six-hourly passes.
      // src/self-health.ts and src/self-health-mcp.ts already read it this way.
      loadLaneMaxGap(db, nowMs - LANE_ALARM_CADENCE_WINDOW_MS),
    ]);

  // Read the open alarms BEFORE planning: without them every tick would open a
  // duplicate of every alarm still outstanding, which is the failure that makes
  // an alerting system get muted.
  const openAlarms = github ? await github.listOpen().catch(() => null) : null;
  // AFTER the open list and never instead of it: this only ever narrows what
  // gets filed, so a failure here costs an extra issue rather than a missed one.
  const acknowledged = github
    ? await github.listAcknowledged().catch(() => ({}))
    : {};
  // Deliberately NOT read as `{}`. An unreadable issue list is
  // indistinguishable from "no alarms are open", and acting on that assumption
  // opens a duplicate of everything currently outstanding.
  //
  // But it must not go the other way either. Returning here -- which is what
  // this did -- SILENCED the per-lane captures below, so the one failure mode
  // where GitHub is unreachable also lost the second channel that could still
  // have reported the lanes. Quieter, in the moment that needs louder.
  //
  // So: still plan, still record every alarming lane, and suppress only the
  // WRITES, which are the part a stale list makes dangerous.
  const listUnavailable = Boolean(github) && openAlarms === null;

  const plan = laneAlarmPlan({
    latest,
    runs,
    unknownRuns,
    faultRates,
    observedMaxGap,
    openAlarms: openAlarms ?? {},
    acknowledged,
    nowMs,
    minStaleMs,
  });

  let opened = 0;
  let closed = 0;
  let commented = 0;
  for (const alarm of plan.open) {
    const body = laneAlarmIssueBody(alarm, nowMs);
    // PostHog stays a second channel rather than the only one. It is recorded
    // for every alarm, including the ones the GitHub cap suppressed below, so a
    // working capture path still sees the full picture.
    //
    // `fingerprintDetail` IS WHAT MAKES THAT TRUE. Without it every lane in a
    // tick fingerprinted `watchdog:lane-alarm:Error`, which is also the storm
    // guard's throttle key -- so the first alarming lane consumed the window
    // and every other lane in the same tick was dropped as a repeat of it.
    // Measured on production before the fix: exactly one event per tick for six
    // consecutive hours, while this watchdog's own verdict read "4 alarming".
    // The lane set is declared and small, so per-lane windows are bounded.
    await record(env, {
      error: new Error(laneAlarmSummary(alarm, nowMs)),
      route: "watchdog:lane-alarm",
      fingerprintDetail: alarm.lane,
      errorCode:
        alarm.kind === "stale"
          ? "lane_stale"
          : alarm.kind === "flapping"
            ? "lane_flapping"
            : "lane_silent",
    }).catch(() => false);
    if (!github || listUnavailable) continue;
    const number = await github
      .open(alarm, laneAlarmTitle(alarm.lane), body)
      .catch(() => null);
    if (number !== null) opened += 1;
  }
  // THE ALARM'S ONLY PUSH CHANNEL, CHECKED (#11226's class, on this lane).
  //
  // `opened` was a number in a return value nothing reads. A tick that planned
  // four alarms and got zero of them accepted looked -- in telemetry, in the
  // lane's own verdict, in the summary string -- exactly like a tick with
  // nothing to report, because the reader IS ok whenever it ran and every
  // create failure was swallowed by `.catch(() => null)`.
  //
  // Production sat in that state: `alarm(lane):` issues have never existed,
  // against days of alarming lanes. The per-lane events kept firing into
  // PostHog, so the fleet looked instrumented while the channel a maintainer
  // actually reads was empty.
  //
  // Its OWN fingerprint, deliberately: filed under a lane it would hide behind
  // that lane's alarm and read as one more stale producer, when it is the
  // opposite -- the watchdog cannot report at all.
  if (listUnavailable) {
    // Its own code, because the two are different problems with different
    // fixes: this one is "we could not ask GitHub what is already open", and
    // the one below is "we asked, and it refused everything we sent".
    await record(env, {
      error: new Error(
        `lane-alarm could not read its issue list: ${plan.open.length} alarming lane(s) ` +
          "recorded but none filed, because opening without the list would " +
          "duplicate every outstanding alarm.",
      ),
      route: "watchdog:lane-alarm",
      fingerprintDetail: "delivery",
      errorCode: "alarm_list_unavailable",
    }).catch(() => false);
  }
  if (github && !listUnavailable && plan.open.length > 0 && opened === 0) {
    await record(env, {
      error: new Error(
        `lane-alarm delivered nothing: ${plan.open.length} alarming lane(s) planned, ` +
          "GitHub accepted none. The alarm's only push channel is not working. " +
          "Opening an issue needs `issues: write` on this repository; " +
          "GITHUB_TOKEN is the upgrade radar's public-read token and does not " +
          "carry it. Set LANE_ALARM_GITHUB_TOKEN to a credential that does.",
      ),
      route: "watchdog:lane-alarm",
      fingerprintDetail: "delivery",
      errorCode: "alarm_undelivered",
    }).catch(() => false);
  }

  // Guarded as a whole rather than per entry: with no client there are no open
  // alarms to have recovered, so the loop body is unreachable, not skipped.
  if (github && !listUnavailable) {
    for (const entry of plan.close) {
      const ok = await github
        .close(entry.issue, laneAlarmRecoveryComment(entry.lane, entry.record))
        .catch(() => false);
      if (ok) closed += 1;
    }
    for (const entry of plan.update) {
      // Recorded to PostHog too, and for the same reason the opens are: the
      // GitHub write is one channel, and a loss nobody can see is the thing
      // this whole list exists to end. Its own code, because "more was lost on
      // a queue already alarming" is a different event from the first loss.
      await record(env, {
        error: new Error(
          `lane ${entry.lane} lost more while already alarming` +
            (entry.record.detail ? ` -- ${entry.record.detail}` : ""),
        ),
        route: "watchdog:lane-alarm",
        fingerprintDetail: entry.lane,
        errorCode: "lane_lost_again",
      }).catch(() => false);
      const ok = await github
        .comment(entry.issue, laneAlarmLossComment(entry.lane, entry.record))
        .catch(() => false);
      if (ok) commented += 1;
    }
  }

  await recordLaneVerdict(db, {
    lane: "lane-alarm",
    // The READER is ok whenever it ran. Whether the lanes it read are ok is the
    // `alarming` count, and conflating the two would make this row report the
    // platform's health instead of its own -- at which point a silent reader
    // and a healthy platform look identical.
    verdict: "ok",
    age_ms: null,
    detail: `${plan.open.length} alarming, ${plan.close.length} recovered, ${plan.update.length} recurred, ${Object.keys(latest).length} lanes`,
    checked_at: nowMs,
  });

  return {
    ok: true,
    lanes: Object.keys(latest).length,
    alarming: plan.open.length,
    recovered: plan.close.length,
    recurred: plan.update.length,
    suppressed: plan.suppressed,
    opened,
    closed,
    commented,
    delivered: Boolean(github) && !listUnavailable,
    ...(listUnavailable ? { reason: "issue_list_unavailable" } : {}),
  };
}
