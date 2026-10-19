import {
  HistoryEconomicsAttributionSchema,
  HistoryObjectSchema,
  type HistoryObject,
} from "../schemas-src/artifacts/history-generation.ts";
import { historyJson, historySha256 } from "./history-sha256.ts";
import {
  boundedParquetBuffer,
  type ParquetRangeSource,
  type ParquetReadBudget,
} from "./indexed-parquet.ts";

const MAX_BYTES = 2 * 1024 * 1024;
type Part = HistoryObject & { rows: number };
const prefix = (part: Part) => part.key.replace(/\.parquet$/, ".economics-");

/** Offline only: caller must derive IDs from every pinned physical row in order. */
export function buildHistoryEconomicsAttribution(
  part: Part,
  subnetIds: readonly number[][],
) {
  const value = HistoryEconomicsAttributionSchema.parse({
    version: 1,
    source: {
      key: part.key,
      etag: part.etag,
      bytes: part.bytes,
      rows: part.rows,
    },
    subnetIds,
  });
  if (value.subnetIds.length !== part.rows || !part.key.endsWith(".parquet"))
    throw new Error("Economics companion source census mismatch");
  const bytes = new TextEncoder().encode(historyJson(value));
  if (bytes.length > MAX_BYTES)
    throw new Error("Economics companion exceeds size bound");
  return {
    value,
    bytes,
    key: `${prefix(part)}${historySha256(bytes)}.json`,
  };
}

export function validateHistoryEconomicsReference(
  input: HistoryObject,
  part: Part,
) {
  const object = HistoryObjectSchema.parse(input);
  const suffix = object.key.slice(prefix(part).length);
  if (
    !part.key.endsWith(".parquet") ||
    !object.key.startsWith(prefix(part)) ||
    !/^[a-f0-9]{64}\.json$/.test(suffix) ||
    object.bytes > MAX_BYTES
  )
    throw new Error("Economics companion identity or size mismatch");
  return object;
}

/** A declared but invalid companion fails closed; it never buys a wide fallback. */
export async function readHistoryEconomicsAttribution(
  source: ParquetRangeSource,
  input: HistoryObject,
  part: Part,
  budget: ParquetReadBudget,
): Promise<number[][]> {
  const object = validateHistoryEconomicsReference(input, part);
  const suffix = object.key.slice(prefix(part).length);
  const raw = new Uint8Array(
    await boundedParquetBuffer(source, object, budget).slice(0, object.bytes),
  );
  if (`${historySha256(raw)}.json` !== suffix)
    throw new Error("Economics companion digest mismatch");
  if (budget.decodedBytes + raw.length > 32 * 1024 * 1024)
    throw new Error("Indexed Parquet decoded memory budget exceeded");
  budget.decodedBytes += raw.length;
  const value = HistoryEconomicsAttributionSchema.parse(
    JSON.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(raw),
    ),
  );
  if (
    value.source.key !== part.key ||
    value.source.etag !== part.etag ||
    value.source.bytes !== part.bytes ||
    value.source.rows !== part.rows ||
    value.subnetIds.length !== part.rows
  )
    throw new Error("Economics companion source census mismatch");
  const values = value.subnetIds.reduce(
    (total, ids) => total + ids.length + 1,
    0,
  );
  if (budget.values + values > 1_000_000)
    throw new Error("Indexed Parquet decoded memory budget exceeded");
  budget.values += values;
  return value.subnetIds;
}
