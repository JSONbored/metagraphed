import assert from "node:assert/strict";
import { test } from "vitest";
import worker from "../workers/data-api.ts";
import { dataApiEnv } from "./helpers/worker-env.ts";
import type { AccountStateStore } from "../src/account-state-store.ts";
import type { PgSql } from "../src/pg-sql.ts";
import { createSessionToken } from "../src/wallet-auth.ts";
import { applyTieredRateLimit } from "../workers/tiered-rate-limit.ts";
import { applyQuotaSpend } from "../src/daily-quota.ts";

function fixture() {
  const calls: { name: string; value: unknown }[] = [];
  const sql: PgSql = Object.assign(
    async <Row>(strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = strings.join("?");
      calls.push({ name: "sql", value: { text, values } });
      if (
        text.includes("SELECT account_id,reason_code") ||
        text.includes("SELECT account_kind, account_id")
      )
        return [] as Row[];
      if (text.includes("SELECT units_spent"))
        return [{ units_spent: 2 }] as Row[];
      if (text.includes("SELECT tier")) return [{ tier: "paid" }] as Row[];
      return [{ id: 1, github_login: "fixture", tier: "free" }] as Row[];
    },
    { unsafe: async <Row>() => [] as Row[] },
  );
  const state: AccountStateStore = {
    sql,
    usage: {
      async increment(value) {
        calls.push({ name: "increment", value });
      },
      async writeRollup(value) {
        calls.push({ name: "rollupWrite", value });
      },
      async accountRows(...value) {
        calls.push({ name: "accountRows", value });
        return [
          {
            day: "2026-11-04",
            route: "/fixture",
            request_count: 1,
            rejected_count: 0,
          },
        ];
      },
      async anomalyRows(value) {
        calls.push({ name: "anomalyRows", value });
        return [];
      },
      async rollupRows(...value) {
        calls.push({ name: "rollupRows", value });
        return [{ cost_shape: "edge", request_count: 1, keyed_count: 1 }];
      },
    },
    quota: {
      async spend(value) {
        calls.push({ name: "quota", value });
        return applyQuotaSpend(0, value.cost, value.limit, value.nowMs);
      },
    },
    blocks: {
      async read(...value) {
        calls.push({ name: "block", value });
        return {
          blocked: true,
          reasonCode: "abuse_manual",
          message: "blocked",
        };
      },
    },
  };
  const env = {
    ...dataApiEnv({
      API_KEY_LOOKUP_INTERNAL_TOKEN: "fixture-internal",
      API_KEY_BLOCK_INTERNAL_TOKEN: "fixture-block",
      WALLET_SESSION_SECRET: "fixture-session",
    }),
    ACCOUNT_STATE_STORE: state,
    CONTROL_KV_STORE: {
      async put() {
        calls.push({ name: "snapshot", value: null });
      },
      async get() {
        return null;
      },
      async delete() {},
      async list() {
        return { keys: [], list_complete: true };
      },
      async consume() {
        return null;
      },
    },
  };
  const ctx = { waitUntil() {} } as unknown as ExecutionContext;
  const request = (
    path: string,
    body?: object,
    headers: Record<string, string> = {},
  ) =>
    worker.fetch(
      new Request(`https://fixture.test/api/v1/${path}`, {
        method: body ? "POST" : "GET",
        headers: {
          ...(body ? { "content-type": "application/json" } : {}),
          ...headers,
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      }),
      env,
      ctx,
    );
  return { state, env, calls, request };
}

test("native account routes select complete usage, quota and identity capabilities", async () => {
  const f = fixture(),
    internal = { "x-api-key-lookup-token": "fixture-internal" };
  assert.equal(
    (
      await f.request(
        "auth/github/upsert-account",
        { github_user_id: 1, github_login: "fixture" },
        internal,
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await f.request(
        "internal/keys/usage",
        { account_id: 1, route: "/fixture" },
        internal,
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await f.request(
        "internal/keys/quota",
        { account_id: 1, cost: 1, limit: 10 },
        internal,
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await f.request(
        "internal/usage-rollup",
        {
          buckets: [
            null,
            {
              day: "2026-11-04",
              family: "fixture",
              cost_shape: "edge",
              request_count: 2,
              keyed_count: 1,
            },
          ],
        },
        internal,
      )
    ).status,
    200,
  );
  for (const group of ["family", "shape"])
    assert.equal(
      (
        await f.request(
          `internal/usage-rollup?group_by=${group}`,
          undefined,
          internal,
        )
      ).status,
      200,
    );
  assert.equal(
    (
      await f.request("internal/keys/anomalies", undefined, {
        "x-api-key-block-token": "fixture-block",
      })
    ).status,
    200,
  );
  const token = await createSessionToken("fixture-session", {
    accountId: 1,
    ss58: "fixture",
  });
  assert.equal(
    (
      await f.request("keys/usage", undefined, {
        authorization: `Bearer ${token}`,
      })
    ).status,
    200,
  );
  assert.equal(
    (await f.request("keys", undefined, { authorization: `Bearer ${token}` }))
      .status,
    200,
  );
  assert.equal(
    (
      await f.request(
        "internal/keys/block",
        { account_id: 1, reason_code: "abuse_manual", note: "fixture" },
        { "x-api-key-block-token": "fixture-block" },
      )
    ).status,
    200,
  );
  for (const name of [
    "increment",
    "quota",
    "rollupWrite",
    "rollupRows",
    "anomalyRows",
    "accountRows",
    "snapshot",
  ])
    assert.ok(
      f.calls.some((call) => call.name === name),
      name,
    );
});

test("malformed native account presence cannot restore another store", async () => {
  const f = fixture();
  const response = await worker.fetch(
    new Request("https://fixture.test/api/v1/auth/github/upsert-account", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key-lookup-token": "fixture-internal",
      },
      body: JSON.stringify({ github_user_id: 1, github_login: "fixture" }),
    }),
    { ...f.env, ACCOUNT_STATE_STORE: {} } as unknown as DataApiEnv,
    { waitUntil() {} } as unknown as ExecutionContext,
  );
  assert.equal(response.status, 502);
  assert.equal(f.calls.length, 0);
});

test("native account state supplies durable block authority to the request gate", async () => {
  const f = fixture();
  const result = await applyTieredRateLimit(
    new Request("https://fixture.test/api/v1/fixture"),
    f.env as unknown as Env,
    {
      anonymous: { envVar: "ANON", limit: 10, windowSeconds: 60 },
      keyed: { envVar: "KEYED", limit: 100, windowSeconds: 60 },
      keyPrefix: "fixture",
    },
    { oauthIdentity: { accountId: 1, tier: "paid" } },
  );
  assert.equal(result.allowed, false);
  assert.equal(f.calls.filter((call) => call.name === "block").length, 1);
});
