import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { beforeAll, beforeEach, afterAll, test } from "vitest";
import { Miniflare } from "miniflare";
import { createD1Store } from "../src/d1-store.ts";
import { writeLedgerD1, writeNominatorPositionsD1 } from "../src/ledger-d1.ts";
import {
  LEDGER_MIRROR_PLANS,
  mirrorLedgerToNeon,
} from "../src/ledger-neon-write.ts";
import {
  coldkeyMaxCapturedAt,
  mirrorNominatorPositionsToNeon,
  type NominatorPositionsInput,
} from "../src/nominator-positions-neon-write.ts";
import { dataApiEnv } from "./helpers/worker-env.ts";
import { PASS_TABLES } from "../src/pass-completeness.ts";
import worker, {
  neonOwnsLedger,
  neonOwnsNominatorPositions,
} from "../workers/data-api.ts";

const runtime = new Miniflare({
  modules: true,
  script: "export default {fetch(){return new Response('test')}}",
  compatibilityDate: "2026-06-06",
  d1Databases: ["DB"],
});
let db: D1Database;
const stamp = 1790090000000;
const tables = [
  ...Object.values(LEDGER_MIRROR_PLANS).map((p) => p.table),
  ...Object.entries(PASS_TABLES)
    .filter(([lane]) => lane !== "neurons")
    .map(([, table]) => table),
  "nominator_positions",
  "nominator_scan_receipts",
];
const env = () =>
  dataApiEnv({
    D1_STATE: db,
    D1_STATE_TABLES: tables.join(","),
    HYPERDRIVE: undefined,
  });
const store = () => createD1Store(db);
const verdicts: unknown[][] = [];
const laneHealthDb = {
  async query() {
    return [];
  },
  async run(_text: string, values?: unknown[]) {
    verdicts.push(values ?? []);
    return { changes: 1 };
  },
};
const pass = (receivedRows = 1, expectedRows = 1) => ({
  capturedAt: stamp,
  receivedRows,
  expectedRows,
  nowMs: stamp + 1,
});
const row = (coldkey = "c", hotkey = "h", netuid = 1, captured_at = stamp) => ({
  coldkey,
  hotkey,
  netuid,
  captured_at,
  shares: "340282366920938463463374607431768211455",
  share_fraction: 0.5,
});
const positions = (
  rows: Record<string, unknown>[],
  rest: Partial<NominatorPositionsInput> = {},
) =>
  mirrorNominatorPositionsToNeon(
    env(),
    null,
    { rows, coldkeyMaxCapturedAt: coldkeyMaxCapturedAt(rows), ...rest },
    { laneHealthDb, now: () => stamp },
  );
const count = (table: string) =>
  db.prepare(`SELECT COUNT(*) n FROM ${table}`).first<number>("n");
beforeAll(async () => {
  db = await runtime.getD1Database("DB");
  for (const statement of readFileSync(
    new URL("../migrations/d1/0010_ledger_state.sql", import.meta.url),
    "utf8",
  ).split("-- statement-breakpoint"))
    if (statement.trim()) await db.prepare(statement).run();
});
afterAll(async () => runtime.dispose());
beforeEach(async () => {
  for (const table of tables) await db.prepare(`DELETE FROM ${table}`).run();
  verdicts.length = 0;
});

