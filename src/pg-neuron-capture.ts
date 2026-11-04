import type { PgStoreRuntime } from "./pg-store-runtime.ts";
import { createNativeWorkGroup } from "./native-work-group.ts";
import { prepareNeuronDocument } from "./neuron-document-preparation.ts";
import {
  storeSqliteValue,
  type createSqliteDocumentDecoder,
} from "./sqlite-document-decoder.ts";
import {
  groupNeuronDocuments,
  neuronCaptureDocumentSize,
  type NeuronDocumentFamily,
  type NeuronCaptureDocument,
} from "./neuron-documents.ts";
import { NEURON_INSERT_COLUMNS } from "./metagraph-neurons.ts";
import {
  ACCOUNT_POSITION_DAILY_COLUMNS,
  NEURON_DAILY_COLUMNS,
  type NeuronMirrorInput,
} from "./neurons-neon-write.ts";
import { neuronCaptureIdentity } from "./neuron-capture-receipt.ts";
import type { NeuronCaptureStore } from "./neuron-capture-store.ts";

type Decoder = ReturnType<typeof createSqliteDocumentDecoder>;
type Transaction = Parameters<Parameters<PgStoreRuntime["transaction"]>[0]>[0];

export interface PgNeuronCaptureOptions {
  maxRows: number;
  maxDocuments: number;
  maxPayloadBytes: number;
  maxConcurrent: number;
  executionTimeoutMillis: number;
  drainTimeoutMillis: number;
}

const integer = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/** One source-family lock precedes every source/member/revision row lock. The
 * caller owns the shared pool and pinned codec, including their shutdown. */
