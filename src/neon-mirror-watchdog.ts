// The watchdog for a mirror lane that NEVER fires (#9770).
//
// #9698's alarm catches two fault classes: a lane reporting `stale`, and a lane
// going SILENT after previously reporting. It cannot catch a third. Silence
// detection learns each lane's cadence from a 7-day window and needs
// LANE_ALARM_MIN_CADENCE_SAMPLES verdicts to learn it, so a lane with ZERO
// samples has no cadence to be late against and is indistinguishable from a
// lane that does not exist.
//
// Measured 2026-08-07, hours after the ledger mirrors deployed:
//
//     neon:account-balances            NO VERDICTS EVER
//     neon:hotkey-alpha                NO VERDICTS EVER
//     neon:validator-nominator-counts  NO VERDICTS EVER
//     neon:nominator-positions         NO VERDICTS EVER
//
// That was benign -- those producers last wrote at 04:38-04:57, before the
// mirrors deployed, and their staleness thresholds are 12h/30h/48h. But a
// typo in NEON_DUAL_WRITE_LANES, a call site never reached, and a lane wired
// but dead all look EXACTLY the same, and would keep looking the same
// indefinitely. Same shape as #9704 (a read with no writer) and #9754 (a
// decline nobody could tell from a failure): an absence that reads as health.
//
// ## The rule, which needs no cadence knowledge
//
// A MIRROR MUST BE NO OLDER THAN THE TABLE IT MIRRORS. The mirror runs in the
// same request as the D1 write, so if a table's own `MAX(captured_at)` is newer
// than the newest `neon:<lane>` verdict, that write happened and the mirror did
// not follow it. This works identically for a 15-minute lane and a 48-hour one.
//
// ## But "never mirrored" is NOT the same fault, and must not be alarmed
//
// A lane with no verdict at all is indistinguishable from one whose producer
// has not run since the mirror deployed. That was true of all four ledger lanes
// above: their tables last wrote at 04:38-04:57 against a mirror deployed at
// 08:05, so there had been nothing to mirror. Reporting them stale would be an
// alarm firing on a system working correctly, and an alarm that cries wolf gets
// muted -- which would cost more than the gap it was closing.
//
// Telling the two apart needs the mirror's DEPLOY time, which lane_health does
// not know. So this reports demonstrable lag as `stale`, and never-mirrored as
// a named fact in the same verdict's detail for a human to judge. That is one
// query replacing the four-way manual comparison it came from.
//
// The table pairing is also why
// the pairing is against the TABLE rather than against the D1 lane that writes
// it: those lane names do not match one-for-one (`validator-nominator-counts`
// is written by a lane called `validator-nominators`), and `nominator_positions`
// has no writer-side lane at all -- only a staleness watchdog, which runs on
// its own cron and would report health whether or not the producer ever ran.
// Table freshness is the one signal every mirrored lane actually has.

import { neonDualWriteLanes } from "./neon-write.ts";
import { LEDGER_MIRROR_PLANS } from "./ledger-neon-write.ts";
import { NEURON_MIRROR_PLANS } from "./neurons-neon-write.ts";
import { NOMINATOR_POSITIONS_NEON_LANE } from "./nominator-positions-neon-write.ts";
import {
  loadLatestLaneHealth,
  recordLaneVerdict,
  type LaneHealthDb,
} from "./lane-health.ts";

/** This watchdog's own lane. */
export const NEON_MIRROR_LAG_LANE = "neon-mirror-lag";

/**
 * How far a mirror may trail the table it mirrors before this reports.
 *
 * Generous on purpose. The mirror writes in the same request as the D1 write,
 * so under any healthy condition the gap is milliseconds -- but a verdict write
 * can fail independently (recordLaneVerdict swallows its own errors by design,
 * because a watchdog whose alarm-recording broke its alarm would be worse than
 * the bug). An hour separates "the mirror is not running" from "one verdict did
 * not land", and only the first is worth an alarm.
 */
export const MIRROR_LAG_THRESHOLD_MS = 60 * 60 * 1000;

/**
 * Every mirrored lane and the D1 table whose freshness proves it ran.
 *
 * Built FROM the mirror plans rather than restated, so a lane cannot be added
 * to a plan and left unwatched here -- the plans are the same constants the
 * writers use, and a test asserts this covers every lane the flag can name.
 *
 * `neurons` maps to its own table only. The two tables handleNeuronsSync
 * derives are mirrored under their own lane names and appear here in their own
 * right, which is what lets a partial failure -- neurons landing while
 * neuron_daily does not -- be seen as one lane lagging rather than as the whole
 * sync being healthy.
 */
