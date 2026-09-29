import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { beforeAll, afterAll, beforeEach, test, vi } from "vitest";
import { Miniflare } from "miniflare";
const { pg } = await vi.hoisted(async () => ({
  pg: (await import("./helpers/pg-mock.ts")).createPgMock(),
}));
vi.mock("pg", () => pg.module);
import { pruneChainDetail } from "../src/chain-detail-prune.ts";
import { chainDetailTables } from "../src/chain-detail-neon-write.ts";
import { runNeonPrune, NEON_PRUNE_PLANS } from "../src/neon-prune.ts";
import { DEFAULT_BLOCKS_SEAM } from "../src/blocks-cold-tier.ts";
import { resetDecodeWatermarkCache } from "../src/decode-watermark.ts";

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
    assert.deepEqual(await Promise.all(tables.map(blocks)), before);
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
