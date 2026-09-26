import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, test } from "vitest";
import { Miniflare } from "miniflare";
import { createD1Store } from "../src/d1-store.ts";
import { writeChainDetailD1 } from "../src/chain-detail-d1-write.ts";
import {
  mirrorChainDetailToNeon,
  chainDetailTables,
} from "../src/chain-detail-neon-write.ts";
import { parseChainDetailSync } from "../src/chain-detail-sync-payload.ts";
import { mirrorBlocksHeadToNeon } from "../src/capture-state-neon-write.ts";
import {
  loadBlockExtrinsicsHotTier,
  loadBlockChainEventsHotTier,
  loadChainEventsHeadHotTier,
  loadExtrinsicHotTier,
} from "../src/chain-detail-hot-tier.ts";
import { loadExtrinsicFeedColdTier } from "../src/extrinsics-cold-tier.ts";
import { loadChainEventsColdTier } from "../src/chain-events-cold-tier.ts";
import { dataApiEnv } from "./helpers/worker-env.ts";
import worker, { neonOwnsChainDetail } from "../workers/data-api.ts";

const runtime = new Miniflare({
  modules: true,
  script: "export default {fetch(){return new Response('test')}}",
  compatibilityDate: "2026-06-06",
  d1Databases: ["DB"],
  r2Buckets: ["R2"],
});
let db: D1Database;
let archive: R2Bucket;
const stamp = 1790090000000;
const hash = `0x${"ab".repeat(32)}`;
const xtHash = `0x${"cd".repeat(32)}`;
const tables = ["blocks_head", ...chainDetailTables()];
const env = () =>
  dataApiEnv({
    D1_STATE: db,
    NATIVE_CHAIN_PAYLOADS: "enabled",
    D1_STATE_TABLES: tables.join(","),
    HYPERDRIVE: undefined,
    METAGRAPH_ARCHIVE: archive,
    CHAIN_DETAIL_SYNC_SECRET: "secret",
  });
const laneHealthDb = {
  async query() {
    return [];
  },
  async run() {
    return { changes: 1 };
  },
};
function payload(args = '[{"name":"now","type":"u64","value":1790090000000}]') {
  return {
    blocks: [
      {
        block_number: 9_000_001,
        block_hash: hash,
        observed_at: stamp,
        spec_version: 291,
        extrinsics: [
          {
            block_number: 9_000_001,
            extrinsic_index: 0,
            extrinsic_hash: xtHash,
            signer: null,
            call_module: "Timestamp",
            call_function: "set",
            success: null,
            fee_tao: null,
            tip_tao: null,
            call_args: args,
            observed_at: stamp,
          },
        ],
        chain_events: [
          {
            block_number: 9_000_001,
            event_index: 0,
            pallet: "System",
            method: "ExtrinsicSuccess",
            args: null,
            phase: "ApplyExtrinsic",
            extrinsic_index: 0,
            observed_at: stamp,
          },
        ],
        account_events: [],
      },
    ],
  };
}
function input(args?: string) {
  const parsed = parseChainDetailSync(payload(args), stamp);
  assert.ok(parsed.ok);
  return parsed.rows;
}
const count = (table: string) =>
  db.prepare(`SELECT COUNT(*) n FROM ${table}`).first<number>("n");
beforeAll(async () => {
  db = await runtime.getD1Database("DB");
  archive = (await runtime.getR2Bucket("R2")) as unknown as R2Bucket;
  for (const statement of readFileSync(
    new URL("../migrations/d1/0014_recent_chain_state.sql", import.meta.url),
    "utf8",
  ).split("-- statement-breakpoint"))
    if (statement.trim()) await db.prepare(statement).run();
});
afterAll(async () => runtime.dispose());
beforeEach(async () => {
  for (const table of tables) await db.prepare(`DELETE FROM ${table}`).run();
});

