import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, afterEach, beforeAll, beforeEach, test } from "vitest";
import {
  createPgNeuronCaptureStore,
  type PgNeuronCaptureOptions,
} from "../src/pg-neuron-capture.ts";
import { createSqliteDocumentDecoder } from "../src/sqlite-document-decoder.ts";
import { prepareNeuronDocument } from "../src/neuron-document-preparation.ts";
import {
  neuronSnapshotWrite,
  type NeuronMirrorInput,
} from "../src/neurons-neon-write.ts";
import { toPositionalPlaceholders } from "../src/pg-sql.ts";
import type { PgTransactionRunner } from "../src/pg-pool.ts";
import { queueDeferred } from "./helpers/queue-fixture.ts";
import { neuronCaptureIdentity } from "../src/neuron-capture-receipt.ts";

let db: PGlite;
let decoder: ReturnType<typeof createSqliteDocumentDecoder>;
const writers: ReturnType<typeof createPgNeuronCaptureStore>[] = [];
const options: PgNeuronCaptureOptions = {
  maxRows: 100,
  maxDocuments: 100,
  maxPayloadBytes: 1048576,
  maxConcurrent: 2,
  executionTimeoutMillis: 10000,
  drainTimeoutMillis: 1000,
};
const at = 1790090000000;
const row = (uid = 0, stamp = at) => ({
  netuid: 1,
  uid,
  hotkey: `hotkey-${uid}`,
  coldkey: "owner",
  captured_at: stamp,
  active: true,
  axon: "a\0b",
  stake_tao: 1.5,
});
const current = (
  rows: Record<string, unknown>[] = [row()],
): NeuronMirrorInput => ({ rows, dailyRows: [], positionRows: [] });
const capture = (
  rows: Record<string, unknown>[] = [row()],
  expectedRows = rows.length,
): NeuronMirrorInput => ({
  ...neuronSnapshotWrite(rows, at + 100),
  pass: {
    capturedAt: at,
    expectedRows,
    receivedRows: rows.length,
    nowMs: at + 100,
  },
});
interface Hooks {
  beforeTransaction?: () => Promise<void>;
  beforeQuery?: (text: string) => Promise<void>;
  first?: (text: string, value: unknown) => unknown;
  afterTransaction?: () => void;
}
function runtime(hooks: Hooks = {}) {
  const transaction: PgTransactionRunner = async (callback, configuration) => {
    assert.deepEqual(configuration, { isolation: "read committed" });
    await hooks.beforeTransaction?.();
    const value = await db.transaction(async (tx) => {
      const query = async <Row>(text: string, values: unknown[] = []) => {
        await hooks.beforeQuery?.(text);
        return (await tx.query<Row>(toPositionalPlaceholders(text), values))
          .rows;
      };
      return callback({
        query,
        first: async <Row>(text: string, values?: unknown[]) => {
          const value = (await query<Row>(text, values))[0] ?? null;
          return (hooks.first ? hooks.first(text, value) : value) as Row | null;
        },
        run: async (text, values = []) => {
          await hooks.beforeQuery?.(text);
          return {
            changes:
              (await tx.query(toPositionalPlaceholders(text), values))
                .affectedRows ?? 0,
          };
        },
      });
    });
    hooks.afterTransaction?.();
    return value;
  };
  return { transaction };
}
function writer(
  overrides: Partial<PgNeuronCaptureOptions> = {},
  hooks: Hooks = {},
) {
  const value = createPgNeuronCaptureStore(runtime(hooks), decoder, {
    ...options,
    ...overrides,
  });
  writers.push(value);
  return value;
}
async function count(table: string) {
  return (
    await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM app.${table}`)
  ).rows[0].n;
}
async function seedDocument(json: string, stamp = at + 1000, shard = 0) {
  const payload = decoder.encode(json),
    value = prepareNeuronDocument(decoder, "neurons_documents", payload);
  await db.transaction(async (tx) => {
    await tx.query(
      `INSERT INTO app.neuron_document_projections(source_table,netuid,day,shard,payload_sha256,payload_json,decode_status,decode_error,axon_values,decoder_version,decoder_source_id)
      VALUES('neurons_documents',1,'',$1,$2,$3,$4,$5,$6::json,$7,$8)
      ON CONFLICT(source_table,netuid,day,shard) DO UPDATE SET payload_sha256=excluded.payload_sha256,payload_json=excluded.payload_json,decode_status=excluded.decode_status,decode_error=excluded.decode_error,axon_values=excluded.axon_values,decoder_version=excluded.decoder_version,decoder_source_id=excluded.decoder_source_id`,
      [
        shard,
        value.payloadSha256,
        value.json,
        value.decodeStatus,
        value.decodeError,
        JSON.stringify(value.axonValues),
        value.decoderVersion,
        value.decoderSourceId,
      ],
    );
    await tx.query(
      "INSERT INTO app.neurons_documents(netuid,day,shard,stamp,payload) VALUES(1,'',$1,$2,$3) ON CONFLICT(netuid,day,shard) DO UPDATE SET stamp=excluded.stamp,payload=excluded.payload",
      [shard, stamp, payload],
    );
  });
}

beforeAll(async () => {
  db = new PGlite();
  decoder = createSqliteDocumentDecoder({ maxAuditBytes: 1048576 });
  for (const name of [
    "0024_neuron_documents.sql",
    "0022_closed_day_revisions.sql",
  ])
    await db.exec(
      readFileSync(
        new URL(`../migrations/postgres/${name}`, import.meta.url),
        "utf8",
      ),
    );
  await db.transaction(async (tx) => {
    for (const name of [
      "0025_neuron_documents_activate.sql",
      "0027_closed_day_revisions_activate.sql",
    ])
      await tx.exec(
        readFileSync(
          new URL(`../migrations/postgres/${name}`, import.meta.url),
          "utf8",
        ),
      );
  });
});
beforeEach(async () => {
  await db.exec(
    "TRUNCATE app.neurons_documents,app.neurons_members,app.neuron_daily_documents,app.neuron_daily_members,app.account_position_daily_documents,app.account_position_daily_members,app.neuron_document_projections,app.neurons_capture_batches,app.neurons_passes,app.archive_export_revisions",
  );
});
afterEach(async () => {
  await Promise.all(writers.splice(0).map((value) => value.close()));
});
afterAll(async () => {
  decoder.close();
  await db.close();
});

test("writes all families atomically, replays receipts, and retains newer members", async () => {
  const w = writer();
  assert.equal(w.state, "ready");
  const first = capture([row(0), row(256)]);
  assert.ok((await w.write(first)) > 1);
  for (const name of [
    "neurons_documents",
    "neuron_daily_documents",
    "account_position_daily_documents",
    "neurons_members",
    "neuron_daily_members",
    "account_position_daily_members",
  ])
    assert.ok((await count(name)) > 0, name);
  assert.equal(await count("neurons_capture_batches"), 1);
  await w.write(first);
  assert.equal(
    (
      await db.query<{ n: number }>(
        "SELECT received_rows::int AS n FROM app.neurons_passes",
      )
    ).rows[0].n,
    2,
  );
  await assert.rejects(
    w.write({ ...first, rows: [{ ...row(0), hotkey: "changed" }, row(256)] }),
    /not acknowledged/,
  );
  await w.write(current([{ ...row(0, at + 2000), hotkey: "new-owner" }]));
  await w.write(current([{ ...row(0), hotkey: "stale-owner" }]));
  assert.equal(
    (
      await db.query<{ hotkey: string }>(
        "SELECT hotkey FROM app.neurons_members WHERE uid=0",
      )
    ).rows[0].hotkey,
    "new-owner",
  );
  await w.write(current([row(1)]));
  assert.equal(
    (
      await db.query<{ stamp: string }>(
        "SELECT stamp::text FROM app.neurons_documents WHERE shard=0",
      )
    ).rows[0].stamp,
    String(at + 2000),
  );
  await w.close();
  assert.equal(w.state, "closed");
  await assert.rejects(w.write(current()), /closed/);
});

test("preserves duplicate source-key member order and refuses invalid imported identity scalars", async () => {
  const w = writer();
  await seedDocument(
    `{"0":{"netuid":1,"uid":0,"hotkey":"first","captured_at":${at + 1000}},"0":{"netuid":1,"uid":0,"hotkey":"last","captured_at":${at + 1000}}}`,
  );
  await w.write(current());
  assert.deepEqual(
    (await db.query("SELECT hotkey FROM app.neurons_members")).rows,
    [{ hotkey: "last" }],
  );
  for (const bad of [
    { netuid: "bad", uid: 0 },
    { netuid: 1, uid: "bad" },
  ]) {
    await seedDocument(
      JSON.stringify({
        "0": { ...bad, hotkey: "invalid", captured_at: at + 1000 },
      }),
    );
    await assert.rejects(w.write(current()), /identity is not an integer/);
  }
});

test("prunes only stale current entries and enforces bounded document scans", async () => {
  const w = writer();
  await w.write(current([row(0), row(256, at + 2000)]));
  await w.write({
    ...current([]),
    netuidMaxCapturedAt: new Map([
      [1, at + 1000],
      [99, at + 1000],
    ]),
  });
  assert.deepEqual(
    (
      await db.query(
        "SELECT uid::int AS uid FROM app.neurons_members ORDER BY uid",
      )
    ).rows,
    [{ uid: 256 }],
  );
  await w.write({
    ...current([]),
    netuidMaxCapturedAt: new Map([[1, at + 1000]]),
  });
  await assert.rejects(
    writer({ maxDocuments: 1 }).write({
      ...current([]),
      netuidMaxCapturedAt: new Map([[1, at + 1000]]),
    }),
    /prune exceeds/,
  );
  await assert.rejects(
    writer(
      {},
      {
        first: (text, value) =>
          text.startsWith("SELECT payload FROM app.neurons_documents")
            ? null
            : value,
      },
    ).write({ ...current([]), netuidMaxCapturedAt: new Map([[1, at + 1000]]) }),
    /disappeared/,
  );
});

test("rolls back earlier families and receipts on a later SQL failure", async () => {
  await db.exec(
    "CREATE FUNCTION app.reject_test_capture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture rejected history'; END $$; CREATE TRIGGER reject_test_capture BEFORE INSERT ON app.account_position_daily_documents FOR EACH ROW EXECUTE FUNCTION app.reject_test_capture()",
  );
  try {
    await assert.rejects(writer().write(capture()), /fixture rejected history/);
    for (const name of [
      "neurons_documents",
      "neuron_daily_documents",
      "neurons_capture_batches",
      "neurons_passes",
    ])
      assert.equal(await count(name), 0, name);
  } finally {
    await db.exec(
      "DROP TRIGGER reject_test_capture ON app.account_position_daily_documents; DROP FUNCTION app.reject_test_capture()",
    );
  }
});

test("retains receipt idempotency after an uncertain commit and after receipt pruning", async () => {
  let fail = true;
  const w = writer(
    {},
    {
      afterTransaction: () => {
        if (fail) {
          fail = false;
          throw new Error("lost commit reply");
        }
      },
    },
  );
  await assert.rejects(w.write(capture()), /lost commit reply/);
  await w.write(capture());
  assert.equal(
    (
      await db.query<{ n: number }>(
        "SELECT received_rows::int AS n FROM app.neurons_passes",
      )
    ).rows[0].n,
    1,
  );
  await db.exec("DELETE FROM app.neurons_capture_batches");
  await w.write(capture());
  assert.equal(await count("neurons_capture_batches"), 0);
  assert.equal(
    (
      await db.query<{ n: number }>(
        "SELECT received_rows::int AS n FROM app.neurons_passes",
      )
    ).rows[0].n,
    1,
  );
});

test("refuses corrupted acknowledgements and incomplete completed-pass evidence", async () => {
  const ack = "SELECT sha256,applied FROM app.neurons_capture_batches";
  const incomplete = capture([row()], 2);
  const { digest } = neuronCaptureIdentity(incomplete.pass!, incomplete.rows);
  for (const replacement of [
    null,
    { sha256: "wrong", applied: false },
    { sha256: digest, applied: false },
  ]) {
    const w = writer(
      {},
      { first: (text, value) => (text.startsWith(ack) ? replacement : value) },
    );
    await assert.rejects(w.write(incomplete), /not acknowledged/);
    assert.equal(await count("neurons_documents"), 0);
  }
  const w = writer();
  await w.write(capture());
  await db.exec("DELETE FROM app.neurons_capture_batches");
  for (const change of [
    "received_rows=0",
    "received_rows=1,completed_at=captured_at-1",
  ]) {
    await db.exec(`UPDATE app.neurons_passes SET ${change}`);
    await assert.rejects(w.write(capture()), /not acknowledged/);
  }
  await db.exec(
    "UPDATE app.neurons_passes SET received_rows=1,completed_at=captured_at+100",
  );
  const absent = writer(
    {},
    {
      first: (text, value) =>
        text.startsWith("SELECT expected_rows::text") ? null : value,
    },
  );
  await assert.rejects(absent.write(capture()), /not acknowledged/);
});

test("validates constructor, input and payload bounds before opening SQL transactions", async () => {
  for (const [name, maximum] of [
    ["maxRows", 50000],
    ["maxDocuments", 4096],
    ["maxPayloadBytes", 64 * 1024 * 1024],
    ["maxConcurrent", 4],
  ] as const)
    for (const value of [0, maximum + 1, 0.5])
      assert.throws(() => writer({ [name]: value }), /Invalid neuron capture/);
  assert.throws(
    () => writer({ maxPayloadBytes: 64 * 1024 * 1024, maxConcurrent: 2 }),
    /aggregate buffering/,
  );
  const w = writer({ maxRows: 1 });
  assert.equal(await w.write(current([])), 1);
  for (const name of ["rows", "dailyRows", "positionRows"])
    for (const value of [null, [row(), row(1)]])
      await assert.rejects(
        w.write({
          ...current([]),
          [name]: value,
        } as unknown as NeuronMirrorInput),
        /row budget/,
      );
  const invalidCutoffs: [number, number][][] = [
    [
      [1, at],
      [2, at],
    ],
    [[1.5, at]],
    [[1, 0]],
  ];
  for (const cutoffs of invalidCutoffs)
    await assert.rejects(
      w.write({ ...current([]), netuidMaxCapturedAt: new Map(cutoffs) }),
      /prune cutoff/,
    );
  for (const pass of [
    { capturedAt: -1, expectedRows: 1, receivedRows: 1, nowMs: at },
    { capturedAt: 0, expectedRows: 1, receivedRows: 1, nowMs: at },
    { capturedAt: at, expectedRows: -1, receivedRows: 1, nowMs: at },
    { capturedAt: at, expectedRows: 1, receivedRows: -1, nowMs: at },
    { capturedAt: at, expectedRows: 1, receivedRows: 1, nowMs: -1 },
  ])
    await assert.rejects(w.write({ ...current([]), pass }), /pass tally/);
  await assert.rejects(
    writer({ maxDocuments: 1 }).write(current([row(0), row(256)])),
    /document budget/,
  );
  await assert.rejects(
    writer({ maxPayloadBytes: 1 }).write(current()),
    /payload budget/,
  );
  await assert.rejects(
    writer().write(current([{ ...row(), hotkey: "x".repeat(524288) }])),
    /512 KiB/,
  );
  assert.equal(await count("neurons_documents"), 0);
});

test("holds capacity until an aborted or timed-out consumer has really drained", async () => {
  const entered = queueDeferred(),
    release = queueDeferred();
  const w = writer(
    { maxConcurrent: 1 },
    {
      beforeTransaction: async () => {
        entered.resolve();
        await release.promise;
      },
    },
  );
  const controller = new AbortController();
  const pending = w.write(current(), controller.signal);
  await entered.promise;
  assert.throws(() => w.write(current()), /capacity exceeded/);
  controller.abort(new Error("fixture aborted"));
  release.resolve();
  await assert.rejects(pending, /fixture aborted/);
  assert.equal(await count("neurons_documents"), 0);
  const already = new AbortController();
  already.abort(new Error("already aborted"));
  await assert.rejects(w.write(current(), already.signal), /already aborted/);
  const timedEntered = queueDeferred(),
    timedRelease = queueDeferred();
  const timed = writer(
    { maxConcurrent: 1, executionTimeoutMillis: 10 },
    {
      beforeTransaction: async () => {
        timedEntered.resolve();
        await timedRelease.promise;
      },
    },
  );
  const task = timed.write(current());
  await timedEntered.promise;
  await assert.rejects(task, /deadline exceeded/);
  assert.throws(() => timed.write(current()), /capacity exceeded/);
  timedRelease.resolve();
  await timed.close();
  assert.equal(timed.state, "closed");
  assert.equal(await count("neurons_documents"), 0);
});
