import assert from "node:assert/strict";
import { test } from "vitest";
import registry from "../workers/registry-sync-api.ts";
import { selectedRegistrySyncStore } from "../src/registry-sync-store.ts";
import { createPgRegistrySyncStore } from "../src/pg-registry-sync.ts";
import { createPgGeneratedArtifactStore } from "../src/pg-generated-artifacts.ts";
import { selectedNativeSelfHealthStore } from "../src/native-self-health-store.ts";
import { createPgSelfHealthStore } from "../src/pg-self-health.ts";
import { selfHealthSql } from "../src/self-health-store.ts";
import { runSelfHealthProbe } from "../src/self-health-prober.ts";
import type { PgTransaction, PgTransactionRunner } from "../src/pg-pool.ts";
import type { RegistrySyncPayload } from "../src/registry-sync-neon.ts";

const payload: RegistrySyncPayload = {
  providers: [{ id: "p", overlay: { ok: true }, source_commit: "source" }],
  subnets: [],
  surfaces: [],
  pruneSurfaces: [],
  deleteSubnets: [],
};
const summary = {
  providers_written: 1,
  subnets_written: 0,
  surfaces_written: 0,
  surfaces_deleted: 0,
  subnets_deleted: 0,
};

function fixture() {
  const calls: { text: string; values?: unknown[] }[] = [];
  let rows: unknown[] = [];
  let first: unknown = { present: true };
  const scope: PgTransaction = {
    async query<Row>(text: string, values?: unknown[]) {
      calls.push({ text, values });
      return rows as Row[];
    },
    async first<Row>(text: string, values?: unknown[]) {
      calls.push({ text, values });
      return first as Row;
    },
    async run(text, values) {
      calls.push({ text, values });
      return { changes: 1 };
    },
  };
  let transactions = 0;
  const transaction: PgTransactionRunner = async (run, options) => {
    transactions++;
    assert.equal(options?.isolation, "read committed");
    return run(scope);
  };
  return {
    calls,
    scope,
    transaction,
    count: () => transactions,
    rows: (value: unknown[]) => {
      rows = value;
    },
    first: (value: unknown) => {
      first = value;
    },
  };
}

test("native registry selection requires the explicit complete capability", () => {
  for (const env of [undefined, null, 3, "x", {}])
    assert.equal(selectedRegistrySyncStore(env), null);
  const store = {
    async apply() {
      return summary;
    },
  };
  assert.equal(
    selectedRegistrySyncStore({ REGISTRY_SYNC_STORE: store }),
    store,
  );
  for (const value of [null, false, {}, { apply: true }])
    assert.throws(
      () => selectedRegistrySyncStore({ REGISTRY_SYNC_STORE: value }),
      /incomplete/,
    );
});

test("the registry handler uses native ownership and preserves the existing PostgreSQL response", async () => {
  const bodies: RegistrySyncPayload[] = [];
  const env = {
    REGISTRY_SYNC_SECRET: "fixture-secret",
    REGISTRY_SYNC_STORE: {
      async apply(body: RegistrySyncPayload) {
        bodies.push(body);
        return summary;
      },
    },
    D1_STATE: {
      prepare() {
        throw new Error("legacy called");
      },
    },
    D1_STATE_TABLES: "providers,subnets,surfaces,surface_history",
  } as unknown as RegistrySyncApiEnv;
  const request = () =>
    new Request("https://registry.example/", {
      method: "POST",
      headers: { "x-registry-sync-token": "fixture-secret" },
      body: JSON.stringify({ providers: payload.providers }),
    });
  const response = await registry.fetch(request(), env);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok: true,
    store: "neon",
    ...summary,
  });
  assert.deepEqual(bodies, [payload]);
  const broken = {
    ...env,
    REGISTRY_SYNC_STORE: {
      async apply() {
        throw new Error("write rejected");
      },
    },
  };
  const rejected = await registry.fetch(request(), broken);
  assert.equal(rejected.status, 502);
  assert.deepEqual(await rejected.json(), { error: "write failed" });
});

test("registry native transactions keep the shared query body inside one owner", async () => {
  const f = fixture();
  const store = createPgRegistrySyncStore(f, () => "fixed-id");
  assert.deepEqual(await store.apply(payload), summary);
  assert.equal(f.count(), 1);
  assert.equal(
    f.calls[0]!.text,
    "SET LOCAL search_path = pg_catalog, app, pg_temp",
  );
  assert(f.calls[1]!.text.includes("pg_advisory_xact_lock"));
  assert(f.calls[2]!.text.includes("INSERT INTO providers"));
  assert.deepEqual(f.calls[2]!.values, ["p", '{"ok":true}', "source"]);
  assert(
    !f.calls.some((call) =>
      ["BEGIN", "COMMIT", "ROLLBACK"].includes(call.text),
    ),
  );
  const defaults = createPgRegistrySyncStore(f);
  await defaults.apply({
    providers: [],
    subnets: [],
    pruneSurfaces: [],
    deleteSubnets: [],
    surfaces: [
      {
        subnet_netuid: 7,
        surface_key: "fixture",
        kind: "subnet-api",
        url: "https://example.com/api",
        overlay: {},
        source_commit: "fixture",
      },
    ],
  });
  const insert = f.calls.find((call) =>
    call.text.includes("INSERT INTO surfaces"),
  )!;
  assert.match(String(insert.values?.[0]), /^[a-f0-9-]{36}$/);
});

