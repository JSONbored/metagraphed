import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { before, beforeEach, after, describe, it } from "node:test";
import { Client } from "pg";
import {
  createPgStoreRuntime,
  type PgStoreRuntime,
} from "../src/pg-store-runtime.ts";
import { createPgSemanticIndex } from "../src/semantic-index-pg.ts";
import {
  runEmbeddingSync,
  semanticSearch,
  EMBED_MODEL,
} from "../src/ai-search.ts";
import { mockEnv } from "./row-type.ts";
import { pg18FixtureUrl } from "./helpers/pg18-fixture.ts";

const connectionString = pg18FixtureUrl().toString();
const control = new Client({
  connectionString,
  connectionTimeoutMillis: 2000,
  statement_timeout: 5000,
});
const ddl = readFileSync(
  new URL("../migrations/postgres/0029_search_index.sql", import.meta.url),
  "utf8",
);
const config = {
  name: "fixture",
  model: "fixture-model",
  dimensions: 3,
  maxVectors: 2,
};
let runtime: PgStoreRuntime;
let ownsSchema = false;
const record = (
  id: string,
  values = [1, 0, 0],
  type = "subnet",
): VectorizeVector => ({ id, values, metadata: { type, title: id } });

describe(
  "native semantic index on PostgreSQL 18",
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
        (await control.query("SELECT to_regnamespace('search') AS existing"))
          .rows[0].existing,
        null,
      );
      await control.query(ddl);
      ownsSchema = true;
      runtime = createPgStoreRuntime({
        connectionString,
        maxConnections: 4,
        connectionTimeoutMillis: 2000,
        idleTimeoutMillis: 1000,
        statementTimeoutMillis: 5000,
        onIdleError: (error) => {
          throw error;
        },
      });
    });
    beforeEach(async () => {
      await control.query(
        "DELETE FROM search.vectors; DELETE FROM search.indexes",
      );
    });
    after(async () => {
      try {
        await runtime?.close();
        if (ownsSchema) await control.query("DROP SCHEMA search CASCADE");
      } finally {
        await control.end();
      }
    });

    it("ranks cosine vectors and preserves metadata bytes and explicit type filtering", async () => {
      const index = await createPgSemanticIndex(runtime, config);
      await index.upsert([
        {
          ...record("a"),
          metadata: { type: "subnet", title: "embedded\0nul", netuid: 1 },
        },
        record("b", [0, 1, 0], "provider"),
      ]);
      const found = await index.query([3, 4, 0], {
        topK: 2,
        returnMetadata: "all",
        returnValues: true,
      });
      assert.deepEqual(
        found.matches.map((m) => m.id),
        ["b", "a"],
      );
      assert.ok(Math.abs(found.matches[0].score - 0.8) < 1e-7);
      assert.ok(Math.abs(found.matches[1].score - 0.6) < 1e-7);
      assert.equal(found.matches[1].metadata?.title, "embedded\0nul");
      assert.deepEqual(found.matches[1].values, [1, 0, 0]);
      assert.deepEqual(
        (
          await index.query([3, 4, 0], {
            filter: { type: { $in: ["subnet"] } },
          })
        ).matches.map((m) => m.id),
        ["a"],
      );
      assert.equal((await index.query([0, 0, 0])).matches[0].score, 0);
    });

    it("rolls back updates and counters when a later insert exceeds capacity", async () => {
      const index = await createPgSemanticIndex(runtime, config);
      await index.upsert([record("a"), record("b")]);
      await assert.rejects(
        index.upsert([record("a", [-1, 0, 0]), record("c")]),
        /check constraint/,
      );
      assert.equal((await index.query([1, 0, 0])).matches[0].score, 1);
      assert.deepEqual(
        (await control.query("SELECT vector_count FROM search.indexes")).rows,
        [{ vector_count: 2 }],
      );
      await index.deleteByIds(["b"]);
      await index.upsert([record("c")]);
      assert.deepEqual(
        (await index.query([1, 0, 0])).matches.map((m) => m.id),
        ["a", "c"],
      );
    });

    it("serializes competing producers without exceeding the durable index budget", async () => {
      const one = await createPgSemanticIndex(runtime, config);
      const two = await createPgSemanticIndex(runtime, config);
      const results = await Promise.allSettled([
        one.upsert([record("a")]),
        two.upsert([record("b")]),
        one.upsert([record("c")]),
      ]);
      assert.equal(results.filter((r) => r.status === "fulfilled").length, 2);
      assert.equal(results.filter((r) => r.status === "rejected").length, 1);
      const count = (
        await control.query(
          "SELECT vector_count,(SELECT count(*)::integer FROM search.vectors) AS actual FROM search.indexes",
        )
      ).rows[0];
      assert.deepEqual(count, { vector_count: 2, actual: 2 });
    });

    it("isolates model/index identity and enforces source vector shape", async () => {
      const index = await createPgSemanticIndex(runtime, config);
      await index.upsert([record("a")]);
      await assert.rejects(
        createPgSemanticIndex(runtime, { ...config, model: "different" }),
        /configuration differs/,
      );
      const separate = await createPgSemanticIndex(runtime, {
        ...config,
        name: "separate",
      });
      assert.equal((await separate.query([1, 0, 0])).count, 0);
      await assert.rejects(
        control.query("UPDATE search.vectors SET embedding=ARRAY[1,2]::real[]"),
        /dimensions differ/,
      );
      await assert.rejects(
        control.query(
          "UPDATE search.vectors SET embedding=ARRAY['NaN',0,0]::real[]",
        ),
        /check constraint/,
      );
      await assert.rejects(
        control.query(
          "UPDATE search.indexes SET dimensions=4 WHERE name='fixture'",
        ),
        /immutable/,
      );
    });

    it("serves the real embedding sync and semantic reader without a Vectorize binding", async () => {
      const index = await createPgSemanticIndex(runtime, {
        ...config,
        name: "registry",
        dimensions: 1024,
        model: EMBED_MODEL,
      });
      const kv = new Map<string, string>();
      const env = mockEnv({
        SEMANTIC_INDEX: index,
        AI: {
          run: async (_model: string, input: { text: string[] }) => ({
            data: input.text.map(() => [1, ...Array(1023).fill(0)]),
          }),
        },
        METAGRAPH_CONTROL: {
          get: async (key: string) =>
            kv.has(key) ? JSON.parse(kv.get(key)!) : null,
          put: async (key: string, value: string) => {
            kv.set(key, value);
          },
        },
      });
      const documents = [
        { id: "subnet:1", type: "subnet", netuid: 1, title: "Example subnet" },
      ];
      const readArtifact = async () => ({
        ok: true as const,
        source: "static-assets" as const,
        storage_tier: "static",
        data: { documents },
      });
      assert.equal((await runEmbeddingSync(env, { readArtifact })).embedded, 1);
      assert.equal((await runEmbeddingSync(env, { readArtifact })).embedded, 0);
      const found = await semanticSearch(env, "Example", { type: ["subnet"] });
      assert.equal(found.count, 1);
      assert.equal(found.results[0].title, "Example subnet");
      assert.equal(found.results[0].score, 1);
    });
  },
);