export const MIRROR_LANE_TABLES: Readonly<Record<string, string>> = {
  ...Object.fromEntries(
    Object.entries(LEDGER_MIRROR_PLANS).map(([lane, plan]) => [
      lane,
      plan.table,
    ]),
  ),
  ...Object.fromEntries(
    Object.entries(NEURON_MIRROR_PLANS).map(([lane, plan]) => [
      lane,
      plan.table,
    ]),
  ),
  [NOMINATOR_POSITIONS_NEON_LANE]: "nominator_positions",
};

/** The minimal D1 surface this needs, so a test can hand it a fake. */
export interface MirrorWatchdogDb {
  prepare(sql: string): {
    all(): Promise<{ results?: unknown[] } | null>;
  };
}

export interface MirrorLag {
  lane: string;
  table: string;
  /** The table's own newest write. */
  tableAt: number;
  /** The mirror lane's newest verdict, or null when it has NEVER reported. */
  mirrorAt: number | null;
  /** How far the mirror trails its table. Zero for a lane with no verdict --
   * there is no gap to measure, which is the point of keeping the two apart. */
  lagMs: number;
}

/**
 * A table's newest write, per table, in one statement.
 *
 * One query rather than one per table: this runs on a cron beside five other
 * lanes, and six round trips to answer "did anything move" is five more than
 * the question needs.
 */
export function mirrorFreshnessSql(tables: readonly string[]): string {
  return tables
    .map(
      (table) => `SELECT '${table}' AS t, MAX(captured_at) AS mx FROM ${table}`,
    )
    .join(" UNION ALL ");
}

export interface MirrorSurvey {
  /** Mirrors that HAVE reported and have since fallen behind their table.
   * Demonstrably a fault: the mirror ran, the table moved, the mirror did not
   * follow. */
  lagging: MirrorLag[];
  /** Mirrors that have NEVER reported.
   *
   * Deliberately NOT reported as a fault, and this is the correction that
   * matters. A never-mirrored lane looks identical to a lane whose producer
   * simply has not run since the mirror deployed -- which was true of all four
   * ledger lanes on 2026-08-07, whose tables last wrote at 04:38-04:57 against
   * a mirror deployed at 08:05. Calling that stale would be an alarm firing on
   * a system working correctly, and an alarm that cries wolf gets muted.
   *
   * Distinguishing the two needs the mirror's deploy time, which is not a thing
   * lane_health knows. So this reports the fact and lets a human judge, which
   * is exactly the manual step it replaces -- one query instead of four. */
  neverMirrored: MirrorLag[];
}

/** Survey every watched mirror against the table it mirrors, worst first. */
export function mirrorLags(
  laneTables: Readonly<Record<string, string>>,
  watched: ReadonlySet<string>,
  tableFreshness: ReadonlyMap<string, number>,
  mirrorVerdictAt: ReadonlyMap<string, number>,
  thresholdMs: number,
): MirrorSurvey {
  const lagging: MirrorLag[] = [];
  const neverMirrored: MirrorLag[] = [];
  for (const [lane, table] of Object.entries(laneTables)) {
    // Only lanes the deployment actually mirrors. A lane not named in
    // NEON_DUAL_WRITE_LANES is SUPPOSED to have no verdicts, and reporting it
    // would make this watchdog loud about the configuration working.
    if (!watched.has(lane)) continue;
    const tableAt = tableFreshness.get(table);
    // A table nobody has written cannot prove anything about its mirror. Not a
    // lag -- an absence of evidence, which is the distinction this whole file
    // exists to keep.
    if (tableAt == null) continue;
    const mirrorAt = mirrorVerdictAt.get(`neon:${lane}`) ?? null;
    if (mirrorAt == null) {
      neverMirrored.push({ lane, table, tableAt, mirrorAt: null, lagMs: 0 });
      continue;
    }
    const lagMs = tableAt - mirrorAt;
    if (lagMs < thresholdMs) continue;
    lagging.push({ lane, table, tableAt, mirrorAt, lagMs });
  }
  return {
    lagging: lagging.sort((a, b) => b.lagMs - a.lagMs),
    neverMirrored: neverMirrored.sort((a, b) => a.lane.localeCompare(b.lane)),
  };
}

