import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { afterAll, beforeAll, test } from "vitest";
import { Miniflare } from "miniflare";
import { createD1Store } from "../src/d1-store.ts";
import { writeNeuronDocuments } from "../src/neuron-documents.ts";
import { neuronSnapshotWrite } from "../src/neurons-neon-write.ts";
import worker, {
  writeTaoUsdIndexRow,
  refreshExplorerDirectoryMaterialization,
} from "../workers/data-api.ts";
import { dataApiEnv } from "./helpers/worker-env.ts";

const runtime = new Miniflare({
  modules: true,
  script: "export default {fetch(){return new Response('test')}}",
  compatibilityDate: "2026-06-06",
  d1Databases: ["DB"],
});
let db: D1Database;
let tables: string;
const stamp = Date.now() - 86400000;
const day = new Date(stamp).toISOString().slice(0, 10);
const account = "5G9hfkx9wGB1CLMT9WXkpHSAiYzjZb5o1Boyq4KAdDhjwrc5";
const pending: Promise<unknown>[] = [];
const ctx = {
  waitUntil(p: Promise<unknown>) {
    pending.push(p);
  },
} as ExecutionContext;
const env = () =>
  dataApiEnv({ D1_STATE: db, D1_STATE_TABLES: tables, HYPERDRIVE: undefined });
