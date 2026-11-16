import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { before, beforeEach, after, describe, it } from "node:test";
import { Client } from "pg";
import {
  createPgStoreRuntime,
  type PgStoreRuntime,
} from "../src/pg-store-runtime.ts";
import {
  createSqliteDocumentDecoder,
  readSqliteValue,
} from "../src/sqlite-document-decoder.ts";
import { createPgNeuronCaptureStore } from "../src/pg-neuron-capture.ts";
import {
  neuronDocumentStatements,
  groupNeuronDocuments,
  neuronCaptureDocumentSize,
} from "../src/neuron-documents.ts";
import { NEURON_INSERT_COLUMNS } from "../src/metagraph-neurons.ts";
import {
  neuronSnapshotWrite,
  type NeuronMirrorInput,
} from "../src/neurons-neon-write.ts";
import { pg18FixtureUrl } from "./helpers/pg18-fixture.ts";

const connectionString = pg18FixtureUrl().toString();
const control = new Client({
  connectionString,
  connectionTimeoutMillis: 2000,
  statement_timeout: 5000,
});
const source = new DatabaseSync(":memory:");
const decoder = createSqliteDocumentDecoder({ maxAuditBytes: 1024 * 1024 });
let runtime: PgStoreRuntime;
let writer: ReturnType<typeof createPgNeuronCaptureStore>;
let ownsApp = false;
const names = [
  "neurons_documents",
  "neurons_members",
  "neuron_daily_documents",
  "neuron_daily_members",
  "account_position_daily_documents",
  "account_position_daily_members",
  "neurons_capture_batches",
  "neurons_passes",
];
const at = 1_790_090_000_000;
const rows = (stamp = at) => [
  {
    netuid: 1,
    uid: 0,
    hotkey: "5First",
    coldkey: "5Owner",
    captured_at: stamp,
    active: true,
    axon: "a\0b",
    stake_tao: 1.5,
  },
  {
    netuid: 1,
    uid: 256,
    hotkey: "5Second",
    coldkey: null,
    captured_at: stamp,
    active: false,
    stake_tao: 20,
  },
];
const capture = (data: Record<string, unknown>[] = rows(), stamp = at) => ({
  ...neuronSnapshotWrite(data, stamp + 100),
  pass: {
    capturedAt: stamp,
    expectedRows: data.length,
    receivedRows: data.length,
    nowMs: stamp + 100,
  },
});
const sql = (name: string) =>
  readFileSync(
    new URL(`../migrations/postgres/${name}`, import.meta.url),
    "utf8",
  );
function applySource(input: NeuronMirrorInput) {
  source.exec("BEGIN");
  try {
    for (const statement of neuronDocumentStatements(input))
      source
        .prepare(statement.text)
        .run(...((statement.values ?? []) as SQLInputValue[]));
    source.exec("COMMIT");
  } catch (error) {
    source.exec("ROLLBACK");
    throw error;
  }
}
async function compare() {
  for (const family of ["neurons", "neuron_daily", "account_position_daily"]) {
    const columns = "netuid,day,shard,stamp";
    const expected = source
      .prepare(
        `SELECT ${columns},lower(hex(payload)) AS payload FROM ${family}_documents ORDER BY netuid,day,shard`,
      )
      .all();
    const actual = (
      await control.query(
        `SELECT netuid::double precision AS netuid,day,shard::double precision AS shard,stamp::double precision AS stamp,encode(payload,'hex') AS payload FROM app.${family}_documents ORDER BY netuid,day,shard`,
      )
    ).rows;
    assert.deepEqual(
      actual,
      expected.map((value) => ({ ...value })),
      family,
    );
  }
  for (const table of [
    "neurons_members",
    "neuron_daily_members",
    "account_position_daily_members",
    "neurons_capture_batches",
    "neurons_passes",
    "archive_export_revisions",
  ]) {
    const expected = source
      .prepare(
        `SELECT *${table === "neuron_daily_members" ? ",typeof(axon_index) AS axon_storage,CASE WHEN typeof(axon_index)='text' THEN CAST(axon_index AS BLOB) ELSE axon_index END AS axon_preserved" : ""} FROM ${table}`,
      )
      .all()
      .map((value) => {
        const result = { ...value };
        if (table === "neuron_daily_members") {
          result.axon_index =
            result.axon_storage === "text"
              ? new TextDecoder().decode(result.axon_preserved as Uint8Array)
              : result.axon_preserved;
          delete result.axon_storage;
          delete result.axon_preserved;
        }
        return result;
      });
    const actual = (await control.query(`SELECT * FROM app.${table}`)).rows.map(
      (value) =>
        Object.fromEntries(
          Object.entries(value).map(([key, item]) => [
            key,
            key === "axon_index"
              ? readSqliteValue(item)
              : typeof item === "boolean"
                ? Number(item)
                : [
                      "netuid",
                      "uid",
                      "shard",
                      "captured_at",
                      "expected_rows",
                      "received_rows",
                      "completed_at",
                      "revision",
                    ].includes(key) && item !== null
                  ? Number(item)
                  : item,
          ]),
        ),
    );
    const canonical = (value: Record<string, unknown>) =>
      JSON.stringify(
        Object.fromEntries(
          Object.entries(value).sort(([left], [right]) =>
            left.localeCompare(right),
          ),
        ),
      );
    assert.deepEqual(
      actual.map(canonical).sort(),
      expected.map(canonical).sort(),
      table,
    );
  }
}

