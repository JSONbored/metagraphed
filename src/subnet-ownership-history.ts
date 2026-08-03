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
export function buildSubnetOwnershipHistory(
  rows: Row[] | null | undefined,
  netuid: unknown,
  { filterByNetuid = false }: { filterByNetuid?: boolean } = {},
): Row {
  const shaped = (rows ?? []).map(shapeOwnershipChange);
  // shapeOwnershipChange already normalized netuid to a number (the raw args
  // hold it as either a scalar or a one-element array), so this compares two
  // numbers rather than re-reading the encoded form.
  const changes = filterByNetuid
    ? shaped.filter((change) => change.netuid === Number(netuid))
    : shaped;
  return {
    schema_version: 1,
    netuid,
    event_pallet: EVENT_PALLET,
    event_method: OWNERSHIP_CHANGE_EVENT_METHOD,
    count: changes.length,
    ownership_changes: changes,
  };
}
