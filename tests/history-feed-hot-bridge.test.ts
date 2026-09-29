import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { Miniflare } from "miniflare";
import {
  ACCOUNT_EVENTS_COLUMNS,
  CHAIN_EVENTS_COLUMNS,
  EXTRINSICS_COLUMNS,
} from "../generated/lakehouse/types.ts";
import {
  hotAccountPredicate,
  hotExtrinsicPredicate,
  hotHistoryNumbers,
  hotHistoryPredicate,
  readHotHistoryTail,
} from "../src/history-feed-hot-bridge.ts";

const runtime = new Miniflare({
  modules: true,
  script: "export default {fetch(){return new Response('test')}}",
  compatibilityDate: "2026-06-06",
  d1Databases: ["DB"],
});
let db: D1Database;
const env = () => ({
  D1_STATE: db,
  D1_STATE_TABLES:
    "chain_detail_blocks,chain_detail_account_events,chain_detail_extrinsics,chain_detail_chain_events",
});
const all = () => hotAccountPredicate([{ side: "all", account: "*" }]);
const read = (predicate = all(), pageSize?: number) =>
  readHotHistoryTail(
    env(),
    "account_events",
    10,
    13,
    "mainnet",
    ACCOUNT_EVENTS_COLUMNS,
    predicate,
    pageSize,
  );
