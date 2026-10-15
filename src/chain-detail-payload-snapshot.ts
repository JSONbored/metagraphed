import {
  readD1Snapshot,
  selectedD1Store,
  type D1StoreBinding,
} from "./d1-store.ts";
import type {
  ExtrinsicsRow,
  ChainEventsRow,
} from "../generated/lakehouse/types.ts";
import {
  NATIVE_PAYLOAD_PREFIX,
  type NativePayloadParts,
} from "./chain-detail-native-payloads.ts";
import type { ProducerStatement } from "./producer-store.ts";

type PayloadRow = Partial<
  Omit<ExtrinsicsRow, "success" | "fee_tao" | "tip_tao"> & ChainEventsRow
> & {
  success?: number | null;
  fee_tao?: string | number | null;
  tip_tao?: string | number | null;
  record?: string | null;
  first?: number | null;
  last?: number | null;
  rows?: number | null;
};
type ChunkRow = { sha256: string; part: number; data: string };

/** One D1 batch owns both the selection and its exact chunk bytes. No lease,
 * clock grace or later database lookup can substitute for this snapshot. */
export async function readChainDetailPayloadSnapshot(
  env: unknown,
  statement: ProducerStatement,
  field: "call_args" | "args",
  records = false,
): Promise<{ rows: PayloadRow[]; parts: NativePayloadParts }> {
  const owner =
    field === "call_args"
      ? "chain_detail_extrinsics"
      : "chain_detail_chain_events";
  if (!selectedD1Store(env, [owner]))
    throw new Error("Native payload snapshot requires selected D1 ownership");
  const db = (env as { D1_STATE: D1StoreBinding }).D1_STATE;
  const cell = records ? `json_extract(record,'$.${field}')` : field;
  const prefix = Array.from(
    new TextEncoder().encode(NATIVE_PAYLOAD_PREFIX),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
  const [rows, chunks] = await readD1Snapshot<PayloadRow, ChunkRow>(db, [
    statement,
    {
      text: `WITH selected AS (${statement.text}), selected_refs AS (
      SELECT CAST(substr(CAST(${cell} AS BLOB),25,64) AS TEXT) AS sha256,
        CAST(substr(CAST(${cell} AS BLOB),90) AS INTEGER) AS raw_bytes FROM selected
      WHERE substr(CAST(${cell} AS BLOB),1,24)=X'${prefix}'
        AND substr(CAST(${cell} AS BLOB),-3)=X'3a6431'
    ), parts AS (
      SELECT sha256,part,data, sum(length(data)) OVER (ORDER BY sha256,part) AS bytes
      FROM chain_detail_payload_chunks WHERE sha256 IN (
        SELECT sha256 FROM selected_refs WHERE (SELECT sum(CASE WHEN raw_bytes BETWEEN 131073 AND 16777216
          THEN raw_bytes ELSE 33554433 END) FROM selected_refs)<=33554432))
      SELECT sha256,part,data FROM parts WHERE bytes<=50331648 ORDER BY sha256,part LIMIT 300`,
      values: statement.values,
    },
  ]);
  // Valid admitted32MiB raw batches need fewer than300 parts and48MiB base64.
  // Corrupt/over-budget selections remain bounded and fail existing hydration.
  const parts = new Map<string, { part: number; data: string }[]>();
  for (const row of chunks) {
    const hash = row.sha256;
    const group = parts.get(hash) ?? [];
    group.push({ part: row.part, data: row.data });
    parts.set(hash, group);
  }
  return { rows, parts };
}
