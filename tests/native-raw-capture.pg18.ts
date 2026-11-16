import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { before, after, beforeEach, afterEach, describe, it } from "node:test";
import { Client, Pool } from "pg";
import { Miniflare } from "miniflare";
import { createPgStoreRuntime } from "../src/pg-store-runtime.ts";
import { createPgRawCapture } from "../src/pg-raw-capture.ts";
import { rawCaptureD1 } from "../src/raw-capture-d1.ts";
import { prepareRawCapture } from "../src/raw-capture-object.ts";
import { pg18FixtureUrl } from "./helpers/pg18-fixture.ts";

const schema = "raw_capture_runtime_fixture";
const connectionString = pg18FixtureUrl().toString();
const options = {
  connectionString,
  connectionTimeoutMillis: 2000,
  statement_timeout: 5000,
};
const control = new Client(options);
const runtime = createPgStoreRuntime(
  {
    connectionString,
    maxConnections: 2,
    connectionTimeoutMillis: 2000,
    idleTimeoutMillis: 1000,
    statementTimeoutMillis: 5000,
    onIdleError() {},
  },
  (config) => new Pool({ ...config, options: `-c search_path=${schema}` }),
);
const tables = [
  "raw_capture_budget",
  "raw_capture_batches",
  "raw_capture_chunks",
  "raw_capture_selected",
  "raw_capture_archives",
  "raw_capture_publications",
  "raw_capture_state",
];
const source = {
  relations: tables,
  access: "read-write" as const,
  transaction: runtime.transaction,
};
const native = createPgRawCapture(source, () => 1000);
let d1: D1Database;
let worker: Miniflare;
let ownsSchema = false;
const key = (network = "mainnet") =>
  `chain/raw/${network === "testnet" ? "testnet/" : ""}blocks/000000000010-000000000010.ndjson`;
const body = (captured = 100, data = "0x12") =>
  JSON.stringify({
    block_number: 10,
    captured_at: captured,
    extrinsics: [data],
  }) + "\n";

async function selected() {
  const expected = await d1
    .prepare(
      "SELECT key,sha256,captured_at FROM raw_capture_selected ORDER BY key",
    )
    .all();
  const actual = await control.query(
    `SELECT key,sha256,captured_at FROM ${schema}.raw_capture_selected ORDER BY key`,
  );
  assert.deepEqual(
    actual.rows.map((row) => ({
      ...row,
      captured_at: Number(row.captured_at),
    })),
    expected.results,
  );
}

