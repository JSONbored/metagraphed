import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { beforeAll, afterAll, beforeEach, test, vi } from "vitest";
import { Miniflare } from "miniflare";
const { pg } = await vi.hoisted(async () => ({
  pg: (await import("./helpers/pg-mock.ts")).createPgMock(),
}));
vi.mock("pg", () => pg.module);
import { pruneChainDetail } from "../src/chain-detail-prune.ts";
import { answerExtrinsicDetail } from "../src/chain-detail-hot-tier.ts";
import { chainDetailTables } from "../src/chain-detail-neon-write.ts";
import { runNeonPrune, NEON_PRUNE_PLANS } from "../src/neon-prune.ts";
import { DEFAULT_BLOCKS_SEAM } from "../src/blocks-cold-tier.ts";
import { resetDecodeWatermarkCache } from "../src/decode-watermark.ts";
import { writeChainDetailD1 } from "../src/chain-detail-d1-write.ts";
import { createD1Store } from "../src/d1-store.ts";

const runtime = new Miniflare({
  modules: true,
  script: "export default {fetch(){return new Response('test')}}",
  compatibilityDate: "2026-06-06",
  d1Databases: ["DB"],
});
let db: D1Database;
const tables = chainDetailTables();
const ctx = { waitUntil() {} };
const hyperdrive = {
  connectionString: "postgresql://test:test@example.com/test",
};
const env = () => ({
  D1_STATE: db,
  D1_STATE_TABLES: tables.join(","),
  HYPERDRIVE: hyperdrive,
});
const head = DEFAULT_BLOCKS_SEAM + 1000;
const floor = head - 3000;
const accountFloor = head - 9000 + 1;
async function seed() {
  for (const block of [floor, floor + 119, floor + 120, head]) {
    await db.batch([
      db
        .prepare(
          "INSERT INTO chain_detail_blocks(block_number,block_hash,extrinsic_count,chain_event_count,account_event_count,observed_at,synced_at) VALUES(?,'hash',1,1,1,1,1)",
        )
        .bind(block),
      db
        .prepare(
          "INSERT INTO chain_detail_extrinsics(block_number,extrinsic_index,observed_at) VALUES(?,0,1)",
        )
        .bind(block),
      db
        .prepare(
          "INSERT INTO chain_detail_chain_events(block_number,event_index,pallet,method,phase,observed_at) VALUES(?,0,'System','Success','ApplyExtrinsic',1)",
        )
        .bind(block),
      db
        .prepare(
          "INSERT INTO chain_detail_account_events(block_number,event_index,event_kind,observed_at) VALUES(?,0,'Transfer',1)",
        )
        .bind(block),
    ]);
  }
  for (const block of [accountFloor - 1, accountFloor])
    await db
      .prepare(
        "INSERT INTO chain_detail_account_events(block_number,event_index,event_kind,observed_at) VALUES(?,0,'Transfer',1)",
      )
      .bind(block)
      .run();
}
const blocks = async (table: string) =>
  (
    await db
      .prepare(`SELECT block_number FROM ${table} ORDER BY block_number`)
      .all<{ block_number: number }>()
  ).results.map((row) => row.block_number);
beforeAll(async () => {
  db = await runtime.getD1Database("DB");
  for (const sql of readFileSync(
    new URL("../migrations/d1/0014_recent_chain_state.sql", import.meta.url),
    "utf8",
  ).split("-- statement-breakpoint"))
    if (sql.trim()) await db.prepare(sql).run();
});
afterAll(async () => runtime.dispose());
beforeEach(async () => {
  await db.prepare("DROP TRIGGER IF EXISTS reject_prune").run();
  await db.prepare("DROP TRIGGER IF EXISTS reject_replay").run();
  for (const table of tables) await db.prepare(`DELETE FROM ${table}`).run();
  resetDecodeWatermarkCache();
  pg.control.connects = 0;
  pg.control.queries.length = 0;
  pg.control.rows = [{ doomed: 2, survivors: 3 }];
});

test("D1 retention applies the bounded block window and deeper account floor without Neon", async () => {
  await seed();
  for (const HYPERDRIVE of [hyperdrive, undefined]) {
    const result = await pruneChainDetail({ ...env(), HYPERDRIVE }, ctx);
    assert.equal(result.ok, true);
    assert.equal(result.d1_pruned, true);
    assert.equal(result.neon_pruned, undefined);
    assert.equal(result.blocks_pruned, 120);
  }
  for (const table of tables)
    assert.deepEqual(
      await blocks(table),
      table === "chain_detail_account_events"
        ? [accountFloor, floor, floor + 119, floor + 120, head]
        : [head],
    );
  assert.equal(pg.control.connects, 0);
  assert.deepEqual(pg.control.queries, []);
});

