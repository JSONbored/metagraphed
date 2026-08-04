// The ONE composer for the two SubnetIdentitiesV3 timelines --
// /api/v1/subnets/{netuid}/identity-history and /api/v1/chain/identity-history.
// REST, MCP and GraphQL all reach both payloads through this module.
//
// WHY A COMPOSER AND NOT SIX CASCADES. #9153 added the lakehouse leg to
// workers/request-handlers/entities.ts alone. METAGRAPH_SUBNET_IDENTITY_SOURCE
// is retired, so tryPostgresTier declines unconditionally and the other two
// surfaces fell straight to the empty builder: REST served the frozen verified
// timeline while get_subnet_identity_history / get_chain_identity_history and
// their GraphQL twins reported entry_count 0 and count 0.
//
// get_chain_identity_history's own comment claimed this tool and the REST route
// "never diverge on which tier answered". That sentence was false the moment the
// cold tier landed on one surface only; this module is what makes it true again,
// by leaving no per-surface copy that CAN diverge.
//
// Same shape src/subnet-ownership-answer.ts and src/rpc-usage-answer.ts already
// established, and the rule tests/subnet-ownership-surface-parity.test.ts
// enforces: a surface may not import a tier reader directly.
//
// THE TIER PROBE STAYS WITH THE SURFACE -- tryPostgresTier needs a Request and
// each surface builds its own. The surface probes and hands the RESULT here.
//
// A DECLINE IS NOT AN EMPTY: the schema-stable empty timeline applies only
// after every store has declined, and it is applied here so no surface can
// reach it early.

import {
  loadChainIdentityHistoryColdTier,
  loadSubnetIdentityHistoryColdTier,
} from "./subnet-identity-cold-tier.ts";
import { buildSubnetIdentityHistory } from "./subnet-identity-history.ts";
import { buildChainIdentityHistory } from "./chain-identity-history.ts";

type Row = Record<string, unknown>;

export interface AnswerSubnetIdentityHistoryOptions {
  coldTier?: typeof loadSubnetIdentityHistoryColdTier;
}

export interface AnswerChainIdentityHistoryOptions {
  coldTier?: typeof loadChainIdentityHistoryColdTier;
}

/** One subnet's identity timeline from whichever store can answer. */
export async function answerSubnetIdentityHistory(
  env: unknown,
  netuid: number,
  tierResult: Row | null | undefined,
  query: { limit: number; offset?: number | null; cursor?: unknown },
  {
    coldTier = loadSubnetIdentityHistoryColdTier,
  }: AnswerSubnetIdentityHistoryOptions = {},
): Promise<Row> {
  return (
    tierResult ??
    ((await coldTier(env as never, netuid, {
      limit: query.limit,
      offset: query.offset ?? null,
      cursor: query.cursor ?? null,
    })) as Row | null) ??
    (buildSubnetIdentityHistory([], netuid, {
      limit: query.limit,
      offset: query.offset ?? null,
      nextCursor: null,
    }) as unknown as Row)
  );
}

/** The network-wide identity feed from whichever store can answer. */
export async function answerChainIdentityHistory(
  env: unknown,
  tierResult: Row | null | undefined,
  query: { limit?: unknown } = {},
  {
    coldTier = loadChainIdentityHistoryColdTier,
  }: AnswerChainIdentityHistoryOptions = {},
): Promise<Row> {
  return (
    tierResult ??
    ((await coldTier(env as never, { limit: query.limit })) as Row | null) ??
    (buildChainIdentityHistory([], {
      limit: query.limit,
    }) as unknown as Row)
  );
}
