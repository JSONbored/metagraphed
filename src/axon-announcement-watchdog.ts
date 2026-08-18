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
import { ROUTABLE_AXON_SQL } from "./axon-routable.ts";
import {
  AXON_LOSS_SQL,
  AXON_MOVED_SQL,
  AXON_SAME_HOTKEY_SQL,
  AXON_VIA_REUSE_SQL,
  axonSequenceSql,
} from "./axon-transition.ts";
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
   * WHAT happened, which is a different question from how much (#11369).
   *
   * - `announcements-withdrawn`: the same miners are still registered and
   *   stopped announcing. The #11328 shape, and the only one that means
   *   "somebody's miners went dark".
   * - `churn-replaced`: the announcing miners were DEREGISTERED and their UIDs
   *   reused by miners that do not announce. Nobody withdrew anything. Measured
   *   2026-08-16, this is 100% of SN25's and SN102's losses -- zero same-hotkey
   *   stops between them -- so labelling those `announcements-withdrawn` states
   *   the opposite of what happened.
   * - `moved-unroutable`: the same miners are STILL ANNOUNCING, at an address
   *   nobody can reach. Measured 2026-08-16 over 38 days, 166 of the 271
   *   same-hotkey losses network-wide are this, not withdrawal -- and SN126,
   *   the single largest source (160 in 14 days, larger than the #11328 case),
   *   is almost entirely this shape. Calling it "stopped publishing an axon"
   *   is false: they never stopped.
   * - `subnet-turned-over`: the metagraph itself emptied, so the missing axons
   *   are missing NEURONS and membership is the story.
   * - `mechanism-unknown`: the drop is real but nothing here explains it. Either
   *   the per-UID read failed, or it ran and found no transition of either
   *   shape.
   *
   * STARTS AT `mechanism-unknown`, and only a successful read moves it. The
   * earlier default was `announcements-withdrawn` on the grounds that it is the
   * reading that asks for a human -- but that is an ASSERTION, not a caution:
   * it names a mechanism, and `loadAxonLossMechanisms` returns `{}` on any
   * failure, so a broken read published "miners that are still registered and
   * still earning stopped publishing an axon" having measured nothing. On the
   * two subnets flagged 2026-08-16 that claim is exactly inverted (SN25 67/0
   * and SN102 43/0 deregistrations). An alarm may escalate on uncertainty; it
   * may not invent the finding it is uncertain about.
   */
  kind:
    | "announcements-withdrawn"
    | "churn-replaced"
    | "moved-unroutable"
    | "subnet-turned-over"
    | "mechanism-unknown";
  /** Axon losses in the window whose UID changed hands. Null until measured. */
  lossesViaReuse: number | null;
  /** Axon losses where the same hotkey stopped announcing. Null until measured. */
  lossesSameHotkey: number | null;
  /**
   * Of those, the ones STILL ANNOUNCING -- at an unroutable address.
   *
   * A subset of `lossesSameHotkey`, so `sameHotkey - movedUnroutable` is the
   * count that genuinely went dark. Null until measured.
   */
  lossesMovedUnroutable: number | null;
  /**
   * Distinct IPs the withdrawn axons were announcing from. Null until measured.
   *
   * THE DIAGNOSTIC THAT NAMES THE BLAST RADIUS. SN101's 2026-08-11 event read
   * as "75 of 256 miners went dark" -- 29% of the metagraph, and subnet-shaped.
   * All 75 were announcing from ONE address (152.53.149.254, four coldkeys), so
   * it was a single operator's host, not the subnet changing behaviour.
   *
   * 1 means one host or one operator, and probably nobody has noticed. N means
   * a genuine subnet-wide change. They ask for completely different responses,
   * and the count is the cheapest thing that separates them.
   */
  lossesDistinctIps: number | null;
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
    kind: turnedOver ? "subnet-turned-over" : "mechanism-unknown",
    // Filled in by the mechanism read, which needs per-UID rows this pure
    // evaluator is deliberately not given. Null means "not measured", never
    // "zero" -- see classifyAxonMechanism.
    lossesViaReuse: null,
    lossesSameHotkey: null,
    lossesMovedUnroutable: null,
    lossesDistinctIps: null,
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
          : f.kind === "mechanism-unknown"
            ? ", mechanism UNREAD -- the drop is real, the cause is not established"
            : f.kind === "moved-unroutable"
              ? `, ${f.lossesMovedUnroutable} of ${f.lossesSameHotkey} still announce -- they MOVED to an unroutable address rather than going dark`
              : f.kind === "churn-replaced"
                ? `, churn-replaced: ${f.lossesViaReuse ?? 0} of ${(f.lossesViaReuse ?? 0) + (f.lossesSameHotkey ?? 0)} losses were deregistrations`
                : // `announcements-withdrawn` is only reachable through a
                  // successful mechanism read, so the count is a number here --
                  // an unread one is `mechanism-unknown` above.
                  `, ${f.lossesSameHotkey} miner(s) stopped announcing` +
                  (f.lossesDistinctIps === null
                    ? ""
                    : f.lossesDistinctIps === 1
                      ? " -- ALL FROM ONE ADDRESS, so this is one host rather than the subnet"
                      : ` from ${f.lossesDistinctIps} addresses`)) +
        ")",
    )
    .join("; ");
  const rest =
    findings.length > AXON_MAX_LISTED
      ? ` (+${findings.length - AXON_MAX_LISTED} more)`
      : "";
  return `${listed}${rest}`;
}

