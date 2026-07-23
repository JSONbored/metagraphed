// Unit tests for workers/data-api.mjs's handleGithubAccountUpsert
// (metagraphed#7151) -- POST /api/v1/auth/github/upsert-account, reached
// only via the DATA_API service binding from src/github-oauth.ts's
// callback handler (see that module's own test file for the OAuth-flow
// side). Mirrors tests/wallet-auth-keys-route.test.mjs's shape: its own
// per-test postgres mock queue, scoped only to this file (vi.mock is
// per-test-file).
import assert from "node:assert/strict";
import { beforeEach, test, vi } from "vitest";
import type { AnyFn, Row } from "./row-type.ts";

const mockQueue = vi.hoisted((): { current: Row[] } => ({ current: [] }));
const sqlCalls = vi.hoisted((): Row[] => []);

vi.mock("postgres", () => ({
  default: () => {
    function sql(strings: TemplateStringsArray, ...values: unknown[]) {
      let text = strings[0];
      for (let i = 0; i < values.length; i += 1) text += "?" + strings[i + 1];
      sqlCalls.push({ text, values });
      return Promise.resolve(
        mockQueue.current.length ? mockQueue.current.shift() : [],
      );
    }
    sql.begin = (cb: AnyFn) => cb(sql);
    sql.end = () => Promise.resolve();
    sql.json = (value: unknown) => value;
    return sql;
  },
}));

const { default: worker } = await import("../workers/data-api.mjs");

function baseEnv(overrides = {}) {
  return {
    HYPERDRIVE: { connectionString: "postgres://mock" },
    ...overrides,
  };
}

beforeEach(() => {
  mockQueue.current = [];
  sqlCalls.length = 0;
});

function req(body: Row) {
  return new Request("https://d/api/v1/auth/github/upsert-account", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function fetchRoute(request: Request, env: Row) {
  return worker.fetch(request, env, {});
}

test("rejects a malformed JSON body", async () => {
  const env = baseEnv();
  const res = await fetchRoute(
    new Request("https://d/api/v1/auth/github/upsert-account", {
      method: "POST",
      headers: { "content-type": "application/json" },
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
