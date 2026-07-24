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
  runHealthProber,
  syncHealthChecksToPostgres,
  syncHealthUptimeRollupToPostgres,
  syncRpcProxyEventsPruneToPostgres,
  workerResolvedUrlSafetyGuard,
  workerWebSocketConnector,
} from "../src/health-prober.ts";
import { handleScheduled } from "../workers/api.ts";
import { mockEnv, type AnyFn, type Row } from "./row-type.ts";

// runHealthProber's second positional parameter (`_ctx: ExecutionContext`) is
// never read at runtime (the leading underscore marks it unused) -- every
// call site below passes this same inert stand-in rather than constructing a
// real Cloudflare ExecutionContext (waitUntil/passThroughOnException/exports/
// tracing) that no test actually exercises.
const FAKE_CTX = {} as unknown as ExecutionContext;

// Many fixtures below still build a `db: makeDb()` (or a standalone `db`)
// entry into runHealthProber's overrides object -- a legacy D1 handle
// pre-dating the D1 -> Postgres migration (see runHealthProber's own header
// comment: D1 is fully eliminated from this function, 2026-07-16).
// RunHealthProberOverrides has no `db` field and the real function never
// reads one, but the fixture shape is left exactly as originally written
// (rather than stripped down) so each test's setup stays intact. This
// Parameters<>-typed cast is the least-invasive way to let the inert `db`
// ride along without fighting the excess-property check on that (unexported)
// overrides interface.
function proberOverrides(o: Row): Parameters<typeof runHealthProber>[2] {
  return o as unknown as Parameters<typeof runHealthProber>[2];
}

describe("workerResolvedUrlSafetyGuard (DNS-aware SSRF)", () => {
  // DoH JSON mock: maps host → { A: [...], AAAA: [...] }.
  const dohFetch = (records: Row) => async (url: string) => {
    const u = new URL(url);
    const name = u.searchParams.get("name");
    const type = u.searchParams.get("type");
    const data = records[name as string]?.[type as string] || [];
    return {
      ok: true,
      async json() {
        return { Answer: data.map((d: Row) => ({ data: d })) };
      },
    };
  };

  test("literal guard still blocks private literals + bad schemes", async () => {
    const guard = workerResolvedUrlSafetyGuard({
      fetchImpl: dohFetch({}) as unknown as typeof fetch,
    });
    assert.equal(await guard("http://10.0.0.1/x"), true);
    assert.equal(await guard("ftp://example.com"), true);
    assert.equal(await guard("not a url"), true);
  });

  test("IP-literal hosts are checked directly without DNS", async () => {
    let called = false;
    const guard = workerResolvedUrlSafetyGuard({
      fetchImpl: (async () => {
        called = true;
        return {
          ok: true,
          async json() {
            return {};
          },
        };
      }) as unknown as typeof fetch,
    });
    // 8.8.8.8 is public, passes the literal guard, and is an IP literal.
    assert.equal(await guard("https://8.8.8.8/x"), false);
    assert.equal(called, false);
  });

  test("blocks a public hostname that resolves to a private IP (rebinding)", async () => {
    const guard = workerResolvedUrlSafetyGuard({
      fetchImpl: dohFetch({
        "evil.example.com": { A: ["10.1.2.3"] },
      }) as unknown as typeof fetch,
    });
    assert.equal(await guard("https://evil.example.com/x"), true);
  });

  test("blocks a private DNS answer when the other RR lookup fails", async () => {
    const guard = workerResolvedUrlSafetyGuard({
      fetchImpl: (async (url: string) => {
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
      }) as unknown as typeof fetch,
    });
    assert.equal(await guard("https://evil.example.com/x"), true);
  });

  test("blocks a private IPv6 AAAA answer", async () => {
    const guard = workerResolvedUrlSafetyGuard({
      fetchImpl: dohFetch({
        "v6.example.com": { AAAA: ["fd00::1"] },
      }) as unknown as typeof fetch,
    });
    assert.equal(await guard("https://v6.example.com/x"), true);
  });

  test("blocks an fec0::/10 site-local AAAA answer (issue #1538)", async () => {
    for (const aaaa of ["fec0::1", "fed0:1:2::3", "feff::1"]) {
      const guard = workerResolvedUrlSafetyGuard({
        fetchImpl: dohFetch({
          "evil.example.com": { AAAA: [aaaa] },
        }) as unknown as typeof fetch,
      });
      assert.equal(await guard("https://evil.example.com/x"), true, aaaa);
    }
  });

  test("blocks an AAAA answer that tunnels a private v4 (mapped/6to4/NAT64)", async () => {
    // A rebinding answer can hide a loopback/link-local target inside an IPv6
    // literal; the guard must decode the embedded v4 and block it.
    for (const aaaa of [
      "::ffff:169.254.169.254", // IPv4-mapped link-local (cloud metadata)
      "::127.0.0.1", // IPv4-compatible loopback
      "2002:7f00:1::", // 6to4 loopback
      "64:ff9b::a00:1", // NAT64 of 10.0.0.1
    ]) {
      const guard = workerResolvedUrlSafetyGuard({
        fetchImpl: dohFetch({
          "evil.example.com": { AAAA: [aaaa] },
        }) as unknown as typeof fetch,
      });
      assert.equal(await guard("https://evil.example.com/x"), true, aaaa);
    }
  });

  test("allows a hostname that resolves to a public IP", async () => {
    const guard = workerResolvedUrlSafetyGuard({
      fetchImpl: dohFetch({
        "ok.example.com": { A: ["93.184.216.34"] },
      }) as unknown as typeof fetch,
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
      fetchImpl: (async () => ({
        ok: false,
        async json() {
          return {};
        },
      })) as unknown as typeof fetch,
    });
    assert.equal(await guard("https://unknown.example.com/x"), false);
  });
});

// --- mocks --------------------------------------------------------------------
function makeDb({ priorStatus = [] as unknown[] } = {}) {
  const calls: Row = { batches: [], runs: [], selects: [] };
  const bound = (sql: string, binds: unknown[]): Row => ({
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
    prepare(sql: string): Row {
      return { sql, bind: (...binds: unknown[]) => bound(sql, binds) };
    },
    async batch(statements: unknown[]) {
      calls.batches.push(statements);
      return statements.map(() => ({ success: true }));
    },
  };
}

// D1 fully eliminated from runHealthProber (2026-07-16): priorStatus now
// reads Postgres via tryPostgresTier(METAGRAPH_HEALTH_SOURCE) against
// /api/v1/internal/health-status-live, and surface_status/surface_checks are
// written only via syncHealthChecksToPostgres's POST to
// /api/v1/internal/health-checks-sync (whose `probed` body is the new
// observation point for consecutive_failures/etc, replacing the old D1
// INSERT-statement inspection).
function makeProberEnv({ priorStatus = [] as unknown[] } = {}) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const posted: any[][] = [];
  return {
    env: mockEnv({
      METAGRAPH_HEALTH_SOURCE: "postgres",
      HEALTH_CHECKS_SYNC_SECRET: "test-secret",
      DATA_API: {
        async fetch(request: Row) {
          const url = new URL(request.url);
          if (url.pathname === "/api/v1/internal/health-status-live") {
            return new Response(JSON.stringify({ rows: priorStatus }), {
              status: 200,
            });
          }
          if (url.pathname === "/api/v1/internal/health-checks-sync") {
            const body = JSON.parse(await request.text());
            posted.push(body.probed);
            return new Response(JSON.stringify({ ok: true }), {
              status: 200,
            });
          }
          return new Response("not found", { status: 404 });
        },
      },
    }),
    posted,
  };
}

