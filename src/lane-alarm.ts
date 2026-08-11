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
import {
  loadLatestLaneHealth,
  staleLanes,
  type LaneHealthDb,
  type LaneHealthRecord,
  type LaneVerdict,
} from "./lane-health.ts";
import { recordLaneVerdict } from "./lane-health.ts";
import { recordExceptionEvent } from "./usage-telemetry.ts";
import { laneHealthStore } from "./lane-health-store.ts";

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
export type LaneAlarmKind = LaneFindingVerdict | "silent";

export interface LaneAlarm {
  lane: string;
  kind: LaneAlarmKind;
  /** When the fault started: the first tick of the stale run, or the last
   * verdict written before the lane went quiet. */
  since: number;
  /** Consecutive stale ticks. Always 0 for `silent` -- there were none. */
  ticks: number;
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
  db: D1Like | null | undefined,
  sinceMs: number,
): Promise<Record<string, number | null>> {
  if (!db?.prepare) return {};
  try {
    const result = await db.prepare(LANE_MAX_GAP_SQL).bind(sinceMs).all?.();
    const rows = (result?.results ?? []) as Record<string, unknown>[];
    const out: Record<string, number | null> = {};
    for (const row of rows) {
      const lane = row.lane == null ? "" : String(row.lane);
      if (!lane) continue;
      // The same sample floor the mean uses. `n` here counts GAPS, one fewer
      // than rows, so a lane with exactly the minimum rows still qualifies.
      const n = toInt(row.n);
      const gap = toInt(row.max_gap);
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
  openAlarms: Record<string, number>;
  nowMs: number;
  minStaleMs: number;
}

export interface LaneAlarmPlan {
  /** Alarms to raise, worst first, capped. */
  open: LaneAlarm[];
  /** Lanes that recovered and whose issue should close. Never carries a null
   * record: an entry only exists because a record said `ok`. */
  close: { lane: string; issue: number; record: LaneHealthRecord }[];
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
    observedMaxGap,
    openAlarms,
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
  const fresh = qualified.filter((alarm) => !(alarm.lane in openAlarms));
  const open = fresh.slice(0, LANE_ALARM_MAX_OPENS_PER_TICK);

  const close: LaneAlarmPlan["close"] = [];
  for (const [lane, issue] of Object.entries(openAlarms)) {
    const record = latest[lane] ?? null;
    // Only `ok` closes. A lane that went `unknown` has not recovered -- the
    // watchdog could not evaluate it -- and closing on an absence of
    // measurement is the confident-wrong-answer this repo avoids everywhere
    // else. A lane with no record at all keeps its issue for the same reason.
    if (record?.verdict !== "ok") continue;
    close.push({ lane, issue, record });
  }

  return { open, close, suppressed: fresh.length - open.length };
}

function humanDuration(ms: number): string {
  if (ms < 60_000) return `${Math.max(0, Math.round(ms / 1000))}s`;
  if (ms < 3_600_000) return `${(ms / 60_000).toFixed(0)} min`;
  if (ms < 172_800_000) return `${(ms / 3_600_000).toFixed(1)}h`;
  return `${(ms / 86_400_000).toFixed(1)} days`;
}

/**
 * The issue body. Written to be actionable without opening anything else:
 * which lane, which fault, how long, what the watchdog said, and the query that
 * shows the history.
 */
export function laneAlarmIssueBody(alarm: LaneAlarm, nowMs: number): string {
  const forHow = humanDuration(nowMs - alarm.since);
  const opening =
    alarm.kind === "stale"
      ? `\`${alarm.lane}\` has reported **stale** on every tick for **${forHow}** (${alarm.ticks} consecutive verdicts).`
      : `\`${alarm.lane}\` has written **no verdict at all** for **${forHow}**. Its watchdog appears to have stopped running -- the last verdict it did write said \`${alarm.detail ?? "ok"}\`, so nothing else will report this.`;
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
  if (alarm.cadence_ms !== null) {
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
    "Closed automatically on the first `ok` verdict. Opened by the lane-health",
    "reader (`src/lane-alarm.ts`); the record it reads is also served at",
    "`GET /api/v1/self-health`.",
  );
  return lines.join("\n");
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

interface D1Like extends LaneHealthDb {
  prepare(sql: string): {
    bind(...values: unknown[]): {
      run(): Promise<unknown>;
      first(): Promise<unknown>;
      all?(): Promise<{ results?: unknown[] } | null>;
    };
    all?(): Promise<{ results?: unknown[] } | null>;
  };
}

function toInt(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/** Current stale runs, keyed by lane. `{}` on any failure -- a reader that
 * throws is a reader that stops reading. */
export async function loadLaneUnknownRuns(
  db: D1Like | null | undefined,
): Promise<LaneVerdictRuns> {
  return loadLaneRuns(db, LANE_UNKNOWN_RUN_SQL);
}

export async function loadLaneStaleRuns(
  db: D1Like | null | undefined,
): Promise<LaneVerdictRuns> {
  return loadLaneRuns(db, LANE_STALE_RUN_SQL);
}

async function loadLaneRuns(
  db: D1Like | null | undefined,
  sql: string,
): Promise<LaneVerdictRuns> {
  if (!db?.prepare) return {};
  try {
    const result = await db.prepare(sql).all?.();
    const rows = (result?.results ?? []) as Record<string, unknown>[];
    const out: LaneVerdictRuns = {};
    for (const row of rows) {
      const lane = row.lane == null ? "" : String(row.lane);
      if (!lane) continue;
      out[lane] = { since: toInt(row.since), ticks: toInt(row.ticks) };
    }
    return out;
  } catch {
    return {};
  }
}

/** The GitHub calls this needs, as one injectable seam. */
export interface LaneAlarmGitHub {
  listOpen(): Promise<Record<string, number>>;
  open(alarm: LaneAlarm, title: string, body: string): Promise<number | null>;
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
    async listOpen() {
      const response = await fetchImpl(
        `${GITHUB_API}/repos/${repo}/issues?state=open&per_page=100`,
        { headers },
      );
      if (!response.ok) return {};
      const issues = (await response.json()) as {
        number?: number;
        title?: string;
        pull_request?: unknown;
      }[];
      const out: Record<string, number> = {};
      for (const issue of Array.isArray(issues) ? issues : []) {
        // The issues endpoint returns pull requests too, and a PR whose title
        // happens to match would be closed as though it were an alarm.
        if (issue.pull_request) continue;
        const title = issue.title ?? "";
        if (!title.startsWith(LANE_ALARM_TITLE_PREFIX)) continue;
        const lane = title.slice(LANE_ALARM_TITLE_PREFIX.length).trim();
        if (lane && typeof issue.number === "number") out[lane] = issue.number;
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
      const created = (await response.json()) as { number?: number };
      return typeof created.number === "number" ? created.number : null;
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
  env: Record<string, unknown> | null | undefined,
  deps: LaneAlarmDeps = {},
): Promise<Record<string, unknown>> {
  const now = deps.now ?? Date.now;
  const record = deps.recordException ?? recordExceptionEvent;
  // laneHealthStore, not the binding (#10154). This is the reader that opens
  // GitHub issues from lane_health verdicts, so pointing it at a store nothing
  // writes any more would replay stale verdicts forever -- filing issues for
  // lanes that recovered, and none for lanes that broke.
  const db = laneHealthStore(env) as unknown as D1Like | undefined;
  if (!db?.prepare) return { ok: false, reason: "no lane_health store bound" };

  const token = typeof env?.GITHUB_TOKEN === "string" ? env.GITHUB_TOKEN : "";
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

  const [latest, runs, unknownRuns, observedMaxGap] = await Promise.all([
    loadLatestLaneHealth(db),
    loadLaneStaleRuns(db),
    loadLaneUnknownRuns(db),
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
  if (github && openAlarms === null) {
    // Deliberately NOT falling back to `{}`. An unreadable issue list is
    // indistinguishable from "no alarms are open", and acting on that
    // assumption opens a duplicate of everything currently outstanding.
    return {
      ok: false,
      reason: "issue_list_unavailable",
      lanes: Object.keys(latest).length,
    };
  }

  const plan = laneAlarmPlan({
    latest,
    runs,
    unknownRuns,
    observedMaxGap,
    openAlarms: openAlarms ?? {},
    nowMs,
    minStaleMs,
  });

  let opened = 0;
  let closed = 0;
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
    await record(env as never, {
      error: new Error(
        `lane ${alarm.lane} is ${alarm.kind}: ${humanDuration(nowMs - alarm.since)}`,
      ),
      route: "watchdog:lane-alarm",
      fingerprintDetail: alarm.lane,
      errorCode: alarm.kind === "stale" ? "lane_stale" : "lane_silent",
    }).catch(() => false);
    if (!github) continue;
    const number = await github
      .open(alarm, laneAlarmTitle(alarm.lane), body)
      .catch(() => null);
    if (number !== null) opened += 1;
  }
  // Guarded as a whole rather than per entry: with no client there are no open
  // alarms to have recovered, so the loop body is unreachable, not skipped.
  if (github) {
    for (const entry of plan.close) {
      const ok = await github
        .close(entry.issue, laneAlarmRecoveryComment(entry.lane, entry.record))
        .catch(() => false);
      if (ok) closed += 1;
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
    detail: `${plan.open.length} alarming, ${plan.close.length} recovered, ${Object.keys(latest).length} lanes`,
    checked_at: nowMs,
  });

  return {
    ok: true,
    lanes: Object.keys(latest).length,
    alarming: plan.open.length,
    recovered: plan.close.length,
    suppressed: plan.suppressed,
    opened,
    closed,
    delivered: Boolean(github),
  };
}
