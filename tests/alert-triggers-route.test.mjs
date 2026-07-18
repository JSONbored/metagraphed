// Unit tests for the chain_alert_triggers CRUD write path (#4984 Part 1,
// workers/data-api.mjs's handleAlertTrigger*/handleAlertTriggersRoute
// functions). A dedicated test file (not folded into the already 5000+-line
// tests/data-api.test.mjs) with its OWN postgres mock scoped to just this
// table's shape -- vi.mock is per-test-file, so this doesn't touch that
// file's shared mock or vice versa.
//
// The mock is a simple per-test QUEUE (not a full SQL-semantics emulator,
// matching data-api.test.mjs's own established convention): each test
// pushes exactly the rows each of ITS query calls (in order) should
// resolve to, and asserts on the recorded call text/values for anything it
// needs to verify was actually sent.
import assert from "node:assert/strict";
import { beforeEach, test, vi } from "vitest";

const mockQueue = vi.hoisted(() => ({ current: [] }));
const sqlCalls = vi.hoisted(() => []);
const failNextQuery = vi.hoisted(() => ({ error: null }));

vi.mock("postgres", () => ({
  default: () => {
    function sql(strings, ...values) {
      let text = strings[0];
      for (let i = 0; i < values.length; i += 1) text += "?" + strings[i + 1];
      sqlCalls.push({ text, values });
      if (failNextQuery.error) {
        const err = failNextQuery.error;
        failNextQuery.error = null;
        return Promise.reject(err);
      }
      return Promise.resolve(
        mockQueue.current.length ? mockQueue.current.shift() : [],
      );
    }
    sql.begin = (cb) => cb(sql);
    sql.end = () => Promise.resolve();
    // #6746: condition (JSONB) is bound via sql.json(value) in the real
    // INSERT/UPDATE -- this mock's tagged-template sql() doesn't need to
    // know about JSON wrapping (it just records whatever value it's handed
    // as a template placeholder), so a passthrough is a faithful stand-in.
    sql.json = (value) => value;
    // sql.unsafe(text, params) -- the #5022 match write-back's batched
    // UPDATE builds its own placeholder text (plain scalar positional
    // binds) rather than a bound JS array, matching workers/data-api.mjs's
    // established neurons-sync-prune/compare-health convention (see that
    // route's own comment for why: this Worker's Hyperdrive
    // fetch_types:false setting breaks postgres.js's automatic
    // ARRAY-literal serialization). Recorded into the SAME sqlCalls list
    // so existing assertions work unchanged regardless of call form.
    sql.unsafe = (text, params = []) => {
      sqlCalls.push({ text, values: params });
      if (failNextQuery.error) {
        const err = failNextQuery.error;
        failNextQuery.error = null;
        return Promise.reject(err);
      }
      return Promise.resolve(
        mockQueue.current.length ? mockQueue.current.shift() : [],
      );
    };
    return sql;
  },
}));

const { default: worker } = await import("../workers/data-api.mjs");

const CREATE_TOKEN = "test-alert-trigger-create-token";
const INTERNAL_TOKEN = "test-alert-triggers-internal-token";
const env = {
  HYPERDRIVE: { connectionString: "postgres://mock" },
  ALERT_TRIGGER_CREATE_TOKEN: CREATE_TOKEN,
  ALERT_TRIGGERS_INTERNAL_TOKEN: INTERNAL_TOKEN,
};

beforeEach(() => {
  mockQueue.current = [];
  sqlCalls.length = 0;
  failNextQuery.error = null;
});