/**
 * Which mechanism produced a subnet's axon losses (#11369).
 *
 * `sameHotkey` means the registered miner stopped announcing. `viaReuse` means
 * its UID changed hands -- a deregistration, where the newcomer simply never
 * served. They look identical in an aggregate count and mean opposite things:
 * one is somebody's fleet going dark, the other is ordinary registration churn
 * grinding the announcing set down because replacements do not announce.
 *
 * NULL COUNTS LEAVE THE DEFAULT ALONE, and that default is now
 * `mechanism-unknown`. An unmeasured mechanism must not be reported as churn,
 * because churn is the reading that does NOT ask anyone to go looking; guessing
 * it would turn an unread number into an all-clear. It must not be reported as
 * withdrawal either -- that names a cause, and naming the wrong one sends a
 * reader to the wrong subnet's operators.
 *
 * `reuse + same === 0` takes the same exit: the read SUCCEEDED and explained
 * nothing, which is a different fact from a failed read but the same claim --
 * we cannot say why the count fell.
 *
 * A tie resolves to `announcements-withdrawn`, which stays deliberate: equal
 * evidence for both is still evidence that some miners went dark.
 */
export function classifyAxonMechanism(
  counts: {
    viaReuse: number | null;
    sameHotkey: number | null;
    movedUnroutable?: number | null;
  },
  fallback: AxonFinding["kind"],
): AxonFinding["kind"] {
  const reuse = counts?.viaReuse;
  const same = counts?.sameHotkey;
  if (typeof reuse !== "number" || typeof same !== "number") return fallback;
  if (reuse + same === 0) return fallback;
  if (reuse > same) return "churn-replaced";
  // SAME-HOTKEY IS TWO MECHANISMS, NOT ONE. A miner that moved to an
  // unroutable address still announces, so "stopped publishing an axon" is
  // false for it -- and network-wide the moves OUTNUMBER the stops 166 to 105.
  // Only a measured majority of genuine stops earns the withdrawal wording;
  // an unmeasured `movedUnroutable` is 0, which leaves today's answer.
  const moved = counts?.movedUnroutable;
  if (typeof moved === "number" && Number.isFinite(moved) && moved > same / 2) {
    return "moved-unroutable";
  }
  return "announcements-withdrawn";
}

/**
 * Split each subnet's axon losses by mechanism, over the same window.
 *
 * The transition itself comes from src/axon-transition.ts, shared with the
 * removal feeds, so the alarm and the API cannot come to disagree about what a
 * loss is (#11394). What is NOT shared is the confirmation rule: the feeds hold
 * a loss back until a later reading confirms it, which is right for an archive
 * and wrong here, because the day that triggered this alarm has no later
 * reading yet and would go permanently unexplained.
 *
 * ONLY FOR SUBNETS ALREADY FLAGGED. The per-UID comparison is the expensive
 * read here -- 256 rows per subnet per day rather than one -- and on a typical
 * day the flag list is one to three subnets, so scoping it to those keeps the
 * cost proportional to what was found rather than to the network.
 *
 * `{}` on any failure, which leaves every finding's kind at its default. See
 * classifyAxonMechanism for why that is the safe direction.
 */
