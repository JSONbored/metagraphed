// The user-state D1 port (accounts, API keys, usage accounting, alert
// triggers, push subscriptions, TAO/USD index), exercised END TO END against
// a REAL SQLite database built from migrations/d1/0004_user_state.sql --
// same rationale as tests/observations-d1-sqlite.test.ts: the route-level
// queue fakes record SQL but never parse it, and the riskiest constructs
// here (guarded upserts against partial unique indexes, ON CONFLICT WHERE
// clauses, the delivery-retention prune's LIMIT subquery, RETURNING on
// writes) only fail at execution. node:sqlite keeps this dependency-free.
//
// Every request below goes through the real Worker fetch handler, so what is
// under test is the full ported path: createD1Sql's tagged-template runner
// and bind coercion, the per-statement SQLite dialect, and the read-site
// normalisation (JSON TEXT columns parsed, INTEGER 0/1 booleans coerced).
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, test, vi } from "vitest";
import {
  getPublicKey,
  secretFromSeed,
  sign as sr25519Sign,
} from "@scure/sr25519";
import { encodeAccountId32 } from "../src/ss58.ts";
import { createSessionToken, createTriggerToken } from "../src/wallet-auth.ts";
import type { Row } from "./row-type.ts";

const {
  default: worker,
  writeTaoUsdIndexRow,
  createD1Sql,
} = await import("../workers/data-api.ts");

const SCHEMA = fs.readFileSync(
  path.join(process.cwd(), "migrations/d1/0004_user_state.sql"),
  "utf8",
);

let db: InstanceType<typeof DatabaseSync>;

/** The runner's whole D1 surface -- prepare(text).bind(...).all() -- backed
 * by the real schema. node:sqlite's .all() works on every statement form the
 * port issues (SELECTs, writes with RETURNING, and plain writes, which yield
 * []). */
function d1() {
  return {
    prepare(text: string) {
      return {
        bind(...values: unknown[]) {
          return {
            async all() {
              return { results: db.prepare(text).all(...(values as never[])) };
            },
          };
        },
      };
    },
  };
}

function createFakeKv() {
  const store = new Map<string, string>();
  return {
    store,
    async get(key: string) {
      return store.has(key) ? store.get(key) : null;
    },
    async put(key: string, value: string) {
      store.set(key, value);
    },
    async delete(key: string) {
      store.delete(key);
    },
  };
}

const CREATE_TOKEN = "test-create-token";
const INTERNAL_TOKEN = "test-internal-token";
const WATCH_SECRET = "test-watch-secret";
const SESSION_SECRET = "test-session-secret";
const LOOKUP_TOKEN = "test-lookup-token";
const PROMOTE_TOKEN = "test-promote-token";
const BLOCK_TOKEN = "test-block-token";
const SS58 = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";

let kv: ReturnType<typeof createFakeKv>;

function env(overrides: Record<string, unknown> = {}): Env {
  return {
    METAGRAPH_HEALTH_DB: d1(),
    METAGRAPH_CONTROL: kv,
    ALERT_TRIGGER_CREATE_TOKEN: CREATE_TOKEN,
    ALERT_TRIGGERS_INTERNAL_TOKEN: INTERNAL_TOKEN,
    WATCH_TRIGGER_TOKEN_SECRET: WATCH_SECRET,
    WALLET_SESSION_SECRET: SESSION_SECRET,
    API_KEY_LOOKUP_INTERNAL_TOKEN: LOOKUP_TOKEN,
    ACCOUNT_TIER_PROMOTE_INTERNAL_TOKEN: PROMOTE_TOKEN,
    API_KEY_BLOCK_INTERNAL_TOKEN: BLOCK_TOKEN,
    UNKEY_ROOT_KEY: "test-root-key",
    UNKEY_API_ID: "api_test",
    ...overrides,
  } as unknown as Env;
}

function req(
  urlPath: string,
  {
    method = "GET",
    headers = {},
    body,
  }: { method?: string; headers?: Record<string, string>; body?: unknown } = {},
) {
  return new Request(`https://d${urlPath}`, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

async function call(request: Request, envOverride: Env = env()) {
  return worker.fetch(request, envOverride, {} as unknown as ExecutionContext);
}

function stubUnkeyFetch(data: Row = {}) {
  vi.stubGlobal("fetch", async () => ({
    ok: true,
    status: 200,
    json: async () => ({ data }),
  }));
}

const one = (sql: string, ...params: unknown[]) =>
  db.prepare(sql).get(...(params as never[])) as Row;
const count = (t: string) =>
  (db.prepare(`SELECT COUNT(*) n FROM ${t}`).get() as { n: number }).n;

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  db.exec(SCHEMA);
  kv = createFakeKv();
});
afterEach(() => vi.unstubAllGlobals());

// --- alert triggers: full CRUD against the real schema ----------------------

async function createTrigger(body: Row = {}) {
  const res = await call(
    req("/api/v1/alerts/triggers", {
      method: "POST",
      headers: { "x-alert-trigger-create-token": CREATE_TOKEN },
      body: {
        channel: "email",
        destination: "a@b.com",
        netuid: 7,
        ...body,
      },
    }),
  );
  return { res, body: (await res.json()) as Row };
}

