// Schema-stable empties for the six DATA_API-proxied routes (#9146).
//
// THE GAP THIS CLOSES. Every route with a `METAGRAPH_*_SOURCE` flag degrades
// to a schema-stable empty when its tier misses -- `tryPostgresTier` returns
// null and the handler builds its payload from zero rows, so a dead tier costs
// a caller freshness, never a request. These six have NO flag: they are
// forwarded straight to the DATA_API service binding, and its own comment says
// "upstream non-2xx maps to a clean error envelope". That was right while
// Postgres existed. It is not right now that it does not -- all six answered
// 502 in production, which is the one response shape the rest of this API
// never emits for a cold tier.
//
// WHY EMPTY-AND-MARKED RATHER THAN 502. A 502 tells a caller nothing except
// "retry", and retrying a decommissioned database does not help. The empty is
// paired with the same degraded marker every other tier uses
// (markPostgresTierFallbackResponse), so the response is barred from the edge
// cache and a caller reading headers can tell "no events" from "we could not
// look". Silence with a marker is honest; a 502 on a route whose data still
// exists in the lakehouse is just broken.
//
// NOT A REPLACEMENT FOR THE LAKEHOUSE PORT. `chain.chain_events` is exported
// and current (1 -> 8,759,336), so these routes CAN be served for real -- that
// is #9146's cold-tier work. This module is the floor underneath it: whatever
// a future tier cannot answer, the caller gets a contract-shaped payload
// instead of an error.
//
// Every shape here comes from the SAME builder the live path uses
// (buildSubnetOwnershipHistory / buildSubnetLeaseHistory /
// buildSubnetConviction) rather than a hand-written literal, so a field added
// to a payload cannot drift out of its degraded twin.

import {
  answerBlockDetail,
  isEmptyChainEventPayload,
  loadBlockChainEventsHotTier,
  type ChainDetailAnswer,
  type ChainEventApi,
} from "./chain-detail-hot-tier.ts";
import { buildSubnetConviction } from "./subnet-conviction.ts";
import { buildSubnetLeaseHistory } from "./subnet-lease-history.ts";
import { buildSubnetOwnershipHistory } from "./subnet-ownership-history.ts";
import { loadSubnetOwnershipHistoryColdTier } from "./subnet-ownership-cold-tier.ts";
import { loadChainEventsColdTier } from "./chain-events-cold-tier.ts";

type Row = Record<string, unknown>;

const BLOCK_CHAIN_EVENTS = /^\/api\/v1\/blocks\/(\d+)\/chain-events$/;
const SUBNET_OWNERSHIP_HISTORY =
  /^\/api\/v1\/subnets\/(\d+)\/ownership-history$/;
const SUBNET_CONVICTION = /^\/api\/v1\/subnets\/(\d+)\/conviction$/;
const SUBNET_LEASE_HISTORY = /^\/api\/v1\/subnets\/(\d+)\/lease\/history$/;

/**
 * The `blocks=` window the stats route echoes back. Read from the request so
 * the degraded payload reports the window the caller ASKED for rather than a
 * default they never sent -- `window_blocks` is the denominator of everything
 * else in that payload, and a wrong one silently rescales it.
 */
function statsWindowBlocks(url: URL): number {
  const raw = Number(url.searchParams.get("blocks"));
  return Number.isInteger(raw) && raw >= 1 && raw <= 5000 ? raw : 1000;
}

/**
 * The schema-stable empty for whichever proxied route this URL names, or null
 * when the path is not one of the six.
 *
 * Null rather than a generic fallback on purpose: a path this module does not
 * recognise must keep its existing error behaviour, so adding a seventh route
 * to the proxy without adding it here fails loudly instead of serving an empty
 * that satisfies no schema.
 */
export function degradedChainEventsPayload(url: URL): Row | null {
  const path = url.pathname;

  if (path === "/api/v1/chain-events") {
    // Mirrors the feed's own cold-store answer: no rows, and both cursor forms
    // null so a paging client stops rather than re-requesting the same page.
    return { count: 0, events: [], next_before: null, next_cursor: null };
  }

  if (path === "/api/v1/chain-events/stats") {
    return {
      head_block: null,
      window_blocks: statsWindowBlocks(url),
      groups: 0,
      activity: [],
    };
  }

  const block = BLOCK_CHAIN_EVENTS.exec(path);
  if (block) {
    return { block_number: Number(block[1]), count: 0, events: [] };
  }

  const ownership = SUBNET_OWNERSHIP_HISTORY.exec(path);
  if (ownership) {
    return buildSubnetOwnershipHistory([], Number(ownership[1]));
  }

  const lease = SUBNET_LEASE_HISTORY.exec(path);
  if (lease) {
    return buildSubnetLeaseHistory([], Number(lease[1]));
  }

  const conviction = SUBNET_CONVICTION.exec(path);
  if (conviction) {
    // No rows and no live rate reads: the leaderboard is empty and the rates
    // are null rather than 0, which would read as "measured zero".
    return buildSubnetConviction([], Number(conviction[1]), {
      unlockRate: null,
      maturityRate: null,
    });
  }

  return null;
}