describe(
  "native raw capture actual PostgreSQL/D1 parity",
  { concurrency: false },
  () => {
    before(async () => {
      await control.connect();
      assert.equal(
        (await control.query("SHOW server_version_num")).rows[0]
          .server_version_num,
        "180006",
      );
      assert.equal(
        (
          await control.query("SELECT 1 FROM pg_namespace WHERE nspname=$1", [
            schema,
          ])
        ).rowCount,
        0,
      );
      ownsSchema = true;
      const sql = readFileSync(
        new URL("../migrations/postgres/0018_raw_capture.sql", import.meta.url),
        "utf8",
      );
      await control.query(sql.replace(/\bapp\b/g, schema));
      await control.query(
        `INSERT INTO ${schema}.raw_capture_budget(id) VALUES(1)`,
      );
      await control.query("BEGIN");
      try {
        await control.query(
          readFileSync(
            new URL(
              "../migrations/postgres/0019_raw_capture_activate.sql",
              import.meta.url,
            ),
            "utf8",
          ).replace(/\bapp\b/g, schema),
        );
        await control.query("COMMIT");
      } catch (error) {
        await control.query("ROLLBACK");
        throw error;
      }
    });
    beforeEach(async () => {
      await control.query(
        `TRUNCATE ${tables.map((name) => `${schema}.${name}`).join(",")} CASCADE`,
      );
      await control.query(
        `INSERT INTO ${schema}.raw_capture_budget(id) VALUES(1)`,
      );
      worker = new Miniflare({
        modules: true,
        script: "export default {fetch(){return new Response('fixture')}}",
        compatibilityDate: "2026-06-06",
        d1Databases: ["DB"],
      });
      d1 = await worker.getD1Database("DB");
      const objects = JSON.parse(
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
      for (const type of ["table", "index", "trigger"])
        for (const object of objects.filter(
          (entry) => entry.type === type && tables.includes(entry.tbl_name),
        ))
          await d1.prepare(object.sql).run();
      await d1.prepare("INSERT INTO raw_capture_budget(id) VALUES(1)").run();
    });
    afterEach(async () => worker?.dispose());
    after(async () => {
      await runtime.close();
      if (ownsSchema) await control.query(`DROP SCHEMA ${schema} CASCADE`);
      await control.end();
    });

    it("stores identical compressed bytes for both networks and replays without budget growth", async () => {
      const raw = body(100, "0x" + randomBytes(100000).toString("hex"));
      for (const network of ["mainnet", "testnet"]) {
        await rawCaptureD1(d1).put(key(network), raw);
        await native.store.put(key(network), raw);
        await native.store.put(key(network), raw);
        const expected = await d1
          .prepare(
            "SELECT part,hex(data) AS data FROM raw_capture_chunks WHERE key=? ORDER BY part",
          )
          .bind(key(network))
          .all();
        const actual = await control.query(
          `SELECT part,upper(encode(data,'hex')) AS data FROM ${schema}.raw_capture_chunks WHERE key=$1 ORDER BY part`,
          [key(network)],
        );
        assert.deepEqual(
          actual.rows.map((row) => ({ ...row, part: Number(row.part) })),
          expected.results,
        );
        assert.equal(
          gunzipSync(
            Buffer.concat(
              actual.rows.map((row) => Buffer.from(row.data, "hex")),
            ),
          ).toString(),
          raw,
        );
      }
      await selected();
      const actual = (
        await control.query(
          `SELECT bytes,objects FROM ${schema}.raw_capture_budget`,
        )
      ).rows[0];
      const expected = await d1
        .prepare("SELECT bytes,objects FROM raw_capture_budget")
        .first();
      assert.deepEqual(
        { bytes: Number(actual.bytes), objects: Number(actual.objects) },
        expected,
      );
    });

    it("cannot select an older invocation or corrupted previously staged bytes", async () => {
      await rawCaptureD1(d1).put(key(), body(200));
      await native.store.put(key(), body(200));
      await assert.rejects(rawCaptureD1(d1).put(key(), body(100)), /selection/);
      await assert.rejects(native.store.put(key(), body(100)), /selection/);
      await selected();
      const raw = body(300),
        prepared = prepareRawCapture(key(), raw);
      const columns = Object.keys(prepared.descriptor).join(",");
      const values = Object.values(prepared.descriptor);
      await control.query(
        `INSERT INTO ${schema}.raw_capture_batches(${columns}) VALUES(${values.map((_, index) => `$${index + 1}`).join(",")})`,
        values,
      );
      await control.query(
        `INSERT INTO ${schema}.raw_capture_chunks(key,sha256,part,data) VALUES($1,$2,0,$3)`,
        [key(), prepared.digest, Buffer.from("corrupt")],
      );
      await assert.rejects(native.store.put(key(), raw), /chunk readback/);
      await selected();
    });

    it("keeps committed bytes after an unknown reply and confirms an idempotent replay", async () => {
      let lose = true;
      const uncertain = createPgRawCapture({
        ...source,
        async transaction(callback, settings) {
          const result = await source.transaction(callback, settings);
          if (lose) {
            lose = false;
            throw new Error("fixture reply lost after commit");
          }
          return result;
        },
      });
      await assert.rejects(uncertain.store.put(key(), body()), /reply lost/);
      await uncertain.store.put(key(), body());
      await rawCaptureD1(d1).put(key(), body());
      await selected();
      assert.equal(
        Number(
          (
            await control.query(
              `SELECT count(*) FROM ${schema}.raw_capture_batches`,
            )
          ).rows[0].count,
        ),
        1,
      );
    });

    it("uses one source for monotonic per-network watermarks", async () => {
      const main = native.watermark("mainnet"),
        testnet = native.watermark("testnet");
      assert.equal(await main.read(), null);
      await Promise.all([main.write(20), main.write(10)]);
      await testnet.write(7);
      assert.equal(await main.read(), 20);
      assert.equal(await testnet.read(), 7);
    });

    it("replays an archived identity without recreating staging and rejects changed archive metadata", async () => {
      const raw = body(),
        prepared = prepareRawCapture(key(), raw);
      await rawCaptureD1(d1).put(key(), raw);
      await native.store.put(key(), raw);
      const pointer = `chain/raw/native/v1/mainnet/${prepared.digest}/${prepared.compressedDigest}.gz`;
      const etag = createHash("md5").update(prepared.compressed).digest("hex");
      const values = [pointer, etag, prepared.compressedDigest, key()];
      await d1
        .prepare(
          "INSERT INTO raw_capture_archives SELECT b.*,1,?,?,? FROM raw_capture_batches b WHERE key=?",
        )
        .bind(...values)
        .run();
      await control.query(
        `INSERT INTO ${schema}.raw_capture_archives SELECT b.*,true,$1,$2,$3 FROM ${schema}.raw_capture_batches b WHERE key=$4`,
        values,
      );
      await rawCaptureD1(d1).put(key(), raw);
      await native.store.put(key(), raw);
      assert.equal(
        Number(
          (
            await control.query(
              `SELECT count(*) FROM ${schema}.raw_capture_batches`,
            )
          ).rows[0].count,
        ),
        0,
      );
      assert.equal(
        (
          await d1
            .prepare("SELECT count(*) AS n FROM raw_capture_batches")
            .first<{ n: number }>()
        )?.n,
        0,
      );
      await d1
        .prepare("UPDATE raw_capture_archives SET native_key='changed'")
        .run();
      await control.query(
        `UPDATE ${schema}.raw_capture_archives SET native_key='changed'`,
      );
      await assert.rejects(
        rawCaptureD1(d1).put(key(), raw),
        /archive identity/,
      );
      await assert.rejects(native.store.put(key(), raw), /archive identity/);
    });
  },
);