test("trigger create: inserts the row with JSON-text columns and 0/1 active, and echoes the parsed view", async () => {
  const condition = {
    metric: "subnet_alpha_price_rank",
    operator: "gt",
    threshold: 100,
  };
  const { res, body } = await createTrigger({
    name: "watcher",
    table_filter: ["account_events"],
    condition,
  });
  assert.equal(res.status, 201);
  assert.equal(body.id, "1");
  assert.deepEqual(body.condition, condition);
  assert.deepEqual(body.table_filter, ["account_events"]);
  assert.equal(body.active, true);
  assert.match(String(body.owner_token), /^[0-9a-f]{64}$/);

  const stored = one("SELECT * FROM chain_alert_triggers");
  assert.equal(stored.active, 1, "boolean bound as INTEGER 1");
  assert.equal(stored.table_filter, '["account_events"]');
  assert.deepEqual(JSON.parse(String(stored.condition)), condition);
});

test("trigger get/patch: the stored JSON text round-trips through the merge and the owner view", async () => {
  const condition = {
    metric: "neuron_immunity_countdown_blocks",
    operator: "lte",
    threshold: 500,
  };
  const { body: created } = await createTrigger({ condition, name: "n1" });
  const ownerToken = String(created.owner_token);

  const got = await call(
    req("/api/v1/alerts/triggers/1", {
      headers: { "x-alert-trigger-owner-token": ownerToken },
    }),
  );
  assert.equal(got.status, 200);
  assert.deepEqual(((await got.json()) as Row).condition, condition);

  // A rename-only PATCH must keep condition/netuid -- the existing row's
  // TEXT columns are parsed for the merge, then re-stringified for the bind.
  const patched = await call(
    req("/api/v1/alerts/triggers/1", {
      method: "PATCH",
      headers: { "x-alert-trigger-owner-token": ownerToken },
      body: { name: "renamed" },
    }),
  );
  assert.equal(patched.status, 200);
  const patchedBody = (await patched.json()) as Row;
  assert.equal(patchedBody.name, "renamed");
  assert.deepEqual(patchedBody.condition, condition);
  assert.equal(patchedBody.netuid, 7);
  assert.deepEqual(
    JSON.parse(
      String(one("SELECT condition FROM chain_alert_triggers").condition),
    ),
    condition,
  );
});

test("trigger patch: pausing stores active=0 and reads back as false", async () => {
  const { body: created } = await createTrigger();
  const patched = await call(
    req("/api/v1/alerts/triggers/1", {
      method: "PATCH",
      headers: { "x-alert-trigger-owner-token": String(created.owner_token) },
      body: { active: false },
    }),
  );
  assert.equal(patched.status, 200);
  assert.equal(((await patched.json()) as Row).active, false);
  assert.equal(one("SELECT active FROM chain_alert_triggers").active, 0);
});

test("trigger delete: removes the row", async () => {
  const { body: created } = await createTrigger();
  const res = await call(
    req("/api/v1/alerts/triggers/1", {
      method: "DELETE",
      headers: { "x-alert-trigger-owner-token": String(created.owner_token) },
    }),
  );
  assert.equal(res.status, 200);
  assert.equal(count("chain_alert_triggers"), 0);
});

test("unparseable stored JSON degrades to null at the read site, never a 502", async () => {
  // Writers stringify, so this only happens to a manually-corrupted row --
  // the read must shrug, not take the route down.
  db.prepare(
    `INSERT INTO chain_alert_triggers
       (owner_token, condition, table_filter, channel, destination, active, created_at, updated_at)
     VALUES ('tok', 'not json', 'also not json', 'email', 'a@b.com', 1, 1, 1)`,
  ).run();
  const res = await call(
    req("/api/v1/alerts/triggers/1", {
      headers: { "x-alert-trigger-owner-token": "tok" },
    }),
  );
  assert.equal(res.status, 200);
  const body = (await res.json()) as Row;
  assert.equal(body.condition, null);
  assert.equal(body.table_filter, null);
});

test("watch-token create: the per-address cap counts only active triggers via `WHERE ... AND active`", async () => {
  const token = await createTriggerToken(WATCH_SECRET, { ss58: SS58 });
  const insert = db.prepare(
    `INSERT INTO chain_alert_triggers
       (owner_token, channel, destination, owner_ss58, active, created_at, updated_at)
     VALUES (?, 'email', 'a@b.com', ?, ?, 1, 1)`,
  );
  for (let i = 0; i < 5; i += 1) insert.run(`t${i}`, SS58, 1);
  const capped = await call(
    req("/api/v1/alerts/triggers", {
      method: "POST",
      headers: { "x-watch-trigger-token": token },
      body: { channel: "email", destination: "a@b.com", netuid: 7 },
    }),
  );
  assert.equal(capped.status, 403);

  // Pausing one frees a slot -- the COUNT filter is on active, not existence.
  db.prepare("UPDATE chain_alert_triggers SET active = 0 WHERE id = 1").run();
  const allowed = await call(
    req("/api/v1/alerts/triggers", {
      method: "POST",
      headers: { "x-watch-trigger-token": token },
      body: { channel: "email", destination: "a@b.com", netuid: 7 },
    }),
  );
  assert.equal(allowed.status, 201);
  assert.equal(((await allowed.json()) as Row).owner_ss58, SS58);
});

