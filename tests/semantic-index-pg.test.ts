import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { beforeAll, beforeEach, afterAll, test } from "vitest";
import { createPgSemanticIndex } from "../src/semantic-index-pg.ts";
import { selectedSemanticIndex } from "../src/semantic-index.ts";
import type { PgTransactionRunner } from "../src/pg-pool.ts";
import { toPositionalPlaceholders } from "../src/pg-sql.ts";
import {
  aiConfigured,
  runEmbeddingSync,
  semanticSearch,
  EMBED_MODEL,
} from "../src/ai-search.ts";
import { mockEnv } from "./row-type.ts";

const migration = readFileSync(
  new URL("../migrations/postgres/0029_search_index.sql", import.meta.url),
  "utf8",
);
const options = {
  name: "fixture-index",
  model: "fixture-model",
  dimensions: 3,
  maxVectors: 3,
};
let db: PGlite;
const transaction: PgTransactionRunner = (callback) =>
  db.transaction(async (tx) => {
    const query = async <Row>(sql: string, values: unknown[] = []) =>
      (await tx.query<Row>(toPositionalPlaceholders(sql), values)).rows;
    return callback({
      query,
      first: async <Row>(sql: string, values?: unknown[]) =>
        (await query<Row>(sql, values))[0] ?? null,
      run: async (sql, values = []) => ({
        changes:
          (await tx.query(toPositionalPlaceholders(sql), values))
            .affectedRows ?? 0,
      }),
    });
  });
beforeAll(async () => {
  db = new PGlite();
});
beforeEach(async () => {
  await db.exec("DROP SCHEMA IF EXISTS search CASCADE");
  await db.exec(migration);
});
afterAll(async () => db.close());
const create = () => createPgSemanticIndex({ transaction }, options);
const item = (
  id: string,
  values = [1, 0, 0],
  type = "subnet",
): VectorizeVector => ({ id, values, metadata: { type, title: id } });

test("selection requires a complete explicit capability and never falls through a malformed one", async () => {
  for (const env of [null, undefined, 1, {}, { SEMANTIC_INDEX: undefined }])
    assert.equal(selectedSemanticIndex(env), undefined);
  const index = await create();
  assert.equal(selectedSemanticIndex({ SEMANTIC_INDEX: index }), index);
  for (const value of [
    null,
    {},
    { upsert() {} },
    { upsert() {}, deleteByIds() {} },
  ])
    assert.throws(
      () => selectedSemanticIndex({ SEMANTIC_INDEX: value }),
      /invalid/,
    );
  assert.equal(
    aiConfigured(mockEnv({ AI: { run() {} }, SEMANTIC_INDEX: index })),
    true,
  );
  assert.throws(
    () => aiConfigured(mockEnv({ AI: { run() {} }, SEMANTIC_INDEX: {} })),
    /invalid/,
  );
});

test("requires bounded configuration, active schema, matching model and a valid count", async () => {
  for (const invalid of [
    { name: "" },
    { name: "a\0b" },
    { name: "x".repeat(129) },
    { model: "" },
    { dimensions: 0 },
    { dimensions: 4097 },
    { dimensions: NaN },
    { maxVectors: 0 },
    { maxVectors: 10001 },
  ])
    await assert.rejects(
      createPgSemanticIndex({ transaction }, { ...options, ...invalid }),
      /Invalid/,
    );
  await create();
  for (const invalid of [
    { model: "other" },
    { dimensions: 2 },
    { maxVectors: 4 },
  ])
    await assert.rejects(
      createPgSemanticIndex({ transaction }, { ...options, ...invalid }),
      /configuration differs/,
    );
  await db.exec("UPDATE search.indexes SET vector_count=1");
  await assert.rejects(create(), /census differs/);
  await db.exec("UPDATE search.indexes SET vector_count=0");
  const index = await create();
  await db.exec("ALTER TABLE search.vectors DISABLE TRIGGER vector_capacity");
  await assert.rejects(create(), /not activated/);
  await assert.rejects(index.query([1, 0, 0]), /not activated/);
});