test("ledger captures and completeness share one atomic write, preserving newer readings", async () => {
  const rows = Array.from({ length: 201 }, (_, i) => ({
    ss58: `account-${i}`,
    free_tao: i + 0.1,
    reserved_tao: 0,
    captured_at: stamp,
  }));
  const result = await mirrorLedgerToNeon(
    env(),
    null,
    "account-balances",
    rows,
    { laneHealthDb },
    pass(201, 202),
  );
  assert.equal(result.result?.ok, true);
  assert.equal(await count("account_balances"), 201);
  assert.equal(
    await db
      .prepare("SELECT completed_at FROM account_balances_passes")
      .first("completed_at"),
    null,
  );
  await mirrorLedgerToNeon(
    env(),
    null,
    "account-balances",
    [{ ...rows[0], free_tao: 999, captured_at: stamp - 1 }],
    { laneHealthDb, now: () => stamp },
    pass(1, 202),
  );
  assert.equal(
    await db
      .prepare("SELECT free_tao FROM account_balances WHERE ss58='account-0'")
      .first("free_tao"),
    0.1,
  );
  assert.equal(
    await db
      .prepare("SELECT completed_at FROM account_balances_passes")
      .first("completed_at"),
    stamp + 1,
  );
  assert.ok(verdicts.length > 0);
  assert.deepEqual(await writeLedgerD1(store(), "account-balances", []), {
    ok: true,
    rows: 0,
    statements: 0,
  });
  assert.equal(
    (
      await mirrorLedgerToNeon(
        env(),
        null,
        "validator-nominator-counts",
        [{ hotkey: "v", nominator_count: 5, captured_at: stamp }],
        { laneHealthDb },
      )
    ).result?.ok,
    true,
  );
});
test("hotkey pools persist only when a nominator position references the pool", async () => {
  await positions([row()]);
  const result = await mirrorLedgerToNeon(
    env(),
    null,
    "hotkey-alpha",
    [1, 2].map((netuid) => ({
      hotkey: "h",
      netuid,
      total_alpha: 90,
      captured_at: stamp,
    })),
    { laneHealthDb },
    pass(2, 2),
  );
  assert.equal(result.result?.ok, true);
  assert.equal(await count("hotkey_alpha"), 1);
  assert.equal(
    await db.prepare("SELECT netuid FROM hotkey_alpha").first("netuid"),
    1,
  );
});
test("failed final tally rolls back every ledger chunk and reports failure", async () => {
  await db
    .prepare(
      "CREATE TRIGGER reject_pass BEFORE INSERT ON account_balances_passes BEGIN SELECT RAISE(ABORT,'injected'); END",
    )
    .run();
  try {
    const result = await mirrorLedgerToNeon(
      env(),
      null,
      "account-balances",
      Array.from({ length: 201 }, (_, i) => ({
        ss58: String(i),
        free_tao: 1,
        reserved_tao: 0,
        captured_at: stamp,
      })),
      { laneHealthDb },
      pass(),
    );
    assert.equal(result.result?.ok, false);
    assert.equal(await count("account_balances"), 0);
  } finally {
    await db.prepare("DROP TRIGGER reject_pass").run();
  }
  const bad = await writeLedgerD1(store(), "account-balances", [
    { ss58: "bad", free_tao: null, reserved_tao: 0, captured_at: stamp },
  ]);
  assert.equal(bad.ok, false);
  const over = await writeLedgerD1(
    store(),
    "account-balances",
    Array.from({ length: 90001 }, (_, i) => ({
      ss58: String(i),
      free_tao: 0,
      reserved_tao: 0,
      captured_at: stamp,
    })),
  );
  assert.equal(over.ok, false);
  assert.match(over.reason!, /statement budget/);
});
test("positions retain exact shares and prune only older rows from the same producer", async () => {
  await positions([row("c", "old", 1, stamp - 5)]);
  await positions([row("c", "self", 1, stamp - 5)], {
    source: "self-stake",
    lane: "self-stake",
  });
  await positions([row("other", "untouched", 1, stamp - 5)]);
  const current = row();
  const result = await positions([current]);
  assert.equal(result.write?.ok, true);
  assert.equal(result.prune?.ok, true);
  const actual = await db
    .prepare("SELECT * FROM nominator_positions ORDER BY coldkey,hotkey")
    .all();
  assert.deepEqual(
    actual.results.map((r) => r.hotkey),
    ["h", "self", "untouched"],
  );
  assert.equal(actual.results[0].shares, current.shares);
  await positions([{ ...current, captured_at: stamp - 1, shares: "1" }]);
  assert.equal(
    await db
      .prepare("SELECT shares FROM nominator_positions WHERE hotkey='h'")
      .first("shares"),
    current.shares,
  );
  await positions([{ ...current, source: "malicious" }]);
  assert.equal(
    await db
      .prepare("SELECT source FROM nominator_positions WHERE hotkey='h'")
      .first("source"),
    "alpha",
  );
});
test("full-scan receipts survive self-stake replacement, retain duplicate payload counts and expire only old evidence", async () => {
  await db
    .prepare("INSERT INTO nominator_scan_receipts VALUES (?,?,1)")
    .bind(stamp - 31 * 86400000, "expired")
    .run();
  const rows = [row(), row(), row("c", "second")];
  await positions(rows);
  await positions(rows);
  assert.equal(await count("nominator_scan_receipts"), 1);
  assert.equal(
    await db
      .prepare("SELECT row_count FROM nominator_scan_receipts")
      .first("row_count"),
    3,
  );
  await positions([row("c", "h", 1, stamp + 1)], { source: "self-stake" });
  assert.equal(
    await db
      .prepare("SELECT row_count FROM nominator_scan_receipts")
      .first("row_count"),
    3,
  );
  const empty = await positions([]);
  assert.equal(empty.write?.ok, true);
  assert.equal(empty.coverage?.rows, 0);
  assert.equal(empty.prune?.rows, 0);
});
test("normalization recomputes affected pools including previous chunks without rounding stored shares", async () => {
  const a = row("a"),
    b = { ...row("b"), shares: "170141183460469231731687303715884105727" };
  await positions([a], { pass: pass(1, 2) });
  assert.equal(
    await db
      .prepare(
        "SELECT share_fraction FROM nominator_positions WHERE coldkey='a'",
      )
      .first("share_fraction"),
    1,
  );
  await positions([b], { pass: pass(1, 2) });
  const found = await db
    .prepare(
      "SELECT coldkey,shares,share_fraction FROM nominator_positions ORDER BY coldkey",
    )
    .all();
  assert.equal(found.results[0].shares, a.shares);
  assert.equal(found.results[1].shares, b.shares);
  assert.ok(Math.abs(Number(found.results[0].share_fraction) - 2 / 3) < 1e-15);
  assert.ok(Math.abs(Number(found.results[1].share_fraction) - 1 / 3) < 1e-15);
  assert.equal(
    await db
      .prepare("SELECT completed_at FROM nominator_positions_passes")
      .first("completed_at"),
    stamp + 1,
  );
  await positions([b], { pass: pass(1, 2) });
  assert.equal(
    await db
      .prepare(
        "SELECT share_fraction FROM nominator_positions WHERE coldkey='a'",
      )
      .first("share_fraction"),
    found.results[0].share_fraction,
  );
  // NULL or zero shares must not divide by zero or invent a fraction.
  await positions(
    [
      { ...row("zero", "zero"), shares: "0", share_fraction: null },
      { ...row("null", "null"), shares: null, share_fraction: 0.2 },
    ],
    { pass: pass(2, 2) },
  );
  assert.equal(
    await db
      .prepare(
        "SELECT share_fraction FROM nominator_positions WHERE coldkey='zero'",
      )
      .first("share_fraction"),
    null,
  );
  assert.equal(
    await db
      .prepare(
        "SELECT share_fraction FROM nominator_positions WHERE coldkey='null'",
      )
      .first("share_fraction"),
    0.2,
  );
});
test("receipt or pass failure rolls back positions, pruning and delivery evidence together", async () => {
  await positions([row("c", "old", 1, stamp - 1)]);
  for (const table of [
    "nominator_scan_receipts",
    "nominator_positions_passes",
  ]) {
    await db
      .prepare(
        `CREATE TRIGGER reject_nominator BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT,'injected'); END`,
      )
      .run();
    try {
      const result = await positions([row()], { pass: pass() });
      assert.equal(result.write?.ok, false);
      assert.equal(result.prune?.ok, false);
      assert.equal(result.coverage?.ok, false);
      assert.equal(result.pass?.ok, false);
      assert.equal(
        await db
          .prepare("SELECT hotkey FROM nominator_positions")
          .first("hotkey"),
        "old",
      );
      assert.equal(await count("nominator_positions_passes"), 0);
    } finally {
      await db.prepare("DROP TRIGGER reject_nominator").run();
    }
  }
  const failure = await positions([{ ...row(), coldkey: null }], {
    source: "self-stake",
  });
  assert.equal(failure.write?.ok, false);
  assert.equal(failure.coverage, undefined);
  assert.equal(failure.pass, undefined);
});
test("native ownership works without Hyperdrive and refuses incomplete selection", async () => {
  await assert.rejects(
    () =>
      mirrorLedgerToNeon(
        dataApiEnv({
          D1_STATE: db,
          D1_STATE_TABLES: "hotkey_alpha,hotkey_alpha_passes",
          HYPERDRIVE: undefined,
        }),
        null,
        "hotkey-alpha",
        [],
        { laneHealthDb },
      ),
    /spans D1/,
  );
  const result = await mirrorNominatorPositionsToNeon(
    env(),
    null,
    { rows: [], coldkeyMaxCapturedAt: new Map() },
    { laneHealthDb },
  );
  assert.equal(result.write?.ok, true);
  assert.equal(
    (
      await writeNominatorPositionsD1(store(), {
        rows: [],
        coldkeyMaxCapturedAt: new Map(),
        source: "self-stake",
        pass: pass(),
      })
    ).pass?.ok,
    true,
  );
});