export function createPgNeuronCaptureStore(
  runtime: Pick<PgStoreRuntime, "transaction">,
  decoder: Decoder,
  requested: PgNeuronCaptureOptions,
): NeuronCaptureStore & { close(): Promise<void>; readonly state: string } {
  const options = { ...requested };
  for (const [name, value, maximum] of [
    ["maxRows", options.maxRows, 50_000],
    ["maxDocuments", options.maxDocuments, 4096],
    ["maxPayloadBytes", options.maxPayloadBytes, 64 * 1024 * 1024],
    ["maxConcurrent", options.maxConcurrent, 4],
  ] as const) {
    if (!integer(value) || value < 1 || value > maximum)
      throw new RangeError(`Invalid neuron capture ${name}`);
  }
  if (options.maxPayloadBytes * options.maxConcurrent > 64 * 1024 * 1024)
    throw new RangeError(
      "Neuron capture aggregate buffering exceeds its budget",
    );
  const work = createNativeWorkGroup({
    name: "Native neuron capture",
    executionTimeoutMillis: options.executionTimeoutMillis,
    drainTimeoutMillis: options.drainTimeoutMillis,
  });

  return {
    get state() {
      return work.state;
    },
    close: work.close,
    write(input, signal) {
      return work.run(
        "write",
        options.maxConcurrent,
        () => {
          throw new Error("Native neuron capture capacity exceeded");
        },
        (scope) =>
          scope.invoke(async (workSignal) => {
            const cancellation = signal
              ? AbortSignal.any([signal, workSignal])
              : workSignal;
            cancellation.throwIfAborted();
            for (const rows of [
              input.rows,
              input.dailyRows,
              input.positionRows,
            ])
              if (!Array.isArray(rows) || rows.length > options.maxRows)
                throw new RangeError("Neuron capture exceeds its row budget");
            const cutoffs = [...(input.netuidMaxCapturedAt ?? [])];
            if (
              cutoffs.length > options.maxRows ||
              cutoffs.some(
                ([key, at]) => !integer(key) || !integer(at) || at < 1e12,
              )
            )
              throw new TypeError("Invalid neuron prune cutoff");
            const pass = input.pass ? { ...input.pass } : undefined;
            if (
              pass &&
              (!integer(pass.capturedAt) ||
                pass.capturedAt < 1e12 ||
                !integer(pass.expectedRows) ||
                !integer(pass.receivedRows) ||
                !integer(pass.nowMs))
            )
              throw new TypeError("Invalid neuron pass tally");
            const receipt = pass
              ? neuronCaptureIdentity(pass, input.rows)
              : undefined;
            const groups: [NeuronDocumentFamily, NeuronCaptureDocument[]][] = [
              [
                "neurons",
                groupNeuronDocuments(
                  "neurons",
                  input.rows,
                  NEURON_INSERT_COLUMNS,
                ),
              ],
              [
                "neuron_daily",
                groupNeuronDocuments(
                  "neuron_daily",
                  input.dailyRows,
                  NEURON_DAILY_COLUMNS,
                ),
              ],
              [
                "account_position_daily",
                groupNeuronDocuments(
                  "account_position_daily",
                  input.positionRows,
                  ACCOUNT_POSITION_DAILY_COLUMNS,
                ),
              ],
            ];
            if (
              groups.reduce((count, [, docs]) => count + docs.length, 0) >
              options.maxDocuments
            )
              throw new RangeError(
                "Neuron capture exceeds its document budget",
              );
            let bytes = 0;
            const prepared = groups.map(([family, docs]) => ({
              family,
              docs: docs.map((doc) => {
                const text = JSON.stringify(doc.payload);
                bytes += neuronCaptureDocumentSize(doc);
                if (bytes > options.maxPayloadBytes)
                  throw new RangeError(
                    "Neuron capture exceeds its payload budget",
                  );
                return { ...doc, encoded: decoder.encode(text) };
              }),
            }));
            return runtime.transaction(
              async (tx) => {
                cancellation.throwIfAborted();
                await tx.query("SELECT pg_advisory_xact_lock(1297307,0)");
                let statements = 1;
                const run: Transaction["run"] = async (text, values) => {
                  cancellation.throwIfAborted();
                  statements++;
                  return tx.run(text, values);
                };
                const save = async (
                  family: NeuronDocumentFamily,
                  doc: { netuid: number; day: string; shard: number | string },
                  stamp: bigint,
                  payload: Uint8Array,
                ) => {
                  const table = `${family}_documents` as const;
                  const value = prepareNeuronDocument(decoder, table, payload);
                  await run(
                    `INSERT INTO app.neuron_document_projections
                (source_table,netuid,day,shard,payload_sha256,payload_json,decode_status,decode_error,axon_values,decoder_version,decoder_source_id)
                VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::json,$10,$11)
                ON CONFLICT(source_table,netuid,day,shard) DO UPDATE SET
                  payload_sha256=excluded.payload_sha256,payload_json=excluded.payload_json,
                  decode_status=excluded.decode_status,decode_error=excluded.decode_error,
                  axon_values=excluded.axon_values,decoder_version=excluded.decoder_version,
                  decoder_source_id=excluded.decoder_source_id`,
                    [
                      table,
                      doc.netuid,
                      doc.day,
                      doc.shard,
                      value.payloadSha256,
                      value.json,
                      value.decodeStatus,
                      value.decodeError,
                      JSON.stringify(value.axonValues),
                      value.decoderVersion,
                      value.decoderSourceId,
                    ],
                  );
                  await run(
                    `INSERT INTO app.${table}(netuid,day,shard,stamp,payload)
                VALUES($1,$2,$3,$4,$5) ON CONFLICT(netuid,day,shard)
                DO UPDATE SET stamp=excluded.stamp,payload=excluded.payload`,
                    [doc.netuid, doc.day, doc.shard, stamp.toString(), payload],
                  );
                };

                let prunedDocuments = 0;
                for (const { family, docs } of prepared) {
                  for (const doc of docs) {
                    cancellation.throwIfAborted();
                    statements++;
                    const old = await tx.first<{
                      payload: Uint8Array;
                      stamp: string;
                    }>(
                      `SELECT payload,stamp::text AS stamp FROM app.${family}_documents
                    WHERE netuid=$1 AND day=$2 AND shard=$3 FOR UPDATE`,
                      [doc.netuid, doc.day, doc.shard],
                    );
                    const updated = old
                      ? decoder.mergeCapture(
                          old.payload,
                          doc.encoded,
                          BigInt(old.stamp),
                        )
                      : doc.encoded;
                    const accepted = updated ?? old!.payload;
                    if (updated)
                      await save(
                        family,
                        doc,
                        old && BigInt(old.stamp) > BigInt(doc.stamp)
                          ? BigInt(old.stamp)
                          : BigInt(doc.stamp),
                        updated,
                      );
                    if (family === "account_position_daily") {
                      const members = Object.values(doc.payload).map((row) => ({
                        account: row.account,
                        netuid: doc.netuid,
                        day: doc.day,
                        shard: doc.shard,
                      }));
                      await run(
                        `INSERT INTO app.account_position_daily_members(account,netuid,snapshot_date,shard)
                    SELECT account,netuid,day,shard FROM json_to_recordset($1::json)
                      AS incoming(account text,netuid bigint,day text,shard bigint)
                    ON CONFLICT(account,netuid,snapshot_date) DO NOTHING`,
                        [JSON.stringify(members)],
                      );
                    } else {
                      const daily = family === "neuron_daily";
                      const members = decoder
                        .metricEntries(
                          accepted,
                          [
                            "netuid",
                            "uid",
                            "hotkey",
                            "coldkey",
                            ...(daily ? ["snapshot_date", "axon"] : []),
                          ],
                          Object.keys(doc.payload),
                        )
                        .map(({ values }) => {
                          if (
                            typeof values.uid !== "bigint" ||
                            typeof values.netuid !== "bigint"
                          )
                            throw new TypeError(
                              "Neuron member identity is not an integer",
                            );
                          return {
                            netuid: values.netuid.toString(),
                            uid: values.uid.toString(),
                            day: daily
                              ? decoder.textAffinity(values.snapshot_date)
                              : "",
                            shard: doc.shard,
                            hotkey: decoder.textAffinity(values.hotkey),
                            coldkey: decoder.textAffinity(values.coldkey),
                            axon_index: daily
                              ? storeSqliteValue(values.axon)
                              : null,
                          };
                        });
                      const writeMembers = async (batch: typeof members) =>
                        run(
                          `INSERT INTO app.${family}_members(netuid,uid,${daily ? "snapshot_date," : ""}hotkey,coldkey,shard${daily ? ",axon_index,axon_indexed" : ""})
                      SELECT netuid,uid,${daily ? "day," : ""}hotkey,coldkey,shard${daily ? ",axon_index,true" : ""} FROM json_to_recordset($1::json)
                        AS incoming(netuid bigint,uid bigint,day text,hotkey text,coldkey text,shard bigint,axon_index json)
                      ON CONFLICT(netuid,uid${daily ? ",snapshot_date" : ""}) DO UPDATE SET hotkey=excluded.hotkey,coldkey=excluded.coldkey
                      WHERE app.${family}_members.hotkey IS DISTINCT FROM excluded.hotkey
                        OR app.${family}_members.coldkey IS DISTINCT FROM excluded.coldkey`,
                          [JSON.stringify(batch)],
                        );
                      // SQLite processes repeated document keys in source order.
                      // A PostgreSQL INSERT cannot affect one key twice, so split
                      // only at duplicates while preserving that update order.
                      let batch: typeof members = [];
                      const identities = new Set<string>();
                      for (const member of members) {
                        const identity = JSON.stringify([
                          member.netuid,
                          member.uid,
                          member.day,
                        ]);
                        if (identities.has(identity)) {
                          await writeMembers(batch);
                          batch = [];
                          identities.clear();
                        }
                        identities.add(identity);
                        batch.push(member);
                      }
                      await writeMembers(batch);
                    }
                  }
                  if (family === "neurons")
                    for (const [netuid, cutoff] of cutoffs) {
                      statements++;
                      const docs = await tx.query<{
                        shard: string;
                        stamp: string;
                      }>(
                        "SELECT shard::text AS shard,stamp::text AS stamp FROM app.neurons_documents WHERE netuid=$1 AND day='' ORDER BY shard LIMIT $2 FOR UPDATE",
                        [netuid, options.maxDocuments + 1],
                      );
                      prunedDocuments += docs.length;
                      if (prunedDocuments > options.maxDocuments)
                        throw new RangeError(
                          "Neuron prune exceeds its document budget",
                        );
                      for (const doc of docs) {
                        cancellation.throwIfAborted();
                        statements++;
                        const source = await tx.first<{ payload: Uint8Array }>(
                          "SELECT payload FROM app.neurons_documents WHERE netuid=$1 AND day='' AND shard=$2",
                          [netuid, doc.shard],
                        );
                        if (!source)
                          throw new Error("Locked neuron document disappeared");
                        const pruned = decoder.pruneCapture(
                          source.payload,
                          cutoff,
                        );
                        if (!pruned) continue;
                        await run(
                          "DELETE FROM app.neurons_members WHERE netuid=$1 AND shard=$2 AND uid=ANY($3::bigint[])",
                          [netuid, doc.shard, pruned.uids.map(String)],
                        );
                        await save(
                          "neurons",
                          { netuid, day: "", shard: doc.shard },
                          BigInt(doc.stamp),
                          pruned.payload,
                        );
                      }
                    }
                }
                if (pass && receipt) {
                  await run(
                    `DELETE FROM app.neurons_capture_batches WHERE batch_id IN (
                SELECT r.batch_id FROM app.neurons_capture_batches r
                JOIN app.neurons_passes p ON p.captured_at=r.captured_at
                WHERE p.completed_at IS NOT NULL AND r.captured_at<$1
                ORDER BY r.captured_at,r.batch_id LIMIT 200)`,
                    [pass.nowMs - 600_000],
                  );
                  await run(
                    `INSERT INTO app.neurons_capture_batches(batch_id,captured_at,sha256)
                SELECT $1,$2,$3 WHERE NOT EXISTS (SELECT 1 FROM app.neurons_passes WHERE captured_at=$2 AND completed_at IS NOT NULL)
                ON CONFLICT(batch_id) DO UPDATE SET sha256=CASE
                  WHEN neurons_capture_batches.sha256=excluded.sha256 THEN excluded.sha256 ELSE NULL END`,
                    [receipt.batchId, pass.capturedAt, receipt.digest],
                  );
                  await run(
                    `INSERT INTO app.neurons_passes(captured_at,expected_rows,received_rows,completed_at)
                SELECT $1::bigint,$2::bigint,$3::bigint,CASE WHEN $3::bigint >= $2::bigint THEN $4::bigint ELSE NULL END
                FROM app.neurons_capture_batches WHERE batch_id=$5 AND sha256=$6 AND NOT applied
                ON CONFLICT(captured_at) DO UPDATE SET expected_rows=excluded.expected_rows,
                  received_rows=neurons_passes.received_rows+excluded.received_rows,
                  completed_at=COALESCE(neurons_passes.completed_at,CASE
                    WHEN neurons_passes.received_rows+excluded.received_rows >= excluded.expected_rows THEN $4 ELSE NULL END)`,
                    [
                      pass.capturedAt,
                      pass.expectedRows,
                      pass.receivedRows,
                      pass.nowMs,
                      receipt.batchId,
                      receipt.digest,
                    ],
                  );
                  await run(
                    "UPDATE app.neurons_capture_batches SET applied=true WHERE batch_id=$1 AND sha256=$2",
                    [receipt.batchId, receipt.digest],
                  );
                  statements++;
                  const acknowledged = await tx.first<{
                    sha256: string;
                    applied: boolean;
                  }>(
                    "SELECT sha256,applied FROM app.neurons_capture_batches WHERE batch_id=$1",
                    [receipt.batchId],
                  );
                  if (!(
                    acknowledged?.sha256 === receipt.digest &&
                    acknowledged.applied
                  )) {
                    statements++;
                    const complete = acknowledged
                      ? null
                      : await tx.first<{
                          expected_rows: string;
                          received_rows: string;
                          completed_at: string | null;
                        }>(
                          "SELECT expected_rows::text,received_rows::text,completed_at::text FROM app.neurons_passes WHERE captured_at=$1",
                          [pass.capturedAt],
                        );
                    const completed =
                      complete !== null &&
                      complete.completed_at !== null &&
                      BigInt(complete.received_rows) >=
                        BigInt(complete.expected_rows) &&
                      BigInt(complete.completed_at) >= BigInt(pass.capturedAt);
                    if (!completed)
                      throw new Error(
                        "Neuron capture batch was not acknowledged",
                      );
                  }
                }
                cancellation.throwIfAborted();
                return statements;
              },
              { isolation: "read committed" },
            );
          }),
      );
    },
  };
}
