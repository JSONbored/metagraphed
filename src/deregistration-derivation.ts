// Deregistrations, derived from UID reuse in the NeuronRegistered stream.
//
// WHY THIS EXISTS. Every deregistration route filtered `account_events` for
// `NeuronDeregistered`. That event has ZERO occurrences in
// `chain.chain_events` -- the COMPLETE pallet-level stream, 898M rows,
// genesis to head -- so the filter has never matched anything and the whole
// family published a confident `0` on every scope, for every subject,
// forever. A 24h census of every `SubtensorModule` method returns 45 distinct
// names and this is not one of them: the routes were modelled on an event the
// Subtensor runtime does not emit, so no indexer work can ever populate them.
//
// THE DATA EXISTS ANYWAY, because deregistration in Bittensor is IMPLICIT.
// Registering into a full subnet replaces the lowest-pruning-score UID, and
// the runtime announces only the arrival. So a `NeuronRegistered` on a
// `(netuid, uid)` slot already held by a DIFFERENT hotkey *is* the
// deregistration of the previous occupant, and the previous occupant is the
// hotkey named on that slot's preceding registration.
//
// MEASURED, not assumed (live lakehouse, 2026-08-03, 30d of NeuronRegistered
// = 33,386 rows over 11,807 distinct slots):
//
//   window   registrations   derived deregistrations   unattributed
//   7d               8,064                     6,338          1,726
//   30d             33,386                    21,579         11,807
//
// So the 7d truth is ~6,300 events across 35 subnets where the routes served
// 0. (The issue's own "1,623 slots reused in 7d" counts SLOTS, not events --
// reproduced here as 1,649 slots; a slot that turned over four times is four
// deregistrations.) Not one of the 33,386 rows is a hotkey re-registering
// into the slot it already held, so the different-hotkey test never discards
// a real eviction.
//
// THE BOUNDARY IS DECLARED, NOT HIDDEN. A slot whose FIRST registration in the
// pulled data falls inside the reported window has no observed predecessor:
// either it is a genuinely new UID (the subnet grew) or its previous holder
// registered before the data begins, and nothing in this stream distinguishes
// them. Those registrations are counted as `unattributed` and reported next to
// the derived total, so a consumer reads a stated LOWER BOUND rather than a
// number that looks complete. Widening the pull is what shrinks it -- deriving
// 7d from a 30d pull (23 days of prior occupancy) cuts the unattributed share
// from 66% to 21% and more than doubles the events found, which is exactly why
// the lane pulls the widest window once and slices the narrower ones out of it
// rather than issuing one query per window.

/** How the deregistration feeds are derived, echoed on every payload. */
export const DEREGISTRATION_DERIVATION_METHOD = "uid-reuse";

/**
 * What a deregistration payload says about its own derivation.
 *
 * `unattributed_registrations` is the honest part: the published totals are a
 * LOWER BOUND by exactly that many events, because those registrations
 * displaced someone the pulled data cannot name. Publishing the bound next to
 * the number is the difference between "at least this many" and a figure that
 * reads as complete.
 */
export interface DeregistrationDerivation {
  method: string;
  /** Days of NeuronRegistered history the derivation had available. */
  lookback_days: number;
  /** Registrations observed inside the reported window. */
  window_registrations: number;
  /** Of those, the ones with no observed previous holder. */
  unattributed_registrations: number;
  /**
   * True when the published count is a floor rather than a measurement.
   *
   * The prose above, the SDL description, and `unattributed_registrations`
   * itself have all said this since #9307 -- but only to a human reading the
   * docs. The PAYLOAD published a bare number, and a bare number reads as a
   * measurement no matter what the documentation says. Measured on mainnet
   * 2026-08-07, against subnets whose UIDs are full so every registration must
   * displace someone:
   *
   *   SN64 Chutes    24 registrations/30d,   0 deregistrations   100% under
   *   SN51 lium.io   26 registrations/30d,   0 deregistrations   100% under
   *   SN120 Affine  470 registrations/30d, 219 deregistrations    53% under
   *   SN53 engy     540 registrations/30d, 287 deregistrations    47% under
   *
   * Two subnets publish a literal zero while two dozen hotkeys register into a
   * subnet with no free slots. A reader concluded "no churn, nobody
   * registering" from that zero -- the opposite of the truth -- and the number
   * gave them no reason to doubt it.
   *
   * A wrong number that looks authoritative is worse than a null, and worse
   * than a flagged floor. This is the flag.
   */
  is_lower_bound: boolean;
}

