import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  KV_HEALTH_CURRENT,
  KV_HEALTH_META,
  KV_HEALTH_RPC_POOL,
  loadOperationalSurfaces,
  OPERATIONAL_SURFACES_PATH,
  pruneHealthHistory,
  rollupDailyUptime,
  runD1StatementBatches,
  D1_STATEMENTS_PER_BATCH,
  runHealthProber,
  workerResolvedUrlSafetyGuard,
  workerWebSocketConnector,
} from "../src/health-prober.mjs";
import { handleScheduled } from "../workers/api.mjs";
import {
  EMBEDDING_SYNC_CRON,
  EVENTS_LOAD_CRON,
  HEALTH_PRUNE_CRON,
} from "../workers/config.mjs";

describe("workerResolvedUrlSafetyGuard (DNS-aware SSRF)", () => {
  // DoH JSON mock: maps host → { A: [...], AAAA: [...] }.
  const dohFetch = (records) => async (url) => {
    const u = new URL(url);
    const name = u.searchParams.get("name");
    const type = u.searchParams.get("type");
    const data = records[name]?.[type] || [];
    return {
      ok: true,
      async json() {
        return { Answer: data.map((d) => ({ data: d })) };
      },
    };
  };

  test("literal guard still blocks private literals + bad schemes", async () => {
    const guard = workerResolvedUrlSafetyGuard({ fetchImpl: dohFetch({}) });
    assert.equal(await guard("http://10.0.0.1/x"), true);
    assert.equal(await guard("ftp://example.com"), true);
    assert.equal(await guard("not a url"), true);
  });

  test("IP-literal hosts are checked directly without DNS", async () => {
    let called = false;
    const guard = workerResolvedUrlSafetyGuard({
      fetchImpl: async () => {
        called = true;
        return {
          ok: true,
          async json() {
            return {};
          },
        };
      },
    });
    // 8.8.8.8 is public, passes the literal guard, and is an IP literal.
    assert.equal(await guard("https://8.8.8.8/x"), false);
    assert.equal(called, false);
  });

  test("blocks a public hostname that resolves to a private IP (rebinding)", async () => {
    const guard = workerResolvedUrlSafetyGuard({
      fetchImpl: dohFetch({ "evil.example.com": { A: ["10.1.2.3"] } }),
    });
    assert.equal(await guard("https://evil.example.com/x"), true);
  });

  test("blocks a private DNS answer when the other RR lookup fails", async () => {
    const guard = workerResolvedUrlSafetyGuard({
      fetchImpl: async (url) => {
        const u = new URL(url);
        const type = u.searchParams.get("type");
        if (type === "AAAA") {
          throw new Error("AAAA lookup timed out");
        }
        return {
          ok: true,
          async json() {
            return { Answer: [{ data: "10.1.2.3" }] };
          },
        };
      },
    });
    assert.equal(await guard("https://evil.example.com/x"), true);
  });

  test("blocks a private IPv6 AAAA answer", async () => {
    const guard = workerResolvedUrlSafetyGuard({
      fetchImpl: dohFetch({ "v6.example.com": { AAAA: ["fd00::1"] } }),
    });
    assert.equal(await guard("https://v6.example.com/x"), true);
  });

  test("allows a hostname that resolves to a public IP", async () => {
    const guard = workerResolvedUrlSafetyGuard({
      fetchImpl: dohFetch({ "ok.example.com": { A: ["93.184.216.34"] } }),
    });
    assert.equal(await guard("https://ok.example.com/x"), false);
  });

  test("fails OPEN on a DoH error (does not block all health)", async () => {
    const guard = workerResolvedUrlSafetyGuard({
      fetchImpl: async () => {
        throw new Error("DoH unreachable");
      },
    });
    assert.equal(await guard("https://ok.example.com/x"), false);
  });

  test("fails OPEN on no DNS answer / non-ok DoH", async () => {
    const guard = workerResolvedUrlSafetyGuard({
      fetchImpl: async () => ({
        ok: false,
        async json() {
          return {};
        },
      }),
    });
    assert.equal(await guard("https://unknown.example.com/x"), false);
  });
});