test("authenticated ledger sync routes persist in D1 without a PostgreSQL binding", async () => {
  const queued: unknown[] = [];
  const account = "5G9hfkx9wGB1CLMT9WXkpHSAiYzjZb5o1Boyq4KAdDhjwrc5";
  const environment = dataApiEnv({
    ...env(),
    SYNC_BATCHES: {
      async send(body: unknown) {
        queued.push(body);
      },
      async sendBatch(messages: { body: unknown }[]) {
        queued.push(...messages.map((m) => m.body));
      },
    },
    ACCOUNT_BALANCES_SYNC_SECRET: "fixture-token",
    HOTKEY_ALPHA_SYNC_SECRET: "fixture-token",
    VALIDATOR_NOMINATOR_COUNTS_SYNC_SECRET: "fixture-token",
    NOMINATOR_POSITIONS_SYNC_SECRET: "fixture-token",
  });
  const pending: Promise<unknown>[] = [];
  const ctx = {
    waitUntil: (p: Promise<unknown>) => {
      pending.push(p);
    },
  } as ExecutionContext;
  async function post(lane: string, rows: Record<string, unknown>[]) {
    const response = await worker.fetch(
      new Request(`https://example.com/api/v1/internal/${lane}-sync`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [`x-${lane}-sync-token`]: "fixture-token",
        },
        body: JSON.stringify({ rows, pass_total: rows.length }),
      }),
      environment,
      ctx,
    );
    assert.equal(response.status, 200, await response.clone().text());
    await Promise.all(pending);
    if (queued.length) {
      let acknowledged = 0;
      const messages = queued.splice(0).map((body, i) => ({
        id: String(i),
        timestamp: new Date(stamp),
        attempts: 1,
        body,
        ack() {
          acknowledged++;
        },
        retry() {
          assert.fail("durable capture requested a retry");
        },
      }));
      await worker.queue!(
        {
          queue: "metagraphed-sync-batches",
          metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
          messages,
          ackAll() {},
          retryAll() {
            assert.fail("batch retry");
          },
        },
        environment,
        ctx,
      );
      assert.equal(acknowledged, messages.length);
    }
  }
  await post("account-balances", [
    { ss58: account, free_tao: 1, reserved_tao: 0, captured_at: stamp },
  ]);
  await post("validator-nominator-counts", [
    { hotkey: account, nominator_count: 1, captured_at: stamp },
  ]);
  await post("nominator-positions", [
    { ...row(account, account), shares: "10" },
  ]);
  await post("hotkey-alpha", [
    { hotkey: account, netuid: 1, total_alpha: 10, captured_at: stamp },
  ]);
  assert.equal(neonOwnsLedger(environment, "account-balances"), true);
  assert.equal(neonOwnsNominatorPositions(environment), true);
  for (const table of [
    "account_balances",
    "hotkey_alpha",
    "validator_nominator_counts",
    "nominator_positions",
  ]) {
    assert.equal(await count(table), 1);
  }
});
