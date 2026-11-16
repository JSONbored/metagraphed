import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { before, beforeEach, after, describe, it } from "node:test";
import { Client } from "pg";
import {
  createPgStoreRuntime,
  type PgStoreRuntime,
} from "../src/pg-store-runtime.ts";
import { createPgSemanticIndex } from "../src/semantic-index-pg.ts";
import { createPgKv } from "../src/pg-kv.ts";
import { createNativeAiInference } from "../src/native-ai-inference.ts";
import {
  runEmbeddingSync,
  semanticSearch,
  askQuestion,
} from "../src/ai-search.ts";
import { pg18FixtureUrl } from "./helpers/pg18-fixture.ts";
import { mockEnv } from "./row-type.ts";

const connectionString = pg18FixtureUrl().toString();
const control = new Client({
  connectionString,
  connectionTimeoutMillis: 2000,
  statement_timeout: 5000,
});
let runtime: PgStoreRuntime;
let inference: ReturnType<typeof createNativeAiInference>;
let server: Server;
let ownsAuth = false,
  ownsSearch = false,
  requests = 0,
  failEmbedding = false;
const identity = {
  embedding: {
    provider: "self_hosted",
    model: "fixture-embedding",
    dimensions: 3,
  },
  completion: { provider: "self_hosted", model: "fixture-answer" },
};
const documents = [
  {
    id: "subnet:1",
    type: "subnet",
    netuid: 1,
    title: "Example",
    url: "https://example.com",
  },
];
const readArtifact = async () => ({
  ok: true as const,
  source: "static-assets" as const,
  storage_tier: "static",
  data: { documents },
});
async function environment(name = "fixture") {
  return mockEnv({
    AI_INFERENCE: inference,
    SEMANTIC_INDEX: await createPgSemanticIndex(runtime, {
      name,
      model: identity.embedding.model,
      dimensions: 3,
      maxVectors: 10,
    }),
    CONTROL_KV_STORE: createPgKv(runtime, "control"),
  });
}

describe(
  "native inference over HTTP with PostgreSQL index and control state",
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
        (await control.query("SELECT to_regnamespace('auth') AS existing"))
          .rows[0].existing,
        null,
      );
      assert.equal(
        (await control.query("SELECT to_regnamespace('search') AS existing"))
          .rows[0].existing,
        null,
      );
      await control.query(
        readFileSync(
          new URL("../migrations/postgres/0009_auth_kv.sql", import.meta.url),
          "utf8",
        ),
      );
      ownsAuth = true;
      await control.query(
        readFileSync(
          new URL(
            "../migrations/postgres/0029_search_index.sql",
            import.meta.url,
          ),
          "utf8",
        ),
      );
      ownsSearch = true;
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
      server = createServer(async (request, response) => {
        let text = "";
        for await (const chunk of request) text += String(chunk);
        const input = JSON.parse(text);
        requests++;
        response.setHeader("content-type", "application/json");
        if (request.url!.endsWith("embeddings")) {
          if (failEmbedding) {
            response.writeHead(503);
            response.end("unavailable");
            return;
          }
          response.end(
            JSON.stringify({
              data: input.input.map((_: string, index: number) => ({
                index,
                embedding: [1, 0, 0],
              })),
            }),
          );
        } else
          response.end(
            JSON.stringify({
              choices: [{ message: { content: "Use Example [1]." } }],
              usage: { prompt_tokens: 10, completion_tokens: 4 },
            }),
          );
      });
      await new Promise<void>((resolve) =>
        server.listen(0, "127.0.0.1", resolve),
      );
      const address = server.address();
      assert.ok(address && typeof address !== "string");
      const baseUrl = `http://127.0.0.1:${address.port}/v1/`;
      inference = createNativeAiInference({
        identity,
        embedding: { baseUrl },
        completion: { baseUrl },
        maxConcurrent: 2,
        maxRequestBytes: 65536,
        maxResponseBytes: 1048576,
        maxOutputTokens: 1024,
        executionTimeoutMillis: 2000,
        drainTimeoutMillis: 2000,
      });
    });
    beforeEach(async () => {
      failEmbedding = false;
      requests = 0;
      await control.query(
        "DELETE FROM search.vectors; DELETE FROM search.indexes; DELETE FROM auth.kv_entries",
      );
    });
    after(async () => {
      try {
        await inference?.close();
        if (server) {
          server.closeAllConnections();
          await new Promise<void>((resolve) => server.close(() => resolve()));
        }
        await runtime?.close();
        if (ownsSearch) await control.query("DROP SCHEMA search CASCADE");
        if (ownsAuth) await control.query("DROP SCHEMA auth CASCADE");
      } finally {
        await control.end();
      }
    });

    it("runs real embedding synchronization, retrieval and grounded completion without Cloudflare bindings", async () => {
      const env = await environment();
      assert.equal((await runEmbeddingSync(env, { readArtifact })).embedded, 1);
      assert.equal((await runEmbeddingSync(env, { readArtifact })).embedded, 0);
      assert.equal(requests, 1);
      const found = await semanticSearch(env, "Example");
      assert.equal(found.model, "fixture-embedding");
      assert.equal(found.results[0].title, "Example");
      const answer = await askQuestion(env, "Where do I start?");
      assert.equal(answer.answer, "Use Example [1].");
      assert.equal(answer.model, "fixture-answer");
      assert.equal(answer.citations[0].title, "Example");
    });

    it("an empty replacement index cannot reuse the original index's completed manifest", async () => {
      await runEmbeddingSync(await environment("original"), { readArtifact });
      assert.equal(
        (
          await runEmbeddingSync(await environment("replacement"), {
            readArtifact,
          })
        ).embedded,
        1,
      );
      assert.equal(requests, 2);
      assert.equal(
        (
          await control.query(
            "SELECT count(*)::integer AS count FROM auth.kv_entries WHERE namespace='control'",
          )
        ).rows[0].count,
        2,
      );
      assert.deepEqual(
        (
          await control.query(
            "SELECT index_name,count(*)::integer AS count FROM search.vectors GROUP BY index_name ORDER BY index_name",
          )
        ).rows,
        [
          { index_name: "original", count: 1 },
          { index_name: "replacement", count: 1 },
        ],
      );
    });

    it("failed model calls preserve already-published vectors and completion markers", async () => {
      const env = await environment();
      await runEmbeddingSync(env, { readArtifact });
      const before = (
        await control.query(
          "SELECT encode(value,'hex') AS value FROM auth.kv_entries WHERE namespace='control'",
        )
      ).rows;
      failEmbedding = true;
      await assert.rejects(
        runEmbeddingSync(env, {
          readArtifact: async () => ({
            ...(await readArtifact()),
            data: { documents: [{ ...documents[0], title: "Changed" }] },
          }),
        }),
        /HTTP 503/,
      );
      assert.deepEqual(
        (
          await control.query(
            "SELECT encode(value,'hex') AS value FROM auth.kv_entries WHERE namespace='control'",
          )
        ).rows,
        before,
      );
      assert.equal(
        (
          await control.query(
            "SELECT count(*)::integer AS count FROM search.vectors",
          )
        ).rows[0].count,
        1,
      );
    });
  },
);
