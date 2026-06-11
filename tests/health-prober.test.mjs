import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  KV_HEALTH_CURRENT,
  KV_HEALTH_META,
  KV_HEALTH_RPC_POOL,
  loadOperationalSurfaces,
  OPERATIONAL_SURFACES_PATH,
  pruneHealthHistory,
  runHealthProber,
  workerResolvedUrlSafetyGuard,
  workerWebSocketConnector,
} from "../src/health-prober.mjs";
import { handleScheduled } from "../workers/api.mjs";

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
          assert.equal(key, "live/metagraph/operational-surfaces.json");
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
          assert.equal(key, "latest/metagraph/operational-surfaces.json");
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
    // KV write happened despite the D1 batch throwing.
    assert.ok(kv.json(KV_HEALTH_CURRENT));
  });
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
    // Average of 100 and 300.
    assert.equal(subnet.avg_latency_ms, 200);
    assert.equal(subnet.last_ok, new Date(6000).toISOString());
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
