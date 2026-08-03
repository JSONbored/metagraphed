// Shared subnet weight-setters loader for REST + MCP + GraphQL parity.
//
// The per-subnet counterpart to chain-weight-setters-loader.ts (#9249). That
// one fixed the chain-wide leaderboard; this route is a separate set of call
// sites and kept answering the zeroed card from the same WeightsSet stream --
// the exact "one surface wired, its sibling not" shape both loaders exist to
// close.
//
// IDENTITY IS uid, NOT hotkey, for the same reason spelled out there:
// account_events.hotkey is NULL on every WeightsSet row because the chain event
// emits [netuid, uid]. buildSubnetWeightSetters reads `hotkey` and `uid`
// independently and is null-safe on the first, so the published row carries the
// identity the event actually recorded and nothing invents a hotkey.
import { buildSubnetWeightSetters } from "./subnet-weight-setters.ts";
import {
  CHAIN_WEIGHTS_ROLLUP,
  loadChainEventIdentityRollup,
} from "./chain-event-rollup-cold-tier.ts";
import type { r2SqlQuery } from "./r2-sql.ts";

/**
 * One subnet's window of weight-setting activity per setter, already built into
 * the response shape — or null when the lakehouse cannot answer.
 *
 * Declines rather than returning the zeroed card so each caller keeps its own
 * fallback: GraphQL answers with a schema-stable card rather than an error, and
 * that decision belongs at the call site.
 */
export async function loadSubnetWeightSettersColdTier(
  env: Parameters<typeof r2SqlQuery>[0],
  netuid: number,
  {
    windowLabel,
    windowDays,
    limit,
    query,
  }: {
    windowLabel?: string;
    windowDays: number;
    limit?: number;
    /** Injectable for tests; forwarded to the rollup reader. */
    query?: typeof r2SqlQuery;
  },
): Promise<ReturnType<typeof buildSubnetWeightSetters> | null> {
  const rollup = await loadChainEventIdentityRollup(env, CHAIN_WEIGHTS_ROLLUP, {
    windowDays,
    limit,
    netuid,
    query,
  });
  if (!rollup) return null;
  // Totals ride separately from the rows: the page is capped by `limit`, so a
  // share computed against a summed page would grow as the page shrank.
  return buildSubnetWeightSetters(rollup.rows, rollup.totals, netuid, {
    window: windowLabel,
  });
}