test("a late D1 delete failure rolls back every detail table and coverage", async () => {
  await seed();
  const before = await Promise.all(tables.map(blocks));
  await db
    .prepare(
      "CREATE TRIGGER reject_prune BEFORE DELETE ON chain_detail_blocks BEGIN SELECT RAISE(ABORT,'retention rejected'); END",
    )
    .run();
  const result = await pruneChainDetail(env(), ctx);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "prune_failed");
  assert.match(result.detail!, /retention rejected/);
  assert.equal(result.blocks_pruned, undefined);
  assert.deepEqual(await Promise.all(tables.map(blocks)), before);
  assert.equal(pg.control.connects, 0);
});

function completeReplay(block: number, hash: string) {
  return {
    blockRows: [
      {
        block_number: block,
        block_hash: `0x${"12".repeat(32)}`,
        extrinsic_count: 1,
        chain_event_count: 1,
        account_event_count: 2,
        observed_at: 1,
        synced_at: 1,
        subnet_ids: "[]",
        economics_complete: 0,
      },
    ],
    extrinsicRows: [
      {
        block_number: block,
        extrinsic_index: 0,
        extrinsic_hash: hash,
        call_module: "Balances",
        call_function: "transfer_keep_alive",
        success: 1,
        fee_tao: "0.25",
        tip_tao: "0",
        call_args: "{}",
        observed_at: 1,
      },
    ],
    chainEventRows: [
      {
        block_number: block,
        event_index: 0,
        pallet: "Balances",
        method: "Transfer",
        phase: "ApplyExtrinsic",
        extrinsic_index: 0,
        args: "{}",
        observed_at: 1,
      },
    ],
    accountEventRows: [0, 1].map((event_index) => ({
      block_number: block,
      event_index,
      extrinsic_index: 0,
      event_kind: "Transfer",
      hotkey: null,
      coldkey: null,
      netuid: null,
      uid: null,
      amount_tao: event_index === 0 ? "0.5" : "0.75",
      alpha_amount: null,
      observed_at: 1,
    })),
  };
}

async function replayThroughOwner(block: number, hash: string) {
  const result = await writeChainDetailD1(
    createD1Store(db),
    env(),
    completeReplay(block, hash),
  );
  assert.ok(Object.values(result).every((value) => value.ok));
}

async function exactReplayCells(block: number) {
  return Promise.all(
    tables.map(async (table) =>
      (
        await db
          .prepare(`SELECT * FROM ${table} WHERE block_number=?`)
          .bind(block)
          .all()
      ).results
        .map((row) => JSON.stringify(row))
        .sort(),
    ),
  );
}

function assertNoAccountPrefix(
  result: Awaited<ReturnType<typeof pruneChainDetail>>,
) {
  assert.equal("account_events_deleted_below" in result, false);
  assert.equal("account_events_blocks_pruned" in result, false);
}

test.each([1, 3])(
  "account-only retention preserves a replay committed before batch %i",
  async (beforeBatch) => {
    const { old, selected } = await accountOnlyFixture();
    const block = old + (beforeBatch - 1) * 10 + 5;
    const hash = `0x${"ab".repeat(32)}`;
    const cold = vi.fn(async () => {
      throw new Error("replayed hot hash must stay hot");
    });
    let calls = 0;
    let before: Awaited<ReturnType<typeof answerExtrinsicDetail>> | undefined;
    let cells: Awaited<ReturnType<typeof exactReplayCells>> | undefined;
    const owned = {
      ...env(),
      ...selected,
      D1_STATE: {
        prepare: db.prepare.bind(db),
        async batch(statements: D1PreparedStatement[]) {
          if (++calls === beforeBatch) {
            await replayThroughOwner(block, hash);
            before = await answerExtrinsicDetail(env(), hash, cold);
            assert.equal(
              before.kind === "answer" && before.data.events.length,
              2,
            );
            cells = await exactReplayCells(block);
          }
          return db.batch(statements);
        },
      },
    };
    const result = await pruneChainDetail(owned, ctx);
    assert.equal(result.ok, true);
    assert.deepEqual(
      await answerExtrinsicDetail(env(), hash, cold),
      before,
      "hot hash events changed after replay",
    );
    assert.deepEqual(await exactReplayCells(block), cells);
    assert.equal(cold.mock.calls.length, 0);
    assert.equal(calls, 12);
    assertNoAccountPrefix(result);
    assert.equal(result.account_events_rows_pruned, block - old);
    assert.equal(pg.control.connects, 0);
  },
);