test("watch routes: list newest-first with parsed views, update scoped to the owner address, delete removes", async () => {
  const token = await createTriggerToken(WATCH_SECRET, { ss58: SS58 });
  db.prepare(
    `INSERT INTO chain_alert_triggers
       (owner_token, channel, destination, owner_ss58, table_filter, active, created_at, updated_at)
     VALUES ('t1', 'email', 'a@b.com', ?, '["transfers"]', 1, 100, 100)`,
  ).run(SS58);
  db.prepare(
    `INSERT INTO chain_alert_triggers
       (owner_token, channel, destination, owner_ss58, active, created_at, updated_at)
     VALUES ('t2', 'email', 'b@b.com', 'someone-else', 1, 200, 200)`,
  ).run();

  const list = await call(
    req("/api/v1/watch/triggers", {
      headers: { "x-watch-trigger-token": token },
    }),
  );
  assert.equal(list.status, 200);
  const triggers = ((await list.json()) as Row).triggers as Row[];
  assert.equal(triggers.length, 1, "only the verified address' own triggers");
  assert.deepEqual(triggers[0].table_filter, ["transfers"]);

  const foreignPatch = await call(
    req("/api/v1/watch/triggers/2", {
      method: "PATCH",
      headers: { "x-watch-trigger-token": token },
      body: { name: "hijack" },
    }),
  );
  assert.equal(foreignPatch.status, 404, "another address' trigger is a 404");

  const del = await call(
    req("/api/v1/watch/triggers/1", {
      method: "DELETE",
      headers: { "x-watch-trigger-token": token },
    }),
  );
  assert.equal(del.status, 200);
  assert.equal(count("chain_alert_triggers"), 1);
});

test("evaluator scan: WHERE active filters paused rows and the view parses table_filter/condition", async () => {
  db.prepare(
    `INSERT INTO chain_alert_triggers
       (owner_token, channel, destination, table_filter, condition, active, created_at, updated_at)
     VALUES ('t1', 'email', 'a@b.com', '["account_events"]',
             '{"metric":"subnet_alpha_price_rank","operator":"gt","threshold":9}', 1, 1, 1)`,
  ).run();
  db.prepare(
    `INSERT INTO chain_alert_triggers
       (owner_token, channel, destination, active, created_at, updated_at)
     VALUES ('t2', 'email', 'b@b.com', 0, 1, 1)`,
  ).run();
  const res = await call(
    req("/api/v1/internal/alert-triggers-active", {
      headers: { "x-alert-triggers-internal-token": INTERNAL_TOKEN },
    }),
  );
  assert.equal(res.status, 200);
  const triggers = ((await res.json()) as Row).triggers as Row[];
  assert.equal(triggers.length, 1, "the paused trigger is not scanned");
  assert.deepEqual(triggers[0].tableFilter, ["account_events"]);
  assert.equal((triggers[0].condition as Row).threshold, 9);
});

test("matched write-back: the expanded IN list updates exactly the named rows", async () => {
  const insert = db.prepare(
    `INSERT INTO chain_alert_triggers
       (owner_token, channel, destination, active, created_at, updated_at)
     VALUES (?, 'email', 'a@b.com', 1, 1, 1)`,
  );
  insert.run("t1");
  insert.run("t2");
  insert.run("t3");
  const res = await call(
    req("/api/v1/internal/alert-triggers/matched", {
      method: "POST",
      headers: { "x-alert-triggers-internal-token": INTERNAL_TOKEN },
      body: { trigger_ids: ["1", "3", "999"] },
    }),
  );
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { updated: 2 });
  assert.equal(
    one("SELECT match_count FROM chain_alert_triggers WHERE id = 1")
      .match_count,
    1,
  );
  assert.equal(
    one("SELECT match_count FROM chain_alert_triggers WHERE id = 2")
      .match_count,
    0,
  );
  assert.ok(
    one("SELECT last_matched_at FROM chain_alert_triggers WHERE id = 3")
      .last_matched_at,
  );
});

