// Shared chain-prometheus loader for REST + MCP + GraphQL parity.
//
// THE RUNG THAT WAS MISSING (#10248). Both prometheus and its axon twin resolve
// their data the same way -- `tryPostgresTier(METAGRAPH_ACCOUNT_EVENTS_SOURCE)`
// first -- and that flag reads "retired", so the call can never forward (#10190
// counts eight such flags). `/chain/serving` survives that because it has a
// SECOND rung, `loadChainServingColdTier`, which reads the lakehouse rollup.
// Prometheus had no second rung at all: it fell straight from a tier that
// always misses to the empty stub, and published a confident zero.
//
// So the route was never "waiting for curation" in the sense its degraded
// marker implied. Even with a fully curated stream it had nothing to read from.
//
// Mirrors src/chain-serving-loader.ts deliberately, down to resolving BOTH the
// window and the limit once here: the rollup reader caps at 200 and the builder
// at 20, so an omitted limit otherwise scans ten times the rows the response
// can carry -- the exact defect #9239 fixed on the serving side.
//
// Returns null rather than a zeroed card so each caller keeps its own fallback
// and error contract.
import {
  ANALYTICS_WINDOW_DAYS,
  DEFAULT_ANALYTICS_WINDOW,
} from "../workers/config.ts";
import {
  buildChainPrometheus,
  CHAIN_PROMETHEUS_LIMIT_DEFAULT,
} from "./chain-prometheus.ts";
import {
  CHAIN_PROMETHEUS_ROLLUP,
  loadChainEventRollup,
} from "./chain-event-rollup-cold-tier.ts";
import type { r2SqlQuery } from "./r2-sql.ts";

/**
 * One window of prometheus-serving activity from the lakehouse, already built
 * into the response shape -- or null when the lakehouse cannot answer.
 */
export async function loadChainPrometheusColdTier(
  env: Parameters<typeof r2SqlQuery>[0],
  {
    window,
    limit,
    query,
  }: {
    window: string;
    /** Optional so callers that leave it to the builder's own default do not
     * have to restate it here. */
    limit?: number;
    /** Injectable for tests; forwarded to the rollup reader. */
    query?: typeof r2SqlQuery;
  },
): Promise<ReturnType<typeof buildChainPrometheus> | null> {
  const label = Object.hasOwn(ANALYTICS_WINDOW_DAYS, window)
    ? window
    : DEFAULT_ANALYTICS_WINDOW;
  const rowLimit = limit ?? CHAIN_PROMETHEUS_LIMIT_DEFAULT;
  const rollup = await loadChainEventRollup(env, CHAIN_PROMETHEUS_ROLLUP, {
    windowDays: ANALYTICS_WINDOW_DAYS[label],
    limit: rowLimit,
    query,
  });
  if (!rollup) return null;
  return buildChainPrometheus(rollup.rows, {
    window: label,
    limit: rowLimit,
    networkDistinct: rollup.networkDistinct,
    subnetCount: rollup.subnetCount,
  });
}
