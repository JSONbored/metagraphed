import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, test } from "vitest";
import { Miniflare } from "miniflare";
import { createD1Store } from "../src/d1-store.ts";
import { writeNeuronDocuments } from "../src/neuron-documents.ts";
import { neuronSnapshotWrite } from "../src/neurons-neon-write.ts";
import { refreshExplorerDirectoryMaterialization } from "../workers/data-api.ts";
import { dataApiEnv } from "./helpers/worker-env.ts";
import {
  explorerDirectoriesSnapshotKey,
  KV_EXPLORER_DIRECTORIES_CURRENT,
} from "../src/kv-keys.ts";
import { NEWEST_NEURON_CAPTURE_QUERY } from "../src/neuron-snapshot-read.ts";

const runtime = new Miniflare({
  modules: true,
  script: "export default {fetch(){return new Response('test')}}",
  compatibilityDate: "2026-06-06",
  d1Databases: ["DB"],
});
let db: D1Database;
let tables: string;
const stamp = 1_790_090_000_000;
const account = "5G9hfkx9wGB1CLMT9WXkpHSAiYzjZb5o1Boyq4KAdDhjwrc5";
const ctx = { waitUntil() {} } as unknown as ExecutionContext;

beforeAll(async () => {
  db = await runtime.getD1Database("DB");
  const root = new URL("../migrations/d1/", import.meta.url);
  for (const file of readdirSync(root)
    .filter((name) => name.endsWith(".sql"))
    .sort()) {
    for (const sql of readFileSync(new URL(file, root), "utf8").split(
      "-- statement-breakpoint",
    ))
      if (sql.trim()) await db.prepare(sql).run();
  }
  tables = (
    await db
      .prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view')")
      .all<{ name: string }>()
  ).results
    .map((row) => row.name)
    .join(",");
});
beforeEach(async () => {
  for (const table of [
    "neurons_capture_batches",
    "neurons_passes",
    "neurons_documents",
    "neurons_members",
    "neuron_daily_documents",
    "neuron_daily_members",
    "account_position_daily_documents",
    "account_position_daily_members",
  ])
    await db.prepare(`DELETE FROM ${table}`).run();
});
afterAll(async () => runtime.dispose());

function fixture() {
  const queries: string[] = [];
  const values = new Map<string, string>();
  const environment = dataApiEnv({
    D1_STATE: {
      prepare(sql: string) {
        queries.push(sql);
        return db.prepare(sql);
      },
      batch: db.batch.bind(db),
    } as D1Database,
    D1_STATE_TABLES: tables,
    HYPERDRIVE: undefined,
    METAGRAPH_CONTROL: {
      async get(key: string, type?: string) {
        const value = values.get(key) ?? null;
        return type === "json" && value !== null ? JSON.parse(value) : value;
      },
      async put(key: string, value: string) {
        values.set(key, value);
      },
      async delete(key: string) {
        values.delete(key);
      },
    } as unknown as KVNamespace,
  });
  return { environment, queries, values };
}
async function chunk(uid: number, capturedAt = stamp, total = 63) {
  const rows = [
    {
      netuid: 7,
      uid,
      hotkey: account,
      coldkey: account,
      captured_at: capturedAt,
      block_number: 9_000_000,
      stake_tao: 1,
      emission_tao: 2,
      active: true,
      validator_permit: true,
    },
  ];
  await writeNeuronDocuments(createD1Store(db), {
    ...neuronSnapshotWrite(rows, capturedAt + 1),
    pass: {
      capturedAt,
      receivedRows: 1,
      expectedRows: total,
      nowMs: capturedAt + 1,
    },
  });
}

test("63 native producer chunks fold the directory only after actual completion", async () => {
  const { environment, queries, values } = fixture();
  for (let uid = 0; uid < 62; uid++) {
    await chunk(uid);
    assert.equal(
      await refreshExplorerDirectoryMaterialization(environment, ctx, stamp),
      false,
    );
  }
  assert.equal(queries.length, 62);
  assert.ok(queries.every((sql) => sql.includes("FROM neurons_passes")));
  assert.equal(values.size, 0);
  await chunk(62);
  queries.length = 0;
  assert.equal(
    await refreshExplorerDirectoryMaterialization(environment, ctx, stamp),
    true,
  );
  assert.equal(
    queries.filter((sql) => sql === NEWEST_NEURON_CAPTURE_QUERY).length,
    2,
  );
  const materialized = JSON.parse(
    values.get(explorerDirectoriesSnapshotKey(stamp))!,
  );
  assert.equal(materialized.accounts.account_count, 1);
  assert.equal(materialized.validators.validator_count, 1);
  assert.equal(
    JSON.parse(values.get(KV_EXPLORER_DIRECTORIES_CURRENT)!).captured_at,
    stamp,
  );
  assert.deepEqual(
    (
      await db
        .prepare(
          "SELECT expected_rows,received_rows,completed_at FROM neurons_passes",
        )
        .all()
    ).results,
    [{ expected_rows: 63, received_rows: 63, completed_at: stamp + 1 }],
  );
  assert.equal(
    (await db
      .prepare("SELECT COUNT(*) AS rows FROM neurons")
      .first<{ rows: number }>())!.rows,
    63,
  );
});

test.each(["absent", "older", "newer"])(
  "a %s completed pass declines before reading any metric documents",
  async (state) => {
    const { environment, queries, values } = fixture();
    if (state !== "absent") {
      const completed = state === "older" ? stamp - 900_000 : stamp + 900_000;
      await db
        .prepare("INSERT INTO neurons_passes VALUES (?,1,1,?)")
        .bind(completed, completed + 1)
        .run();
    }
    assert.equal(
      await refreshExplorerDirectoryMaterialization(environment, ctx, stamp),
      false,
    );
    assert.equal(queries.length, 1);
    assert.ok(queries[0].includes("FROM neurons_passes"));
    assert.equal(values.size, 0);
  },
);

test("a newer partial native capture still prevents publishing an older complete pass", async () => {
  await chunk(0, stamp, 1);
  await chunk(0, stamp + 900_000, 2);
  const { environment, queries, values } = fixture();
  assert.equal(
    await refreshExplorerDirectoryMaterialization(environment, ctx, stamp),
    false,
  );
  assert.equal(
    queries.filter((sql) => sql === NEWEST_NEURON_CAPTURE_QUERY).length,
    1,
  );
  assert.equal(values.size, 0);
});
