// Shared chain-weights loader for REST + MCP + GraphQL parity.
//
// /api/v1/chain/weights, `get_chain_weights` and GraphQL's `chain_weights` all
// answered the zeroed card: the route reads `account_events`' WeightsSet
// stream, which was Postgres-only.
//
// WHY THIS WAS BRIEFLY THOUGHT IMPOSSIBLE. `account_events.hotkey` is NULL on
// all 50,890,747 WeightsSet rows, so a distinct-hotkey count returns 0 and the
// route looked underivable. It is not: the chain event emits [netuid, uid] and
// carries no hotkey at all, so `uid` is the identity the event actually
// records. Within a subnet a uid is one neuron, which makes a distinct-uid
// count the distinct-setter count -- see CHAIN_WEIGHTS_ROLLUP's own note on the
// one case (uid reassignment after deregistration) where that is an upper
// bound rather than an identity.
//
// Same single-implementation shape as chain-serving-loader.ts: one loader, three
// callers, so a surface cannot be wired to the lakehouse while its siblings
// answer zeros.
import { ANALYTICS_WINDOWS } from "../workers/config.ts";
import { buildChainWeights } from "./chain-weights.ts";
import {
  CHAIN_WEIGHTS_ROLLUP,
  loadChainEventRollup,
} from "./chain-event-rollup-cold-tier.ts";
import type { r2SqlQuery } from "./r2-sql.ts";

/**
 * One window of weight-setting activity from the lakehouse, already built into
 * the response shape — or null when the lakehouse cannot answer.
 *
 * Returns null rather than the zeroed card so each caller keeps its own
 * fallback and error contract; GraphQL in particular answers with a
 * schema-stable card rather than an error, and that belongs at the call site.
 */
export async function loadChainWeightsColdTier(
  env: Parameters<typeof r2SqlQuery>[0],
  {
    window,
    limit,
    query,
  }: {
    window: string;
    limit?: number;
    /** Injectable for tests; forwarded to the rollup reader. */
    query?: typeof r2SqlQuery;
  },
): Promise<ReturnType<typeof buildChainWeights> | null> {
  const rollup = await loadChainEventRollup(env, CHAIN_WEIGHTS_ROLLUP, {
    windowDays: (ANALYTICS_WINDOWS as Record<string, number>)[window] ?? 7,
    limit,
    query,
  });
  if (!rollup) return null;
  return buildChainWeights(rollup.rows, {
    window,
    limit,
    networkDistinct: rollup.networkDistinct,
  } as unknown as Parameters<typeof buildChainWeights>[1]);
}