test.each([1, 3])(
  "a replay after account deletion batch %i commits its complete hot hash",
  async (afterBatch) => {
    const { old, selected } = await accountOnlyFixture();
    const block = old + (afterBatch - 1) * 10 + 5;
    const hash = `0x${"bc".repeat(32)}`;
    const cold = vi.fn(async () => {
      throw new Error("replayed hot hash must stay hot");
    });
    let calls = 0;
    let before: Awaited<ReturnType<typeof answerExtrinsicDetail>> | undefined;
    let cells: Awaited<ReturnType<typeof exactReplayCells>> | undefined;
    const result = await pruneChainDetail(
      {
        ...env(),
        ...selected,
        D1_STATE: {
          prepare: db.prepare.bind(db),
          async batch(statements: D1PreparedStatement[]) {
            const result = await db.batch(statements);
            if (++calls === afterBatch) {
              await replayThroughOwner(block, hash);
              before = await answerExtrinsicDetail(env(), hash, cold);
              assert.equal(
                before.kind === "answer" && before.data.events.length,
                2,
              );
              cells = await exactReplayCells(block);
            }
            return result;
          },
        },
      },
      ctx,
    );
    assert.equal(result.ok, true);
    assert.deepEqual(await answerExtrinsicDetail(env(), hash, cold), before);
    assert.deepEqual(await exactReplayCells(block), cells);
    assert.equal(cold.mock.calls.length, 0);
    assertNoAccountPrefix(result);
    assert.equal(result.account_events_rows_pruned, afterBatch * 10);
  },
);

for (const mode of ["abort", "lost-ack"])
  test.each([1, 3])(
    `a replay survives ${mode} ordering at account batch %i`,
    async (beforeBatch) => {
      const { old, selected } = await accountOnlyFixture();
      const first = old + (beforeBatch - 1) * 10;
      const block = first + 5;
      const hash = `0x${"cd".repeat(32)}`;
      const cold = vi.fn(async () => {
        throw new Error("replayed hot hash must stay hot");
      });
      let calls = 0;
      let before: Awaited<ReturnType<typeof answerExtrinsicDetail>> | undefined;
      let cells: Awaited<ReturnType<typeof exactReplayCells>> | undefined;
      let accountBefore: unknown[] = [];
      const result = await pruneChainDetail(
        {
          ...env(),
          ...selected,
          D1_STATE: {
            prepare: db.prepare.bind(db),
            async batch(statements: D1PreparedStatement[]) {
              const injecting = ++calls === beforeBatch;
              if (injecting) {
                await replayThroughOwner(block, hash);
                before = await answerExtrinsicDetail(env(), hash, cold);
                cells = await exactReplayCells(block);
                accountBefore = await blocks("chain_detail_account_events");
                if (mode === "abort")
                  await db
                    .prepare(
                      `CREATE TRIGGER reject_prune BEFORE DELETE ON chain_detail_account_events WHEN OLD.block_number=${first + 2} BEGIN SELECT RAISE(ABORT,'replay ordering rejected'); END`,
                    )
                    .run();
              }
              const result = await db.batch(statements);
              if (injecting && mode === "lost-ack")
                throw new Error("replay ordering acknowledgement lost");
              return result;
            },
          },
        },
        ctx,
      );
      assert.equal(result.ok, false);
      assert.match(result.detail!, /replay ordering/);
      assert.equal(calls, beforeBatch);
      assert.deepEqual(await answerExtrinsicDetail(env(), hash, cold), before);
      assert.deepEqual(await exactReplayCells(block), cells);
      assert.deepEqual(
        await blocks("chain_detail_account_events"),
        mode === "abort"
          ? accountBefore
          : accountBefore.filter((height) => Number(height) >= block),
      );
      assert.equal(result.account_events_rows_pruned, undefined);
      assertNoAccountPrefix(result);
      assert.equal(cold.mock.calls.length, 0);
    },
  );

test("a replay rejected at its block register commits none of its hot families", async () => {
  const { old, selected } = await accountOnlyFixture();
  const block = old + 5,
    hash = `0x${"de".repeat(32)}`;
  let injected = false;
  const result = await pruneChainDetail(
    {
      ...env(),
      ...selected,
      D1_STATE: {
        prepare: db.prepare.bind(db),
        async batch(statements: D1PreparedStatement[]) {
          if (!injected) {
            injected = true;
            const beforeReplay = await exactReplayCells(block);
            await db
              .prepare(
                `CREATE TRIGGER reject_replay BEFORE INSERT ON chain_detail_blocks WHEN NEW.block_number=${block} BEGIN SELECT RAISE(ABORT,'replay register rejected'); END`,
              )
              .run();
            const replay = await writeChainDetailD1(
              createD1Store(db),
              env(),
              completeReplay(block, hash),
            );
            assert.ok(Object.values(replay).every((value) => !value.ok));
            assert.deepEqual(await exactReplayCells(block), beforeReplay);
            assert.deepEqual(await blocks("chain_detail_extrinsics"), []);
            assert.deepEqual(await blocks("chain_detail_chain_events"), []);
            assert.deepEqual(await blocks("chain_detail_blocks"), [
              head - 1800 + 1,
              head,
            ]);
          }
          return db.batch(statements);
        },
      },
    },
    ctx,
  );
  assert.equal(result.ok, true);
  assert.deepEqual(await answerExtrinsicDetail(env(), hash, async () => null), {
    kind: "miss",
  });
  assert.equal(result.account_events_rows_pruned, 120);
  assertNoAccountPrefix(result);
});