test("native generated snapshots retain cold reads and acknowledged writes", async () => {
  const f = fixture();
  const store = createPgGeneratedArtifactStore({
    read: f.scope,
    producer: {
      ...f.scope,
      async transaction() {
        return [];
      },
    },
  });
  f.first({ payload: '{"version":1}' });
  assert.deepEqual(await store.get("key"), { version: 1 });
  for (const value of [null, { payload: "{" }]) {
    f.first(value);
    assert.equal(await store.get("key"), null);
  }
  const unavailable = createPgGeneratedArtifactStore({
    read: {
      ...f.scope,
      async first() {
        throw new Error("read rejected");
      },
    },
    producer: {
      ...f.scope,
      async transaction() {
        return [];
      },
    },
  });
  assert.equal(await unavailable.get("key"), null);
  f.first({ payload: null });
  assert.equal(await store.get("key", 64), null);
  assert.deepEqual(f.calls.at(-1)!.values, ["key", 64]);
  for (const limit of [0, -1, 0.5, NaN, 25 * 1024 * 1024 + 1])
    await assert.rejects(store.get("key", limit), /limit is invalid/);
  f.first({ key: "key" });
  await store.put("key", '{"version":2}');
  const write = f.calls.at(-1)!;
  assert.deepEqual(write.values?.slice(0, 2), ["key", '{"version":2}']);
  assert(!Number.isNaN(Date.parse(String(write.values?.[2]))));
  f.first(null);
  await assert.rejects(store.put("key", "{}"), /not acknowledged/);
});

test("self-health selection moves reads and complete tick writes together", async () => {
  for (const env of [undefined, null, 3, "x", {}])
    assert.equal(selectedNativeSelfHealthStore(env), null);
  const f = fixture();
  const store = createPgSelfHealthStore(f);
  const env = {
    SELF_HEALTH_STORE: store,
    D1_STATE: {
      prepare() {
        throw new Error("legacy called");
      },
    },
    D1_STATE_TABLES: "self_health_checks,self_health_daily",
  };
  assert.equal(selectedNativeSelfHealthStore(env), store);
  assert.equal(selfHealthSql(env), store.sql);
  await store.sql`SELECT ${"value"}`;
  await store.sql.unsafe("SELECT $1", ["unsafe"]);
  assert.deepEqual(
    f.calls.map((call) => call.text),
    [
      "SET LOCAL search_path = pg_catalog, app, pg_temp",
      "SELECT $1",
      "SET LOCAL search_path = pg_catalog, app, pg_temp",
      "SELECT $1",
    ],
  );
  const tick = {
    component: "api",
    checkedAt: 1000,
    day: "2026-11-04",
    ok: true,
    http_status: 200,
    latency_ms: 2,
  };
  f.calls.length = 0;
  f.rows([{ component: "api" }]);
  await store.record(tick);
  assert(f.calls[1]!.text.includes("self_health_daily"));
  f.calls.length = 0;
  f.rows([]);
  await store.record(tick);
  assert.equal(
    f.calls.length,
    2,
    "a duplicate tick adds no daily contribution",
  );
  f.first({ present: false });
  await assert.rejects(store.record(tick), /not acknowledged/);
  f.first(null);
  await assert.rejects(store.record(tick), /not acknowledged/);
  for (const value of [
    null,
    false,
    {},
    { ...store, sql: {} },
    { ...store, sql: () => {} },
    { sql: store.sql },
    { ...store, sql: Object.assign(() => {}, { unsafe: 3 }) },
    { ...store, record: 1 },
  ])
    assert.throws(
      () => selectedNativeSelfHealthStore({ SELF_HEALTH_STORE: value }),
      /incomplete/,
    );
});

test("unselected self-health retains lazy legacy SQL and requires a deferrable context", () => {
  const env = { HYPERDRIVE: { connectionString: "fixture-connection" } };
  assert.equal(selfHealthSql({}), null);
  assert.equal(selfHealthSql(env), null);
  const sql = selfHealthSql(env, {
    waitUntil() {
      throw new Error("constructing the SQL capability must not start work");
    },
  });
  assert.equal(typeof sql, "function");
  assert.equal(typeof sql?.unsafe, "function");
});

test("the real self-health prober selects the complete native tick writer", async () => {
  const f = fixture();
  const store = createPgSelfHealthStore(f);
  f.rows([{ component: "present" }]);
  const result = await runSelfHealthProbe(
    {
      SELF_HEALTH_STORE: store,
      D1_STATE: {
        prepare() {
          throw new Error("legacy called");
        },
      },
      D1_STATE_TABLES: "self_health_checks,self_health_daily",
    } as unknown as Parameters<typeof runSelfHealthProbe>[0],
    null,
    {
      now: () => Date.UTC(2026, 10, 4),
      fetch: async () => new Response(null, { status: 200 }),
      wait: () => new Promise<void>(() => {}),
      laneHealthDb: {
        async query() {
          return [];
        },
        async run() {
          return { changes: 1 };
        },
      },
    },
  );
  assert.equal(result.attempted, true);
  assert.equal(f.count(), 3);
  assert.equal(
    f.calls.filter((call) =>
      call.text.includes("INSERT INTO app.self_health_checks"),
    ).length,
    3,
  );
});
