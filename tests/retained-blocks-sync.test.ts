import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { beforeAll, beforeEach, afterAll, test } from "vitest";
import { Miniflare } from "miniflare";
import { handleRetainedBlocksSync } from "../src/retained-blocks-sync.ts";
import { readRetainedBlockRows } from "../src/retained-blocks-d1.ts";
import dataWorker from "../workers/data-api.ts";
import { apiEnv, dataApiEnv } from "./helpers/worker-env.ts";
import apiWorker from "../workers/api.ts";
import type { D1StoreBinding } from "../src/d1-store.ts";
const runtime = new Miniflare({
  modules: true,
  script: "export default {fetch(){return new Response('test')}}",
  compatibilityDate: "2026-06-06",
  d1Databases: ["DB"],
});
let db: D1Database;
const now = Date.now(),
  identity = "a".repeat(64),
  other = "b".repeat(64);
const source = {
  network: "mainnet",
  table: "blocks",
  bucket: "warehouse",
  key: "blocks.parquet",
  etag: "abc",
  bytes: 100,
  rows: 3,
};
const row = [11, "0xabc", "0xABC", null, 3, 7, 240, 100];
const tail = [10, null, null, "5abcdefg", null, 11, 241, 200];
const env = () => ({
  D1_RETAINED_BLOCKS: db,
  RETAINED_BLOCKS_SYNC_SECRET: "test-secret",
});
const request = (input: unknown, token = "test-secret") =>
  new Request("https://example.com/api/v1/internal/retained-blocks-sync", {
    method: "POST",
    headers: { "x-retained-blocks-sync-token": token },
    body: JSON.stringify(input),
  });
const call = (input: unknown) =>
  handleRetainedBlocksSync(request(input), env(), now);