test("native chain detail preserves nullable outcomes and reader parity on replay", async () => {
  const rows = input();
  rows.accountEventRows.push({
    block_number: 9_000_001,
    event_index: 1,
    extrinsic_index: 0,
    event_kind: "Transfer",
    hotkey: "h",
    coldkey: "c",
    netuid: null,
    uid: null,
    amount_tao: "1.000000001",
    alpha_amount: null,
    observed_at: stamp,
  });
  for (let pass = 0; pass < 2; pass++) {
    const result = await mirrorChainDetailToNeon(env(), null, rows, {
      laneHealthDb,
      now: () => stamp,
    });
    assert.ok(Object.values(result.results).every((r) => r.ok));
  }
  for (const table of chainDetailTables()) assert.equal(await count(table), 1);
  assert.equal(
    await db
      .prepare("SELECT success FROM chain_detail_extrinsics")
      .first("success"),
    null,
  );
  assert.ok(await loadExtrinsicHotTier(env(), xtHash));
  assert.ok(
    await loadBlockExtrinsicsHotTier(env(), hash, 9_000_001, { limit: 20 }),
  );
  assert.ok(await loadBlockChainEventsHotTier(env(), 9_000_001));
  const empty = await writeChainDetailD1(createD1Store(db), env(), {
    blockRows: [],
    extrinsicRows: [],
    chainEventRows: [],
    accountEventRows: [],
  });
  assert.ok(Object.values(empty).every((r) => r.ok && r.rows === 0));
});

test("a bad late family rolls back detail and coverage together", async () => {
  const rows = input();
  rows.blockRows[0].block_hash = null;
  const result = await mirrorChainDetailToNeon(env(), null, rows, {
    laneHealthDb,
  });
  assert.ok(Object.values(result.results).every((r) => !r.ok && r.rows === 0));
  for (const table of chainDetailTables()) assert.equal(await count(table), 0);
  const tooMany = input();
  tooMany.extrinsicRows = Array.from(
    { length: 90_001 },
    () => tooMany.extrinsicRows[0],
  );
  const bounded = await writeChainDetailD1(createD1Store(db), env(), tooMany);
  assert.match(bounded.chain_detail_blocks.reason!, /statement budget/);
  assert.equal(await count("chain_detail_blocks"), 0);
});

test("a nine-megabyte call is compressed inline and hydrated without R2", async () => {
  const args = JSON.stringify([
    { name: "payload", type: "Vec<u8>", value: "x".repeat(9_088_840) },
  ]);
  const result = await mirrorChainDetailToNeon(env(), null, input(args), {
    laneHealthDb,
  });
  assert.ok(Object.values(result.results).every((r) => r.ok));
  const stored = await db
    .prepare("SELECT call_args FROM chain_detail_extrinsics")
    .first<string>("call_args");
  assert.match(stored!, /^\0metagraphed:payload:v1:.*:gzip:inline:/);
  const { restoreChainDetailPayloads } =
    await import("../src/chain-detail-payloads.ts");
  const restored = await restoreChainDetailPayloads(env(), [
    { call_args: stored },
  ]);
  assert.equal(restored[0].call_args, args);
  assert.ok(await loadExtrinsicHotTier(env(), xtHash));
  const unbound = { ...env(), METAGRAPH_ARCHIVE: undefined };
  assert.ok(await loadExtrinsicHotTier(unbound, xtHash));
  const replay = await mirrorChainDetailToNeon(unbound, null, input(args), {
    laneHealthDb,
  });
  assert.ok(Object.values(replay.results).every((r) => r.ok));
});

test("native header updates retain known author and event count", async () => {
  const row = {
    block_number: 9_000_001,
    block_hash: hash,
    parent_hash: hash,
    extrinsic_count: 1,
    event_count: 2,
    author: "validator",
    observed_at: stamp,
  };
  assert.ok(
    (await mirrorBlocksHeadToNeon(env(), null, row, { laneHealthDb })).result
      ?.ok,
  );
  assert.ok(
    (
      await mirrorBlocksHeadToNeon(
        env(),
        null,
        { ...row, event_count: null, author: null },
        { laneHealthDb },
      )
    ).result?.ok,
  );
  assert.deepEqual(
    await db.prepare("SELECT event_count,author FROM blocks_head").first(),
    { event_count: 2, author: "validator" },
  );
});

