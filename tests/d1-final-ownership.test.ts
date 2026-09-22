import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { beforeAll, afterAll, test } from "vitest";
import { Miniflare } from "miniflare";
import { handleRequest } from "../workers/api.ts";
import dataWorker, { neonOwnsNeuronsSnapshot } from "../workers/data-api.ts";
import { createLocalArtifactEnv } from "../scripts/lib.ts";
import { apiEnv, dataApiEnv } from "./helpers/worker-env.ts";
import { DEGRADED_HEADER } from "../workers/request-handlers/analytics.ts";

const runtime = new Miniflare({
  modules: true,
  script: "export default {fetch(){return new Response('test')}}",
  compatibilityDate: "2026-06-06",
  d1Databases: ["DB"],
});
let db: D1Database;
let owners: string;
const pending: Promise<unknown>[] = [];
const ctx = {
  waitUntil(p: Promise<unknown>) {
    pending.push(p);
  },
} as ExecutionContext;
const state = () => ({
  D1_STATE: db,
  D1_STATE_TABLES: owners,
  HYPERDRIVE: undefined,
});
beforeAll(async () => {
  db = await runtime.getD1Database("DB");
  const root = new URL("../migrations/d1/", import.meta.url);
  for (const file of readdirSync(root)
    .filter((f) => f.endsWith(".sql"))
    .sort())
    for (const sql of readFileSync(new URL(file, root), "utf8").split(
      "-- statement-breakpoint",
    ))
      if (sql.trim()) await db.prepare(sql).run();
  owners = (
    await db
      .prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view')")
      .all<{ name: string }>()
  ).results
    .map((r) => r.name)
    .join(",");
});
afterAll(async () => {
  await Promise.all(pending);
  await runtime.dispose();
});

test("native ownership reaches both neuron ingestion routes after Hyperdrive removal", async () => {
  assert.equal(neonOwnsNeuronsSnapshot(dataApiEnv(state())), true);
  assert.throws(
    () =>
      neonOwnsNeuronsSnapshot(
        dataApiEnv({
          ...state(),
          D1_STATE_TABLES: "neurons,neuron_daily,account_position_daily",
        }),
      ),
    /spans D1 and Neon/,
  );
  const row = {
    netuid: 7,
    uid: 3,
    hotkey: "5Hot",
    coldkey: "5Cold",
    active: 1,
    validator_permit: 1,
    rank: 1,
    trust: 0,
    validator_trust: 0.5,
    consensus: 0.4,
    incentive: 0.3,
    dividends: 0.2,
    emission_tao: 1.5,
    stake_tao: 100.25,
    registered_at_block: 1000,
    is_immunity_period: 0,
    axon: "1.2.3.4:9000",
    block_number: 5_000_000,
    captured_at: Date.now(),
  };
  for (const [path, header, secret] of [
    ["neurons-sync", "x-neurons-sync-token", "NEURONS_SYNC_SECRET"],
    [
      "backfill-neuron-daily",
      "x-neuron-daily-backfill-token",
      "NEURON_DAILY_BACKFILL_SECRET",
    ],
  ]) {
    const response = await dataWorker.fetch(
      new Request(`https://example.com/api/v1/internal/${path}`, {
        method: "POST",
        headers: { [header]: "fixture-token" },
        body: JSON.stringify([row]),
      }),
      dataApiEnv({ ...state(), [secret]: "fixture-token" }),
      ctx,
    );
    assert.equal(response.status, 200, await response.clone().text());
  }
  for (const table of ["neurons", "neuron_daily", "account_position_daily"])
    assert.equal(
      await db.prepare(`SELECT count(*) n FROM ${table}`).first("n"),
      1,
    );
});

test("D1-backed analytics preserve cache eligibility without PostgreSQL", async () => {
  const env = apiEnv(createLocalArtifactEnv(state()));
  for (const path of [
    "/api/v1/health/trends",
    "/api/v1/subnets/7/health/trends",
    "/api/v1/subnets/7/health/percentiles",
    "/api/v1/subnets/7/health/incidents",
    "/api/v1/incidents",
    "/api/v1/subnets/7/trajectory",
    "/api/v1/subnets/7/uptime",
    "/api/v1/economics/trends",
    "/api/v1/registry/leaderboards",
  ]) {
    const response = await handleRequest(
      new Request(`https://example.com${path}`),
      env,
      ctx,
    );
    assert.equal(
      response.status,
      200,
      `${path}: ${await response.clone().text()}`,
    );
    assert.equal(response.headers.get(DEGRADED_HEADER), null, path);
    assert.doesNotMatch(
      response.headers.get("cache-control") ?? "",
      /no-store/,
      path,
    );
  }
});

test("health retains the D1 chain heartbeat after the Neon binding is removed", async () => {
  const stamp = Date.now();
  await db
    .prepare(
      `INSERT INTO chain_detail_blocks(block_number,block_hash,spec_version,extrinsic_count,chain_event_count,account_event_count,observed_at,synced_at)
    VALUES(9000000,'0xfixture',454,0,0,0,?,?)`,
    )
    .bind(stamp, stamp)
    .run();
  const response = await handleRequest(
    new Request("https://example.com/health"),
    apiEnv(createLocalArtifactEnv(state())),
    ctx,
  );
  const body = await response.json<{
    bindings: { health_db: boolean };
    chain_events: { latest_indexed_block: number };
  }>();
  assert.equal(response.status, 200);
  assert.equal(body.bindings.health_db, true);
  assert.equal(body.chain_events.latest_indexed_block, 9000000);
});