test("stores float32 vectors, exact JSON metadata and deterministic cosine ranking", async () => {
  const index = await create();
  const result = await index.upsert([
    {
      ...item("a"),
      metadata: { type: "subnet", title: "with\0nul", categories: ["api"] },
    },
    item("b", [0, 1, 0], "provider"),
    item("c", [-1, 0, 0]),
  ]);
  assert.match(result.mutationId, /^[a-f0-9-]{36}$/);
  const found = await index.query(new Float64Array([1, 0, 0]), {
    topK: 3,
    returnMetadata: "all",
    returnValues: true,
  });
  assert.deepEqual(
    found.matches.map((match) => [match.id, match.score]),
    [
      ["a", 1],
      ["b", 0],
      ["c", -1],
    ],
  );
  assert.equal(found.matches[0].metadata?.title, "with\0nul");
  assert.deepEqual(found.matches[0].values, [1, 0, 0]);
  assert.equal(found.count, 3);
  const hidden = await index.query([1, 0, 0]);
  assert.equal(hidden.matches[0].metadata, undefined);
  assert.equal(hidden.matches[0].values, undefined);
  await index.upsert([item("a", [0, 0, 0])]);
  assert.ok(
    (await index.query([0, 0, 0])).matches.every((match) => match.score === 0),
  );
  assert.deepEqual(
    (await db.query("SELECT vector_count FROM search.indexes")).rows,
    [{ vector_count: 3 }],
  );
});

test("filters exactly by type with equality or allow-lists", async () => {
  const index = await create();
  await index.upsert([
    item("a"),
    item("b", [1, 0, 0], "provider"),
    item("c", [1, 0, 0], "surface"),
  ]);
  for (const filter of [{ type: "provider" }, { type: { $eq: "provider" } }])
    assert.deepEqual(
      (await index.query([1, 0, 0], { filter })).matches.map(
        (match) => match.id,
      ),
      ["b"],
    );
  assert.deepEqual(
    (
      await index.query([1, 0, 0], {
        filter: { type: { $in: ["surface", "subnet"] } },
      })
    ).matches.map((match) => match.id),
    ["a", "c"],
  );
  assert.equal(
    (await index.query([1, 0, 0], { filter: { type: { $in: [] } } })).count,
    0,
  );
  assert.equal((await index.query([1, 0, 0], { filter: {} })).count, 3);
  const invalidFilters: VectorizeVectorMetadataFilter[] = [
    { other: "subnet" },
    { type: 1 },
    { type: { $gt: "a" } },
    { type: { $in: Array(101).fill("a") } },
  ];
  for (const filter of invalidFilters)
    await assert.rejects(
      index.query([1, 0, 0], { filter }),
      /semantic filters/,
    );
});

test("validates all input before mutation and refuses unsupported query options", async () => {
  const index = await create();
  for (const input of [
    [],
    Array(101).fill(item("a")),
    [item("")],
    [item("a\0b")],
    [item("a", [1, 0])],
    [item("a", [Infinity, 0, 0])],
    [item("a", [1e100, 0, 0])],
    [{ ...item("a"), namespace: "private" }],
    [{ ...item("a"), metadata: { type: "bad\0type" } }],
    [{ ...item("a"), metadata: { title: "x".repeat(10241) } }],
  ])
    await assert.rejects(index.upsert(input), /Semantic|semantic|Native/);
  assert.deepEqual(
    (await db.query("SELECT vector_count FROM search.indexes")).rows,
    [{ vector_count: 0 }],
  );
  for (const query of [
    { topK: 0 },
    { topK: 21 },
    { topK: 1.5 },
    { namespace: "other" },
    { returnMetadata: "indexed" as const },
  ])
    await assert.rejects(
      index.query([1, 0, 0], query),
      /Semantic|semantic|Native/,
    );
  await assert.rejects(index.query([1, 0]), /dimensions/);
  await assert.rejects(index.deleteByIds(Array(101).fill("a")), /100 ids/);
  await assert.rejects(index.deleteByIds(["a\0b"]), /Invalid/);
});

