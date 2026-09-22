import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, test } from "vitest";
import { Miniflare } from "miniflare";
import { createD1Sql, createD1Store } from "../src/d1-store.ts";
import worker, {
  ACCOUNT_STATE_TABLES,
  ALERT_TRIGGER_TABLES,
  userStateRunner,
} from "../workers/data-api.ts";
import { dataApiEnv } from "./helpers/worker-env.ts";
import { jsonBody } from "./row-type.ts";
const runtime = new Miniflare({
  modules: true,
  script: "export default { fetch() { return new Response('test'); } }",
  compatibilityDate: "2026-06-06",
  d1Databases: ["DB"],
});
let db: D1Database;
const stamp = 1790080000000;
const ctx = {
  waitUntil() {},
  passThroughOnException() {},
} as unknown as ExecutionContext;
const token = "test-internal-token";
function env() {
  return dataApiEnv({
    D1_STATE: db,
    D1_STATE_TABLES: [...ACCOUNT_STATE_TABLES, ...ALERT_TRIGGER_TABLES].join(
      ",",
    ),
    HYPERDRIVE: { connectionString: "postgresql://must-not-be-used/invalid" },
    API_KEY_LOOKUP_INTERNAL_TOKEN: token,
    ALERT_TRIGGER_CREATE_TOKEN: token,
    ALERT_TRIGGERS_INTERNAL_TOKEN: token,
  });
}
function call(
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
  method = body === undefined ? "GET" : "POST",
) {
  return worker.fetch(
    new Request(`https://data.example.com${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        "x-api-key-lookup-token": token,
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    env(),
    ctx,
  );
}
beforeAll(async () => {
  db = await runtime.getD1Database("DB");
  for (const statement of readFileSync(
    new URL("../migrations/d1/0005_user_state.sql", import.meta.url),
    "utf8",
  ).split("-- statement-breakpoint"))
    if (statement.trim()) await db.prepare(statement).run();
  await db
    .prepare(
      "INSERT INTO rpc_accounts(id,ss58,created_at) VALUES (42,'test-public-account',?)",
    )
    .bind(stamp)
    .run();
});
afterAll(async () => {
  await runtime.dispose();
});

test("native tagged SQL binds in order, preserves imported sequences, and refuses owner drift", async () => {
  const sql = userStateRunner(env(), ctx, ACCOUNT_STATE_TABLES)!;
  const rows = await sql<{
    id: number;
    ss58: string;
  }>`INSERT INTO rpc_accounts(ss58,created_at) VALUES (${"second-public-account"},${stamp}) RETURNING id,ss58`;
  assert.deepEqual(rows, [{ id: 43, ss58: "second-public-account" }]);
  assert.deepEqual(
    await createD1Sql(createD1Store(db)).unsafe<{ n: number }>(
      "SELECT COUNT(*) AS n FROM rpc_accounts",
    ),
    [{ n: 2 }],
  );
  assert.deepEqual(
    await sql.unsafe<{ ss58: string }>(
      "SELECT ss58 FROM rpc_accounts WHERE id = ?",
      [42],
    ),
    [{ ss58: "test-public-account" }],
  );
  assert.throws(
    () =>
      userStateRunner(
        dataApiEnv({ ...env(), D1_STATE: undefined }),
        ctx,
        ACCOUNT_STATE_TABLES,
      ),
    /unbound/,
  );
  assert.throws(
    () => userStateRunner(env(), ctx, ["rpc_accounts", "neurons"]),
    /spans D1 and Neon/,
  );
});

test("GitHub upsert preserves identity and creation time across login changes", async () => {
  const first = await call("/api/v1/auth/github/upsert-account", {
    github_user_id: 501,
    github_login: "first-login",
  });
  assert.equal(first.status, 200);
  const a = await jsonBody(first);
  const stored = await db
    .prepare("SELECT created_at FROM github_accounts WHERE id = ?")
    .bind(a.id)
    .first();
  const second = await call("/api/v1/auth/github/upsert-account", {
    github_user_id: 501,
    github_login: "new-login",
  });
  assert.equal(second.status, 200);
  assert.deepEqual(await jsonBody(second), {
    id: a.id,
    github_login: "new-login",
    tier: "free",
  });
  assert.deepEqual(
    await db
      .prepare("SELECT created_at FROM github_accounts WHERE id = ?")
      .bind(a.id)
      .first(),
    stored,
  );
});

test("atomic quota spends reject without a debit and isolate overlapping account IDs", async () => {
  const spend = (account_kind: string, cost: number) =>
    call("/api/v1/internal/keys/quota", {
      account_id: 42,
      account_kind,
      cost,
      limit: 10,
    });
  const [a, b] = await Promise.all([spend("rpc", 6), spend("rpc", 6)]);
  const bodies = await Promise.all([jsonBody(a), jsonBody(b)]);
  assert.equal(bodies.filter((x) => x.allowed).length, 1);
  assert.ok(bodies.every((x) => x.used === 6));
  assert.equal((await jsonBody(await spend("github", 9))).allowed, true);
  assert.equal((await jsonBody(await spend("github", 2))).allowed, false);
  assert.deepEqual(
    (
      await db
        .prepare(
          "SELECT account_kind,units_spent FROM api_quota_daily ORDER BY account_kind",
        )
        .all()
    ).results,
    [
      { account_kind: "github", units_spent: 9 },
      { account_kind: "rpc", units_spent: 6 },
    ],
  );
});

test("usage counters accumulate with account-kind isolation and preserve rollup totals", async () => {
  for (const [account_kind, rejected] of [
    ["rpc", false],
    ["rpc", true],
    ["github", false],
  ] as const)
    assert.equal(
      (
        await call("/api/v1/internal/keys/usage", {
          account_id: 42,
          account_kind,
          route: "/api/v1/blocks",
          rejected,
        })
      ).status,
      200,
    );
  assert.deepEqual(
    (
      await db
        .prepare(
          "SELECT account_kind,request_count,rejected_count FROM api_key_usage_daily ORDER BY account_kind",
        )
        .all()
    ).results,
    [
      { account_kind: "github", request_count: 1, rejected_count: 0 },
      { account_kind: "rpc", request_count: 1, rejected_count: 1 },
    ],
  );
  for (const request_count of [7, 9])
    assert.equal(
      (
        await call("/api/v1/internal/usage-rollup", {
          buckets: [
            {
              day: "2026-09-22",
              family: "/api/v1/blocks",
              cost_shape: "lookup",
              request_count,
              keyed_count: 2,
            },
          ],
        })
      ).status,
      200,
    );
  assert.deepEqual(
    await db
      .prepare("SELECT request_count,keyed_count FROM api_usage_rollup")
      .first(),
    { request_count: 16, keyed_count: 4 },
  );
});

test("key revocation intent remains authoritative in the native ledger", async () => {
  await db
    .prepare(
      "INSERT INTO api_keys(owner_contact,created_at,account_id,unkey_key_id) VALUES (?,?,?,?)",
    )
    .bind("test@example.com", stamp, 42, "key_test_native_ledger")
    .run();
  const state = () =>
    call("/api/v1/internal/keys/state", {
      keyId: "key_test_native_ledger",
      accountId: 42,
    });
  assert.deepEqual(await jsonBody(await state()), { state: "active" });
  await db
    .prepare(
      "UPDATE api_keys SET revocation_requested_at=? WHERE account_id=42",
    )
    .bind(stamp + 1)
    .run();
  assert.deepEqual(await jsonBody(await state()), { state: "pending" });
});

test("alert routes preserve JSON filters and false booleans; delivery FKs cascade", async () => {
  const response = await call(
    "/api/v1/alerts/triggers",
    {
      channel: "email",
      destination: "test@example.com",
      active: false,
      netuid: 7,
      table_filter: ["account_events"],
    },
    { "x-alert-trigger-create-token": token },
  );
  assert.equal(response.status, 201, await response.clone().text());
  const created = await jsonBody(response);
  assert.equal(created.active, false);
  assert.deepEqual(created.table_filter, ["account_events"]);
  const headers = { "x-alert-trigger-owner-token": created.owner_token };
  const read = await call(
    `/api/v1/alerts/triggers/${created.id}`,
    undefined,
    headers,
  );
  assert.equal(read.status, 200);
  assert.equal((await jsonBody(read)).active, false);
  await db
    .prepare(
      "INSERT INTO chain_alert_deliveries(trigger_id,delivered_at,success) VALUES (?,?,?)",
    )
    .bind(Number(created.id), stamp, 1)
    .run();
  const deleted = await call(
    `/api/v1/alerts/triggers/${created.id}`,
    undefined,
    headers,
    "DELETE",
  );
  assert.equal(deleted.status, 200);
  assert.equal(
    await db
      .prepare("SELECT COUNT(*) AS n FROM chain_alert_deliveries")
      .first("n"),
    0,
  );
  await assert.rejects(
    db
      .prepare(
        "INSERT INTO chain_alert_deliveries(trigger_id,delivered_at,success) VALUES (999,?,1)",
      )
      .bind(stamp)
      .run(),
    /FOREIGN KEY/,
  );
  await assert.rejects(
    db
      .prepare(
        "INSERT INTO api_quota_daily(account_kind,account_id,day,updated_at) VALUES ('unknown',1,'2026-09-22',?)",
      )
      .bind(stamp)
      .run(),
    /CHECK/,
  );
});
