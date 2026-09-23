import {
  HistoryBlockIndexSchema,
  type HistoryBlockIndex,
} from "../schemas-src/artifacts/history-block-index.ts";
import {
  boundedParquetBuffer,
  type ParquetRangeSource,
  type ParquetReadBudget,
} from "./indexed-parquet.ts";

// Read options combine manifest identity with the separately verified file census.
interface Scope {
  generation: HistoryBlockIndex["generation"];
  network: HistoryBlockIndex["network"];
  table: HistoryBlockIndex["table"];
  fileRows: readonly number[];
}
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

export interface HistoryBlockRangeRun extends HistoryBlockRun {
  block: number;
}

/** Locate every physical run for a bounded inclusive block window. */
export function findHistoryBlockRangeRuns(
  source: ParquetRangeSource,
  input: unknown,
  scope: Scope,
  first: number,
  last: number,
  budget: ParquetReadBudget,
): Promise<HistoryBlockRangeRun[]> {
  if (last - first > 5000)
    throw new Error("History block window exceeds its budget");
  return findRuns(source, input, scope, first, last, budget, 65536, 2_000_000);
}

/** Point reads keep their existing result envelope and physical capture order. */
export async function findHistoryBlockRuns(
  source: ParquetRangeSource,
  input: unknown,
  scope: Scope,
  block: number,
  budget: ParquetReadBudget,
): Promise<HistoryBlockRun[]> {
  const runs = await findRuns(
    source,
    input,
    scope,
    block,
    block,
    budget,
    4096,
    65536,
  );
  return runs.map(({ fileId, rowStart, rows, observedAt }) => ({
    fileId,
    rowStart,
    rows,
    observedAt,
  }));
}

async function findRuns(
  source: ParquetRangeSource,
  input: unknown,
  scope: Scope,
  first: number,
  last: number,
  budget: ParquetReadBudget,
  maxRuns: number,
  maxRows: number,
): Promise<HistoryBlockRangeRun[]> {
  const index = validateHistoryBlockIndex(input, scope);
  if (
    !Number.isInteger(first) ||
    first < 0 ||
    first > 0xffffffff ||
    !Number.isInteger(last) ||
    last < first ||
    last > 0xffffffff
  )
    throw new Error("Invalid history block number");
  const found: HistoryBlockRangeRun[] = [];
  let rows = 0;
  for (const shard of index.shards) {
    if (last < shard.firstBlock || first > shard.lastBlock) continue;
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
        key >>> 16 !== parseInt(shard.prefix, 16) ||
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
      if ((await record(mid)).key < first) low = mid + 1;
      else high = mid;
    }
    for (let run = low; run < shard.runs; run++) {
      const { key, view } = await record(run);
      if (key > last) break;
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
      if (found.length >= maxRuns || rows > maxRows)
        throw new Error("History block exceeds its result budget");
      found.push({
        block: key,
        fileId,
        rowStart,
        rows: count,
        observedAt: Number(observed),
      });
    }
  }
  return found;
}
