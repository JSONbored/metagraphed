import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { after, before, describe, it } from "node:test";
import { Client } from "pg";
import { pg18FixtureUrl } from "./helpers/pg18-fixture.ts";
import {
  createSqliteDocumentDecoder,
  readSqliteValue,
  storeSqliteValue,
} from "../src/sqlite-document-decoder.ts";
import {
  projectAccountDocument,
  projectNeuronDocument,
} from "../src/neuron-document-projection.ts";
import {
  prepareNeuronDocument,
  type NeuronDocumentTable,
} from "../src/neuron-document-preparation.ts";

const sourceObjects = JSON.parse(
  readFileSync(
    new URL("../generated/db/d1-schema.json", import.meta.url),
    "utf8",
  ),
) as {
  type: string;
  name: string;
  tbl_name: string;
  sql: string;
}[];
const names = [
  "_audit_neuron_docs_20260922",
  "_audit_neuron_members_20260922",
  "neurons_documents",
  "neurons_members",
  "neuron_daily_documents",
  "neuron_daily_members",
  "account_position_daily_documents",
  "account_position_daily_members",
  "neurons_capture_batches",
  "neurons_passes",
];
const source = new DatabaseSync(":memory:");
const control = new Client({
  connectionString: pg18FixtureUrl().toString(),
  connectionTimeoutMillis: 2000,
  statement_timeout: 5000,
});
const decoder = createSqliteDocumentDecoder({ maxAuditBytes: 2 * 1024 * 1024 });
let ownApp = false;
const binary = (text: string) =>
  source.prepare("SELECT jsonb(?) AS value").get(text)!.value as Uint8Array;
const migration = (name: string) =>
  readFileSync(
    new URL(`../migrations/postgres/${name}`, import.meta.url),
    "utf8",
  );
async function transaction(operation: () => Promise<void>) {
  await control.query("BEGIN");
  try {
    await operation();
    await control.query("COMMIT");
  } catch (error) {
    await control.query("ROLLBACK");
    throw error;
  }
}
async function receipt(
  table: NeuronDocumentTable,
  netuid: number,
  day: string,
  shard: number,
  payload: Uint8Array,
) {
  const prepared = prepareNeuronDocument(decoder, table, payload);
  await control.query(
    `INSERT INTO app.neuron_document_projections VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
    ON CONFLICT(source_table,netuid,day,shard) DO UPDATE SET payload_sha256=excluded.payload_sha256,
    payload_json=excluded.payload_json,decode_status=excluded.decode_status,decode_error=excluded.decode_error,axon_values=excluded.axon_values,
    decoder_version=excluded.decoder_version,decoder_source_id=excluded.decoder_source_id`,
    [
      table,
      netuid,
      day,
      shard,
      prepared.payloadSha256,
      prepared.json,
      prepared.decodeStatus,
      prepared.decodeError,
      JSON.stringify(prepared.axonValues),
      prepared.decoderVersion,
      prepared.decoderSourceId,
    ],
  );
}
async function compareEffects() {
  assert.deepEqual(
    (
      await control.query(
        "SELECT table_name,revision::double precision AS revision FROM app.archive_export_revisions ORDER BY table_name",
      )
    ).rows,
    source
      .prepare(
        "SELECT table_name,revision FROM archive_export_revisions ORDER BY table_name",
      )
      .all()
      .map((row) => ({ ...row })),
  );
  const statement = source.prepare(
    "SELECT netuid,uid,snapshot_date,axon_index,axon_indexed FROM neuron_daily_members ORDER BY netuid,uid,snapshot_date",
  );
  statement.setReadBigInts(true);
  assert.deepEqual(
    (
      await control.query(
        "SELECT netuid,uid,snapshot_date,axon_index,axon_indexed FROM app.neuron_daily_members ORDER BY netuid,uid,snapshot_date",
      )
    ).rows.map((row) => ({
      ...row,
      netuid: BigInt(row.netuid),
      uid: BigInt(row.uid),
      axon_index: readSqliteValue(row.axon_index),
      axon_indexed: row.axon_indexed ? 1n : 0n,
    })),
    statement.all().map((row) => ({ ...row })),
  );
}