function req(path, { method = "GET", headers = {}, body } = {}) {
  return new Request(`https://d${path}`, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

async function fetch(request, envOverride = env) {
  return worker.fetch(request, envOverride, {});
}

function row(overrides = {}) {
  return {
    id: "1",
    owner_token: "stored-owner-token",
    name: null,
    table_filter: null,
    netuid: 7,
    event_kind: null,
    account: null,
    min_amount_tao: null,
    channel: "email",
    destination: "a@b.com",
    active: true,
    created_at: 1700000000000,
    updated_at: 1700000000000,
    last_matched_at: null,
    match_count: 0,
    ...overrides,
  };
}

// --- POST /api/v1/alerts/triggers (create) -----------------------------------

test("create: 503 when ALERT_TRIGGER_CREATE_TOKEN is not configured", async () => {
  const res = await fetch(
    req("/api/v1/alerts/triggers", { method: "POST", body: {} }),
    { ...env, ALERT_TRIGGER_CREATE_TOKEN: undefined },
  );
  assert.equal(res.status, 503);
});

test("create: 401 when the create token is missing or wrong", async () => {
  const missing = await fetch(
    req("/api/v1/alerts/triggers", { method: "POST", body: {} }),
  );
  assert.equal(missing.status, 401);
  const wrong = await fetch(
    req("/api/v1/alerts/triggers", {
      method: "POST",
      headers: { "x-alert-trigger-create-token": "wrong" },
      body: {},
    }),
  );
  assert.equal(wrong.status, 401);
});

test("create: 413 when content-length declares an oversized body", async () => {
  const res = await fetch(
    req("/api/v1/alerts/triggers", {
      method: "POST",
      headers: {
        "x-alert-trigger-create-token": CREATE_TOKEN,
        "content-length": "999999",
      },
      body: {},
    }),
  );
  assert.equal(res.status, 413);
});

test("create: 413 when the actual body exceeds the byte cap even without a lying content-length header", async () => {
  const request = new Request("https://d/api/v1/alerts/triggers", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-alert-trigger-create-token": CREATE_TOKEN,
    },
    body: JSON.stringify({
      channel: "email",
      destination: "a@b.com",
      netuid: 1,
      name: "x".repeat(20_000),
    }),
  });
  const res = await fetch(request);
  assert.equal(res.status, 413);
});

test("create: 400 on malformed JSON", async () => {
  const request = new Request("https://d/api/v1/alerts/triggers", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-alert-trigger-create-token": CREATE_TOKEN,
    },
    body: "{not json",
  });
  const res = await fetch(request);
  assert.equal(res.status, 400);
});

test("create: 400 on an empty body (parses to null, fails validation)", async () => {
  const request = new Request("https://d/api/v1/alerts/triggers", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-alert-trigger-create-token": CREATE_TOKEN,
    },
    body: "",
  });
  const res = await fetch(request);
  assert.equal(res.status, 400);
});

test("create: 400 on a validation failure, without ever touching Postgres", async () => {
  const res = await fetch(
    req("/api/v1/alerts/triggers", {
      method: "POST",
      headers: { "x-alert-trigger-create-token": CREATE_TOKEN },
      body: { channel: "carrier-pigeon", destination: "x" },
    }),
  );
  assert.equal(res.status, 400);
  assert.equal(sqlCalls.length, 0);
});

test("create: 503 when HYPERDRIVE is unbound", async () => {
  const res = await fetch(
    req("/api/v1/alerts/triggers", {
      method: "POST",
      headers: { "x-alert-trigger-create-token": CREATE_TOKEN },
      body: { channel: "email", destination: "a@b.com", netuid: 7 },
    }),
    { ...env, HYPERDRIVE: undefined },
  );
  assert.equal(res.status, 503);
});

test("create: 502 when the insert fails", async () => {
  failNextQuery.error = new Error("boom");
  const res = await fetch(
    req("/api/v1/alerts/triggers", {
      method: "POST",
      headers: { "x-alert-trigger-create-token": CREATE_TOKEN },
      body: { channel: "email", destination: "a@b.com", netuid: 7 },
    }),
  );
  assert.equal(res.status, 502);
});

test("create: 201 on success, mints a fresh owner_token distinct from any stored value, and inserts the validated fields", async () => {
  mockQueue.current.push([row({ owner_token: "irrelevant-stored-value" })]);
  const res = await fetch(
    req("/api/v1/alerts/triggers", {
      method: "POST",
      headers: { "x-alert-trigger-create-token": CREATE_TOKEN },
      body: {
        channel: "email",
        destination: "a@b.com",
        netuid: 7,
        name: "my alert",
      },
    }),
  );
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.match(body.owner_token, /^[0-9a-f]{64}$/);
  assert.notEqual(body.owner_token, "irrelevant-stored-value");
  assert.equal(body.id, "1");
  assert.equal(sqlCalls.length, 1);
  assert.match(sqlCalls[0].text, /INSERT INTO chain_alert_triggers/);
  assert.ok(sqlCalls[0].values.includes("my alert"));
  assert.ok(sqlCalls[0].values.includes(7));
  assert.ok(sqlCalls[0].values.includes("email"));
  assert.ok(sqlCalls[0].values.includes("a@b.com"));
});

