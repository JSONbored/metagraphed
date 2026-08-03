// The ONE composer for /api/v1/subnets/{netuid}/ownership-history. REST, MCP
// and GraphQL all reach the payload through this module and none of them
// assembles it.
//
// WHY A COMPOSER AND NOT THREE RESHAPES. All three surfaces already called the
// same cold-tier reader -- and then each rebuilt the answer from it by hand.
// MCP's `narrowOwnershipHistory` kept four fields; GraphQL's resolver kept the
// same four, separately; REST returned the reader's payload whole. So the
// three agreed only by coincidence, and any field the reader gained reached
// exactly one of them. That is #9285 and #9296's bug seen a third time, and it
// is why `source`, `observed_through` and the observation-derived records this
// PR adds are composed once, here, rather than three times.
//
// WHAT THE ANSWER ACTUALLY CONTAINS is argued in
// src/subnet-ownership-history.ts's builder: the SubnetOwnerChanged event
// stream (one event chain-wide, measured) merged with the poller's owner-
// observation ledger (three observed coldkey transfers), deduped and labelled
// by source. This module only decides WHICH STORE ANSWERS and hands the result
// out unshaped.
//
// A DECLINE IS NOT AN EMPTY. Null here means the lakehouse could not be read,
// and every surface keeps whatever it already does with that -- REST its
// marked empty, MCP its degraded payload, GraphQL its tier error. What none of
// them may do is turn a decline into `ownership_changes: []`, which reads
// exactly like a subnet that never changed hands.

import { loadSubnetOwnershipHistoryColdTier } from "./subnet-ownership-cold-tier.ts";

type Row = Record<string, unknown>;

export interface AnswerSubnetOwnershipHistoryOptions {
  coldTier?: typeof loadSubnetOwnershipHistoryColdTier;
}

/**
 * One subnet's ownership history from the lakehouse, or null when it cannot be
 * read.
 *
 * The netuid is validated inside the reader (`safeBlockNumber`) rather than
 * here, so a surface that passes a path segment straight through gets the same
 * decline as one that parsed it first.
 */
export async function answerSubnetOwnershipHistory(
  env: Env | null | undefined,
  netuid: unknown,
  {
    coldTier = loadSubnetOwnershipHistoryColdTier,
  }: AnswerSubnetOwnershipHistoryOptions = {},
): Promise<Row | null> {
  return await coldTier(env, netuid);
}

/**
 * The payload with every contract field guaranteed present.
 *
 * TWO SURFACES NEED THIS AND FOR DIFFERENT REASONS, which is why it is one
 * function rather than two. GraphQL cannot forward a bare object -- its SDL
 * type names the fields it returns -- and MCP must not hand an agent a
 * structured result with `undefined` where a count belongs, because a tier that
 * answers 200 with a body missing them would surface as "unknown" in something
 * that then reasons over it.
 *
 * The payload is SPREAD before the defaults are applied, so a field the reader
 * gains reaches both surfaces without anyone editing them. The projection this
 * replaces listed four fields and silently dropped the rest -- the per-surface
 * drift #9296 fixed for /rpc/usage, and the reason `source` and
 * `observed_through` would otherwise have shipped to REST alone.
 */
export function subnetOwnershipHistoryNode(
  data: Row | null | undefined,
  netuid: number,
): Row {
  return {
    ...data,
    schema_version: data?.schema_version ?? 1,
    netuid,
    event_pallet: data?.event_pallet ?? null,
    event_method: data?.event_method ?? null,
    count: data?.count ?? 0,
    ownership_changes: Array.isArray(data?.ownership_changes)
      ? data.ownership_changes
      : [],
    observed_through: data?.observed_through ?? null,
  };
}
