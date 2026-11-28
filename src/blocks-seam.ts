import { safeBlockNumber } from "./history-readers.ts";
import { type ChainNetworkId, DEFAULT_CHAIN_NETWORK } from "./chain-network.ts";
import {
  resolveDecodeWatermark,
  type DecodeWatermarkDeps,
} from "./decode-watermark.ts";
import {
  readRetainedBlockCensus,
  type RetainedBlocksEnv,
} from "./retained-blocks-d1.ts";
import { RetainedHistoryUnavailableError } from "./retained-history-store.ts";
import { registerModuleStateReset } from "./module-state-registry.ts";
import {
  CHAIN_CORE_DETAIL,
  chainCoreNetwork,
  chainViewsStore,
} from "./chain-core-read.ts";

export const RETAINED_SEAM_TTL_MS = 5_000;
type Census = Awaited<ReturnType<typeof readRetainedBlockCensus>>;
let retainedMemo = new WeakMap<
  object,
  { expiresAt: number; value: Promise<Census> }
>();
registerModuleStateReset("src/blocks-seam.ts", () => {
  retainedMemo = new WeakMap();
});

/** Share in-flight reads and briefly reuse the publication census per binding.
 * The watchdog uses its own uncached census. Nulls expire too, so a failed
 * selected owner cannot turn concurrent public requests into a retry storm. */
function retainedSeamCensus(env: unknown, deps: DecodeWatermarkDeps) {
  const selected = env as RetainedBlocksEnv | null | undefined;
  const now = (deps.now ?? Date.now)();
  const db = selected?.D1_RETAINED_BLOCKS;
  if (
    deps.fresh ||
    !db ||
    !selected?.RETAINED_BLOCKS_NETWORKS?.split(",").includes("mainnet")
  )
    return readRetainedBlockCensus(selected, "mainnet", now);
  const cached = retainedMemo.get(db);
  if (cached && cached.expiresAt > now) return cached.value;
  const value = readRetainedBlockCensus(selected, "mainnet", now);
  retainedMemo.set(db, { expiresAt: now + RETAINED_SEAM_TTL_MS, value });
  return value;
}

/** Floor for the seam, overridable per environment. NOT the seam itself any
 * more: see `resolveBlocksSeam`. */
export const BLOCKS_SEAM_ENV = "ICEBERG_BLOCKS_MAX";

/** Original contiguous export ceiling (#9161), retained as a fallback floor.
 * A selected retained owner must independently prove coverage at this height;
 * this historical measurement alone cannot establish present availability. */
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

/** A decoded commit is not a serving publication. Keep the hot bridge until
 * the selected retained copy contains the new height. An unavailable selected
 * owner cannot fall back to a watermark that would route reads into a gap. */
export function publishedBlocksSeam(
  floor: number,
  decodedThrough: number | undefined,
  retainedThrough: number | null | undefined,
): number {
  const decoded = Math.max(floor, decodedThrough ?? floor);
  if (retainedThrough === undefined) return decoded;
  if (
    retainedThrough === null ||
    !Number.isSafeInteger(retainedThrough) ||
    retainedThrough < floor
  )
    throw new RetainedHistoryUnavailableError();
  return Math.min(decoded, retainedThrough);
}

/** The configured floor: the env override when it parses, else the constant. */
export function blocksSeamFloor(env: unknown): number {
  const parsed = safeBlockNumber(bindings(env)[BLOCKS_SEAM_ENV]);
  return parsed ?? DEFAULT_BLOCKS_SEAM;
}

/** Route on the decoded height bounded by the independently published retained
 * copy. Unselected environments keep their existing watermark policy. */
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
  // The census starts inside the chain, so a synchronous throw from it is a
  // rejection Promise.all handles, never an orphaned watermark read whose own
  // rejection nothing awaits.
  const [watermark, retained] = await Promise.all([
    resolveDecodeWatermark(env, deps, network),
    Promise.resolve().then(() => retainedSeamCensus(env, deps)),
  ]);
  return publishedBlocksSeam(
    floor,
    watermark?.decodedThrough,
    retained === undefined ? undefined : (retained?.hi ?? null),
  );
}

/** The lowest block every chain-core detail family holds whole
 * (chain.coverage), or null when no chain core is bound or none holds a whole
 * window yet. */
async function chainCoreFloor(
  env: unknown,
  network: ChainNetworkId,
): Promise<number | null> {
  const store = chainViewsStore(env);
  if (!store) return null;
  const core = chainCoreNetwork(network);
  const [row] = await store.query<{ floor?: unknown }>(
    CHAIN_CORE_DETAIL.coverage,
    [core, core],
  );
  return safeBlockNumber(row?.floor);
}

/**
 * The seam a READ routes on (ADR 0029 phase 1b): `resolveBlocksSeam`, except
 * that a selected retained copy which cannot answer does not refuse what the
 * chain core holds whole.
 *
 * A retained owner with no census raises history_unavailable for every height
 * -- including the blocks the chain core holds whole, which then never reach
 * the chain core at all (measured on the fleet 2026-11-28: every block route
 * answered 503, block 9,602,100 included, with the chain core holding it).
 * The chain core's own coverage is a boundary nothing is routed past into a
 * gap: every block at or above its floor is served whole from it, and every
 * height below stays with the retained owner, whose reads still raise
 * history_unavailable for it.
 *
 * READS ONLY. Retention (src/chain-detail-prune.ts) keeps the strict seam: it
 * prunes the hot tier below the seam because the retained copy holds those
 * rows, and below the chain core's floor no retained copy does.
 */
export async function resolveReadBlocksSeam(
  env: unknown,
  deps: DecodeWatermarkDeps = {},
  network: ChainNetworkId = DEFAULT_CHAIN_NETWORK,
): Promise<number> {
  try {
    return await resolveBlocksSeam(env, deps, network);
  } catch (error) {
    if (!(error instanceof RetainedHistoryUnavailableError)) throw error;
    // A chain core that cannot say what it holds leaves the refusal standing:
    // history_unavailable is the honest answer, not the chain core's failure.
    const floor = await chainCoreFloor(env, network).catch(() => null);
    if (floor === null) throw error;
    return floor - 1;
  }
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
