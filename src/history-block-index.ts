import {
  HistoryBlockIndexSchema,
  type HistoryBlockIndex,
} from "../schemas-src/artifacts/history-block-index.ts";
import {
  boundedParquetBuffer,
  type ParquetRangeSource,
  type ParquetReadBudget,
} from "./indexed-parquet.ts";

type Scope = Pick<HistoryBlockIndex, "generation" | "network" | "table"> & {
  fileRows: readonly number[];
};
export interface HistoryBlockRun {
  fileId: number;
  rowStart: number;
  rows: number;
  observedAt: number;
}
const RECORD_BYTES = 24;
const PAGE_RUNS = 1024;

/** Missing shards only establish absence after the complete source row census
 * and every shard's scope have been validated. Publication verifies sorting. */
export function validateHistoryBlockIndex(
  input: unknown,
  scope: Scope,
): HistoryBlockIndex {
  const index = HistoryBlockIndexSchema.parse(input);
  if (
    index.generation !== scope.generation ||
    index.network !== scope.network ||
    index.table !== scope.table
  )
    throw new Error("History block index scope mismatch");
  let sourceRows = 0;
  for (const rows of scope.fileRows) {
    if (!Number.isSafeInteger(rows) || rows < 1 || rows > 0xffffffff)
      throw new Error("History block source row count invalid");
    sourceRows += rows;
  }
  let rows = 0,
    runs = 0,
    previous = -1;
  for (const shard of index.shards) {
    const prefix = parseInt(shard.prefix, 16);
    if (
      shard.generation !== scope.generation ||
      shard.network !== scope.network ||
      shard.table !== scope.table ||
      shard.key !==
        `metagraph/indexed-history/v1/${scope.network}/${scope.table}/generations/${scope.generation}/blocks/${shard.prefix}.bin` ||
      prefix <= previous ||
      shard.firstBlock > shard.lastBlock ||
      shard.firstBlock >>> 16 !== prefix ||
      shard.lastBlock >>> 16 !== prefix ||
      shard.bytes !== shard.runs * RECORD_BYTES ||
      shard.rows < shard.runs
    )
      throw new Error("History block shard scope or census mismatch");
    rows += shard.rows;
    runs += shard.runs;
    previous = prefix;
  }
  if (
    sourceRows !== index.rows ||
    rows !== sourceRows ||
    runs !== index.runs ||
    !Number.isSafeInteger(sourceRows)
  )
    throw new Error("History block index is incomplete");
  return index;
}

/** Locate all physical runs for one logical block, retaining repeated captures.
 * The caller must verify decoded block numbers and apply its existing logical
 * deduplication rules. A bounded failure never becomes a partial success. */
export async function findHistoryBlockRuns(
  source: ParquetRangeSource,
  input: unknown,
  scope: Scope,
  block: number,
  budget: ParquetReadBudget,
): Promise<HistoryBlockRun[]> {
  const index = validateHistoryBlockIndex(input, scope);
  if (!Number.isInteger(block) || block < 0 || block > 0xffffffff)
    throw new Error("Invalid history block number");
  const prefix = (block >>> 16).toString(16).padStart(4, "0");
  const shard = index.shards.find((item) => item.prefix === prefix);
  if (!shard || block < shard.firstBlock || block > shard.lastBlock) return [];
  const file = boundedParquetBuffer(source, shard, budget);
  const pages = new Map<number, Promise<ArrayBuffer>>();
  const record = async (run: number) => {
    const page = Math.floor(run / PAGE_RUNS);
    let bytes = pages.get(page);
    if (!bytes) {
      const start = page * PAGE_RUNS * RECORD_BYTES;
      bytes = Promise.resolve(
        file.slice(
          start,
          Math.min(start + PAGE_RUNS * RECORD_BYTES, shard.bytes),
        ),
      );
      pages.set(page, bytes);
    }
    const view = new DataView(
      await bytes,
      (run % PAGE_RUNS) * RECORD_BYTES,
      RECORD_BYTES,
    );
    const key = view.getUint32(0, true);
    if (
      key >>> 16 !== parseInt(prefix, 16) ||
      key < shard.firstBlock ||
      key > shard.lastBlock
    )
      throw new Error("History block shard contains a foreign block");
    return { key, view };
  };
  let low = 0,
    high = shard.runs;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if ((await record(mid)).key < block) low = mid + 1;
    else high = mid;
  }
  const found: HistoryBlockRun[] = [];
  let rows = 0;
  for (let run = low; run < shard.runs; run++) {
    const { key, view } = await record(run);
    if (key !== block) break;
    const fileId = view.getUint32(4, true),
      rowStart = view.getUint32(8, true),
      count = view.getUint32(12, true);
    const observed = view.getBigUint64(16, true);
    if (
      fileId >= scope.fileRows.length ||
      count === 0 ||
      rowStart + count > scope.fileRows[fileId] ||
      observed > BigInt(Number.MAX_SAFE_INTEGER)
    )
      throw new Error("History block pointer is outside its generation");
    rows += count;
    if (found.length >= 4096 || rows > 65536)
      throw new Error("History block exceeds its result budget");
    found.push({ fileId, rowStart, rows: count, observedAt: Number(observed) });
  }
  return found;
}
