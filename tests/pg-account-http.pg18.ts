import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { Client } from "pg";
import { Miniflare } from "miniflare";
import { getPublicKey, secretFromSeed, sign } from "@scure/sr25519";
import worker from "../workers/data-api.ts";
import { dataApiEnv } from "./helpers/worker-env.ts";
import { createNativeAccountState } from "../src/native-account-state.ts";
import { createPgStoreRuntime } from "../src/pg-store-runtime.ts";
import { createPgKv } from "../src/pg-kv.ts";
import { encodeAccountId32 } from "../src/ss58.ts";
import { pg18FixtureUrl } from "./helpers/pg18-fixture.ts";

test("native wallet, GitHub, key, tier, usage and block HTTP lifecycles retain D1 bytes", async () => {
  const connectionString = pg18FixtureUrl().toString();
  const control = new Client({
    connectionString,
    connectionTimeoutMillis: 2000,
    statement_timeout: 5000,
  });
  const runtime = createPgStoreRuntime({
    connectionString,
    maxConnections: 4,
    connectionTimeoutMillis: 2000,
    idleTimeoutMillis: 1000,
    statementTimeoutMillis: 5000,
    onIdleError() {},
  });
  const source = new Miniflare({
    modules: true,
    script: "export default {fetch(){return new Response('fixture')}}",
    d1Databases: ["DB"],
    compatibilityDate: "2026-06-06",
  });
  const now = Date.now(),
    originalNow = Date.now,
    originalFetch = globalThis.fetch;
  let ownApp = false,
    ownAuth = false;
  try {
    await control.connect();
    assert.equal(
      (await control.query("SHOW server_version_num")).rows[0]
        .server_version_num,
      "180006",
    );
    ownApp =
      (await control.query("SELECT 1 FROM pg_namespace WHERE nspname='app'"))
        .rowCount === 0;
    ownAuth =
      (await control.query("SELECT 1 FROM pg_namespace WHERE nspname='auth'"))
        .rowCount === 0;
    assert.ok(ownApp && ownAuth, "requires disposable fixture");
    for (const name of [
      "0010_account_state.sql",
      "0033_account_numeric.sql",
      "0035_usage_row_identity.sql",
      "0036_usage_row_identity_activate.sql",
      "0009_auth_kv.sql",
    ])
      await control.query(
        readFileSync(
          new URL(`../migrations/postgres/${name}`, import.meta.url),
          "utf8",
        ),
      );
    const db = await source.getD1Database("DB");
    const tables = new Set([
      "rpc_accounts",
      "github_accounts",
      "api_keys",
      "api_key_blocks",
      "api_key_usage_daily",
      "api_quota_daily",
      "api_usage_rollup",
      "api_usage_rollup_batches",
    ]);
    const objects = JSON.parse(
      readFileSync(
        new URL("../generated/db/d1-schema.json", import.meta.url),
        "utf8",
      ),
    ) as { type: string; tbl_name: string; sql: string }[];
    for (const type of ["table", "index"])
      for (const object of objects.filter(
        (entry) => entry.type === type && tables.has(entry.tbl_name),
      ))
        await db.prepare(object.sql).run();
    Date.now = () => now;
    let failRevocation = false;
    let nativeRequest = false;
    let fixtureKey = "key_fixture";
    globalThis.fetch = async (input, init) => {
      const url = new URL(String(input));
      assert.equal(url.origin, "https://api.unkey.com");
      const body = JSON.parse(String(init?.body)) as { enabled?: boolean };
      if (nativeRequest) {
        assert.equal(
          (
            await control.query(
              "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND state='idle in transaction'",
            )
          ).rows[0].n,
          0,
          "provider work must not hold a database transaction",
        );
        if (body.enabled === false)
          assert.equal(
            (
              await control.query(
                "SELECT count(*)::int AS n FROM app.api_keys WHERE unkey_key_id='key_fixture' AND revocation_requested_at IS NOT NULL",
              )
            ).rows[0].n,
            1,
            "revocation intent must commit before provider mutation",
          );
      }
      if (body.enabled === false && failRevocation)
        throw new Error("fixture unavailable");
      return new Response(
        JSON.stringify({
          data: url.pathname.endsWith("keys.createKey")
            ? { keyId: fixtureKey, key: "mg_fixture_only" }
            : {},
        }),
        { headers: { "content-type": "application/json" } },
      );
    };
    const key = secretFromSeed(
      Uint8Array.from({ length: 32 }, (_, index) => index + 1),
    );
    const address = encodeAccountId32(getPublicKey(key))!;
    const common = {
      WALLET_SESSION_SECRET: "fixture-session",
      UNKEY_ROOT_KEY: "fixture-only",
      UNKEY_API_ID: "fixture",
      API_KEY_LOOKUP_INTERNAL_TOKEN: "fixture-internal",
      API_KEY_BLOCK_INTERNAL_TOKEN: "fixture-block",
      ACCOUNT_TIER_PROMOTE_INTERNAL_TOKEN: "fixture-tier",
    };
    const sourceKv = new Map<string, string>();
    const sourceEnv = {
      ...dataApiEnv(),
      ...common,
      D1_STATE: db,
      D1_STATE_TABLES: [...tables].join(",") as DataApiEnv["D1_STATE_TABLES"],
      METAGRAPH_CONTROL: {
        async get(name: string, options?: { type?: string }) {
          const value = sourceKv.get(name) ?? null;
          return options?.type === "json" && value !== null
            ? JSON.parse(value)
            : value;
        },
        async put(name: string, value: string) {
          sourceKv.set(name, value);
        },
        async delete(name: string) {
          sourceKv.delete(name);
        },
      },
    } as unknown as DataApiEnv;
    const nativeEnv = {
      ...dataApiEnv(common),
      ACCOUNT_STATE_STORE: createNativeAccountState(runtime),
      CONTROL_KV_STORE: createPgKv(runtime, "control"),
    };
    const pending: Promise<unknown>[] = [];
    const ctx = {
      waitUntil(value: Promise<unknown>) {
        pending.push(value);
      },
    } as unknown as ExecutionContext;
    const call = async (
      env: DataApiEnv,
      path: string,
      body?: object,
      headers: Record<string, string> = {},
      method = body ? "POST" : "GET",
    ) => {
      nativeRequest = env === nativeEnv;
      const response = await worker.fetch(
        new Request(`https://fixture.test/api/v1/${path}`, {
          method,
          headers: {
            ...headers,
            ...(body ? { "content-type": "application/json" } : {}),
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
        }),
        env,
        ctx,
      );
      await Promise.all(pending.splice(0));
      return { status: response.status, text: await response.text() };
    };
    const both = async (
      path: string,
      body?: object,
      headers: Record<string, string> = {},
      method = body ? "POST" : "GET",
    ) => {
      const expected = await call(sourceEnv, path, body, headers, method);
      const actual = await call(nativeEnv, path, body, headers, method);
      assert.deepEqual(actual, expected, path);
      return actual;
    };
    const sessions = [];
    for (const env of [sourceEnv, nativeEnv]) {
      const challenge = await call(env, "auth/wallet/challenge", {
        ss58: address,
      });
      assert.equal(challenge.status, 200);
      const { message } = JSON.parse(challenge.text) as { message: string };
      const signature = Buffer.from(
        sign(key, new TextEncoder().encode(message)),
      ).toString("hex");
      const verified = await call(env, "auth/wallet/verify", {
        ss58: address,
        signature,
      });
      assert.equal(verified.status, 200);
      sessions.push(verified);
    }
    assert.deepEqual(sessions[1], sessions[0]);
    const token = (JSON.parse(sessions[0].text) as { session_token: string })
      .session_token;
    const session = { authorization: `Bearer ${token}` };
    const internal = { "x-api-key-lookup-token": "fixture-internal" };
    const block = { "x-api-key-block-token": "fixture-block" };
    assert.equal(
      (
        await both(
          "auth/github/upsert-account",
          { github_user_id: 1e30, github_login: "fixture" },
          internal,
        )
      ).status,
      200,
    );
    assert.equal((await both("keys", {}, session)).status, 201);
    fixtureKey = "key_second";
    assert.equal((await both("keys", {}, session)).status, 201);
    assert.equal((await both("keys", undefined, session)).status, 200);
    assert.equal(
      (
        await both(
          "internal/accounts/tier",
          { ss58: address, tier: "paid" },
          { "x-account-tier-promote-token": "fixture-tier" },
        )
      ).status,
      200,
    );
    assert.equal(
      (
        await both(
          "internal/keys/usage",
          { account_id: 1, route: "/fixture", source_row_id: -99 },
          internal,
        )
      ).status,
      200,
    );
    assert.equal(
      (
        await control.query(
          "SELECT source_row_id>0 AS generated FROM app.api_key_usage_daily",
        )
      ).rows[0].generated,
      true,
    );
    assert.equal(
      (
        await both(
          "internal/keys/quota",
          { account_id: 1, cost: 1, limit: 10 },
          internal,
        )
      ).status,
      200,
    );
    const day = new Date().toISOString().slice(0, 10);
    assert.equal(
      (
        await both(
          "internal/usage-rollup",
          {
            buckets: [
              {
                day,
                family: "fixture",
                cost_shape: "edge",
                request_count: 1,
                keyed_count: 1,
              },
            ],
          },
          internal,
        )
      ).status,
      200,
    );
    assert.equal(
      (await both("internal/usage-rollup?group_by=shape", undefined, internal))
        .status,
      200,
    );
    assert.equal((await both("keys/usage", undefined, session)).status, 200);
    assert.equal(
      (
        await both(
          "internal/keys/block",
          { account_id: 1, reason_code: "abuse_manual", note: "fixture" },
          block,
        )
      ).status,
      200,
    );
    assert.equal((await both("keys/status", undefined, session)).status, 200);
    assert.equal(
      (
        await both(
          "internal/keys/unblock",
          { account_id: 1, note: "fixture cleared" },
          block,
        )
      ).status,
      200,
    );
    failRevocation = true;
    assert.equal(
      (await both("keys/key_fixture", undefined, session, "DELETE")).status,
      502,
    );
    assert.equal(
      (
        await both(
          "internal/keys/state",
          { keyId: "key_fixture", accountId: 1 },
          internal,
        )
      ).status,
      200,
    );
    failRevocation = false;
    assert.equal(
      (await both("keys/key_fixture", undefined, session, "DELETE")).status,
      200,
    );
    assert.equal((await both("keys", undefined, session)).status, 200);
  } finally {
    Date.now = originalNow;
    globalThis.fetch = originalFetch;
    await source.dispose();
    await runtime.close();
    if (ownApp) await control.query("DROP SCHEMA app CASCADE");
    if (ownAuth) await control.query("DROP SCHEMA auth CASCADE");
    await control.end();
  }
});
