import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { after, before, beforeEach, describe, it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { Client, type QueryResult } from "pg";
import { toPositionalPlaceholders } from "../src/pg-sql.ts";
import { pg18FixtureUrl } from "./helpers/pg18-fixture.ts";

const names = [
  "raw_capture_budget",
  "raw_capture_batches",
  "raw_capture_chunks",
  "raw_capture_selected",
  "raw_capture_archives",
  "raw_capture_publications",
  "raw_capture_state",
];
const lockTables = names.filter(
  (name) => !["raw_capture_publications", "raw_capture_state"].includes(name),
);
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
const source = new DatabaseSync(":memory:");
source.exec("PRAGMA foreign_keys=ON");
const clientOptions = {
  connectionString: pg18FixtureUrl().toString(),
  connectionTimeoutMillis: 2000,
  statement_timeout: 5000,
};
const control = new Client(clientOptions);
const migration = (name: string) =>
  readFileSync(
    new URL(`../migrations/postgres/${name}`, import.meta.url),
    "utf8",
  );
let ownApp = false;
const digest = "a".repeat(64);
const compressedDigest = "b".repeat(64);
const batchSql =
  "INSERT INTO app.raw_capture_batches(key,sha256,network,first_block,last_block,raw_bytes,compressed_bytes,compressed_sha256,parts,captured_at,complete) VALUES (?,?,?,?,?,?,?,?,?,?,?)";
const archiveSql =
  "INSERT INTO app.raw_capture_archives(key,sha256,network,first_block,last_block,raw_bytes,compressed_bytes,compressed_sha256,parts,captured_at,complete,selected,native_key,native_etag,native_sha256) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)";
const batchValues = (key: string, sha = digest, bytes = 4) => [
  key,
  sha,
  "mainnet",
  1,
  2,
  10,
  bytes,
  compressedDigest,
  1,
  1,
  true,
];
const archiveValues = (key: string, sha = digest, selected = true) => [
  ...batchValues(key, sha),
  selected,
  "native-object",
  "c".repeat(32),
  compressedDigest,
];

async function both(
  sql: string,
  values: (string | number | boolean | Buffer)[] = [],
) {
  source
    .prepare(sql.replaceAll("app.", ""))
    .run(
      ...values.map((value) =>
        typeof value === "boolean" ? Number(value) : value,
      ),
    );
  await control.query(toPositionalPlaceholders(sql), values);
}

async function activate() {
  await control.query("BEGIN");
  try {
    await control.query(migration("0019_raw_capture_activate.sql"));
    await control.query("COMMIT");
  } catch (error) {
    await control.query("ROLLBACK");
    throw error;
  }
}

async function stage(key: string, sha = digest, selected = true) {
  await both(batchSql, batchValues(key, sha));
  await both("INSERT INTO app.raw_capture_chunks VALUES (?,?,0,?)", [
    key,
    sha,
    Buffer.from([0, 1, 128, 255]),
  ]);
  if (selected)
    await both(
      "INSERT INTO app.raw_capture_selected VALUES (?,?,'mainnet',2,1)",
      [key, sha],
    );
}

async function compareSource() {
  assert.deepEqual(
    (
      await control.query(
        "SELECT bytes::integer,objects::integer FROM app.raw_capture_budget",
      )
    ).rows,
    source
      .prepare("SELECT bytes,objects FROM raw_capture_budget")
      .all()
      .map((row) => ({ ...row })),
  );
  for (const name of names.filter((name) => name !== "raw_capture_budget")) {
    assert.equal(
      (await control.query(`SELECT count(*)::integer AS n FROM app.${name}`))
        .rows[0].n,
      source.prepare(`SELECT count(*) AS n FROM ${name}`).get()?.n,
      name,
    );
  }
  assert.deepEqual(
    (
      await control.query(
        "SELECT key,sha256,selected::integer FROM app.raw_capture_archives ORDER BY key,sha256",
      )
    ).rows,
    source
      .prepare(
        "SELECT key,sha256,selected FROM raw_capture_archives ORDER BY key,sha256",
      )
      .all()
      .map((row) => ({ ...row })),
  );
}

async function waitForLock(pid: number) {
  for (let attempt = 0; attempt < 50; attempt++) {
    const row = (
      await control.query(
        "SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1",
        [pid],
      )
    ).rows[0];
    if (row?.wait_event_type === "Lock") return;
    await delay(20);
  }
  assert.fail("competing raw-capture transaction did not reach its lock");
}

describe(
  "raw-capture PostgreSQL load and trigger semantics",
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
      await control.query(migration("0018_raw_capture.sql"));
      for (const object of sourceObjects.filter(
        (item) => item.type === "table" && names.includes(item.name),
      ))
        source.exec(object.sql);
      for (const object of sourceObjects.filter(
        (item) => item.type !== "table" && names.includes(item.tbl_name),
      ))
        source.exec(object.sql);
    });
    beforeEach(async () => {
      for (const name of lockTables)
        await control.query(
          `DROP TRIGGER IF EXISTS raw_capture_lock ON app.${name}`,
        );
      await control.query(
        "DROP TRIGGER IF EXISTS raw_capture_reserve ON app.raw_capture_batches; DROP TRIGGER IF EXISTS raw_capture_release ON app.raw_capture_batches; DROP TRIGGER IF EXISTS raw_capture_archive_source ON app.raw_capture_archives; DROP TRIGGER IF EXISTS raw_capture_archive_release ON app.raw_capture_archives",
      );
      await control.query(
        "ALTER TABLE app.raw_capture_chunks DROP CONSTRAINT IF EXISTS raw_capture_chunks_batch_fkey; ALTER TABLE app.raw_capture_selected DROP CONSTRAINT IF EXISTS raw_capture_selected_batch_fkey",
      );
      await control.query(
        `TRUNCATE ${names.map((name) => `app.${name}`).join(",")}`,
      );
      await control.query("INSERT INTO app.raw_capture_budget(id) VALUES(1)");
      source.exec(
        "DELETE FROM raw_capture_archives; DELETE FROM raw_capture_selected; DELETE FROM raw_capture_batches; DELETE FROM raw_capture_publications; DELETE FROM raw_capture_state; DELETE FROM raw_capture_budget; INSERT INTO raw_capture_budget(id) VALUES(1)",
      );
    });
    after(async () => {
      try {
        for (const name of [
          "raw_capture_selected",
          "raw_capture_chunks",
          ...names.filter(
            (name) =>
              !["raw_capture_selected", "raw_capture_chunks"].includes(name),
          ),
        ])
          await control.query(`DROP TABLE IF EXISTS app.${name}`);
        await control.query(
          "DROP FUNCTION app.raw_capture_lock(); DROP FUNCTION app.raw_capture_reserve(); DROP FUNCTION app.raw_capture_release(); DROP FUNCTION app.raw_capture_archive_source(); DROP FUNCTION app.raw_capture_archive_release()",
        );
        if (ownApp) await control.query("DROP SCHEMA app");
      } finally {
        source.close();
        await control.end();
      }
    });

    it("preserves all source columns, two indexes and bytea chunks", async () => {
      for (const name of names) {
        const expected = source
          .prepare(`PRAGMA table_info(${name})`)
          .all()
          .map((column) => ({
            name: column.name,
            type: ["complete", "selected"].includes(String(column.name))
              ? "boolean"
              : (
                  { INTEGER: "bigint", TEXT: "text", BLOB: "bytea" } as Record<
                    string,
                    string
                  >
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
          name,
        );
      }
      const expected = sourceObjects
        .filter(
          (item) => item.type === "index" && names.includes(item.tbl_name),
        )
        .map((item) => item.name)
        .sort();
      assert.equal(expected.length, 2);
      assert.deepEqual(
        (
          await control.query(
            "SELECT indexname FROM pg_indexes WHERE schemaname='app' AND tablename=ANY($1) AND indexname NOT LIKE '%_pkey' ORDER BY indexname",
            [names],
          )
        ).rows.map((row) => row.indexname),
        expected,
      );
      await control.query(
        "INSERT INTO app.raw_capture_chunks VALUES ('k','s',0,$1)",
        [Buffer.from([0, 1, 128, 255])],
      );
      assert.deepEqual(
        (await control.query("SELECT data FROM app.raw_capture_chunks")).rows[0]
          .data,
        Buffer.from([0, 1, 128, 255]),
      );
    });

    it("validates imported accounting and foreign keys while retaining archived rows without sources", async () => {
      await control.query(
        toPositionalPlaceholders(archiveSql),
        archiveValues("already-archived"),
      );
      await control.query("UPDATE app.raw_capture_budget SET bytes=1");
      await assert.rejects(activate(), { code: "23514" });
      await control.query("UPDATE app.raw_capture_budget SET bytes=0");
      await control.query(
        "INSERT INTO app.raw_capture_chunks VALUES ('missing','s',0,$1)",
        [Buffer.from([1])],
      );
      await assert.rejects(activate(), { code: "23503" });
      await control.query("DELETE FROM app.raw_capture_chunks");
      await activate();
      assert.equal(
        (
          await control.query(
            "SELECT count(*)::integer AS n FROM app.raw_capture_archives",
          )
        ).rows[0].n,
        1,
      );
      await assert.rejects(
        control.query(
          "INSERT INTO app.raw_capture_selected VALUES ('missing','s','mainnet',1,1)",
        ),
        { code: "23503" },
      );
    });

    it("matches source reservation, archive release and selection transitions", async () => {
      await activate();
      await stage("capture", "1".repeat(64));
      await both(archiveSql, archiveValues("capture", "1".repeat(64)));
      await compareSource();
      await stage("capture", "2".repeat(64));
      await both(archiveSql, archiveValues("capture", "2".repeat(64)));
      await compareSource();
      await stage("capture", "3".repeat(64), false);
      await both(archiveSql, archiveValues("capture", "3".repeat(64), false));
      await compareSource();
      assert.deepEqual(
        (
          await control.query(
            "SELECT sha256 FROM app.raw_capture_archives WHERE selected",
          )
        ).rows,
        [{ sha256: "2".repeat(64) }],
      );
    });

    it("rejects a changed archive source and rolls back an archive with all accounting effects", async () => {
      await activate();
      await stage("capture");
      const changed = archiveValues("capture");
      changed[6] = 3;
      await assert.rejects(
        control.query(toPositionalPlaceholders(archiveSql), changed),
        { code: "23514" },
      );
      await compareSource();
      await control.query("BEGIN");
      await control.query(
        toPositionalPlaceholders(archiveSql),
        archiveValues("capture"),
      );
      await control.query("ROLLBACK");
      await compareSource();
      assert.equal(
        (
          await control.query(
            "SELECT count(*)::integer AS n FROM app.raw_capture_chunks",
          )
        ).rows[0].n,
        1,
      );
    });

    it("keeps source bounds and uniqueness with exact failed-statement rollback", async () => {
      await activate();
      await stage("capture", digest, false);
      for (const sql of [
        "INSERT INTO app.raw_capture_budget VALUES (2,0,0)",
        "INSERT INTO app.raw_capture_chunks VALUES ('capture','" +
          digest +
          "',513,decode('00','hex'))",
        "INSERT INTO app.raw_capture_chunks VALUES ('capture','" +
          digest +
          "',1,decode('','hex'))",
        "INSERT INTO app.raw_capture_publications VALUES ('k','short','short',NULL)",
      ])
        await assert.rejects(control.query(sql), { code: "23514" });
      await assert.rejects(
        control.query(
          toPositionalPlaceholders(batchSql),
          batchValues("capture"),
        ),
        { code: "23505" },
      );
      await compareSource();
    });

    it("serializes concurrent reservations so only one can cross the remaining budget", async () => {
      await activate();
      for (let index = 0; index < 15; index++)
        await control.query(
          toPositionalPlaceholders(batchSql),
          batchValues(`large-${index}`, digest, 33619968),
        );
      const writer = new Client(clientOptions);
      await writer.connect();
      const pid = (await writer.query("SELECT pg_backend_pid() AS pid")).rows[0]
        .pid;
      await control.query("BEGIN");
      let committed = false;
      let pending: Promise<QueryResult> | undefined;
      try {
        await control.query(
          toPositionalPlaceholders(batchSql),
          batchValues("winner", digest, 20000000),
        );
        pending = writer.query(
          toPositionalPlaceholders(batchSql),
          batchValues("loser", digest, 20000000),
        );
        void pending.catch(() => {});
        await waitForLock(pid);
        await control.query("COMMIT");
        committed = true;
        await assert.rejects(pending, { code: "23514" });
        assert.deepEqual(
          (
            await control.query(
              "SELECT bytes::integer,objects::integer FROM app.raw_capture_budget",
            )
          ).rows,
          [{ bytes: 524299520, objects: 16 }],
        );
        assert.equal(
          (
            await control.query(
              "SELECT count(*)::integer AS n FROM app.raw_capture_batches WHERE key='loser'",
            )
          ).rows[0].n,
          0,
        );
      } finally {
        if (!committed) await control.query("ROLLBACK");
        await pending?.catch(() => {});
        await writer.end();
      }
    });

    it("serializes archive release against a concurrent delete without double-releasing", async () => {
      await activate();
      await stage("capture");
      const writer = new Client(clientOptions);
      await writer.connect();
      const pid = (await writer.query("SELECT pg_backend_pid() AS pid")).rows[0]
        .pid;
      await control.query("BEGIN");
      let committed = false;
      let pending: Promise<QueryResult> | undefined;
      try {
        await control.query(
          toPositionalPlaceholders(archiveSql),
          archiveValues("capture"),
        );
        pending = writer.query(
          "DELETE FROM app.raw_capture_batches WHERE key='capture'",
        );
        void pending.catch(() => {});
        await waitForLock(pid);
        await control.query("COMMIT");
        committed = true;
        assert.equal((await pending).rowCount, 0);
        assert.deepEqual(
          (
            await control.query(
              "SELECT bytes::integer,objects::integer FROM app.raw_capture_budget",
            )
          ).rows,
          [{ bytes: 0, objects: 0 }],
        );
        assert.equal(
          (
            await control.query(
              "SELECT count(*)::integer AS n FROM app.raw_capture_archives",
            )
          ).rows[0].n,
          1,
        );
      } finally {
        if (!committed) await control.query("ROLLBACK");
        await pending?.catch(() => {});
        await writer.end();
      }
    });
  },
);