test("create: 201 with a condition, inserts it as the JSONB value verbatim", async () => {
  const condition = {
    metric: "subnet_alpha_price_rank",
    operator: "gt",
    threshold: 100,
  };
  mockQueue.current.push([row({ condition })]);
  const res = await fetch(
    req("/api/v1/alerts/triggers", {
      method: "POST",
      headers: { "x-alert-trigger-create-token": CREATE_TOKEN },
      body: { channel: "email", destination: "a@b.com", netuid: 7, condition },
    }),
  );
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.deepEqual(body.condition, condition);
  assert.match(sqlCalls[0].text, /INSERT INTO chain_alert_triggers/);
  assert.ok(
    sqlCalls[0].values.some(
      (v) =>
        v && typeof v === "object" && v.metric === "subnet_alpha_price_rank",
    ),
  );
});

test("create: 400 on a malformed condition", async () => {
  const res = await fetch(
    req("/api/v1/alerts/triggers", {
      method: "POST",
      headers: { "x-alert-trigger-create-token": CREATE_TOKEN },
      body: {
        channel: "email",
        destination: "a@b.com",
        condition: { metric: "made-up", operator: "lt", threshold: 1 },
      },
    }),
  );
  assert.equal(res.status, 400);
  assert.equal(sqlCalls.length, 0);
});

test("create: 429 when ALERT_TRIGGER_CREATE_RATE_LIMITER rejects the request, without ever touching Postgres", async () => {
  const limiter = { limit: vi.fn(async () => ({ success: false })) };
  const res = await fetch(
    req("/api/v1/alerts/triggers", {
      method: "POST",
      headers: { "x-alert-trigger-create-token": CREATE_TOKEN },
      body: { channel: "email", destination: "a@b.com", netuid: 7 },
    }),
    { ...env, ALERT_TRIGGER_CREATE_RATE_LIMITER: limiter },
  );
  assert.equal(res.status, 429);
  assert.equal(sqlCalls.length, 0);
  assert.equal(limiter.limit.mock.calls.length, 1);
  // #5475: the 429 now carries the standard rate-limit header family so the
  // api.mjs proxy (and clients) can honour the back-off.
  assert.equal(res.headers.get("retry-after"), "60");
  assert.equal(res.headers.get("x-ratelimit-limit"), "10");
  assert.equal(res.headers.get("x-ratelimit-policy"), "10;w=60");
  assert.equal(res.headers.get("x-ratelimit-remaining"), "0");
});

test("create: 201 when ALERT_TRIGGER_CREATE_RATE_LIMITER allows the request", async () => {
  const limiter = { limit: vi.fn(async () => ({ success: true })) };
  mockQueue.current.push([row()]);
  const res = await fetch(
    req("/api/v1/alerts/triggers", {
      method: "POST",
      headers: { "x-alert-trigger-create-token": CREATE_TOKEN },
      body: { channel: "email", destination: "a@b.com", netuid: 7 },
    }),
    { ...env, ALERT_TRIGGER_CREATE_RATE_LIMITER: limiter },
  );
  assert.equal(res.status, 201);
  assert.equal(limiter.limit.mock.calls.length, 1);
});

test("create: skips rate limiting entirely when ALERT_TRIGGER_CREATE_RATE_LIMITER is unbound (local dev/CI)", async () => {
  mockQueue.current.push([row()]);
  const res = await fetch(
    req("/api/v1/alerts/triggers", {
      method: "POST",
      headers: { "x-alert-trigger-create-token": CREATE_TOKEN },
      body: { channel: "email", destination: "a@b.com", netuid: 7 },
    }),
  );
  assert.equal(res.status, 201);
});

// --- GET /api/v1/alerts/triggers/{id} -----------------------------------------

test("get: 400 on a malformed id", async () => {
  const res = await fetch(req("/api/v1/alerts/triggers/not-a-number"));
  assert.equal(res.status, 400);
});

test("get: 404 when no such trigger exists", async () => {
  mockQueue.current.push([]);
  const res = await fetch(req("/api/v1/alerts/triggers/1"));
  assert.equal(res.status, 404);
});

test("get: 404 (not 403) when the owner token header is entirely absent -- indistinguishable from a nonexistent id", async () => {
  mockQueue.current.push([row()]);
  const res = await fetch(req("/api/v1/alerts/triggers/1"));
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { error: "no such trigger" });
});

test("get: 404 (not 403) when the owner token is present but wrong -- prevents an existence oracle over sequential ids", async () => {
  mockQueue.current.push([row()]);
  const res = await fetch(
    req("/api/v1/alerts/triggers/1", {
      headers: { "x-alert-trigger-owner-token": "wrong" },
    }),
  );
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { error: "no such trigger" });
});