test("HTTP sync and resume use D1 without a Postgres binding", async () => {
  assert.equal(neonOwnsChainDetail(env()), true);
  assert.throws(
    () =>
      neonOwnsChainDetail(
        dataApiEnv({ ...env(), D1_STATE_TABLES: "chain_detail_blocks" }),
      ),
    /spans D1/,
  );
  const context = { waitUntil() {} } as unknown as ExecutionContext;
  const head = () =>
    worker.fetch(
      new Request("https://d/api/v1/internal/chain-detail-sync/head", {
        headers: { "x-chain-detail-sync-token": "secret" },
      }),
      env(),
      context,
    );
  assert.deepEqual(await (await head()).json(), { head: null });
  const response = await worker.fetch(
    new Request("https://d/api/v1/internal/chain-detail-sync", {
      method: "POST",
      headers: { "x-chain-detail-sync-token": "secret" },
      body: JSON.stringify(payload()),
    }),
    env(),
    context,
  );
  assert.equal(response.status, 200);
  assert.deepEqual(((await response.json()) as { stores: string[] }).stores, [
    "d1",
  ]);
  assert.deepEqual(await (await head()).json(), { head: 9_000_001 });
  await db
    .prepare("ALTER TABLE chain_detail_blocks RENAME TO held_blocks")
    .run();
  try {
    assert.equal((await head()).status, 503);
  } finally {
    await db
      .prepare("ALTER TABLE held_blocks RENAME TO chain_detail_blocks")
      .run();
  }
  const missingResult = dataApiEnv({
    ...env(),
    D1_STATE: {
      prepare() {
        return { all: async () => ({ results: [] }) };
      },
      batch: async () => [],
    } as unknown as D1Database,
  });
  const missing = await worker.fetch(
    new Request("https://d/api/v1/internal/chain-detail-sync/head", {
      headers: { "x-chain-detail-sync-token": "secret" },
    }),
    missingResult,
    context,
  );
  assert.equal(missing.status, 503);
});

test("compressed queue batches acknowledge only a durable atomic block", async () => {
  const { compressSyncBatchMessage } =
    await import("../src/sync-batch-compress.ts");
  const rows = input();
  const body = await compressSyncBatchMessage(
    {
      lane: "chain-detail",
      captured_at: stamp,
      families: {
        blockRows: rows.blockRows,
        extrinsicRows: rows.extrinsicRows,
        chainEventRows: rows.chainEventRows,
        accountEventRows: rows.accountEventRows,
      },
    },
    128 * 1024,
  );
  const calls: string[] = [];
  const message = {
    body,
    ack: () => calls.push("ack"),
    retry: () => calls.push("retry"),
  };
  const batch = {
    queue: "sync-batches",
    messages: [message],
  } as unknown as MessageBatch;
  const context = { waitUntil() {} } as unknown as ExecutionContext;
  await worker.queue(batch, env(), context);
  assert.deepEqual(calls, ["ack"]);
  assert.equal(await count("chain_detail_blocks"), 1);
  await db.prepare("DELETE FROM chain_detail_blocks").run();
  await db
    .prepare("ALTER TABLE chain_detail_extrinsics RENAME TO held_extrinsics")
    .run();
  calls.length = 0;
  try {
    await worker.queue(batch, env(), context);
    assert.deepEqual(calls, ["retry"]);
    assert.equal(await count("chain_detail_blocks"), 0);
  } finally {
    await db
      .prepare("ALTER TABLE held_extrinsics RENAME TO chain_detail_extrinsics")
      .run();
  }
});

