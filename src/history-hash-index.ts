import { HistoryHashShardSchema } from "../schemas-src/artifacts/history-hash-index.ts";
import {
  boundedParquetBuffer,
  type ParquetRangeSource,
  type ParquetReadBudget,
} from "./indexed-parquet.ts";

const RECORD_BYTES = 40;
const PAGE_ROWS = 1024;

/** Binary search never downloads an entire skewed shard. Only a valid,
 * complete generation may establish absence; missing/corrupt objects throw. */
export async function findHistoryHash(
  source: ParquetRangeSource,
  input: unknown,
  hash: string,
  scope: {
    generation: string;
    network: "mainnet" | "testnet";
    table: "extrinsics" | "blocks";
    fileRows: readonly number[];
  },
  budget: ParquetReadBudget,
): Promise<{ fileId: number; row: number } | null> {
  const shard = HistoryHashShardSchema.parse(input);
  if (!/^0x[0-9a-fA-F]{64}$/.test(hash))
    throw new Error("Invalid history hash");
  const hex = hash.slice(2).toLowerCase();
  const offset = shard.offset ?? 0;
  const name = shard.offset === undefined ? shard.prefix : "packed";
  const expectedKey = `metagraph/indexed-history/v1/${scope.network}/${scope.table}/generations/${scope.generation}/hash/${name}.bin`;
  if (
    shard.generation !== scope.generation ||
    shard.network !== scope.network ||
    shard.table !== scope.table ||
    shard.prefix !== hex.slice(0, 3) ||
    shard.key !== expectedKey ||
    shard.bytes !== shard.rows * RECORD_BYTES ||
    offset % RECORD_BYTES !== 0 ||
    !Number.isSafeInteger(offset + shard.bytes)
  )
    throw new Error("History hash index scope mismatch");
  const target = Uint8Array.from(hex.match(/../g)!, (value) =>
    parseInt(value, 16),
  );
  const file = boundedParquetBuffer(
    {
      read: (key, etag, start, length) =>
        source.read(key, etag, offset + start, length),
    },
    shard,
    budget,
  );
  const pages = new Map<number, Promise<ArrayBuffer>>();
  const record = async (row: number) => {
    const page = Math.floor(row / PAGE_ROWS);
    let bytes = pages.get(page);
    if (!bytes) {
      const start = page * PAGE_ROWS * RECORD_BYTES;
      bytes = Promise.resolve(
        file.slice(
          start,
          Math.min(start + PAGE_ROWS * RECORD_BYTES, shard.bytes),
        ),
      );
      pages.set(page, bytes);
    }
    const data = new Uint8Array(
      await bytes,
      (row % PAGE_ROWS) * RECORD_BYTES,
      RECORD_BYTES,
    );
    const prefix = Array.from(data.subarray(0, 2), (v) =>
      v.toString(16).padStart(2, "0"),
    )
      .join("")
      .slice(0, 3);
    if (prefix !== shard.prefix)
      throw new Error("History hash shard contains a foreign prefix");
    return data;
  };
  const compare = (data: Uint8Array) => {
    for (let i = 0; i < 32; i++) {
      if (data[i] !== target[i]) return data[i] - target[i];
    }
    return 0;
  };
  let low = 0,
    high = shard.rows;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (compare(await record(mid)) < 0) low = mid + 1;
    else high = mid;
  }
  if (low === shard.rows) return null;
  const data = await record(low);
  if (compare(data) !== 0) return null;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const fileId = view.getUint32(32, true),
    row = view.getUint32(36, true);
  if (
    fileId >= scope.fileRows.length ||
    !Number.isSafeInteger(scope.fileRows[fileId]) ||
    scope.fileRows[fileId] < 1 ||
    row >= scope.fileRows[fileId]
  )
    throw new Error("History hash pointer is outside its generation");
  return { fileId, row };
}