async function seed(sql: string, ...values: (string | number | null)[]) {
  await db
    .prepare(sql)
    .bind(...values)
    .run();
}
async function get(path: string) {
  const response = await worker.fetch(
    new Request(`https://example.com/api/v1/${path}`),
    env(),
    ctx,
  );
  assert.equal(
    response.status,
    200,
    `${path}: ${await response.clone().text()}`,
  );
  return response.json<Record<string, unknown>>();
}
beforeAll(async () => {
  db = await runtime.getD1Database("DB");
  const root = new URL("../migrations/d1/", import.meta.url);
  for (const file of readdirSync(root)
    .filter((f) => f.endsWith(".sql"))
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
    .map((r) => r.name)
    .join(",");
  const rows = [7, 8].map((netuid, i) => ({
    netuid,
    uid: 0,
    hotkey: account,
    coldkey: account,
    captured_at: stamp,
    stake_tao: 100 + i,
    emission_tao: 2,
    active: true,
    validator_permit: true,
    incentive: 0.5,
    dividends: 0.5,
    trust: 1,
    consensus: 1,
    validator_trust: 1,
    take: 0.1,
  }));
  await writeNeuronDocuments(createD1Store(db), {
    ...neuronSnapshotWrite(rows, stamp),
    pass: {
      capturedAt: stamp,
      receivedRows: 2,
      expectedRows: 2,
      nowMs: stamp + 1,
    },
  });
  for (const netuid of [7, 8]) {
    await seed(
      "INSERT INTO subnet_snapshots(netuid,snapshot_date,alpha_out_emission,alpha_price_tao,miner_burned_fraction,captured_at) VALUES(?,?,?,?,?,?)",
      netuid,
      day,
      1,
      0.01,
      0.2,
      stamp,
    );
    await seed(
      "INSERT INTO subnet_ownership(netuid,owner_coldkey,owner_hotkey,captured_at) VALUES(?,?,?,?)",
      netuid,
      account,
      account,
      stamp,
    );
    await seed(
      "INSERT INTO subnet_hyperparams(netuid,tempo,captured_at) VALUES(?,?,?)",
      netuid,
      360,
      stamp,
    );
  }
  await seed(
    "INSERT INTO subnet_hyperparams_history(netuid,observed_at,tempo,hyperparams_hash) VALUES(?,?,?,?)",
    7,
    stamp,
    360,
    "h",
  );
  await seed(
    "INSERT INTO account_identity(account,name,captured_at) VALUES(?,?,?)",
    account,
    "Native D1",
    stamp,
  );
  await seed(
    "INSERT INTO account_identity_history(account,name,observed_at,identity_hash) VALUES(?,?,?,?)",
    account,
    "Native D1",
    stamp,
    "i",
  );
  await seed(
    "INSERT INTO validator_nominator_counts(hotkey,nominator_count,captured_at) VALUES(?,?,?)",
    account,
    3,
    stamp,
  );
  await seed(
    "INSERT INTO nominator_positions(coldkey,hotkey,netuid,shares,share_fraction,captured_at) VALUES(?,?,?,?,?,?)",
    account,
    account,
    7,
    "18446744073709551616",
    1,
    stamp,
  );
  await seed(
    "INSERT INTO surface_status(surface_id,netuid,status,last_checked,consecutive_failures) VALUES(?,?,?,?,?)",
    "native",
    7,
    "up",
    stamp,
    0,
  );
  await seed(
    "INSERT INTO treasury_readings(netuid,source_url,read_at_sha,observed_at,first_seen,found,declared_share,review_state) VALUES(?,?,?,?,?,?,?,?)",
    7,
    "https://example.com",
    "source",
    stamp,
    stamp,
    1,
    0.2,
    "reviewed",
  );
});
afterAll(async () => {
  await Promise.all(pending);
  await runtime.dispose();
});

test("native TAO price writes preserve duplicate and unpriced observations", async () => {
  const base = {
    block_number: 1,
    observed_at: Date.parse(`${day}T12:00:00Z`),
    usd_per_tao: 300,
    price_basis: "wrapped_onchain_median" as const,
    eth_usd: 2000,
    pool_count: 3,
    pools: [],
  };
  assert.deepEqual(await writeTaoUsdIndexRow(env(), base), { written: true });
  await writeTaoUsdIndexRow(env(), { ...base, usd_per_tao: 999 });
  await writeTaoUsdIndexRow(env(), {
    ...base,
    block_number: 2,
    observed_at: base.observed_at + 1000,
    usd_per_tao: 350,
  });
  await writeTaoUsdIndexRow(env(), {
    ...base,
    block_number: 3,
    observed_at: base.observed_at + 2000,
    usd_per_tao: null,
    price_basis: "insufficient_pools",
    pool_count: 0,
  });
  const prices = (
    await db
      .prepare("SELECT usd_per_tao FROM tao_usd_index ORDER BY block_number")
      .all()
  ).results.map((r) => r.usd_per_tao);
  assert.deepEqual(prices, [300, 350, null]);
  const split = await get("subnets/7/emission-split/history");
  const points = split.points as Record<string, unknown>[];
  assert.equal(points.length, 1);
  assert.equal(points[0].tao_usd, 350);
  assert.ok(Math.abs(Number(points[0].total_usd_day) - 25200) < 0.001);
});

test("native shared readers return captured neurons, joined subnet and identity state", async () => {
  const metagraph = await get("subnets/7/metagraph");
  const neurons = metagraph.neurons as Record<string, unknown>[];
  assert.equal(neurons.length, 1);
  assert.equal(neurons[0].stake_tao, 100);
  assert.equal(neurons[0].active, true);
  const ranking = await get("chain/concentration/subnets");
  assert.equal((ranking.subnets as unknown[]).length, 2);
  for (const path of [
    "subnets/7/neurons/0",
    "subnets/7/neurons/0/history",
    "subnets/7/validators",
    "validators",
    `validators/${account}`,
    `validators/${account}/history`,
    "subnets/7/concentration",
    "subnets/7/concentration/history",
    "subnets/7/performance",
    "subnets/7/performance/history",
    "chain/concentration",
    "chain/performance",
    "chain/idle-stake",
    "chain/yield",
    "subnets/7/idle-stake",
    "subnets/7/yield",
    "subnets/7/yield/history",
    "subnets/7/miner-fairness",
    "subnets/7/cost-to-participate",
    "subnets/7/treasury",
    "subnets/7/owner-capture",
    `accounts/${account}/portfolio`,
    `accounts/${account}/subnets`,
    `accounts/${account}/subnets/7/history`,
    "accounts",
    "subnets/7/history",
    "chain/turnover",
    "subnets/7/turnover",
    "subnets/movers",
    "subnets/7/hyperparameters",
    "subnets/7/hyperparameters/history",
    `accounts/${account}/identity`,
    `accounts/${account}/identity-history`,
  ])
    await get(path);
  const health = await get(`internal/health-status-live?since=${stamp - 1}`);
  assert.equal(
    (health.rows as Record<string, unknown>[])[0].surface_id,
    "native",
  );
});

test("directory publication runs against native completed neuron captures", async () => {
  const values = new Map<string, string>();
  const kv = {
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
  };
  const environment = dataApiEnv({ ...env(), METAGRAPH_CONTROL: kv });
  assert.equal(
    await refreshExplorerDirectoryMaterialization(environment, ctx, stamp),
    true,
  );
  for (const route of ["accounts/directory", "validators/operators"]) {
    const response = await worker.fetch(
      new Request(`https://example.com/api/v1/${route}`),
      environment,
      ctx,
    );
    assert.equal(response.status, 200, await response.clone().text());
    const body = await response.json<Record<string, unknown>>();
    assert.equal(
      body[route.startsWith("accounts") ? "account_count" : "validator_count"],
      1,
    );
  }
});
