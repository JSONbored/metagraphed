// #8600: the row one tick writes, and the JSON-RPC it takes to get there.
//
// Pure. workers/data-api.ts owns the two HTTP round-trips and the INSERT; the
// decisions -- which calls, pinned to which height, and what the answers mean
// once combined -- live here so they are testable with a Map and no network.
//
// TWO REQUESTS PER TICK, NOT EIGHT. The height is fetched first, then all
// seven `eth_call`s go out as ONE JSON-RPC batch pinned to it. That is both
// politer to whatever endpoint is configured and the only way the reading is
// coherent: seven separate `latest` calls straddle block boundaries, and an
// index composed from two different heights is not reproducible at either.

import {
  computeTaoUsdIndex,
  type FiatPriceBasis,
  type PoolReading,
} from "./tao-usd-index.ts";
import {
  buildObservationCalls,
  decodeObservation,
  type Observation,
} from "./tao-usd-observation.ts";

/** One pool's contribution to a stored tick, or its reason for not making one. */
export interface PoolProvenance {
  address: string;
  included: boolean;
  /** Present only when the pool's price read cleanly. */
  eth_per_tao?: number;
  /** Present only when both balances read cleanly. */
  liquidity_usd?: number;
  /** Present only when the pool did not contribute. */
  reason?: string;
}

/** Exactly the columns of `tao_usd_index`. */
export interface TaoUsdIndexRow {
  block_number: number;
  observed_at: number;
  usd_per_tao: number | null;
  price_basis: FiatPriceBasis;
  eth_usd: number | null;
  pool_count: number;
  pools: PoolProvenance[];
}

/** The JSON-RPC request bodies for one tick, pinned to `blockTag`. */
export function buildObservationBatch(blockTag: string): {
  id: number;
  jsonrpc: "2.0";
  method: "eth_call";
  params: [{ to: string; data: string }, string];
}[] {
  return buildObservationCalls().map((call, index) => ({
    id: index,
    jsonrpc: "2.0" as const,
    method: "eth_call" as const,
    params: [{ to: call.to, data: call.data }, blockTag] as [
      { to: string; data: string },
      string,
    ],
  }));
}

/**
 * Map a batch response back onto call ids.
 *
 * JSON-RPC permits a batch response in any order, and permits per-entry
 * errors alongside successes. Both are handled by id: an entry carrying an
 * error contributes nothing rather than contributing its `undefined` result to
 * whichever call happened to sit at that array position.
 */
export function indexBatchResults(response: unknown): Map<string, unknown> {
  const byId = new Map<string, unknown>();
  if (!Array.isArray(response)) return byId;
  const calls = buildObservationCalls();
  for (const entry of response) {
    const id = (entry as { id?: unknown })?.id;
    if (typeof id !== "number" || !Number.isInteger(id)) continue;
    const call = calls[id];
    if (!call) continue;
    if ((entry as { error?: unknown })?.error) continue;
    byId.set(call.id, (entry as { result?: unknown })?.result);
  }
  return byId;
}

/**
 * The row for one observation at one height.
 *
 * `blockTimestampSeconds` is the Ethereum block header's own timestamp. It
 * becomes `observed_at` (in ms) rather than the wall clock, which is what
 * makes re-running a tick a genuine no-op against the primary key instead of
 * a near-duplicate the constraint cannot see.
 *
 * Returns null when the header itself is unusable — without a height and a
 * timestamp there is no row that could be written idempotently, and writing
 * one keyed on "now" would defeat the whole scheme.
 */
export function buildIndexRow(input: {
  observation: Observation;
  blockNumber: number;
  blockTimestampSeconds: number;
}): TaoUsdIndexRow | null {
  const { observation, blockNumber, blockTimestampSeconds } = input;
  if (!Number.isInteger(blockNumber) || blockNumber <= 0) return null;
  if (
    !Number.isFinite(blockTimestampSeconds) ||
    blockTimestampSeconds <= 0 ||
    !Number.isInteger(blockTimestampSeconds)
  )
    return null;

  const index = computeTaoUsdIndex({
    pools: observation.pools,
    // computeTaoUsdIndex treats a non-usable anchor as "publish nothing", so
    // null passes through as the correct refusal rather than needing a guard.
    ethUsd: observation.ethUsd as number,
  });

  const reasonByAddress = new Map(
    index.exclusions.map((exclusion) => [exclusion.address, exclusion.reason]),
  );
  const readingByAddress = new Map<string, PoolReading>(
    observation.pools.map((pool) => [pool.address, pool]),
  );

  const pools: PoolProvenance[] = [];
  // Pools that read cleanly, in the order they were read: contributors first
  // by construction, since a rejected one carries its reason instead.
  for (const pool of observation.pools) {
    const reason = reasonByAddress.get(pool.address);
    pools.push({
      address: pool.address,
      included: reason === undefined,
      eth_per_tao: pool.eth_per_tao,
      liquidity_usd: pool.liquidity_usd,
      ...(reason === undefined ? {} : { reason }),
    });
  }
  // Pools rejected before the aggregator ever saw them (unreadable price or
  // balance, below the TVL floor). They have no usable numbers to record, but
  // their absence still has to be explained.
  for (const rejected of observation.rejected) {
    if (readingByAddress.has(rejected.address)) continue;
    pools.push({
      address: rejected.address,
      included: false,
      reason: rejected.reason,
    });
  }

  return {
    block_number: blockNumber,
    observed_at: blockTimestampSeconds * 1000,
    usd_per_tao: index.usd_per_tao,
    price_basis: index.price_basis,
    eth_usd: index.eth_usd,
    pool_count: index.pool_count,
    pools,
  };
}

/** Decode a batch response straight into the row it produces. */
export function rowFromBatch(input: {
  blockNumber: number;
  blockTimestampSeconds: number;
  response: unknown;
}): TaoUsdIndexRow | null {
  const results = indexBatchResults(input.response);
  const observation = decodeObservation(results);
  return buildIndexRow({
    observation,
    blockNumber: input.blockNumber,
    blockTimestampSeconds: input.blockTimestampSeconds,
  });
}

export type { Observation };
