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
import { parquetReadBudget, r2ParquetSource } from "./indexed-parquet.ts";
import { registerModuleStateReset } from "./module-state-registry.ts";

type Bucket = Pick<R2Bucket, "get">;
interface HistoryEnv {
  METAGRAPH_ARCHIVE?: Bucket;
}
let selections = new WeakMap<
  Bucket,
  Map<string, { expires: number; value: Promise<HistorySelection | undefined> }>
>();
registerModuleStateReset("src/indexed-history-store.ts", () => {
  selections = new WeakMap();
});
const TTL_MS = 60_000;

async function selection(
  bucket: Bucket,
  table: ChainFirehoseTopic,
  network: ChainNetworkId,
): Promise<HistorySelection | undefined> {
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
    const root = `metagraph/indexed-history/v1/${network}/${table}/generations/${selected.generation}`;
    if (
      selected.network !== network ||
      selected.table !== table ||
      selected.firstBlock > selected.lastBlock ||
      selected.blockManifest.key !== `${root}/block-manifest.json` ||
      (selected.hashManifest &&
        selected.hashManifest.key !== `${root}/manifest.json`)
    )
      throw new Error("History selection scope mismatch");
    return selected;
  })();
  entries.set(key, { expires: Date.now() + TTL_MS, value });
  return value;
}

/** Match the existing catalog row boundary without rounding wide integers.
 * Declared numeric columns are checked by the caller's catalog schema. */
function catalogRow(row: Record<string, unknown>): Record<string, unknown> {
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
): Promise<Record<string, unknown>[] | null | undefined> {
  const bucket = (env as HistoryEnv | null)?.METAGRAPH_ARCHIVE;
  if (!bucket) return undefined;
  try {
    const selected = await selection(bucket, table, network);
    if (!selected || block < selected.firstBlock || block > selected.lastBlock)
      return undefined;
    const source = r2ParquetSource(bucket),
      budget = parquetReadBudget();
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
    return null;
  }
}

/** A missing hash in a base does not prove absence from newer segments. Keep
 * that distinction until incremental coverage and the hot bridge are selected. */
export async function readSelectedHistoryHash(
  env: unknown,
  table: "blocks" | "extrinsics",
  hash: string,
  network: ChainNetworkId = DEFAULT_CHAIN_NETWORK,
): Promise<Record<string, unknown> | null | undefined> {
  const bucket = (env as HistoryEnv | null)?.METAGRAPH_ARCHIVE;
  if (!bucket) return undefined;
  try {
    const selected = await selection(bucket, table, network);
    if (!selected?.hashManifest) return undefined;
    const source = r2ParquetSource(bucket),
      budget = parquetReadBudget();
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
    if (!row) return undefined;
    const normalized = catalogRow(row),
      block = Number(normalized.block_number);
    if (block < selected.firstBlock || block > selected.lastBlock)
      return undefined;
    return normalized;
  } catch {
    return null;
  }
}