test("delivery log: inserts land with 0/1 success and the prune retains the newest 20 per trigger", async () => {
  db.prepare(
    `INSERT INTO chain_alert_triggers
       (owner_token, channel, destination, active, created_at, updated_at)
     VALUES ('t1', 'email', 'a@b.com', 1, 1, 1)`,
  ).run();
  const records = Array.from({ length: 25 }, (_, i) => ({
    trigger_id: "1",
    delivered_at: 1_700_000_000_000 + i,
    success: i % 2 === 0,
    status_code: 200,
  }));
  const res = await call(
    req("/api/v1/internal/alert-triggers/deliveries", {
      method: "POST",
      headers: { "x-alert-triggers-internal-token": INTERNAL_TOKEN },
      body: { records },
    }),
  );
  assert.equal(res.status, 200);
  assert.equal(count("chain_alert_deliveries"), 20, "pruned to retention");
  assert.equal(
    one("SELECT MIN(delivered_at) m FROM chain_alert_deliveries").m,
    1_700_000_000_005,
    "the oldest five were pruned",
  );

  // The owner-facing history parses success back to a real boolean.
  const token = await createTriggerToken(WATCH_SECRET, { ss58: SS58 });
  db.prepare("UPDATE chain_alert_triggers SET owner_ss58 = ? WHERE id = 1").run(
    SS58,
  );
  const history = await call(
    req("/api/v1/watch/triggers/1/deliveries", {
      headers: { "x-watch-trigger-token": token },
    }),
  );
  assert.equal(history.status, 200);
  const deliveries = ((await history.json()) as Row).deliveries as Row[];
  assert.equal(deliveries.length, 20);
  assert.equal(typeof deliveries[0].success, "boolean");
  assert.equal(
    deliveries[0].success,
    true,
    "delivered_at ...024 is an even index",
  );
});

// --- push subscriptions ------------------------------------------------------

const P256DH = Buffer.from([
  4,
  ...Array.from({ length: 64 }, (_, i) => i + 1),
]).toString("base64url");
const AUTH_KEY = Buffer.from(Array.from({ length: 16 }, (_, i) => i)).toString(
  "base64url",
);
const ENDPOINT = "https://push.example.com/send/abc";

async function subscribePush(overrides: Row = {}, ss58 = SS58) {
  const token = await createTriggerToken(WATCH_SECRET, { ss58 });
  return call(
    req("/api/v1/watch/push-subscriptions", {
      method: "POST",
      headers: { "x-watch-trigger-token": token },
      body: {
        endpoint: ENDPOINT,
        p256dh: P256DH,
        auth: AUTH_KEY,
        user_agent: "TestBrowser",
        ...overrides,
      },
    }),
  );
}

test("push subscribe: inserts, re-subscribing the same endpoint updates in place, another address gets 409", async () => {
  const created = await subscribePush();
  assert.equal(created.status, 201);
  assert.equal(count("watch_push_subscriptions"), 1);
  assert.equal(
    one("SELECT p256dh FROM watch_push_subscriptions").p256dh,
    P256DH,
  );

  // Same owner, rotated keys: the ON CONFLICT ... WHERE address = excluded
  // upsert fires and the RETURNING row comes back -- no duplicate device.
  const rotated = Buffer.from([
    4,
    ...Array.from({ length: 64 }, () => 9),
  ]).toString("base64url");
  const resub = await subscribePush({ p256dh: rotated });
  assert.equal(resub.status, 201);
  assert.equal(count("watch_push_subscriptions"), 1, "updated, not duplicated");
  assert.equal(
    one("SELECT p256dh FROM watch_push_subscriptions").p256dh,
    rotated,
  );

  // A different verified address presenting the SAME endpoint must not
  // silently take the device over.
  const foreign = await subscribePush(
    {},
    "5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty",
  );
  assert.equal(foreign.status, 409);
});

test("push subscribe: the device cap counts existing rows via COUNT(*)", async () => {
  for (let i = 0; i < 3; i += 1) {
    const res = await subscribePush({ endpoint: `${ENDPOINT}${i}` });
    assert.equal(res.status, 201);
  }
  const fourth = await subscribePush({ endpoint: `${ENDPOINT}-extra` });
  assert.equal(fourth.status, 409);
  assert.equal(count("watch_push_subscriptions"), 3);
});

test("push list + delete: owner-scoped metadata without key material, delete scoped by address", async () => {
  await subscribePush();
  const token = await createTriggerToken(WATCH_SECRET, { ss58: SS58 });
  const list = await call(
    req("/api/v1/watch/push-subscriptions", {
      headers: { "x-watch-trigger-token": token },
    }),
  );
  assert.equal(list.status, 200);
  const listBody = (await list.json()) as Row;
  const subs = listBody.subscriptions as Row[];
  assert.equal(subs.length, 1);
  assert.ok(!("p256dh" in subs[0]), "key material never leaves via the list");
  assert.equal(subs[0].user_agent, "TestBrowser");

  const otherToken = await createTriggerToken(WATCH_SECRET, {
    ss58: "5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty",
  });
  const foreignDelete = await call(
    req(`/api/v1/watch/push-subscriptions/${subs[0].id}`, {
      method: "DELETE",
      headers: { "x-watch-trigger-token": otherToken },
    }),
  );
  assert.equal(foreignDelete.status, 404, "another address' id is a 404");

  const del = await call(
    req(`/api/v1/watch/push-subscriptions/${subs[0].id}`, {
      method: "DELETE",
      headers: { "x-watch-trigger-token": token },
    }),
  );
  assert.equal(del.status, 200);
  assert.equal(count("watch_push_subscriptions"), 0);
});

