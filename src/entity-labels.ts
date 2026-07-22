// Community-contributable entity labels (#6737-#6740): pure shaping over the
// baked entities.json artifact (registry/entities/<ss58>.json, one file per
// address) plus a reverse join against the SAME chain_events SubnetOwnerChanged
// stream src/subnet-ownership-history.mjs already shapes per-subnet -- this
// module pivots that stream by coldkey instead of by netuid. No new capture:
// both inputs (the entity registry, the chain_events stream) already exist.
//
// Honest scope note (mirrors buildSubnetOwnershipHistory's own limitation):
// SubnetOwnerChanged only fires on an AUTOMATIC conviction-contest transfer
// (docs/conviction-lock-mechanism.md) -- it says nothing about who a subnet's
// original/genesis owner was if it has never changed hands. A coldkey that has
// held a subnet since registration and never lost it to a challenger will not
// appear in ownership_ties at all. This is a real data-source gap, not a bug.

import { decodeChainEventArgs } from "./chain-event-args.ts";

export const ENTITY_LABELS_ARTIFACT = "/metagraph/entities.json";

// entities: the entities.json artifact's `entities` array (or any array of
// entity records). Keyed by ss58 -- the registry's own one-file-per-address
// invariant means this is never a genuine collision, just last-write-wins
// defensively.
export function entityLabelsIndex(
  entities: Array<Record<string, unknown>> | null | undefined,
): Map<string, Record<string, unknown>> {
  const bySs58 = new Map<string, Record<string, unknown>>();
  for (const entity of entities ?? []) {
    if (typeof entity?.ss58 === "string" && entity.ss58) {
      bySs58.set(entity.ss58, entity);
    }
  }
  return bySs58;
}

export interface EntityLabel {
  name: unknown;
  category: unknown;
  notes: unknown;
  source_urls: unknown[];
}

// Public label shape for a given address -- omits `review`/internal
// governance fields (those are curation metadata, not a user-facing claim).
// Always an array (0 or 1 entries today; array-shaped so a future multi-label
// address doesn't need a breaking response-shape change).
export function labelsForSs58(
  index: Map<string, Record<string, unknown>>,
  ss58: string,
): EntityLabel[] {
  const entity = index.get(ss58);
  if (!entity) return [];
  return [
    {
      name: entity.name ?? null,
      category: entity.category ?? null,
      notes: entity.notes ?? null,
      source_urls: Array.isArray(entity.source_urls) ? entity.source_urls : [],
    },
  ];
}

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

interface OwnershipChangeRow {
  netuid: number | null;
  old_coldkey: unknown;
  new_coldkey: unknown;
  block_number: number | null;
  observed_at: string | null;
}

// One SubnetOwnerChanged chain_events row -> { netuid, old_coldkey,
// new_coldkey, block_number, observed_at }, decoded exactly like
// subnet-ownership-history.mjs's own shapeOwnershipChange.
function decodeOwnershipChangeRow(
  row: Record<string, unknown>,
): OwnershipChangeRow {
  const decoded = decodeChainEventArgs(row.args, {
    pallet: row.pallet as string,
    method: row.method as string,
  }) as Record<string, unknown> | null | undefined;
  return {
    netuid: numberOrNull(decoded?.netuid),
    old_coldkey: decoded?.old_coldkey ?? null,
    new_coldkey: decoded?.new_coldkey ?? null,
    block_number: numberOrNull(row.block_number),
    observed_at: isoOrNull(row.observed_at),
  };
}

export interface OwnershipTie {
  netuid: number | null;
  role: "gained_ownership" | "lost_ownership";
  block_number: number | null;
  observed_at: string | null;
}

export interface AccountEntitiesResult {
  schema_version: 1;
  ss58: string;
  labels: EntityLabel[];
  ownership_tie_count: number;
  ownership_ties: OwnershipTie[];
}

// #6740: one coldkey's entity labels plus every subnet-ownership tie it has
// via the SubnetOwnerChanged stream (either side of the transfer), newest
// first. `ownershipRows` are the RAW, unfiltered chain_events rows (pallet=
// SubtensorModule, method=SubnetOwnerChanged, ANY netuid) -- filtering by
// coldkey happens here, in JS, after decoding, since the raw args column
// stores hex pubkeys and only decodeChainEventArgs knows how to resolve them
// to ss58 (a SQL-side equality filter would need the reverse ss58->hex
// encoding, which this module deliberately does not attempt).
export function buildAccountEntities(
  ss58: string,
  {
    entities,
    ownershipRows,
  }: {
    entities?: Array<Record<string, unknown>> | null;
    ownershipRows?: Array<Record<string, unknown>> | null;
  } = {},
): AccountEntitiesResult {
  const labels = labelsForSs58(entityLabelsIndex(entities), ss58);
  const ownershipTies: OwnershipTie[] = (ownershipRows ?? [])
    .map(decodeOwnershipChangeRow)
    .filter(
      (change) => change.old_coldkey === ss58 || change.new_coldkey === ss58,
    )
    .map((change) => ({
      netuid: change.netuid,
      role: (change.new_coldkey === ss58
        ? "gained_ownership"
        : "lost_ownership") as "gained_ownership" | "lost_ownership",
      block_number: change.block_number,
      observed_at: change.observed_at,
    }))
    .sort((a, b) => (b.block_number ?? 0) - (a.block_number ?? 0));

  return {
    schema_version: 1,
    ss58,
    labels,
    ownership_tie_count: ownershipTies.length,
    ownership_ties: ownershipTies,
  };
}
