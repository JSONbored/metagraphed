// One clock for the staleness watchdogs (#10849 item 5).
//
// ## What this replaces
//
// Eight watchdogs each held a cron expression of its own, and the hourly grid
// is full. Expanding the step expressions -- `*/5` (raw capture) fires on every
// multiple of five, `*/15` (health prober) on every multiple of fifteen -- the
// 60-minute grid has exactly ONE genuinely unclaimed minute. `src/lane-scheduler.ts`
// recorded the same measurement when it was written ("exactly THREE every-hour
// minutes were free"), and it has got worse since.
//
// The producers already solved this: #10715 gave them one heartbeat and a
// registry, and #10709 gave the registry a cadence gate so a lane declares HOW
// OFTEN rather than WHICH MINUTE. This is that pattern for the watchdog family,
// and it is not a new idea in this file either -- `rpc-usage-staleness` has
// ridden the health-prune tick since #9228 rather than taking a minute.
//
// ## Cadence is preserved exactly, which is the whole point
//
// A watchdog that checks less often detects later, and detection latency is the
// only thing a staleness alarm sells. Measured against the eight crons this
// replaces, every one runs at 15, 30 or 60 minutes:
//
//   neurons-staleness                    6,21,36,51    15m
//   chain-detail-staleness               14,29,44,59   15m
//   projection-staleness                 2,32          30m
//   nominator-positions-staleness        8,38          30m
//   validator-nominator-counts-staleness 19,49         30m
//   account-balances-staleness           4,34          30m
//   top-holders-*-staleness              22,52         30m
//   hotkey-alpha-staleness               54            60m
//
// All three divide into a 15-minute tick, so a quarter-hourly heartbeat plus
// `lanesDue` reproduces each cadence exactly rather than approximately. That is
// why the heartbeat is quarter-hourly and not hourly: an hourly clock would
// quietly turn two 15-minute alarms into 60-minute ones, and the issue asking
// for this consolidation asks for it on comprehensibility grounds -- which is
// not a trade worth any detection latency at all.
//
// ## One lane's failure must never silence another's alarm
//
// This is the property the whole module exists to protect, and it is the lesson
// #9228 already paid for here: `rpc-usage-staleness` was moved to run BEFORE a
// sibling's gate precisely because "the gate can early-return this whole tick,
// and an alarm that a sibling lane's failure can silence is an alarm that
// reports healthy for exactly the reason it should be shouting."
//
// Eight watchdogs behind one trigger makes that failure mode eight times
// cheaper to hit, so every lane runs inside its own try/catch and a throw is
// recorded and stepped over. `Promise.all` would have been shorter and is
// exactly wrong: the first rejection abandons the rest.
//
// A THROWN LANE IS NOT MARKED HEALTHY. It writes no verdict, so its
// `lane_health.checked_at` freezes and the existing lane alarm reports it stale
// on the normal path. Writing a verdict here to record the failure would
// refresh that stamp and make a permanently broken watchdog look recently
// checked -- suppressing the alarm at the moment it should fire.
//
// ## Sequential, not concurrent
//
// Each lane is a `MAX(...)` against Neon through Hyperdrive. Eight at once is
// eight pooled connections for no gain -- the tick has fifteen minutes and the
// work is milliseconds -- and Neon compute is the estate's live cost pressure.
import { lanesDue, type ScheduledLane } from "./lane-scheduler.ts";

/** A staleness watchdog that declares a cadence instead of taking a minute. */
export interface StalenessWatchdogLane<E> extends ScheduledLane {
  /**
   * `name` must equal the lane's own `lane_health.lane` value, because that row's
   * `checked_at` is what gates the cadence. These watchdogs stamp `now()` at the
   * moment they run -- verified per module -- so it is a true last-run stamp.
   * That is NOT true of `lane_health` generally: lanes stamped with a producer's
   * pass time freeze while the producer is down, and feeding one of those to the
   * gate would read a dead lane as permanently overdue.
   */
  run: (env: E) => Promise<Record<string, unknown>>;
}

/** What one lane did on one tick. */
export interface StalenessWatchdogOutcome {
  lane: string;
  ok: boolean;
  /**
   * What the watchdog itself returned. Carried rather than dropped so the
   * heartbeat's report says as much as the eight separate cron returns did --
   * otherwise consolidating the trigger would quietly cost every lane its
   * verdict detail at the dispatch boundary.
   */
  summary?: Record<string, unknown>;
  /** The thrown message, when it threw. Absent on success. */
  error?: string;
}

export interface StalenessWatchdogTick {
  /** False if ANY lane that ran threw. An idle tick is ok. */
  ok: boolean;
  ran: StalenessWatchdogOutcome[];
  /** Registered lanes the cadence gate held back, so "ran two of eight" reads
   * as six not-due rather than as six gone missing. */
  skipped: number;
}

export interface StalenessWatchdogTickDeps {
  /** Lane name to last-run wall clock, from `lastRunFromLaneHealth`. */
  lastRunMs?: Readonly<Record<string, number | null | undefined>>;
  now?: () => number;
}

/**
 * Run every registered watchdog that is due, in order, isolating each.
 *
 * Returns rather than throws: the caller is a cron branch whose return value is
 * a report, and a throw here would lose the outcomes of every lane that already
 * succeeded on this tick.
 */
export async function runDueStalenessWatchdogs<E>(
  lanes: ReadonlyArray<StalenessWatchdogLane<E>>,
  env: E,
  deps: StalenessWatchdogTickDeps = {},
): Promise<StalenessWatchdogTick> {
  const now = deps.now ?? Date.now;
  const registered = Array.isArray(lanes) ? lanes : [];
  const due = lanesDue(registered, deps.lastRunMs ?? {}, now());

  const ran: StalenessWatchdogOutcome[] = [];
  for (const lane of due) {
    try {
      const summary = await lane.run(env);
      ran.push({ lane: lane.name, ok: true, summary });
    } catch (error) {
      // Recorded and stepped over. The next lane still runs, and this one's
      // frozen `checked_at` is what raises the alarm -- see the header.
      ran.push({
        lane: lane.name,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    // `[].every()` is true, so a tick with nothing due reports ok -- which is
    // correct, and is the common case on a grid that ticks more often than the
    // slowest lane wants.
    ok: ran.every((outcome) => outcome.ok),
    ran,
    skipped: registered.length - ran.length,
  };
}