test("internal push resolve: returns the key material, stamps last_used_at, and the prune is idempotent", async () => {
  await subscribePush();
  const res = await call(
    req(
      `/api/v1/internal/push-subscription?endpoint=${encodeURIComponent(ENDPOINT)}`,
      { headers: { "x-alert-triggers-internal-token": INTERNAL_TOKEN } },
    ),
  );
  assert.equal(res.status, 200);
  const sub = ((await res.json()) as Row).subscription as Row;
  assert.equal(sub.p256dh, P256DH);
  assert.equal(sub.auth, AUTH_KEY);
  assert.ok(
    one("SELECT last_used_at FROM watch_push_subscriptions").last_used_at,
  );

  const prune = await call(
    req("/api/v1/internal/push-subscription", {
      method: "DELETE",
      headers: { "x-alert-triggers-internal-token": INTERNAL_TOKEN },
      body: { endpoint: ENDPOINT },
    }),
  );
  assert.equal(prune.status, 200);
  assert.equal(count("watch_push_subscriptions"), 0);
  // Pruning an already-pruned device is a success, not a 404.
  const again = await call(
    req("/api/v1/internal/push-subscription", {
      method: "DELETE",
      headers: { "x-alert-triggers-internal-token": INTERNAL_TOKEN },
      body: { endpoint: ENDPOINT },
    }),
  );
  assert.equal(again.status, 200);
});

// --- accounts: wallet login + github upsert ----------------------------------

test("wallet verify: first login inserts rpc_accounts, second login updates last_login_at in place", async () => {
  const seed = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
  const secretKey = secretFromSeed(seed);
  const ss58 = encodeAccountId32(getPublicKey(secretKey))!;
  const testEnv = env();

  for (let round = 0; round < 2; round += 1) {
    const challengeRes = await call(
      req("/api/v1/auth/wallet/challenge", { method: "POST", body: { ss58 } }),
      testEnv,
    );
    assert.equal(challengeRes.status, 200);
    const { message } = (await challengeRes.json()) as Row;
    const signature = [
      ...sr25519Sign(secretKey, new TextEncoder().encode(String(message))),
    ]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    const verifyRes = await call(
      req("/api/v1/auth/wallet/verify", {
        method: "POST",
        body: { ss58, signature },
      }),
      testEnv,
    );
    assert.equal(verifyRes.status, 200);
    const body = (await verifyRes.json()) as Row;
    assert.ok(body.session_token);
    assert.deepEqual(body.account, { ss58, tier: "free" });
  }
  assert.equal(count("rpc_accounts"), 1, "upserted on ss58, not duplicated");
});

test("github upsert: conflicts on github_user_id and refreshes the login", async () => {
  const first = await call(
    req("/api/v1/auth/github/upsert-account", {
      method: "POST",
      headers: { "x-api-key-lookup-token": LOOKUP_TOKEN },
      body: { github_user_id: 42, github_login: "octocat" },
    }),
  );
  assert.equal(first.status, 200);
  const firstBody = (await first.json()) as Row;
  assert.equal(firstBody.github_login, "octocat");

  const second = await call(
    req("/api/v1/auth/github/upsert-account", {
      method: "POST",
      headers: { "x-api-key-lookup-token": LOOKUP_TOKEN },
      body: { github_user_id: 42, github_login: "octocat-renamed" },
    }),
  );
  const secondBody = (await second.json()) as Row;
  assert.equal(secondBody.id, firstBody.id, "same row");
  assert.equal(secondBody.github_login, "octocat-renamed");
  assert.equal(count("github_accounts"), 1);
});

// --- API keys: mint / list / revoke / verify ---------------------------------

function seedAccount(id: number, ss58: string, tier = "free") {
  db.prepare(
    "INSERT INTO rpc_accounts (id, ss58, tier, created_at) VALUES (?, ?, ?, 1)",
  ).run(id, ss58, tier);
}

test("keys: mint writes the bookkeeping row, list reads it back, revoke stamps revoked_at", async () => {
  seedAccount(11, "5Minter");
  const token = await createSessionToken(SESSION_SECRET, {
    accountId: 11,
    ss58: "5Minter",
  });
  stubUnkeyFetch({ keyId: "key_abc", key: "mg_secret" });
  const minted = await call(
    req("/api/v1/keys", {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    }),
  );
  assert.equal(minted.status, 201);
  const stored = one("SELECT * FROM api_keys");
  assert.equal(stored.unkey_key_id, "key_abc");
  assert.equal(stored.account_id, 11);
  assert.equal(stored.owner_contact, "5Minter");

  const list = await call(
    req("/api/v1/keys", { headers: { authorization: `Bearer ${token}` } }),
  );
  const keys = ((await list.json()) as Row).keys as Row[];
  assert.equal(keys.length, 1);
  assert.equal(keys[0].key_id, "key_abc");
  assert.equal(keys[0].revoked_at, null);

  stubUnkeyFetch({});
  const revoked = await call(
    req("/api/v1/keys/key_abc", {
      method: "DELETE",
      headers: { authorization: `Bearer ${token}` },
    }),
  );
  assert.equal(revoked.status, 200);
  assert.ok(one("SELECT revoked_at FROM api_keys").revoked_at);

  // A second revoke finds no live row -- the ownership SELECT filters
  // `revoked_at IS NULL`.
  const again = await call(
    req("/api/v1/keys/key_abc", {
      method: "DELETE",
      headers: { authorization: `Bearer ${token}` },
    }),
  );
  assert.equal(again.status, 404);
});