// --- mocks --------------------------------------------------------------------
function makeDb({ priorStatus = [] } = {}) {
  const calls = { batches: [], runs: [], selects: [] };
  const bound = (sql, binds) => ({
    sql,
    binds,
    async all() {
      calls.selects.push({ sql, binds });
      if (/FROM surface_status/.test(sql)) {
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

// A fake Worker-style client WebSocket. Listeners are captured so a test can
// drive message/error/close events deterministically after send() runs.
function makeFakeWebSocket() {
  const listeners = { message: [], error: [], close: [] };
  const sent = [];
  return {
    sent,
    listeners,
    accepted: false,
    closed: false,
    accept() {
      this.accepted = true;
    },
    addEventListener(type, fn) {
      (listeners[type] ||= []).push(fn);
    },
    send(payload) {
      sent.push(payload);
    },
    close() {
      this.closed = true;
    },
    emit(type, event) {
      for (const fn of listeners[type] || []) fn(event);
    },
  };
}

// A fetchImpl that hands back the given webSocket (or rejects/omits it) and
// records the URL it was called with so the ws:→http: rewrite is checkable.
function makeFetchImpl({ webSocket, reject, calls = [] } = {}) {
  return (url, init) => {
    calls.push({ url, init });
    if (reject) return Promise.reject(reject);
    return Promise.resolve({ webSocket });
  };
}

const RPC_CALLS = [
  { key: "a", method: "chain_getHeader", params: [] },
  { key: "b", method: "system_chain", params: [] },
];

const SURFACES = [
  {
    surface_id: "sn7-api",
    surface_key: "srf-sn7apikey000000",
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
    surface_key: "srf-rootrpckey00000",
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
        latest_block: 12345,
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
        {
          surface_id: "sn7-api-old",
          surface_key: "srf-sn7apikey000000",
          last_ok: 1000,
          consecutive_failures: 2,
        },
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

    // #1005: both the append-only time-series and the latest-row upsert carry the
    // stable surface_key (binds[1]) so D1 history re-keys onto the rename-stable
    // identity. surface_checks binds: [surface_id, surface_key, netuid, ...].
    assert.match(
      db.calls.selects[0].sql,
      /WHERE surface_key IN \(\?,\?\)\s+OR surface_id IN \(\?,\?\)/,
    );
    assert.deepEqual(db.calls.selects[0].binds, [
      "srf-sn7apikey000000",
      "srf-rootrpckey00000",
      "sn7-api",
      "opentensor-finney-rpc",
    ]);
    const checkInsert = db.calls.batches[0].find(
      (s) =>
        /INSERT INTO surface_checks/.test(s.sql) && s.binds[0] === "sn7-api",
    );
    assert.equal(checkInsert.binds[1], "srf-sn7apikey000000");

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
    assert.equal(pool.endpoints[0].latest_block, 12345);

    const meta = kv.json(KV_HEALTH_META);
    assert.equal(meta.probed_count, 2);
    assert.equal(meta.last_run_at, new Date(50000).toISOString());
  });

  test("rejects unsafe or implausibly high live RPC block heights", async () => {
    const kv = makeKv();
    const rpcSurfaces = [
      {
        ...SURFACES[1],
        surface_id: "honest-rpc",
        url: "https://honest.example/rpc",
      },
      {
        ...SURFACES[1],
        surface_id: "forged-rpc",
        url: "https://forged.example/rpc",
      },
      {
        ...SURFACES[1],
        surface_id: "unsafe-rpc",
        url: "https://unsafe.example/rpc",
      },
    ];
    await runHealthProber(
      {},
      {},
      {
        now: () => 50000,
        db: makeDb(),
        kv,
        loadSurfaces: async () => rpcSurfaces,
        probeSurface: async (input) => ({
          status: "ok",
          classification: "live",
          latency_ms: 42,
          status_code: 200,
          latest_block:
            input.id === "honest-rpc"
              ? 8_400_000
              : input.id === "forged-rpc"
                ? 9_007_199_254_740_991
                : 9_007_199_254_740_992,
        }),
        probeOptions: {},
      },
    );

    const byId = new Map(
      kv
        .json(KV_HEALTH_RPC_POOL)
        .endpoints.map((endpoint) => [endpoint.id, endpoint]),
    );
    assert.equal(byId.get("honest-rpc").latest_block, 8_400_000);
    assert.equal(byId.get("forged-rpc").latest_block, null);
    assert.equal(byId.get("unsafe-rpc").latest_block, null);
  });

  test("bumps consecutive_failures from prior state for the breaker", async () => {
    const db = makeDb({
      priorStatus: [
        {
          surface_id: "sn7-api-before-rename",
          surface_key: "srf-sn7apikey000000",
          last_ok: 1000,
          consecutive_failures: 2,
        },
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
    // binds: [surface_id, surface_key, netuid, kind, url, provider, status,
    //   classification, latency_ms, status_code, last_checked, last_ok, consec,
    //   updated_at] — #1005 added surface_key at index 1, shifting the rest by 1.
    assert.match(
      apiUpsert.sql,
      /ON CONFLICT\(surface_key\) WHERE surface_key IS NOT NULL/,
    );
    assert.match(apiUpsert.sql, /ON CONFLICT\(surface_id\) DO UPDATE SET/);
    assert.equal(apiUpsert.binds[1], "srf-sn7apikey000000");
    assert.equal(apiUpsert.binds[12], 3);
  });

  test("a degraded non-RPC run resets the breaker", async () => {
    const db = makeDb({
      priorStatus: [
        {
          surface_id: "sn7-api",
          surface_key: "srf-sn7apikey000000",
          last_ok: 1000,
          consecutive_failures: 2,
        },
      ],
    });
    // The subnet-api surface probes `degraded` (e.g. rate-limited), not failed.
    const degradedProbe = async (input) =>
      input.kind === "subtensor-rpc"
        ? {
            status: "ok",
            classification: "live",
            latency_ms: 42,
            status_code: 200,
          }
        : {
            status: "degraded",
            classification: "rate-limited",
            latency_ms: null,
            status_code: 429,
          };
    await runHealthProber(
      {},
      {},
      {
        now: () => 50000,
        db,
        kv: makeKv(),
        loadSurfaces: async () => SURFACES,
        probeSurface: degradedProbe,
        probeOptions: {},
      },
    );
    const apiUpsert = db.calls.batches[0]
      .filter((s) => /INSERT INTO surface_status/.test(s.sql))
      .find((s) => s.binds[0] === "sn7-api");
    // binds[12] = consecutive_failures: a degraded run must NOT bump 2 -> 3; it
    // resets to 0 so a persistently-degraded (still-usable) endpoint is not
    // evicted from the RPC pool by the sustained-down breaker.
    assert.equal(apiUpsert.binds[12], 0);
  });

  test("a degraded RPC run accrues toward pool eviction", async () => {
    const db = makeDb({
      priorStatus: [
        {
          surface_id: "opentensor-finney-rpc",
          surface_key: "srf-rootrpckey00000",
          last_ok: 1000,
          consecutive_failures: 2,
        },
      ],
    });
    const degradedRpcProbe = async (input) =>
      input.kind === "subtensor-rpc"
        ? {
            status: "degraded",
            classification: "auth-required",
            latency_ms: null,
            status_code: 401,
          }
        : {
            status: "ok",
            classification: "live",
            latency_ms: 42,
            status_code: 200,
          };

    await runHealthProber(
      {},
      {},
      {
        now: () => 50000,
        db,
        kv: makeKv(),
        loadSurfaces: async () => SURFACES,
        probeSurface: degradedRpcProbe,
        probeOptions: {},
      },
    );

    const rpcUpsert = db.calls.batches[0]
      .filter((s) => /INSERT INTO surface_status/.test(s.sql))
      .find((s) => s.binds[0] === "opentensor-finney-rpc");
    assert.equal(rpcUpsert.binds[12], 3);
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

  test("also prunes rpc_proxy_events to the same cutoff (B3)", async () => {
    const db = makeDb();
    await pruneHealthHistory(
      {},
      { now: () => 100_000_000, db, retentionMs: 1000 },
    );
    assert.match(db.calls.runs[1].sql, /DELETE FROM rpc_proxy_events/);
    assert.equal(db.calls.runs[1].binds[0], 100_000_000 - 1000);
  });

  test("a missing rpc_proxy_events table (pre-migration) does not fail the prune", async () => {
    // surface_checks DELETE succeeds; the rpc_proxy_events DELETE throws (no such
    // table) — the prune must still report success for the surface_checks window.
    const db = {
      prepare: (sql) => ({
        bind: () => ({
          async run() {
            if (/rpc_proxy_events/.test(sql)) {
              throw new Error("no such table: rpc_proxy_events");
            }
            return { meta: { changes: 3 } };
          },
        }),
      }),
    };
    const result = await pruneHealthHistory({}, { now: () => 5_000, db });
    assert.equal(result.pruned, true);
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

  test("non-fast-load crons never drain the staged R2 files (audit #9)", async () => {
    // INVARIANT: only the EVENTS_LOAD_CRON tick owns the unlocked staged
    // read-modify-write drain. Every other cron (prune/embedding/prober) must NOT
    // call loadStagedNeurons / loadStagedEvents — running them on concurrent ticks
    // let one invocation clobber a freshly-staged file via the delete path. We prove
    // it by tracking R2 .get keys and asserting the two staged keys are never read.
    const STAGED_KEYS = [
      "metagraph/neurons-pending.json",
      "events/account-events-pending.json",
    ];
    for (const cron of [
      HEALTH_PRUNE_CRON,
      EMBEDDING_SYNC_CRON,
      "*/15 * * * *", // the prober tick (any cron that is not EVENTS_LOAD_CRON)
    ]) {
      const getKeys = [];
      const env = {
        METAGRAPH_HEALTH_DB: makeDb(),
        // A tracking bucket: any staged-key read would push it here. Incidental,
        // non-staged reads (e.g. the prober's surface fallback) are allowed and
        // return null so the path stays a clean no-op.
        METAGRAPH_ARCHIVE: {
          async get(key) {
            getKeys.push(key);
            return null;
          },
        },
        // A signing key is REQUIRED for loadStagedNeurons to even reach its
        // bucket.get — present here so the guard can't mask a regression where the
        // loader is wrongly invoked on this tick.
        METAGRAPH_STAGING_SIGNING_KEY: "test-secret",
      };
      await handleScheduled({ cron }, env, {});
      for (const stagedKey of STAGED_KEYS) {
        assert.ok(
          !getKeys.includes(stagedKey),
          `cron ${cron} must not read staged key ${stagedKey}`,
        );
      }
    }
  });

  test("fast-load cron drains BOTH staged files then returns the marker (audit #9)", async () => {
    // REGRESSION: the EVENTS_LOAD_CRON tick must still run both loaders (one R2 .get
    // per staged key) AND early-return the fast-load marker without falling through
    // to the prober/prune.
    const getKeys = [];
    const env = {
      METAGRAPH_HEALTH_DB: makeDb(),
      METAGRAPH_ARCHIVE: {
        async get(key) {
          getKeys.push(key);
          return null; // nothing staged → each loader no-ops after its read
        },
      },
      METAGRAPH_STAGING_SIGNING_KEY: "test-secret",
    };
    const result = await handleScheduled({ cron: EVENTS_LOAD_CRON }, env, {});
    assert.deepEqual(result, { ok: true, fast_load: true });
    assert.ok(
      getKeys.includes("metagraph/neurons-pending.json"),
      "loadStagedNeurons read its staged key on the fast-load tick",
    );
    assert.ok(
      getKeys.includes("events/account-events-pending.json"),
      "loadStagedEvents read its staged key on the fast-load tick",
    );
  });
});

describe("workerWebSocketConnector", () => {
  test("rewrites ws:→http:, accepts, sends every call, resolves on all replies", async () => {
    const socket = makeFakeWebSocket();
    const calls = [];
    const connect = workerWebSocketConnector(
      makeFetchImpl({ webSocket: socket, calls }),
    );
    const promise = connect("wss://node.example/rpc", RPC_CALLS, 1000);

    // ws→http rewrite + Upgrade header.
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://node.example/rpc");
    assert.equal(calls[0].init.headers.Upgrade, "websocket");

    // Wait for the fetch().then() to run so accept()/send() have happened.
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(socket.accepted, true);
    assert.equal(socket.sent.length, 2);
    const firstSent = JSON.parse(socket.sent[0]);
    assert.equal(firstSent.jsonrpc, "2.0");
    assert.equal(firstSent.id, 1);
    assert.equal(firstSent.method, "chain_getHeader");

    // Reply to both ids → resolve. One reply carries an rpc error.
    socket.emit("message", {
      data: JSON.stringify({ id: 1, result: { number: "0x1" } }),
    });
    socket.emit("message", {
      data: JSON.stringify({ id: 2, error: { code: -32000, message: "boom" } }),
    });

    const results = await promise;
    assert.equal(results.get("a").ok, true);
    assert.deepEqual(results.get("a").result, { number: "0x1" });
    assert.equal(results.get("b").ok, false);
    assert.deepEqual(results.get("b").rpc_error, {
      code: -32000,
      message: "boom",
    });
    assert.equal(socket.closed, true);
  });

  test("decodes binary (ArrayBuffer) message data via TextDecoder", async () => {
    const socket = makeFakeWebSocket();
    const connect = workerWebSocketConnector(
      makeFetchImpl({ webSocket: socket }),
    );
    const promise = connect("ws://node.example", [RPC_CALLS[0]], 1000);
    await Promise.resolve();
    await Promise.resolve();
    const bytes = new TextEncoder().encode(
      JSON.stringify({ id: 1, result: 9 }),
    );
    socket.emit("message", { data: bytes });
    const results = await promise;
    assert.equal(results.get("a").result, 9);
  });

  test("ignores replies with an unknown id without resolving early", async () => {
    const socket = makeFakeWebSocket();
    const connect = workerWebSocketConnector(
      makeFetchImpl({ webSocket: socket }),
    );
    const promise = connect("wss://node.example", RPC_CALLS, 1000);
    await Promise.resolve();
    await Promise.resolve();
    // id 99 is not in the byId map → ignored, run not yet complete.
    socket.emit("message", { data: JSON.stringify({ id: 99, result: 1 }) });
    socket.emit("message", { data: JSON.stringify({ id: 1, result: 1 }) });
    socket.emit("message", { data: JSON.stringify({ id: 2, result: 2 }) });
    const results = await promise;
    assert.equal(results.size, 2);
  });

  test("rejects when a message body is malformed JSON", async () => {
    const socket = makeFakeWebSocket();
    const connect = workerWebSocketConnector(
      makeFetchImpl({ webSocket: socket }),
    );
    const promise = connect("wss://node.example", RPC_CALLS, 1000);
    await Promise.resolve();
    await Promise.resolve();
    socket.emit("message", { data: "{not json" });
    await assert.rejects(promise, /Unexpected|JSON/i);
  });

  test("rejects on the 'error' event", async () => {
    const socket = makeFakeWebSocket();
    const connect = workerWebSocketConnector(
      makeFetchImpl({ webSocket: socket }),
    );
    const promise = connect("wss://node.example", RPC_CALLS, 1000);
    await Promise.resolve();
    await Promise.resolve();
    socket.emit("error", {});
    await assert.rejects(promise, /WebSocket RPC connection failed/);
  });

  test("rejects when closed before all responses arrive", async () => {
    const socket = makeFakeWebSocket();
    const connect = workerWebSocketConnector(
      makeFetchImpl({ webSocket: socket }),
    );
    const promise = connect("wss://node.example", RPC_CALLS, 1000);
    await Promise.resolve();
    await Promise.resolve();
    socket.emit("message", { data: JSON.stringify({ id: 1, result: 1 }) });
    socket.emit("close", {});
    await assert.rejects(promise, /WebSocket closed before all responses/);
  });

  test("does not reject on close once all responses already arrived", async () => {
    const socket = makeFakeWebSocket();
    const connect = workerWebSocketConnector(
      makeFetchImpl({ webSocket: socket }),
    );
    const promise = connect("wss://node.example", RPC_CALLS, 1000);
    await Promise.resolve();
    await Promise.resolve();
    socket.emit("message", { data: JSON.stringify({ id: 1, result: 1 }) });
    socket.emit("message", { data: JSON.stringify({ id: 2, result: 2 }) });
    await promise; // resolved by the second message
    // A trailing close after settle is a no-op (settled guard).
    socket.emit("close", {});
    socket.emit("error", {});
    const results = await promise;
    assert.equal(results.size, 2);
  });

  test("rejects with a TimeoutError when no responses arrive in time", async () => {
    const socket = makeFakeWebSocket();
    const connect = workerWebSocketConnector(
      makeFetchImpl({ webSocket: socket }),
    );
    const promise = connect("wss://node.example", RPC_CALLS, 5);
    await assert.rejects(promise, (err) => {
      assert.equal(err.name, "TimeoutError");
      assert.match(err.message, /WSS RPC probe timed out/);
      return true;
    });
  });

  test("rejects when the response carries no .webSocket", async () => {
    const connect = workerWebSocketConnector(
      makeFetchImpl({ webSocket: undefined }),
    );
    await assert.rejects(
      connect("wss://node.example", RPC_CALLS, 1000),
      /server did not accept the WebSocket upgrade/,
    );
  });

  test("rejects when fetchImpl itself rejects (catch path)", async () => {
    const connect = workerWebSocketConnector(
      makeFetchImpl({ reject: new Error("connect refused") }),
    );
    await assert.rejects(
      connect("wss://node.example", RPC_CALLS, 1000),
      /connect refused/,
    );
  });

  test("swallows a throwing socket.close() during finish", async () => {
    const socket = makeFakeWebSocket();
    socket.close = () => {
      throw new Error("close blew up");
    };
    const connect = workerWebSocketConnector(
      makeFetchImpl({ webSocket: socket }),
    );
    const promise = connect("wss://node.example", [RPC_CALLS[0]], 1000);
    await Promise.resolve();
    await Promise.resolve();
    socket.emit("message", { data: JSON.stringify({ id: 1, result: 1 }) });
    const results = await promise; // resolves despite close() throwing
    assert.equal(results.get("a").result, 1);
  });

  test("defaults fetchImpl to global fetch when none is passed", () => {
    // Construction alone exercises the default-parameter branch.
    const connect = workerWebSocketConnector();
    assert.equal(typeof connect, "function");
  });
});

describe("loadOperationalSurfaces", () => {
  const surfacesBody = { surfaces: [{ surface_id: "x", netuid: 1 }] };

  test("returns surfaces from the ASSETS binding on success", async () => {
    let requested = null;
    const env = {
      ASSETS: {
        fetch: async (req) => {
          requested = req.url;
          return { ok: true, json: async () => surfacesBody };
        },
      },
    };
    const surfaces = await loadOperationalSurfaces(env);
    assert.deepEqual(surfaces, surfacesBody.surfaces);
    assert.match(requested, new RegExp(OPERATIONAL_SURFACES_PATH));
  });

  test("falls back to R2 when ASSETS.fetch throws", async () => {
    const env = {
      ASSETS: {
        fetch: async () => {
          throw new Error("assets down");
        },
      },
      METAGRAPH_R2_LATEST_PREFIX: "live/",
      METAGRAPH_ARCHIVE: {
        get: async (key) => {
          assert.equal(key, "live/operational-surfaces.json");
          return { text: async () => JSON.stringify(surfacesBody) };
        },
      },
    };
    const surfaces = await loadOperationalSurfaces(env);
    assert.deepEqual(surfaces, surfacesBody.surfaces);
  });

  test("falls back to R2 with the default prefix when none is configured", async () => {
    const env = {
      METAGRAPH_ARCHIVE: {
        get: async (key) => {
          assert.equal(key, "latest/operational-surfaces.json");
          return { text: async () => JSON.stringify(surfacesBody) };
        },
      },
    };
    const surfaces = await loadOperationalSurfaces(env);
    assert.deepEqual(surfaces, surfacesBody.surfaces);
  });

  test("returns [] when ASSETS responds non-ok and there is no R2", async () => {
    const env = { ASSETS: { fetch: async () => ({ ok: false }) } };
    assert.deepEqual(await loadOperationalSurfaces(env), []);
  });

  test("returns [] when the ASSETS body has no surfaces array", async () => {
    const env = {
      ASSETS: { fetch: async () => ({ ok: true, json: async () => ({}) }) },
    };
    assert.deepEqual(await loadOperationalSurfaces(env), []);
  });

  test("returns [] when R2 returns a null object", async () => {
    const env = { METAGRAPH_ARCHIVE: { get: async () => null } };
    assert.deepEqual(await loadOperationalSurfaces(env), []);
  });

  test("returns [] when R2 .text() yields a body without a surfaces array", async () => {
    const env = {
      METAGRAPH_ARCHIVE: {
        get: async () => ({ text: async () => JSON.stringify({ nope: 1 }) }),
      },
    };
    assert.deepEqual(await loadOperationalSurfaces(env), []);
  });

  test("returns [] when both ASSETS and R2 throw", async () => {
    const env = {
      ASSETS: {
        fetch: async () => {
          throw new Error("assets down");
        },
      },
      METAGRAPH_ARCHIVE: {
        get: async () => {
          throw new Error("r2 down");
        },
      },
    };
    assert.deepEqual(await loadOperationalSurfaces(env), []);
  });

  test("returns [] for an empty env (no bindings present)", async () => {
    assert.deepEqual(await loadOperationalSurfaces({}), []);
  });
});

describe("runHealthProber edge paths", () => {
  test("uses the real workerWebSocketConnector path when no probeOptions are given", async () => {
    // Drive the default probeOptions branch: probeSurface still injected so no
    // real network is hit, but probeOptions falls through to the connector.
    const result = await runHealthProber(
      {},
      {},
      {
        now: () => 50000,
        db: makeDb(),
        kv: makeKv(),
        loadSurfaces: async () => SURFACES,
        probeSurface: probeImpl,
        // probeOptions intentionally omitted → exercises the default branch.
      },
    );
    assert.equal(result.ok, true);
    assert.equal(result.probed, 2);
  });

  test("catches a probe that throws → failed/unsupported row", async () => {
    const kv = makeKv();
    const result = await runHealthProber(
      {},
      {},
      {
        now: () => 7000,
        db: makeDb(),
        kv,
        loadSurfaces: async () => [SURFACES[0]],
        probeSurface: async () => {
          throw new Error("kaboom");
        },
        probeOptions: {},
      },
    );
    assert.equal(result.ok, true);
    assert.deepEqual(result.counts, {
      ok: 0,
      degraded: 0,
      failed: 1,
      unknown: 0,
    });
    const current = kv.json(KV_HEALTH_CURRENT);
    const row = current.surfaces[0];
    assert.equal(row.status, "failed");
    assert.equal(row.classification, "unsupported");
    assert.equal(row.latency_ms, null);
    assert.equal(row.status_code, null);
  });

  test("falls back to a default error message when a probe throws without one", async () => {
    const result = await runHealthProber(
      {},
      {},
      {
        now: () => 7000,
        db: makeDb(),
        kv: makeKv(),
        loadSurfaces: async () => [SURFACES[0]],
        // Throw a non-Error so error?.message is undefined.
        probeSurface: async () => {
          throw "string failure";
        },
        probeOptions: {},
      },
    );
    assert.equal(result.counts.failed, 1);
  });

  test("catches a throwing priorStatus SELECT and treats all as cold", async () => {
    const db = makeDb();
    // Make the prior-status SELECT blow up; the run should still complete.
    db.prepare = (sql) => ({
      sql,
      bind: () => ({
        async all() {
          if (/FROM surface_status WHERE surface_id IN/.test(sql)) {
            throw new Error("cold table");
          }
          return { results: [] };
        },
        async run() {
          return { meta: { changes: 0 } };
        },
      }),
    });
    db.batch = async () => [];
    const kv = makeKv();
    const result = await runHealthProber(
      {},
      {},
      {
        now: () => 9000,
        db,
        kv,
        loadSurfaces: async () => SURFACES,
        probeSurface: probeImpl,
        probeOptions: {},
      },
    );
    assert.equal(result.ok, true);
    // With no prior state, the failed surface starts its breaker at 1.
    const current = kv.json(KV_HEALTH_CURRENT);
    assert.equal(current.surfaces.length, 2);
  });

  test("runs with db absent (KV-only) and kv absent (D1-only)", async () => {
    // db absent → skips the prior SELECT + persistToD1; KV still written.
    const kv = makeKv();
    const kvOnly = await runHealthProber(
      {},
      {},
      {
        now: () => 1,
        db: null,
        kv,
        loadSurfaces: async () => SURFACES,
        probeSurface: probeImpl,
        probeOptions: {},
      },
    );
    assert.equal(kvOnly.ok, true);
    assert.ok(kv.json(KV_HEALTH_CURRENT));

    // kv absent → persistToKv no-ops; D1 still written.
    const db = makeDb();
    const d1Only = await runHealthProber(
      {},
      {},
      {
        now: () => 1,
        db,
        kv: null,
        loadSurfaces: async () => SURFACES,
        probeSurface: probeImpl,
        probeOptions: {},
      },
    );
    assert.equal(d1Only.ok, true);
    assert.equal(db.calls.batches.length, 1);
  });

  test("handles a SELECT with no results key and a surface without a provider", async () => {
    // db.prepare(...).all() returns an object without a `results` key →
    // exercises the `results || []` fallback in the prior-status loop. The
    // surface has no provider → exercises the `surface.provider || null` branch.
    const db = makeDb();
    db.prepare = (sql) => ({
      sql,
      bind: () => ({
        async all() {
          return {}; // no `results` key
        },
      }),
    });
    db.batch = async () => [];
    const kv = makeKv();
    const result = await runHealthProber(
      {},
      {},
      {
        now: () => 1,
        db,
        kv,
        loadSurfaces: async () => [
          {
            surface_id: "no-provider",
            netuid: 9,
            kind: "subnet-api",
            url: "https://np.dev",
            // provider intentionally omitted
          },
        ],
        probeSurface: async () => ({
          status: "ok",
          classification: "live",
          latency_ms: 5,
        }),
        probeOptions: {},
      },
    );
    assert.equal(result.ok, true);
    const current = kv.json(KV_HEALTH_CURRENT);
    assert.equal(current.surfaces[0].provider, null);
  });

  test("respects a custom concurrency override", async () => {
    const result = await runHealthProber(
      {},
      {},
      {
        now: () => 1,
        db: makeDb(),
        kv: makeKv(),
        loadSurfaces: async () => SURFACES,
        probeSurface: probeImpl,
        probeOptions: {},
        concurrency: 1,
      },
    );
    assert.equal(result.probed, 2);
  });
});

describe("persistToD1 via runHealthProber", () => {
  test("no-ops when db has no .prepare", async () => {
    const kv = makeKv();
    // db is a truthy object without .prepare → prior SELECT skipped (guarded by
    // db truthiness then .prepare access), persistToD1 returns immediately.
    const db = { batch: async () => [] };
    const result = await runHealthProber(
      {},
      {},
      {
        now: () => 1,
        db,
        kv,
        loadSurfaces: async () => SURFACES,
        probeSurface: probeImpl,
        probeOptions: {},
      },
    );
    assert.equal(result.ok, true);
    assert.ok(kv.json(KV_HEALTH_CURRENT));
  });

  test("swallows a throwing db.batch so KV still gets written", async () => {
    const db = makeDb();
    db.batch = async () => {
      throw new Error("batch failed");
    };
    const kv = makeKv();
    const result = await runHealthProber(
      {},
      {},
      {
        now: () => 1,
        db,
        kv,
        loadSurfaces: async () => SURFACES,
        probeSurface: probeImpl,
        probeOptions: {},
      },
    );
    assert.equal(result.ok, true);
    assert.equal(result.d1_persisted, false);
    // KV write happened despite the D1 batch throwing.
    assert.ok(kv.json(KV_HEALTH_CURRENT));
  });

  test("chunks large D1 persists into bounded batches", async () => {
    const db = makeDb();
    const surfaces = Array.from({ length: 30 }, (_, i) => ({
      ...SURFACES[0],
      surface_id: `sn-api-${i}`,
      surface_key: `srf-key-${String(i).padStart(14, "0")}`,
    }));
    const result = await runHealthProber(
      {},
      {},
      {
        now: () => 1,
        db,
        kv: makeKv(),
        loadSurfaces: async () => surfaces,
        probeSurface: probeImpl,
        probeOptions: {},
      },
    );
    assert.equal(result.ok, true);
    assert.equal(result.d1_persisted, true);
    assert.equal(db.calls.batches.length, 2);
    assert.equal(db.calls.batches[0].length, D1_STATEMENTS_PER_BATCH);
    assert.equal(db.calls.batches[1].length, 10);
  });
});

test("runD1StatementBatches splits statements at the D1 cap", async () => {
  const batches = [];
  const db = {
    batch: async (statements) => {
      batches.push(statements.length);
    },
  };
  const statements = Array.from({ length: 55 }, (_, i) => i);
  const result = await runD1StatementBatches(db, statements);
  assert.equal(result.ok, true);
  assert.equal(result.batches, 2);
  assert.deepEqual(batches, [50, 5]);
});

describe("persistToKv via runHealthProber", () => {
  test("no-ops when kv has no .put", async () => {
    const db = makeDb();
    // kv truthy but missing .put → persistToKv returns early.
    const result = await runHealthProber(
      {},
      {},
      {
        now: () => 1,
        db,
        kv: { get: async () => null },
        loadSurfaces: async () => SURFACES,
        probeSurface: probeImpl,
        probeOptions: {},
      },
    );
    assert.equal(result.ok, true);
    // D1 still got its batch.
    assert.equal(db.calls.batches.length, 1);
  });

  test("builds the rpc-pool snapshot from RPC-kind rows incl. eligible_count", async () => {
    // Two RPC-kind surfaces: one ok (eligible), one failed (ineligible), plus a
    // non-RPC api surface that must be excluded from the pool.
    const surfaces = [
      {
        surface_id: "rpc-ok",
        netuid: 0,
        kind: "subtensor-rpc",
        url: "https://a.rpc",
        provider: "p1",
      },
      {
        surface_id: "rpc-bad",
        netuid: 0,
        kind: "subtensor-wss",
        url: "wss://b.rpc",
        provider: "p2",
      },
      {
        surface_id: "api-x",
        netuid: 5,
        kind: "subnet-api",
        url: "https://x.api",
        provider: "p3",
      },
    ];
    const probe = async (input) =>
      input.id === "rpc-ok"
        ? {
            status: "ok",
            classification: "live",
            latency_ms: 10,
            archive_support: true,
            latest_block: 76543,
          }
        : { status: "failed", classification: "dead", latency_ms: null };
    const kv = makeKv();
    await runHealthProber(
      {},
      {},
      {
        now: () => 2000,
        db: makeDb(),
        kv,
        loadSurfaces: async () => surfaces,
        probeSurface: probe,
        probeOptions: {},
      },
    );
    const pool = kv.json(KV_HEALTH_RPC_POOL);
    // Only the two RPC-kind surfaces, sorted by id (rpc-bad < rpc-ok).
    assert.equal(pool.endpoint_count, 2);
    assert.equal(pool.eligible_count, 1);
    assert.deepEqual(
      pool.endpoints.map((e) => e.id),
      ["rpc-bad", "rpc-ok"],
    );
    assert.equal(
      pool.endpoints.find((e) => e.id === "rpc-ok").pool_eligible,
      true,
    );
    assert.equal(
      pool.endpoints.find((e) => e.id === "rpc-ok").latest_block,
      76543,
    );
    assert.equal(
      pool.endpoints.find((e) => e.id === "rpc-bad").pool_eligible,
      false,
    );

    const meta = kv.json(KV_HEALTH_META);
    assert.equal(meta.rpc_endpoint_count, 2);
    assert.equal(meta.rpc_eligible_count, 1);
  });
});

describe("summarizeGroup / rollupStatus via per-subnet rollup", () => {
  function buildSurface(id, netuid, kind = "subnet-api") {
    return {
      surface_id: id,
      netuid,
      kind,
      url: `https://${id}.dev`,
      provider: "p",
    };
  }

  test("all-unknown subnet rolls up to unknown with null aggregates", async () => {
    const kv = makeKv();
    await runHealthProber(
      {},
      {},
      {
        now: () => 5000,
        db: makeDb(),
        kv,
        loadSurfaces: async () => [
          buildSurface("u1", 11),
          buildSurface("u2", 11),
        ],
        // Both unknown, no latency, no last_ok.
        probeSurface: async () => ({
          status: "unknown",
          classification: null,
          latency_ms: null,
        }),
        probeOptions: {},
      },
    );
    const current = kv.json(KV_HEALTH_CURRENT);
    const subnet = current.subnets.find((s) => s.netuid === 11);
    assert.equal(subnet.status, "unknown");
    assert.equal(subnet.unknown_count, 2);
    assert.equal(subnet.avg_latency_ms, null);
    // No surface ever went ok → lastOk stays at the 0 epoch sentinel (iso(0)),
    // which is truthy so the `|| null` fallback does not fire.
    assert.equal(subnet.last_ok, new Date(0).toISOString());
    assert.equal(subnet.last_checked, new Date(5000).toISOString());
  });

  test("mixed ok+failed subnet rolls up to degraded with avg latency", async () => {
    const kv = makeKv();
    await runHealthProber(
      {},
      {},
      {
        now: () => 6000,
        db: makeDb(),
        kv,
        loadSurfaces: async () => [
          buildSurface("m-ok", 22),
          buildSurface("m-bad", 22),
        ],
        probeSurface: async (input) =>
          input.id === "m-ok"
            ? { status: "ok", classification: "live", latency_ms: 100 }
            : { status: "failed", classification: "dead", latency_ms: 300 },
        probeOptions: {},
      },
    );
    const current = kv.json(KV_HEALTH_CURRENT);
    const subnet = current.subnets.find((s) => s.netuid === 22);
    // ok>0 with a failure present → degraded.
    assert.equal(subnet.status, "degraded");
    assert.equal(subnet.ok_count, 1);
    assert.equal(subnet.failed_count, 1);
    // Latency is success-only: the failed surface's 300ms is excluded, so the
    // mean is the lone healthy reading (100) — NOT (100+300)/2 — and exactly one
    // sample backed it.
    assert.equal(subnet.avg_latency_ms, 100);
    assert.equal(subnet.latency_sample_count, 1);
    assert.equal(subnet.last_ok, new Date(6000).toISOString());
  });

  test("failures (fast, timed-out, unsafe) never pollute the latency mean", async () => {
    // Regression for issue 4: a fast-fail stored 0ms and a timeout stored its
    // elapsed time, so both leaked into AVG(latency_ms) while a thrown probe's
    // null was excluded — the mean silently blended them. Now every failure is
    // excluded uniformly: the mean is the single healthy 100ms reading.
    const kv = makeKv();
    await runHealthProber(
      {},
      {},
      {
        now: () => 7000,
        db: makeDb(),
        kv,
        loadSurfaces: async () => [
          buildSurface("ok", 55),
          buildSurface("timeout", 55),
          buildSurface("unsafe", 55),
          buildSurface("threw", 55),
        ],
        probeSurface: async (input) =>
          ({
            ok: { status: "ok", classification: "live", latency_ms: 100 },
            timeout: {
              status: "degraded",
              classification: "timeout",
              latency_ms: 8000,
            },
            unsafe: {
              status: "failed",
              classification: "unsafe",
              latency_ms: 0,
            },
            threw: {
              status: "failed",
              classification: "dead",
              latency_ms: null,
            },
          })[input.id],
        probeOptions: {},
      },
    );
    const current = kv.json(KV_HEALTH_CURRENT);
    const subnet = current.subnets.find((s) => s.netuid === 55);
    assert.equal(subnet.avg_latency_ms, 100);
    assert.equal(subnet.latency_sample_count, 1);
    // Stored per-surface latency is null for every non-ok probe.
    const byId = new Map(current.surfaces.map((s) => [s.surface_id, s]));
    assert.equal(byId.get("ok").latency_ms, 100);
    assert.equal(byId.get("timeout").latency_ms, null);
    assert.equal(byId.get("unsafe").latency_ms, null);
    assert.equal(byId.get("threw").latency_ms, null);
  });

  test("all-failed subnet reports a null latency mean and zero latency samples", async () => {
    const kv = makeKv();
    await runHealthProber(
      {},
      {},
      {
        now: () => 7500,
        db: makeDb(),
        kv,
        loadSurfaces: async () => [
          buildSurface("x1", 66),
          buildSurface("x2", 66),
        ],
        probeSurface: async () => ({
          status: "failed",
          classification: "timeout",
          latency_ms: 9000,
        }),
        probeOptions: {},
      },
    );
    const subnet = kv
      .json(KV_HEALTH_CURRENT)
      .subnets.find((s) => s.netuid === 66);
    assert.equal(subnet.avg_latency_ms, null);
    assert.equal(subnet.latency_sample_count, 0);
  });

  test("all-failed subnet rolls up to failed", async () => {
    const kv = makeKv();
    await runHealthProber(
      {},
      {},
      {
        now: () => 8000,
        db: makeDb(),
        kv,
        loadSurfaces: async () => [
          buildSurface("f1", 33),
          buildSurface("f2", 33),
        ],
        probeSurface: async () => ({
          status: "failed",
          classification: "dead",
          latency_ms: null,
        }),
        probeOptions: {},
      },
    );
    const current = kv.json(KV_HEALTH_CURRENT);
    const subnet = current.subnets.find((s) => s.netuid === 33);
    // No ok, no degraded, all failed → failed.
    assert.equal(subnet.status, "failed");
    assert.equal(subnet.failed_count, 2);
  });

  test("all-ok subnet rolls up to ok", async () => {
    const kv = makeKv();
    await runHealthProber(
      {},
      {},
      {
        now: () => 9000,
        db: makeDb(),
        kv,
        loadSurfaces: async () => [buildSurface("g1", 44)],
        probeSurface: async () => ({
          status: "ok",
          classification: "live",
          latency_ms: 50,
        }),
        probeOptions: {},
      },
    );
    const current = kv.json(KV_HEALTH_CURRENT);
    const subnet = current.subnets.find((s) => s.netuid === 44);
    assert.equal(subnet.status, "ok");
  });

  test("degraded-only subnet (no failures) rolls up to degraded", async () => {
    const kv = makeKv();
    await runHealthProber(
      {},
      {},
      {
        now: () => 9500,
        db: makeDb(),
        kv,
        loadSurfaces: async () => [buildSurface("d1", 55)],
        probeSurface: async () => ({
          status: "degraded",
          classification: "slow",
          latency_ms: 900,
        }),
        probeOptions: {},
      },
    );
    const current = kv.json(KV_HEALTH_CURRENT);
    const subnet = current.subnets.find((s) => s.netuid === 55);
    // failed === 0 but degraded > 0 → degraded (not ok).
    assert.equal(subnet.status, "degraded");
    assert.equal(subnet.degraded_count, 1);
  });
});

describe("pruneHealthHistory edge paths", () => {
  test("returns {pruned:false} when db is absent", async () => {
    assert.deepEqual(await pruneHealthHistory({}, { db: null }), {
      pruned: false,
    });
  });

  test("returns {pruned:false} when db lacks .prepare", async () => {
    assert.deepEqual(await pruneHealthHistory({}, { db: {} }), {
      pruned: false,
    });
  });

  test("returns {pruned:true,changes} on success using env binding + default retention", async () => {
    const db = makeDb();
    const result = await pruneHealthHistory(
      { METAGRAPH_HEALTH_DB: db },
      { now: () => 1_000_000_000_000 },
    );
    assert.equal(result.pruned, true);
    assert.equal(result.changes, 7);
    // Default 30-day retention window applied.
    assert.equal(result.cutoff, 1_000_000_000_000 - 30 * 24 * 60 * 60 * 1000);
  });

  test("returns {pruned:false} when prepare/run throws", async () => {
    const db = {
      prepare() {
        throw new Error("prepare exploded");
      },
    };
    assert.deepEqual(await pruneHealthHistory({}, { db }), { pruned: false });
  });

  test("returns null changes when run() yields no meta", async () => {
    const db = {
      prepare: (sql) => ({
        sql,
        bind: () => ({
          async run() {
            return {}; // no .meta
          },
        }),
      }),
    };
    const result = await pruneHealthHistory({}, { now: () => 0, db });
    assert.equal(result.pruned, true);
    assert.equal(result.changes, null);
  });
});

describe("rollupDailyUptime (durable daily history)", () => {
  test("rolls up today + yesterday into surface_uptime_daily", async () => {
    const db = makeDb();
    const fixedNow = Date.UTC(2026, 5, 13, 10, 0, 0); // 2026-06-13T10:00Z
    const result = await rollupDailyUptime(
      { METAGRAPH_HEALTH_DB: db },
      { now: () => fixedNow },
    );
    assert.equal(result.rolled, true);
    assert.deepEqual(result.days, ["2026-06-13", "2026-06-12"]);
    assert.equal(db.calls.batches.length, 1);
    const stmts = db.calls.batches[0];
    assert.equal(stmts.length, 2);
    assert.match(stmts[0].sql, /INSERT INTO surface_uptime_daily/);
    // Latency is rolled up via the shared ok-latency ranking CTE → success-only
    // mean + sample count + p50/p95/p99 stored for long-term tail latency.
    assert.match(stmts[0].sql, /WITH ranked AS/);
    assert.match(stmts[0].sql, /latency_samples/);
    assert.match(stmts[0].sql, /p50_latency_ms/);
    assert.match(stmts[0].sql, /p99_latency_ms/);
    assert.match(stmts[0].sql, /GROUP BY surface_key, netuid/);
    assert.match(
      stmts[0].sql,
      /ON CONFLICT\(surface_key, day\) WHERE surface_key IS NOT NULL/,
    );
    assert.match(stmts[0].sql, /ON CONFLICT\(surface_id, day\) DO UPDATE SET/);
    // binds: [dayStart, dayEnd, day, updated_at] — the CTE's checked_at window
    // binds lead the statement, then `? AS day` / `? AS updated_at`.
    assert.deepEqual(stmts[0].binds, [
      Date.UTC(2026, 5, 13),
      Date.UTC(2026, 5, 14),
      "2026-06-13",
      fixedNow,
    ]);
    assert.equal(stmts[1].binds[2], "2026-06-12");
    assert.equal(stmts[1].binds[0], Date.UTC(2026, 5, 12));
  });

  test("no-ops without a D1 binding", async () => {
    assert.deepEqual(await rollupDailyUptime({}), { rolled: false });
  });

  test("degrades to { rolled: false } when the batch write throws", async () => {
    const db = {
      prepare: () => ({ bind: () => ({}) }),
      async batch() {
        throw new Error("d1 unavailable");
      },
    };
    assert.deepEqual(await rollupDailyUptime({ METAGRAPH_HEALTH_DB: db }), {
      rolled: false,
    });
  });

  test("hourly cron rolls up BEFORE pruning the raw window", async () => {
    const order = [];
    const orderDb = {
      prepare(sql) {
        return {
          sql,
          bind: () => ({
            sql,
            async run() {
              order.push(`run:${sql}`);
              return { meta: { changes: 0 } };
            },
          }),
        };
      },
      async batch(statements) {
        order.push("batch:uptime-rollup");
        return statements.map(() => ({ success: true }));
      },
    };
    await handleScheduled(
      { cron: "0 * * * *" },
      { METAGRAPH_HEALTH_DB: orderDb },
      {},
    );
    const rollupIdx = order.findIndex((o) => o === "batch:uptime-rollup");
    const pruneIdx = order.findIndex((o) =>
      o.includes("DELETE FROM surface_checks"),
    );
    assert.ok(rollupIdx >= 0, "rollup batch must run");
    assert.ok(pruneIdx >= 0, "prune delete must run");
    assert.ok(
      rollupIdx < pruneIdx,
      "daily rollup must run before the raw prune so history is never lost",
    );
  });

  test("hourly cron skips prune when uptime rollup fails", async () => {
    const order = [];
    const orderDb = {
      prepare(sql) {
        return {
          sql,
          bind: () => ({
            sql,
            async run() {
              order.push(`run:${sql}`);
              return { meta: { changes: 0 } };
            },
          }),
        };
      },
      async batch() {
        order.push("batch:uptime-rollup");
        throw new Error("d1 unavailable");
      },
    };
    const result = await handleScheduled(
      { cron: "0 * * * *" },
      { METAGRAPH_HEALTH_DB: orderDb },
      {},
    );
    assert.equal(result.rollup_skipped_prune, true);
    assert.equal(result.uptime_rolled, false);
    assert.equal(result.pruned, false);
    assert.ok(
      !order.some((o) => o.includes("DELETE FROM surface_checks")),
      "raw surface_checks must not be pruned when rollup fails",
    );
  });
});