test("account-only retention fails closed when the live detail register disappears", async () => {
  const { selected } = await accountOnlyFixture();
  const before = await blocks("chain_detail_account_events");
  let injected = false;
  const result = await pruneChainDetail(
    {
      ...env(),
      ...selected,
      D1_STATE: {
        prepare: db.prepare.bind(db),
        async batch(statements: D1PreparedStatement[]) {
          if (!injected) {
            injected = true;
            await db.prepare("DELETE FROM chain_detail_blocks").run();
          }
          return db.batch(statements);
        },
      },
    },
    ctx,
  );
  assert.equal(result.ok, true);
  assert.equal(result.account_events_rows_pruned, 0);
  assertNoAccountPrefix(result);
  assert.deepEqual(await blocks("chain_detail_account_events"), before);
});

test("an account-event backlog is bounded from its own floor", async () => {
  await seed();
  const old = accountFloor - 10_000;
  for (const block of [old, old + 119, old + 120, accountFloor - 1])
    await db
      .prepare(
        "INSERT OR IGNORE INTO chain_detail_account_events(block_number,event_index,event_kind,observed_at) VALUES(?,0,'Transfer',1)",
      )
      .bind(block)
      .run();
  const result = await pruneChainDetail(env(), ctx);
  assert.equal(result.ok, true);
  assert.equal(result.blocks_pruned, 120);
  assert.deepEqual(await blocks("chain_detail_account_events"), [
    old + 120,
    accountFloor - 1,
    accountFloor,
    floor,
    floor + 119,
    floor + 120,
    head,
  ]);
});

test("a later D1 chunk failure leaves a complete pruned prefix", async () => {
  await seed();
  await db
    .prepare(
      `CREATE TRIGGER reject_prune BEFORE DELETE ON chain_detail_blocks
       WHEN OLD.block_number >= ${floor + 10}
       BEGIN SELECT RAISE(ABORT,'later chunk rejected'); END`,
    )
    .run();
  const result = await pruneChainDetail(env(), ctx);
  assert.equal(result.ok, false);
  assert.equal(result.blocks_pruned, undefined);
  assert.match(result.detail!, /later chunk rejected/);
  for (const table of tables)
    assert.deepEqual(
      await blocks(table),
      table === "chain_detail_account_events"
        ? [accountFloor, floor, floor + 119, floor + 120, head]
        : [floor + 119, floor + 120, head],
    );
});

test("an empty account-event table does not prevent bounded coverage cleanup", async () => {
  await seed();
  await db.prepare("DELETE FROM chain_detail_account_events").run();
  const result = await pruneChainDetail(env(), ctx);
  assert.equal(result.ok, true);
  assert.equal(result.blocks_pruned, 120);
  assert.deepEqual(await blocks("chain_detail_account_events"), []);
  assert.deepEqual(await blocks("chain_detail_blocks"), [floor + 120, head]);
});

function selectedHistory(through: Record<string, number>, firstBlock = 0) {
  return {
    NATIVE_PROJECTIONS: "enabled",
    METAGRAPH_ARCHIVE: {
      get: vi.fn(async (key: string) => {
        const table = key.split("/").at(-2)!;
        if (!(table in through)) return null;
        const generation = "a".repeat(64);
        const root = `metagraph/indexed-history/v1/mainnet/${table}/generations/${generation}`;
        return {
          size: 1024,
          json: async () => ({
            version: 1,
            network: "mainnet",
            table,
            generation,
            firstBlock,
            lastBlock: through[table],
            blockManifest: {
              key: `${root}/block-manifest.json`,
              etag: "b".repeat(32),
              bytes: 100,
            },
          }),
        };
      }),
    },
  };
}

test.each(["blocks", "extrinsics", "chain_events", "account_events"])(
  "D1 retention follows the slowest published %s index, not the decoded watermark",
  async (lagging) => {
    await seed();
    const selected = selectedHistory({
      blocks: head,
      extrinsics: head,
      chain_events: head,
      account_events: head,
      [lagging]: floor - 1,
    });
    const before = await Promise.all(tables.map(blocks));
    const result = await pruneChainDetail({ ...env(), ...selected }, ctx);
    assert.equal(result.ok, true);
    assert.equal(result.keep_from, floor);
    assert.equal(result.blocks_pruned, 0);
    assert.deepEqual(
      await Promise.all(tables.map(blocks)),
      before.map((rows, index) =>
        tables[index] === "chain_detail_account_events"
          ? rows.filter((block) => block >= accountFloor)
          : rows,
      ),
    );
    assert.equal(selected.METAGRAPH_ARCHIVE.get.mock.calls.length, 4);
  },
);

test("caught-up serving indexes retain the normal bounded D1 cleanup", async () => {
  await seed();
  const selected = selectedHistory({
    blocks: head,
    extrinsics: head,
    chain_events: head,
    account_events: head,
  });
  const result = await pruneChainDetail({ ...env(), ...selected }, ctx);
  assert.equal(result.ok, true);
  assert.equal(result.blocks_pruned, 120);
  assert.equal(result.retained_blocks, 1800);
});

