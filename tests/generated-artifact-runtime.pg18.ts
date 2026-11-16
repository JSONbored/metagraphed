import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, beforeEach, describe, it } from "node:test";
import { Client } from "pg";
import { createPgGeneratedArtifactStore } from "../src/generated-artifact-pg.ts";
import {
  selectedGeneratedArtifactStore,
  type GeneratedArtifactStore,
} from "../src/generated-artifact-store.ts";
import { iconCacheStore } from "../src/icon-cache-store.ts";
import {
  createPgStoreRuntime,
  type PgStoreRuntime,
} from "../src/pg-store-runtime.ts";
import { pg18FixtureUrl } from "./helpers/pg18-fixture.ts";
import { readGeneratedStoreJson } from "../scripts/r2-rest.ts";

const url = pg18FixtureUrl().toString();
const control = new Client({
  connectionString: url,
  connectionTimeoutMillis: 2000,
  statement_timeout: 5000,
});
let runtime: PgStoreRuntime;
let store: GeneratedArtifactStore;
let ownsSchema = false;
let ownsTable = false;

describe(
  "generated artifacts on PostgreSQL 18.6",
  { concurrency: false },
  () => {
    before(async () => {
      await control.connect();
      assert.equal(
        (await control.query("SHOW server_version_num")).rows[0]
          .server_version_num,
        "180006",
      );
      ownsSchema =
        (
          await control.query(
            "SELECT oid FROM pg_namespace WHERE nspname='app'",
          )
        ).rowCount === 0;
      await control.query(
        readFileSync(
          new URL(
            "../migrations/postgres/0006_generated_artifacts.sql",
            import.meta.url,
          ),
          "utf8",
        ),
      );
      ownsTable = true;
      runtime = createPgStoreRuntime({
        connectionString: url,
        maxConnections: 2,
        connectionTimeoutMillis: 2000,
        idleTimeoutMillis: 1000,
        statementTimeoutMillis: 5000,
        onIdleError: (error) => {
          throw error;
        },
      });
      store = selectedGeneratedArtifactStore({
        GENERATED_ARTIFACT_STORE: createPgGeneratedArtifactStore(runtime),
      })!;
    });
    beforeEach(async () => {
      await control.query("TRUNCATE app.generated_artifacts");
    });
    after(async () => {
      try {
        await runtime?.close();
        if (ownsTable)
          await control.query("DROP TABLE IF EXISTS app.generated_artifacts");
        if (ownsSchema) await control.query("DROP SCHEMA app");
      } finally {
        await control.end();
      }
    });

    it("keeps exact JSON text and overwrites one key without changing the get contract", async () => {
      const payload =
        '{ "wide": 123456789012345678901234567890, "nul": "\\u0000", "surrogate": "\\ud800", "n": 1.00 }';
      assert.equal(await store.get("key"), null);
      await store.put("key", payload);
      assert.equal(
        (
          await control.query(
            "SELECT payload FROM app.generated_artifacts WHERE key='key'",
          )
        ).rows[0].payload,
        payload,
      );
      assert.deepEqual(await store.get("key"), JSON.parse(payload));
      await store.put("key", '{"next":"λ"}');
      assert.deepEqual(await store.get("key"), { next: "λ" });
      const previousDatabase =
        process.env.METAGRAPH_GENERATED_ARTIFACT_DATABASE_URL;
      try {
        process.env.METAGRAPH_GENERATED_ARTIFACT_DATABASE_URL = url;
        assert.deepEqual(await readGeneratedStoreJson("key", 5000), {
          next: "λ",
        });
      } finally {
        if (previousDatabase === undefined)
          delete process.env.METAGRAPH_GENERATED_ARTIFACT_DATABASE_URL;
        else
          process.env.METAGRAPH_GENERATED_ARTIFACT_DATABASE_URL =
            previousDatabase;
      }
      assert.equal(
        (
          await control.query(
            "SELECT count(*)::integer AS n FROM app.generated_artifacts",
          )
        ).rows[0].n,
        1,
      );
      for (const invalid of ["{", "null", "[]", "1"]) {
        await assert.rejects(store.put("key", invalid));
        assert.deepEqual(await store.get("key"), { next: "λ" });
      }
    });

    it("does not publish a rolled-back snapshot and preserves icon bytes and metadata", async () => {
      await control.query("BEGIN");
      await control.query(
        "INSERT INTO app.generated_artifacts(key,payload) VALUES ('rolled-back','{}')",
      );
      await control.query("ROLLBACK");
      assert.equal(await store.get("rolled-back"), null);
      const cache = iconCacheStore(undefined, store)!;
      const bytes = new Uint8Array([0, 1, 127, 128, 255]);
      const metadata = {
        httpMetadata: { contentType: "image/png" },
        customMetadata: { source: "fixture" },
      };
      await cache.put("icon", bytes, metadata);
      const found = await cache.get("icon");
      assert.ok(found);
      assert.deepEqual(new Uint8Array(found.body), bytes);
      assert.deepEqual(found.customMetadata, metadata.customMetadata);
      assert.deepEqual(found.httpMetadata, metadata.httpMetadata);
    });
  },
);
