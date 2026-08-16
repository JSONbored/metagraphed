// Axon removals, derived from the daily axon STATE rather than an event.
//
// WHY THIS EXISTS. Every axon-removal route filtered for `AxonInfoRemoved`.
// That event has ZERO occurrences in `chain.chain_events` -- the COMPLETE
// pallet-level stream, 898M rows, genesis to head -- so the whole family
// published a confident `0` on every scope, for every subject, forever
// (#10805). Unlike `PrometheusServed` (18,041 on chain, 0 captured), which is
// a curation gap an indexer can close, this one was modelled on an event the
// runtime does not emit, so no indexer work populates it.
//
// THE DATA EXISTS ANYWAY, as state. `neuron_daily.axon` is snapshotted per
// (netuid, uid) per day, so an axon going away is a transition we already
// hold: a non-null axon becoming null. Deriving it here rather than
// materialising a table keeps ONE copy of the truth -- the removals are
// derivable from the state, the state is not derivable from the removals --
// and adds no new consumer to `neuron_daily`'s retention list, which #10798
// measured growing from seven modules to eight.
//
// TWO CORRECTIONS ARE MANDATORY, and without them this lies. Measured against
// Neon over 30 days, 936,244 neuron-day observations ending 2026-08-16:
//
//   axon drops (non-null -> null)                     1,584
//     ...via UID REUSE (hotkey changed)               1,485   93.8%
//     ...same hotkey                                     99    6.3%
//       ...back on the very NEXT reading (a blip)         5
//       ...absent for two readings or more               94
//   CONFIRMED REMOVALS                                   94    5.9%
//
// WHICH "CAME BACK" DISQUALIFIES A REMOVAL is a real choice, and it moves the
// answer: requiring that the hotkey never announce again ANYWHERE in the
// window gives 89 instead of 94. This takes the weaker test -- absent for at
// least two consecutive readings -- deliberately.
//
// A one-reading absence is indistinguishable from the poller missing a read,
// so it is rejected. An absence sustained across two readings and recovered a
// week later is NOT a non-event: the teardown happened, and the recovery is
// its own separate fact. Under the stricter test a removal would vanish from
// history the moment the miner came back, so yesterday's feed and today's
// would disagree about what happened last Tuesday. An archive whose past
// changes is worse than one that is sparse.
//
// 1. SUBTRACT UID REUSE. 93.8% of drops are a deregistration whose replacement
//    never announced -- an event the deregistration family already owns.
//    Counting them here reports one event twice under two names and overstates
//    teardowns 18x. The test is the hotkey on the slot, exactly as
//    src/deregistration-derivation.ts uses it.
//
// 2. REQUIRE A SECOND ABSENT READING. 5 of the 99 same-hotkey drops were back
//    on the very next reading, which is what a missed poll looks like. A
//    removal is confirmed only once the same hotkey has been observed again on
//    that slot and STILL has no axon; a drop with no following observation of
//    that hotkey is reported as pending, never as a removal. The newest day of
//    any window is structurally pending for exactly this reason.
//
// Applied, the 30-day answer is 94 removals across 7 subnets -- roughly 3 a
// day network-wide, and 80% of them one subnet. Sparse and true beats busy and
// wrong: the routes served 0 while we held this.
//
// VERIFIED AGAINST THE DATABASE, not just unit fixtures. Run over 47,616 real
// `neuron_daily` rows for netuids 2, 4, 44, 51, 61 and 85, this module and the
// equivalent SQL window function agree per subnet exactly -- 2, 1, 4, 5, 2, 5
// -- and on the 230 drops it excluded as UID reuse.

import { isRoutableAxon } from "./axon-routable.ts";

/** How the axon-removal feeds are derived, echoed on every payload. */
export const AXON_REMOVAL_DERIVATION_METHOD = "axon-state-diff";

/**
 * What an axon-removal payload says about its own derivation.
 *
 * `excluded_uid_reuse` and `pending_confirmation` are the honest part. The
 * first is how many drops were attributed elsewhere (to deregistration), the
 * second how many are real candidates the data cannot yet confirm. Publishing
 * both next to the total is the difference between "this is what happened" and
 * a number that quietly absorbs two different kinds of doubt.
 */
export interface AxonRemovalDerivation {
  method: string;
  /** Days of `neuron_daily` the derivation had available. */
  lookback_days: number;
  /** Drops attributed to UID reuse, and therefore to a deregistration. */
  excluded_uid_reuse: number;
  /**
   * Drops by a still-present hotkey with no later observation of that slot.
   *
   * Not removals, and not discarded either: the newest day in any window is
   * always in this bucket, because confirmation needs a day after it.
   */
  pending_confirmation: number;
  /**
   * Of the confirmed removals, how many still announce something unreachable.
   *
   * Stated on the payload because it is the majority and a reader paging the
   * list would otherwise have to count them: 166 of 271 same-hotkey losses
   * over 38 days were moves, not departures (#11398).
   */
  moved_unroutable: number;
}

/** One (netuid, uid) observation on one day, as `neuron_daily` stores it. */
export interface NeuronAxonDayRow {
  netuid: unknown;
  uid: unknown;
  snapshot_date: unknown;
  hotkey: unknown;
  axon: unknown;
}

/** How a slot stopped being reachable, with the same hotkey still in it. */
export type AxonRemovalKind = "stopped-announcing" | "moved-unroutable";