test("get: 200 with the owner view (owner_token stripped) when the token matches", async () => {
  mockQueue.current.push([row({ owner_token: "correct-token", netuid: 9 })]);
  const res = await fetch(
    req("/api/v1/alerts/triggers/1", {
      headers: { "x-alert-trigger-owner-token": "correct-token" },
    }),
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.netuid, 9);
  assert.equal("owner_token" in body, false);
});

// --- PATCH /api/v1/alerts/triggers/{id} ---------------------------------------

test("update: 400 on a malformed id", async () => {
  const res = await fetch(
    req("/api/v1/alerts/triggers/xx", {
      method: "PATCH",
      body: { channel: "email", destination: "a@b.com", netuid: 1 },
    }),
  );
  assert.equal(res.status, 400);
});

test("update: 400 on malformed JSON, before ever querying Postgres", async () => {
  const request = new Request("https://d/api/v1/alerts/triggers/1", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: "{not json",
  });
  const res = await fetch(request);
  assert.equal(res.status, 400);
  assert.equal(sqlCalls.length, 0);
});

test("update: 400 on an empty body (parses to null), before ever querying Postgres -- the merge helper needs a real object", async () => {
  const request = new Request("https://d/api/v1/alerts/triggers/1", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: "",
  });
  const res = await fetch(request);
  assert.equal(res.status, 400);
  assert.equal(sqlCalls.length, 0);
});

test("update: 400 when the body parses to a JSON array, before ever querying Postgres", async () => {
  const request = new Request("https://d/api/v1/alerts/triggers/1", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: "[]",
  });
  const res = await fetch(request);
  assert.equal(res.status, 400);
  assert.equal(sqlCalls.length, 0);
});

test("update: 400 when the body parses to a JSON primitive (not an object), before ever querying Postgres", async () => {
  const request = new Request("https://d/api/v1/alerts/triggers/1", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: "5",
  });
  const res = await fetch(request);
  assert.equal(res.status, 400);
  assert.equal(sqlCalls.length, 0);
});

test("update: 400 on a validation failure, after loading (but never writing) the existing row -- merge-then-validate needs the row first, unlike CREATE", async () => {
  mockQueue.current.push([row({ owner_token: "correct-token" })]);
  const res = await fetch(
    req("/api/v1/alerts/triggers/1", {
      method: "PATCH",
      headers: { "x-alert-trigger-owner-token": "correct-token" },
      body: { channel: "email", destination: "not-an-email" },
    }),
  );
  assert.equal(res.status, 400);
  assert.equal(sqlCalls.length, 1);
  assert.match(sqlCalls[0].text, /SELECT \* FROM chain_alert_triggers/);
});

test("update: 404 (not 400) on a validation failure when the trigger doesn't exist -- existence is checked before validation", async () => {
  mockQueue.current.push([]);
  const res = await fetch(
    req("/api/v1/alerts/triggers/1", {
      method: "PATCH",
      body: { channel: "email", destination: "not-an-email" },
    }),
  );
  assert.equal(res.status, 404);
});

test("update: 404 when no such trigger exists", async () => {
  mockQueue.current.push([]);
  const res = await fetch(
    req("/api/v1/alerts/triggers/1", {
      method: "PATCH",
      body: { channel: "email", destination: "a@b.com", netuid: 1 },
    }),
  );
  assert.equal(res.status, 404);
});

test("update: 404 (not 403) when the owner token is missing or wrong -- prevents an existence oracle over sequential ids", async () => {
  mockQueue.current.push([row({ owner_token: "correct-token" })]);
  const res = await fetch(
    req("/api/v1/alerts/triggers/1", {
      method: "PATCH",
      headers: { "x-alert-trigger-owner-token": "wrong" },
      body: { channel: "email", destination: "a@b.com", netuid: 1 },
    }),
  );
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { error: "no such trigger" });
});

test("update: 200 on success, sends the new validated fields to the UPDATE", async () => {
  mockQueue.current.push([row({ owner_token: "correct-token" })]);
  mockQueue.current.push([row({ netuid: 42, event_kind: "Transfer" })]);
  const res = await fetch(
    req("/api/v1/alerts/triggers/1", {
      method: "PATCH",
      headers: { "x-alert-trigger-owner-token": "correct-token" },
      body: {
        channel: "email",
        destination: "a@b.com",
        netuid: 42,
        event_kind: "Transfer",
      },
    }),
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.netuid, 42);
  assert.equal(body.event_kind, "Transfer");
  assert.equal(sqlCalls.length, 2);
  assert.match(sqlCalls[0].text, /SELECT \* FROM chain_alert_triggers/);
  assert.match(sqlCalls[1].text, /UPDATE chain_alert_triggers SET/);
  assert.ok(sqlCalls[1].values.includes(42));
  assert.ok(sqlCalls[1].values.includes("Transfer"));
});

