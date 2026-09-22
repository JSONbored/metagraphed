// Native, atomic D1 storage for metagraph captures. Stable key indexes change
// only when membership changes; repeated metric captures replace documents.
import { NEURON_INSERT_COLUMNS } from "./metagraph-neurons.ts";
import {
  ACCOUNT_POSITION_DAILY_COLUMNS,
  NEURON_DAILY_COLUMNS,
  type NeuronMirrorInput,
} from "./neurons-neon-write.ts";
import type { ProducerStatement, ProducerStore } from "./producer-store.ts";

type Row = Record<string, unknown>;
type Family = "neurons" | "neuron_daily" | "account_position_daily";
type Document = {
  netuid: number;
  day: string;
  shard: number;
  stamp: number;
  payload: Record<string, Row>;
};
const encoder = new TextEncoder();
const MAX_BYTES = 512 * 1024;

function integer(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function documents(
  family: Family,
  rows: Row[],
  columns: readonly string[],
): Document[] {
  const groups = new Map<string, Document>();
  for (const row of rows) {
    if (
      !integer(row.netuid) ||
      !integer(row.captured_at) ||
      row.captured_at < 1e12
    )
      throw new TypeError("Invalid neuron capture key or timestamp");
    const position = family === "account_position_daily";
    const key = position ? row.account : row.uid;
    if (position ? typeof key !== "string" : !integer(key))
      throw new TypeError("Invalid neuron member key");
    const memberKey = position
      ? "k" +
        [...encoder.encode(String(key))]
          .map((byte) => byte.toString(16).padStart(2, "0"))
          .join("")
          .toUpperCase()
      : String(key);
    const day = family === "neurons" ? "" : row.snapshot_date;
    if (
      typeof day !== "string" ||
      (family !== "neurons" && !/^\d{4}-\d{2}-\d{2}$/.test(day))
    )
      throw new TypeError("Invalid neuron snapshot day");
    const shard = position
      ? [...String(key)].reduce(
          (hash, c) => (hash * 31 + c.charCodeAt(0)) >>> 0,
          0,
        ) % 4
      : Math.floor(Number(key) / 256);
    const id = `${row.netuid}/${day}/${shard}`;
    let doc = groups.get(id);
    if (!doc) {
      doc = {
        netuid: row.netuid,
        day,
        shard,
        stamp: row.captured_at,
        payload: {},
      };
      groups.set(id, doc);
    }
    if (Object.hasOwn(doc.payload, memberKey))
      throw new TypeError("Duplicate neuron member in capture");
    const normalized: Row = {};
    for (const column of columns) {
      const value = row[column] ?? null;
      if (
        value !== null &&
        typeof value !== "string" &&
        typeof value !== "boolean" &&
        !(typeof value === "number" && Number.isFinite(value))
      )
        throw new TypeError("Invalid neuron column value");
      normalized[column] = typeof value === "boolean" ? Number(value) : value;
    }
    doc.payload[memberKey] = normalized;
    doc.stamp = Math.max(doc.stamp, row.captured_at);
  }
  return [...groups.values()];
}

function documentStatements(
  family: Family,
  docs: Document[],
): ProducerStatement[] {
  const table = `${family}_documents`;
  const members = `${family}_members`;
  const position = family === "account_position_daily";
  const daily = family !== "neurons";
  const fields = position
    ? ["account", "netuid", "snapshot_date"]
    : [
        "netuid",
        "uid",
        ...(daily ? ["snapshot_date"] : []),
        "hotkey",
        "coldkey",
      ];
  const conflict = position
    ? "account,netuid,snapshot_date"
    : `netuid,uid${daily ? ",snapshot_date" : ""}`;
  const identityUpdates = position
    ? "DO NOTHING"
    : `DO UPDATE SET hotkey=excluded.hotkey,coldkey=excluded.coldkey WHERE ${members}.hotkey IS NOT excluded.hotkey OR ${members}.coldkey IS NOT excluded.coldkey`;
  const path = `'$."'||i.key||'".captured_at'`;
  const newer = `json_extract(${table}.payload,${path}) IS NULL OR json_extract(${table}.payload,${path}) < json_extract(i.value,'$.captured_at')`;
  const out: ProducerStatement[] = [];
  let batch: Document[] = [],
    bytes = 2;
  function flush() {
    if (!batch.length) return;
    const value = JSON.stringify(batch);
    out.push({
      text: `INSERT INTO ${table}(netuid,day,shard,stamp,payload)
      SELECT json_extract(value,'$.netuid'),json_extract(value,'$.day'),json_extract(value,'$.shard'),json_extract(value,'$.stamp'),jsonb_extract(value,'$.payload')
      FROM json_each(?) WHERE true
      ON CONFLICT(netuid,day,shard) DO UPDATE SET
        payload=jsonb_patch(${table}.payload,(SELECT jsonb_group_object(i.key,json(i.value)) FROM json_each(excluded.payload) i WHERE ${newer})),
        stamp=MAX(${table}.stamp,excluded.stamp)
      WHERE EXISTS(SELECT 1 FROM json_each(excluded.payload) i WHERE ${newer})`,
      values: [value],
    });
    // Read accepted identities from the merged document, so a stale incoming
    // capture cannot regress the lookup index while its metrics are rejected.
    out.push({
      text: `INSERT INTO ${members}(${fields.join(",")},shard)
      SELECT ${fields.map((c) => `json_extract(d.payload,'$."'||i.key||'".${c}')`).join(",")},d.shard
      FROM json_each(?) b JOIN ${table} d ON d.netuid=json_extract(b.value,'$.netuid') AND d.day=json_extract(b.value,'$.day') AND d.shard=json_extract(b.value,'$.shard')
      JOIN json_each(json_extract(b.value,'$.payload')) i WHERE true
      ON CONFLICT(${conflict}) ${identityUpdates}`,
      values: [value],
    });
    batch = [];
    bytes = 2;
  }
  for (const doc of docs) {
    const size = encoder.encode(JSON.stringify(doc)).length + 1;
    if (size + 2 > MAX_BYTES)
      throw new RangeError("Neuron document exceeds 512 KiB");
    if (bytes + size > MAX_BYTES) flush();
    batch.push(doc);
    bytes += size;
  }
  flush();
  return out;
}

/** One transaction includes all three families, pruning and the pass tally. */
export function neuronDocumentStatements(
  input: NeuronMirrorInput,
): ProducerStatement[] {
  const statements = [
    ...documentStatements(
      "neurons",
      documents("neurons", input.rows, NEURON_INSERT_COLUMNS),
    ),
    ...documentStatements(
      "neuron_daily",
      documents("neuron_daily", input.dailyRows, NEURON_DAILY_COLUMNS),
    ),
    ...documentStatements(
      "account_position_daily",
      documents(
        "account_position_daily",
        input.positionRows,
        ACCOUNT_POSITION_DAILY_COLUMNS,
      ),
    ),
  ];
  const cutoffs = [...(input.netuidMaxCapturedAt ?? [])];
  if (cutoffs.length) {
    if (
      cutoffs.some(
        ([netuid, at]) => !integer(netuid) || !integer(at) || at < 1e12,
      )
    )
      throw new TypeError("Invalid neuron prune cutoff");
    const value = JSON.stringify(Object.fromEntries(cutoffs));
    statements.push({
      text: `DELETE FROM neurons_members WHERE netuid IN (SELECT CAST(key AS INTEGER) FROM json_each(?)) AND uid IN
      (SELECT CAST(i.key AS INTEGER) FROM neurons_documents d,json_each(d.payload) i WHERE d.netuid=neurons_members.netuid AND d.shard=neurons_members.shard AND json_extract(i.value,'$.captured_at') < json_extract(?,'$."'||d.netuid||'"'))`,
      values: [value, value],
    });
    statements.push({
      text: `UPDATE neurons_documents SET payload=jsonb((SELECT jsonb_group_object(i.key,json(i.value)) FROM json_each(neurons_documents.payload) i WHERE json_extract(i.value,'$.captured_at') >= json_extract(?,'$."'||neurons_documents.netuid||'"')))
      WHERE netuid IN (SELECT CAST(key AS INTEGER) FROM json_each(?)) AND EXISTS(SELECT 1 FROM json_each(neurons_documents.payload) i WHERE json_extract(i.value,'$.captured_at') < json_extract(?,'$."'||neurons_documents.netuid||'"'))`,
      values: [value, value, value],
    });
  }
  if (input.pass) {
    const p = input.pass;
    statements.push({
      text: `INSERT INTO neurons_passes(captured_at,expected_rows,received_rows,completed_at)
      VALUES (?,?,?,CASE WHEN ? >= ? THEN ? ELSE NULL END)
      ON CONFLICT(captured_at) DO UPDATE SET expected_rows=excluded.expected_rows,
      received_rows=neurons_passes.received_rows+excluded.received_rows,
      completed_at=COALESCE(neurons_passes.completed_at,CASE WHEN neurons_passes.received_rows+excluded.received_rows >= excluded.expected_rows THEN ? ELSE NULL END)`,
      values: [
        p.capturedAt,
        p.expectedRows,
        p.receivedRows,
        p.receivedRows,
        p.expectedRows,
        p.nowMs,
        p.nowMs,
      ],
    });
  }
  if (statements.length > 900)
    throw new RangeError("Neuron capture exceeds atomic statement budget");
  return statements;
}

export async function writeNeuronDocuments(
  store: ProducerStore,
  input: NeuronMirrorInput,
): Promise<number> {
  const statements = neuronDocumentStatements(input);
  await store.transaction(statements);
  return statements.length;
}
