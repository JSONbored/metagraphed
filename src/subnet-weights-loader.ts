// Shared subnet-weights loader for REST + MCP + GraphQL parity.
//
// The third instance of one shape. chain-weight-setters-loader.ts (#9249) fixed the
// chain-wide leaderboard; subnet-weight-setters-loader.ts (#9267) fixed the per-subnet
// leaderboard and its own header calls this out as "the exact 'one surface wired, its
// sibling not' shape both loaders exist to close". `/api/v1/subnets/{netuid}/weights`
// -- the summary card those leaderboards drill into -- was left unwired by both.
//
// Measured live 2026-08-04, same subnet, same window, same WeightsSet stream:
//
//   GET /api/v1/subnets/64/weights/setters  distinct_setters 14, weight_sets 2750
//   GET /api/v1/subnets/64/weights          distinct_setters  0, weight_sets    0
//
// The zeros are not a cold store. `handleSubnetWeights` had a two-tier fallback --
// Postgres, then the zeroed card -- while its sibling had three, with the cold tier in
// the middle. The Postgres box is gone, so the first tier declines and the summary card
// answered 0 for every subnet on the network, with a 200 and no degraded marker: a
// confident zero, which is the specific wrong answer this repo's null-safety convention
// exists to avoid.
//
// IDENTITY IS uid, NOT hotkey, for the reason CHAIN_WEIGHTS_ROLLUP records:
// account_events.hotkey is NULL on every WeightsSet row because the chain event emits
// [netuid, uid]. Counting distinct hotkeys here would reproduce the same zero from a
// different direction.
import { buildSubnetWeights } from "./subnet-weights.ts";
import {
  CHAIN_WEIGHTS_ROLLUP,
  loadChainEventIdentityRollup,
} from "./chain-event-rollup-cold-tier.ts";
import type { r2SqlQuery } from "./r2-sql.ts";

/**
 * One subnet's window of weight-setting activity as the summary card — or null when the
 * lakehouse cannot answer.
 *
 * Declines rather than returning the zeroed card, so each caller keeps its own fallback.
 * That is the same contract `loadSubnetWeightSettersColdTier` uses, and it is what lets
 * GraphQL answer with a schema-stable card instead of an error while REST distinguishes
 * "no activity" from "could not read".
 *
 * Reads the ROLLUP TOTALS, not the per-setter page: `totals` already carries
 * `weight_sets`, `distinct_setters` and `newest_observed` computed over the whole window
 * rather than over a capped page, so a `limit` here could not skew the summary. That is
 * also why no limit is passed -- the card needs no rows at all.
 */
export async function loadSubnetWeightsColdTier(
  env: Parameters<typeof r2SqlQuery>[0],
  netuid: number,
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
): Promise<ReturnType<typeof buildSubnetWeights> | null> {
  const rollup = await loadChainEventIdentityRollup(env, CHAIN_WEIGHTS_ROLLUP, {
    windowDays,
    netuid,
    query,
  });
  if (!rollup) return null;
  return buildSubnetWeights(rollup.totals, netuid, { window: windowLabel });
}