/** One derived removal: this hotkey stopped being reachable on this slot. */
export interface DerivedAxonRemoval {
  netuid: number;
  uid: number;
  hotkey: string;
  /** The first day the axon was unreachable. */
  removed_on: string;
  /** What it had been announcing the day before. */
  previous_axon: string;
  /**
   * `stopped-announcing` cleared the field; `moved-unroutable` still publishes
   * an address, at somewhere nothing can reach.
   *
   * Both are removals of REACHABILITY and both belong in the feed, but they
   * ask different things of a reader: one miner went away, the other is
   * running and misconfigured. Collapsing them would hide the second entirely.
   */
  kind: AxonRemovalKind;
  /** The unreachable address on a move; null when the field was cleared. */
  current_axon: string | null;
}

export interface DerivedAxonRemovals {
  removals: DerivedAxonRemoval[];
  derivation: AxonRemovalDerivation;
}

interface NormalizedDay {
  netuid: number;
  uid: number;
  date: string;
  hotkey: string;
  /**
   * Null means "nothing REACHABLE announced" -- which is what a removal
   * transitions to.
   *
   * Reachability, not presence (#11398). An axon in RFC 5737 documentation
   * space or RFC 1918 private space is announced and cannot be reached by
   * anyone, so a miner that moves to one has stopped serving exactly as much
   * as one that cleared the field. Testing presence alone missed 166 of 271
   * same-hotkey losses over 38 days, and all but one of SN126's 160 -- the
   * largest same-hotkey source on the network, which read as a single event.
   */
  axon: string | null;
  /**
   * What is announced, reachable or not.
   *
   * Non-null while `axon` is null is precisely the move case, and it is what
   * separates `moved-unroutable` from `stopped-announcing` below.
   */
  announced: string | null;
}

/** A row is usable only if it identifies a slot, a day and an occupant. */
function normalize(row: NeuronAxonDayRow): NormalizedDay | null {
  const netuid = Number(row?.netuid);
  const uid = Number(row?.uid);
  if (!Number.isInteger(netuid) || !Number.isInteger(uid)) return null;
  const hotkey = typeof row?.hotkey === "string" ? row.hotkey : "";
  if (!hotkey) return null;
  // Dates arrive as `Date` from pg and as an ISO string from the lakehouse.
  const raw = row?.snapshot_date;
  const date =
    raw instanceof Date
      ? raw.toISOString().slice(0, 10)
      : typeof raw === "string" && raw.length >= 10
        ? raw.slice(0, 10)
        : "";
  if (!date) return null;
  const announced =
    typeof row?.axon === "string" && row.axon !== "" ? row.axon : null;
  // `isRoutableAxon` is the same predicate the serving path publishes as
  // `axon_routable` and the axon-announcement alarm counts by, so all three
  // agree on what "reachable" means rather than each deciding for itself.
  const axon =
    announced !== null && isRoutableAxon(announced) ? announced : null;
  return { netuid, uid, date, hotkey, axon, announced };
}

/**
 * Confirmed axon removals in the pulled data.
 *
 * `rows` may arrive in any order and need not be dense: a slot missing from a
 * day is simply not observed, and the next observation of it is what the
 * transition is measured against.
 */
export function deriveAxonRemovals(
  rows: NeuronAxonDayRow[] | null | undefined,
  { lookbackDays }: { lookbackDays: number },
): DerivedAxonRemovals {
  const bySlot = new Map<string, NormalizedDay[]>();
  for (const row of Array.isArray(rows) ? rows : []) {
    const day = normalize(row);
    if (day === null) continue;
    const slot = `${day.netuid}:${day.uid}`;
    const bucket = bySlot.get(slot);
    if (bucket) bucket.push(day);
    else bySlot.set(slot, [day]);
  }

  const removals: DerivedAxonRemoval[] = [];
  let excludedUidReuse = 0;
  let pending = 0;

  for (const bucket of bySlot.values()) {
    bucket.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    for (let i = 1; i < bucket.length; i += 1) {
      const previous = bucket[i - 1]!;
      const current = bucket[i]!;
      // Only a non-null -> null transition is a candidate at all.
      if (previous.axon === null || current.axon !== null) continue;
      // CORRECTION 1: the slot changed hands, so this is a deregistration.
      if (previous.hotkey !== current.hotkey) {
        excludedUidReuse += 1;
        continue;
      }
      // CORRECTION 2: confirmation needs a later observation of the same
      // hotkey on the same slot. Without one, the poller having missed a read
      // is indistinguishable from a teardown.
      const later = bucket
        .slice(i + 1)
        .find((day) => day.hotkey === current.hotkey);
      if (later === undefined) {
        pending += 1;
        continue;
      }
      // It came back. A flap is a capture gap, not a removal.
      if (later.axon !== null) continue;
      removals.push({
        netuid: current.netuid,
        uid: current.uid,
        hotkey: current.hotkey,
        removed_on: current.date,
        previous_axon: previous.axon,
        kind:
          current.announced === null
            ? "stopped-announcing"
            : "moved-unroutable",
        current_axon: current.announced,
      });
    }
  }

  removals.sort(
    (a, b) =>
      (a.removed_on < b.removed_on
        ? 1
        : a.removed_on > b.removed_on
          ? -1
          : 0) ||
      a.netuid - b.netuid ||
      a.uid - b.uid,
  );

  return {
    removals,
    derivation: {
      method: AXON_REMOVAL_DERIVATION_METHOD,
      lookback_days: lookbackDays,
      excluded_uid_reuse: excludedUidReuse,
      pending_confirmation: pending,
      moved_unroutable: removals.filter(
        (removal) => removal.kind === "moved-unroutable",
      ).length,
    },
  };
}