/**
 * The LAKEHOUSE answer for whichever proxied route this URL names, or null
 * when no cold-tier reader covers it (or the reader itself declines).
 *
 * The floor above is what a caller gets when nothing can answer; this is the
 * step before it -- #9146's "NOT A REPLACEMENT FOR THE LAKEHOUSE PORT" note
 * made concrete for the one route whose stream already has a reader. Both
 * live in this module so the six proxied paths are matched in exactly one
 * place: a route that gains a cold tier is a branch here, not a second URL
 * table somewhere else that can silently disagree with this one.
 *
 * Callers MUST try this before degradedChainEventsPayload and must NOT mark
 * its result as a degraded fallback -- these are real, current rows, and
 * flagging them would bar them from the edge cache for no reason.
 *
 * The other five stay uncovered on purpose rather than by omission: the two
 * chain-events feeds and the block feed are unfiltered scans of the 894M-row
 * event tables (the shape #9146 moved to scheduled projections), conviction
 * additionally needs live UnlockRate/MaturityRate RPC reads that no lakehouse
 * query can stand in for, and lease/history reads account_events, a different
 * stream with no reader yet.
 */
export async function coldTierChainEventsPayload(
  env: Env | null | undefined,
  url: URL,
): Promise<Row | null> {
  const ownership = SUBNET_OWNERSHIP_HISTORY.exec(url.pathname);
  if (ownership) {
    return await loadSubnetOwnershipHistoryColdTier(env, ownership[1]);
  }
  // #9146: the all-events feed. `chain.chain_events` carries every pallet and
  // method -- 895M rows genesis-to-head -- including kinds the curated
  // account_events stream drops entirely (PrometheusServed exists only here).
  // The reader bounds each page to a block window; see its header for why an
  // unbounded port would have scanned ~2 GB per request.
  if (url.pathname === "/api/v1/chain-events") {
    const params = url.searchParams;
    return (await loadChainEventsColdTier(env, {
      limit: chainEventsLimit(params.get("limit")),
      pallet: params.get("pallet"),
      method: params.get("method"),
      block: params.get("block"),
      extrinsic: params.get("extrinsic"),
      cursor: params.get("cursor"),
      before: params.get("before"),
    })) as Row | null;
  }
  return null;
}

/** The feed's page size, clamped to the same 1-100 range data-api enforced. */
function chainEventsLimit(raw: string | null): number {
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1)
    return CHAIN_EVENTS_LIMIT_DEFAULT;
  return Math.min(parsed, CHAIN_EVENTS_LIMIT_MAX);
}

export const CHAIN_EVENTS_LIMIT_DEFAULT = 50;
export const CHAIN_EVENTS_LIMIT_MAX = 100;

export interface BlockChainEventsPayload {
  block_number: number;
  count: number;
  events: ChainEventApi[];
}

/**
 * The HOT-tier answer for `/api/v1/blocks/{n}/chain-events` (#9208), or null
 * when this URL is not that route.
 *
 * This is the one route in the six whose stream the live-follow lane feeds, and
 * it is the reason `chain_events` is in the hot tier at all: the two block
 * feeds above it are unfiltered scans, but this one is a single-block read that
 * a user reaches by clicking a block.
 *
 * THE COLD LEG IS DELIBERATELY NULL. `chain.chain_events` is exported and
 * current in the lakehouse, but nothing in this repo reads it per block yet --
 * this module's own header explains why the remaining five stayed uncovered.
 * A null cold leg gives exactly the right routing anyway: at or below the seam
 * the answer is `miss`, and the caller keeps today's schema-stable empty; above
 * the seam an uncovered block is a `gap` and DECLINES, which is the behaviour
 * #9208 requirement 4 asks for. Adding the cold reader later only turns some of
 * those misses into rows -- it does not change this shape.
 */
export async function hotTierBlockChainEvents(
  env: Env | null | undefined,
  url: URL,
): Promise<ChainDetailAnswer<BlockChainEventsPayload> | null> {
  const block = BLOCK_CHAIN_EVENTS.exec(url.pathname);
  if (!block) return null;
  return answerBlockDetail<BlockChainEventsPayload>(env, block[1]!, {
    hot: (height) => loadBlockChainEventsHotTier(env, height),
    cold: async () => null,
    isEmpty: isEmptyChainEventPayload,
  });
}

/**
 * Whether an upstream status should degrade rather than surface.
 *
 * Only the tier's own failures (5xx) and unreachability degrade. A 4xx is the
 * CALLER's error -- a bad cursor, an out-of-range limit -- and turning that
 * into an empty 200 would hide a bug in their request behind a payload that
 * looks merely uneventful.
 */
export function shouldDegrade(status: number): boolean {
  return status >= 500;
}
