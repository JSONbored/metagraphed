// When a subnet's miners stop announcing an axon (#11328).
//
// ## The event this exists for
//
// On 2026-08-11, 94 of SN101's 256 miners stopped publishing an axon and had
// not resumed four days later. The hotkey set did not change, emission stayed
// flat at ~295.17 TAO/day, and validator permits held. The miners kept earning
// while becoming unreachable-by-announcement, and NOTHING in the fleet reported
// it -- the axon-removals routes that exist to surface exactly this answer a
// permanent zero (#10805), and no watchdog read `neuron_daily.axon` at all.
//
// Sweeping the whole table rather than the one subnet found it is not rare.
// Measured 2026-08-15 over 37 retained days, six subnets had a sustained
// collapse; two (25 and 102) were still in one, and SN25's was worse than the
// filed case: 80 announced axons down to 14 in four days.
//
// ## Against a TRAILING BASELINE, not against yesterday
//
// This is the measurement that decided the shape. SN25's decline ran
// 80 -> 59 -> 21 -> 13 -> 14. The first step is a 26% drop, under any sane
// day-over-day threshold, so a yesterday-comparison does not see the collapse
// start; it only catches the middle of it. Comparing each day against the
// median of the previous week catches it on the first day that matters and
// keeps catching it while it continues.
//
// Gradual is also the COMMON case here, not the exotic one: of the six measured
// incidents, 102, 65 and 25 all bled over days rather than dropping in a step.
//
// ## `neurons` travels with `with_axon`, because they answer different questions
//
// SN103 looked like the biggest axon event in the window -- 252 to zero on
// 2026-08-04. It is not an axon event: `neurons` went 256 -> 2 on the same day.
// The metagraph emptied, which on a recycled netuid is a deregistration and
// re-registration rather than miners ceasing to announce
// (a netuid is an unstable join key). Reading `with_axon` alone would have
// reported a subnet's miners going dark when the subnet itself had turned over,
// which is a different fact for a different reader -- so both counts are
// carried and the finding says which happened.
//
// ## A day where everything drops is OUR capture, not their behaviour
//
// #11328 established this by controlling against the rest of the network:
// excluding SN101, the network-wide axon series was flat across its boundary,
// which is what made "they stopped publishing" separable from "we stopped
// reading". The same control is cheap here and falls out of the same rows: the
// one day in the window where three subnets dropped together (2026-07-16) is
// also the only one that did not persist. So a fleet-wide flag count is a guard
// against reporting our own wobble as somebody else's outage.
//
// ## What this does NOT claim
//
// The baseline decays toward whatever the subnet settles at, so an incident
// alarms for a few days and then goes quiet even while the subnet stays down.
// That is correct for a CHANGE detector and it is the whole contract: this
// answers "something moved", never "this subnet is currently healthy".

import { readStore, type StoreEnv } from "./read-store.ts";
import { laneHealthStore } from "./lane-health-store.ts";
import { recordLaneVerdict, type LaneHealthDb } from "./lane-health.ts";
import { recordExceptionEvent, type TelemetryEnv } from "./usage-telemetry.ts";

/** Lane name, in `lane_health` and in the watchdog's own route label. */
export const AXON_ANNOUNCEMENT_LANE = "axon-announcement";

/**
 * Days of history the baseline is taken over, not counting the day under test.
 *
 * Seven, so the baseline spans a week of ordinary variation and a single bad
 * capture day cannot move a median of seven values far.
 */
export const AXON_BASELINE_DAYS = 7;

/**
 * Flag when the day under test holds less than this share of its baseline.
 *
 * 0.7 measured against the real distribution over 4,644 subnet-day
 * transitions: the 5th percentile of the day-over-day ratio is 0.980 and the
 * 1st is 0.722, so a third of a subnet's announcements disappearing is already
 * far outside ordinary movement. Every one of the six incidents in the window
 * clears it comfortably; the tightest is SN101 at 0.578.
 */
export const AXON_DROP_RATIO = 0.7;

/**
 * Baselines below this are not evaluated.
 *
 * Without a floor the flag list is dominated by subnets where the whole
 * announced set is single digits and a 30% move is three miners. With it, the
 * window's flags are six real incidents rather than dozens of rounding events.
 */
export const AXON_BASELINE_FLOOR = 20;

/**
 * Flags on one day at or above this count are reported as OUR capture rather
 * than as findings about subnets.
 *
 * Four: the window's genuine incidents flag at most three subnets on a day, and
 * they are independent events that happen to overlap. The one day where several
 * moved together (2026-07-16, three subnets) is also the only one that did not
 * persist -- the signature of the poller wobbling. Set above the observed
 * independent maximum so a real cluster is not silently reclassified, and low
 * enough that a genuine fleet-wide read failure is never reported as 129
 * separate subnet outages.
 */
