import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { before, beforeEach, after, describe, it } from "node:test";
import { Client } from "pg";
import { Miniflare } from "miniflare";
import {
  createPgStoreRuntime,
  type PgStoreRuntime,
} from "../src/pg-store-runtime.ts";
import { createPgRateLimits } from "../src/pg-rate-limits.ts";
import { createPgDailyQuota } from "../src/pg-daily-quota.ts";
import { sqliteNumberDecimal } from "../src/sqlite-number.ts";
import { pg18FixtureUrl } from "./helpers/pg18-fixture.ts";
import dataWorker, { ACCOUNT_STATE_TABLES } from "../workers/data-api.ts";
import { handleRequest, DATA_TIERED_RATE_LIMIT } from "../workers/api.ts";
import { handleMcpRequest } from "../src/mcp-server.ts";
import { MCP_TIERED_RATE_LIMIT } from "../src/api-tiers.ts";
import { AI_TIERED_RATE_LIMIT } from "../src/ai-search.ts";
import { validateApiKey } from "../src/api-key-validation.ts";
import { resolveOAuthAccountTier } from "../src/oauth-account-tier.ts";
import { createNativeAuthControls } from "../src/native-auth-controls.ts";

const connectionString = pg18FixtureUrl().toString();
const control = new Client({
  connectionString,
  connectionTimeoutMillis: 2000,
  statement_timeout: 5000,
});
let runtime: PgStoreRuntime;
const errors: unknown[] = [];
const stamp = Date.UTC(2026, 10, 4, 12);
const quotaInput = {
  accountId: 1,
  accountKind: "rpc" as const,
  cost: 1,
  limit: 10,
  nowMs: stamp,
};
const source = new Miniflare({
  modules: true,
  script: "export default { fetch() { return new Response('fixture'); } };",
  d1Databases: ["DB"],
  compatibilityDate: "2026-06-06",
});
let sourceDb: D1Database;
const originalNow = Date.now;
const day = new Date(stamp).toISOString().slice(0, 10);
const realStorageText = (value: number) => {
  const decimal = sqliteNumberDecimal(value);
  return decimal.includes(".") ? decimal : `${decimal}.0`;
};
const ctx = { waitUntil() {} } as unknown as ExecutionContext;
const internalToken = "fixture-internal";
const quotaRoute = (env: object, body: object) =>
  dataWorker.fetch(
    new Request("https://data.example.com/api/v1/internal/keys/quota", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key-lookup-token": internalToken,
      },
      body: JSON.stringify(body),
    }),
    { ...env, API_KEY_LOOKUP_INTERNAL_TOKEN: internalToken } as DataApiEnv,
    ctx,
  );
const clientIp = "203.0.113.9",
  apiKey = "mg_aValidOpaqueUnkeyGeneratedSuffix";

function frontEnvironment() {
  const policies = [
    DATA_TIERED_RATE_LIMIT,
    MCP_TIERED_RATE_LIMIT,
    AI_TIERED_RATE_LIMIT,
  ].flatMap((config) => [
    config.anonymous,
    config.keyed,
    ...Object.values(config.tiers ?? {}),
  ]);
  const definitions = [
    ...new Map(
      policies.map((policy) => [
        policy.envVar,
        {
          binding: policy.envVar,
          limit: policy.limit,
          period: policy.windowSeconds as 60,
        },
      ]),
    ).values(),
  ];
  const controls = createNativeAuthControls(runtime, definitions, (error) =>
    errors.push(error),
  );
  const kv = controls.bindings.CONTROL_KV_STORE;
  const calls: { path: string; body?: Record<string, unknown> }[] = [];
  let state = "active",
    modelCalls = 0;
  const env = {
    ...controls.bindings,
    METAGRAPH_CONTROL: {
      get() {
        throw new Error("legacy KV reached");
      },
    },
    API_KEY_LOOKUP_INTERNAL_TOKEN: internalToken,
    METAGRAPH_ENABLE_AI: "true",
    AI: {
      async run() {
        modelCalls += 1;
        throw new Error("model must not run");
      },
    },
    VECTORIZE: {},
    DATA_API: {
      async fetch(request: Request) {
        const path = new URL(request.url).pathname;
        const body =
          request.method === "POST"
            ? ((await request.clone().json()) as Record<string, unknown>)
            : undefined;
        calls.push({ path, body });
        if (path === "/api/v1/internal/keys/quota")
          return quotaRoute(
            { DAILY_QUOTA_STORE: controls.bindings.DAILY_QUOTA_STORE },
            body!,
          );
        if (path === "/api/v1/internal/keys/state")
          return Response.json({ state });
        if (path === "/api/v1/internal/accounts/github/tier")
          return Response.json({ found: true, tier: "paid" });
        if (path === "/api/v1/internal/keys/verify")
          return Response.json({
            valid: true,
            managed: true,
            keyId: "key_fixture",
            accountId: "42",
            tier: "paid",
          });
        throw new Error(`Unexpected data request ${path}`);
      },
    },
  } as unknown as Env;
  controls.assertEnvironment(env);
  return {
    env,
    kv,
    calls,
    controls,
    modelCalls: () => modelCalls,
    state: (value: string) => {
      state = value;
    },
  };
}

