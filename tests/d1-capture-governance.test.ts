import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, test } from "vitest";
import { Miniflare } from "miniflare";
import { apiEnv } from "./helpers/worker-env.ts";
import { handleRequest } from "../workers/api.ts";
import { neonWatermark, runRawCaptureSync } from "../src/raw-capture-sync.ts";
import { runSubnetDeregistrationDailyLane } from "../src/subnet-deregistration-daily.ts";
import { loadEmissionChanges } from "../src/emission-gate-changes.ts";
import { createD1Store } from "../src/d1-store.ts";
const runtime = new Miniflare({
  modules: true,
  script: "export default { fetch() { return new Response('test'); } }",
  compatibilityDate: "2026-06-06",
  d1Databases: ["DB"],
});
let db: D1Database;
const stamp = 1790090000000;
const tables =
  "raw_capture_state,emission_gate_param_history,subnet_emission_enabled_history,emission_flow_watch,subnet_deregistration_daily";
function env() {
  return apiEnv({
    D1_STATE: db,
    D1_STATE_TABLES: tables,
    HYPERDRIVE: undefined,
  });
}
beforeAll(async () => {
  db = await runtime.getD1Database("DB");
  for (const sql of readFileSync(
    new URL("../migrations/d1/0006_capture_governance.sql", import.meta.url),
    "utf8",
  ).split("-- statement-breakpoint"))
    if (sql.trim()) await db.prepare(sql).run();
});
afterAll(async () => {
  await runtime.dispose();
});
test("capture cursor reads its own monotonic writes without Hyperdrive or an execution context", async () => {
  const store = neonWatermark(env(), undefined, "mainnet", () => stamp);
  assert.equal(await store.read(), null);
  await store.write(9120000);
  await store.write(9119999);
  assert.equal(await store.read(), 9120000);
  const testnet = neonWatermark(env(), undefined, "testnet", () => stamp);
  assert.equal(await testnet.read(), null);
  await testnet.write(8050000);
  assert.equal(await testnet.read(), 8050000);
  let rpcCalls = 0;
  const result = await runRawCaptureSync(
    {
      ...env(),
      RAW_CAPTURE_ENABLED: "true",
      METAGRAPH_ARCHIVE: {
        async put() {
          throw new Error("no capture expected");
        },
      },
    },
    {
      fetchImpl: async () => {
        rpcCalls++;
        throw new Error("injected RPC failure");
      },
      sleepFn: async () => {},
      recordException: async () => true,
      endpointDeps: { readArtifact: async () => ({ ok: false }) },
    },
  );
  assert.notEqual(result.reason, "watermark_unavailable");
  assert.ok(rpcCalls > 0);
});
function economics(count: number, block = 9000000) {
  return {
    chain_state: { block, network_immunity_period: 50000 },
    subnets: Array.from({ length: count }, (_, i) => ({
      netuid: i + 1,
      moving_price_pinned: 0.5 + i / 1000,
      registered_at_block: 1000000 + i,
      subnet_mechanism: 1,
    })),
  };
}
test("a full daily observation commits atomically across D1 chunks and rejects stale blocks", async () => {
  const deps = { readEconomics: async () => economics(129), now: () => stamp };
  assert.equal((await runSubnetDeregistrationDailyLane(env(), deps)).ok, true);
  assert.equal(
    await db
      .prepare("SELECT COUNT(*) AS n FROM subnet_deregistration_daily")
      .first("n"),
    129,
  );
  await runSubnetDeregistrationDailyLane(env(), {
    ...deps,
    readEconomics: async () => economics(129, 8999999),
  });
  assert.equal(
    await db
      .prepare("SELECT MIN(pinned_block) AS n FROM subnet_deregistration_daily")
      .first("n"),
    9000000,
  );
  await db
    .prepare(
      "CREATE TRIGGER reject_daily BEFORE UPDATE ON subnet_deregistration_daily WHEN NEW.netuid=129 BEGIN SELECT RAISE(ABORT,'injected last-chunk failure'); END",
    )
    .run();
  assert.equal(
    (
      await runSubnetDeregistrationDailyLane(env(), {
        ...deps,
        readEconomics: async () => economics(129, 9000001),
      })
    ).ok,
    false,
  );
  assert.equal(
    await db
      .prepare("SELECT MAX(pinned_block) AS n FROM subnet_deregistration_daily")
      .first("n"),
    9000000,
  );
  await db.prepare("DROP TRIGGER reject_daily").run();
});
test("governance diff and append runs on native D1 and a repeated observation writes nothing", async () => {
  const body = {
    block_number: 8500000,
    observed_at: stamp,
    current: {
      emission_gate_bar: 0.42,
      emission_bar_quantile: 0.75,
      emission_gate_exponent: null,
      block_emission_halvings: 2,
    },
    current_enabled: [
      [1, true],
      [2, false],
    ],
    flow_observations: [
      { item: "net_tao_flow_enabled", raw: null },
      { item: "flow_norm_exponent", raw: null },
      { item: "tao_flow_cutoff", raw: null },
      { item: "flow_ema_smoothing_factor", raw: null },
    ],
    current_ema: [
      [1, { block: 8466530 }],
      [2, null],
    ],
  };
  const post = () =>
    handleRequest(
      new Request("https://example.com/api/v1/internal/emission-gate-sync", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-emission-gate-sync-token": "fixture",
        },
        body: JSON.stringify(body),
      }),
      apiEnv({ ...env(), EMISSION_GATE_SYNC_SECRET: "fixture" }),
      {},
    );
  const first = await post();
  assert.equal(first.status, 200, await first.text());
  const before = await db
    .prepare("SELECT COUNT(*) AS n FROM emission_gate_param_history")
    .first("n");
  assert.equal(before, 4);
  const second = await post();
  assert.equal(second.status, 200, await second.text());
  assert.equal(
    await db
      .prepare("SELECT COUNT(*) AS n FROM emission_gate_param_history")
      .first("n"),
    before,
  );
  const changes = await loadEmissionChanges(createD1Store(db), {});
  assert.ok(changes);
});

test("an unselected D1 binding leaves the daily lane with its existing owner", async () => {
  const result = await runSubnetDeregistrationDailyLane(
    {
      ...env(),
      D1_STATE_TABLES: "",
      HYPERDRIVE: { connectionString: "postgresql://unused.invalid/database" },
    },
    {
      readEconomics: async () => null,
      now: () => stamp,
      laneHealthDb: {
        async query() {
          return [];
        },
        async run() {
          return { changes: 0 };
        },
      },
    },
  );
  assert.equal(result.reason, "economics_unavailable");
  assert.equal(
    await db
      .prepare("SELECT COUNT(*) AS n FROM subnet_deregistration_daily")
      .first("n"),
    129,
  );
});