beforeAll(async () => {
  db = await runtime.getD1Database("DB");
  for (const file of [
    "0014_recent_chain_state.sql",
    "0033_account_event_subnet_tail_index.sql",
  ])
    for (const sql of readFileSync(
      new URL(`../migrations/d1/${file}`, import.meta.url),
      "utf8",
    ).split("-- statement-breakpoint"))
      if (sql.trim()) await db.prepare(sql).run();
});
afterAll(async () => runtime.dispose());
beforeEach(async () => {
  await db.batch(
    [
      "chain_detail_blocks",
      "chain_detail_account_events",
      "chain_detail_extrinsics",
      "chain_detail_chain_events",
    ].map((table) => db.prepare(`DELETE FROM ${table}`)),
  );
  for (const block of [11, 12, 13]) {
    await db
      .prepare(
        "INSERT INTO chain_detail_blocks(block_number,block_hash,extrinsic_count,chain_event_count,account_event_count,observed_at,synced_at) VALUES(?,?,0,0,1,?,1)",
      )
      .bind(block, `hash-${block}`, block * 1000)
      .run();
    await db
      .prepare(
        "INSERT INTO chain_detail_account_events(block_number,event_index,event_kind,hotkey,coldkey,netuid,amount_tao,alpha_amount,observed_at) VALUES(?,0,'Transfer',?,?,64,'1.25',NULL,?)",
      )
      .bind(block, block === 11 ? "alice" : "bob", "alice", block * 1000)
      .run();
  }
});
it("reads exactly the unindexed interval and unions overlapping identities once", async () => {
  const rows = await read(
    hotAccountPredicate([
      { side: "hotkey", account: "alice" },
      { side: "coldkey", account: "alice" },
    ]),
  );
  expect(rows?.map((row) => row.block_number)).toEqual([13, 12, 11]);
  expect((await read(all(), 2))?.map((row) => row.block_number)).toEqual([
    13, 12,
  ]);
  expect(
    await read(hotAccountPredicate([{ side: "hotkey", account: "absent" }])),
  ).toEqual([]);
});
it("bounds broad tail work independently of older rows without displacing account indexes", async () => {
  await db
    .prepare(
      `WITH RECURSIVE items(n) AS (SELECT 0 UNION ALL SELECT n+1 FROM items WHERE n<10000)
       INSERT INTO chain_detail_account_events(block_number,event_index,event_kind,hotkey,netuid,observed_at)
       SELECT 1,n,'Transfer','older',64,14000 FROM items`,
    )
    .run();
  const work: { rows: number; plans: string[] }[] = [];
  const measured = {
    ...env(),
    D1_STATE: {
      batch: db.batch.bind(db),
      prepare(text: string) {
        return {
          bind(...values: (string | number | null)[]) {
            return {
              async all() {
                const plan = await db
                  .prepare(`EXPLAIN QUERY PLAN ${text}`)
                  .bind(...values)
                  .all<{ detail: string }>();
                const result = await db
                  .prepare(text)
                  .bind(...values)
                  .all();
                work.push({
                  rows: result.meta.rows_read,
                  plans: plan.results.map((row) => row.detail),
                });
                return result;
              },
            };
          },
        };
      },
    },
  };
  for (const selectors of [
    [{ side: "all" as const, account: "*", kind: "Transfer", netuid: 64 }],
    [{ side: "hotkey" as const, account: "bob" }],
    [
      { side: "hotkey" as const, account: "bob" },
      { side: "all" as const, account: "*" },
    ],
  ]) {
    const rows = await readHotHistoryTail(
      measured,
      "account_events",
      10,
      13,
      "mainnet",
      ACCOUNT_EVENTS_COLUMNS,
      hotAccountPredicate(selectors),
      2,
    );
    expect(rows?.map((row) => row.block_number)).toEqual([13, 12]);
  }
  expect(work[0]!.rows).toBeLessThan(100);
  expect(work[0]!.plans.join("\n")).toContain(
    "idx_chain_detail_account_events_netuid_block (netuid=? AND block_number>? AND block_number<?)",
  );
  expect(work[1]!.plans.join("\n")).toContain(
    "idx_chain_detail_account_events_hotkey_observed",
  );
  expect(work[2]!.rows).toBeLessThan(100);
});
it("bounds subnet-filtered work inside a busy tail and preserves OR deduplication and cursors", async () => {
  await db
    .prepare(
      `WITH RECURSIVE items(n) AS
    (SELECT 1 UNION ALL SELECT n+1 FROM items WHERE n<10001)
    INSERT INTO chain_detail_account_events(block_number,event_index,event_kind,hotkey,netuid,observed_at)
    SELECT 12,n,'Transfer','other-subnet',99,12000 FROM items`,
    )
    .run();
  await db
    .prepare(
      `INSERT INTO chain_detail_account_events
    (block_number,event_index,event_kind,hotkey,netuid,observed_at)
    VALUES (12,10002,'StakeAdded','alice',65,12000)`,
    )
    .run();
  let reads = 0;
  const measured = {
    ...env(),
    D1_STATE: {
      batch: db.batch.bind(db),
      prepare(text: string) {
        return {
          bind(...values: (string | number | null)[]) {
            return {
              async all() {
                const result = await db
                  .prepare(text)
                  .bind(...values)
                  .all();
                reads = result.meta.rows_read;
                return result;
              },
            };
          },
        };
      },
    },
  };
  const predicate = hotAccountPredicate([
    {
      side: "all",
      account: "*",
      netuid: 64,
      kind: "Transfer",
      cursor: [13000, 13, 0],
    },
    { side: "all", account: "*", netuid: 65, kind: "StakeAdded" },
    { side: "hotkey", account: "bob", netuid: 64, cursor: [13000, 13, 0] },
  ]);
  expect(predicate.netuids).toEqual([64, 65]);
  const rows = await readHotHistoryTail(
    measured,
    "account_events",
    10,
    13,
    "mainnet",
    ACCOUNT_EVENTS_COLUMNS,
    predicate,
    10,
  );
  expect(reads).toBeLessThan(100);
  const reference = await read({ ...predicate, netuids: undefined }, 10);
  expect(rows).toEqual(reference);
  expect(rows?.map((row) => [row.block_number, row.event_index])).toEqual([
    [12, 10002],
    [12, 0],
    [11, 0],
  ]);
  expect(hotAccountPredicate([]).netuids).toBeUndefined();
  expect(
    hotAccountPredicate([{ side: "hotkey", account: "bob", netuid: 64 }])
      .netuids,
  ).toBeUndefined();
  expect(
    hotAccountPredicate([
      { side: "all", account: "*", netuid: 64 },
      { side: "all", account: "*" },
    ]).netuids,
  ).toBeUndefined();
});
it("preserves peer, kind, subnet, inclusive windows and the exclusive cursor", async () => {
  const rows = await read(
    hotAccountPredicate([
      {
        side: "coldkey",
        account: "alice",
        counterparty: "bob",
        kind: "Transfer",
        netuid: 64,
        blockStart: 12,
        blockEnd: 13,
        observedStart: 12000,
        observedEnd: 13000,
        cursor: [13000, 13, 0],
      },
    ]),
  );
  expect(rows?.map((row) => row.block_number)).toEqual([12]);
  expect(
    await read(
      hotAccountPredicate([
        {
          side: "hotkey",
          account: "bob",
          counterparty: "absent",
          kind: "Transfer",
        },
      ]),
    ),
  ).toEqual([]);
  expect(
    await read(
      hotAccountPredicate([{ side: "all", account: "*", kind: "StakeAdded" }]),
    ),
  ).toEqual([]);
});
it("binds extrinsic filters including false and keeps their sort/cursor contract", async () => {
  for (const [index, success] of [
    [0, 0],
    [1, 1],
  ])
    await db
      .prepare(
        "INSERT INTO chain_detail_extrinsics(block_number,extrinsic_index,signer,call_module,call_function,success,observed_at) VALUES(13,?,'alice','Balances','transfer',?,13000)",
      )
      .bind(index, success)
      .run();
  const rows = await readHotHistoryTail(
    env(),
    "extrinsics",
    10,
    13,
    "mainnet",
    EXTRINSICS_COLUMNS,
    hotExtrinsicPredicate({
      signer: "alice",
      module: "Balances",
      callFunction: "transfer",
      success: false,
      cursor: [13000, 13, 1],
    }),
    5,
  );
  expect(rows?.map((row) => row.extrinsic_index)).toEqual([0]);
});
it("counts a busy event tail completely while raw pages remain bounded and ordered by block", async () => {
  await db
    .prepare(
      `WITH RECURSIVE items(n) AS (SELECT 0 UNION ALL SELECT n+1 FROM items WHERE n<50001)
       INSERT INTO chain_detail_chain_events(block_number,event_index,pallet,method,phase,observed_at)
       SELECT CASE WHEN n=0 THEN 12 ELSE 13 END,n,'System','Success','Finalization',CASE WHEN n=0 THEN 14000 ELSE 13000 END FROM items`,
    )
    .run();
  const predicate = hotHistoryPredicate({}, "event_index", {});
  const page = await readHotHistoryTail(
    env(),
    "chain_events",
    10,
    13,
    "mainnet",
    CHAIN_EVENTS_COLUMNS,
    predicate,
    2,
  );
  expect(page?.map((row) => [row.block_number, row.event_index])).toEqual([
    [13, 50001],
    [13, 50000],
  ]);
  expect(
    await readHotHistoryTail(
      env(),
      "chain_events",
      10,
      13,
      "mainnet",
      ["pallet", "method", "count"],
      predicate,
      undefined,
      ["pallet", "method"],
    ),
  ).toEqual([{ pallet: "System", method: "Success", count: 50002 }]);
});
it("never substitutes mainnet hot state for testnet, an uncovered gap or an unowned store", async () => {
  expect(
    await readHotHistoryTail(
      env(),
      "account_events",
      10,
      13,
      "testnet",
      ACCOUNT_EVENTS_COLUMNS,
      all(),
    ),
  ).toBeUndefined();
  expect(
    await readHotHistoryTail(
      {},
      "account_events",
      10,
      13,
      "mainnet",
      ACCOUNT_EVENTS_COLUMNS,
      all(),
    ),
  ).toBeUndefined();
  expect(
    await readHotHistoryTail(
      env(),
      "account_events",
      10,
      32779,
      "mainnet",
      ACCOUNT_EVENTS_COLUMNS,
      all(),
    ),
  ).toBeUndefined();
  expect(
    await readHotHistoryTail(
      {},
      "account_events",
      13,
      13,
      "testnet",
      ACCOUNT_EVENTS_COLUMNS,
      all(),
    ),
  ).toEqual([]);
  await db
    .prepare("DELETE FROM chain_detail_blocks WHERE block_number=12")
    .run();
  expect(await read()).toBeUndefined();
  await db.prepare("DELETE FROM chain_detail_blocks").run();
  expect(await read()).toBeUndefined();
});
it("keeps literal-looking input bound and parses decimal/null cells without replacing bad data", async () => {
  expect(
    await read(
      hotAccountPredicate([{ side: "hotkey", account: "' OR 1=1 --" }]),
    ),
  ).toEqual([]);
  expect(
    hotHistoryNumbers({ a: "1.25", b: null, c: 2 }, ["a", "b", "c"]),
  ).toEqual({ a: 1.25, b: null, c: 2 });
  expect(() => hotHistoryNumbers({ a: "" }, ["a"])).toThrow("numeric cell");
  expect(() => hotHistoryNumbers({ a: {} }, ["a"])).toThrow("numeric cell");
  expect(
    hotHistoryPredicate({}, "event_index", { pallet: null }).values,
  ).toHaveLength(4);
});
it("rejects truncated aggregate reads and oversized payloads before parsing or returning a prefix", async () => {
  const coverage = { first: 11, last: 13, rows: 3, record: null };
  let results: {
    first: number | null;
    last: number | null;
    rows: number | null;
    record: string | null;
  }[] = [];
  const statement = {
    bind: () => statement,
    all: async () => ({ results: [...results] }),
  };
  const fake = {
    ...env(),
    D1_STATE: { prepare: () => statement, batch: async () => [] },
  };
  const check = () =>
    readHotHistoryTail(
      fake,
      "account_events",
      10,
      13,
      "mainnet",
      ACCOUNT_EVENTS_COLUMNS,
      all(),
    );
  expect(await check()).toBeUndefined();
  results = [
    coverage,
    ...Array.from({ length: 50_001 }, () => ({
      first: null,
      last: null,
      rows: null,
      record: "{}",
    })),
  ];
  expect(await check()).toBeUndefined();
  results = [
    coverage,
    {
      first: null,
      last: null,
      rows: null,
      record: "x".repeat(32 * 1024 * 1024 + 1),
    },
  ];
  await expect(check()).rejects.toThrow("byte budget");
});