async function ok(input: unknown) {
  const result = await call(input);
  assert.equal(result.status, 200, await result.clone().text());
  assert.equal(result.headers.get("cache-control"), "no-store");
  return result.json<Record<string, unknown>>();
}
const publication = (extra: Record<string, unknown> = {}) => ({
  kind: "publish",
  network: "mainnet",
  table_uuid: "019fc234-642e-7f82-b656-ddb8529315ab",
  snapshot: "9223372036854775806",
  sequence: 10,
  generated_at: now,
  source_rows: 3,
  sources: [identity],
  coverage: null,
  ...extra,
});
async function complete(id = identity) {
  await ok({ kind: "begin", identity: id, source });
  await ok({ kind: "chunk", identity: id, start: 0, rows: [row, row] });
  await ok({ kind: "chunk", identity: id, start: 2, rows: [tail] });
}
beforeAll(async () => {
  db = await runtime.getD1Database("DB");
  for (const sql of readFileSync(
    new URL(
      "../migrations/retained-blocks/0001_retained_blocks.sql",
      import.meta.url,
    ),
    "utf8",
  ).split("-- statement-breakpoint"))
    await db.prepare(sql).run();
});
beforeEach(async () => {
  for (const table of [
    "history_blocks",
    "history_block_authors",
    "history_block_sources",
    "history_block_chunks",
    "history_block_source_counts",
    "history_block_counts",
    "history_block_state",
  ])
    await db.prepare(`DELETE FROM ${table}`).run();
});
afterAll(async () => runtime.dispose());
test("larger byte-bounded chunks preserve every row and reject excess row counts", async () => {
  const rows = Array.from({ length: 4000 }, (_, i) => [
    i,
    i % 2 ? null : "0xabc",
    "0xABC",
    i % 2 ? "author" : null,
    3,
    i % 2 ? 7 : 11,
    240,
    100,
  ]);
  await ok({ kind: "begin", identity, source: { ...source, rows: 4000 } });
  const input = { kind: "chunk", identity, start: 0, rows };
  assert.ok(JSON.stringify(input).length < 512 * 1024);
  assert.equal((await call({ ...input, rows: [...rows, row] })).status, 400);
  await ok(input);
  await ok(input);
  await ok(publication({ source_rows: 4000 }));
  const actual = await db
    .prepare(
      "SELECT block_number,block_hash,parent_hash,author,extrinsic_count,event_count,spec_version,observed_at FROM history_block_rows WHERE network=0 ORDER BY block_number",
    )
    .all();
  assert.deepEqual(
    actual.results.map((r) => Object.values(r)),
    rows,
  );
  assert.deepEqual(
    (
      await db
        .prepare(
          "SELECT value,rows FROM history_block_counts WHERE kind='events' ORDER BY value",
        )
        .all()
    ).results,
    [
      { value: 7, rows: 2000 },
      { value: 11, rows: 2000 },
    ],
  );
});
test("resumable chunks preserve physical duplicates and exact null/string data without double counting", async () => {
  assert.deepEqual(await ok({ kind: "begin", identity, source }), {
    received_rows: 0,
    expected_rows: 3,
  });
  const input = { kind: "chunk", identity, start: 0, rows: [row, row] };
  await ok(input);
  await ok(input);
  assert.deepEqual(await ok({ kind: "begin", identity, source }), {
    received_rows: 2,
    expected_rows: 3,
  });
  assert.equal((await call(publication())).status, 409);
  await ok({ kind: "chunk", identity, start: 2, rows: [tail] });
  const published = await ok(publication());
  assert.match(String(published.generation), /^[0-9a-f]{64}$/);
  assert.deepEqual(await ok(publication()), published);
  assert.equal(
    (await db
      .prepare("SELECT COUNT(*) n FROM history_blocks")
      .first<{ n: number }>())!.n,
    3,
  );
  const counts = await db
    .prepare(
      "SELECT kind,value,rows FROM history_block_counts ORDER BY kind,value",
    )
    .all();
  assert.deepEqual(counts.results, [
    { kind: "events", value: 7, rows: 2 },
    { kind: "events", value: 11, rows: 1 },
    { kind: "extrinsics", value: 3, rows: 2 },
  ]);
  const rows = await readRetainedBlockRows(
    { ...env(), RETAINED_BLOCKS_NETWORKS: "mainnet" },
    ["event_count>=10"],
    100,
    "mainnet",
    now,
    { minEvents: 10 },
  );
  assert.deepEqual(rows, [
    {
      block_number: 10,
      block_hash: null,
      parent_hash: null,
      author: "5abcdefg",
      extrinsic_count: null,
      event_count: 11,
      spec_version: 241,
      observed_at: 200,
    },
  ]);
});
test("snapshot replacement changes membership and histograms together, retaining previous immutable rows", async () => {
  await complete();
  await ok(publication());
  await ok({
    kind: "begin",
    identity: other,
    source: { ...source, key: "replacement.parquet", rows: 1 },
  });
  await ok({ kind: "chunk", identity: other, start: 0, rows: [tail] });
  await ok(
    publication({
      sources: [other],
      source_rows: 1,
      sequence: 11,
      snapshot: "9223372036854775807",
    }),
  );
  const selected = await db
    .prepare("SELECT block_number FROM history_block_rows")
    .all();
  assert.deepEqual(selected.results, [{ block_number: 10 }]);
  assert.equal(
    (await db
      .prepare("SELECT COUNT(*) n FROM history_blocks")
      .first<{ n: number }>())!.n,
    4,
  );
  assert.deepEqual(
    (await db.prepare("SELECT kind,value,rows FROM history_block_counts").all())
      .results,
    [{ kind: "events", value: 11, rows: 1 }],
  );
  assert.equal((await call(publication())).status, 409);
});
test("source, chunk, and source-census conflicts never publish partial or wider history", async () => {
  assert.equal(
    (await call({ kind: "chunk", identity, start: 0, rows: [row] })).status,
    404,
  );
  await ok({ kind: "begin", identity, source });
  assert.equal(
    (await call({ kind: "begin", identity, source: { ...source, bytes: 101 } }))
      .status,
    409,
  );
  for (const [start, rows] of [
    [1, [row]],
    [0, [row, row, row, row]],
  ])
    assert.equal(
      (await call({ kind: "chunk", identity, start, rows })).status,
      409,
    );
  await ok({ kind: "chunk", identity, start: 0, rows: [row, row] });
  for (const [start, rows] of [
    [0, [tail, tail]],
    [1, [row]],
    [0, [row]],
  ])
    assert.equal(
      (await call({ kind: "chunk", identity, start, rows })).status,
      409,
    );
  await ok({ kind: "chunk", identity, start: 2, rows: [tail] });
  for (const overrides of [
    { sources: [other] },
    { source_rows: 4 },
    { network: "testnet" },
  ])
    assert.equal((await call(publication(overrides))).status, 409);
  assert.equal(
    (await db
      .prepare("SELECT COUNT(*) n FROM history_block_state")
      .first<{ n: number }>())!.n,
    0,
  );
});
test("publication rejects duplicate sources, stale/future receipts and incompatible table/snapshot identity", async () => {
  await complete();
  for (const extra of [
    { sources: [identity, identity] },
    { generated_at: now + 1 },
    { generated_at: now - 7200001 },
  ])
    assert.equal((await call(publication(extra))).status, 400);
  await ok(publication());
  for (const extra of [
    { sequence: 9 },
    { generated_at: now - 1 },
    { table_uuid: "019fc234-642e-7f82-b656-ddb8529315ac" },
    { snapshot: "1" },
  ])
    assert.equal((await call(publication(extra))).status, 409);
  const empty = await ok(
    publication({ network: "testnet", sources: [], source_rows: 0 }),
  );
  assert.equal(empty.source_rows, 0);
});
test("simultaneous identical chunks commit one copy and one histogram increment", async () => {
  await ok({ kind: "begin", identity, source: { ...source, rows: 1 } });
  const input = { kind: "chunk", identity, start: 0, rows: [row] };
  const responses = await Promise.all([call(input), call(input)]);
  assert.deepEqual(
    responses.map((r) => r.status),
    [200, 200],
  );
  assert.equal(
    (await db
      .prepare("SELECT COUNT(*) n FROM history_blocks")
      .first<{ n: number }>())!.n,
    1,
  );
  assert.deepEqual(
    (await db.prepare("SELECT rows FROM history_block_source_counts").all())
      .results,
    [{ rows: 1 }, { rows: 1 }],
  );
});
test("authentication and bounded parsing reject unavailable, unauthorized, malformed or oversized requests", async () => {
  assert.equal((await handleRetainedBlocksSync(request({}), {})).status, 503);
  assert.equal(
    (
      await handleRetainedBlocksSync(request({}), {
        RETAINED_BLOCKS_SYNC_SECRET: "secret",
      })
    ).status,
    503,
  );
  assert.equal(
    (await handleRetainedBlocksSync(request({}, "wrong"), env())).status,
    401,
  );
  assert.equal(
    (
      await handleRetainedBlocksSync(
        new Request("https://example.com", {
          headers: { "x-retained-blocks-sync-token": "test-secret" },
        }),
        env(),
      )
    ).status,
    405,
  );
  for (const body of [undefined, "invalid-json", "x".repeat(1024 * 1024 + 1)])
    assert.equal(
      (
        await handleRetainedBlocksSync(
          new Request("https://example.com", {
            method: "POST",
            headers: { "x-retained-blocks-sync-token": "test-secret" },
            body,
          }),
          env(),
        )
      ).status,
      400,
    );
  for (const body of [
    {},
    { kind: "chunk", identity, start: 0, rows: [] },
    { kind: "begin", identity, source: { ...source, rows: -1 } },
  ])
    assert.equal((await call(body)).status, 400);
  const broken = {
    ...env(),
    D1_RETAINED_BLOCKS: {
      prepare() {
        throw new Error("offline");
      },
    } as unknown as D1StoreBinding,
  };
  assert.equal(
    (
      await handleRetainedBlocksSync(
        request({ kind: "begin", identity, source }),
        broken,
      )
    ).status,
    503,
  );
});
test("actual data Worker routes the separately authenticated receiver", async () => {
  const ctx = {
    waitUntil(p: Promise<unknown>) {
      void p.catch(() => {});
    },
  } as ExecutionContext;
  const response = await dataWorker.fetch(
    request({ kind: "begin", identity, source }),
    dataApiEnv(env()),
    ctx,
  );
  assert.equal(response.status, 200, await response.clone().text());
  const main = await apiWorker.fetch(
    request({ kind: "begin", identity, source }),
    apiEnv({
      DATA_API: {
        fetch: (req: Request) => dataWorker.fetch(req, dataApiEnv(env()), ctx),
      },
    }),
    ctx,
  );
  assert.equal(main.status, 200, await main.clone().text());
  const absent = await apiWorker.fetch(
    request({ kind: "begin", identity, source }),
    apiEnv({}),
    ctx,
  );
  assert.equal(absent.status, 503);
});