test("update: omitting a field on PATCH keeps the existing row's value (partial-update semantics, not full-replace), including a non-null min_amount_tao", async () => {
  mockQueue.current.push([
    row({
      owner_token: "correct-token",
      netuid: 7,
      event_kind: "Transfer",
      // A non-null existing min_amount_tao specifically exercises the
      // Number(existing.min_amount_tao) branch of the merge's ternary --
      // every OTHER fixture in this file uses row()'s default (null).
      min_amount_tao: "12.5", // Postgres numeric columns come back as strings
      channel: "email",
      destination: "a@b.com",
    }),
  ]);
  mockQueue.current.push([row({ netuid: 7, event_kind: "Transfer" })]);
  const res = await fetch(
    req("/api/v1/alerts/triggers/1", {
      method: "PATCH",
      headers: { "x-alert-trigger-owner-token": "correct-token" },
      // Only renaming -- netuid/event_kind/min_amount_tao/channel/destination
      // are NOT resent, and must survive the update untouched (the exact bug
      // the adversarial review found: a shared CREATE validator's
      // "omitted -> unset" default would otherwise silently drop them).
      body: { name: "renamed" },
    }),
  );
  assert.equal(res.status, 200);
  assert.equal(sqlCalls.length, 2);
  assert.ok(sqlCalls[1].values.includes(7));
  assert.ok(sqlCalls[1].values.includes("Transfer"));
  assert.ok(sqlCalls[1].values.includes(12.5));
  assert.ok(sqlCalls[1].values.includes("email"));
  assert.ok(sqlCalls[1].values.includes("a@b.com"));
  assert.ok(sqlCalls[1].values.includes("renamed"));
});

test("update: omitting condition on PATCH keeps the existing row's condition", async () => {
  const condition = {
    metric: "neuron_immunity_countdown_blocks",
    operator: "lte",
    threshold: 500,
  };
  mockQueue.current.push([
    row({ owner_token: "correct-token", netuid: 7, condition }),
  ]);
  mockQueue.current.push([row({ netuid: 7, condition })]);
  const res = await fetch(
    req("/api/v1/alerts/triggers/1", {
      method: "PATCH",
      headers: { "x-alert-trigger-owner-token": "correct-token" },
      body: { name: "renamed" },
    }),
  );
  assert.equal(res.status, 200);
  assert.ok(
    sqlCalls[1].values.some(
      (v) =>
        v &&
        typeof v === "object" &&
        v.metric === "neuron_immunity_countdown_blocks",
    ),
  );
});

test("update: a resent condition replaces the existing one", async () => {
  const oldCondition = {
    metric: "subnet_alpha_price_rank",
    operator: "gt",
    threshold: 100,
  };
  const newCondition = {
    metric: "neuron_immunity_countdown_blocks",
    operator: "lte",
    threshold: 500,
  };
  mockQueue.current.push([
    row({ owner_token: "correct-token", netuid: 7, condition: oldCondition }),
  ]);
  mockQueue.current.push([row({ netuid: 7, condition: newCondition })]);
  const res = await fetch(
    req("/api/v1/alerts/triggers/1", {
      method: "PATCH",
      headers: { "x-alert-trigger-owner-token": "correct-token" },
      body: { condition: newCondition },
    }),
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.condition, newCondition);
});

test("update: an explicit null on PATCH is a no-op, NOT a clear -- the existing value survives (validateAlertTriggerInput rejects a real null for most fields, so PATCH can't safely route an intentional-clear through the CREATE-shared validator)", async () => {
  mockQueue.current.push([
    row({
      owner_token: "correct-token",
      netuid: 7,
      event_kind: "Transfer",
      channel: "email",
      destination: "a@b.com",
    }),
  ]);
  mockQueue.current.push([row({ netuid: 7, event_kind: "Transfer" })]);
  const res = await fetch(
    req("/api/v1/alerts/triggers/1", {
      method: "PATCH",
      headers: { "x-alert-trigger-owner-token": "correct-token" },
      body: {
        netuid: null,
        channel: "email",
        destination: "a@b.com",
      },
    }),
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.netuid, 7);
  assert.equal(sqlCalls.length, 2);
  assert.ok(sqlCalls[1].values.includes(7));
});

