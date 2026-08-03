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
      events.push({
        netuid: current.netuid,
        uid: current.uid,
        hotkey: previous.hotkey,
        successor: current.hotkey,
        block_number: current.block_number,
        observed_at: current.observed_at,
      });
    }
  }
  return { events, unattributed, registrations };
}

/** One per-subnet leaderboard row, in the exact shape
 * buildChainDeregistrations / buildSubnetDeregistrations read. */
export interface DeregistrationSubnetRow {
  netuid: number;
  deregistrations: number;
  distinct_deregistered_hotkeys: number;
  newest_observed: number;
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
    { count: number; hotkeys: Set<string>; newest: number }
  >();
  for (const event of events) {
    const bucket = perNetuid.get(event.netuid) ?? {
      count: 0,
      hotkeys: new Set<string>(),
      newest: 0,
    };
    bucket.count += 1;
    bucket.hotkeys.add(event.hotkey);
    if (event.observed_at > bucket.newest) bucket.newest = event.observed_at;
    perNetuid.set(event.netuid, bucket);
  }
  return [...perNetuid.entries()]
    .map(([netuid, bucket]) => ({
      netuid,
      deregistrations: bucket.count,
      distinct_deregistered_hotkeys: bucket.hotkeys.size,
      newest_observed: bucket.newest,
    }))
    .sort(
      (a, b) => b.deregistrations - a.deregistrations || a.netuid - b.netuid,
    );
}

export interface DeregistrationNetworkRollup {
  distinct_deregistered_hotkeys: number;
  newest_observed: number | null;
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