describe(
  "PostgreSQL document load schema and native projections",
  { concurrency: false },
  () => {
    before(async () => {
      await control.connect();
      assert.equal(
        (await control.query("SHOW server_version_num")).rows[0]
          .server_version_num,
        "180006",
      );
      ownApp =
        (
          await control.query(
            "SELECT oid FROM pg_namespace WHERE nspname='app'",
          )
        ).rowCount === 0;
      await control.query(
        readFileSync(
          new URL(
            "../migrations/postgres/0024_neuron_documents.sql",
            import.meta.url,
          ),
          "utf8",
        ),
      );
      for (const kind of ["table", "index", "view"])
        for (const object of sourceObjects.filter(
          (item) =>
            item.type === kind &&
            (names.includes(item.tbl_name) || kind === "view"),
        ))
          source.exec(object.sql);
    });
    after(async () => {
      try {
        for (const name of [
          ...names,
          "neuron_document_projections",
          "subnet_snapshots",
          "archive_export_revisions",
        ])
          await control.query(`DROP TABLE IF EXISTS app.${name} CASCADE`);
        for (const signature of [
          "sqlite_scalar_number(json)",
          "sqlite_scalar_same(json,json)",
          "neuron_document_lock()",
          "neuron_document_assert(text,bigint,text,bigint)",
          "neuron_document_receipt_check()",
          "neuron_document_source_guard()",
          "neuron_document_receipt_immutable()",
          "neuron_projected_axon(bigint,text,bigint,bigint)",
          "neuron_daily_axon_document()",
          "neuron_daily_axon_member()",
          "archive_export_closed_day()",
          "archive_export_revision_lock()",
          "archive_revision_increment(numeric)",
        ])
          await control.query(
            `DROP FUNCTION IF EXISTS app.${signature} CASCADE`,
          );
        if (ownApp) await control.query("DROP SCHEMA app");
      } finally {
        decoder.close();
        source.close();
        await control.end();
      }
    });

    it("preserves all ten source column orders and fifteen explicit indexes", async () => {
      for (const name of names) {
        const expected = source
          .prepare(`PRAGMA table_info(${name})`)
          .all()
          .map((column) => ({
            name: column.name,
            type:
              column.name === "axon_index"
                ? "json"
                : ["axon_indexed", "applied"].includes(String(column.name))
                  ? "boolean"
                  : (
                      {
                        INTEGER: "bigint",
                        BLOB: "bytea",
                        TEXT: "text",
                      } as Record<string, string>
                    )[String(column.type)],
            nullable: !(column.notnull || column.pk),
          }));
        assert.deepEqual(
          (
            await control.query(
              "SELECT column_name AS name,data_type AS type,is_nullable='YES' AS nullable FROM information_schema.columns WHERE table_schema='app' AND table_name=$1 ORDER BY ordinal_position",
              [name],
            )
          ).rows,
          expected,
        );
      }
      assert.deepEqual(
        (
          await control.query(
            "SELECT indexname AS name FROM pg_indexes WHERE schemaname='app' AND tablename=ANY($1) AND indexname NOT LIKE '%_pkey' ORDER BY indexname",
            [names],
          )
        ).rows,
        sourceObjects
          .filter(
            (item) => item.type === "index" && names.includes(item.tbl_name),
          )
          .map((item) => ({ name: item.name }))
          .sort((a, b) => a.name.localeCompare(b.name)),
      );
    });

    it("retains exact binary JSON, uncapped historical blobs and mixed axon storage", async () => {
      const payload = binary('{"1":{"axon":"a\\u0000b","rank":0.1}}');
      await control.query(
        "INSERT INTO app.neurons_documents VALUES(1,'',0,1000000000000,$1)",
        [payload],
      );
      assert.deepEqual(
        (
          await control.query(
            "SELECT payload FROM app.neurons_documents WHERE netuid=1",
          )
        ).rows[0].payload,
        Buffer.from(payload),
      );
      const audit = Buffer.alloc(600000, 255);
      await control.query(
        "INSERT INTO app._audit_neuron_docs_20260922 VALUES(1,$1,0)",
        [audit],
      );
      assert.deepEqual(
        (
          await control.query(
            "SELECT payload FROM app._audit_neuron_docs_20260922 WHERE netuid=1",
          )
        ).rows[0].payload,
        audit,
      );
      for (const [index, scalar] of [
        null,
        7n,
        0.1,
        "a\0b",
        Buffer.from([0, 255]),
      ].entries()) {
        const encoded = storeSqliteValue(scalar);
        await control.query(
          "INSERT INTO app.neuron_daily_members VALUES(1,$1,'2001-01-01',NULL,NULL,0,$2,false)",
          [index, encoded === null ? null : JSON.stringify(encoded)],
        );
        assert.deepEqual(
          readSqliteValue(
            (
              await control.query(
                "SELECT axon_index FROM app.neuron_daily_members WHERE netuid=1 AND uid=$1",
                [index],
              )
            ).rows[0].axon_index,
          ),
          scalar,
        );
      }
      await assert.rejects(
        control.query(
          "INSERT INTO app.neuron_daily_documents VALUES(1,'',0,1000000000000,$1)",
          [audit],
        ),
        { code: "23514" },
      );
      await assert.rejects(
        control.query(
          "INSERT INTO app.neurons_documents VALUES(2,'',0,999999999999,$1)",
          [payload],
        ),
        { code: "23514" },
      );
    });

    it("projects all four source views with first-key, scalar and account-hex semantics", () => {
      const metric =
        '{"active":true,"validator_permit":false,"rank":0.1,"trust":null,"axon":{"a":1},"stake_tao":9007199254740993,"updated_at":17}';
      const payload = binary(
        `{"2":${metric},"2":{"rank":999},"02":{"rank":888}}`,
      );
      const accountPayload = binary(`{"kC3A9":${metric},"kc3a9":{"rank":999}}`);
      source
        .prepare("INSERT INTO neurons_documents VALUES(1,'',0,1000000000000,?)")
        .run(payload);
      source
        .prepare("INSERT INTO neurons_members VALUES(1,2,'hot','cold',0)")
        .run();
      source
        .prepare(
          "INSERT INTO neuron_daily_documents VALUES(1,'2001-01-01',0,1000000000000,?)",
        )
        .run(payload);
      source
        .prepare(
          "INSERT INTO neuron_daily_members(netuid,uid,snapshot_date,hotkey,coldkey,shard) VALUES(1,2,'2001-01-01','hot','cold',0)",
        )
        .run();
      source
        .prepare("INSERT INTO _audit_neuron_docs_20260922 VALUES(1,?,0)")
        .run(payload);
      source
        .prepare(
          "INSERT INTO _audit_neuron_members_20260922 VALUES(1,2,'hot','cold')",
        )
        .run();
      source
        .prepare(
          "INSERT INTO account_position_daily_documents VALUES(1,'2001-01-01',0,1000000000000,?)",
        )
        .run(accountPayload);
      source
        .prepare(
          "INSERT INTO account_position_daily_members VALUES('é',1,'2001-01-01',0)",
        )
        .run();
      for (const [view, projected] of [
        [
          "neurons",
          projectNeuronDocument(
            decoder,
            { netuid: 1n, uid: 2n, hotkey: "hot", coldkey: "cold" },
            payload,
          ),
        ],
        [
          "neuron_daily",
          projectNeuronDocument(
            decoder,
            {
              netuid: 1n,
              uid: 2n,
              hotkey: "hot",
              coldkey: "cold",
              snapshot_date: "2001-01-01",
            },
            payload,
          ),
        ],
        [
          "_audit_neurons_20260922",
          projectNeuronDocument(
            decoder,
            { netuid: 1n, uid: 2n, hotkey: "hot", coldkey: "cold" },
            payload,
            "audit",
          ),
        ],
        [
          "account_position_daily",
          projectAccountDocument(
            decoder,
            { account: "é", netuid: 1n, snapshot_date: "2001-01-01" },
            accountPayload,
          ),
        ],
      ] as const) {
        const statement = source.prepare(`SELECT * FROM ${view}`);
        statement.setReadBigInts(true);
        assert.deepEqual(projected, { ...statement.get() });
      }
    });

    it("requires matching decoder receipts and original axon projections before activation", async () => {
      await assert.rejects(
        transaction(async () => {
          await control.query(migration("0025_neuron_documents_activate.sql"));
        }),
        { code: "23514" },
      );
      for (const name of names) {
        await control.query(`DELETE FROM app.${name}`);
        source.exec(`DELETE FROM ${name}`);
      }
      await control.query(migration("0022_closed_day_revisions.sql"));
      for (const name of ["subnet_snapshots", "archive_export_revisions"])
        source.exec(
          sourceObjects.find(
            (item) => item.type === "table" && item.name === name,
          )!.sql,
        );
      for (const object of sourceObjects.filter(
        (item) =>
          item.type === "trigger" &&
          [
            "subnet_snapshots",
            "neuron_daily_documents",
            "neuron_daily_members",
            "account_position_daily_documents",
            "account_position_daily_members",
          ].includes(item.tbl_name),
      ))
        source.exec(object.sql);
      const payload = binary('{"1":{"axon":1},"1":{"axon":99}}');
      source
        .prepare(
          "INSERT INTO neuron_daily_documents VALUES(1,'2001-01-01',0,1000000000000,?)",
        )
        .run(payload);
      source
        .prepare(
          "INSERT INTO neuron_daily_members(netuid,uid,snapshot_date,shard) VALUES(1,1,'2001-01-01',0)",
        )
        .run();
      await receipt("neuron_daily_documents", 1, "2001-01-01", 0, payload);
      await control.query(
        "INSERT INTO app.neuron_daily_documents VALUES(1,'2001-01-01',0,1000000000000,$1)",
        [payload],
      );
      await control.query(
        "INSERT INTO app.neuron_daily_members VALUES(1,1,'2001-01-01',NULL,NULL,0,NULL,false)",
      );
      await assert.rejects(
        transaction(async () => {
          await control.query(migration("0025_neuron_documents_activate.sql"));
        }),
        { code: "23514" },
      );
      await control.query(
        "UPDATE app.neuron_daily_members SET axon_index=$1,axon_indexed=true",
        [JSON.stringify(storeSqliteValue(1n))],
      );
      const malformedAudit = Buffer.from([0xff]);
      source
        .prepare("INSERT INTO _audit_neuron_docs_20260922 VALUES(88,?,0)")
        .run(malformedAudit);
      await receipt("_audit_neuron_docs_20260922", 88, "", 0, malformedAudit);
      await control.query(
        "INSERT INTO app._audit_neuron_docs_20260922 VALUES(88,$1,0)",
        [malformedAudit],
      );
      // Import the already-produced source revision values, then install the
      // actual axon effects and all fifteen closed-day effects together.
      for (const row of source
        .prepare("SELECT table_name,revision FROM archive_export_revisions")
        .all())
        await control.query(
          "INSERT INTO app.archive_export_revisions VALUES($1,$2)",
          [row.table_name, row.revision],
        );
      await transaction(async () => {
        await control.query(migration("0025_neuron_documents_activate.sql"));
        await control.query(
          migration("0027_closed_day_revisions_activate.sql"),
        );
      });
      await compareEffects();
      assert.deepEqual(
        (
          await control.query(
            "SELECT decode_status,decode_error,payload_json FROM app.neuron_document_projections WHERE netuid=88",
          )
        ).rows,
        [
          {
            decode_status: "failed",
            decode_error: "invalid-json",
            payload_json: null,
          },
        ],
      );
      assert.deepEqual(
        (
          await control.query(
            "SELECT payload FROM app._audit_neuron_docs_20260922 WHERE netuid=88",
          )
        ).rows[0].payload,
        malformedAudit,
      );
      assert.throws(() =>
        projectNeuronDocument(
          decoder,
          { netuid: 88n, uid: 1n, hotkey: null, coldkey: null },
          malformedAudit,
          "audit",
        ),
      );
      assert.equal(
        (
          await control.query(
            "SELECT count(*)::integer AS count FROM pg_trigger WHERE tgname LIKE '%_closed_day_%' AND NOT tgisinternal",
          )
        ).rows[0].count,
        15,
      );
    });

    it("matches nested axon effects, numeric IS equality and all closed-day trigger families", async () => {
      const writeDocument = async (json: string) => {
        const payload = binary(json);
        source
          .prepare("UPDATE neuron_daily_documents SET payload=? WHERE netuid=1")
          .run(payload);
        await transaction(async () => {
          await receipt("neuron_daily_documents", 1, "2001-01-01", 0, payload);
          await control.query(
            "UPDATE app.neuron_daily_documents SET payload=$1 WHERE netuid=1",
            [payload],
          );
        });
        await compareEffects();
      };
      await writeDocument('{"1":{"axon":1.0}}');
      assert.deepEqual(
        (
          await control.query(
            "SELECT axon_index FROM app.neuron_daily_members WHERE uid=1",
          )
        ).rows[0].axon_index,
        storeSqliteValue(1n),
      );
      await writeDocument('{"1":{"axon":"first"},"1":{"axon":"last"}}');
      await writeDocument('{"1":{"axon":"first","rank":2}}');
      source.exec(
        "INSERT INTO neuron_daily_members(netuid,uid,snapshot_date,shard) VALUES(1,2,'2001-01-01',0)",
      );
      await control.query(
        "INSERT INTO app.neuron_daily_members(netuid,uid,snapshot_date,shard) VALUES(1,2,'2001-01-01',0)",
      );
      await compareEffects();
      source.exec(
        "UPDATE neuron_daily_members SET snapshot_date='2001-01-02',shard=1 WHERE uid=2",
      );
      await control.query(
        "UPDATE app.neuron_daily_members SET snapshot_date='2001-01-02',shard=1 WHERE uid=2",
      );
      await compareEffects();
      source.exec(
        "DELETE FROM neuron_daily_documents; DELETE FROM neuron_daily_members",
      );
      await control.query(
        "DELETE FROM app.neuron_daily_documents; DELETE FROM app.neuron_daily_members",
      );
      await compareEffects();
      for (const operation of [
        "INSERT INTO subnet_snapshots(netuid,snapshot_date) VALUES(2,'2001-02-01')",
        "UPDATE subnet_snapshots SET snapshot_date='2001-02-02'",
        "DELETE FROM subnet_snapshots",
      ]) {
        source.exec(operation);
        await control.query(
          operation.replaceAll("subnet_snapshots", "app.subnet_snapshots"),
        );
        await compareEffects();
      }
      const payload = binary('{"k61":{"axon":"unused"}}');
      source
        .prepare(
          "INSERT INTO account_position_daily_documents VALUES(1,'2001-03-01',0,1000000000000,?)",
        )
        .run(payload);
      await transaction(async () => {
        await receipt(
          "account_position_daily_documents",
          1,
          "2001-03-01",
          0,
          payload,
        );
        await control.query(
          "INSERT INTO app.account_position_daily_documents VALUES(1,'2001-03-01',0,1000000000000,$1)",
          [payload],
        );
      });
      await compareEffects();
      for (const operation of [
        "INSERT INTO account_position_daily_members VALUES('a',1,'2001-03-01',0)",
        "UPDATE account_position_daily_members SET snapshot_date='2001-03-02'",
        "DELETE FROM account_position_daily_members",
      ]) {
        source.exec(operation);
        await control.query(
          operation.replaceAll(
            "account_position_daily_members",
            "app.account_position_daily_members",
          ),
        );
        await compareEffects();
      }
      source.exec("UPDATE account_position_daily_documents SET stamp=stamp+1");
      await control.query(
        "UPDATE app.account_position_daily_documents SET stamp=stamp+1",
      );
      await compareEffects();
      source.exec("DELETE FROM account_position_daily_documents");
      await control.query("DELETE FROM app.account_position_daily_documents");
      await compareEffects();
    });

    it("rejects stale receipts atomically and preserves numeric scalar equivalence", async () => {
      const payload = binary('{"7":{"axon":"seven"}}');
      await assert.rejects(
        control.query(
          "INSERT INTO app.neuron_daily_documents VALUES(7,'2001-01-01',0,1000000000000,$1)",
          [payload],
        ),
        { code: "23514" },
      );
      await transaction(async () => {
        await receipt("neuron_daily_documents", 7, "2001-01-01", 0, payload);
        await control.query(
          "INSERT INTO app.neuron_daily_documents VALUES(7,'2001-01-01',0,1000000000000,$1)",
          [payload],
        );
      });
      await assert.rejects(
        transaction(async () => {
          await control.query(
            "DELETE FROM app.neuron_document_projections WHERE netuid=7",
          );
        }),
        { code: "23514" },
      );
      await assert.rejects(
        control.query(
          "UPDATE app.neuron_document_projections SET payload_json='{}' WHERE netuid=7",
        ),
        { code: "23514" },
      );
      for (const [left, right] of [
        [1n, 1],
        [0n, -0],
        [9223372036854775807n, 9223372036854775808],
        [null, null],
        ["1", 1n],
        [Infinity, Infinity],
        [0.1, 0.1],
      ] as const) {
        const expected =
          source.prepare("SELECT ? IS ? AS same").get(left, right)!.same === 1;
        const observed = (
          await control.query(
            "SELECT app.sqlite_scalar_same($1::json,$2::json) AS same",
            [
              JSON.stringify(storeSqliteValue(left)),
              JSON.stringify(storeSqliteValue(right)),
            ],
          )
        ).rows[0].same;
        assert.equal(observed, expected);
      }
      await control.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
      await assert.rejects(
        control.query("DELETE FROM app.neuron_daily_documents"),
        { code: "25000" },
      );
      await control.query("ROLLBACK");
    });
  },
);
