// Unit tests for workers/data-api.ts's handleGithubAccountUpsert
// (metagraphed#7151) -- POST /api/v1/auth/github/upsert-account, reached
// only via the DATA_API service binding from src/github-oauth.ts's
// callback handler (see that module's own test file for the OAuth-flow
// side). Mirrors tests/wallet-auth-keys-route.test.ts's shape: its own
// per-test queue-shaped D1 fake (tests/user-state-d1-queue.ts), scoped only
// to this file -- github_accounts lives on the user-state D1 since the
// accounts-d1 port.
import assert from "node:assert/strict";
import { beforeEach, test } from "vitest";
import { createQueueD1 } from "./user-state-d1-queue.ts";
import type { Row } from "./row-type.ts";

const mockQueue: { current: Row[][] } = { current: [] };
const sqlCalls: Array<{ text: string; values: unknown[] }> = [];
const failNextQuery = { error: null as Error | null };

const { default: worker } = await import("../workers/data-api.ts");

// #8820: the route is gated with the internal-token pair, so the default env
// provisions the secret and the default request carries the matching header --
// the pre-gate happy/validation paths below assert behaviour AFTER the gate.
const INTERNAL_TOKEN = "test-lookup-token";

function baseEnv(overrides = {}) {
  return {
    METAGRAPH_HEALTH_DB: createQueueD1({ mockQueue, sqlCalls, failNextQuery }),
    API_KEY_LOOKUP_INTERNAL_TOKEN: INTERNAL_TOKEN,
    ...overrides,
  };
}

beforeEach(() => {
  mockQueue.current = [];
  sqlCalls.length = 0;
  failNextQuery.error = null;
});

function req(body: Row, token: string | null = INTERNAL_TOKEN) {
  return new Request("https://d/api/v1/auth/github/upsert-account", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token === null ? {} : { "x-api-key-lookup-token": token }),
    },
    body: JSON.stringify(body),
  });
}

async function fetchRoute(request: Request, env: Row) {
  return worker.fetch(
    request,
    env as unknown as Env,
    {} as unknown as ExecutionContext,
  );
}

test("rejects a malformed JSON body", async () => {
  const env = baseEnv();
  const res = await fetchRoute(
    new Request("https://d/api/v1/auth/github/upsert-account", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key-lookup-token": INTERNAL_TOKEN,
      },
      body: "not json",
    }),
    env,
  );
  assert.equal(res.status, 400);
});

test("rejects a non-integer github_user_id", async () => {
  const env = baseEnv();
  const res = await fetchRoute(
    req({ github_user_id: "42", github_login: "octocat" }),
    env,
  );
  assert.equal(res.status, 400);
});

test("rejects a missing/empty github_login", async () => {
  const env = baseEnv();
  const res = await fetchRoute(req({ github_user_id: 42 }), env);
  assert.equal(res.status, 400);
});

test("upserts on github_user_id and returns the account row", async () => {
  const env = baseEnv();
  mockQueue.current.push([{ id: 7, github_login: "octocat", tier: "free" }]);
  const res = await fetchRoute(
    req({ github_user_id: 42, github_login: "octocat" }),
    env,
  );
  assert.equal(res.status, 200);
  const body = (await res.json()) as Row;
  assert.deepEqual(body, { id: 7, github_login: "octocat", tier: "free" });
  assert.ok(sqlCalls.some((c) => /INSERT INTO github_accounts/.test(c.text)));
  assert.ok(
    sqlCalls.some((c) =>
      /ON CONFLICT \(github_user_id\) DO UPDATE/.test(c.text),
    ),
  );
});

test("a GET to the same path is not routed here", async () => {
  const env = baseEnv();
  const res = await fetchRoute(
    new Request("https://d/api/v1/auth/github/upsert-account", {
      method: "GET",
    }),
    env,
  );
  assert.notEqual(res.status, 200);
});

// #8820: the internal-token gate. Same two-step 503-then-401 fail-closed shape
// as handleApiKeyVerify -- no token means no write is even attempted.
test("no token header -> 401 and NO write attempted (fails on main)", async () => {
  const env = baseEnv();
  const res = await fetchRoute(
    req({ github_user_id: 42, github_login: "octocat" }, null),
    env,
  );
  assert.equal(res.status, 401);
  assert.deepEqual(sqlCalls, []);
});

test("a wrong token header -> 401 and NO write attempted", async () => {
  const env = baseEnv();
  const res = await fetchRoute(
    req({ github_user_id: 42, github_login: "octocat" }, "not-the-secret"),
    env,
  );
  assert.equal(res.status, 401);
  assert.deepEqual(sqlCalls, []);
});

test("the secret unprovisioned -> 503 even when a header is supplied, NO write (fail-closed ordering)", async () => {
  const env = baseEnv({ API_KEY_LOOKUP_INTERNAL_TOKEN: undefined });
  const res = await fetchRoute(
    req({ github_user_id: 42, github_login: "octocat" }, INTERNAL_TOKEN),
    env,
  );
  assert.equal(res.status, 503);
  assert.deepEqual(sqlCalls, []);
});

test("correct token + valid body -> 200 with the account row, byte-identical to today", async () => {
  const env = baseEnv();
  mockQueue.current.push([{ id: 7, github_login: "octocat", tier: "free" }]);
  const res = await fetchRoute(
    req({ github_user_id: 42, github_login: "octocat" }),
    env,
  );
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json()) as Row, {
    id: 7,
    github_login: "octocat",
    tier: "free",
  });
});

test("correct token + invalid body -> the existing 400, NO write attempted", async () => {
  const env = baseEnv();
  const res = await fetchRoute(
    req({ github_user_id: "42", github_login: "octocat" }),
    env,
  );
  assert.equal(res.status, 400);
  assert.deepEqual(sqlCalls, []);
});