test("internal verify: a valid key bumps last_used_at best-effort", async () => {
  seedAccount(11, "5Minter");
  db.prepare(
    "INSERT INTO api_keys (unkey_key_id, owner_contact, account_id, created_at) VALUES ('key_v', '5Minter', 11, 1)",
  ).run();
  vi.stubGlobal("fetch", async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      data: {
        valid: true,
        code: "VALID",
        keyId: "key_v",
        meta: { tier: "free" },
      },
    }),
  }));
  const res = await call(
    req("/api/v1/internal/keys/verify", {
      method: "POST",
      headers: { "x-api-key-lookup-token": LOOKUP_TOKEN },
      body: { key: "mg_real" },
    }),
  );
  assert.equal(res.status, 200);
  // The bump is fired without being awaited by the handler -- settle it.
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.ok(one("SELECT last_used_at FROM api_keys").last_used_at);
});

// --- usage accounting: daily counters, quota, rollup -------------------------

async function incrementUsage(body: Row) {
  return call(
    req("/api/v1/internal/keys/usage", {
      method: "POST",
      headers: { "x-api-key-lookup-token": LOOKUP_TOKEN },
      body: { account_id: 7, route: "chain-events", ...body },
    }),
  );
}

test("usage increment: the upsert accumulates request_count and rejected_count per (account, day, route)", async () => {
  await incrementUsage({});
  await incrementUsage({});
  await incrementUsage({ rejected: true });
  const stored = one("SELECT * FROM api_key_usage_daily");
  assert.equal(count("api_key_usage_daily"), 1, "one row per key triple");
  assert.equal(stored.request_count, 2);
  assert.equal(stored.rejected_count, 1);
});

async function spendQuota(cost: number, limit: number) {
  const res = await call(
    req("/api/v1/internal/keys/quota", {
      method: "POST",
      headers: { "x-api-key-lookup-token": LOOKUP_TOKEN },
      body: { account_id: 7, cost, limit },
    }),
  );
  return (await res.json()) as Row;
}

test("quota spend: the guarded upsert banks in-limit spends and leaves the counter untouched on a reject", async () => {
  assert.deepEqual(
    await spendQuota(400, 1000).then((b) => [b.allowed, b.used]),
    [true, 400],
    "first spend of the day inserts",
  );
  assert.deepEqual(
    await spendQuota(500, 1000).then((b) => [b.allowed, b.used]),
    [true, 900],
    "the conflict path accumulates",
  );
  const rejected = await spendQuota(200, 1000);
  assert.equal(rejected.allowed, false);
  assert.equal(rejected.used, 900, "the rejected spend banked nothing");
  assert.equal(rejected.remaining, 100);
  assert.equal(
    one("SELECT units_spent FROM api_quota_daily").units_spent,
    900,
    "the counter is exactly the two allowed spends",
  );
});

test("quota spend: a single request over the whole day's limit never reaches the database", async () => {
  const body = await spendQuota(5000, 1000);
  assert.equal(body.allowed, false);
  assert.equal(count("api_quota_daily"), 0);
});

test("usage rollup: increments accumulate and both read groupings aggregate in SQL", async () => {
  const post = (buckets: Row[]) =>
    call(
      req("/api/v1/internal/usage-rollup", {
        method: "POST",
        headers: { "x-api-key-lookup-token": LOOKUP_TOKEN },
        body: { buckets },
      }),
    );
  const day = new Date().toISOString().slice(0, 10);
  await post([
    {
      day,
      family: "/api/v1/subnets/{netuid}",
      cost_shape: "edge",
      request_count: 12,
      keyed_count: 3,
    },
  ]);
  await post([
    {
      day,
      family: "/api/v1/subnets/{netuid}",
      cost_shape: "edge",
      request_count: 8,
      keyed_count: 1,
    },
    {
      day,
      family: "/api/v1/chain-events",
      cost_shape: "postgres",
      request_count: 5,
      keyed_count: 5,
    },
  ]);
  assert.equal(
    one("SELECT request_count FROM api_usage_rollup WHERE cost_shape = 'edge'")
      .request_count,
    20,
  );

  const byFamily = await call(
    req("/api/v1/internal/usage-rollup", {
      headers: { "x-api-key-lookup-token": LOOKUP_TOKEN },
    }),
  );
  const familyBody = (await byFamily.json()) as Row;
  assert.equal(familyBody.total_requests, 25);
  assert.equal(familyBody.total_keyed, 9);
  assert.equal(
    (familyBody.rows as Row[])[0].route_family,
    "/api/v1/subnets/{netuid}",
  );

  const byShape = await call(
    req("/api/v1/internal/usage-rollup?group_by=shape", {
      headers: { "x-api-key-lookup-token": LOOKUP_TOKEN },
    }),
  );
  const shapeBody = (await byShape.json()) as Row;
  assert.equal((shapeBody.rows as Row[]).length, 2);
  assert.ok(!("route_family" in (shapeBody.rows as Row[])[0]));
});

