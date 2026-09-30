// Native, atomic D1 storage for metagraph captures. Stable key indexes change
// only when membership changes; repeated metric captures replace documents.
import { NEURON_INSERT_COLUMNS } from "./metagraph-neurons.ts";
import {
  ACCOUNT_POSITION_DAILY_COLUMNS,
  NEURON_DAILY_COLUMNS,
  type NeuronMirrorInput,
} from "./neurons-neon-write.ts";
import type { ProducerStatement, ProducerStore } from "./producer-store.ts";
import {
  neuronPassWrite,
  retryNeuronCapture,
} from "./neuron-capture-receipt.ts";

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
  const indexedAxon = family === "neuron_daily";
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
  // A wholly newer batch can merge directly. Mixed or delayed timestamps still
  // compare each member, including previously unseen members in an older batch.
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
        payload=jsonb_patch(${table}.payload,CASE
          WHEN (SELECT MIN(json_extract(i.value,'$.captured_at')) FROM json_each(excluded.payload) i) > ${table}.stamp
          THEN excluded.payload
          ELSE (SELECT jsonb_group_object(i.key,json(i.value)) FROM json_each(excluded.payload) i WHERE ${newer}) END),
        stamp=MAX(${table}.stamp,excluded.stamp)
      WHERE (SELECT MIN(json_extract(i.value,'$.captured_at')) FROM json_each(excluded.payload) i) > ${table}.stamp
        OR EXISTS(SELECT 1 FROM json_each(excluded.payload) i WHERE ${newer})`,
      values: [value],
    });
    // Account/day identity cannot change with its metrics: the document key
    // encodes that account, and a previously absent key is always accepted.
    // Neuron identities can change, so resolve those from the merged document
    // to keep stale captures from regressing them. New daily members also take
    // their axon from that accepted row without a second trigger read.
    out.push({
      text: `WITH incoming AS MATERIALIZED (
        SELECT json_extract(value,'$.netuid') AS netuid,json_extract(value,'$.day') AS day,
          json_extract(value,'$.shard') AS shard,jsonb_extract(value,'$.keys') AS keys
        FROM json_each(?)
      )
      INSERT INTO ${members}(${fields.join(",")},shard${indexedAxon ? ",axon_index,axon_indexed" : ""})
      ${
        position
          ? "SELECT k.value,b.netuid,b.day,b.shard FROM incoming b JOIN json_each(b.keys) k WHERE true"
          : `SELECT ${fields.map((c) => `json_extract(i.value,'$.${c}')`).join(",")},d.shard${indexedAxon ? ",json_extract(i.value,'$.axon'),1" : ""}
      FROM incoming b JOIN ${table} d ON d.netuid=b.netuid AND d.day=b.day AND d.shard=b.shard
      JOIN json_each(d.payload) i WHERE json_type(b.keys,'$."'||i.key||'"') IS NOT NULL`
      }
      ON CONFLICT(${conflict}) ${identityUpdates}`,
      values: [
        JSON.stringify(
          batch.map(({ netuid, day, shard, payload }) => ({
            netuid,
            day,
            shard,
            keys: position
              ? Object.values(payload).map((row) => row.account)
              : Object.fromEntries(Object.keys(payload).map((key) => [key, 1])),
          })),
        ),
      ],
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
function neuronDocumentWrite(input: NeuronMirrorInput) {
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
      // Materialize stale keys once. A correlated per-member subquery expands
      // its entire shard for every UID even when nothing needs pruning.
      text: `DELETE FROM neurons_members WHERE (netuid,uid,shard) IN
      (SELECT d.netuid,CAST(i.key AS INTEGER),d.shard
       FROM neurons_documents d CROSS JOIN json_each(d.payload) i
       WHERE d.day='' AND d.netuid IN (SELECT CAST(key AS INTEGER) FROM json_each(?))
         AND json_extract(i.value,'$.captured_at') < json_extract(?,'$."'||d.netuid||'"'))`,
      values: [value, value],
    });
    statements.push({
      text: `UPDATE neurons_documents SET payload=jsonb((SELECT jsonb_group_object(i.key,json(i.value)) FROM json_each(neurons_documents.payload) i WHERE json_extract(i.value,'$.captured_at') >= json_extract(?,'$."'||neurons_documents.netuid||'"')))
      WHERE netuid IN (SELECT CAST(key AS INTEGER) FROM json_each(?)) AND EXISTS(SELECT 1 FROM json_each(neurons_documents.payload) i WHERE json_extract(i.value,'$.captured_at') < json_extract(?,'$."'||neurons_documents.netuid||'"'))`,
      values: [value, value, value],
    });
  }
  const passWrite = input.pass
    ? neuronPassWrite(input.pass, input.rows)
    : undefined;
  if (passWrite) statements.push(...passWrite.statements);
  if (statements.length > 900)
    throw new RangeError("Neuron capture exceeds atomic statement budget");
  return { statements, passWrite };
}

export function neuronDocumentStatements(
  input: NeuronMirrorInput,
): ProducerStatement[] {
  return neuronDocumentWrite(input).statements;
}

export async function writeNeuronDocuments(
  store: ProducerStore,
  input: NeuronMirrorInput,
): Promise<number> {
  const { statements, passWrite } = neuronDocumentWrite(input);
  await retryNeuronCapture(async () => {
    await store.transaction(statements);
    if (passWrite) await passWrite.acknowledge(store);
  });
  return statements.length;
}