test("a native publication outage cannot age unserved rows past the retention ceiling", async () => {
  await seed();
  const old = head - 15_000;
  await db
    .prepare(
      "INSERT INTO chain_detail_blocks(block_number,block_hash,extrinsic_count,chain_event_count,account_event_count,observed_at,synced_at) VALUES(?,'old',0,0,0,1,1)",
    )
    .bind(old)
    .run();
  const selected = selectedHistory({
    blocks: head,
    extrinsics: old - 1,
    chain_events: head,
    account_events: head,
  });
  const before = await Promise.all(tables.map(blocks));
  const result = await pruneChainDetail({ ...env(), ...selected }, ctx);
  assert.equal(result.ok, true);
  assert.equal(result.keep_from, old);
  assert.equal(result.retained_blocks, 15_001);
  assert.equal(result.blocks_pruned, 0);
  assert.deepEqual(await Promise.all(tables.map(blocks)), before);
});

test.each(["missing", "partial", "unbound"])(
  "D1 retention preserves all rows when selected history is %s",
  async (state) => {
    await seed();
    const selected = selectedHistory(
      {
        blocks: head,
        extrinsics: head,
        chain_events: head,
        account_events: head,
      },
      state === "partial" ? 1 : 0,
    );
    if (state === "missing")
      selected.METAGRAPH_ARCHIVE.get.mockResolvedValue(null);
    const before = await Promise.all(tables.map(blocks));
    const result = await pruneChainDetail(
      {
        ...env(),
        ...selected,
        ...(state === "unbound" ? { METAGRAPH_ARCHIVE: undefined } : {}),
      },
      ctx,
    );
    assert.equal(result.ok, false);
    assert.equal(result.reason, "prune_failed");
    assert.match(result.detail!, /Selected history coverage unavailable/);
    assert.deepEqual(await Promise.all(tables.map(blocks)), before);
  },
);

test("selected D1 retention refuses a missing binding or mixed family", async () => {
  await assert.rejects(
    pruneChainDetail({ ...env(), D1_STATE: undefined }, ctx),
    /unbound/,
  );
  await assert.rejects(
    pruneChainDetail({ ...env(), D1_STATE_TABLES: tables[0] }, ctx),
    /spans D1 and Neon/,
  );
  assert.equal(pg.control.connects, 0);
});

test("fully migrated rolling windows skip Neon while still recording a healthy handoff", async () => {
  const verdicts: unknown[][] = [];
  const laneHealthDb = {
    async query() {
      return [];
    },
    async run(sql: string, values: unknown[] = []) {
      if (sql.startsWith("INSERT")) verdicts.push(values);
      return { changes: 1 };
    },
  };
  const owned = {
    ...env(),
    D1_STATE_TABLES: Object.keys(NEON_PRUNE_PLANS).join(","),
  };
  const expected = { attempted: false, outcomes: [] };
  assert.deepEqual(
    await runNeonPrune(owned, ctx, { laneHealthDb, now: () => 123 }),
    expected,
  );
  assert.deepEqual(
    await runNeonPrune({ ...owned, HYPERDRIVE: undefined }, ctx, {
      laneHealthDb,
    }),
    expected,
  );
  assert.equal(verdicts.length, 2);
  assert.equal(verdicts[0]![1], "ok");
  assert.equal(verdicts[0]![3], "retention owned by D1 capture lanes");
  assert.equal(pg.control.connects, 0);
});

test("mixed window ownership prunes only Neon tables and unbound D1 fails closed", async () => {
  const owned = { ...env(), D1_STATE_TABLES: "surface_checks" };
  const out = await runNeonPrune(owned, ctx);
  assert.equal(out.attempted, true);
  assert.deepEqual(
    out.outcomes?.map((item) => item.table),
    ["subnet_burn_history"],
  );
  assert.ok(
    pg.control.queries.some((q) =>
      q.text.startsWith("DELETE FROM subnet_burn_history"),
    ),
  );
  assert.ok(!pg.control.queries.some((q) => q.text.includes("surface_checks")));
  const connections = pg.control.connects;
  await assert.rejects(
    runNeonPrune({ ...owned, D1_STATE: undefined }, ctx),
    /unbound/,
  );
  assert.equal(pg.control.connects, connections);
});