test("rejects malformed vector and metadata boundaries without storing a partial batch", async () => {
  const index = await create();
  await assert.rejects(index.upsert({} as VectorizeVector[]), /1 to 100/);
  await assert.rejects(index.deleteByIds({} as string[]), /100 ids/);
  const malformed = [
    { ...item("a"), values: {} },
    { ...item("a"), values: ["1", 0, 0] },
    { ...item("a"), metadata: [] },
    { ...item("a"), metadata: { toJSON: () => undefined } },
    { ...item("a"), metadata: { toJSON: () => "string" } },
  ];
  for (const entry of malformed)
    await assert.rejects(
      index.upsert([entry as unknown as VectorizeVector]),
      /Semantic|semantic/,
    );
  const filters: unknown[] = [
    { type: "subnet", extra: true },
    { type: { $eq: 1 } },
    { type: { $in: "subnet" } },
    { type: { $in: [1] } },
  ];
  for (const filter of filters)
    await assert.rejects(
      index.query([1, 0, 0], {
        filter: filter as VectorizeVectorMetadataFilter,
      }),
      /semantic filters/,
    );
  assert.equal((await index.query([1, 0, 0])).count, 0);
  await index.upsert([{ id: "plain", values: new Float32Array([1, 0, 0]) }]);
  assert.deepEqual(
    (await index.query([1, 0, 0], { returnMetadata: true })).matches[0]
      .metadata,
    {},
  );
});

test("a retired index handle refuses reads rather than recreating or falling back", async () => {
  const index = await create();
  await db.exec("DELETE FROM search.indexes");
  await assert.rejects(index.query([1, 0, 0]), /configuration differs/);
});

test("capacity failures roll back the batch and deletes release capacity", async () => {
  const index = await create();
  await index.upsert([item("a"), item("b"), item("c")]);
  await assert.rejects(
    index.upsert([item("a", [0, 1, 0]), item("d")]),
    /check constraint/,
  );
  assert.equal((await index.query([1, 0, 0])).matches[0].id, "a");
  await index.deleteByIds(["b", "missing"]);
  await index.upsert([item("d")]);
  await index.deleteByIds([]);
  assert.equal((await index.query([1, 0, 0])).count, 3);
  await assert.rejects(
    db.exec("UPDATE search.indexes SET dimensions=4"),
    /immutable/,
  );
  await assert.rejects(
    db.exec("UPDATE search.vectors SET id='different' WHERE id='a'"),
    /immutable/,
  );
  await assert.rejects(
    db.exec(
      "UPDATE search.vectors SET embedding=ARRAY[1,0]::real[] WHERE id='a'",
    ),
    /dimensions differ/,
  );
});

test("normal embedding sync and semantic search use the native index without Vectorize", async () => {
  const index = await createPgSemanticIndex(
    { transaction },
    { name: "registry", model: EMBED_MODEL, dimensions: 1024, maxVectors: 10 },
  );
  const values = new Map<string, string>();
  const env = mockEnv({
    SEMANTIC_INDEX: index,
    METAGRAPH_ENABLE_AI: "true",
    AI: {
      run: async (_model: string, input: { text: string[] }) => ({
        data: input.text.map(() => [1, ...Array(1023).fill(0)]),
      }),
    },
    METAGRAPH_CONTROL: {
      get: async (key: string) =>
        values.has(key) ? JSON.parse(values.get(key)!) : null,
      put: async (key: string, value: string) => {
        values.set(key, value);
      },
    },
  });
  const documents = [
    {
      id: "subnet:1",
      type: "subnet",
      netuid: 1,
      title: "Example",
      url: "https://example.com",
      categories: ["api"],
    },
  ];
  const readArtifact = async () => ({
    ok: true as const,
    data: { documents },
    source: "static-assets" as const,
    storage_tier: "static",
  });
  const first = await runEmbeddingSync(env, { readArtifact });
  assert.equal(first.embedded, 1);
  assert.equal((await runEmbeddingSync(env, { readArtifact })).embedded, 0);
  const found = await semanticSearch(env, "Example", { type: "subnet" });
  assert.equal(found.count, 1);
  assert.equal(found.results[0].title, "Example");
  assert.equal(found.results[0].score, 1);
  assert.equal(
    (
      await runEmbeddingSync(env, {
        readArtifact: async () => ({
          ok: true as const,
          data: { documents: [] },
          source: "static-assets" as const,
          storage_tier: "static",
        }),
      })
    ).removed,
    1,
  );
  assert.equal((await semanticSearch(env, "Example")).count, 0);
});
