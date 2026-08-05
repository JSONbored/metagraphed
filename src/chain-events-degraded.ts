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
import { loadBlockChainEventsColdTier } from "./events-cold-tier.ts";
import { buildSubnetConviction } from "./subnet-conviction.ts";
import { type ChainNetworkId, DEFAULT_CHAIN_NETWORK } from "./chain-network.ts";
import { buildSubnetLeaseHistory } from "./subnet-lease-history.ts";
import { buildSubnetOwnershipHistory } from "./subnet-ownership-history.ts";
import {
  loadSubnetConvictionChainTier,
  type KvLike,
} from "./subnet-lock-state.ts";
import { answerSubnetOwnershipHistory } from "./subnet-ownership-answer.ts";
import {
  type ChainEventsQuery,
  loadChainEventsColdTier,
  loadChainEventsStatsColdTier,
  loadSubnetLeaseHistoryColdTier,
} from "./chain-events-cold-tier.ts";

type Row = Record<string, unknown>;

const BLOCK_CHAIN_EVENTS = /^\/api\/v1\/blocks\/(\d+)\/chain-events$/;
/**
 * The same route, admitting the `0x` block-hash form of `{ref}`.
 *
 * The ROUTER already accepts a hash (`BLOCK_CHAIN_EVENTS_PATH_PATTERN`,
 * workers/config.ts), and so does every reader underneath -- `answerBlockDetail`
 * resolves a hash ref, and `loadBlockChainEventsColdTier` puts it through
 * `resolveBlockHeight`. Only the tier MATCHER below was numeric-only, so a
 * hash-form request routed in, matched no tier, asked no store, and fell out of
 * `handleChainEventsFamily` as a 503 `data_tier_unavailable` -- a status that
 * says "retry, this is temporary" for a request that could never succeed. That
 * is what crawlers walking `/blocks/{hash}/chain-events` kept retrying, and why
 * the sibling `/blocks/{ref}/events` served the same hash correctly all along.
 *
 * Deliberately a SECOND constant rather than a widened first: the degraded
 * builder above pairs its match with a non-nullable `block_number`, which a
 * hash cannot supply without a lookup. Keeping that one numeric means the
 * widened form is used only where a ref is actually resolved.
 */
