import {
  HistorySelectionSchema,
  type HistorySelection,
} from "../schemas-src/artifacts/history-selection.ts";
import { type ChainNetworkId, DEFAULT_CHAIN_NETWORK } from "./chain-network.ts";
import type { ChainFirehoseTopic } from "./chain-firehose-topics.ts";
import {
  loadHistoryBlockGeneration,
  loadHistoryGeneration,
  readHistoryBlock,
  readHistoryHash,
} from "./history-generation.ts";
import {
  parquetReadBudget,
  r2ParquetSource,
  type ParquetReadBudget,
} from "./indexed-parquet.ts";
import { registerModuleStateReset } from "./module-state-registry.ts";
import { recordIndexedHistoryFailure } from "./indexed-history-status.ts";
import { historyHashAbsentFromHotBridge } from "./history-hash-hot-bridge.ts";
import { TESTNET_RAW_CAPTURE_GENESIS_FLOOR } from "./raw-capture-floors.ts";

type Bucket = Pick<R2Bucket, "get">;
interface HistoryEnv {
  METAGRAPH_ARCHIVE?: Bucket;
}
type Segment = Omit<Extract<HistorySelection, { version: 1 }>, "version">;
let selections = new WeakMap<
  Bucket,
  Map<string, { expires: number; value: Promise<Segment[] | undefined> }>
>();
registerModuleStateReset("src/indexed-history-store.ts", () => {
  selections = new WeakMap();
});
const TTL_MS = 60_000;

/** Share the validated immutable selection with small generation summaries. */
export async function readSelectedHistorySegments(
  env: unknown,
  table: ChainFirehoseTopic,
  network: ChainNetworkId = DEFAULT_CHAIN_NETWORK,
): Promise<Segment[] | undefined> {
  const bucket = (env as HistoryEnv | null)?.METAGRAPH_ARCHIVE;
  return bucket ? selection(bucket, table, network) : undefined;
}

async function selection(
  bucket: Bucket,
  table: ChainFirehoseTopic,
  network: ChainNetworkId,
): Promise<Segment[] | undefined> {
  const key = `metagraph/indexed-history/v1/${network}/${table}/current.json`;
  let entries = selections.get(bucket);
  if (!entries) {
    entries = new Map();
    selections.set(bucket, entries);
  }
  const prior = entries.get(key);
  if (prior && prior.expires > Date.now()) return prior.value;
  const value = (async () => {
    const object = await bucket.get(key);
    if (!object) return undefined;
    if (object.size > 16 * 1024)
      throw new Error("History selection exceeds size budget");
    const selected = HistorySelectionSchema.parse(await object.json());
    if (selected.network !== network || selected.table !== table)
      throw new Error("History selection scope mismatch");
    const segments = selected.version === 1 ? [selected] : selected.segments;
    const seen = new Set<string>();
    for (const [index, segment] of segments.entries()) {
      const root = `metagraph/indexed-history/v1/${network}/${table}/generations/${segment.generation}`;
      if (
        segment.network !== network ||
        segment.table !== table ||
        segment.firstBlock > segment.lastBlock ||
        (index > 0 &&
          segment.firstBlock !== segments[index - 1].lastBlock + 1) ||
        seen.has(segment.generation) ||
        segment.blockManifest.key !== `${root}/block-manifest.json` ||
        (segment.hashManifest &&
          segment.hashManifest.key !== `${root}/manifest.json`)
      )
        throw new Error("History segment scope or coverage mismatch");
      seen.add(segment.generation);
    }
    return segments;
  })();
  entries.set(key, { expires: Date.now() + TTL_MS, value });
  return value;
}

/** Match the existing catalog row boundary without rounding wide integers.
 * Declared numeric columns are checked by the caller's catalog schema. */
export function catalogRow(
  row: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [
      key,
      typeof value === "bigint"
        ? value >= BigInt(Number.MIN_SAFE_INTEGER) &&
          value <= BigInt(Number.MAX_SAFE_INTEGER)
          ? Number(value)
          : value.toString()
        : value,
    ]),
  );
}

/** undefined means unselected/outside pinned coverage; null means an indexed
 * operation failed and MUST NOT trigger a paid scan. [] proves snapshot absence. */
export async function readSelectedHistoryBlock(
  env: unknown,
  table: ChainFirehoseTopic,
  block: number,
  network: ChainNetworkId = DEFAULT_CHAIN_NETWORK,
  budget: ParquetReadBudget = parquetReadBudget(),
): Promise<Record<string, unknown>[] | null | undefined> {
  const bucket = (env as HistoryEnv | null)?.METAGRAPH_ARCHIVE;
  if (!bucket) return undefined;
  try {
    const segments = await selection(bucket, table, network);
    const selected = segments?.find(
      (segment) => block >= segment.firstBlock && block <= segment.lastBlock,
    );
    if (!selected) return undefined;
    const source = r2ParquetSource(bucket);
    const generation = await loadHistoryBlockGeneration(
      source,
      selected.blockManifest,
      selected,
      budget,
    );
    return (
      await readHistoryBlock(source, generation, selected, block, budget)
    ).map(catalogRow);
  } catch {
    recordIndexedHistoryFailure();
    return null;
  }
}

/** Search newest segments first without resetting the operation's budget.
 * [] proves absence only with every historical hash index and a qualified hot
 * bridge. undefined keeps the migration fallback outside that coverage. */
export async function readSelectedHistoryHash(
  env: unknown,
  table: "blocks" | "extrinsics",
  hash: string,
  network: ChainNetworkId = DEFAULT_CHAIN_NETWORK,
  budget: ParquetReadBudget = parquetReadBudget(),
): Promise<Record<string, unknown> | [] | null | undefined> {
  const bucket = (env as HistoryEnv | null)?.METAGRAPH_ARCHIVE;
  if (!bucket) return undefined;
  try {
    const segments = await selection(bucket, table, network);
    if (!segments) return undefined;
    const source = r2ParquetSource(bucket);
    for (const selected of [...segments].reverse()) {
      if (!selected.hashManifest) continue;
      const generation = await loadHistoryGeneration(
        source,
        selected.hashManifest,
        selected,
        budget,
      );
      const row = await readHistoryHash(
        source,
        generation,
        selected,
        hash,
        budget,
      );
      if (!row) continue;
      const normalized = catalogRow(row),
        block = normalized.block_number;
      if (typeof block !== "number" || !Number.isSafeInteger(block))
        throw new Error("History hash row has an invalid block number");
      if (block >= selected.firstBlock && block <= selected.lastBlock)
        return normalized;
    }
    if (
      segments[0].firstBlock <=
        (network === "mainnet" ? 0 : TESTNET_RAW_CAPTURE_GENESIS_FLOOR) &&
      segments.every((segment) => segment.hashManifest) &&
      (await historyHashAbsentFromHotBridge(
        env,
        table,
        hash,
        segments[segments.length - 1].lastBlock,
        network,
      ))
    )
      return [];
    return undefined;
  } catch {
    recordIndexedHistoryFailure();
    return null;
  }
}