test("testnet sources and simultaneous conflicting chunks cannot overwrite an accepted chunk", async () => {
  await ok({
    kind: "begin",
    identity,
    source: { ...source, network: "testnet", rows: 1 },
  });
  let release: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  let reads = 0;
  const wrapped = {
    prepare(sql: string) {
      const stmt = db.prepare(sql);
      if (!sql.startsWith("SELECT * FROM history_block_sources")) return stmt;
      return {
        bind(...values: unknown[]) {
          const bound = stmt.bind(...values);
          return {
            async first() {
              const result = await bound.first();
              if (++reads === 2) release();
              await barrier;
              return result;
            },
          };
        },
      };
    },
    batch: db.batch.bind(db),
  } as unknown as D1StoreBinding;
  const input = (rows: unknown[]) => ({
    kind: "chunk",
    identity,
    start: 0,
    rows,
  });
  const responses = await Promise.all([
    handleRetainedBlocksSync(
      request(input([row])),
      { ...env(), D1_RETAINED_BLOCKS: wrapped },
      now,
    ),
    handleRetainedBlocksSync(
      request(input([tail])),
      { ...env(), D1_RETAINED_BLOCKS: wrapped },
      now,
    ),
  ]);
  assert.deepEqual(responses.map((r) => r.status).sort(), [200, 409]);
  assert.equal(
    (await db
      .prepare("SELECT COUNT(*) n FROM history_blocks")
      .first<{ n: number }>())!.n,
    1,
  );
  await ok(
    publication({ network: "testnet", sources: [identity], source_rows: 1 }),
  );
});
test("a publisher losing compare-and-swap preserves the winner's membership and receipt", async () => {
  await complete();
  await ok(publication());
  let first = true;
  const wrapped = {
    prepare: db.prepare.bind(db),
    async batch(statements: D1PreparedStatement[]) {
      const result = await db.batch(statements);
      if (first) {
        first = false;
        await ok(publication({ sequence: 20, snapshot: "20" }));
      }
      return result;
    },
  } as D1StoreBinding;
  const result = await handleRetainedBlocksSync(
    request(publication({ sequence: 11, snapshot: "11" })),
    { ...env(), D1_RETAINED_BLOCKS: wrapped },
    now,
  );
  assert.equal(result.status, 409);
  assert.equal(
    (await db
      .prepare("SELECT sequence FROM history_block_state")
      .first<{ sequence: number }>())!.sequence,
    20,
  );
  assert.equal(
    (await db
      .prepare("SELECT COUNT(*) n FROM history_block_rows")
      .first<{ n: number }>())!.n,
    3,
  );
});

