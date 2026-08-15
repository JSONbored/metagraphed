// Which lanes are due to run on this tick (#10709).
//
// ## The failure class this removes
//
// `dispatchScheduled` keys on the LITERAL cron string -- `if (cron === X_CRON)`
// against 38 registered expressions. Two lanes sharing an expression means the
// first branch wins and the second silently never runs, which is the shape
// #10566, #10680 and #10548 all turned out to be. A lane therefore needed its
// own minute, and the hourly grid was 97% full: accounting for the `*/5` and
// `*/15` expressions, exactly THREE every-hour minutes were free (17, 24, 56).
//
// #10715 took the first half of the fix -- one heartbeat expression, and a lane
// registry (`LANE_PRODUCERS`) that a new lane joins instead of the grid. This
// module is the second half: a lane declares HOW OFTEN it wants to run, and the
// dispatcher runs whichever lanes are due. "How often" stops being a function of
// "which minute is free".
//
// ## The tick grid quantises every cadence, and that is not a bug to hide
//
// A lane cannot run more often than the dispatcher ticks. Declaring
// `everyMinutes: 5` against an hourly grid does not produce a 5-minute lane; it
// produces a lane that runs on every tick. The registry is a request for a
// cadence FLOOR, never a promise of one, and `everyMinutes` below the tick
// interval is the caller asking for "every tick".
//
// This matters because the free minutes are unevenly spaced. A widened grid of
// {17, 26, 56} has gaps of 9, 30 and 21 minutes, so a lane declaring 15 minutes
// would run at :17 and :56 -- twice an hour, unevenly -- not four times. Sizing
// a cadence against the grid is the caller's job; this module only answers
// "has enough time passed".
//
// ## Extra ticks are RETRIES, not extra runs
//
// This is the reason widening the grid is worth anything while every registered
// lane is hourly. Without a cadence gate, three ticks an hour would run every
// lane three times an hour. With one, a lane that ran at :26 is simply not due
// at :56, and the extra ticks cost a single last-run read.
//
// What they buy is recovery. If the :26 tick fails -- a Worker error, a deploy
// window, a cold start that timed out -- the lane used to wait a full hour for
// its one clock to come round again. Now :56 sees an elapsed of 90 minutes and
// runs it. The gate converts spare capacity on the grid into a shorter worst
// case, without changing the steady-state rate.

/** A lane that declares its own cadence instead of taking a cron minute. */
export interface ScheduledLane {
  /** Matches the `lane` column in `lane_health`, which is where last-run comes
   * from. A name that does not match means the lane reads as never-run and
   * therefore runs every tick -- loud, not silent, which is the intended way
   * round for a typo. */
  name: string;
  /** Requested cadence FLOOR in minutes. Quantised up to the tick grid (see the
   * header): this is "not more often than", never "exactly every". */
  everyMinutes: number;
}

/**
 * How early a lane may run before its cadence has strictly elapsed.
 *
 * WITHOUT this, the gate halves the rate of any lane whose cadence equals the
 * tick interval. Cron delivery is not to-the-millisecond: an hourly lane that
 * ran at 12:26:04 and is re-checked at 13:26:01 has an elapsed of 59m57s, which
 * is less than 60 minutes, so it would be skipped -- and the next tick is a full
 * interval away. An hourly lane silently becomes two-hourly, and the symptom is
 * a staleness watchdog firing at roughly double the declared cadence.
 *
 * Four minutes, sized against the GRID rather than against the jitter: it has to
 * be comfortably larger than any plausible delivery skew, and strictly smaller
 * than the smallest gap between two ticks (9 minutes, :17 to :26) or a lane
 * could satisfy its cadence on two consecutive ticks and run twice.
 */
export const LANE_DUE_TOLERANCE_MS = 4 * 60 * 1000;

/**
 * Reduce a `lane_health` snapshot to the last-run map `lanesDue` wants.
 *
 * Pure, and here rather than inline in the dispatcher, because `workers/api.ts`
 * is where an untested branch hides best: a loop over a store result inside a
 * cron branch is reachable only with a live Postgres handle. As a function it is
 * exercised directly.
 *
 * `checked_at` is only a LAST-RUN stamp for lanes that write it at the moment
 * they run. Several lanes stamp their producer's pass time instead, which
 * freezes while the producer is down -- feeding those to `lanesDue` would read a
 * dead lane as permanently overdue. Callers must know which they have.
 */
export function lastRunFromLaneHealth(
  health: Readonly<
    Record<string, { checked_at?: number | null } | null | undefined>
  >,
): Record<string, number> {
  const lastRun: Record<string, number> = {};
  for (const [lane, record] of Object.entries(health ?? {})) {
    const stamp = record?.checked_at;
    // Anything unusable is OMITTED rather than defaulted, so the lane reads as
    // never-run and `lanesDue` returns it. Writing a 0 here would say the same
    // thing by accident; leaving it out says it on purpose.
    if (typeof stamp === "number" && Number.isFinite(stamp) && stamp > 0) {
      lastRun[lane] = stamp;
    }
  }
  return lastRun;
}

/**
 * The lanes that should run on this tick.
 *
 * `lastRunMs` maps lane name to the wall-clock time that lane last RAN. It must
 * come from a source the caller knows is a run stamp -- see the note in
 * `workers/api.ts` about `lane_health.checked_at`, which is a true run stamp for
 * the heartbeat's own lanes and is NOT one for lanes stamped with a producer's
 * pass time.
 *
 * ## Every uncertain case resolves to RUNNING
 *
 * A missing, zero, non-finite or FUTURE stamp all return the lane as due. That
 * is deliberate and it is the whole safety argument for putting a gate in front
 * of 39 producers:
 *
 *   - Missing: a newly registered lane, or one whose 90-day history was pruned.
 *     Waiting a full period to start is a slow silent stop.
 *   - Future: a clock skew or a bad row. Subtracting gives a negative elapsed,
 *     which under a strict comparison would stall the lane until real time
 *     caught up -- potentially forever, with no error anywhere.
 *
 * Running a lane sooner than asked costs one extra enqueue. Not running it is
 * the failure this issue exists to remove, so the gate fails toward running.
 */
export function lanesDue<T extends ScheduledLane>(
  lanes: readonly T[],
  lastRunMs: Readonly<Record<string, number | null | undefined>>,
  nowMs: number,
): T[] {
  if (!Number.isFinite(nowMs)) return [...lanes];
  return lanes.filter((lane) => {
    const last = lastRunMs?.[lane.name];
    // `<= 0` and not just `== null`: `lane_health.checked_at` reads through
    // `safeIntOrNull(...) ?? 0`, so a row with an unparseable stamp arrives as a
    // real 0 rather than as absent, and 0 would otherwise read as "ran at the
    // epoch" -- which is due anyway, but only by accident of arithmetic.
    if (typeof last !== "number" || !Number.isFinite(last) || last <= 0) {
      return true;
    }
    const elapsed = nowMs - last;
    // A future stamp is a broken clock, not a lane that just ran.
    if (elapsed < 0) return true;
    const every = lane.everyMinutes;
    // An absent or nonsensical cadence runs every tick rather than never. Same
    // polarity as the rest of this function: a registry entry someone forgot to
    // give a cadence is a lane that runs too often, which is visible.
    if (!Number.isFinite(every) || every <= 0) return true;
    return elapsed >= every * 60 * 1000 - LANE_DUE_TOLERANCE_MS;
  });
}