/** One NeuronRegistered row as the lakehouse returns it. */
export interface RegistrationEventRow {
  netuid?: unknown;
  uid?: unknown;
  hotkey?: unknown;
  block_number?: unknown;
  event_index?: unknown;
  observed_at?: unknown;
}

/** One derived deregistration: the displaced holder, and the registration
 * that displaced it. */
export interface DerivedDeregistration {
  netuid: number;
  uid: number;
  /** The DISPLACED hotkey -- the account this event is a deregistration OF. */
  hotkey: string;
  /** The hotkey that took the slot. */
  successor: string;
  block_number: number;
  observed_at: number;
  /**
   * HOW LONG THE DISPLACED HOLDER HELD THE SLOT, in blocks (#9742).
   *
   * The derivation already holds both registrations at once -- it needs the
   * predecessor to name the displaced hotkey at all -- so this is the distance
   * between two observed events rather than anything modelled. It was being
   * dropped on the line that builds this object.
   *
   * Null when the two registrations carry no usable ordering (a malformed or
   * equal block height); never zero, because a zero-block tenure would read as
   * "evicted instantly" rather than "not measurable".
   */
  tenure_blocks: number | null;
  /** The predecessor's own registration timestamp, so a consumer can express
   * the same span in time without needing the block schedule. */
  predecessor_observed_at: number;
}

export interface DerivedDeregistrations {
  events: DerivedDeregistration[];
  /** Registrations in the window whose slot had no observed predecessor, so
   * no displaced holder could be named. The published total is a lower bound
   * by exactly this many events. */
  unattributed: number;
  /** Registrations observed inside the window -- the denominator the two
   * numbers above are read against. */
  registrations: number;
}

interface NormalizedRegistration {
  slot: string;
  netuid: number;
  uid: number;
  hotkey: string;
  block_number: number;
  event_index: number;
  observed_at: number;
}

/** A non-negative safe integer, or null for anything else. Guards null and a
 * blank string explicitly: `Number(null)`, `Number("")` and `Number("  ")` are
 * all 0, and silently reading a malformed cell as netuid/uid 0 would attribute
 * a real eviction to the wrong slot. */
function safeIndex(value: unknown): number | null {
  if (value == null) return null;
  if (typeof value === "string" && value.trim() === "") return null;
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}

/** A finite, in-JS-Date-range epoch-ms stamp, or null. */
function safeEpochMs(value: unknown): number | null {
  if (value == null) return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Number.isFinite(new Date(n).getTime()) ? n : null;
}

