import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  KV_HEALTH_CURRENT,
  KV_HEALTH_META,
  KV_HEALTH_RPC_POOL,
  pruneHealthHistory,
  runHealthProber,
} from "../src/health-prober.mjs";
import { handleScheduled } from "../workers/api.mjs";

// --- mocks --------------------------------------------------------------------
function makeDb({ priorStatus = [] } = {}) {
  const calls = { batches: [], runs: [], selects: [] };
  const bound = (sql, binds) => ({
    sql,
    binds,
    async all() {
      calls.selects.push({ sql, binds });
      if (/FROM surface_status WHERE surface_id IN/.test(sql)) {
        return { results: priorStatus };
      }
      return { results: [] };
    },
    async run() {
      calls.runs.push({ sql, binds });
      return { meta: { changes: 7 } };
    },
  });
  return {
    calls,
    prepare(sql) {
      return { sql, bind: (...binds) => bound(sql, binds) };
    },
    async batch(statements) {
      calls.batches.push(statements);
      return statements.map(() => ({ success: true }));
    },
  };
}

function makeKv() {
  const store = new Map();
  return {
    store,
    async put(key, value) {
      store.set(key, value);
    },
    async get(key) {
      return store.has(key) ? store.get(key) : null;
    },
    json(key) {
      const raw = store.get(key);
      return raw ? JSON.parse(raw) : null;
    },
  };
}

const SURFACES = [
  {
    surface_id: "sn7-api",
    netuid: 7,
    kind: "subnet-api",
    url: "https://api.example.dev",
    provider: "acme",
    authority: "official",
    auth_required: false,
    public_safe: true,
    subnet_slug: "acme",
    subnet_name: "Acme",
    probe: { method: "GET", expect: "json" },
  },
  {
    surface_id: "opentensor-finney-rpc",
    netuid: 0,
    kind: "subtensor-rpc",
    url: "https://entrypoint-finney.opentensor.ai",
    provider: "opentensor",
    authority: "official",
    auth_required: false,
    public_safe: true,
    subnet_slug: "root",
    subnet_name: "root",
    probe: { method: "JSON-RPC", expect: "json" },
  },
];

const probeImpl = async (input) =>
  input.kind === "subtensor-rpc"
    ? {
        status: "ok",
        classification: "live",
        latency_ms: 42,
        status_code: 200,
        archive_support: true,
      }
    : {
        status: "failed",
        classification: "dead",
        latency_ms: null,
        status_code: 404,
      };

describe("runHealthProber", () => {
  test("writes D1 batch + the three KV snapshots with correct shapes", async () => {
    const db = makeDb({
      priorStatus: [
        { surface_id: "sn7-api", last_ok: 1000, consecutive_failures: 2 },
      ],
    });
    const kv = makeKv();
    const result = await runHealthProber(
      {},
      {},
      {
        now: () => 50000,
        db,
        kv,
        loadSurfaces: async () => SURFACES,
        probeSurface: probeImpl,
        probeOptions: {},
      },
    );

    assert.equal(result.ok, true);
    assert.equal(result.probed, 2);
    assert.deepEqual(result.counts, {
      ok: 1,
      degraded: 0,
      failed: 1,
      unknown: 0,
    });

    // One batch with 4 statements (2 surfaces × {check insert, status upsert}).
    assert.equal(db.calls.batches.length, 1);
    assert.equal(db.calls.batches[0].length, 4);

    const current = kv.json(KV_HEALTH_CURRENT);
    assert.equal(current.summary.surface_count, 2);
    assert.deepEqual(current.summary.status_counts, {
      ok: 1,
      degraded: 0,
      failed: 1,
      unknown: 0,
    });
    assert.equal(current.surfaces.length, 2);
    // Per-subnet operational rollup, sorted by netuid.
    assert.deepEqual(
      current.subnets.map((s) => s.netuid),
      [0, 7],
    );
    assert.equal(current.subnets.find((s) => s.netuid === 0).status, "ok");
    assert.equal(current.subnets.find((s) => s.netuid === 7).status, "failed");

    // last_ok continuity: the failed surface keeps its prior last_ok (1000).
    const apiRow = current.surfaces.find((s) => s.surface_id === "sn7-api");
    assert.equal(apiRow.last_ok, new Date(1000).toISOString());
    // The ok RPC surface stamps last_ok = run time.
    const rpcRow = current.surfaces.find(
      (s) => s.surface_id === "opentensor-finney-rpc",
    );
    assert.equal(rpcRow.last_ok, new Date(50000).toISOString());

    // RPC pool snapshot: only the RPC kind, eligible because ok.
    const pool = kv.json(KV_HEALTH_RPC_POOL);
    assert.equal(pool.endpoint_count, 1);
    assert.equal(pool.eligible_count, 1);
    assert.equal(pool.endpoints[0].pool_eligible, true);
    assert.equal(pool.endpoints[0].archive_support, true);

    const meta = kv.json(KV_HEALTH_META);
    assert.equal(meta.probed_count, 2);
    assert.equal(meta.last_run_at, new Date(50000).toISOString());
  });

  test("bumps consecutive_failures from prior state for the breaker", async () => {
    const db = makeDb({
      priorStatus: [
        { surface_id: "sn7-api", last_ok: 1000, consecutive_failures: 2 },
      ],
    });
    await runHealthProber(
      {},
      {},
      {
        now: () => 50000,
        db,
        kv: makeKv(),
        loadSurfaces: async () => SURFACES,
        probeSurface: probeImpl,
        probeOptions: {},
      },
    );
    // The failed surface's status upsert carries consecutive_failures = 3.
    const upserts = db.calls.batches[0].filter((s) =>
      /INSERT INTO surface_status/.test(s.sql),
    );
    const apiUpsert = upserts.find((s) => s.binds[0] === "sn7-api");
    // binds: [surface_id, netuid, kind, url, provider, status, classification,
    //         latency_ms, status_code, last_checked, last_ok, consec, updated_at]
    assert.equal(apiUpsert.binds[11], 3);
  });

  test("no-ops cleanly when there are no operational surfaces", async () => {
    const result = await runHealthProber(
      {},
      {},
      {
        now: () => 1,
        db: makeDb(),
        kv: makeKv(),
        loadSurfaces: async () => [],
      },
    );
    assert.equal(result.ok, false);
    assert.equal(result.reason, "no-operational-surfaces");
  });
});

describe("pruneHealthHistory", () => {
  test("deletes rows older than the retention window", async () => {
    const db = makeDb();
    const result = await pruneHealthHistory(
      {},
      { now: () => 100_000_000, db, retentionMs: 1000 },
    );
    assert.equal(result.pruned, true);
    assert.equal(result.cutoff, 100_000_000 - 1000);
    assert.match(db.calls.runs[0].sql, /DELETE FROM surface_checks/);
    assert.equal(db.calls.runs[0].binds[0], 100_000_000 - 1000);
  });
});

describe("handleScheduled dispatch", () => {
  test("hourly cron prunes; other crons probe", async () => {
    const db = makeDb();
    const pruneResult = await handleScheduled(
      { cron: "0 * * * *" },
      { METAGRAPH_HEALTH_DB: db },
    );
    assert.equal(pruneResult.pruned, true);

    // The 2-minute cron path runs the prober; with an empty env it no-ops.
    const probeResult = await handleScheduled({ cron: "*/2 * * * *" }, {});
    assert.equal(probeResult.ok, false);
    assert.equal(probeResult.reason, "no-operational-surfaces");
  });
});