test("update: a PATCH that only touches an unrelated field still validates cleanly when other existing fields are already null", async () => {
  mockQueue.current.push([
    row({
      owner_token: "correct-token",
      netuid: null,
      event_kind: null,
      account: "5F...",
      channel: "email",
      destination: "a@b.com",
    }),
  ]);
  mockQueue.current.push([row({ name: "renamed" })]);
  const res = await fetch(
    req("/api/v1/alerts/triggers/1", {
      method: "PATCH",
      headers: { "x-alert-trigger-owner-token": "correct-token" },
      body: { name: "renamed" },
    }),
  );
  assert.equal(res.status, 200);
});

// --- DELETE /api/v1/alerts/triggers/{id} --------------------------------------

test("delete: 400 on a malformed id", async () => {
  const res = await fetch(
    req("/api/v1/alerts/triggers/xx", { method: "DELETE" }),
  );
  assert.equal(res.status, 400);
});

test("delete: 404 when no such trigger exists", async () => {
  mockQueue.current.push([]);
  const res = await fetch(
    req("/api/v1/alerts/triggers/1", { method: "DELETE" }),
  );
  assert.equal(res.status, 404);
});

test("delete: 404 (not 403) when the owner token is missing or wrong -- prevents an existence oracle over sequential ids", async () => {
  mockQueue.current.push([{ owner_token: "correct-token" }]);
  const res = await fetch(
    req("/api/v1/alerts/triggers/1", {
      method: "DELETE",
      headers: { "x-alert-trigger-owner-token": "wrong" },
    }),
  );
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { error: "no such trigger" });
});

test("delete: 200 with {id, deleted:true} on success, and actually issues the DELETE", async () => {
  mockQueue.current.push([{ owner_token: "correct-token" }]);
  mockQueue.current.push([]);
  const res = await fetch(
    req("/api/v1/alerts/triggers/1", {
      method: "DELETE",
      headers: { "x-alert-trigger-owner-token": "correct-token" },
    }),
  );
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { id: "1", deleted: true });
  assert.equal(sqlCalls.length, 2);
  assert.match(sqlCalls[1].text, /DELETE FROM chain_alert_triggers WHERE id/);
});

// --- GET /api/v1/internal/alert-triggers-active (evaluator scan) -------------

test("active list: 503 when ALERT_TRIGGERS_INTERNAL_TOKEN is not configured", async () => {
  const res = await fetch(req("/api/v1/internal/alert-triggers-active"), {
    ...env,
    ALERT_TRIGGERS_INTERNAL_TOKEN: undefined,
  });
  assert.equal(res.status, 503);
});

test("active list: 401 when the internal token header is entirely absent", async () => {
  const res = await fetch(req("/api/v1/internal/alert-triggers-active"));
  assert.equal(res.status, 401);
});

test("active list: 401 when the internal token is present but wrong", async () => {
  const res = await fetch(
    req("/api/v1/internal/alert-triggers-active", {
      headers: { "x-alert-triggers-internal-token": "wrong" },
    }),
  );
  assert.equal(res.status, 401);
});

test("active list: 200 with every active trigger reshaped for the evaluator, owner_token stripped", async () => {
  mockQueue.current.push([
    row({ id: "1", netuid: 7 }),
    row({ id: "2", netuid: 8, table_filter: ["account_events"] }),
  ]);
  const res = await fetch(
    req("/api/v1/internal/alert-triggers-active", {
      headers: { "x-alert-triggers-internal-token": INTERNAL_TOKEN },
    }),
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.triggers.length, 2);
  assert.equal(body.triggers[0].netuid, 7);
  assert.equal(body.triggers[1].tableFilter[0], "account_events");
  assert.equal("owner_token" in body.triggers[0], false);
  assert.equal(sqlCalls.length, 1);
  assert.match(
    sqlCalls[0].text,
    /SELECT \* FROM chain_alert_triggers WHERE active/,
  );
});

// --- POST /api/v1/internal/alert-triggers/matched (#5022 write-back) ---------

test("matched writeback: 503 when ALERT_TRIGGERS_INTERNAL_TOKEN is not configured", async () => {
  const res = await fetch(
    req("/api/v1/internal/alert-triggers/matched", {
      method: "POST",
      body: { trigger_ids: ["1"] },
    }),
    { ...env, ALERT_TRIGGERS_INTERNAL_TOKEN: undefined },
  );
  assert.equal(res.status, 503);
  assert.equal(sqlCalls.length, 0);
});

