// The ONE composer for /api/v1/accounts/{ss58}/entities. REST, MCP and GraphQL
// all reach the ownership half of the payload through this module and none of
// them decides the tier order itself.
//
// WHY A COMPOSER AND NOT THREE CASCADES. The lakehouse leg was wired into the
// REST handler alone. METAGRAPH_SUBNET_OWNERSHIP_SOURCE is retired, so
// tryPostgresTier declines unconditionally, and MCP and GraphQL fell straight
// to `buildAccountEntities(coldkey, { entities: [] })`: for a coldkey that HAS
// won or lost a subnet they published `ownership_ties: []`, which
// get_account_entities' own description reads as "this coldkey has never
// transferred a subnet". The community-label half is identical on all three
// surfaces, so the response looked fully populated while the on-chain half was
// silently missing.
//
// This is the same shape src/subnet-ownership-answer.ts and
// src/rpc-usage-answer.ts already fixed for their routes, and
// tests/subnet-ownership-surface-parity.test.ts enforces the rule those
// established: a surface may not import a tier reader directly, because
// "which store answers, and what an absence means" is one decision, not three.
//
// THE TIER PROBE STAYS WITH THE SURFACE, deliberately. tryPostgresTier needs a
// Request, and each surface has a different one -- REST forwards the caller's,
// MCP and GraphQL synthesize theirs. So the surface performs its own probe and
// hands the RESULT here; this module owns everything after it, which is the
// part that drifted.
//
// A DECLINE IS NOT AN EMPTY. A cold-tier null means the lakehouse could not be
// read; only after it declines does the schema-stable empty apply. Callers must
// not turn a decline into `[]` themselves -- that is the bug this module exists
// to make unrepresentable.

import { loadAccountEntitiesColdTier } from "./subnet-ownership-cold-tier.ts";
import { buildAccountEntities } from "./entity-labels.ts";

type Row = Record<string, unknown>;

export interface AnswerAccountEntitiesOptions {
  coldTier?: typeof loadAccountEntitiesColdTier;
}

/**
 * One coldkey's entity payload, with the ownership ties resolved from whichever
 * store can answer.
 *
 * `tierResult` is the surface's own tryPostgresTier outcome: a payload when the
 * tier answered, null when it declined or is retired.
 *
 * Never returns null -- the empty payload is the documented floor once every
 * store has declined, and it is applied HERE so all three surfaces reach it by
 * the same route.
 */
export async function answerAccountEntities(
  env: unknown,
  coldkey: string,
  tierResult: Row | null | undefined,
  { coldTier = loadAccountEntitiesColdTier }: AnswerAccountEntitiesOptions = {},
): Promise<Row> {
  return (
    tierResult ??
    ((await coldTier(env as never, coldkey)) as Row | null) ??
    (buildAccountEntities(coldkey, { entities: [] }) as unknown as Row)
  );
}
