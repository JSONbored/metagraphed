// Subnet-lease lifecycle history (#6719, part of the subnet-leasing/
// crowdloan-tracking epic #6717): every SubnetLeaseCreated /
// SubnetLeaseTerminated event this subnet has had, decoded from the
// account_events stream #6718 started capturing. Pure shaping over RAW
// account_events rows -- mirrors src/subnet-ownership-history.mjs's own
// "one row in, one record out" convention.
//
// SubnetLeaseDividendsDistributed / Contributed / Withdrew are deliberately
// EXCLUDED here even though #6718 captures all five kinds: none of those
// three carry a netuid on their account_events row, and
// deploy/postgres/schema.sql's account_events table has no lease_id column
// to join back through either -- SubnetLeaseDividendsDistributed's own
// on-chain event is only {lease_id, contributor, alpha} (no netuid), and
// Contributed/Withdrew are Crowdloan-pallet events keyed by crowdloan_id,
// emitted before any subnet/netuid exists for the crowdloan being funded.
// A netuid-scoped history can only show the two lifecycle events that are
// actually netuid-tagged at the point they're emitted (verified against
// the pallet source, pallets/subtensor/src/subnets/leasing.rs: SubnetLease-
// Created carries {beneficiary, lease_id, netuid, end_block},
// SubnetLeaseTerminated carries {beneficiary, netuid} -- both netuid-
// tagged; SubnetLeaseDividendsDistributed carries {lease_id, contributor,
// alpha} -- no netuid).

type Row = Record<string, unknown>;

const EVENT_PALLET = "SubtensorModule";
export const SUBNET_LEASE_CREATED_KIND = "SubnetLeaseCreated";
export const SUBNET_LEASE_TERMINATED_KIND = "SubnetLeaseTerminated";

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

// account_events has no dedicated "beneficiary" column; #6718's indexer-rs
// extract() stores the lease's beneficiary account under the generic
// coldkey column for both event kinds (the semantically-closest existing
// column, matching how other event kinds repurpose the same shared columns).
function shapeLeaseEvent(row: Row): Row {
  return {
    event_kind: row.event_kind,
    beneficiary: row.coldkey ?? null,
    block_number: numberOrNull(row.block_number),
    observed_at: isoOrNull(row.observed_at),
  };
}

// `rows` are raw account_events rows already filtered to this netuid and
// event_kind IN (SubnetLeaseCreated, SubnetLeaseTerminated), ordered ASC by
// block_number. Empty/absent rows -> the schema-stable empty-list shape,
// never a 404 -- most subnets have never been leased.
export function buildSubnetLeaseHistory(
  rows: Row[] | null | undefined,
  netuid: unknown,
): Row {
  const events = (rows ?? []).map(shapeLeaseEvent);
  return {
    schema_version: 1,
    netuid,
    event_pallet: EVENT_PALLET,
    event_kinds: [SUBNET_LEASE_CREATED_KIND, SUBNET_LEASE_TERMINATED_KIND],
    count: events.length,
    lease_events: events,
  };
}