test("status pages identify the exact selected snapshot and fence concurrent changes", async () => {
  assert.deepEqual(await ok({ kind: "status", network: "testnet" }), {
    state: null,
    sources: [],
    next_cursor: null,
  });
  assert.equal(
    (await call({ kind: "status", network: "testnet", generation: identity }))
      .status,
    409,
  );
  await complete();
  const published = await ok(publication());
  const first = await ok({ kind: "status", network: "mainnet" });
  assert.equal(
    (first.state as { generation: string }).generation,
    published.generation,
  );
  assert.equal((first.sources as unknown[]).length, 1);
  const page = await ok({
    kind: "status",
    network: "mainnet",
    after: 0,
    generation: published.generation,
  });
  assert.deepEqual(page, first);
  assert.equal(
    (await call({ kind: "status", network: "mainnet", generation: other }))
      .status,
    409,
  );
  const paged = {
    prepare: db.prepare.bind(db),
    async batch() {
      return [
        { results: [{ generation: identity }] },
        { results: Array.from({ length: 201 }, (_, id) => ({ id: id + 1 })) },
      ];
    },
  } as unknown as D1StoreBinding;
  const response = await handleRetainedBlocksSync(
    request({ kind: "status", network: "mainnet" }),
    { ...env(), D1_RETAINED_BLOCKS: paged },
    now,
  );
  const data = await response.json<{
    next_cursor: number;
    sources: unknown[];
  }>();
  assert.equal(data.next_cursor, 200);
  assert.equal(data.sources.length, 200);
});
