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

test("get: 403 when the owner token header is entirely absent", async () => {
  mockQueue.current.push([row()]);
  const res = await fetch(req("/api/v1/alerts/triggers/1"));
  assert.equal(res.status, 403);
});

test("get: 403 when the owner token is present but wrong", async () => {
  mockQueue.current.push([row()]);
  const res = await fetch(
    req("/api/v1/alerts/triggers/1", {
      headers: { "x-alert-trigger-owner-token": "wrong" },
    }),
  );
  assert.equal(res.status, 403);
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

test("update: 400 on a validation failure, before ever querying Postgres", async () => {
  const res = await fetch(
    req("/api/v1/alerts/triggers/1", {
      method: "PATCH",
      body: { channel: "email", destination: "not-an-email" },
    }),
  );
  assert.equal(res.status, 400);
  assert.equal(sqlCalls.length, 0);
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

test("update: 403 when the owner token is missing or wrong", async () => {
  mockQueue.current.push([{ owner_token: "correct-token" }]);
  const res = await fetch(
    req("/api/v1/alerts/triggers/1", {
      method: "PATCH",
      headers: { "x-alert-trigger-owner-token": "wrong" },
      body: { channel: "email", destination: "a@b.com", netuid: 1 },
    }),
  );
  assert.equal(res.status, 403);
});

test("update: 200 on success, sends the new validated fields to the UPDATE", async () => {
  mockQueue.current.push([{ owner_token: "correct-token" }]);
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
  assert.match(
    sqlCalls[0].text,
    /SELECT owner_token FROM chain_alert_triggers/,
  );
  assert.match(sqlCalls[1].text, /UPDATE chain_alert_triggers SET/);
  assert.ok(sqlCalls[1].values.includes(42));
  assert.ok(sqlCalls[1].values.includes("Transfer"));
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

test("delete: 403 when the owner token is missing or wrong", async () => {
  mockQueue.current.push([{ owner_token: "correct-token" }]);
  const res = await fetch(
    req("/api/v1/alerts/triggers/1", {
      method: "DELETE",
      headers: { "x-alert-trigger-owner-token": "wrong" },
    }),
  );
  assert.equal(res.status, 403);
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
