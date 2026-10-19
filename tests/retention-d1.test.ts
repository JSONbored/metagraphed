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
async function seed(coverageFloor = floor, extraBlocks: number[] = []) {
  for (const block of [
    coverageFloor,
    coverageFloor + 119,
    coverageFloor + 120,
    head,
    ...extraBlocks,
  ]) {
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

async function replaceCoverage(heights: number[]) {
  for (const table of tables)
    if (table !== "chain_detail_account_events")
      await db.prepare(`DELETE FROM ${table}`).run();
  for (const block of heights)
    await db.batch([
      db
        .prepare(
          "INSERT INTO chain_detail_blocks(block_number,block_hash,extrinsic_count,chain_event_count,account_event_count,observed_at,synced_at) VALUES(?,'hash',1,1,0,1,1)",
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
    ]);
}

async function accountRange(first: number) {
  await db.batch(
    Array.from({ length: 121 }, (_, offset) =>
      db
        .prepare(
          "INSERT INTO chain_detail_account_events(block_number,event_index,event_kind,observed_at) VALUES(?,0,'Transfer',1)",
        )
        .bind(first + offset),
    ),
  );
}

function measuredPrune(afterBatch?: (completed: number) => Promise<void>) {
  const prepared: string[] = [];
  const changes: number[][] = [];
  return {
    prepared,
    changes,
    binding: {
      prepare(text: string) {
        prepared.push(text);
        return db.prepare(text);
      },
      async batch(statements: D1PreparedStatement[]) {
        const result = await db.batch(statements);
        changes.push(result.map((row) => row.meta.changes));
        await afterBatch?.(changes.length);
        return result;
      },
    },
  };
}

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

test("caught-up coverage still advances an account backlog in twelve bounded transactions", async () => {
  await seed();
  const keepFrom = head - 1800 + 1;
  await replaceCoverage([keepFrom, head]);
  const before = await Promise.all(tables.map(blocks));
  const old = accountFloor - 10_000;
  await accountRange(old);
  const trace = measuredPrune();
  const result = await pruneChainDetail(
    { ...env(), D1_STATE: trace.binding },
    ctx,
  );
  assert.equal(result.ok, true);
  assert.equal(result.d1_pruned, true);
  assert.equal(result.blocks_pruned, 0);
  assert.equal(result.account_events_range_blocks, 120);
  assert.equal(result.account_events_range_end, old + 120);
  assert.deepEqual(
    trace.changes,
    Array.from({ length: 12 }, () => [10]),
  );
  const deletes = trace.prepared.filter((text) => text.startsWith("DELETE"));
  assert.equal(deletes.length, 12);
  for (const text of deletes)
    assert.match(text, /^DELETE FROM chain_detail_account_events /);
  for (const [index, table] of tables.entries())
    if (table !== "chain_detail_account_events")
      assert.deepEqual(await blocks(table), before[index]);
  const accounts = await blocks("chain_detail_account_events");
  assert.equal(accounts[0], old + 120);
  assert.ok(accounts.includes(accountFloor - 1));
  assert.ok(accounts.includes(accountFloor));
  assert.equal(pg.control.connects, 0);
});

test("a small coverage backlog cannot throttle independent account catch-up", async () => {
  await seed();
  const keepFrom = head - 1800 + 1;
  await replaceCoverage([keepFrom - 3, keepFrom - 2, keepFrom - 1, head]);
  const old = accountFloor - 10_000;
  await accountRange(old);
  const trace = measuredPrune();
  const result = await pruneChainDetail(
    { ...env(), D1_STATE: trace.binding },
    ctx,
  );
  assert.equal(result.ok, true);
  assert.equal(result.blocks_pruned, 3);
  assert.equal(result.account_events_range_blocks, 120);
  assert.deepEqual(trace.changes, [
    [3, 3, 10, 3],
    ...Array.from({ length: 11 }, () => [10]),
  ]);
  for (const table of tables)
    if (table !== "chain_detail_account_events")
      assert.deepEqual(await blocks(table), [head]);
  assert.equal((await blocks("chain_detail_account_events"))[0], old + 120);
  const deletes = trace.prepared.filter((text) => text.startsWith("DELETE"));
  assert.deepEqual(
    deletes.slice(0, 4).map((text) => text.split(" ")[2]),
    [
      "chain_detail_extrinsics",
      "chain_detail_chain_events",
      "chain_detail_account_events",
      "chain_detail_blocks",
    ],
  );
  for (const text of deletes.slice(4))
    assert.match(text, /^DELETE FROM chain_detail_account_events /);
});

test("caught-up account events receive no deletes while coverage advances", async () => {
  await seed();
  await db
    .prepare("DELETE FROM chain_detail_account_events WHERE block_number < ?")
    .bind(accountFloor)
    .run();
  const before = await blocks("chain_detail_account_events");
  const trace = measuredPrune();
  const result = await pruneChainDetail(
    { ...env(), D1_STATE: trace.binding },
    ctx,
  );
  assert.equal(result.ok, true);
  assert.equal(result.blocks_pruned, 120);
  assert.equal(result.account_events_range_blocks, 0);
  assert.deepEqual(await blocks("chain_detail_account_events"), before);
  assert.equal(trace.changes.length, 12);
  assert.ok(trace.changes.every((batch) => batch.length === 3));
  assert.equal(
    trace.prepared.some((text) =>
      text.startsWith("DELETE FROM chain_detail_account_events"),
    ),
    false,
  );
});

test("caught-up native coverage and account events perform no delete batches", async () => {
  await seed();
  const keepFrom = head - 1800 + 1;
  await replaceCoverage([keepFrom, head]);
  await db
    .prepare("DELETE FROM chain_detail_account_events WHERE block_number < ?")
    .bind(accountFloor)
    .run();
  const before = await Promise.all(tables.map(blocks));
  const trace = measuredPrune();
  const result = await pruneChainDetail(
    { ...env(), D1_STATE: trace.binding },
    ctx,
  );
  assert.equal(result.ok, true);
  assert.equal(result.keep_from, keepFrom);
  assert.equal(result.blocks_pruned, 0);
  assert.equal(result.d1_pruned, undefined);
  assert.deepEqual(trace.changes, []);
  assert.equal(
    trace.prepared.some((text) => text.startsWith("DELETE")),
    false,
  );
  assert.deepEqual(await Promise.all(tables.map(blocks)), before);
  assert.equal(pg.control.connects, 0);
});

test("account events ahead of retiring coverage retain all advertised children", async () => {
  await seed();
  const coverageFloor = head - 10_000;
  const first = head - 9500;
  await replaceCoverage([
    coverageFloor,
    coverageFloor + 119,
    coverageFloor + 120,
    first,
    first + 120,
    head,
  ]);
  await db.prepare("DELETE FROM chain_detail_account_events").run();
  await accountRange(first);
  await db
    .prepare(
      "UPDATE chain_detail_blocks SET account_event_count=1 WHERE block_number IN (?,?)",
    )
    .bind(first, first + 120)
    .run();
  const before = await blocks("chain_detail_account_events");
  const trace = measuredPrune();
  const result = await pruneChainDetail(
    { ...env(), D1_STATE: trace.binding },
    ctx,
  );
  assert.equal(result.ok, true);
  assert.equal(result.blocks_pruned, 120);
  assert.equal(result.account_events_range_blocks, 120);
  assert.deepEqual(await blocks("chain_detail_account_events"), before);
  assert.equal(trace.changes.length, 12);
  assert.ok(trace.changes.every((batch) => batch[2] === 0));
  for (const table of tables)
    if (table !== "chain_detail_account_events")
      assert.deepEqual(await blocks(table), [
        coverageFloor + 120,
        first,
        first + 120,
        head,
      ]);
});

test("overlapping account children retire with their coverage in the same batch", async () => {
  await seed();
  const first = head - 10_000;
  const heights = Array.from({ length: 121 }, (_, offset) => first + offset);
  await replaceCoverage([...heights, head]);
  await db.prepare("DELETE FROM chain_detail_account_events").run();
  await accountRange(first);
  await db
    .prepare(
      "UPDATE chain_detail_blocks SET account_event_count=1 WHERE block_number < ?",
    )
    .bind(head)
    .run();
  const trace = measuredPrune();
  const result = await pruneChainDetail(
    { ...env(), D1_STATE: trace.binding },
    ctx,
  );
  assert.equal(result.ok, true);
  assert.equal(result.blocks_pruned, 120);
  assert.equal(result.account_events_range_blocks, 120);
  assert.deepEqual(
    trace.changes,
    Array.from({ length: 12 }, () => [10, 10, 10, 10]),
  );
  for (const table of tables)
    assert.deepEqual(
      await blocks(table),
      table === "chain_detail_account_events"
        ? [first + 120]
        : [first + 120, head],
    );
});

test("a replay between account-only batches preserves newly advertised detail", async () => {
  await seed();
  const keepFrom = head - 1800 + 1;
  await replaceCoverage([keepFrom, head]);
  const old = accountFloor - 10_000;
  await accountRange(old);
  const replayed = old + 10;
  const trace = measuredPrune(async (completed) => {
    if (completed !== 1) return;
    await db.batch([
      db
        .prepare(
          "INSERT INTO chain_detail_extrinsics(block_number,extrinsic_index,observed_at) VALUES(?,0,2)",
        )
        .bind(replayed),
      db
        .prepare(
          "INSERT INTO chain_detail_chain_events(block_number,event_index,pallet,method,phase,observed_at) VALUES(?,0,'System','Success','ApplyExtrinsic',2)",
        )
        .bind(replayed),
      db
        .prepare(
          "UPDATE chain_detail_account_events SET observed_at=2 WHERE block_number=?",
        )
        .bind(replayed),
      db
        .prepare(
          "INSERT INTO chain_detail_blocks(block_number,block_hash,extrinsic_count,chain_event_count,account_event_count,observed_at,synced_at) VALUES(?,'replayed',1,1,1,2,2)",
        )
        .bind(replayed),
    ]);
  });
  const result = await pruneChainDetail(
    { ...env(), D1_STATE: trace.binding },
    ctx,
  );
  assert.equal(result.ok, true);
  assert.equal(result.blocks_pruned, 0);
  assert.equal(result.account_events_range_blocks, 120);
  assert.deepEqual(trace.changes, [
    [10],
    ...Array.from({ length: 11 }, () => [0]),
  ]);
  for (const table of tables)
    assert.ok((await blocks(table)).includes(replayed));
  const accounts = await blocks("chain_detail_account_events");
  assert.equal(accounts[0], replayed);
  assert.ok(accounts.includes(old + 119));
  assert.equal(
    await db
      .prepare(
        "SELECT observed_at FROM chain_detail_account_events WHERE block_number=?",
      )
      .bind(replayed)
      .first("observed_at"),
    2,
  );
});
test.each([0, 17])(
  "an account backlog keeps draining at a fixed head with coverage %i heights inside its window",
  async (inside) => {
    const coverageFloor = head - 1800 + 1 + inside;
    await seed(coverageFloor);
    const old = accountFloor - 300;
    for (const block of [old, old + 119, old + 120, old + 239, old + 240])
      await db
        .prepare(
          "INSERT INTO chain_detail_account_events(block_number,event_index,event_kind,observed_at) VALUES(?,0,'Transfer',1)",
        )
        .bind(block)
        .run();
    const before = await Promise.all(tables.map(blocks));
    for (const removed of [120, 240]) {
      const result = await pruneChainDetail(env(), ctx);
      assert.equal(result.ok, true);
      assert.equal(result.d1_pruned, true);
      assert.equal(result.blocks_pruned, 0);
      assert.equal(result.deleted_below, coverageFloor);
      for (const [index, table] of tables.entries())
        assert.deepEqual(
          await blocks(table),
          table === "chain_detail_account_events"
            ? before[index]!.filter((block) => block >= old + removed)
            : before[index],
        );
    }
    assert.equal(pg.control.connects, 0);
  },
);

test.each([1, 75, 120])(
  "a %i-height coverage backlog does not reduce the account-event budget",
  async (span) => {
    const keepFrom = head - 1800 + 1;
    const coverageFloor = keepFrom - span;
    await seed(coverageFloor);
    const old = accountFloor - 1000;
    for (const block of [old, old + 119, old + 120])
      await db
        .prepare(
          "INSERT INTO chain_detail_account_events(block_number,event_index,event_kind,observed_at) VALUES(?,0,'Transfer',1)",
        )
        .bind(block)
        .run();
    const before = await Promise.all(tables.map(blocks));
    const batch = vi.fn((statements: D1PreparedStatement[]) =>
      db.batch(statements),
    );
    const result = await pruneChainDetail(
      {
        ...env(),
        D1_STATE: { prepare: db.prepare.bind(db), batch },
      },
      ctx,
    );
    assert.equal(result.ok, true);
    assert.equal(result.blocks_pruned, span);
    assert.equal(result.deleted_below, keepFrom);
    assert.equal(batch.mock.calls.length, 12);
    assert.deepEqual(
      batch.mock.calls.map(([statements]) => statements.length),
      Array.from({ length: 12 }, (_, chunk) => (chunk * 10 < span ? 4 : 1)),
    );
    for (const [index, table] of tables.entries())
      assert.deepEqual(
        await blocks(table),
        before[index]!.filter((block) =>
          table === "chain_detail_account_events"
            ? block >= old + 120
            : block >= keepFrom,
        ),
      );
    assert.equal(pg.control.connects, 0);
  },
);

test.each(["empty", "at cutoff", "above cutoff"])(
  "caught-up coverage does not write when account events are %s",
  async (state) => {
    await seed(head - 1800 + 1);
    if (state === "empty")
      await db.prepare("DELETE FROM chain_detail_account_events").run();
    else
      await db
        .prepare(
          "DELETE FROM chain_detail_account_events WHERE block_number < ?",
        )
        .bind(accountFloor + (state === "above cutoff" ? 1 : 0))
        .run();
    const before = await Promise.all(tables.map(blocks));
    const batch = vi.fn((statements: D1PreparedStatement[]) =>
      db.batch(statements),
    );
    const result = await pruneChainDetail(
      {
        ...env(),
        D1_STATE: { prepare: db.prepare.bind(db), batch },
      },
      ctx,
    );
    assert.equal(result.ok, true);
    assert.equal(result.blocks_pruned, 0);
    assert.equal(batch.mock.calls.length, 0);
    assert.deepEqual(await Promise.all(tables.map(blocks)), before);
    assert.equal(pg.control.connects, 0);
  },
);

test.each([0, 75])(
  "a later account delete failure preserves its whole chunk with %i coverage heights pending",
  async (span) => {
    const coverageFloor = head - 1800 + 1 - span;
    await seed(coverageFloor, [coverageFloor + 10]);
    const old = accountFloor - 1000;
    for (const block of [old, old + 9, old + 10, old + 19, old + 20])
      await db
        .prepare(
          "INSERT INTO chain_detail_account_events(block_number,event_index,event_kind,observed_at) VALUES(?,0,'Transfer',1)",
        )
        .bind(block)
        .run();
    const before = await Promise.all(tables.map(blocks));
    await db
      .prepare(
        `CREATE TRIGGER reject_prune BEFORE DELETE ON chain_detail_account_events
         WHEN OLD.block_number >= ${old + 10}
         BEGIN SELECT RAISE(ABORT,'later account chunk rejected'); END`,
      )
      .run();
    const result = await pruneChainDetail(env(), ctx);
    assert.equal(result.ok, false);
    assert.equal(result.reason, "prune_failed");
    assert.equal(result.blocks_pruned, undefined);
    assert.match(result.detail!, /later account chunk rejected/);
    for (const [index, table] of tables.entries())
      assert.deepEqual(
        await blocks(table),
        before[index]!.filter((block) =>
          table === "chain_detail_account_events"
            ? block >= old + 10
            : span === 0 || block >= coverageFloor + 10,
        ),
      );
    assert.equal(pg.control.connects, 0);
  },
);

test("account-only rows cannot supply a missing coverage head", async () => {
  await seed();
  await db.prepare("DELETE FROM chain_detail_blocks").run();
  const before = await Promise.all(tables.map(blocks));
  const result = await pruneChainDetail(env(), ctx);
  assert.deepEqual(result, { ok: true, reason: "no rows", blocks_pruned: 0 });
  assert.deepEqual(await Promise.all(tables.map(blocks)), before);
  assert.equal(pg.control.connects, 0);
});

test("account events ahead of retiring coverage retain all advertised children", async () => {
  await seed();
  const coverageFloor = head - 10_000;
  const first = head - 9500;
  await replaceCoverage([
    coverageFloor,
    coverageFloor + 119,
    coverageFloor + 120,
    first,
    first + 120,
    head,
  ]);
  await db.prepare("DELETE FROM chain_detail_account_events").run();
  await accountRange(first);
  await db
    .prepare(
      "UPDATE chain_detail_blocks SET account_event_count=1 WHERE block_number IN (?,?)",
    )
    .bind(first, first + 120)
    .run();
  const before = await blocks("chain_detail_account_events");
  const trace = measuredPrune();
  const result = await pruneChainDetail(
    { ...env(), D1_STATE: trace.binding },
    ctx,
  );
  assert.equal(result.ok, true);
  assert.equal(result.blocks_pruned, 120);
  assert.deepEqual(await blocks("chain_detail_account_events"), before);
  assert.equal(trace.changes.length, 12);
  assert.ok(trace.changes.every((batch) => batch[2] === 0));
  for (const table of tables)
    if (table !== "chain_detail_account_events")
      assert.deepEqual(await blocks(table), [
        coverageFloor + 120,
        first,
        first + 120,
        head,
      ]);
});

test("overlapping account children retire with their coverage in the same batch", async () => {
  await seed();
  const first = head - 10_000;
  const heights = Array.from({ length: 121 }, (_, offset) => first + offset);
  await replaceCoverage([...heights, head]);
  await db.prepare("DELETE FROM chain_detail_account_events").run();
  await accountRange(first);
  await db
    .prepare(
      "UPDATE chain_detail_blocks SET account_event_count=1 WHERE block_number < ?",
    )
    .bind(head)
    .run();
  const trace = measuredPrune();
  const result = await pruneChainDetail(
    { ...env(), D1_STATE: trace.binding },
    ctx,
  );
  assert.equal(result.ok, true);
  assert.equal(result.blocks_pruned, 120);
  assert.deepEqual(
    trace.changes,
    Array.from({ length: 12 }, () => [10, 10, 10, 10]),
  );
  for (const table of tables)
    assert.deepEqual(
      await blocks(table),
      table === "chain_detail_account_events"
        ? [first + 120]
        : [first + 120, head],
    );
});

test("a replay between account-only batches preserves newly advertised detail", async () => {
  await seed();
  const keepFrom = head - 1800 + 1;
  await replaceCoverage([keepFrom, head]);
  const old = accountFloor - 10_000;
  await accountRange(old);
  const replayed = old + 10;
  const trace = measuredPrune(async (completed) => {
    if (completed !== 1) return;
    await db.batch([
      db
        .prepare(
          "INSERT INTO chain_detail_extrinsics(block_number,extrinsic_index,observed_at) VALUES(?,0,2)",
        )
        .bind(replayed),
      db
        .prepare(
          "INSERT INTO chain_detail_chain_events(block_number,event_index,pallet,method,phase,observed_at) VALUES(?,0,'System','Success','ApplyExtrinsic',2)",
        )
        .bind(replayed),
      db
        .prepare(
          "UPDATE chain_detail_account_events SET observed_at=2 WHERE block_number=?",
        )
        .bind(replayed),
      db
        .prepare(
          "INSERT INTO chain_detail_blocks(block_number,block_hash,extrinsic_count,chain_event_count,account_event_count,observed_at,synced_at) VALUES(?,'replayed',1,1,1,2,2)",
        )
        .bind(replayed),
    ]);
  });
  const result = await pruneChainDetail(
    { ...env(), D1_STATE: trace.binding },
    ctx,
  );
  assert.equal(result.ok, true);
  assert.equal(result.blocks_pruned, 0);
  assert.deepEqual(trace.changes, [
    [10],
    ...Array.from({ length: 11 }, () => [0]),
  ]);
  for (const table of tables)
    assert.ok((await blocks(table)).includes(replayed));
  const accounts = await blocks("chain_detail_account_events");
  assert.equal(accounts[0], replayed);
  assert.ok(accounts.includes(old + 119));
  assert.equal(
    await db
      .prepare(
        "SELECT observed_at FROM chain_detail_account_events WHERE block_number=?",
      )
      .bind(replayed)
      .first("observed_at"),
    2,
  );
});

test("account batches keep their bounded progress if coverage disappears after the first batch", async () => {
  await seed();
  const keepFrom = head - 1800 + 1;
  await replaceCoverage([keepFrom, head]);
  await db.prepare("DELETE FROM chain_detail_account_events").run();
  const old = accountFloor - 10_000;
  await accountRange(old);
  const trace = measuredPrune(async (completed) => {
    if (completed === 1)
      await db.prepare("DELETE FROM chain_detail_blocks").run();
  });
  const result = await pruneChainDetail(
    { ...env(), D1_STATE: trace.binding },
    ctx,
  );
  assert.equal(result.ok, true);
  assert.equal(result.blocks_pruned, 0);
  assert.deepEqual(
    trace.changes,
    Array.from({ length: 12 }, () => [10]),
  );
  assert.deepEqual(await blocks("chain_detail_account_events"), [old + 120]);
  assert.deepEqual(await blocks("chain_detail_blocks"), []);
});

test("a guarded account retirement rolls back with its coverage", async () => {
  await seed();
  const first = head - 10_000;
  const heights = Array.from({ length: 121 }, (_, offset) => first + offset);
  await replaceCoverage([...heights, head]);
  await db.prepare("DELETE FROM chain_detail_account_events").run();
  await accountRange(first);
  const before = await Promise.all(tables.map(blocks));
  await db
    .prepare(
      "CREATE TRIGGER reject_prune BEFORE DELETE ON chain_detail_blocks BEGIN SELECT RAISE(ABORT,'guarded coverage rejected'); END",
    )
    .run();
  const result = await pruneChainDetail(env(), ctx);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "prune_failed");
  assert.match(result.detail!, /guarded coverage rejected/);
  assert.deepEqual(await Promise.all(tables.map(blocks)), before);
});

test.each([0, 120])(
  "the account delete uses indexed range and coverage minimum searches with %i coverage heights pending",
  async (span) => {
    const coverageFloor = head - 1800 + 1 - span;
    await seed(coverageFloor);
    const old = accountFloor - 10_000;
    await accountRange(old);
    const trace = measuredPrune();
    const result = await pruneChainDetail(
      { ...env(), D1_STATE: trace.binding },
      ctx,
    );
    assert.equal(result.ok, true);
    const accountDelete = trace.prepared.find((text) =>
      text.startsWith("DELETE FROM chain_detail_account_events"),
    );
    assert.ok(accountDelete);
    // Explain the actual emitted statement, in both batch shapes, with the
    // first batch's bounds. This is a plan assertion, not a row-count limit.
    const values = [old, old + 10, old + 10];
    if (span) values.push(coverageFloor, coverageFloor + 10);
    const plan = await db
      .prepare(`EXPLAIN QUERY PLAN ${accountDelete}`)
      .bind(...values)
      .all<{ detail: string }>();
    const detail = plan.results.map((row) => row.detail).join("\n");
    assert.match(
      detail,
      /SEARCH chain_detail_account_events USING PRIMARY KEY \(block_number>\? AND block_number<\?\)/,
    );
    assert.match(detail, /SEARCH chain_detail_blocks\b/);
    assert.doesNotMatch(detail, /\bSCAN\b/);
  },
);

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
  const trace = measuredPrune();
  const result = await pruneChainDetail(
    { ...env(), D1_STATE: trace.binding },
    ctx,
  );
  assert.equal(result.ok, true);
  assert.equal(result.blocks_pruned, 120);
  assert.equal(result.account_events_range_blocks, 0);
  assert.equal(trace.changes.length, 12);
  assert.ok(trace.changes.every((batch) => batch.length === 3));
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
    assert.equal(result.account_events_range_blocks, 1);
    assert.deepEqual(
      await Promise.all(tables.map(blocks)),
      before.map((rows, index) =>
        tables[index] === "chain_detail_account_events"
          ? rows.filter((block) => block >= accountFloor)
          : rows,
      ),
    );
    for (const [index, table] of tables.entries())
      assert.deepEqual(
        await blocks(table),
        table === "chain_detail_account_events"
          ? before[index]!.filter((block) => block >= accountFloor)
          : before[index],
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

test("account-only cleanup stops at the slowest published history boundary", async () => {
  await seed();
  const seam = accountFloor - 20;
  await db.prepare("DELETE FROM chain_detail_account_events").run();
  for (const block of [seam - 2, seam - 1, seam, seam + 1, seam + 2])
    await db
      .prepare(
        "INSERT INTO chain_detail_account_events(block_number,event_index,event_kind,observed_at) VALUES(?,0,'Transfer',1)",
      )
      .bind(block)
      .run();
  const selected = selectedHistory({
    blocks: head,
    extrinsics: head,
    chain_events: seam,
    account_events: head,
  });
  const before = await blocks("chain_detail_blocks");
  const trace = measuredPrune();
  const result = await pruneChainDetail(
    { ...env(), ...selected, D1_STATE: trace.binding },
    ctx,
  );
  assert.equal(result.ok, true);
  assert.equal(result.keep_from, seam + 1);
  assert.equal(result.blocks_pruned, 0);
  assert.equal(result.account_events_range_end, seam + 1);
  assert.equal(result.account_events_range_blocks, 3);
  assert.deepEqual(trace.changes, [[3]]);
  assert.deepEqual(await blocks("chain_detail_account_events"), [
    seam + 1,
    seam + 2,
  ]);
  assert.deepEqual(await blocks("chain_detail_blocks"), before);
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