test("matched writeback: 401 when the internal token header is entirely absent", async () => {
  const res = await fetch(
    req("/api/v1/internal/alert-triggers/matched", {
      method: "POST",
      body: { trigger_ids: ["1"] },
    }),
  );
  assert.equal(res.status, 401);
  assert.equal(sqlCalls.length, 0);
});

test("matched writeback: 401 when the internal token is present but wrong", async () => {
  const res = await fetch(
    req("/api/v1/internal/alert-triggers/matched", {
      method: "POST",
      headers: { "x-alert-triggers-internal-token": "wrong" },
      body: { trigger_ids: ["1"] },
    }),
  );
  assert.equal(res.status, 401);
  assert.equal(sqlCalls.length, 0);
});

test("matched writeback: 400 on malformed JSON body", async () => {
  const request = new Request(
    "https://d/api/v1/internal/alert-triggers/matched",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-alert-triggers-internal-token": INTERNAL_TOKEN,
      },
      body: "{not json",
    },
  );
  const res = await fetch(request);
  assert.equal(res.status, 400);
  assert.equal(sqlCalls.length, 0);
});

test("matched writeback: 400 when trigger_ids is missing", async () => {
  const res = await fetch(
    req("/api/v1/internal/alert-triggers/matched", {
      method: "POST",
      headers: { "x-alert-triggers-internal-token": INTERNAL_TOKEN },
      body: {},
    }),
  );
  assert.equal(res.status, 400);
  assert.equal(sqlCalls.length, 0);
});

test("matched writeback: 400 when trigger_ids is not an array", async () => {
  const res = await fetch(
    req("/api/v1/internal/alert-triggers/matched", {
      method: "POST",
      headers: { "x-alert-triggers-internal-token": INTERNAL_TOKEN },
      body: { trigger_ids: "1" },
    }),
  );
  assert.equal(res.status, 400);
  assert.equal(sqlCalls.length, 0);
});

test("matched writeback: 400 when trigger_ids is an empty array", async () => {
  const res = await fetch(
    req("/api/v1/internal/alert-triggers/matched", {
      method: "POST",
      headers: { "x-alert-triggers-internal-token": INTERNAL_TOKEN },
      body: { trigger_ids: [] },
    }),
  );
  assert.equal(res.status, 400);
  assert.equal(sqlCalls.length, 0);
});

test("matched writeback: 400 when every id in trigger_ids is malformed (filters to empty)", async () => {
  const res = await fetch(
    req("/api/v1/internal/alert-triggers/matched", {
      method: "POST",
      headers: { "x-alert-triggers-internal-token": INTERNAL_TOKEN },
      body: { trigger_ids: ["not-an-id", "-1", "1.5", null] },
    }),
  );
  assert.equal(res.status, 400);
  assert.equal(sqlCalls.length, 0);
});

test("matched writeback: 200, filters out malformed ids, and issues a single batched UPDATE incrementing match_count and setting last_matched_at", async () => {
  mockQueue.current.push([{ id: "1" }, { id: "2" }]);
  const res = await fetch(
    req("/api/v1/internal/alert-triggers/matched", {
      method: "POST",
      headers: { "x-alert-triggers-internal-token": INTERNAL_TOKEN },
      body: { trigger_ids: ["1", "2", "not-an-id"] },
    }),
  );
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { updated: 2 });
  assert.equal(sqlCalls.length, 1);
  const call = sqlCalls[0];
  assert.match(call.text, /UPDATE chain_alert_triggers/);
  assert.match(call.text, /match_count = match_count \+ 1/);
  assert.match(call.text, /last_matched_at = \$1/);
  assert.match(call.text, /WHERE id IN \(\$2::bigint, \$3::bigint\)/);
  // $1 is the shared `now` timestamp; $2.. are the validated ids, in
  // order, with the malformed one already filtered out.
  assert.equal(typeof call.values[0], "number");
  assert.deepEqual(call.values.slice(1), ["1", "2"]);
});

test("matched writeback: 502 when the UPDATE itself fails", async () => {
  failNextQuery.error = new Error("boom");
  const res = await fetch(
    req("/api/v1/internal/alert-triggers/matched", {
      method: "POST",
      headers: { "x-alert-triggers-internal-token": INTERNAL_TOKEN },
      body: { trigger_ids: ["1"] },
    }),
  );
  assert.equal(res.status, 502);
});

