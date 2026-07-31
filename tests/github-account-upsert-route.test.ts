// Unit tests for workers/data-api.ts's handleGithubAccountUpsert
// (metagraphed#7151, #8820) -- POST /api/v1/auth/github/upsert-account, reached
// only via the DATA_API service binding from src/github-oauth.ts's
// callback handler (see that module's own test file for the OAuth-flow
// side). Mirrors tests/wallet-auth-keys-route.test.ts's shape: its own
// per-test postgres mock queue, scoped only to this file (vi.mock is
// per-test-file). Gated by API_KEY_LOOKUP_INTERNAL_TOKEN (#8820).
import assert from "node:assert/strict";
import { beforeEach, test, vi } from "vitest";
import { API_KEY_LOOKUP_TOKEN_HEADER } from "../src/api-key-validation.ts";
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

const { default: worker } = await import("../workers/data-api.ts");

const INTERNAL_TOKEN = "test-api-key-lookup-token";

function baseEnv(overrides = {}) {
  return {
    HYPERDRIVE: { connectionString: "postgres://mock" },
    API_KEY_LOOKUP_INTERNAL_TOKEN: INTERNAL_TOKEN,
    ...overrides,
  };
}

beforeEach(() => {
  mockQueue.current = [];
  sqlCalls.length = 0;
});

function req(body: Row, { token = INTERNAL_TOKEN }: { token?: string | null } = {}) {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (token != null) headers[API_KEY_LOOKUP_TOKEN_HEADER] = token;
  return new Request("https://d/api/v1/auth/github/upsert-account", {
    method: "POST",
    headers,
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

test("rejects a missing token header with 401 and issues no write", async () => {
  const env = baseEnv();
  const res = await fetchRoute(
    req({ github_user_id: 42, github_login: "octocat" }, { token: null }),
    env,
  );
  assert.equal(res.status, 401);
  assert.deepEqual(await res.json(), {
    error: `provide a valid ${API_KEY_LOOKUP_TOKEN_HEADER} header`,
  });
  assert.equal(sqlCalls.length, 0);
});

test("rejects a wrong token header with 401 and issues no write", async () => {
  const env = baseEnv();
  const res = await fetchRoute(
    req({ github_user_id: 42, github_login: "octocat" }, { token: "wrong" }),
    env,
  );
  assert.equal(res.status, 401);
  assert.equal(sqlCalls.length, 0);
});

test("returns 503 when the internal token is not provisioned, even with a header", async () => {
  const env = baseEnv({ API_KEY_LOOKUP_INTERNAL_TOKEN: undefined });
  const res = await fetchRoute(
    req({ github_user_id: 42, github_login: "octocat" }),
    env,
  );
  assert.equal(res.status, 503);
  assert.deepEqual(await res.json(), {
    error: "github account upsert is not provisioned on this deployment",
  });
  assert.equal(sqlCalls.length, 0);
});

test("rejects a malformed JSON body", async () => {
  const env = baseEnv();
  const res = await fetchRoute(
    new Request("https://d/api/v1/auth/github/upsert-account", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [API_KEY_LOOKUP_TOKEN_HEADER]: INTERNAL_TOKEN,
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
  assert.equal(sqlCalls.length, 0);
});

test("rejects a missing/empty github_login", async () => {
  const env = baseEnv();
  const res = await fetchRoute(req({ github_user_id: 42 }), env);
  assert.equal(res.status, 400);
  assert.equal(sqlCalls.length, 0);
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
