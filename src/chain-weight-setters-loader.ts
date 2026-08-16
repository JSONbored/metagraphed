// Shared chain-weight-setters loader for REST + MCP + GraphQL parity.
//
// /api/v1/chain/weights/setters answered a stable zero while its sibling
// /api/v1/chain/weights served 254 distinct setters and 65,043 weight sets from
// the SAME WeightsSet stream over the same window: #9237 gave the netuid rollup
// a lakehouse reader and the setter leaderboard never got one.
//
// WHY THIS LOOKED LIKE IT NEEDED A JOIN. `account_events.hotkey` is NULL on
// every WeightsSet row, because the chain event emits [netuid, uid] and carries
// no hotkey — so a hotkey-keyed leaderboard reads as "resolve uid -> hotkey
// against the neurons table first". It is not needed:
// buildChainWeightSetters already publishes a hotkey-less row under (netuid,
// uid) identity and only reaches for `netuid` when `hotkey` is absent
// (src/chain-weight-setters.ts). The event's own identity is what gets
// published, and nothing invents a hotkey.
//
// Same single-implementation shape as chain-weights-loader.ts and
// chain-serving-loader.ts: one loader, three callers, so a surface cannot be
// wired to the lakehouse while its siblings answer zeros.
import { ANALYTICS_WINDOW_DAYS } from "../workers/config.ts";
import { buildChainWeightSetters } from "./chain-weight-setters.ts";
import {
  CHAIN_WEIGHTS_ROLLUP,
  loadChainEventIdentityRollup,
} from "./chain-event-rollup-cold-tier.ts";
import { declineChainWeightSetters } from "./chain-weight-setters.ts";
import type { R2SqlReader } from "./r2-sql.ts";

/**
 * One window of weight-setting activity per setter, already built into the
 * response shape — or null when the lakehouse cannot answer.
 *
 * Returns null rather than the zeroed card so each caller keeps its own
 * fallback and error contract; GraphQL in particular answers with a
 * schema-stable card rather than an error, and that belongs at the call site.
 */
export async function loadChainWeightSettersColdTier(
  env: Parameters<R2SqlReader>[0],
  {
    window,
    limit,
    query,
  }: {
    window: string;
    limit?: number;
    /** Injectable for tests; forwarded to the rollup reader. */
    query?: R2SqlReader;
  },
): Promise<ReturnType<typeof buildChainWeightSetters> | null> {
  const rollup = await loadChainEventIdentityRollup(env, CHAIN_WEIGHTS_ROLLUP, {
    windowDays: (ANALYTICS_WINDOW_DAYS as Record<string, number>)[window] ?? 7,
    limit,
    query,
  });
  // Only a configured lakehouse that could not answer is a decline; an `empty`
  // window and a `miss` both keep the caller's zeros. See
  // ChainEventRollupOutcome.
  if (rollup.kind === "gap") return declineChainWeightSetters(window);
  if (rollup.kind !== "answer") return null;
  // `totals` rides separately from the rows on purpose: the row page is capped
  // by `limit`, so a share computed against a summed page would grow as the
  // page shrank. The denominator has to be the window's own COUNT(*).
  return buildChainWeightSetters(rollup.rollup.rows, rollup.rollup.totals, {
    window,
    limit,
  });
}