test("a published detail seam does not stall the older account-only retention window", async () => {
  const liveHead = 9_268_821;
  const detailFloor = 9_261_070;
  const oldAccount = 9_253_944;
  const accountKeep = liveHead - 9_000 + 1;
  for (const block of [detailFloor, liveHead])
    await db
      .prepare(
        "INSERT INTO chain_detail_blocks(block_number,block_hash,extrinsic_count,chain_event_count,account_event_count,observed_at,synced_at) VALUES(?,'hash',0,0,0,1,1)",
      )
      .bind(block)
      .run();
  for (const block of [
    oldAccount,
    oldAccount + 9,
    oldAccount + 10,
    oldAccount + 119,
    oldAccount + 120,
    accountKeep - 1,
    accountKeep,
    detailFloor,
  ])
    await db
      .prepare(
        "INSERT INTO chain_detail_account_events(block_number,event_index,event_kind,observed_at) VALUES(?,0,'Transfer',1)",
      )
      .bind(block)
      .run();
  const selected = selectedHistory({
    blocks: 9_265_409,
    extrinsics: 9_263_769,
    account_events: 9_263_769,
    chain_events: 9_261_069,
  });
  const before = await Promise.all(
    tables
      .filter((table) => table !== "chain_detail_account_events")
      .map(blocks),
  );
  const result = await pruneChainDetail({ ...env(), ...selected }, ctx);
  assert.equal(result.ok, true);
  assert.equal(result.keep_from, detailFloor);
  assert.equal(result.account_events_rows_pruned, 4);
  assert.equal(result.blocks_pruned, 0);
  assert.deepEqual(await blocks("chain_detail_account_events"), [
    oldAccount + 120,
    accountKeep - 1,
    accountKeep,
    detailFloor,
  ]);
  assert.deepEqual(
    await Promise.all(
      tables
        .filter((table) => table !== "chain_detail_account_events")
        .map(blocks),
    ),
    before,
  );
  assert.equal(pg.control.connects, 0);
});

test("one remaining detail height does not limit an independent account prefix to ten heights", async () => {
  const detailFloor = head - 1_800;
  const oldAccount = accountFloor - 500;
  for (const block of [detailFloor, head])
    await db
      .prepare(
        "INSERT INTO chain_detail_blocks(block_number,block_hash,extrinsic_count,chain_event_count,account_event_count,observed_at,synced_at) VALUES(?,'hash',0,0,0,1,1)",
      )
      .bind(block)
      .run();
  for (const block of [
    oldAccount,
    oldAccount + 9,
    oldAccount + 10,
    oldAccount + 119,
    oldAccount + 120,
    accountFloor,
  ])
    await db
      .prepare(
        "INSERT INTO chain_detail_account_events(block_number,event_index,event_kind,observed_at) VALUES(?,0,'Transfer',1)",
      )
      .bind(block)
      .run();
  const selected = selectedHistory({
    blocks: head,
    extrinsics: head,
    account_events: head,
    chain_events: head,
  });
  const result = await pruneChainDetail({ ...env(), ...selected }, ctx);
  assert.equal(result.ok, true);
  assert.equal(result.blocks_pruned, 1);
  assert.deepEqual(await blocks("chain_detail_account_events"), [
    oldAccount + 120,
    accountFloor,
  ]);
  assert.deepEqual(await blocks("chain_detail_blocks"), [head]);
});

test("an account-only failure rolls back its ten-height chunk and preserves the committed prefix", async () => {
  const detailFloor = head - 1800 + 1;
  const oldAccount = accountFloor - 500;
  for (const block of [detailFloor, head])
    await db
      .prepare(
        "INSERT INTO chain_detail_blocks(block_number,block_hash,extrinsic_count,chain_event_count,account_event_count,observed_at,synced_at) VALUES(?,'hash',0,0,0,1,1)",
      )
      .bind(block)
      .run();
  for (const block of [
    oldAccount,
    oldAccount + 9,
    oldAccount + 10,
    oldAccount + 11,
    oldAccount + 120,
    accountFloor,
  ])
    await db
      .prepare(
        "INSERT INTO chain_detail_account_events(block_number,event_index,event_kind,observed_at) VALUES(?,0,'Transfer',1)",
      )
      .bind(block)
      .run();
  await db
    .prepare(
      `CREATE TRIGGER reject_prune BEFORE DELETE ON chain_detail_account_events WHEN OLD.block_number = ${oldAccount + 11} BEGIN SELECT RAISE(ABORT,'account chunk rejected'); END`,
    )
    .run();
  const selected = selectedHistory({
    blocks: head,
    extrinsics: head,
    account_events: head,
    chain_events: head,
  });
  const result = await pruneChainDetail({ ...env(), ...selected }, ctx);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "prune_failed");
  assert.match(result.detail!, /account chunk rejected/);
  assert.equal(result.blocks_pruned, undefined);
  assert.equal(result.account_events_rows_pruned, undefined);
  assert.deepEqual(await blocks("chain_detail_account_events"), [
    oldAccount + 10,
    oldAccount + 11,
    oldAccount + 120,
    accountFloor,
  ]);
  assert.deepEqual(await blocks("chain_detail_blocks"), [detailFloor, head]);
});

