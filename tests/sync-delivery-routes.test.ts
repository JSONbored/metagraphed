import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, test } from "vitest";
import worker from "../workers/data-api.ts";
import { dataApiEnv } from "./helpers/worker-env.ts";
import {
  makeSyncDelivery,
  syncDeliveryKey,
  requireSyncDeliveryQualification,
} from "../src/sync-delivery-receipt.ts";
import {
  packSyncBatchMessages,
  passTallyFor,
  syncBatchRows,
  writeSyncBatch,
  type SyncBatchMessage,
} from "../src/sync-batch-queue.ts";
import { PASS_TABLES } from "../src/pass-completeness.ts";
import { createD1Store } from "../src/d1-store.ts";
import { writeNeuronDocuments } from "../src/neuron-documents.ts";
import { neuronSnapshotWrite } from "../src/neurons-neon-write.ts";

const runtime = new Miniflare({
  modules: true,
  script: "export default {fetch(){return new Response('fixture')}}",
  compatibilityDate: "2026-06-06",
  d1Databases: ["DB"],
});
let db: D1Database;
let tables: string;
const pending: Promise<unknown>[] = [];
const ctx = {
  waitUntil: (p: Promise<unknown>) => pending.push(p),
} as unknown as ExecutionContext;
const queued: SyncBatchMessage[] = [];
const account = "5G9hfkx9wGB1CLMT9WXkpHSAiYzjZb5o1Boyq4KAdDhjwrc5";
const stamp = 1790000000000;
const env = () =>
  dataApiEnv({
    D1_STATE: db,
    D1_STATE_TABLES: tables,
    HYPERDRIVE: undefined,
    SYNC_DELIVERY_V1_READY: "true",
    SYNC_BATCHES: {
      send: async (body: unknown) => {
        queued.push(body as SyncBatchMessage);
      },
    },
    ACCOUNT_BALANCES_SYNC_SECRET: "fixture-token",
    HOTKEY_ALPHA_SYNC_SECRET: "fixture-token",
    NEURONS_SYNC_SECRET: "fixture-token",
    NOMINATOR_POSITIONS_SYNC_SECRET: "fixture-token",
    VALIDATOR_NOMINATOR_COUNTS_SYNC_SECRET: "fixture-token",
  });