describe("native neuron capture transactions", { concurrency: false }, () => {
  before(async () => {
    await control.connect();
    assert.equal(
      (await control.query("SHOW server_version_num")).rows[0]
        .server_version_num,
      "180006",
    );
    assert.equal(
      (await control.query("SELECT to_regnamespace('app') AS existing")).rows[0]
        .existing,
      null,
    );
    await control.query(sql("0024_neuron_documents.sql"));
    ownsApp = true;
    await control.query(sql("0022_closed_day_revisions.sql"));
    await control.query("BEGIN");
    try {
      await control.query(sql("0025_neuron_documents_activate.sql"));
      await control.query(sql("0027_closed_day_revisions_activate.sql"));
      await control.query("COMMIT");
    } catch (error) {
      await control.query("ROLLBACK");
      throw error;
    }
    const schema = JSON.parse(
      readFileSync(
        new URL("../generated/db/d1-schema.json", import.meta.url),
        "utf8",
      ),
    ) as { type: string; name: string; tbl_name: string; sql: string }[];
    for (const kind of ["table", "index", "view", "trigger"])
      for (const item of schema.filter(
        (item) =>
          item.type === kind &&
          (names.includes(item.tbl_name) ||
            ["archive_export_revisions", "subnet_snapshots"].includes(
              item.tbl_name,
            ) ||
            kind === "view"),
      ))
        source.exec(item.sql);
    runtime = createPgStoreRuntime({
      connectionString,
      maxConnections: 4,
      connectionTimeoutMillis: 2000,
      idleTimeoutMillis: 1000,
      statementTimeoutMillis: 5000,
      onIdleError(error) {
        throw error;
      },
    });
    writer = createPgNeuronCaptureStore(runtime, decoder, {
      maxRows: 100,
      maxDocuments: 100,
      maxPayloadBytes: 1024 * 1024,
      maxConcurrent: 2,
      executionTimeoutMillis: 10000,
      drainTimeoutMillis: 2000,
    });
  });
  beforeEach(async () => {
    await control.query(
      `TRUNCATE ${[...names, "neuron_document_projections", "archive_export_revisions"].map((name) => `app.${name}`).join(",")}`,
    );
    for (const name of names) source.exec(`DELETE FROM ${name}`);
    source.exec("DELETE FROM archive_export_revisions");
  });
  after(async () => {
    try {
      await writer?.close();
      await runtime?.close();
      if (ownsApp) await control.query("DROP SCHEMA app CASCADE");
    } finally {
      decoder.close();
      source.close();
      await control.end();
    }
  });
  it("matches source bytes, memberships, axon values and revisions through replay, delayed data and prune", async () => {
    const first = capture();
    applySource(first);
    await writer.write(first);
    await compare();
    applySource(first);
    await writer.write(first);
    await compare();
    const update = capture(
      [{ ...rows(at + 1000)[0], hotkey: "5Changed" }],
      at + 1000,
    );
    applySource(update);
    await writer.write(update);
    await compare();
    const delayed = {
      ...capture([{ ...rows()[0], hotkey: "5Stale" }]),
      netuidMaxCapturedAt: null,
    };
    applySource(delayed);
    await writer.write(delayed);
    await compare();
  });
  it("backfills history without changing current membership or pruning", async () => {
    applySource(capture());
    await writer.write(capture());
    const past = neuronSnapshotWrite(rows(at - 86400000), at + 100);
    const backfill = {
      rows: [],
      dailyRows: past.dailyRows,
      positionRows: past.positionRows,
    };
    applySource(backfill);
    await writer.write(backfill);
    await compare();
  });
  it("rolls back all families and receipts when a later write fails", async () => {
    applySource(capture());
    await writer.write(capture());
    await control.query(`CREATE FUNCTION app.reject_capture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture failure'; END $$;
      CREATE TRIGGER reject_capture BEFORE INSERT ON app.account_position_daily_documents FOR EACH ROW EXECUTE FUNCTION app.reject_capture()`);
    try {
      await assert.rejects(
        writer.write(capture(rows(at + 2000), at + 2000)),
        /fixture failure/,
      );
    } finally {
      await control.query(
        "DROP TRIGGER reject_capture ON app.account_position_daily_documents; DROP FUNCTION app.reject_capture()",
      );
    }
    await compare();
  });
  it("does not double-count an uncertain committed write and rejects changed content under its receipt", async () => {
    const input = capture();
    let loseReply = true;
    const uncertain = createPgNeuronCaptureStore(
      {
        transaction: async (operation, options) => {
          const result = await runtime.transaction(operation, options);
          if (loseReply) {
            loseReply = false;
            throw new Error("fixture lost commit response");
          }
          return result;
        },
      },
      decoder,
      {
        maxRows: 100,
        maxDocuments: 100,
        maxPayloadBytes: 1024 * 1024,
        maxConcurrent: 1,
        executionTimeoutMillis: 10000,
        drainTimeoutMillis: 2000,
      },
    );
    try {
      await assert.rejects(uncertain.write(input), /lost commit response/);
      await uncertain.write(input);
      applySource(input);
      await compare();
      const changed = {
        ...input,
        rows: input.rows.map((value) => ({ ...value, hotkey: "5Different" })),
      };
      // Completed receipts intentionally retain the source writer's semantics:
      // an existing receipt mismatch still fails its explicit acknowledgement.
      await assert.rejects(uncertain.write(changed), /acknowledged/);
      await compare();
    } finally {
      await uncertain.close();
    }
  });
  it("serializes competing current captures and refuses a pre-aborted write", async () => {
    const older = capture(rows(at + 1000), at + 1000),
      newer = capture(rows(at + 2000), at + 2000);
    await Promise.all([writer.write(older), writer.write(newer)]);
    const stamps = (
      await control.query(
        "SELECT DISTINCT stamp::text FROM app.neurons_documents",
      )
    ).rows;
    assert.deepEqual(stamps, [{ stamp: String(at + 2000) }]);
    const controller = new AbortController();
    controller.abort(new Error("fixture aborted"));
    await assert.rejects(
      writer.write(capture(), controller.signal),
      /fixture aborted/,
    );
  });
  it("applies the source document-wrapper byte limit before any database work", async () => {
    const base = { ...rows()[0], axon: "" };
    const document = groupNeuronDocuments(
      "neurons",
      [base],
      NEURON_INSERT_COLUMNS,
    )[0]!;
    const baseSize = neuronCaptureDocumentSize(document);
    const value = { ...base, axon: "x".repeat(524286 - baseSize) };
    const input = { rows: [value], dailyRows: [], positionRows: [] };
    assert.doesNotThrow(() => neuronDocumentStatements(input));
    await writer.write(input);
    const oversized = {
      rows: [{ ...value, axon: value.axon + "x" }],
      dailyRows: [],
      positionRows: [],
    };
    assert.throws(() => neuronDocumentStatements(oversized), /exceeds 512 KiB/);
    await assert.rejects(writer.write(oversized), /exceeds 512 KiB/);
    assert.equal(
      (
        await control.query(
          "SELECT count(*)::int AS count FROM app.neurons_documents",
        )
      ).rows[0].count,
      1,
    );
  });
});