test("a sparse account floor cannot retire events still embedded by a hot extrinsic hash", async () => {
  const detailFloor = head - 11_000;
  const sparseBlock = head - 10_000;
  const hash = `0x${"ab".repeat(32)}`;
  for (const block of [detailFloor, sparseBlock, head])
    await db
      .prepare(
        "INSERT INTO chain_detail_blocks(block_number,block_hash,extrinsic_count,chain_event_count,account_event_count,observed_at,synced_at) VALUES(?,'hash',1,0,2,1,1)",
      )
      .bind(block)
      .run();
  await db
    .prepare(
      "INSERT INTO chain_detail_extrinsics(block_number,extrinsic_index,extrinsic_hash,call_module,call_function,success,observed_at) VALUES(?,0,?,'Balances','transfer_keep_alive',1,1)",
    )
    .bind(sparseBlock, hash)
    .run();
  for (const event of [0, 1])
    await db
      .prepare(
        "INSERT INTO chain_detail_account_events(block_number,event_index,extrinsic_index,event_kind,amount_tao,observed_at) VALUES(?,?,0,'Transfer','0.5',1)",
      )
      .bind(sparseBlock, event)
      .run();
  const selected = selectedHistory({
    blocks: head,
    extrinsics: head,
    account_events: head,
    chain_events: head,
  });
  const owned = { ...env(), ...selected };
  const cold = vi.fn(async () => {
    throw new Error("hot hash must not need a cold read");
  });
  const before = await answerExtrinsicDetail(owned, hash, cold);
  assert.equal(before.kind, "answer");
  assert.equal(before.kind === "answer" && before.tier, "hot");
  assert.equal(before.kind === "answer" && before.data.events.length, 2);
  const result = await pruneChainDetail(owned, ctx);
  assert.equal(result.ok, true);
  assert.equal(result.blocks_pruned, 120);
  assert.deepEqual(await answerExtrinsicDetail(owned, hash, cold), before);
  assert.deepEqual(await blocks("chain_detail_account_events"), [
    sparseBlock,
    sparseBlock,
  ]);
  assert.equal(cold.mock.calls.length, 0);
});

test("a later detail rollback cannot leave a retained hot hash without its account events", async () => {
  const detailFloor = head - 11_000;
  const sparseBlock = detailFloor + 15;
  const hash = `0x${"cd".repeat(32)}`;
  for (const block of [detailFloor, detailFloor + 10, sparseBlock, head])
    await db
      .prepare(
        "INSERT INTO chain_detail_blocks(block_number,block_hash,extrinsic_count,chain_event_count,account_event_count,observed_at,synced_at) VALUES(?,'hash',1,0,2,1,1)",
      )
      .bind(block)
      .run();
  await db
    .prepare(
      "INSERT INTO chain_detail_extrinsics(block_number,extrinsic_index,extrinsic_hash,call_module,call_function,success,observed_at) VALUES(?,0,?,'Balances','transfer_keep_alive',1,1)",
    )
    .bind(sparseBlock, hash)
    .run();
  for (const event of [0, 1])
    await db
      .prepare(
        "INSERT INTO chain_detail_account_events(block_number,event_index,extrinsic_index,event_kind,amount_tao,observed_at) VALUES(?,?,0,'Transfer','0.5',1)",
      )
      .bind(sparseBlock, event)
      .run();
  const owned = {
    ...env(),
    ...selectedHistory({
      blocks: head,
      extrinsics: head,
      account_events: head,
      chain_events: head,
    }),
  };
  const cold = vi.fn(async () => {
    throw new Error("hot hash must not need a cold read");
  });
  const before = await answerExtrinsicDetail(owned, hash, cold);
  assert.equal(before.kind === "answer" && before.data.events.length, 2);
  await db
    .prepare(
      `CREATE TRIGGER reject_prune BEFORE DELETE ON chain_detail_blocks WHEN OLD.block_number >= ${detailFloor + 10} BEGIN SELECT RAISE(ABORT,'later detail chunk rejected'); END`,
    )
    .run();
  const result = await pruneChainDetail(owned, ctx);
  assert.equal(result.ok, false);
  assert.match(result.detail!, /later detail chunk rejected/);
  assert.deepEqual(await blocks("chain_detail_blocks"), [
    detailFloor + 10,
    sparseBlock,
    head,
  ]);
  assert.deepEqual(await answerExtrinsicDetail(owned, hash, cold), before);
  assert.equal(cold.mock.calls.length, 0);
});

async function accountOnlyFixture() {
  const detailFloor = head - 1800 + 1;
  const old = accountFloor - 500;
  for (const block of [detailFloor, head])
    await db
      .prepare(
        "INSERT INTO chain_detail_blocks(block_number,block_hash,extrinsic_count,chain_event_count,account_event_count,observed_at,synced_at) VALUES(?,'hash',0,0,0,1,1)",
      )
      .bind(block)
      .run();
  for (let offset = 0; offset <= 240; offset++)
    await db
      .prepare(
        "INSERT INTO chain_detail_account_events(block_number,event_index,event_kind,amount_tao,alpha_amount,observed_at) VALUES(?,0,'Transfer','0.0000000000000000001',NULL,1)",
      )
      .bind(old + offset)
      .run();
  const selected = selectedHistory({
    blocks: head,
    extrinsics: head,
    chain_events: head,
    account_events: head,
  });
  return { old, detailFloor, selected };
}

