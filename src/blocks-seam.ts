import { safeBlockNumber } from "./history-readers.ts";
import { type ChainNetworkId, DEFAULT_CHAIN_NETWORK } from "./chain-network.ts";
import {
  resolveDecodeWatermark,
  type DecodeWatermarkDeps,
} from "./decode-watermark.ts";

/** Floor for the seam, overridable per environment. NOT the seam itself any
 * more: see `resolveBlocksSeam`. */
export const BLOCKS_SEAM_ENV = "ICEBERG_BLOCKS_MAX";

/**
 * The seam FLOOR: history the lakehouse is known to hold regardless of what
 * the decode lane has published since.
 *
 * Measured 2026-08-02 against the live lakehouse (#9161): `min=0,
 * max=8,759,336, count=8,759,337` -- `count == max - min + 1`, so the range is
 * contiguous with no gaps and no duplicates. It is the height of the final
 * export plus the delta loads that followed, and it is the same number the
 * decoder's own `iceberg_r2.py seam` uses when its ledger is empty.
 *
 * As a CEILING this number went stale twice, both times invisibly, because
 * nothing re-measured it between deploys. As a floor it cannot: the published
 * watermark only raises the seam, so a constant that lags reality costs
 * nothing the moment the decoder publishes, and a constant that is somehow
 * ahead of the lakehouse still bounds the damage to the range it always did.
 */
export const DEFAULT_BLOCKS_SEAM = 8_759_336;

/** The one binding this module still reads directly, independent of the full
 * Env shape so the module stays testable with a plain object. The store behind
 * the SQL comes from readStore now (#10148), not from a binding read here. */
interface ColdTierBindings {
  ICEBERG_BLOCKS_MAX?: unknown;
}

function bindings(env: unknown): ColdTierBindings {
  return (env ?? {}) as ColdTierBindings;
}

/** The configured floor: the env override when it parses, else the constant. */
export function blocksSeamFloor(env: unknown): number {
  const parsed = safeBlockNumber(bindings(env)[BLOCKS_SEAM_ENV]);
  return parsed ?? DEFAULT_BLOCKS_SEAM;
}

/**
 * The seam this request routes on: the published decode watermark when it is
 * ahead of the configured floor, the floor otherwise.
 *
 * `Math.max` is the whole fail-safe. A missing, unreadable, malformed or
 * REGRESSED watermark cannot lower the seam, so the worst case is the
 * behaviour this module had before the watermark existed. A watermark that is
 * ahead is trusted because the decoder writes its ledger property in the SAME
 * Iceberg commit as the rows -- there is no window in which it can claim a
 * height whose data is not yet visible -- and because it is the `min` across
 * all four decoded tables, so it never runs ahead of the slowest one.
 */
export async function resolveBlocksSeam(
  env: unknown,
  deps: DecodeWatermarkDeps = {},
  network: ChainNetworkId = DEFAULT_CHAIN_NETWORK,
): Promise<number> {
  // Off mainnet the seam is not a boundary between two sources -- there is only
  // one. `blocks_head` and the whole hot tier are written by the mainnet
  // firehose poller and carry no network column, so a non-mainnet request has
  // no hot rows to reach and every block must come from the lakehouse. Zero
  // says exactly that: nothing is above the seam.
  if (network !== DEFAULT_CHAIN_NETWORK) return 0;
  const floor = blocksSeamFloor(env);
  const watermark = await resolveDecodeWatermark(env, deps, network);
  return Math.max(floor, watermark?.decodedThrough ?? floor);
}

/**
 * The newest block this network's lakehouse can answer for, or null when that
 * is not knowable.
 *
 * NOT the seam, and the distinction is the whole reason this exists.
 * `resolveBlocksSeam` answers "where do the two block sources MEET", so off
 * mainnet it is 0 -- there is one source and nothing sits above it. A reader
 * with no hot leg at all needs the opposite fact: how far UP that single source
 * reaches.
 *
 * The chain-events feed and its stats aggregate are exactly those readers, and
 * both anchored on `blocksSeamFloor` -- a CONSTANT. So the all-events feed's
 * newest event stayed pinned at block 8,759,336 while the decoder appended
 * 7,200 blocks a day past it (11,746 blocks stale when measured, 2026-08-04),
 * and `/chain-events/stats`, documented as "the most recent N blocks",
 * aggregated a fixed window receding further into history every day. The same
 * anchor would have put testnet at 0.
 *
 * Mainnet keeps the configured floor as a FAIL-SAFE MINIMUM, the same guarantee
 * `resolveBlocksSeam` makes: a missing, unreadable or regressed watermark
 * cannot pull the ceiling below history the lakehouse is known to hold. Off
 * mainnet there is no such floor to fall back on -- `ICEBERG_BLOCKS_MAX` is
 * mainnet's own exodus boundary and means nothing on another chain -- so an
 * unreadable watermark yields null and the caller declines rather than picking
 * a window it cannot justify.
 */
export async function lakehouseHeadBlock(
  env: unknown,
  deps: DecodeWatermarkDeps = {},
  network: ChainNetworkId = DEFAULT_CHAIN_NETWORK,
): Promise<number | null> {
  const watermark = await resolveDecodeWatermark(env, deps, network);
  const decodedThrough = watermark?.decodedThrough ?? null;
  if (network !== DEFAULT_CHAIN_NETWORK) return decodedThrough;
  return Math.max(blocksSeamFloor(env), decodedThrough ?? 0);
}