export async function loadAxonLossMechanisms(
  db:
    | { query?: (t: string, v?: unknown[]) => Promise<unknown[]> }
    | null
    | undefined,
  netuids: readonly number[],
  sinceDate: string,
): Promise<
  Record<
    number,
    {
      viaReuse: number;
      sameHotkey: number;
      movedUnroutable: number;
      distinctIps: number | null;
    }
  >
> {
  const out: Record<
    number,
    {
      viaReuse: number;
      sameHotkey: number;
      movedUnroutable: number;
      distinctIps: number | null;
    }
  > = {};
  const ids = (netuids ?? []).filter((n) => Number.isSafeInteger(n) && n >= 0);
  if (!db?.query || ids.length === 0) return out;
  try {
    const sameHotkeyLoss = `${AXON_LOSS_SQL} AND ${AXON_SAME_HOTKEY_SQL}`;
    const rows = (await db.query(
      `WITH seq AS (${axonSequenceSql(`netuid IN (${ids.map(() => "?").join(",")})`)}) ` +
        "SELECT netuid, " +
        `COUNT(*) FILTER (WHERE ${AXON_LOSS_SQL} AND ${AXON_VIA_REUSE_SQL}) AS via_reuse, ` +
        `COUNT(*) FILTER (WHERE ${sameHotkeyLoss}) AS same_hotkey, ` +
        `COUNT(*) FILTER (WHERE ${sameHotkeyLoss} AND ${AXON_MOVED_SQL}) AS moved_unroutable, ` +
        `COUNT(DISTINCT prev_address) FILTER (WHERE ${sameHotkeyLoss}) AS distinct_ips ` +
        "FROM seq GROUP BY netuid",
      [sinceDate, ...ids],
    )) as Record<string, unknown>[];
    for (const row of rows ?? []) {
      const netuid = Number(row?.netuid);
      const viaReuse = Number(row?.via_reuse ?? 0);
      const sameHotkey = Number(row?.same_hotkey ?? 0);
      const moved = Number(row?.moved_unroutable ?? 0);
      const ips = Number(row?.distinct_ips);
      if (!Number.isFinite(netuid)) continue;
      if (!Number.isFinite(viaReuse) || !Number.isFinite(sameHotkey)) continue;
      out[netuid] = {
        viaReuse,
        sameHotkey,
        // Clamped into the same-hotkey total it is a subset of: a driver that
        // hands back something unreadable must not make "moved" exceed the
        // losses it partitions, which would render as a negative "stopped".
        movedUnroutable:
          Number.isFinite(moved) && moved >= 0
            ? Math.min(moved, sameHotkey)
            : 0,
        // Null rather than 0 when unreadable: "no addresses" and "we did not
        // count the addresses" are different, and only one of them is a fact.
        distinctIps: Number.isFinite(ips) ? ips : null,
      };
    }
  } catch {
    // Unmeasured, not zero. The caller keeps each finding's default kind.
  }
  return out;
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
        `COUNT(*) FILTER (WHERE ${ROUTABLE_AXON_SQL}) AS with_axon, ` +
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

  // WHAT happened, not just how much (#11369). Measured 2026-08-16, SN25 and
  // SN102 had ZERO miners stop announcing -- every loss was a deregistration
  // whose replacement never served -- so reporting them as withdrawal stated
  // the opposite of the truth. Scoped to the flagged subnets, so an ordinary
  // day costs one extra grouped read over one to three netuids.
  const mechanisms = await loadAxonLossMechanisms(
    db,
    findings.map((f) => f.netuid),
    isoDaysAgo(now(), AXON_BASELINE_DAYS + 1),
  );
  for (const finding of findings) {
    const counts = mechanisms[finding.netuid];
    if (!counts) continue;
    finding.lossesViaReuse = counts.viaReuse;
    finding.lossesSameHotkey = counts.sameHotkey;
    finding.lossesMovedUnroutable = counts.movedUnroutable;
    finding.lossesDistinctIps = counts.distinctIps;
    // Turnover is decided by the neuron count and is not up for revision here:
    // a subnet that emptied is not "churn" at any ratio.
    if (finding.kind !== "subnet-turned-over") {
      finding.kind = classifyAxonMechanism(counts, finding.kind);
    }
  }

  const fleetWide = isFleetWide(findings);
  const detail = axonDetail(findings);

  // CHURN RECORDS, IT DOES NOT PAGE (#11386).
  //
  // `churn-replaced` means the announcing miners were deregistered and their
  // UIDs reused by miners that never served. Nobody went dark, and there is
  // nobody to go looking for. Measured across the network, restricted to
  // subnets with >=3 miners earning incentive, 32 of 66 (48%) have NOT ONE
  // earner that announces -- and only ~21% of registered neurons announce a
  // routable axon at all. A subnet whose announcing set is ground down one
  // deregistration at a time is describing the network's ordinary state.
  //
  // SN25 alone would have paged twice a day for about a week on this shape,
  // until its baseline decayed below the floor.
  //
  // The verdict is still WRITTEN, so it stays on /self-health and in history
  // with the mechanism and counts inline (#11385). Suppressing the page is not
  // suppressing the finding -- lane_health is the durable record by design
  // (#9330/#9340), and PostHog was never it.
  //
  // A withdrawal, a fleet-wide flag, an unread mechanism or any MIXED set all
  // still page: `every` is the bar, so one non-churn finding restores it.
  const churnOnly =
    findings.length > 0 &&
    !fleetWide &&
    findings.every((f) => f.kind === "churn-replaced");

  if (findings.length > 0 && !churnOnly) {
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
          : // ONLY ON A MEASURED WITHDRAWAL. This sentence names a cause and
            // sends a reader to a specific subnet's operators, so it is gated
            // on having actually counted same-hotkey stops rather than on
            // being the last branch left.
            findings.some((f) => f.kind === "announcements-withdrawn")
            ? `announced axons collapsed: ${detail} -- miners that are still registered and ` +
              `still earning stopped publishing an axon, so this is a reachability change ` +
              `nothing else in the fleet reports (#11328)`
            : findings.some((f) => f.kind === "moved-unroutable")
              ? `routable axons fell WITHOUT anyone going dark: ${detail} -- the same miners ` +
                `are still announcing, at addresses in documentation or private ranges that ` +
                `nothing can reach. Reachability changed; publishing did not (#11392)`
              : // Turnover, unread mechanisms, and churn MIXED with either land
                // here -- pure churn never reaches this call at all. The detail
                // already says which, and none of them is a withdrawal, so this
                // states the drop and stops.
                `announced axons fell below baseline: ${detail} -- this reports the DROP only; ` +
                `no miner was measured to have stopped announcing`,
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
    //
    // PURE CHURN IS NOT ONE OF THEM (#11367). The paging decision above already
    // concluded that churn-only means "nobody went dark, and there is nobody to
    // go looking for" -- and `stale` is not a neutral word for that, it is this
    // enum's assertion of a FAULT. Writing it for a measured non-event made two
    // components disagree: the watchdog decided not to page, and `src/lane-alarm.ts`
    // raised anyway, because its finding set is `Exclude<LaneVerdict, "ok">` and
    // it never sees the paging decision.
    //
    // The cost of that disagreement is an issue that cannot close. lane-alarm
    // closes on the first `ok`, so a lane held at `stale` by ordinary
    // deregistration churn keeps its alarm open for as long as the churn lasts
    // -- #11367 has been open since 2026-08-15 on exactly this. A verdict that
    // cannot be cleared is not a health signal; the neurons sub-lanes were the
    // same shape (#11466).
    //
    // THE FINDING IS NOT SUPPRESSED, which is the point the block above makes
    // and this keeps: `detail` still carries the subnet, the ratio, the
    // mechanism and the counts, on /self-health and in history, exactly as
    // before. What changes is only whether that record asserts a fault. A
    // withdrawal, a fleet-wide flag, an unread mechanism or any MIXED set are
    // all still `stale` -- `churnOnly` is the same `every` bar the page uses,
    // so one non-churn finding restores it.
    verdict: findings.length > 0 && !churnOnly ? "stale" : "ok",
    age_ms: null,
    detail,
    checked_at: now(),
  });

  return {
    ok: true,
    // WHETHER IT PAGED, which is no longer the same as whether it found
    // something -- pure churn is recorded without an exception.
    alerted: findings.length > 0 && !churnOnly,
    flagged: findings.length > 0,
    churn_only: churnOnly,
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
