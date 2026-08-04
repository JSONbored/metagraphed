// Cold-tier loader for every per-subnet account_events SUMMARY CARD.
//
// #9368 wired one of these (`/weights`) after finding it served a confident 0 for every
// subnet on the network. Probing the rest of the family the same way found four more
// with the identical shape — measured live 2026-08-04, chain-wide against subnet 64:
//
//   family            chain-wide                          /subnets/64/…
//   serving           3,036 servers over 20 subnets       0
//   stake-moves         674 movers  over 128 subnets      0
//   stake-transfers     430 senders / 12,168 over 126     0
//   registrations     6,317 registrants / 8,055 over 98   0
//
// Every one had the same two-tier fallback -- `tryPostgresTier(...)` then the zeroed
// card -- and `METAGRAPH_ACCOUNT_EVENTS_SOURCE` is `"retired"`, so the first tier
// declines unconditionally and the card is all that is left. A 200, no degraded marker,
// and a number that reads as "this subnet has no activity of this kind".
//
// Deliberately NOT extended to `/prometheus` and `/axon-removals`: those report 0
// per-subnet AND 0 chain-wide, because `PrometheusServed` and `AxonInfoRemoved` do not
// occur in the window at all. Their zero is the right answer, and wiring a loader there
// would have been a fix for a bug that is not there.
import { loadChainEventIdentityRollup } from "./chain-event-rollup-cold-tier.ts";
import type { ChainEventRollupSpec } from "./chain-event-rollup-cold-tier.ts";
import type { r2SqlQuery } from "./r2-sql.ts";

type Row = Record<string, unknown>;

/**
 * One subnet's window of activity for one event kind, shaped by the caller's own builder
 * — or null when the lakehouse cannot answer.
 *
 * Declines rather than returning the zeroed card, so the caller keeps its own fallback
 * and can still tell "no activity" from "could not read". That distinction is the whole
 * defect this closes: a card that cannot tell them apart reports the second as the first.
 *
 * Reads the rollup TOTALS, never the per-identity page: the page is capped by `limit`, so
 * a summary summed from it would shrink as the page did. No limit is passed at all,
 * because a summary card needs no rows.
 */
export async function loadSubnetEventCardColdTier<T>(
  env: Parameters<typeof r2SqlQuery>[0],
  spec: ChainEventRollupSpec,
  netuid: number,
  build: (row: Row | null, netuid: unknown, options: { window?: unknown }) => T,
  {
    windowLabel,
    windowDays,
    query,
  }: {
    windowLabel?: string;
    windowDays: number;
    /** Injectable for tests; forwarded to the rollup reader. */
    query?: typeof r2SqlQuery;
  },
): Promise<T | null> {
  const rollup = await loadChainEventIdentityRollup(env, spec, {
    windowDays,
    netuid,
    query,
  });
  if (!rollup) return null;
  return build(rollup.totals, netuid, { window: windowLabel });
}