beforeAll(async () => {
  db = await runtime.getD1Database("DB");
  for (const file of readdirSync("migrations/d1")
    .filter((f) => f.endsWith(".sql"))
    .sort())
    for (const statement of readFileSync(`migrations/d1/${file}`, "utf8").split(
      "-- statement-breakpoint",
    ))
      if (statement.trim()) await db.prepare(statement).run();
  for (const statement of readFileSync(
    "deploy/sync-delivery-receipts/sqlite.sql",
    "utf8",
  )
    .split(/(?<=;)\n(?=CREATE|--|\n)/)
    .filter((s) => s.trim()))
    await db.prepare(statement).run();
  tables = (
    await db
      .prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view')")
      .all<{ name: string }>()
  ).results
    .map((r) => r.name)
    .join(",");
});
afterAll(async () => {
  await Promise.allSettled(pending);
  await runtime.dispose();
});
async function post(lane: string, body: unknown, environment = env()) {
  return worker.fetch(
    new Request(`https://example.com/api/v1/internal/${lane}-sync`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [`x-${lane}-sync-token`]: "fixture-token",
      },
      body: JSON.stringify(body),
    }),
    environment,
    ctx,
  );
}
test("all five authenticated routes preserve producer identity through actual writes and queue replay", async () => {
  const lanes: [string, Record<string, unknown>[]][] = [
    [
      "account-balances",
      [{ ss58: account, free_tao: 1, reserved_tao: 0, captured_at: stamp }],
    ],
    [
      "validator-nominator-counts",
      [{ hotkey: account, nominator_count: 1, captured_at: stamp }],
    ],
    [
      "nominator-positions",
      [
        {
          coldkey: account,
          hotkey: account,
          netuid: 1,
          shares: "340282366920938463463374607431768211455",
          share_fraction: 1,
          captured_at: stamp,
        },
      ],
    ],
    [
      "hotkey-alpha",
      [{ hotkey: account, netuid: 1, total_alpha: 100, captured_at: stamp }],
    ],
    [
      "neurons",
      [
        {
          netuid: 1,
          uid: 0,
          hotkey: account,
          coldkey: account,
          active: true,
          stake_tao: 1,
          captured_at: stamp,
        },
      ],
    ],
  ];
  for (const [lane, rows] of lanes) {
    const delivery = makeSyncDelivery(lane, stamp, rows.length, rows);
    const packet = { delivery, delivery_rows: rows, pass_total: rows.length };
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await post(lane, packet);
      assert.equal(response.status, 200, await response.clone().text());
      const reply = await response.json<{
        delivery: { parent_id: string; parent_sha256: string };
      }>();
      assert.equal(reply.delivery.parent_id, delivery.id);
      assert.equal(reply.delivery.parent_sha256, delivery.sha256);
      const messages = queued.splice(0).map((body, i) => ({
        id: String(i),
        timestamp: new Date(stamp),
        attempts: 1,
        body,
        ack() {},
        retry() {
          assert.fail("identified replay requested retry");
        },
      }));
      if (messages.length)
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
          env(),
          ctx,
        );
    }
    const tally = await db
      .prepare(
        `SELECT received_rows,completed_at FROM ${PASS_TABLES[lane]} WHERE captured_at=?`,
      )
      .bind(stamp)
      .first<{ received_rows: number; completed_at: number }>();
    assert.equal(tally!.received_rows, 1);
    assert.ok(tally!.completed_at);
  }
  assert.equal(
    await db
      .prepare("SELECT COUNT(*) n FROM sync_delivery_receipts")
      .first<number>("n"),
    5,
  );
});
test("unqualified activation and malformed envelope never downgrade to legacy writes", async () => {
  const rows = [
    { ss58: account, free_tao: 1, reserved_tao: 0, captured_at: stamp + 1 },
  ];
  const delivery = makeSyncDelivery("account-balances", stamp + 1, 1, rows);
  for (const body of [
    { delivery, delivery_rows: rows },
    {
      delivery: { ...delivery, sha256: "a".repeat(64) },
      delivery_rows: rows,
      pass_total: 1,
    },
    {
      delivery: {
        ...delivery,
        parent_id: delivery.id,
        parent_sha256: delivery.sha256,
      },
      delivery_rows: rows,
      pass_total: 1,
    },
    { delivery, rows, pass_total: 1 },
  ]) {
    const response = await post("account-balances", body);
    assert.equal(response.status, 400, await response.clone().text());
  }
  assert.throws(() => requireSyncDeliveryQualification(null), /not qualified/);
  assert.throws(() => requireSyncDeliveryQualification({}), /not qualified/);
  requireSyncDeliveryQualification({ SYNC_DELIVERY_V1_READY: "true" });
  const response = await post(
    "account-balances",
    { delivery, delivery_rows: rows, pass_total: 1 },
    { ...env(), SYNC_DELIVERY_V1_READY: undefined },
  );
  assert.equal(response.status, 400);
  assert.equal(queued.length, 0);
  const body = {
    lane: "account-balances",
    captured_at: stamp + 1,
    rows,
    delivery,
  } as SyncBatchMessage;
  let writes = 0;
  await assert.rejects(
    writeSyncBatch(body, {
      "account-balances": async () => {
        writes++;
        return { statements: 0 };
      },
    }),
    /census/,
  );
  await assert.rejects(
    writeSyncBatch(
      {
        ...body,
        pass_total: 1,
        delivery: { ...delivery, version: 2 } as never,
      },
      {
        "account-balances": async () => {
          writes++;
          return { statements: 0 };
        },
      },
    ),
    /envelope/,
  );
  assert.equal(writes, 0);
});
test("numeric neuron hoisting restores the original type before digest and native commit", async () => {
  const at = stamp + 2;
  const rows = Array.from({ length: 300 }, (_, uid) => ({
    netuid: 2,
    uid,
    hotkey: String(uid).padStart(48, "h"),
    coldkey: account,
    active: true,
    axon: JSON.stringify({ ip: 1, padding: "x".repeat(210) }),
    captured_at: at,
  }));
  rows.sort((a, b) =>
    syncDeliveryKey("neurons", a).localeCompare(syncDeliveryKey("neurons", b)),
  );
  const delivery = makeSyncDelivery("neurons", at, rows.length, rows);
  const messages = packSyncBatchMessages({
    lane: "neurons",
    capturedAt: at,
    passTotal: rows.length,
    rows,
    delivery,
    maxBytes: 16000,
    maxRows: 5000,
  });
  assert.equal(messages.length, 1);
  assert.equal(messages[0]!.key_column, "netuid");
  const decoded = syncBatchRows(messages[0]!);
  assert.equal(decoded[0]!.netuid, 2);
  await writeNeuronDocuments(createD1Store(db), {
    ...neuronSnapshotWrite(decoded, at + 100),
    pass: passTallyFor(messages[0]!, at + 100),
  });
  assert.equal(
    await db
      .prepare("SELECT received_rows FROM neurons_passes WHERE captured_at=?")
      .bind(at)
      .first("received_rows"),
    300,
  );
});

test("malformed identified queue bodies retain repair evidence and an unqualified consumer cannot write", async () => {
  let acknowledgements = 0,
    retries = 0;
  const rows = [
    { ss58: account, free_tao: 1, reserved_tao: 0, captured_at: stamp + 3 },
  ];
  const delivery = makeSyncDelivery("account-balances", stamp + 3, 1, rows);
  const bodies = [
    { delivery },
    null,
    {
      lane: "account-balances",
      captured_at: stamp + 3,
      pass_total: 1,
      rows,
      delivery,
    },
  ];
  const messages = bodies.map((body, i) => ({
    id: String(i),
    timestamp: new Date(stamp),
    attempts: 1,
    body,
    ack() {
      acknowledgements++;
    },
    retry() {
      retries++;
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
    { ...env(), SYNC_DELIVERY_V1_READY: undefined },
    ctx,
  );
  assert.equal(acknowledgements, 1);
  assert.equal(retries, 2);
  assert.equal(
    await db
      .prepare(
        "SELECT COUNT(*) n FROM sync_delivery_receipts WHERE captured_at=?",
      )
      .bind(stamp + 3)
      .first("n"),
    0,
  );
});