function makeKv() {
  const store = new Map<string, string>();
  return {
    store,
    async put(key: string, value: string) {
      store.set(key, value);
    },
    async get(key: string) {
      return store.has(key) ? store.get(key) : null;
    },
    json(key: string) {
      const raw = store.get(key);
      return raw ? JSON.parse(raw) : null;
    },
  } as unknown as KVNamespace & {
    store: Map<string, string>;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    json: (key: string) => any;
  };
}

// A fake Worker-style client WebSocket. Listeners are captured so a test can
// drive message/error/close events deterministically after send() runs.
function makeFakeWebSocket() {
  const listeners: Row = { message: [], error: [], close: [] };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sent: any[] = [];
  return {
    sent,
    listeners,
    accepted: false,
    closed: false,
    accept() {
      this.accepted = true;
    },
    addEventListener(type: string, fn: AnyFn) {
      (listeners[type] ||= []).push(fn);
    },
    send(payload: unknown) {
      sent.push(payload);
    },
    close() {
      this.closed = true;
    },
    emit(type: string, event: Row) {
      for (const fn of listeners[type] || []) fn(event);
    },
  };
}

// A fetchImpl that hands back the given webSocket (or rejects/omits it) and
// records the URL it was called with so the ws:→http: rewrite is checkable.
type MakeFetchImplOptions = {
  webSocket?: unknown;
  reject?: unknown;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  calls?: any[];
};
function makeFetchImpl({
  webSocket,
  reject,
  calls = [],
}: MakeFetchImplOptions = {}): typeof fetch {
  return ((url: string, init: Row) => {
    calls.push({ url, init });
    if (reject) return Promise.reject(reject);
    return Promise.resolve({ webSocket });
  }) as unknown as typeof fetch;
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

const probeImpl = async (input: Row) =>
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
  test("posts the probed batch to Postgres + writes the three KV snapshots with correct shapes", async () => {
    const { env, posted } = makeProberEnv({
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
    const result = await runHealthProber(env, FAKE_CTX, {
      now: () => 50000,
      kv,
      loadSurfaces: async () => SURFACES,
      probeSurface: probeImpl,
      probeOptions: {},
    });

    assert.equal(result.ok, true);
    assert.equal(result.probed, 2);
    assert.deepEqual(result.counts, {
      ok: 1,
      degraded: 0,
      failed: 1,
      unknown: 0,
    });

    // syncHealthChecksToPostgres posts the full probed batch once -- the sole
    // writer now for both surface_checks and surface_status (D1 fully
    // eliminated, 2026-07-16, see runHealthProber's own header comment).
    assert.equal(posted.length, 1);
    assert.equal(posted[0].length, 2);
    const postedApiRow = posted[0].find((r) => r.surface_id === "sn7-api");
    // #1005: the stable surface_key rides every posted row so Postgres history
    // re-keys onto the rename-stable identity, not the display id/slug.
    assert.equal(postedApiRow.surface_key, "srf-sn7apikey000000");

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
      current.subnets.map((s: Row) => s.netuid),
      [0, 7],
    );
    assert.equal(current.subnets.find((s: Row) => s.netuid === 0).status, "ok");
    assert.equal(
      current.subnets.find((s: Row) => s.netuid === 7).status,
      "failed",
    );

    // last_ok continuity: the failed surface keeps its prior last_ok (1000).
    const apiRow = current.surfaces.find(
      (s: Row) => s.surface_id === "sn7-api",
    );
    assert.equal(apiRow.last_ok, new Date(1000).toISOString());
    // The ok RPC surface stamps last_ok = run time.
    const rpcRow = current.surfaces.find(
      (s: Row) => s.surface_id === "opentensor-finney-rpc",
    );
    assert.equal(rpcRow.last_ok, new Date(50000).toISOString());
  });

  test("an out-of-range prior last_ok coerces to null instead of throwing a RangeError", async () => {
    // A corrupt/out-of-range epoch (e.g. 1e100) carried on a prior last_ok would make
    // new Date(ms).toISOString() throw, tearing down the run. It must coerce to null.
    const { env } = makeProberEnv({
      priorStatus: [
        {
          surface_id: "sn7-api-old",
          surface_key: "srf-sn7apikey000000",
          last_ok: 1e100,
          consecutive_failures: 2,
        },
      ],
    });
    const kv = makeKv();
    const result = await runHealthProber(env, FAKE_CTX, {
      now: () => 50000,
      kv,
      loadSurfaces: async () => SURFACES,
      probeSurface: probeImpl,
      probeOptions: {},
    });
    assert.equal(result.ok, true);
    const current = kv.json(KV_HEALTH_CURRENT);
    // sn7-api probes failed, so it keeps its (out-of-range) prior last_ok -> null.
    const apiRow = current.surfaces.find(
      (s: Row) => s.surface_id === "sn7-api",
    );
    assert.equal(apiRow.last_ok, null);

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

  test("folds unrecognized probe status into unknown in global status_counts", async () => {
    const kv = makeKv();
    const { env } = makeProberEnv();
    const result = await runHealthProber(env, FAKE_CTX, {
      now: () => 60000,
      kv,
      loadSurfaces: async () => [SURFACES[0]],
      probeSurface: async () => ({
        status: "throttled",
        classification: "rate-limited",
        latency_ms: 120,
        status_code: 429,
      }),
      probeOptions: {},
    });
    assert.deepEqual(result.counts, {
      ok: 0,
      degraded: 0,
      failed: 0,
      unknown: 1,
    });
    const current = kv.json(KV_HEALTH_CURRENT);
    assert.deepEqual(current.summary.status_counts, {
      ok: 0,
      degraded: 0,
      failed: 0,
      unknown: 1,
    });
    const meta = kv.json(KV_HEALTH_META);
    assert.deepEqual(meta.status_counts, {
      ok: 0,
      degraded: 0,
      failed: 0,
      unknown: 1,
    });
    assert.equal(current.summary.status_counts.throttled, undefined);
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
    const { env } = makeProberEnv();
    await runHealthProber(env, FAKE_CTX, {
      now: () => 50000,
      kv,
      loadSurfaces: async () => rpcSurfaces,
      probeSurface: async (input: Row) => ({
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
    });

    const byId = new Map<string, Row>(
      kv
        .json(KV_HEALTH_RPC_POOL)
        .endpoints.map((endpoint: Row): [string, Row] => [
          endpoint.id,
          endpoint,
        ]),
    );
    assert.equal(byId.get("honest-rpc")!.latest_block, 8_400_000);
    assert.equal(byId.get("forged-rpc")!.latest_block, null);
    assert.equal(byId.get("unsafe-rpc")!.latest_block, null);
  });

  test("bumps consecutive_failures from prior state for the breaker", async () => {
    const { env, posted } = makeProberEnv({
      priorStatus: [
        {
          surface_id: "sn7-api-before-rename",
          surface_key: "srf-sn7apikey000000",
          last_ok: 1000,
          consecutive_failures: 2,
        },
      ],
    });
    await runHealthProber(env, FAKE_CTX, {
      now: () => 50000,
      kv: makeKv(),
      loadSurfaces: async () => SURFACES,
      probeSurface: probeImpl,
      probeOptions: {},
    });
    // The failed surface's posted row carries consecutive_failures = 3, and
    // the stable surface_key rides alongside it (#1005) so Postgres history
    // re-keys onto the rename-stable identity, not the display id/slug.
    const apiRow = posted[0].find((r) => r.surface_id === "sn7-api");
    assert.equal(apiRow.surface_key, "srf-sn7apikey000000");
    assert.equal(apiRow.consecutive_failures, 3);
  });

  test("a degraded non-RPC run resets the breaker", async () => {
    const { env, posted } = makeProberEnv({
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
    const degradedProbe = async (input: Row) =>
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
    await runHealthProber(env, FAKE_CTX, {
      now: () => 50000,
      kv: makeKv(),
      loadSurfaces: async () => SURFACES,
      probeSurface: degradedProbe,
      probeOptions: {},
    });
    const apiRow = posted[0].find((r) => r.surface_id === "sn7-api");
    // A degraded run must NOT bump 2 -> 3; it resets to 0 so a persistently-
    // degraded (still-usable) endpoint is not evicted from the RPC pool by
    // the sustained-down breaker.
    assert.equal(apiRow.consecutive_failures, 0);
  });

  test("a degraded RPC run accrues toward pool eviction", async () => {
    const { env, posted } = makeProberEnv({
      priorStatus: [
        {
          surface_id: "opentensor-finney-rpc",
          surface_key: "srf-rootrpckey00000",
          last_ok: 1000,
          consecutive_failures: 2,
        },
      ],
    });
    const degradedRpcProbe = async (input: Row) =>
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

    await runHealthProber(env, FAKE_CTX, {
      now: () => 50000,
      kv: makeKv(),
      loadSurfaces: async () => SURFACES,
      probeSurface: degradedRpcProbe,
      probeOptions: {},
    });

    const rpcRow = posted[0].find(
      (r) => r.surface_id === "opentensor-finney-rpc",
    );
    assert.equal(rpcRow.consecutive_failures, 3);
  });

  test("a degraded subtensor-wss run accrues toward pool eviction", async () => {
    // Regression for #2072: subtensor-wss is base-layer RPC (proxy-routable,
    // pooled) exactly like subtensor-rpc, so a persistently-degraded WSS endpoint
    // must accrue toward the sustained-down breaker. Before the fix the breaker
    // matched only subtensor-rpc, so a degraded WSS run reset the streak to 0 and
    // the endpoint stayed pool_eligible forever.
    const wssSurface = {
      surface_id: "opentensor-finney-wss",
      surface_key: "srf-rootwsskey00000",
      netuid: 0,
      kind: "subtensor-wss",
      url: "wss://entrypoint-finney.opentensor.ai",
      provider: "opentensor",
      authority: "official",
      auth_required: false,
      public_safe: true,
      subnet_slug: "root",
      subnet_name: "root",
      probe: { method: "JSON-RPC", expect: "json" },
    };
    const { env, posted } = makeProberEnv({
      priorStatus: [
        {
          surface_id: "opentensor-finney-wss",
          surface_key: "srf-rootwsskey00000",
          last_ok: 1000,
          consecutive_failures: 2,
        },
      ],
    });
    // The WSS endpoint probes `degraded` (e.g. rate-limited), not failed.
    const degradedWssProbe = async () => ({
      status: "degraded",
      classification: "rate-limited",
      latency_ms: null,
      status_code: 429,
    });

    await runHealthProber(env, FAKE_CTX, {
      now: () => 50000,
      kv: makeKv(),
      loadSurfaces: async () => [wssSurface],
      probeSurface: degradedWssProbe,
      probeOptions: {},
    });

    const wssRow = posted[0].find(
      (r) => r.surface_id === "opentensor-finney-wss",
    );
    // A degraded base-layer WSS run must bump 2 -> 3 so the sustained-down
    // breaker can eventually evict it.
    assert.equal(wssRow.consecutive_failures, 3);
  });

  test("no-ops cleanly when there are no operational surfaces", async () => {
    const { env } = makeProberEnv();
    const result = await runHealthProber(env, FAKE_CTX, {
      now: () => 1,
      kv: makeKv(),
      loadSurfaces: async () => [],
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "no-operational-surfaces");
  });
});

// D1 fully eliminated from pruneHealthHistory (2026-07-16): both D1 DELETEs
// (surface_checks and the earlier-retired rpc_proxy_events) are gone --
// syncRpcProxyEventsPruneToPostgres (exercised in its own describe blocks
// below) is the sole remaining work, since the D1 INSERTs those prunes used
// to clean up after are retired too. See pruneHealthHistory edge paths
// below for its now-simple contract.

describe("handleScheduled dispatch", () => {
  test("hourly cron prunes; other crons probe", async () => {
    const db = makeDb();
    const pruneResult = (await handleScheduled(
      { cron: "0 * * * *" } as unknown as ScheduledController,
      {
        METAGRAPH_HEALTH_DB: db,
        // rollupDailyUptime must succeed (Postgres sync ok) for the prune to
        // run at all -- see "hourly cron skips prune when the Postgres
        // rollup sync fails" above.
        DATA_API: { fetch: async () => new Response("{}", { status: 200 }) },
        HEALTH_CHECKS_SYNC_SECRET: "test-secret",
      } as unknown as Env,
    )) as Row;
    assert.equal(pruneResult.pruned, true);

    // The 2-minute cron path runs the prober; with an empty env it no-ops.
    const probeResult = (await handleScheduled(
      { cron: "*/2 * * * *" } as unknown as ScheduledController,
      {} as unknown as Env,
    )) as Row;
    assert.equal(probeResult.ok, false);
    assert.equal(probeResult.reason, "no-operational-surfaces");
  });

  // The three EVENTS_LOAD_CRON ("*/3 * * * *") tests that lived here (the
  // non-fast-load-crons-never-drain invariant, the fast-load drain regression,
  // and the drain-failure isolation test) are retired along with the trigger
  // itself: loadStagedAccountIdentity (the last staged-R2-to-D1 loader) and
  // workers/request-handlers/staging.mjs are deleted now that
  // refresh-account-identity syncs straight to Postgres from the indexer-box
  // cron pipeline. Nothing left to dispatch on that cron string.
});

describe("workerWebSocketConnector", () => {
  test("rewrites ws:→http:, accepts, sends every call, resolves on all replies", async () => {
    const socket = makeFakeWebSocket();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const calls: any[] = [];
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
    assert.equal(results.get("a")!.ok, true);
    assert.deepEqual(results.get("a")!.result, { number: "0x1" });
    assert.equal(results.get("b")!.ok, false);
    assert.deepEqual(results.get("b")!.rpc_error, {
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
    assert.equal(results.get("a")!.result, 9);
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
      const e = err as Row;
      assert.equal(e.name, "TimeoutError");
      assert.match(e.message, /WSS RPC probe timed out/);
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
    assert.equal(results.get("a")!.result, 1);
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
    let requested: string | null = null;
    const env = mockEnv({
      ASSETS: {
        fetch: async (req: Row) => {
          requested = req.url;
          return { ok: true, json: async () => surfacesBody };
        },
      },
    });
    const surfaces = await loadOperationalSurfaces(env);
    assert.deepEqual(surfaces, surfacesBody.surfaces);
    assert.match(
      requested as unknown as string,
      new RegExp(OPERATIONAL_SURFACES_PATH),
    );
  });

  test("falls back to R2 when ASSETS.fetch throws", async () => {
    const env = mockEnv({
      ASSETS: {
        fetch: async () => {
          throw new Error("assets down");
        },
      },
      METAGRAPH_R2_LATEST_PREFIX: "live/",
      METAGRAPH_ARCHIVE: {
        get: async (key: string) => {
          assert.equal(key, "live/operational-surfaces.json");
          return { text: async () => JSON.stringify(surfacesBody) };
        },
      },
    });
    const surfaces = await loadOperationalSurfaces(env);
    assert.deepEqual(surfaces, surfacesBody.surfaces);
  });

  test("falls back to R2 with the default prefix when none is configured", async () => {
    const env = mockEnv({
      METAGRAPH_ARCHIVE: {
        get: async (key: string) => {
          assert.equal(key, "latest/operational-surfaces.json");
          return { text: async () => JSON.stringify(surfacesBody) };
        },
      },
    });
    const surfaces = await loadOperationalSurfaces(env);
    assert.deepEqual(surfaces, surfacesBody.surfaces);
  });

  test("returns [] when ASSETS responds non-ok and there is no R2", async () => {
    const env = mockEnv({ ASSETS: { fetch: async () => ({ ok: false }) } });
    assert.deepEqual(await loadOperationalSurfaces(env), []);
  });

  test("returns [] when the ASSETS body has no surfaces array", async () => {
    const env = mockEnv({
      ASSETS: { fetch: async () => ({ ok: true, json: async () => ({}) }) },
    });
    assert.deepEqual(await loadOperationalSurfaces(env), []);
  });

  test("returns [] when R2 returns a null object", async () => {
    const env = mockEnv({ METAGRAPH_ARCHIVE: { get: async () => null } });
    assert.deepEqual(await loadOperationalSurfaces(env), []);
  });

  test("returns [] when R2 .text() yields a body without a surfaces array", async () => {
    const env = mockEnv({
      METAGRAPH_ARCHIVE: {
        get: async () => ({ text: async () => JSON.stringify({ nope: 1 }) }),
      },
    });
    assert.deepEqual(await loadOperationalSurfaces(env), []);
  });

  test("returns [] when both ASSETS and R2 throw", async () => {
    const env = mockEnv({
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
    });
    assert.deepEqual(await loadOperationalSurfaces(env), []);
  });

  test("returns [] for an empty env (no bindings present)", async () => {
    assert.deepEqual(await loadOperationalSurfaces(mockEnv()), []);
  });
});

describe("runHealthProber edge paths", () => {
  test("uses the real workerWebSocketConnector path when no probeOptions are given", async () => {
    // Drive the default probeOptions branch: probeSurface still injected so no
    // real network is hit, but probeOptions falls through to the connector.
    const result = await runHealthProber(
      mockEnv(),
      FAKE_CTX,
      proberOverrides({
        now: () => 50000,
        db: makeDb(),
        kv: makeKv(),
        loadSurfaces: async () => SURFACES,
        probeSurface: probeImpl,
        // probeOptions intentionally omitted → exercises the default branch.
      }),
    );
    assert.equal(result.ok, true);
    assert.equal(result.probed, 2);
  });

  test("catches a probe that throws → failed/unsupported row", async () => {
    const kv = makeKv();
    const result = await runHealthProber(
      mockEnv(),
      FAKE_CTX,
      proberOverrides({
        now: () => 7000,
        db: makeDb(),
        kv,
        loadSurfaces: async () => [SURFACES[0]],
        probeSurface: async () => {
          throw new Error("kaboom");
        },
        probeOptions: {},
      }),
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
    const result = (await runHealthProber(
      mockEnv(),
      FAKE_CTX,
      proberOverrides({
        now: () => 7000,
        db: makeDb(),
        kv: makeKv(),
        loadSurfaces: async () => [SURFACES[0]],
        // Throw a non-Error so error?.message is undefined.
        probeSurface: async () => {
          throw "string failure";
        },
        probeOptions: {},
      }),
    )) as Row;
    assert.equal(result.counts.failed, 1);
  });

  test("catches a throwing priorStatus SELECT and treats all as cold", async () => {
    const db = makeDb();
    // Make the prior-status SELECT blow up; the run should still complete.
    db.prepare = (sql: string) => ({
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
      mockEnv(),
      FAKE_CTX,
      proberOverrides({
        now: () => 9000,
        db,
        kv,
        loadSurfaces: async () => SURFACES,
        probeSurface: probeImpl,
        probeOptions: {},
      }),
    );
    assert.equal(result.ok, true);
    // With no prior state, the failed surface starts its breaker at 1.
    const current = kv.json(KV_HEALTH_CURRENT);
    assert.equal(current.surfaces.length, 2);
  });

  test("runs with no Postgres tier configured (KV-only) and kv absent (Postgres-only)", async () => {
    // No METAGRAPH_HEALTH_SOURCE/DATA_API → priorStatus reads nothing, sync
    // no-ops; KV still written.
    const kv = makeKv();
    const kvOnly = await runHealthProber(
      mockEnv(),
      FAKE_CTX,
      proberOverrides({
        now: () => 1,
        kv,
        loadSurfaces: async () => SURFACES,
        probeSurface: probeImpl,
        probeOptions: {},
      }),
    );
    assert.equal(kvOnly.ok, true);
    assert.ok(kv.json(KV_HEALTH_CURRENT));

    // kv absent → persistToKv no-ops; the Postgres sync still fires.
    const { env, posted } = makeProberEnv();
    const postgresOnly = await runHealthProber(
      env,
      FAKE_CTX,
      proberOverrides({
        now: () => 1,
        kv: null,
        loadSurfaces: async () => SURFACES,
        probeSurface: probeImpl,
        probeOptions: {},
      }),
    );
    assert.equal(postgresOnly.ok, true);
    assert.equal(posted.length, 1);
  });

  test("handles a SELECT with no results key and a surface without a provider", async () => {
    // db.prepare(...).all() returns an object without a `results` key →
    // exercises the `results || []` fallback in the prior-status loop. The
    // surface has no provider → exercises the `surface.provider || null` branch.
    const db = makeDb();
    db.prepare = (sql: string) => ({
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
      mockEnv(),
      FAKE_CTX,
      proberOverrides({
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
      }),
    );
    assert.equal(result.ok, true);
    const current = kv.json(KV_HEALTH_CURRENT);
    assert.equal(current.surfaces[0].provider, null);
  });

  test("respects a custom concurrency override", async () => {
    const result = await runHealthProber(
      mockEnv(),
      FAKE_CTX,
      proberOverrides({
        now: () => 1,
        db: makeDb(),
        kv: makeKv(),
        loadSurfaces: async () => SURFACES,
        probeSurface: probeImpl,
        probeOptions: {},
        concurrency: 1,
      }),
    );
    assert.equal(result.probed, 2);
  });
});

// #4832 gap-closure: syncHealthChecksToPostgres is a private helper (unlike
// syncSubnetIdentityToPostgres, which lives in its own module and is tested
// directly in tests/subnet-identity-history.test.mjs) -- exercised the same
// way persistToKv above is, indirectly through runHealthProber. It is the
// sole writer for surface_checks/surface_status now (D1 fully eliminated,
// 2026-07-16); these tests prove a sync failure never affects
// runHealthProber's own `ok` result -- KV stays the source of truth for live
// serving either way.
describe("syncHealthChecksToPostgres", () => {
  // runHealthProber never calls this with an empty array (it short-circuits
  // on zero operational surfaces before ever reaching persist/sync), so this
  // guard is only reachable via a direct call, unlike the other tests below.
  test("returns no_rows for an empty or non-array probed batch", async () => {
    const env = mockEnv({
      DATA_API: { fetch: async () => new Response("{}") },
      HEALTH_CHECKS_SYNC_SECRET: "test-secret",
    });
    assert.deepEqual(await syncHealthChecksToPostgres(env, []), {
      synced: false,
      reason: "no_rows",
    });
    assert.deepEqual(
      await syncHealthChecksToPostgres(env, undefined as unknown as Row[]),
      {
        synced: false,
        reason: "no_rows",
      },
    );
  });
});

describe("syncHealthChecksToPostgres via runHealthProber", () => {
  test("no-ops (no DATA_API call) when DATA_API is not bound", async () => {
    const called = false;
    const result = await runHealthProber(
      mockEnv(),
      FAKE_CTX,
      proberOverrides({
        now: () => 1,
        db: makeDb(),
        kv: makeKv(),
        loadSurfaces: async () => SURFACES,
        probeSurface: probeImpl,
        probeOptions: {},
      }),
    );
    assert.equal(result.ok, true);
    assert.equal(called, false);
  });

  test("no-ops (no DATA_API call) when HEALTH_CHECKS_SYNC_SECRET is not configured", async () => {
    let called = false;
    const result = await runHealthProber(
      mockEnv({
        DATA_API: { fetch: async () => ((called = true), new Response("{}")) },
      }),
      FAKE_CTX,
      proberOverrides({
        now: () => 1,
        db: makeDb(),
        kv: makeKv(),
        loadSurfaces: async () => SURFACES,
        probeSurface: probeImpl,
        probeOptions: {},
      }),
    );
    assert.equal(result.ok, true);
    assert.equal(called, false);
  });

  test("posts the probed batch to health-checks-sync with the token header", async () => {
    let request: Row | undefined;
    const env = mockEnv({
      DATA_API: {
        fetch: async (req: Row) => {
          request = req;
          return new Response("{}", { status: 200 });
        },
      },
      HEALTH_CHECKS_SYNC_SECRET: "test-secret",
    });
    const result = await runHealthProber(
      env,
      FAKE_CTX,
      proberOverrides({
        now: () => 1,
        db: makeDb(),
        kv: makeKv(),
        loadSurfaces: async () => SURFACES,
        probeSurface: probeImpl,
        probeOptions: {},
      }),
    );
    assert.equal(result.ok, true);
    assert.ok(request);
    assert.equal(request.method, "POST");
    assert.equal(
      request.headers.get("x-health-checks-sync-token"),
      "test-secret",
    );
    const body = await request.json();
    assert.ok(Array.isArray(body.probed));
    assert.equal(body.probed.length, SURFACES.length);
  });

  test("a DATA_API failure never affects runHealthProber's own result", async () => {
    const env = mockEnv({
      DATA_API: {
        fetch: async () => {
          throw new Error("boom");
        },
      },
      HEALTH_CHECKS_SYNC_SECRET: "test-secret",
    });
    const result = await runHealthProber(
      env,
      FAKE_CTX,
      proberOverrides({
        now: () => 1,
        kv: makeKv(),
        loadSurfaces: async () => SURFACES,
        probeSurface: probeImpl,
        probeOptions: {},
      }),
    );
    assert.equal(result.ok, true);
  });

  test("a non-2xx DATA_API response never affects runHealthProber's own result", async () => {
    const env = mockEnv({
      DATA_API: {
        fetch: async () => new Response("nope", { status: 502 }),
      },
      HEALTH_CHECKS_SYNC_SECRET: "test-secret",
    });
    const result = await runHealthProber(
      env,
      FAKE_CTX,
      proberOverrides({
        now: () => 1,
        db: makeDb(),
        kv: makeKv(),
        loadSurfaces: async () => SURFACES,
        probeSurface: probeImpl,
        probeOptions: {},
      }),
    );
    assert.equal(result.ok, true);
  });
});

describe("persistToKv via runHealthProber", () => {
  test("no-ops when kv has no .put", async () => {
    const { env, posted } = makeProberEnv();
    // kv truthy but missing .put → persistToKv returns early.
    const result = await runHealthProber(
      env,
      FAKE_CTX,
      proberOverrides({
        now: () => 1,
        kv: { get: async () => null },
        loadSurfaces: async () => SURFACES,
        probeSurface: probeImpl,
        probeOptions: {},
      }),
    );
    assert.equal(result.ok, true);
    // The Postgres sync still fires.
    assert.equal(posted.length, 1);
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
    const probe = async (input: Row) =>
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
      mockEnv(),
      FAKE_CTX,
      proberOverrides({
        now: () => 2000,
        db: makeDb(),
        kv,
        loadSurfaces: async () => surfaces,
        probeSurface: probe,
        probeOptions: {},
      }),
    );
    const pool = kv.json(KV_HEALTH_RPC_POOL);
    // Only the two RPC-kind surfaces, sorted by id (rpc-bad < rpc-ok).
    assert.equal(pool.endpoint_count, 2);
    assert.equal(pool.eligible_count, 1);
    assert.deepEqual(
      pool.endpoints.map((e: Row) => e.id),
      ["rpc-bad", "rpc-ok"],
    );
    assert.equal(
      pool.endpoints.find((e: Row) => e.id === "rpc-ok").pool_eligible,
      true,
    );
    assert.equal(
      pool.endpoints.find((e: Row) => e.id === "rpc-ok").latest_block,
      76543,
    );
    assert.equal(
      pool.endpoints.find((e: Row) => e.id === "rpc-bad").pool_eligible,
      false,
    );

    const meta = kv.json(KV_HEALTH_META);
    assert.equal(meta.rpc_endpoint_count, 2);
    assert.equal(meta.rpc_eligible_count, 1);
  });
});

describe("summarizeGroup / rollupStatus via per-subnet rollup", () => {
  function buildSurface(id: string, netuid: number, kind = "subnet-api") {
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
      mockEnv(),
      FAKE_CTX,
      proberOverrides({
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
      }),
    );
    const current = kv.json(KV_HEALTH_CURRENT);
    const subnet = current.subnets.find((s: Row) => s.netuid === 11);
    assert.equal(subnet.status, "unknown");
    assert.equal(subnet.unknown_count, 2);
    assert.equal(subnet.avg_latency_ms, null);
    // No surface ever went ok → last_ok is null ("never"), not the 1970 epoch.
    // (iso(0) is the truthy string "1970-01-01T00:00:00.000Z", so the old
    // `iso(lastOk) || null` reported a fabricated last-healthy timestamp here.)
    assert.equal(subnet.last_ok, null);
    assert.equal(subnet.last_checked, new Date(5000).toISOString());
  });

  test("a zero checked-at timestamp reports last_checked null, not the epoch", async () => {
    // Same 0-sentinel guard as last_ok, on the last_checked field: with the
    // clock at the Unix epoch every row's checked_at_ms is 0, so lastChecked
    // stays 0. `iso(0)` is the truthy "1970-01-01T00:00:00.000Z", so the field
    // must be guarded (`lastChecked ? iso(lastChecked) : null`) to report null.
    const kv = makeKv();
    await runHealthProber(
      mockEnv(),
      FAKE_CTX,
      proberOverrides({
        now: () => 0,
        db: makeDb(),
        kv,
        loadSurfaces: async () => [buildSurface("z1", 13)],
        probeSurface: async () => ({
          status: "unknown",
          classification: null,
          latency_ms: null,
        }),
        probeOptions: {},
      }),
    );
    const subnet = kv
      .json(KV_HEALTH_CURRENT)
      .subnets.find((s: Row) => s.netuid === 13);
    assert.equal(subnet.last_checked, null);
    assert.equal(subnet.last_ok, null);
  });

  test("mixed ok+failed subnet rolls up to degraded with avg latency", async () => {
    const kv = makeKv();
    await runHealthProber(
      mockEnv(),
      FAKE_CTX,
      proberOverrides({
        now: () => 6000,
        db: makeDb(),
        kv,
        loadSurfaces: async () => [
          buildSurface("m-ok", 22),
          buildSurface("m-bad", 22),
        ],
        probeSurface: async (input: Row) =>
          input.id === "m-ok"
            ? { status: "ok", classification: "live", latency_ms: 100 }
            : { status: "failed", classification: "dead", latency_ms: 300 },
        probeOptions: {},
      }),
    );
    const current = kv.json(KV_HEALTH_CURRENT);
    const subnet = current.subnets.find((s: Row) => s.netuid === 22);
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
      mockEnv(),
      FAKE_CTX,
      proberOverrides({
        now: () => 7000,
        db: makeDb(),
        kv,
        loadSurfaces: async () => [
          buildSurface("ok", 55),
          buildSurface("timeout", 55),
          buildSurface("unsafe", 55),
          buildSurface("threw", 55),
        ],
        probeSurface: async (input: Row) =>
          (
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
            }) as Row
          )[input.id],
        probeOptions: {},
      }),
    );
    const current = kv.json(KV_HEALTH_CURRENT);
    const subnet = current.subnets.find((s: Row) => s.netuid === 55);
    assert.equal(subnet.avg_latency_ms, 100);
    assert.equal(subnet.latency_sample_count, 1);
    // Stored per-surface latency is null for every non-ok probe.
    const byId = new Map<string, Row>(
      current.surfaces.map((s: Row): [string, Row] => [s.surface_id, s]),
    );
    assert.equal(byId.get("ok")!.latency_ms, 100);
    assert.equal(byId.get("timeout")!.latency_ms, null);
    assert.equal(byId.get("unsafe")!.latency_ms, null);
    assert.equal(byId.get("threw")!.latency_ms, null);
  });

  test("all-failed subnet reports a null latency mean and zero latency samples", async () => {
    const kv = makeKv();
    await runHealthProber(
      mockEnv(),
      FAKE_CTX,
      proberOverrides({
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
      }),
    );
    const subnet = kv
      .json(KV_HEALTH_CURRENT)
      .subnets.find((s: Row) => s.netuid === 66);
    assert.equal(subnet.avg_latency_ms, null);
    assert.equal(subnet.latency_sample_count, 0);
  });

  test("all-failed subnet rolls up to failed", async () => {
    const kv = makeKv();
    await runHealthProber(
      mockEnv(),
      FAKE_CTX,
      proberOverrides({
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
      }),
    );
    const current = kv.json(KV_HEALTH_CURRENT);
    const subnet = current.subnets.find((s: Row) => s.netuid === 33);
    // No ok, no degraded, all failed → failed.
    assert.equal(subnet.status, "failed");
    assert.equal(subnet.failed_count, 2);
  });

  test("all-ok subnet rolls up to ok", async () => {
    const kv = makeKv();
    await runHealthProber(
      mockEnv(),
      FAKE_CTX,
      proberOverrides({
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
      }),
    );
    const current = kv.json(KV_HEALTH_CURRENT);
    const subnet = current.subnets.find((s: Row) => s.netuid === 44);
    assert.equal(subnet.status, "ok");
  });

  test("degraded-only subnet (no failures) rolls up to degraded", async () => {
    const kv = makeKv();
    await runHealthProber(
      mockEnv(),
      FAKE_CTX,
      proberOverrides({
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
      }),
    );
    const current = kv.json(KV_HEALTH_CURRENT);
    const subnet = current.subnets.find((s: Row) => s.netuid === 55);
    // failed === 0 but degraded > 0 → degraded (not ok).
    assert.equal(subnet.status, "degraded");
    assert.equal(subnet.degraded_count, 1);
  });

  test("notifies SubnetStatusHub only when a subnet status fingerprint changes (#6034)", async () => {
    const surfaces = [buildSurface("chg", 77)];
    const kv = makeKv();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const notifyCalls: any[] = [];
    const env = mockEnv({
      SUBNET_STATUS_HUB: {
        idFromName: (name: string) => name,
        get: () => ({
          fetch: async (url: unknown, init: Row) => {
            notifyCalls.push({
              url,
              body: JSON.parse(init.body),
            });
            return new Response(JSON.stringify({ ok: true }), { status: 200 });
          },
        }),
      },
    });
    // First run: cold prior → notify for the probed netuid.
    await runHealthProber(
      env,
      FAKE_CTX,
      proberOverrides({
        now: () => 10_000,
        db: makeDb(),
        kv,
        loadSurfaces: async () => surfaces,
        probeSurface: async () => ({
          status: "ok",
          classification: "live",
          latency_ms: 12,
        }),
        probeOptions: {},
      }),
    );
    assert.equal(notifyCalls.length, 1);
    assert.deepEqual(notifyCalls[0].body.netuids, [77]);

    // Second run: identical status → no notify.
    notifyCalls.length = 0;
    await runHealthProber(
      env,
      FAKE_CTX,
      proberOverrides({
        now: () => 20_000,
        db: makeDb(),
        kv,
        loadSurfaces: async () => surfaces,
        probeSurface: async () => ({
          status: "ok",
          classification: "live",
          latency_ms: 12,
        }),
        probeOptions: {},
      }),
    );
    assert.equal(notifyCalls.length, 0);

    // Third run: status flips → notify.
    await runHealthProber(
      env,
      FAKE_CTX,
      proberOverrides({
        now: () => 30_000,
        db: makeDb(),
        kv,
        loadSurfaces: async () => surfaces,
        probeSurface: async () => ({
          status: "failed",
          classification: "dead",
          latency_ms: null,
        }),
        probeOptions: {},
      }),
    );
    assert.equal(notifyCalls.length, 1);
    assert.deepEqual(notifyCalls[0].body.netuids, [77]);
  });
});

// D1 fully eliminated from pruneHealthHistory (2026-07-16): it no longer
// takes a `db` at all, and its sole remaining call (syncRpcProxyEventsPrune
// ToPostgres) already catches every failure internally and never rejects
// -- so pruneHealthHistory always resolves {pruned: true, cutoff}, whatever
// env/overrides it's given. The Postgres-sync-fires-or-degrades behavior is
// exercised directly in the syncRpcProxyEventsPruneToPostgres describe
// blocks below.
describe("pruneHealthHistory edge paths", () => {
  test("always resolves {pruned:true, cutoff}, with no env/DATA_API configured", async () => {
    const result = await pruneHealthHistory(mockEnv(), {
      now: () => 1_000_000_000_000,
    });
    assert.equal(result.pruned, true);
    // Default 30-day retention window applied.
    assert.equal(result.cutoff, 1_000_000_000_000 - 30 * 24 * 60 * 60 * 1000);
  });

  test("applies a custom retentionMs override", async () => {
    const result = await pruneHealthHistory(mockEnv(), {
      now: () => 100_000_000,
      retentionMs: 1000,
    });
    assert.equal(result.pruned, true);
    assert.equal(result.cutoff, 100_000_000 - 1000);
  });

  test("still resolves {pruned:true} even when the Postgres sync fetch throws", async () => {
    const env = mockEnv({
      DATA_API: {
        fetch: async () => {
          throw new Error("network down");
        },
      },
      RPC_USAGE_SYNC_SECRET: "test-secret",
    });
    const result = await pruneHealthHistory(env, { now: () => 0 });
    assert.equal(result.pruned, true);
  });
});

describe("syncRpcProxyEventsPruneToPostgres", () => {
  test("returns unavailable when DATA_API is not bound", async () => {
    assert.deepEqual(await syncRpcProxyEventsPruneToPostgres(mockEnv(), 1), {
      synced: false,
      reason: "unavailable",
    });
  });

  test("returns unavailable when RPC_USAGE_SYNC_SECRET is not configured", async () => {
    const env = mockEnv({
      DATA_API: { fetch: async () => new Response("{}") },
    });
    assert.deepEqual(await syncRpcProxyEventsPruneToPostgres(env, 1), {
      synced: false,
      reason: "unavailable",
    });
  });

  test("reports the upstream status when the DATA_API response isn't ok", async () => {
    const env = mockEnv({
      DATA_API: { fetch: async () => new Response("nope", { status: 502 }) },
      RPC_USAGE_SYNC_SECRET: "test-secret",
    });
    assert.deepEqual(await syncRpcProxyEventsPruneToPostgres(env, 1), {
      synced: false,
      reason: "status_502",
    });
  });

  test("returns fetch_failed when DATA_API.fetch throws", async () => {
    const env = mockEnv({
      DATA_API: {
        fetch: async () => {
          throw new Error("boom");
        },
      },
      RPC_USAGE_SYNC_SECRET: "test-secret",
    });
    assert.deepEqual(await syncRpcProxyEventsPruneToPostgres(env, 1), {
      synced: false,
      reason: "fetch_failed",
    });
  });

  test("posts the cutoff to rpc-usage-prune with the token header on success", async () => {
    let request: Row | undefined;
    const env = mockEnv({
      DATA_API: {
        fetch: async (req: Row) => {
          request = req;
          return new Response("{}", { status: 200 });
        },
      },
      RPC_USAGE_SYNC_SECRET: "test-secret",
    });
    const result = await syncRpcProxyEventsPruneToPostgres(env, 12_345);
    assert.deepEqual(result, { synced: true });
    assert.ok(request);
    assert.equal(request.method, "POST");
    assert.equal(
      request.url,
      "https://api.metagraph.sh/api/v1/internal/rpc-usage-prune",
    );
    assert.equal(request.headers.get("x-rpc-usage-sync-token"), "test-secret");
    const body = await request.json();
    assert.equal(body.cutoff, 12_345);
  });
});

describe("syncRpcProxyEventsPruneToPostgres via pruneHealthHistory", () => {
  test("no-ops (no DATA_API call) when DATA_API is not bound", async () => {
    const result = await pruneHealthHistory(
      mockEnv({ METAGRAPH_HEALTH_DB: makeDb() }),
      { now: () => 5_000 },
    );
    assert.equal(result.pruned, true);
  });

  test("posts the cutoff to rpc-usage-prune with the token header", async () => {
    let request: Row | undefined;
    const env = mockEnv({
      METAGRAPH_HEALTH_DB: makeDb(),
      DATA_API: {
        fetch: async (req: Row) => {
          request = req;
          return new Response("{}", { status: 200 });
        },
      },
      RPC_USAGE_SYNC_SECRET: "test-secret",
    });
    const result = await pruneHealthHistory(env, {
      now: () => 100_000_000,
      retentionMs: 1000,
    });
    assert.equal(result.pruned, true);
    assert.ok(request);
    assert.equal(request.headers.get("x-rpc-usage-sync-token"), "test-secret");
    const body = await request.json();
    assert.equal(body.cutoff, 100_000_000 - 1000);
  });

  test("a DATA_API failure never affects pruneHealthHistory's own result", async () => {
    const env = mockEnv({
      METAGRAPH_HEALTH_DB: makeDb(),
      DATA_API: {
        fetch: async () => {
          throw new Error("boom");
        },
      },
      RPC_USAGE_SYNC_SECRET: "test-secret",
    });
    const result = await pruneHealthHistory(env, { now: () => 5_000 });
    assert.equal(result.pruned, true);
  });
});

// D1 write retired 2026-07-16 (item 3 of the D1->Postgres cleanup):
// rollupDailyUptime no longer touches D1 at all -- syncHealthUptimeRollupToPostgres
// (exercised directly below and via this function) is the sole writer, and
// `rolled` now reflects whether THAT sync succeeded. The SQL-shape assertions
// that used to live here (ranked CTE, ON CONFLICT targets, the #1799
// uptime_ratio clamp) moved to Postgres's own handleHealthUptimeRollupSync,
// which computes the equivalent rollup server-side (see that handler's own
// tests in tests/data-api.test.mjs).
describe("rollupDailyUptime (durable daily history)", () => {
  function postgresEnv(fetchImpl: AnyFn) {
    return mockEnv({
      DATA_API: { fetch: fetchImpl as unknown as typeof fetch },
      HEALTH_CHECKS_SYNC_SECRET: "test-secret",
    });
  }

  test("rolls up today + yesterday when the Postgres sync succeeds", async () => {
    const fixedNow = Date.UTC(2026, 5, 13, 10, 0, 0); // 2026-06-13T10:00Z
    const result = await rollupDailyUptime(
      postgresEnv(async () => new Response("{}", { status: 200 })),
      { now: () => fixedNow },
    );
    assert.deepEqual(result, {
      rolled: true,
      days: ["2026-06-13", "2026-06-12"],
    });
  });

  test("posts the UTC day boundaries to health-uptime-rollup-sync with the token header", async () => {
    let request: Row | undefined;
    const fixedNow = Date.UTC(2026, 5, 13, 10, 0, 0);
    const env = postgresEnv(async (req: Row) => {
      request = req;
      return new Response("{}", { status: 200 });
    });
    const result = await rollupDailyUptime(env, { now: () => fixedNow });
    assert.equal(result.rolled, true);
    assert.ok(request);
    assert.equal(request.method, "POST");
    assert.equal(
      request.headers.get("x-health-checks-sync-token"),
      "test-secret",
    );
    const body = await request.json();
    assert.equal(body.days.length, 2);
    assert.equal(body.days[0].date, "2026-06-13");
    assert.equal(body.updated_at, fixedNow);
  });

  test("returns { rolled: false, reason: unavailable } without DATA_API/secret", async () => {
    assert.deepEqual(await rollupDailyUptime(mockEnv()), {
      rolled: false,
      reason: "unavailable",
    });
  });

  test("returns { rolled: false, reason } when the Postgres sync response isn't ok", async () => {
    const result = await rollupDailyUptime(
      postgresEnv(async () => new Response("nope", { status: 502 })),
      { now: () => Date.UTC(2026, 5, 13, 10, 0, 0) },
    );
    assert.deepEqual(result, { rolled: false, reason: "status_502" });
  });

  test("returns { rolled: false, reason: fetch_failed } when the Postgres sync fetch throws", async () => {
    const result = await rollupDailyUptime(
      postgresEnv(async () => {
        throw new Error("boom");
      }),
      { now: () => Date.UTC(2026, 5, 13, 10, 0, 0) },
    );
    assert.deepEqual(result, { rolled: false, reason: "fetch_failed" });
  });

  // The "rollup must run before the raw D1 prune" ordering guarantee this
  // used to test no longer applies: D1's own surface_checks DELETE is
  // retired (2026-07-16, D1 fully eliminated from pruneHealthHistory) --
  // Postgres owns its own surface_checks retention server-side now, not
  // sequenced by this cron at all. The still-live invariant (a failed
  // uptime rollup must skip the prune fan-out entirely) is covered by the
  // next test.
  test("hourly cron skips prune when the Postgres rollup sync fails", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const order: any[] = [];
    const orderDb = {
      prepare(sql: string) {
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
    };
    const result = (await handleScheduled(
      { cron: "0 * * * *" } as unknown as ScheduledController,
      { METAGRAPH_HEALTH_DB: orderDb } as unknown as Env,
      {} as unknown as ExecutionContext,
    )) as Row;
    assert.equal(result.rollup_skipped_prune, true);
    assert.equal(result.uptime_rolled, false);
    assert.equal(result.pruned, false);
    assert.ok(
      !order.some((o) => o.includes("DELETE FROM surface_checks")),
      "raw surface_checks must not be pruned when rollup fails",
    );
  });
});

// #4832 gap-closure: syncHealthUptimeRollupToPostgres, exercised the same
// way syncHealthChecksToPostgres is above -- indirectly through
// rollupDailyUptime (private helper) -- proving the Postgres mirror attempt
// fires (or safely no-ops) without affecting rollupDailyUptime's own
// `rolled`/`days`/`error` result either way.
describe("syncHealthUptimeRollupToPostgres", () => {
  // rollupDailyUptime never calls this with an empty days array (it always
  // computes exactly [today, yesterday]), so this guard is only reachable
  // via a direct call, unlike the other tests below.
  test("returns no_days for an empty or non-array days argument", async () => {
    const env = mockEnv({
      DATA_API: { fetch: async () => new Response("{}") },
      HEALTH_CHECKS_SYNC_SECRET: "test-secret",
    });
    assert.deepEqual(await syncHealthUptimeRollupToPostgres(env, [], 1), {
      synced: false,
      reason: "no_days",
    });
    assert.deepEqual(
      await syncHealthUptimeRollupToPostgres(
        env,
        undefined as unknown as Row[],
        1,
      ),
      { synced: false, reason: "no_days" },
    );
  });

  test("reports the upstream status when the DATA_API response isn't ok", async () => {
    const env = mockEnv({
      DATA_API: { fetch: async () => new Response("nope", { status: 502 }) },
      HEALTH_CHECKS_SYNC_SECRET: "test-secret",
    });
    assert.deepEqual(
      await syncHealthUptimeRollupToPostgres(
        env,
        [{ date: "2026-06-13", start: 1, end: 2 }],
        1,
      ),
      { synced: false, reason: "status_502" },
    );
  });
});

// Coverage for the D1-free rollupDailyUptime lives in the
// "rollupDailyUptime (durable daily history)" describe block above (the
// success/unavailable/status/fetch-failed cases are now the SAME cases this
// block used to exercise "via" rollupDailyUptime -- there is no longer a
// separate D1 outcome to vary independently of the Postgres one).