test("keys usage dashboard: aggregates the account's own rows and reads quota headroom from the enforcement table", async () => {
  seedAccount(7, "5Abc", "paid");
  const day = new Date().toISOString().slice(0, 10);
  db.prepare(
    "INSERT INTO api_key_usage_daily (account_id, day, route, request_count, rejected_count) VALUES (7, ?, 'mcp', 40, 3)",
  ).run(day);
  db.prepare(
    "INSERT INTO api_quota_daily (account_id, day, units_spent, updated_at) VALUES (7, ?, 250, 1)",
  ).run(day);
  const token = await createSessionToken(SESSION_SECRET, {
    accountId: 7,
    ss58: "5Abc",
  });
  const res = await call(
    req("/api/v1/keys/usage", {
      headers: { authorization: `Bearer ${token}` },
    }),
  );
  assert.equal(res.status, 200);
  const body = (await res.json()) as Row;
  assert.equal(body.tier, "paid");
  assert.deepEqual(body.days, [{ day, count: 40, rejected: 3 }]);
  assert.equal((body.quota as Row).units_spent, 250);
  assert.equal((body.quota as Row).remaining, 2_000_000 - 250);
});

// --- tier promote + abuse controls -------------------------------------------

test("tier promote: updates the account row and every unrevoked key row", async () => {
  seedAccount(9, "5Promote");
  db.prepare(
    "INSERT INTO api_keys (unkey_key_id, owner_contact, account_id, tier, created_at) VALUES ('key_1', '5Promote', 9, 'free', 1)",
  ).run();
  db.prepare(
    "INSERT INTO api_keys (unkey_key_id, owner_contact, account_id, tier, created_at, revoked_at) VALUES ('key_2', '5Promote', 9, 'free', 1, 2)",
  ).run();
  stubUnkeyFetch({});
  const res = await call(
    req("/api/v1/internal/accounts/tier", {
      method: "POST",
      headers: { "x-account-tier-promote-token": PROMOTE_TOKEN },
      body: { ss58: "5Promote", tier: "paid" },
    }),
  );
  assert.equal(res.status, 200);
  const body = (await res.json()) as Row;
  assert.equal(body.keys_updated, 1, "only the live key");
  assert.equal(one("SELECT tier FROM rpc_accounts").tier, "paid");
  assert.equal(
    one("SELECT tier FROM api_keys WHERE unkey_key_id = 'key_1'").tier,
    "paid",
  );
  assert.equal(
    one("SELECT tier FROM api_keys WHERE unkey_key_id = 'key_2'").tier,
    "free",
    "a revoked key keeps its old tier",
  );

  const missing = await call(
    req("/api/v1/internal/accounts/tier", {
      method: "POST",
      headers: { "x-account-tier-promote-token": PROMOTE_TOKEN },
      body: { ss58: "5Nobody", tier: "paid" },
    }),
  );
  assert.equal(missing.status, 404);
});

async function blockAccount(accountId: number) {
  return call(
    req("/api/v1/internal/keys/block", {
      method: "POST",
      headers: { "x-api-key-block-token": BLOCK_TOKEN },
      body: { account_id: accountId, reason_code: "abuse_scraping", note: "t" },
    }),
  );
}

test("block ledger: the partial unique index makes a re-block idempotent, unblock closes the row, status reports it", async () => {
  const first = await blockAccount(7);
  assert.equal(first.status, 200);
  assert.equal(((await first.json()) as Row).already_blocked, false);
  const snapshot = JSON.parse(kv.store.get("api-key-blocklist")!);
  assert.deepEqual(
    snapshot.blocks.map((b: Row) => b.accountId),
    [7],
  );

  // ON CONFLICT DO NOTHING against idx_api_key_blocks_one_active_per_account.
  const second = await blockAccount(7);
  assert.equal(((await second.json()) as Row).already_blocked, true);
  assert.equal(count("api_key_blocks"), 1);

  const token = await createSessionToken(SESSION_SECRET, {
    accountId: 7,
    ss58: "5Abc",
  });
  const status = await call(
    req("/api/v1/keys/status", {
      headers: { authorization: `Bearer ${token}` },
    }),
  );
  const statusBody = (await status.json()) as Row;
  assert.equal(statusBody.blocked, true);
  assert.equal(statusBody.reason_code, "abuse_scraping");

  const unblock = await call(
    req("/api/v1/internal/keys/unblock", {
      method: "POST",
      headers: { "x-api-key-block-token": BLOCK_TOKEN },
      body: { account_id: 7, note: "false positive" },
    }),
  );
  assert.equal(((await unblock.json()) as Row).unblocked, true);
  assert.equal(count("api_key_blocks"), 1, "closed, never deleted");
  assert.ok(one("SELECT unblocked_at FROM api_key_blocks").unblocked_at);

  // After the unblock the account can be blocked again -- the partial index
  // only constrains OPEN rows.
  const reblocked = await blockAccount(7);
  assert.equal(((await reblocked.json()) as Row).already_blocked, false);
  assert.equal(count("api_key_blocks"), 2);
});