// --- GET /api/v1/internal/alert-triggers-dereg-risk-snapshot (#6747) --------

test("dereg-risk snapshot: 503 when ALERT_TRIGGERS_INTERNAL_TOKEN is not configured", async () => {
  const res = await fetch(
    req("/api/v1/internal/alert-triggers-dereg-risk-snapshot"),
    { ...env, ALERT_TRIGGERS_INTERNAL_TOKEN: undefined },
  );
  assert.equal(res.status, 503);
});

test("dereg-risk snapshot: 401 when the internal token header is entirely absent", async () => {
  const res = await fetch(
    req("/api/v1/internal/alert-triggers-dereg-risk-snapshot"),
  );
  assert.equal(res.status, 401);
});

test("dereg-risk snapshot: 401 when the internal token is present but wrong", async () => {
  const res = await fetch(
    req("/api/v1/internal/alert-triggers-dereg-risk-snapshot", {
      headers: { "x-alert-triggers-internal-token": "wrong" },
    }),
  );
  assert.equal(res.status, 401);
});

test("dereg-risk snapshot: 200, joins registered_at_block + immunity_period into immunity_expires_at_block, and returns the latest subnet_snapshots row per netuid", async () => {
  mockQueue.current.push([{ block_number: 12345 }]); // MAX(block_number)
  mockQueue.current.push([
    { netuid: 7, immunity_period: 500 },
    { netuid: 8, immunity_period: 1000 },
  ]);
  mockQueue.current.push([
    { netuid: 7, hotkey: "5Fhot", registered_at_block: 12000 },
  ]);
  mockQueue.current.push([
    { netuid: 7, alpha_price_tao: "1.5" },
    { netuid: 8, alpha_price_tao: null },
  ]);
  const res = await fetch(
    req("/api/v1/internal/alert-triggers-dereg-risk-snapshot", {
      headers: { "x-alert-triggers-internal-token": INTERNAL_TOKEN },
    }),
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.current_block, 12345);
  assert.deepEqual(body.subnets, [
    { netuid: 7, alpha_price_tao: 1.5 },
    { netuid: 8, alpha_price_tao: null },
  ]);
  assert.deepEqual(body.immune_neurons, [
    { netuid: 7, hotkey: "5Fhot", immunity_expires_at_block: 12500 },
  ]);
  assert.equal(sqlCalls.length, 4);
});

test("dereg-risk snapshot: an immune neuron on a subnet with no immunity_period hyperparameter row is dropped, not defaulted", async () => {
  mockQueue.current.push([{ block_number: 100 }]);
  mockQueue.current.push([]); // no subnet_hyperparams rows at all
  mockQueue.current.push([
    { netuid: 7, hotkey: "5Fhot", registered_at_block: 50 },
  ]);
  mockQueue.current.push([]);
  const res = await fetch(
    req("/api/v1/internal/alert-triggers-dereg-risk-snapshot", {
      headers: { "x-alert-triggers-internal-token": INTERNAL_TOKEN },
    }),
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.immune_neurons, []);
});

test("dereg-risk snapshot: current_block is null when the blocks table is empty", async () => {
  mockQueue.current.push([{ block_number: null }]);
  mockQueue.current.push([]);
  mockQueue.current.push([]);
  mockQueue.current.push([]);
  const res = await fetch(
    req("/api/v1/internal/alert-triggers-dereg-risk-snapshot", {
      headers: { "x-alert-triggers-internal-token": INTERNAL_TOKEN },
    }),
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.current_block, null);
});

test("dereg-risk snapshot: 502 when a query fails", async () => {
  failNextQuery.error = new Error("boom");
  const res = await fetch(
    req("/api/v1/internal/alert-triggers-dereg-risk-snapshot", {
      headers: { "x-alert-triggers-internal-token": INTERNAL_TOKEN },
    }),
  );
  assert.equal(res.status, 502);
});

// --- method-dispatch fallthrough -----------------------------------------------

test("route: an id-less GET is rejected with 405", async () => {
  const res = await fetch(req("/api/v1/alerts/triggers"));
  assert.equal(res.status, 405);
});

test("route: POST with an id in the path is rejected with 405 (create is id-less only)", async () => {
  const res = await fetch(
    req("/api/v1/alerts/triggers/1", { method: "POST", body: {} }),
  );
  assert.equal(res.status, 405);
});

test("route: an unsupported method is rejected with 405", async () => {
  const res = await fetch(req("/api/v1/alerts/triggers/1", { method: "PUT" }));
  assert.equal(res.status, 405);
});