test("native D1 chain-event cursors cross blocks without repeating the cursor block", async () => {
  for (let block = 100; block <= 102; block++)
    for (let index = 0; index < 4; index++)
      await db
        .prepare(
          "INSERT INTO chain_detail_chain_events(block_number,event_index,pallet,method,args,observed_at,phase) VALUES(?,?,?,?,?,?,?)",
        )
        .bind(
          block,
          index,
          "Balances",
          "Transfer",
          null,
          stamp,
          "ApplyExtrinsic",
        )
        .run();
  const page = await loadChainEventsHeadHotTier(env(), {
    limit: 3,
    ceiling: 102,
    floor: 101,
    cursorEventIndex: 2,
    pallet: "Balances",
    method: "Transfer",
  });
  assert.deepEqual(
    page?.map((row) => [row.block_number, row.event_index]),
    [
      [102, 1],
      [102, 0],
      [101, 3],
    ],
  );
  assert.deepEqual(
    await loadChainEventsHeadHotTier(env(), {
      limit: 3,
      ceiling: 102,
      floor: 102,
      cursorEventIndex: 0,
    }),
    [],
  );
  const first = await loadChainEventsColdTier(env(), { limit: 3, before: 103 });
  const second = await loadChainEventsColdTier(env(), {
    limit: 3,
    cursor: first?.next_cursor,
  });
  assert.deepEqual(
    first?.events.map((row) => [row.block_number, row.event_index]),
    [
      [102, 3],
      [102, 2],
      [102, 1],
    ],
  );
  assert.deepEqual(
    second?.events.map((row) => [row.block_number, row.event_index]),
    [
      [102, 0],
      [101, 3],
      [101, 2],
    ],
  );
});

test("D1 extrinsic feeds apply all bounds before LIMIT and cross tuple ties exactly", async () => {
  const signer = "5EYCAe5jLQhn6ofDSvqF6iY53erXNkwhyE1aCEgvi1NNs91F";
  for (let block = 100; block <= 103; block++)
    for (let index = 0; index < 4; index++)
      await db
        .prepare(
          "INSERT INTO chain_detail_extrinsics(block_number,extrinsic_index,extrinsic_hash,signer,call_module,call_function,success,observed_at) VALUES(?,?,?,?,?,?,?,?)",
        )
        .bind(
          block,
          index,
          `0x${(block * 10 + index).toString(16).padStart(64, "0")}`,
          signer,
          "SubtensorModule",
          "set_weights",
          index % 2 === 0 ? 1 : 0,
          stamp + (block === 103 ? 1 : 0),
        )
        .run();
  const ids = (page: Awaited<ReturnType<typeof loadExtrinsicFeedColdTier>>) =>
    page?.extrinsics.map((row) => [row.block_number, row.extrinsic_index]);
  const first = await loadExtrinsicFeedColdTier(env(), {
    limit: 3,
    from: String(stamp),
    to: String(stamp),
    blockStart: "100",
    blockEnd: "103",
  });
  assert.deepEqual(ids(first), [
    [102, 3],
    [102, 2],
    [102, 1],
  ]);
  const second = await loadExtrinsicFeedColdTier(env(), {
    limit: 3,
    from: stamp,
    to: stamp,
    blockStart: 100,
    blockEnd: 103,
    cursor: first?.next_cursor,
  });
  assert.deepEqual(ids(second), [
    [102, 0],
    [101, 3],
    [101, 2],
  ]);
  assert.deepEqual(
    ids(
      await loadExtrinsicFeedColdTier(env(), {
        limit: 2,
        block: "101",
        from: stamp,
        to: stamp,
        blockStart: "100",
        blockEnd: "102",
      }),
    ),
    [
      [101, 3],
      [101, 2],
    ],
  );
  assert.deepEqual(
    ids(await loadExtrinsicFeedColdTier(env(), { limit: 2, from: stamp + 1 })),
    [
      [103, 3],
      [103, 2],
    ],
  );
  assert.deepEqual(
    ids(
      await loadExtrinsicFeedColdTier(env(), {
        limit: 2,
        block: 102,
        from: stamp,
        to: stamp,
        signer,
        module: "SubtensorModule",
        callFunction: "set_weights",
        success: true,
      }),
    ),
    [
      [102, 2],
      [102, 0],
    ],
  );
});