export const AXON_FLEET_WIDE_FLAGS = 4;

/** Most subnets named in one detail string, so a fleet event stays readable. */
export const AXON_MAX_LISTED = 8;

/** One subnet-day, as read from `neuron_daily`. */
export interface AxonDay {
  date: string;
  /** Neurons publishing a non-empty axon. */
  withAxon: number;
  /** Neurons present at all. Distinguishes withdrawal from turnover. */
  neurons: number;
}

/** What happened to one subnet. */
export interface AxonFinding {
  netuid: number;
  date: string;
  withAxon: number;
  baseline: number;
  ratio: number;
  neurons: number;
  neuronBaseline: number;
  /**
   * `announcements-withdrawn`: the miners are still there and stopped
   * announcing -- the #11328 shape. `subnet-turned-over`: the metagraph itself
   * emptied, so the missing axons are missing NEURONS and the subnet's
   * membership is the story.
   */
  kind: "announcements-withdrawn" | "subnet-turned-over";
}

/** Median of a list, on a copy — the caller's array is never reordered. */
export function medianOf(values: readonly number[]): number | null {
  const sorted = [...values]
    .filter((v) => Number.isFinite(v))
    .sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Evaluate ONE subnet's series, oldest first. Null when there is nothing to say.
 *
 * Deliberately returns null rather than a "healthy" finding: a subnet with too
 * little history, or a baseline under the floor, has not been measured, and
 * reporting it as fine would be the [[a-correct-decline-hides-a-dead-producer]]
 * shape one level down.
 */
export function evaluateSubnetAxons(
  netuid: number,
  series: readonly AxonDay[],
): AxonFinding | null {
  if (!Array.isArray(series) || series.length < 2) return null;
  const latest = series[series.length - 1];
  if (!latest || !Number.isFinite(latest.withAxon)) return null;
  const window = series.slice(
    Math.max(0, series.length - 1 - AXON_BASELINE_DAYS),
    series.length - 1,
  );
  const baseline = medianOf(window.map((d) => d.withAxon));
  if (baseline === null || baseline < AXON_BASELINE_FLOOR) return null;
  const ratio = latest.withAxon / baseline;
  if (!(ratio < AXON_DROP_RATIO)) return null;
  const neuronBaseline = medianOf(window.map((d) => d.neurons)) ?? 0;
  // Turnover is judged on the SAME ratio as the axons, so the two cannot
  // disagree about what "collapsed" means. A subnet whose neuron count held
  // while its axons vanished is the #11328 shape; one where both fell is a
  // membership change wearing an axon costume.
  const turnedOver =
    neuronBaseline >= AXON_BASELINE_FLOOR &&
    latest.neurons / neuronBaseline < AXON_DROP_RATIO;
  return {
    netuid,
    date: latest.date,
    withAxon: latest.withAxon,
    baseline,
    ratio,
    neurons: latest.neurons,
    neuronBaseline,
    kind: turnedOver ? "subnet-turned-over" : "announcements-withdrawn",
  };
}

/** Every subnet's finding, netuid order, from rows grouped per subnet. */
export function evaluateAxonAnnouncements(
  bySubnet: ReadonlyMap<number, readonly AxonDay[]>,
): AxonFinding[] {
  const out: AxonFinding[] = [];
  for (const [netuid, series] of bySubnet) {
    const finding = evaluateSubnetAxons(netuid, series);
    if (finding) out.push(finding);
  }
  return out.sort((a, b) => a.ratio - b.ratio || a.netuid - b.netuid);
}

/** True when this many subnets flagging at once is more likely to be us. */
export function isFleetWide(findings: readonly AxonFinding[]): boolean {
  return findings.length >= AXON_FLEET_WIDE_FLAGS;
}

/** Human-readable summary, bounded so a fleet event cannot produce a wall. */
export function axonDetail(findings: readonly AxonFinding[]): string {
  if (findings.length === 0) return "no subnet below baseline";
  const listed = findings
    .slice(0, AXON_MAX_LISTED)
    .map(
      (f) =>
        `SN${f.netuid} ${f.withAxon}/${f.baseline} axons (${Math.round(f.ratio * 100)}%` +
        (f.kind === "subnet-turned-over"
          ? `, neurons ${f.neurons}/${f.neuronBaseline} -- the subnet turned over`
          : "") +
        ")",
    )
    .join("; ");
  const rest =
    findings.length > AXON_MAX_LISTED
      ? ` (+${findings.length - AXON_MAX_LISTED} more)`
      : "";
  return `${listed}${rest}`;
}

export interface AxonWatchdogDeps {
  laneHealthDb?: LaneHealthDb | null;
  now?: () => number;
  recordException?: typeof recordExceptionEvent;
}

/**
 * One tick. Returns a summary rather than throwing, matching the cron family.
 */
export async function runAxonAnnouncementWatchdog(
  env: (StoreEnv & TelemetryEnv) | null | undefined,
  deps: AxonWatchdogDeps = {},
): Promise<Record<string, unknown>> {
  const now = deps.now ?? Date.now;
  const record = deps.recordException ?? recordExceptionEvent;
  const db = readStore(env, ["neuron_daily"]);
  if (!db?.query) return { ok: false, reason: "no store bound" };

  let bySubnet: Map<number, AxonDay[]>;
  try {
    // Aggregated in the store: the raw window is ~129 subnets x 256 neurons x 8
    // days, and the answer is two integers per subnet-day.
    const rows = await db.query(
      "SELECT netuid, snapshot_date AS date, " +
        "COUNT(*) FILTER (WHERE axon IS NOT NULL AND axon <> '') AS with_axon, " +
        "COUNT(*) AS neurons FROM neuron_daily " +
        "WHERE snapshot_date >= ? GROUP BY netuid, snapshot_date " +
        "ORDER BY netuid, snapshot_date",
      [isoDaysAgo(now(), AXON_BASELINE_DAYS + 1)],
    );
    bySubnet = groupAxonDays(rows);
  } catch (err) {
    return {
      ok: false,
      reason: "query_failed",
      detail: err instanceof Error ? err.message : String(err),
    };
  }

  const findings = evaluateAxonAnnouncements(bySubnet);
  const fleetWide = isFleetWide(findings);
  const detail = axonDetail(findings);

  if (findings.length > 0) {
    // A fleet-wide flag is reported as OUR failure and given its own error
    // code, because it sends a reader somewhere completely different: to the
    // poller, not to a subnet's operators. Collapsing the two would make an
    // outage of ours read as 129 subnets going dark at once.
    await record(env, {
      error: new Error(
        fleetWide
          ? `${findings.length} subnets dropped below their axon baseline on the same day -- ` +
              `that is far more than any observed independent cluster (max 3), so read this as the ` +
              `metagraph capture failing rather than as subnets going dark: ${detail}`
          : `announced axons collapsed: ${detail} -- these miners are still registered and still ` +
              `earning, so an axon that stops being published is a reachability change nothing ` +
              `else in the fleet reports (#11328)`,
      ),
      route: `watchdog:${AXON_ANNOUNCEMENT_LANE}`,
      errorCode: fleetWide
        ? "axon_capture_suspect"
        : "axon_announcements_dropped",
    }).catch(() => false);
  }

  await recordLaneVerdict(laneHealthStore(env, deps.laneHealthDb), {
    lane: AXON_ANNOUNCEMENT_LANE,
    // `stale` is the vocabulary `lane_health` has for "this lane has a finding";
    // there is no `finding` verdict, and inventing one would drift from the
    // published enum every other reader shares.
    verdict: findings.length > 0 ? "stale" : "ok",
    age_ms: null,
    detail,
    checked_at: now(),
  });

  return {
    ok: true,
    alerted: findings.length > 0,
    fleet_wide: fleetWide,
    subnets_measured: bySubnet.size,
    findings,
  };
}

/** `YYYY-MM-DD`, `days` before `nowMs`, matching `snapshot_date`'s text form. */
export function isoDaysAgo(nowMs: number, days: number): string {
  const t = Number.isFinite(nowMs) ? nowMs : Date.now();
  return new Date(t - days * 86_400_000).toISOString().slice(0, 10);
}

/** Group store rows into per-subnet series, oldest first. */
export function groupAxonDays(
  rows: readonly Record<string, unknown>[],
): Map<number, AxonDay[]> {
  const out = new Map<number, AxonDay[]>();
  for (const row of rows ?? []) {
    const netuid = Number(row?.netuid);
    const date = String(row?.date ?? "");
    if (!Number.isFinite(netuid) || date === "") continue;
    const day: AxonDay = {
      date,
      withAxon: Number(row?.with_axon ?? 0),
      neurons: Number(row?.neurons ?? 0),
    };
    if (!Number.isFinite(day.withAxon) || !Number.isFinite(day.neurons))
      continue;
    const series = out.get(netuid);
    if (series) series.push(day);
    else out.set(netuid, [day]);
  }
  // Sorted here rather than trusted from the query, so the evaluator is correct
  // on whatever it is handed -- the same discipline loadLatestLaneHealth applies
  // to its own reduction.
  for (const series of out.values())
    series.sort((a, b) => a.date.localeCompare(b.date));
  return out;
}