for (const family of ["blocks", "extrinsics", "chain_events", "account_events"])
  test.each(["missing", "partial", "malformed"])(
    `account-only retention refuses ${family} coverage that is %s`,
    async (state) => {
      const { selected } = await accountOnlyFixture();
      const original = selected.METAGRAPH_ARCHIVE.get.getMockImplementation()!;
      selected.METAGRAPH_ARCHIVE.get.mockImplementation(async (key) => {
        if (!key.includes(`/${family}/`)) return original(key);
        if (state === "missing") return null;
        const object = await original(key);
        return {
          ...object!,
          json: async () => ({
            ...(await object!.json()),
            ...(state === "malformed" ? { version: 999 } : { firstBlock: 1 }),
          }),
        };
      });
      const before = await Promise.all(tables.map(blocks));
      const batch = vi.fn(db.batch.bind(db));
      const result = await pruneChainDetail(
        {
          ...env(),
          ...selected,
          D1_STATE: { prepare: db.prepare.bind(db), batch },
        },
        ctx,
      );
      assert.equal(result.ok, false);
      assert.equal(result.reason, "prune_failed");
      assert.equal(batch.mock.calls.length, 0);
      assert.deepEqual(await Promise.all(tables.map(blocks)), before);
      assert.equal(pg.control.connects, 0);
    },
  );

test("account-only retention bounds twelve ten-height transactions and preserves exact survivors", async () => {
  const { old, selected } = await accountOnlyFixture();
  const before = await db
    .prepare(
      "SELECT * FROM chain_detail_account_events ORDER BY block_number,event_index",
    )
    .all();
  const prepare = vi.fn(db.prepare.bind(db));
  const batch = vi.fn(db.batch.bind(db));
  const result = await pruneChainDetail(
    {
      ...env(),
      ...selected,
      D1_STATE: { prepare, batch },
    },
    ctx,
  );
  assert.equal(result.ok, true);
  assert.equal(result.blocks_pruned, 0);
  assert.equal(result.account_events_rows_pruned, 120);
  assert.equal(batch.mock.calls.length, 12);
  for (const [statements] of batch.mock.calls)
    assert.equal(statements.length, 1);
  const deletes = prepare.mock.calls
    .map(([sql]) => sql)
    .filter((sql) => sql.startsWith("DELETE"));
  assert.equal(deletes.length, 12);
  assert.ok(
    deletes.every(
      (sql) =>
        sql ===
        "DELETE FROM chain_detail_account_events WHERE block_number >= ? AND block_number < ? AND block_number < (SELECT MIN(block_number) FROM chain_detail_blocks)",
    ),
  );
  assert.deepEqual(
    (
      await db
        .prepare(
          "SELECT * FROM chain_detail_account_events ORDER BY block_number,event_index",
        )
        .all()
    ).results,
    before.results.filter((row) => Number(row.block_number) >= old + 120),
  );
  assert.equal(selected.METAGRAPH_ARCHIVE.get.mock.calls.length, 4);
  assert.equal(pg.control.connects, 0);
});

test("a lost account-delete acknowledgement stops writes and a later cron rechecks expired coverage and its floor", async () => {
  const { old, selected } = await accountOnlyFixture();
  let calls = 0;
  const batch = async (statements: D1PreparedStatement[]) => {
    calls++;
    const result = await db.batch(statements);
    if (calls === 2) throw new Error("accepted delete acknowledgement lost");
    return result;
  };
  const owned = {
    ...env(),
    ...selected,
    D1_STATE: { prepare: db.prepare.bind(db), batch },
  };
  const failed = await pruneChainDetail(owned, ctx);
  assert.equal(failed.ok, false);
  assert.match(failed.detail!, /acknowledgement lost/);
  assert.equal(failed.account_events_rows_pruned, undefined);
  assert.equal(calls, 2);
  assert.deepEqual(
    await blocks("chain_detail_account_events"),
    Array.from({ length: 221 }, (_, i) => old + 20 + i),
  );
  const original = selected.METAGRAPH_ARCHIVE.get.getMockImplementation()!;
  const now = Date.now();
  // Validated selections have an existing sixty-second cache. The normal
  // quarter-hour cron expires it; do not claim an immediate call rereads it.
  const clock = vi.spyOn(Date, "now").mockReturnValue(now + 60_001);
  try {
    selected.METAGRAPH_ARCHIVE.get.mockResolvedValue(null);
    const refused = await pruneChainDetail(owned, ctx);
    assert.equal(refused.ok, false);
    assert.equal(calls, 2);
    selected.METAGRAPH_ARCHIVE.get.mockImplementation(original);
    clock.mockReturnValue(now + 120_002);
    const resumed = await pruneChainDetail(owned, ctx);
    assert.equal(resumed.ok, true);
    assert.equal(resumed.account_events_rows_pruned, 120);
    assert.equal(calls, 14);
    assert.deepEqual(
      await blocks("chain_detail_account_events"),
      Array.from({ length: 101 }, (_, i) => old + 140 + i),
    );
  } finally {
    clock.mockRestore();
  }
  assert.equal(pg.control.connects, 0);
});