test("anomalies: reads the usage window and annotates blocked accounts", async () => {
  const day = new Date().toISOString().slice(0, 10);
  for (const route of ["a", "b", "c", "d", "e"]) {
    db.prepare(
      "INSERT INTO api_key_usage_daily (account_id, day, route, request_count) VALUES (7, ?, ?, 5)",
    ).run(day, route);
  }
  db.prepare(
    "INSERT INTO api_key_blocks (account_id, reason_code, blocked_at) VALUES (7, 'abuse_scraping', 1)",
  ).run();
  const res = await call(
    req("/api/v1/internal/keys/anomalies", {
      headers: { "x-api-key-block-token": BLOCK_TOKEN },
    }),
  );
  assert.equal(res.status, 200);
  const body = (await res.json()) as Row;
  assert.equal(body.accounts_seen, 1);
  const flagged = (body.flagged as Row[])[0];
  assert.equal(flagged.account_id, 7);
  assert.equal(flagged.blocked_reason_code, "abuse_scraping");
});

// --- TAO/USD index ------------------------------------------------------------

test("tao-usd write: inserts once, reports a same-height re-run as not inserted", async () => {
  const row = {
    block_number: 25_650_836,
    observed_at: 1_785_476_783_000,
    usd_per_tao: 195.52,
    price_basis: "wrapped_onchain_median",
    eth_usd: 3644.4,
    pool_count: 2,
    pools: [{ address: "0xabc", included: true }],
  } as Parameters<typeof writeTaoUsdIndexRow>[1];
  assert.deepEqual(await writeTaoUsdIndexRow(env(), row), { inserted: true });
  assert.deepEqual(await writeTaoUsdIndexRow(env(), row), { inserted: false });
  const stored = one("SELECT * FROM tao_usd_index");
  assert.equal(stored.pool_count, 2);
  assert.deepEqual(JSON.parse(String(stored.pools)), [
    { address: "0xabc", included: true },
  ]);
});

test("tao-usd write: a missing binding rejects (the tick's catch reports tick_failed)", async () => {
  await assert.rejects(() =>
    writeTaoUsdIndexRow(env({ METAGRAPH_HEALTH_DB: undefined }), {
      block_number: 1,
      observed_at: 2,
      usd_per_tao: null,
      price_basis: "insufficient_pools",
      eth_usd: null,
      pool_count: 0,
      pools: [],
    } as unknown as Parameters<typeof writeTaoUsdIndexRow>[1]),
  );
});

// --- runner edges -------------------------------------------------------------

test("bind coercion: undefined -> NULL, booleans -> 0/1, arrays/objects -> JSON text, scalars untouched", async () => {
  // The full coercion contract, against real SQLite. Routes cannot produce
  // every shape (no route binds a literal undefined today), but the runner's
  // contract still covers them for the next call site.
  const sql = createD1Sql(d1() as unknown as D1Database);
  const [row] = await sql`
    SELECT ${undefined} AS u, ${true} AS t, ${false} AS f,
           ${["a", 1]} AS arr, ${{ k: "v" }} AS obj,
           ${null} AS n, ${7.5} AS num, ${"s"} AS str`;
  // Spread first: node:sqlite hands back null-prototype row objects, which
  // strict deepEqual distinguishes from plain literals.
  assert.deepEqual(
    { ...row },
    {
      u: null,
      t: 1,
      f: 0,
      arr: '["a",1]',
      obj: '{"k":"v"}',
      n: null,
      num: 7.5,
      str: "s",
    },
  );
});

test("the runner tolerates a D1 result with no `results` key", async () => {
  // D1's .all() always carries `results` today; the `?? []` is the contract
  // guard for a driver that returns a bare success object.
  const bare = {
    prepare(text: string) {
      return {
        bind() {
          return { all: async () => ({ text }) };
        },
      };
    },
  };
  const token = await createTriggerToken(WATCH_SECRET, { ss58: SS58 });
  const res = await call(
    req("/api/v1/watch/triggers", {
      headers: { "x-watch-trigger-token": token },
    }),
    env({ METAGRAPH_HEALTH_DB: bare }),
  );
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { triggers: [] });
});

test("a thrown D1 error surfaces as the wrappers' 502 envelope", async () => {
  const exploding = {
    prepare() {
      return {
        bind() {
          return {
            all: async () => {
              throw new Error("d1 down");
            },
          };
        },
      };
    },
  };
  const token = await createTriggerToken(WATCH_SECRET, { ss58: SS58 });
  const alertRoute = await call(
    req("/api/v1/watch/triggers", {
      headers: { "x-watch-trigger-token": token },
    }),
    env({ METAGRAPH_HEALTH_DB: exploding }),
  );
  assert.equal(alertRoute.status, 502);

  const sessionToken = await createSessionToken(SESSION_SECRET, {
    accountId: 7,
    ss58: "5Abc",
  });
  const accountsRoute = await call(
    req("/api/v1/keys", {
      headers: { authorization: `Bearer ${sessionToken}` },
    }),
    env({ METAGRAPH_HEALTH_DB: exploding }),
  );
  assert.equal(accountsRoute.status, 502);
});