/** A non-empty hotkey string, or null. */
function safeHotkey(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function normalize(row: RegistrationEventRow): NormalizedRegistration | null {
  const netuid = safeIndex(row?.netuid);
  const uid = safeIndex(row?.uid);
  const hotkey = safeHotkey(row?.hotkey);
  const block = safeIndex(row?.block_number);
  const observedAt = safeEpochMs(row?.observed_at);
  if (
    netuid === null ||
    uid === null ||
    hotkey === null ||
    block === null ||
    observedAt === null
  ) {
    // A row missing any of the five is not evidence of anything: it can
    // neither identify a slot nor order itself within one. Dropping it is
    // strictly better than guessing a slot for it.
    return null;
  }
  return {
    slot: `${netuid}:${uid}`,
    netuid,
    uid,
    hotkey,
    block_number: block,
    // Two registrations CAN land in one block on the same slot under heavy
    // churn, and then the block alone does not order them. event_index is the
    // chain's own within-block order; a row without one sorts first, which is
    // the only stable choice available.
    event_index: safeIndex(row?.event_index) ?? 0,
    observed_at: observedAt,
  };
}

/**
 * Derive the deregistrations implied by UID reuse.
 *
 * `rows` is the NeuronRegistered stream over a lookback that should be WIDER
 * than the window: everything before `since` is used only to establish who
 * held each slot, and nothing before it is ever reported.
 *
 * A registration is a deregistration of the slot's previous holder when both
 * are observed and the hotkeys differ. Same-hotkey reuse is not a
 * deregistration of anyone -- it would name the account as having evicted
 * itself.
 */
export function deriveDeregistrations(
  rows: RegistrationEventRow[] | null | undefined,
  { since }: { since: number },
): DerivedDeregistrations {
  const bySlot = new Map<string, NormalizedRegistration[]>();
  for (const row of Array.isArray(rows) ? rows : []) {
    const normalized = normalize(row);
    if (normalized === null) continue;
    const bucket = bySlot.get(normalized.slot);
    if (bucket) bucket.push(normalized);
    else bySlot.set(normalized.slot, [normalized]);
  }

  const events: DerivedDeregistration[] = [];
  let unattributed = 0;
  let registrations = 0;
  for (const bucket of bySlot.values()) {
    bucket.sort(
      (a, b) =>
        a.block_number - b.block_number || a.event_index - b.event_index,
    );
    for (let i = 0; i < bucket.length; i += 1) {
      const current = bucket[i]!;
      if (current.observed_at < since) continue;
      registrations += 1;
      const previous = i === 0 ? null : bucket[i - 1]!;
      if (previous === null) {
        unattributed += 1;
        continue;
      }
      if (previous.hotkey === current.hotkey) continue;
      const tenureBlocks = current.block_number - previous.block_number;
      events.push({
        netuid: current.netuid,
        uid: current.uid,
        hotkey: previous.hotkey,
        successor: current.hotkey,
        block_number: current.block_number,
        observed_at: current.observed_at,
        // Positive-only: the bucket is sorted by (block, event_index), so a
        // non-positive span means the two rows are not orderable by block --
        // publishing 0 would read as an instant eviction rather than as a
        // measurement that could not be taken.
        tenure_blocks: tenureBlocks > 0 ? tenureBlocks : null,
        predecessor_observed_at: previous.observed_at,
      });
    }
  }
  return { events, unattributed, registrations };
}

/** One per-subnet leaderboard row, in the exact shape
 * buildChainDeregistrations / buildSubnetDeregistrations read. */
/**
 * The observable distribution of slot tenure (#9742).
 *
 * A DISTRIBUTION, not a mean. Slot tenure is not symmetric -- a handful of
 * long-lived validators over a churn floor of miners evicted inside an epoch
 * gives a mean that describes neither -- so the median and the tails are what a
 * caller can act on.
 *
 * CENSORED, AND IT SAYS SO. Only a slot that has ALREADY turned over
 * contributes a sample; one still occupied contributes nothing, however long it
 * has been held. So the observable distribution is biased toward SHORT tenures
 * and systematically understates how long slots last. That is published as
 * `censored: true` rather than left for the reader to deduce, for the same
 * reason the count publishes `is_lower_bound` -- a number whose bias is known
 * and unstated is worse than one that declares it.
 */
export interface TenureDistribution {
  /** How many derived events carried a measurable tenure. */
  sample_count: number;
  median_blocks: number | null;
  p10_blocks: number | null;
  p90_blocks: number | null;
  min_blocks: number | null;
  max_blocks: number | null;
  /** Always true here, and stated anyway: see the note above. */
  censored: boolean;
}

/** Nearest-rank percentile over an ascending sample; null on an empty one. */
function percentileBlocks(
  ascending: number[],
  fraction: number,
): number | null {
  if (ascending.length === 0) return null;
  const rank = Math.ceil(fraction * ascending.length);
  return ascending[Math.min(Math.max(rank, 1), ascending.length) - 1] ?? null;
}

/**
 * Summarize the tenure of a set of derived deregistrations.
 *
 * Events with a null `tenure_blocks` are DROPPED rather than counted as zero:
 * an unmeasurable span is not an instant eviction, and `sample_count` is
 * reported so a caller can see how much of the set was measurable.
 */
export function summarizeTenure(
  events: DerivedDeregistration[],
): TenureDistribution {
  const samples = events
    .map((event) => event.tenure_blocks)
    .filter((value): value is number => typeof value === "number" && value > 0)
    .sort((a, b) => a - b);
  return {
    sample_count: samples.length,
    median_blocks: percentileBlocks(samples, 0.5),
    p10_blocks: percentileBlocks(samples, 0.1),
    p90_blocks: percentileBlocks(samples, 0.9),
    min_blocks: samples.length ? samples[0] : null,
    max_blocks: samples.length ? samples[samples.length - 1] : null,
    censored: true,
  };
}

export interface DeregistrationSubnetRow {
  netuid: number;
  deregistrations: number;
  distinct_deregistered_hotkeys: number;
  newest_observed: number;
  /** How long the slots that turned over here had been held (#9742). */
  tenure: TenureDistribution;
}

/**
 * Reduce derived events to one row per netuid, ranked most-active-first and
 * tie-broken by netuid -- the order the retired loader emitted, so the rows
 * reach the builder already ranked.
 */
export function deregistrationsByNetuid(
  events: DerivedDeregistration[],
): DeregistrationSubnetRow[] {
  const perNetuid = new Map<
    number,
    {
      count: number;
      hotkeys: Set<string>;
      newest: number;
      events: DerivedDeregistration[];
    }
  >();
  for (const event of events) {
    const bucket = perNetuid.get(event.netuid) ?? {
      count: 0,
      hotkeys: new Set<string>(),
      newest: 0,
      events: [],
    };
    bucket.count += 1;
    bucket.hotkeys.add(event.hotkey);
    if (event.observed_at > bucket.newest) bucket.newest = event.observed_at;
    // Kept per netuid rather than summarised on the fly: the distribution needs
    // the whole sample sorted, and a subnet's churn is a few thousand numbers.
    bucket.events.push(event);
    perNetuid.set(event.netuid, bucket);
  }
  return [...perNetuid.entries()]
    .map(([netuid, bucket]) => ({
      netuid,
      deregistrations: bucket.count,
      distinct_deregistered_hotkeys: bucket.hotkeys.size,
      newest_observed: bucket.newest,
      tenure: summarizeTenure(bucket.events),
    }))
    .sort(
      (a, b) => b.deregistrations - a.deregistrations || a.netuid - b.netuid,
    );
}

export interface DeregistrationNetworkRollup {
  distinct_deregistered_hotkeys: number;
  newest_observed: number | null;
  /** Network-wide slot tenure (#9742), computed over EVERY event rather than
   * averaged across per-subnet medians -- an average of medians is not a
   * median, and subnets differ by orders of magnitude in churn. */
  tenure: TenureDistribution;
}

/**
 * The network-wide rollup, computed over the events rather than summed from
 * the per-subnet rows: one hotkey evicted from three subnets is three
 * subnet-level hotkeys but ONE network-wide distinct hotkey.
 */
export function deregistrationsNetworkRollup(
  events: DerivedDeregistration[],
): DeregistrationNetworkRollup {
  const hotkeys = new Set<string>();
  let newest: number | null = null;
  for (const event of events) {
    hotkeys.add(event.hotkey);
    if (newest === null || event.observed_at > newest) {
      newest = event.observed_at;
    }
  }
  return {
    distinct_deregistered_hotkeys: hotkeys.size,
    newest_observed: newest,
    tenure: summarizeTenure(events),
  };
}

/** One `(netuid, count, first_observed, last_observed)` tuple. Positional
 * rather than an object because this index carries ~12,400 hotkeys over 30d
 * and the key names would be most of its bytes. */
export type DeregistrationHotkeyTuple = [number, number, number, number];

/**
 * Reduce derived events to a per-DISPLACED-hotkey index -- the account-scoped
 * view, keyed on the account this event happened TO rather than the account
 * that caused it. `/accounts/{ss58}/deregistrations` is exactly "the slots
 * where this hotkey was the previous holder".
 */
export function deregistrationsByHotkey(
  events: DerivedDeregistration[],
): Record<string, DeregistrationHotkeyTuple[]> {
  const perHotkey = new Map<string, Map<number, DeregistrationHotkeyTuple>>();
  for (const event of events) {
    let perNetuid = perHotkey.get(event.hotkey);
    if (!perNetuid) perHotkey.set(event.hotkey, (perNetuid = new Map()));
    const tuple = perNetuid.get(event.netuid);
    if (!tuple) {
      perNetuid.set(event.netuid, [
        event.netuid,
        1,
        event.observed_at,
        event.observed_at,
      ]);
      continue;
    }
    tuple[1] += 1;
    if (event.observed_at < tuple[2]) tuple[2] = event.observed_at;
    if (event.observed_at > tuple[3]) tuple[3] = event.observed_at;
  }
  const index: Record<string, DeregistrationHotkeyTuple[]> = {};
  for (const [hotkey, perNetuid] of perHotkey) {
    index[hotkey] = [...perNetuid.values()];
  }
  return index;
}

/** Expand one hotkey's tuples back into the `{netuid, deregistrations,
 * first_observed, last_observed}` rows buildAccountDeregistrations reads. */
export function deregistrationRowsForHotkey(
  tuples: unknown,
): Array<Record<string, unknown>> {
  if (!Array.isArray(tuples)) return [];
  const rows: Array<Record<string, unknown>> = [];
  for (const tuple of tuples) {
    if (!Array.isArray(tuple) || tuple.length < 4) continue;
    rows.push({
      netuid: tuple[0],
      deregistrations: tuple[1],
      first_observed: tuple[2],
      last_observed: tuple[3],
    });
  }
  return rows;
}