async function prime(binding: string, key: string, requests: number) {
  await control.query(
    "INSERT INTO auth.rate_limit_buckets(binding,key,bucket_second,requests,expires_at) SELECT $1,$2,floor(extract(epoch FROM clock_timestamp()))::bigint,$3,floor(extract(epoch FROM clock_timestamp()))::bigint+61",
    [binding, Buffer.from(key), requests],
  );
}

const migration = (name: string) =>
  readFileSync(
    new URL(`../migrations/postgres/${name}`, import.meta.url),
    "utf8",
  );

describe(
  "native authentication controls on PostgreSQL 18.6",
  { concurrency: false },
  () => {
    before(async () => {
      await control.connect();
      assert.equal(
        (await control.query("SHOW server_version_num")).rows[0]
          .server_version_num,
        "180006",
      );
      await control.query(migration("0009_auth_kv.sql"));
      await control.query(migration("0010_account_state.sql"));
      assert.deepEqual(
        (
          await control.query(
            "SELECT column_name,data_type FROM information_schema.columns WHERE table_schema='app' AND table_name='api_quota_daily' AND column_name IN ('account_id','units_spent') ORDER BY column_name",
          )
        ).rows,
        [
          { column_name: "account_id", data_type: "numeric" },
          { column_name: "units_spent", data_type: "numeric" },
        ],
      );
      // Exercise the upgrade conversion too, not only the new load schema.
      await control.query(
        "ALTER TABLE app.api_quota_daily ALTER COLUMN account_id TYPE bigint, ALTER COLUMN units_spent TYPE bigint",
      );
      await control.query(migration("0028_auth_rate_limits.sql"));
      const connection = new URL(connectionString);
      connection.searchParams.set(
        "options",
        "-c default_transaction_isolation=repeatable\\ read",
      );
      runtime = createPgStoreRuntime({
        connectionString: connection.toString(),
        maxConnections: 8,
        connectionTimeoutMillis: 2000,
        idleTimeoutMillis: 1000,
        statementTimeoutMillis: 5000,
        onIdleError(error) {
          errors.push(error);
        },
      });
      sourceDb = await source.getD1Database("DB");
      await sourceDb.exec(
        "CREATE TABLE api_quota_daily(account_kind TEXT,account_id INTEGER,day TEXT,units_spent INTEGER,updated_at INTEGER,PRIMARY KEY(account_kind,account_id,day))",
      );
    });
    beforeEach(async () => {
      Date.now = () => stamp;
      await control.query(
        "TRUNCATE auth.kv_entries,auth.rate_limit_buckets,app.api_quota_daily",
      );
      await sourceDb.exec("DELETE FROM api_quota_daily");
      errors.length = 0;
    });
    after(async () => {
      Date.now = originalNow;
      await source.dispose();
      await runtime?.close();
      await control.query(
        "DROP SCHEMA IF EXISTS auth CASCADE; DROP SCHEMA IF EXISTS app CASCADE",
      );
      await control.end();
    });

    it("serializes concurrent draws across independent limiters and separates bindings and UTF-8 keys", async () => {
      const definitions = [
        { binding: "FIRST", limit: 3, period: 60 as const },
        { binding: "SECOND", limit: 1, period: 10 as const },
      ];
      const a = createPgRateLimits(runtime, definitions, (error) =>
        errors.push(error),
      );
      const b = createPgRateLimits(runtime, definitions, (error) =>
        errors.push(error),
      );
      const values = await Promise.all(
        Array.from({ length: 8 }, (_, index) =>
          (index % 2 ? a : b).bindings.FIRST.limit({ key: "caller\0λ" }),
        ),
      );
      assert.equal(values.filter((value) => value.success).length, 3);
      assert.deepEqual(errors, []);
      assert.equal(
        (await a.bindings.SECOND.limit({ key: "caller\0λ" })).success,
        true,
      );
      assert.equal(
        (await a.bindings.FIRST.limit({ key: "other" })).success,
        true,
      );
      assert.equal(
        (
          await control.query(
            "SELECT sum(requests)::int AS n FROM auth.rate_limit_buckets WHERE binding='FIRST'",
          )
        ).rows[0].n,
        4,
      );
    });

    it("retains future buckets conservatively and prunes only the bounded expired rows", async () => {
      const api = createPgRateLimits(
        runtime,
        [{ binding: "LIMIT", limit: 1, period: 10 }],
        (error) => errors.push(error),
      );
      await api.bindings.LIMIT.limit({ key: "future" });
      await control.query(
        "UPDATE auth.rate_limit_buckets SET bucket_second=bucket_second+3600,expires_at=expires_at+3600",
      );
      assert.equal(
        (await api.bindings.LIMIT.limit({ key: "future" })).success,
        false,
      );
      for (const key of ["a", "b", "c"])
        await api.bindings.LIMIT.limit({ key });
      await control.query(
        "UPDATE auth.rate_limit_buckets SET bucket_second=bucket_second-120,expires_at=expires_at-120 WHERE key<>$1",
        [Buffer.from("future")],
      );
      assert.equal(await api.pruneExpired(2), 2);
      assert.equal(await api.pruneExpired(2), 1);
      assert.equal(await api.pruneExpired(), 0);
      assert.equal(
        (await api.bindings.LIMIT.limit({ key: "a" })).success,
        true,
      );
    });

    it("denies admission during pool exhaustion and leaves no partial draw", async () => {
      const single = createPgStoreRuntime({
        connectionString,
        maxConnections: 1,
        connectionTimeoutMillis: 2000,
        idleTimeoutMillis: 1000,
        statementTimeoutMillis: 5000,
        onIdleError(error) {
          errors.push(error);
        },
      });
      let entered!: () => void, release!: () => void;
      const held = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const paused = new Promise<void>((resolve) => {
        release = resolve;
      });
      const pending = single.transaction(async () => {
        entered();
        await paused;
      });
      try {
        await held;
        const rate = createPgRateLimits(
          single,
          [{ binding: "LIMIT", limit: 1, period: 60 }],
          (error) => errors.push(error),
        );
        assert.equal(
          (await rate.bindings.LIMIT.limit({ key: "actor" })).success,
          false,
        );
        assert.equal(errors.length, 1);
        assert.equal(
          (
            await control.query(
              "SELECT count(*)::int AS n FROM auth.rate_limit_buckets",
            )
          ).rows[0].n,
          0,
        );
      } finally {
        release();
        await pending;
        await single.close();
      }
    });

    it("preserves fractional quotas, wide keys, kind separation and UTC day isolation", async () => {
      const quota = createPgDailyQuota(runtime);
      assert.equal(
        (
          await quota.spend({
            ...quotaInput,
            accountId: 1e30,
            cost: 0.1,
            limit: 0.3,
          })
        ).used,
        0.1,
      );
      assert.equal(
        (
          await quota.spend({
            ...quotaInput,
            accountId: 1e30,
            cost: 0.2,
            limit: 0.3,
          })
        ).allowed,
        false,
      );
      const row = (
        await control.query(
          "SELECT account_id::text AS id,units_spent::text AS used FROM app.api_quota_daily",
        )
      ).rows[0];
      assert.equal(row.id, sqliteNumberDecimal(1e30));
      assert.equal(row.used, sqliteNumberDecimal(0.1));
      assert.equal(
        (
          await quota.spend({
            ...quotaInput,
            accountId: 1e30,
            accountKind: "github",
            cost: 0.2,
            limit: 0.3,
          })
        ).allowed,
        true,
      );
      assert.equal(
        (
          await quota.spend({
            ...quotaInput,
            accountId: 1e30,
            cost: 0.2,
            limit: 0.3,
            nowMs: stamp + 86400000,
          })
        ).allowed,
        true,
      );
    });

    it("commits only one concurrent quota debit and rolls back a failed write", async () => {
      const quota = createPgDailyQuota(runtime);
      const results = await Promise.all([
        quota.spend({ ...quotaInput, cost: 6 }),
        quota.spend({ ...quotaInput, cost: 6 }),
      ]);
      assert.equal(results.filter((result) => result.allowed).length, 1);
      assert.equal(
        (
          await control.query(
            "SELECT units_spent::text AS used FROM app.api_quota_daily",
          )
        ).rows[0].used,
        "6",
      );
      await control.query(
        "CREATE FUNCTION app.reject_quota() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture quota failure'; END $$; CREATE TRIGGER reject_quota BEFORE UPDATE ON app.api_quota_daily FOR EACH ROW EXECUTE FUNCTION app.reject_quota()",
      );
      try {
        await assert.rejects(quota.spend(quotaInput), /fixture quota failure/);
      } finally {
        await control.query(
          "DROP TRIGGER reject_quota ON app.api_quota_daily; DROP FUNCTION app.reject_quota()",
        );
      }
      assert.equal(
        (
          await control.query(
            "SELECT units_spent::text AS used FROM app.api_quota_daily",
          )
        ).rows[0].used,
        "6",
      );
    });

    it("matches the actual D1 quota HTTP handler for fractional and wide-number arithmetic", async () => {
      const sourceEnv = {
        D1_STATE: sourceDb,
        D1_STATE_TABLES: ACCOUNT_STATE_TABLES.join(","),
      };
      const nativeEnv = { DAILY_QUOTA_STORE: createPgDailyQuota(runtime) };
      const cases: {
        initial: string | null;
        cost: number;
        limit: number;
        real?: boolean;
      }[] = [
        { initial: null, cost: 0.1, limit: 0.3 },
        { initial: "0.1", cost: 0.2, limit: 0.3 },
        { initial: "9007199254740992", cost: 1, limit: 9007199254740992 },
        { initial: "9007199254740993", cost: 1, limit: 9007199254740994 },
        { initial: "9223372036854775807", cost: 1, limit: 1e20 },
        { initial: "-9223372036854775808", cost: 1, limit: 10 },
        { initial: "-9223372036854775808", real: true, cost: 1, limit: 10 },
        { initial: null, cost: Number.MAX_VALUE, limit: Number.MAX_VALUE },
      ];
      for (const [index, entry] of cases.entries()) {
        const accountId = index === 0 ? 1e30 : index + 1;
        if (entry.initial !== null) {
          await sourceDb
            .prepare("INSERT INTO api_quota_daily VALUES ('rpc',?,?,?,0)")
            .bind(
              accountId,
              day,
              entry.real ? Number(entry.initial) : entry.initial,
            )
            .run();
          const sourceValue = await sourceDb
            .prepare(
              "SELECT typeof(units_spent) AS kind,quote(units_spent) AS quoted,units_spent AS used FROM api_quota_daily WHERE account_id=?",
            )
            .bind(accountId)
            .first<{ kind: string; quoted: string; used: number }>();
          const exact =
            sourceValue!.kind === "integer"
              ? sourceValue!.quoted
              : realStorageText(sourceValue!.used);
          await control.query(
            "INSERT INTO app.api_quota_daily(account_kind,account_id,day,units_spent,updated_at) VALUES ('rpc',$1::numeric,$2,$3::numeric,0)",
            [sqliteNumberDecimal(accountId), day, exact],
          );
        }
        const body = {
          account_id: accountId,
          account_kind: "rpc",
          cost: entry.cost,
          limit: entry.limit,
        };
        const expected = await quotaRoute(sourceEnv, body),
          actual = await quotaRoute(nativeEnv, body);
        assert.equal(actual.status, expected.status, `case ${index} status`);
        assert.deepEqual(
          await actual.json(),
          await expected.json(),
          `case ${index} response`,
        );
        const sourceValue = await sourceDb
          .prepare(
            "SELECT typeof(units_spent) AS kind,quote(units_spent) AS quoted,units_spent AS used FROM api_quota_daily WHERE account_id=?",
          )
          .bind(accountId)
          .first<{ kind: string; quoted: string; used: number }>();
        const exact =
          sourceValue!.kind === "integer"
            ? sourceValue!.quoted
            : realStorageText(sourceValue!.used);
        const actualValue = (
          await control.query(
            "SELECT units_spent::text AS used FROM app.api_quota_daily WHERE account_id=$1::numeric",
            [sqliteNumberDecimal(accountId)],
          )
        ).rows[0].used;
        assert.equal(actualValue, exact, `case ${index} stored value`);
      }
    });

    it("normal REST and MCP gates use native counters before data or body processing", async () => {
      const front = frontEnvironment();
      await prime(
        DATA_TIERED_RATE_LIMIT.anonymous.envVar,
        `data:${clientIp}`,
        DATA_TIERED_RATE_LIMIT.anonymous.limit,
      );
      const rest = await handleRequest(
        new Request("https://api.metagraph.sh/api/v1/blocks/8816875", {
          headers: { "cf-connecting-ip": clientIp },
        }),
        front.env,
        {},
      );
      assert.equal(rest.status, 429);
      assert.equal(front.calls.length, 0);
      await prime(
        MCP_TIERED_RATE_LIMIT.anonymous.envVar,
        `mcp:${clientIp}`,
        MCP_TIERED_RATE_LIMIT.anonymous.limit,
      );
      const mcp = await handleMcpRequest(
        new Request("https://api.metagraph.sh/mcp", {
          method: "POST",
          headers: { "cf-connecting-ip": clientIp },
          body: "not-json",
        }),
        front.env,
      );
      assert.equal(mcp.status, 429);
      assert.equal(front.calls.length, 0);
    });

    it("MCP prices deferred cost once and preserves native cache and blocklist precedence", async () => {
      const front = frontEnvironment(),
        quota = createPgDailyQuota(runtime);
      const ceiling = MCP_TIERED_RATE_LIMIT.tiers!.paid.dailyUnits!;
      await quota.spend({
        accountId: 42,
        accountKind: "rpc",
        cost: ceiling,
        limit: ceiling,
        nowMs: stamp,
      });
      const request = () =>
        new Request("https://api.metagraph.sh/mcp", {
          method: "POST",
          headers: {
            "cf-connecting-ip": clientIp,
            "content-type": "application/json",
            authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: { name: "ask", arguments: { question: "hi" } },
          }),
        });
      const response = await handleMcpRequest(request(), front.env);
      assert.equal(response.status, 429);
      assert.deepEqual(
        front.calls
          .filter((call) => call.path.endsWith("/quota"))
          .map((call) => call.body?.cost),
        [25],
      );
      assert.equal(front.modelCalls(), 0);
      assert.equal(
        (
          await control.query(
            "SELECT units_spent::text AS used FROM app.api_quota_daily",
          )
        ).rows[0].used,
        String(ceiling),
      );
      await front.kv.put(
        "api-key-blocklist",
        JSON.stringify({
          blocks: [{ accountId: 42, reasonCode: "abuse_manual" }],
        }),
      );
      const prior = (
        await control.query(
          "SELECT sum(requests)::int AS n FROM auth.rate_limit_buckets",
        )
      ).rows[0].n;
      const blocked = await handleMcpRequest(request(), front.env);
      assert.equal(blocked.status, 403);
      assert.equal(
        front.calls.filter((call) => call.path.endsWith("/quota")).length,
        1,
      );
      assert.equal(
        (
          await control.query(
            "SELECT sum(requests)::int AS n FROM auth.rate_limit_buckets",
          )
        ).rows[0].n,
        prior,
      );
      assert.equal((await validateApiKey(front.env, apiKey)).ok, true);
      front.state("revoked");
      assert.equal((await validateApiKey(front.env, apiKey)).ok, false);
      assert.deepEqual(await resolveOAuthAccountTier(front.env, 42), {
        found: true,
        tier: "paid",
      });
      assert.deepEqual(await resolveOAuthAccountTier(front.env, 42), {
        found: true,
        tier: "paid",
      });
      assert.equal(
        front.calls.filter((call) => call.path.includes("accounts/github/tier"))
          .length,
        1,
      );
    });

    it("counter unavailability cannot grant an AI call through REST or the separate MCP limiter", async () => {
      const front = frontEnvironment();
      const single = createPgStoreRuntime({
        connectionString,
        maxConnections: 1,
        connectionTimeoutMillis: 2000,
        idleTimeoutMillis: 1000,
        statementTimeoutMillis: 5000,
        onIdleError(error) {
          errors.push(error);
        },
      });
      let entered!: () => void, release!: () => void;
      const held = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const paused = new Promise<void>((resolve) => {
        release = resolve;
      });
      const pending = single.transaction(async () => {
        entered();
        await paused;
      });
      try {
        await held;
        const failed = createPgRateLimits(
          single,
          [{ binding: "AI_RATE_LIMITER", limit: 20, period: 60 }],
          (error) => errors.push(error),
        );
        const env = { ...front.env, ...failed.bindings } as Env;
        const rest = await handleRequest(
          new Request("https://api.metagraph.sh/api/v1/search/semantic?q=x", {
            headers: { "cf-connecting-ip": clientIp },
          }),
          env,
          {},
        );
        assert.equal(rest.status, 429);
        const mcp = await handleMcpRequest(
          new Request("https://api.metagraph.sh/mcp", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "cf-connecting-ip": clientIp,
            },
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              method: "tools/call",
              params: { name: "semantic_search", arguments: { q: "x" } },
            }),
          }),
          env,
        );
        assert.match(await mcp.text(), /rate_limited/);
        assert.equal(front.modelCalls(), 0);
        assert.equal(
          front.calls.filter((call) => call.path.endsWith("/quota")).length,
          0,
        );
        assert.equal(errors.length, 2);
      } finally {
        release();
        await pending;
        await single.close();
      }
    });
  },
);
