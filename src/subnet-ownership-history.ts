// Subnet ownership-change history from the chain_events SubnetOwnerChanged
// stream (#6637, part of the conviction/ownership-contest tracker epic #4302):
// every automatic ownership transfer a subnet has undergone, emitted by the
// permissionless conviction-weighted contest documented in
// docs/conviction-lock-mechanism.md (any account can build "conviction" by
// locking alpha to a hotkey; once a challenger's conviction overtakes the
// incumbent owner's, ownership transfers automatically -- no vote required).
// Pure shaping (buildSubnetOwnershipHistory) over RAW chain_events rows --
// mirrors src/subnet-ohlc.ts's own "unaggregated rows, shaped in JS"
// convention rather than a SQL aggregate, since there's nothing to aggregate
// here (one row in, one record out). Null-safe: a subnet with no recorded
// ownership changes yields an empty list (never throws), matching the
// sibling live tiers (movers, subnet-axon-removals).

import { decodeChainEventArgs } from "./chain-event-args.ts";

type Row = Record<string, unknown>;

const EVENT_PALLET = "SubtensorModule";
export const OWNERSHIP_CHANGE_EVENT_METHOD = "SubnetOwnerChanged";

function numberOrNull(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function isoOrNull(value: unknown): string | null {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  const date = new Date(n);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

// Shapes one SubnetOwnerChanged chain_events row into a clean ownership-
// transfer record. old_coldkey/new_coldkey are already in decodeChainEventArgs'
// ACCOUNT_KEYS allowlist (added 2026-07-14 for the sibling ColdkeySwapped
// event), so both resolve to SS58 addresses, never raw hex.
function shapeOwnershipChange(row: Row): Row {
  const decoded = decodeChainEventArgs(row.args, {
    pallet: row.pallet as string,
    method: row.method as string,
  }) as Row | null;
  return {
    netuid: numberOrNull(decoded?.netuid),
    old_coldkey: decoded?.old_coldkey ?? null,
    new_coldkey: decoded?.new_coldkey ?? null,
    block_number: numberOrNull(row.block_number),
    observed_at: isoOrNull(row.observed_at),
  };
}

// `rows` are raw chain_events rows already filtered to
// pallet=SubtensorModule, method=SubnetOwnerChanged, this netuid, ordered ASC
// by block_number. Empty/absent rows -> the schema-stable empty-list shape,
// never a 404 -- a subnet that has never changed hands is the common case,
// not an error.
//
// `filterByNetuid` is the opt-in for a tier that CANNOT express the netuid
// predicate in SQL. The Postgres tier can (chain_events.args is JSONB there,
// so data-api matches COALESCE(args->'netuid'->>0, args->>'netuid')); the
// lakehouse stores the same column as an opaque JSON STRING (Iceberg has no
// JSON type), so its reader hands over the whole SubnetOwnerChanged stream and
// narrows here instead. Doing it here rather than in the caller keeps ONE
// decode of `args` for both the filter and the shaped record -- a caller-side
// filter would have to decode every row a second time, which is exactly the
// "second, subtly different decoder" this family exists to avoid.
//
// `observations` is the SECOND source, and the reason this builder has one is
// measured: the whole chain has emitted exactly ONE SubnetOwnerChanged event
// (netuid 18, block 8,724,813 -- confirmed against the 895M-row event table on
// 2026-08-03). The permissionless contest above is only one of the ways a
// subnet's owner can change, and the others leave no event of this method
// behind. The owner-observation ledger the poller writes DID see them: three
// subnets changed coldkey across consecutive observations, and only one of the
// three has an event. Serving the event stream alone therefore publishes an
// empty history for transfers that provably happened.
//
// So an observation-derived change is included, and LABELLED. `source` is not
// decoration: an event record's `observed_at` is when the chain emitted the
// transfer and carries the block that did it, while an observation record's is
// when the poller NOTICED -- a real upper bound, not the transfer time, and
// with no block to name. A caller that cannot tell those apart would read a
// capture lag as a transfer time. Deduped on the (old, new) coldkey pair,
// event first: for netuid 18 both sources describe the identical transfer (the
// decoded event's old/new coldkeys equal the ledger's consecutive owners,
// verified), and publishing it twice would read as two flips.
export function buildSubnetOwnershipHistory(
  rows: Row[] | null | undefined,
  netuid: unknown,
  {
    filterByNetuid = false,
    observations,
  }: { filterByNetuid?: boolean; observations?: Row[] | null } = {},
): Row {
  const shaped = (rows ?? []).map(shapeOwnershipChange);
  // shapeOwnershipChange already normalized netuid to a number (the raw args
  // hold it as either a scalar or a one-element array), so this compares two
  // numbers rather than re-reading the encoded form.
  const events = (
    filterByNetuid
      ? shaped.filter((change) => change.netuid === Number(netuid))
      : shaped
  ).map((change) => ({ ...change, source: OWNERSHIP_SOURCE_EVENT }));

  const changes = observations
    ? mergeOwnershipSources(events, observations, netuid)
    : events;
  const result: Row = {
    schema_version: 1,
    netuid,
    event_pallet: EVENT_PALLET,
    event_method: OWNERSHIP_CHANGE_EVENT_METHOD,
    count: changes.length,
    ownership_changes: changes,
  };
  if (observations) {
    result.observed_through = newestObservationIso(observations);
  }
  return result;
}

/** The transfer the chain announced: exact, block-stamped, authoritative. */
export const OWNERSHIP_SOURCE_EVENT = "chain-event";

/** A transfer inferred from two consecutive owner observations: real, but
 * timed by when it was NOTICED and with no block behind it. */
export const OWNERSHIP_SOURCE_OBSERVATION = "owner-observation";

/** The newest `captured_at` in the ledger slice, as ISO -- how far the
 * observation source covers this subnet at all, so a caller can tell "watched,
 * no transfer" from "not watched since". */
function newestObservationIso(observations: Row[]): string | null {
  let newest: number | null = null;
  for (const row of observations) {
    const at = Number(row?.captured_at);
    if (!Number.isFinite(at) || at <= 0) continue;
    if (newest === null || at > newest) newest = at;
  }
  return newest === null ? null : isoOrNull(newest);
}

/**
 * Ownership changes from both sources, oldest first, event records winning a
 * tie.
 *
 * `observations` are the ledger's rows for this ONE subnet, ordered ASC by
 * `captured_at`. A coldkey that differs from the previous observation's is a
 * transfer that happened between the two captures; an unchanged coldkey is
 * not, and neither is the FIRST observation of a subnet (it records when
 * tracking began, not a change of hands -- 128 subnets have exactly that one
 * row, and publishing them as transfers would invent 128 flips that never
 * occurred).
 */
function mergeOwnershipSources(
  events: Row[],
  observations: Row[],
  netuid: unknown,
): Row[] {
  const seen = new Set(
    events.map((change) => `${change.old_coldkey}|${change.new_coldkey}`),
  );
  const derived: Row[] = [];
  let previous: string | null = null;
  for (const row of observations) {
    const owner =
      typeof row?.owner_coldkey === "string" && row.owner_coldkey.length > 0
        ? row.owner_coldkey
        : null;
    if (owner === null) continue;
    if (
      previous !== null &&
      previous !== owner &&
      !seen.has(`${previous}|${owner}`)
    ) {
      derived.push({
        netuid: numberOrNull(netuid),
        old_coldkey: previous,
        new_coldkey: owner,
        block_number: null,
        observed_at: isoOrNull(row.captured_at),
        source: OWNERSHIP_SOURCE_OBSERVATION,
      });
    }
    previous = owner;
  }
  if (derived.length === 0) return events;
  // Ascending by time, the order the event stream already arrives in. A record
  // with no readable timestamp sorts last rather than to the epoch, so an
  // unstamped row cannot claim to be the oldest transfer on record.
  return [...events, ...derived].sort(
    (a, b) => sortKey(a.observed_at) - sortKey(b.observed_at),
  );
}

function sortKey(observedAt: unknown): number {
  const at = typeof observedAt === "string" ? Date.parse(observedAt) : NaN;
  return Number.isFinite(at) ? at : Number.MAX_SAFE_INTEGER;
}