const BLOCK_CHAIN_EVENTS_REF =
  /^\/api\/v1\/blocks\/(\d+|0x[0-9a-fA-F]{64})\/chain-events$/;
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
 * `/blocks/{n}/chain-events` is covered too, but by `hotTierBlockChainEvents`
 * below rather than here, because it is the one path with a hot tier to route
 * against first -- putting its cold leg in this function would give it two
 * entry points that could disagree about the same block.
 *
 * Conviction is covered too, but NOT from the lakehouse -- it reads live chain
 * storage (#9319, src/subnet-lock-state.ts). The note that stood here said
 * conviction "additionally needs live UnlockRate/MaturityRate RPC reads that no
 * lakehouse query can stand in for": the right observation with the wrong
 * conclusion. Since the rates have to be read live anyway, the four lock maps
 * are read in the same pass and the capture tier is skipped entirely -- no
 * subnet_locks table, no migration, no producer cron.
 *
 * Every one of the six now has a reader; nothing is left uncovered here.
 */
/**
 * A cold-tier answer and the name of the tier that produced it.
 *
 * The tier travels WITH the payload because `meta.source` exists to report
 * which store answered, and only this function knows. Deriving it at the call
 * site would mean a second copy of the path table, free to disagree -- which is
 * exactly what happened when conviction (a live CHAIN read, #9319) was reported
 * as `lakehouse-cold-tier` because that was the only label the caller had.
 */
export interface ColdTierAnswer {
  data: Row;
  source: string;
}

/** Every branch below except conviction reads the lakehouse. */
const LAKEHOUSE_TIER = "lakehouse-cold-tier";
/** Conviction reads chain storage at request time -- no captured tier exists. */
const LIVE_CHAIN_TIER = "live-chain-storage";

export async function coldTierChainEventsPayload(
  env: Env | null | undefined,
  url: URL,
  /** Which chain to read (#8700). */
  network: ChainNetworkId = DEFAULT_CHAIN_NETWORK,
): Promise<ColdTierAnswer | null> {
  const lake = (data: Row | null): ColdTierAnswer | null =>
    data ? { data, source: LAKEHOUSE_TIER } : null;
  // Branches whose reader has no network dimension yet DECLINE off mainnet
  // rather than answering from `chain.*`. Returning null sends the caller to
  // its documented empty/404; silently reading mainnet would hand back another
  // chain's history under a testnet path, which is well-formed and therefore
  // undetectable downstream.
  const mainnetOnlyBranch = network !== DEFAULT_CHAIN_NETWORK;
  const ownership = SUBNET_OWNERSHIP_HISTORY.exec(url.pathname);
  if (ownership) {
    if (mainnetOnlyBranch) return null;
    // Through the composer, not the reader: MCP and GraphQL answer this route
    // from the same function, so the path table here stays the URL matcher it
    // is rather than a second place that decides what the payload contains.
    return lake(await answerSubnetOwnershipHistory(env, ownership[1]));
  }
  // #9146: the all-events feed. `chain.chain_events` carries every pallet and
  // method -- 895M rows genesis-to-head -- including kinds the curated
  // account_events stream drops entirely (PrometheusServed exists only here).
  // The reader bounds each page to a block window; see its header for why an
  // unbounded port would have scanned ~2 GB per request.
  if (url.pathname === "/api/v1/chain-events") {
    return lake(
      (await loadChainEventsColdTier(
        env,
        chainEventsQueryFromUrl(url),
        network,
      )) as Row | null,
    );
  }
  const lease = SUBNET_LEASE_HISTORY.exec(url.pathname);
  if (lease) {
    const found = await loadSubnetLeaseHistoryColdTier(
      env,
      Number(lease[1]),
      network,
    );
    // A verified-empty history is an ANSWER; only an inconclusive read keeps
    // the marked empty below.
    return found
      ? lake(buildSubnetLeaseHistory(found.rows, Number(lease[1])) as Row)
      : null;
  }
  if (url.pathname === "/api/v1/chain-events/stats") {
    return lake(
      (await loadChainEventsStatsColdTier(
        env,
        url.searchParams.get("blocks"),
        network,
      )) as Row | null,
    );
  }
  const conviction = SUBNET_CONVICTION.exec(url.pathname);
  if (conviction) {
    if (mainnetOnlyBranch) return null;
    // The one branch that does not touch the lakehouse: it reads chain storage
    // directly, exactly as /sudo/key and the upgrade radar do -- see
    // src/subnet-lock-state.ts's header for why no captured tier is involved.
    // `env` IS used on this branch after all -- for the KV cache, not for a
    // store. The chain read itself talks to finney directly; without the cache
    // a sweep across subnets throttles the endpoint and every netuid starts
    // declining at once (#9335).
    const board = (await loadSubnetConvictionChainTier(Number(conviction[1]), {
      kv: (env?.METAGRAPH_CONTROL ?? null) as KvLike | null,
    })) as Row | null;
    return board ? { data: board, source: LIVE_CHAIN_TIER } : null;
  }
  return null;
}

/**
 * The feed query this URL names, in the reader's own shape.
 *
 * One builder, because the router validates the query and the reader executes
 * it: two copies of this extraction would let a value be rejected that the
 * reader never saw, or accepted that it cannot express.
 */
export function chainEventsQueryFromUrl(url: URL): ChainEventsQuery {
  const params = url.searchParams;
  return {
    limit: chainEventsLimit(params.get("limit")),
    pallet: params.get("pallet"),
    method: params.get("method"),
    block: params.get("block"),
    extrinsic: params.get("extrinsic"),
    cursor: params.get("cursor"),
    before: params.get("before"),
  };
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
 * The TIERED answer for `/api/v1/blocks/{n}/chain-events` (#9208, #9260), or
 * null when this URL is not that route.
 *
 * This is the one route in the six whose stream the live-follow lane feeds, and
 * it is the reason `chain_events` is in the hot tier at all: the two block
 * feeds above it are unfiltered scans, but this one is a single-block read that
 * a user reaches by clicking a block.
 *
 * THE COLD LEG USED TO BE NULL, and that was the whole of #9260. It was the
 * right call when #9208 shipped -- nothing read `chain.chain_events` per block
 * yet, and a null cold leg still routed correctly -- but the consequence was
 * that every one of the ~8.76M blocks at or below the seam answered `miss`,
 * which the caller turns into a schema-stable `events: []`. For a block that
 * really did emit 570 events, an empty 200 is a wrong answer wearing the shape
 * of a quiet one. It now reads the lakehouse, so the routing is what it always
 * claimed to be: hot above the seam, lakehouse at or below it, and a DECLINE
 * only for the genuine gap between them.
 *
 * The `tier` on the answer is not decoration -- callers use it to name the
 * source that actually served, so a lakehouse row is never labelled as the
 * hot tier's.
 */
export async function hotTierBlockChainEvents(
  env: Env | null | undefined,
  url: URL,
  /** Which chain to read (#8700). */
  network: ChainNetworkId = DEFAULT_CHAIN_NETWORK,
): Promise<ChainDetailAnswer<BlockChainEventsPayload> | null> {
  const block = BLOCK_CHAIN_EVENTS_REF.exec(url.pathname);
  if (!block) return null;
  return answerBlockDetail<BlockChainEventsPayload>(
    env,
    block[1]!,
    {
      hot: (height) => loadBlockChainEventsHotTier(env, height),
      cold: () => loadBlockChainEventsColdTier(env, block[1]!, network),
      isEmpty: isEmptyChainEventPayload,
    },
    // The tiering itself is network-aware: off mainnet there is no D1 hot leg
    // to route against, so `hot` above is never reached.
    network,
  );
}