/** The survey as one line, for the verdict's detail column. */
export function describeMirrorLags(survey: MirrorSurvey): string {
  const parts: string[] = [];
  if (survey.lagging.length > 0) {
    parts.push(
      survey.lagging
        .map(
          (lag) =>
            `${lag.lane}: ${(lag.lagMs / 3_600_000).toFixed(1)}h behind ${lag.table}`,
        )
        .join("; "),
    );
  }
  if (survey.neverMirrored.length > 0) {
    // Named, not alarmed. A reader needs to know these exist to judge them.
    parts.push(
      `never mirrored (not alarmed): ${survey.neverMirrored
        .map((lag) => lag.lane)
        .join(", ")}`,
    );
  }
  return parts.length === 0
    ? "every mirror is current with its table"
    : parts.join(" | ");
}

export interface MirrorWatchdogDeps {
  db?: MirrorWatchdogDb | null;
  laneHealthDb?: LaneHealthDb | null;
  now?: () => number;
  thresholdMs?: number;
}

export interface MirrorWatchdogOutcome {
  attempted: boolean;
  survey?: MirrorSurvey;
  reason?: string;
}

/**
 * Compare every mirrored lane against the table it mirrors. Never throws.
 *
 * `unknown` rather than `stale` when the tables cannot be read: this watchdog
 * reports on OTHER lanes' evidence, and claiming they are behind because this
 * query failed would put a fabricated verdict where triage reads one. The same
 * distinction lane-health's own `staleLanes` makes.
 */
export async function runNeonMirrorWatchdog(
  env: Record<string, unknown> | null | undefined,
  deps: MirrorWatchdogDeps = {},
): Promise<MirrorWatchdogOutcome> {
  const watched = neonDualWriteLanes(env);
  if (watched.size === 0) return { attempted: false };

  const db =
    deps.db ?? (env?.METAGRAPH_HEALTH_DB as MirrorWatchdogDb | undefined);
  const laneDb =
    deps.laneHealthDb ?? (env?.METAGRAPH_HEALTH_DB as LaneHealthDb | undefined);
  const now = deps.now ?? Date.now;
  const thresholdMs = deps.thresholdMs ?? MIRROR_LAG_THRESHOLD_MS;

  const tables = [
    ...new Set(
      Object.entries(MIRROR_LANE_TABLES)
        .filter(([lane]) => watched.has(lane))
        .map(([, table]) => table),
    ),
  ];
  if (tables.length === 0) return { attempted: false };

  let freshness: Map<string, number>;
  try {
    const result = await db?.prepare(mirrorFreshnessSql(tables)).all();
    if (!result) throw new Error("no result");
    freshness = new Map();
    for (const raw of result.results ?? []) {
      const row = raw as Record<string, unknown>;
      // NULL CHECKED BEFORE Number(), because `Number(null)` is 0 and 0 passes
      // Number.isFinite. `MAX(captured_at)` over an empty table returns NULL,
      // and reading that as epoch 0 makes the table look like it was written
      // in 1970 -- which this watchdog would then report as a mirror that
      // never followed a write that never happened.
      if (row.t == null || row.mx == null) continue;
      const at = Number(row.mx);
      if (Number.isFinite(at)) freshness.set(String(row.t), at);
    }
  } catch (error) {
    await recordLaneVerdict(laneDb, {
      lane: NEON_MIRROR_LAG_LANE,
      verdict: "unknown",
      age_ms: null,
      detail: `table freshness unreadable: ${error instanceof Error ? error.message : String(error)}`,
      checked_at: now(),
    });
    return { attempted: true, reason: "freshness unreadable" };
  }

  const latest = await loadLatestLaneHealth(laneDb);
  const mirrorVerdictAt = new Map<string, number>();
  for (const [lane, record] of Object.entries(latest)) {
    if (lane.startsWith("neon:")) mirrorVerdictAt.set(lane, record.checked_at);
  }

  const survey = mirrorLags(
    MIRROR_LANE_TABLES,
    watched,
    freshness,
    mirrorVerdictAt,
    thresholdMs,
  );
  // ONLY demonstrable lag is stale. never-mirrored rides along in the detail
  // so it is visible without being alarmed on -- see this file's header.
  await recordLaneVerdict(laneDb, {
    lane: NEON_MIRROR_LAG_LANE,
    verdict: survey.lagging.length === 0 ? "ok" : "stale",
    age_ms: survey.lagging.length === 0 ? null : survey.lagging[0].lagMs,
    detail: describeMirrorLags(survey),
    checked_at: now(),
  });
  return { attempted: true, survey };
}
