// metagraphed#7734: confirms src/graphql.mjs's genuine-fault discriminator
// (a resolver's raw Error, wrapped by execute() into result.errors, vs a
// deliberately-thrown `new GraphQLError(...)` -- expected, caller-fixable
// validation, the GraphQL analogue of a REST 4xx) actually reaches Sentry
// only for the former, and that the x-metagraph-error-code response header
// is set correctly across every transport- and execution-level error path.
// A separate small file rather than folded into tests/graphql.test.mjs
// (20k lines, ~900 tests): vi.mock is file-scoped and hoisted, and that
// file's own tests already exercise these same paths through the real
// (unmocked) Sentry no-op -- mocking it there risks disturbing tests this
// issue doesn't own. Mirrors tests/mcp-server-sentry-args-safety.test.mjs's
// and tests/api-ai-routes-sentry.test.mjs's own identical rationale.
import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import { POSTHOG_PROJECT_TOKEN_ENV } from "../src/usage-telemetry.ts";

const captureException = vi.hoisted(() => vi.fn());
const resolveLiveEconomics = vi.hoisted(() => vi.fn());

vi.mock("@sentry/cloudflare", () => ({
  captureException,
}));

// loadEconomics (src/graphql.mjs) awaits resolveLiveEconomics with no
// try/catch, and Query.economics awaits loadEconomics the same way -- a
// rejection here propagates uncaught all the way to execute(), the exact
// genuine-fault shape this file needs to trigger on demand. Every other
// export of health-serving.ts passes through unmocked (importOriginal),
// so no other resolver's behavior changes.
vi.mock("../src/health-serving.ts", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, resolveLiveEconomics };
});

const {
  handleGraphQLRequest,
  GRAPHQL_MAX_BODY_BYTES,
  GRAPHQL_MAX_QUERY_BYTES,
} = await import("../src/graphql.mjs");

afterEach(() => {
  captureException.mockClear();
  resolveLiveEconomics.mockReset();
});

const emptyEnv = {};

async function gql(query, env = emptyEnv) {
  const req = new Request("https://api.metagraph.sh/api/v1/graphql", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query }),
  });
  const res = await handleGraphQLRequest(req, env);
  return { res, body: await res.json() };
}

test("a resolver's genuine exception reaches Sentry and is tagged graphql_execution_error", async () => {
  resolveLiveEconomics.mockRejectedValue(new Error("hyperdrive unavailable"));
  const { res, body } = await gql("{ economics { total } }");

  assert.equal(res.status, 200); // spec-mandated: errors ride a 200
  assert.equal(
    res.headers.get("x-metagraph-error-code"),
    "graphql_execution_error",
  );
  assert.ok(body.errors?.length >= 1);

  assert.equal(captureException.mock.calls.length, 1);
  const [capturedError, context] = captureException.mock.calls[0];
  assert.equal(capturedError.message, "hyperdrive unavailable");
  assert.deepEqual(context, { tags: { route: "graphql" } });
});

// metagraphed#7758: PostHog $exception capture, parallel-run alongside the
// Sentry.captureException above -- same route tag, same genuine-fault-only
// discriminator.
test("a resolver's genuine exception also reaches PostHog as $exception, tagged the same way", async () => {
  resolveLiveEconomics.mockRejectedValue(new Error("hyperdrive unavailable"));
  const original = globalThis.fetch;
  const posted = [];
  globalThis.fetch = async (url, init) => {
    posted.push({ url, body: JSON.parse(init.body) });
    return { ok: true };
  };
  try {
    const { res } = await gql("{ economics { total } }", {
      [POSTHOG_PROJECT_TOKEN_ENV]: "phc_test_token",
    });
    assert.equal(res.status, 200);
    assert.equal(posted.length, 1);
    assert.equal(posted[0].body.event, "$exception");
    assert.equal(posted[0].body.properties.route, "graphql");
    assert.equal(
      posted[0].body.properties.error_code,
      "graphql_execution_error",
    );
    assert.equal(
      posted[0].body.properties.$exception_list[0].value,
      "hyperdrive unavailable",
    );
  } finally {
    globalThis.fetch = original;
  }
});

test("a deliberate GraphQLError (bad user input) never reaches PostHog either", async () => {
  const original = globalThis.fetch;
  const posted = [];
  globalThis.fetch = async (url, init) => {
    posted.push({ url, body: JSON.parse(init.body) });
    return { ok: true };
  };
  try {
    await gql("{ subnet_identity_history(netuid: -1) { __typename } }", {
      [POSTHOG_PROJECT_TOKEN_ENV]: "phc_test_token",
    });
    assert.equal(posted.length, 0);
  } finally {
    globalThis.fetch = original;
  }
});

test("a deliberate GraphQLError (bad user input) never reaches Sentry, tagged graphql_field_error", async () => {
  const { res, body } = await gql(
    "{ subnet_identity_history(netuid: -1) { __typename } }",
  );

  assert.equal(res.status, 200);
  assert.equal(
    res.headers.get("x-metagraph-error-code"),
    "graphql_field_error",
  );
  assert.ok(body.errors?.[0]?.message.includes("non-negative"));
  assert.equal(captureException.mock.calls.length, 0);
});

test("a clean success carries no error-code header and is not captured", async () => {
  const { res, body } = await gql("{ __typename }");
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("x-metagraph-error-code"), null);
  assert.equal(body.errors, undefined);
  assert.equal(captureException.mock.calls.length, 0);
});

test("every transport-level rejection carries its own error code, none reach Sentry", async () => {
  const cases = [
    {
      name: "bad method",
      req: () =>
        new Request("https://api.metagraph.sh/api/v1/graphql", {
          method: "PUT",
        }),
      status: 405,
      code: "graphql_bad_method",
    },
    {
      name: "invalid Content-Length",
      req: () =>
        new Request("https://api.metagraph.sh/api/v1/graphql", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "content-length": "not-a-number",
          },
          body: JSON.stringify({ query: "{ __typename }" }),
        }),
      status: 400,
      code: "graphql_invalid_json",
    },
    {
      name: "declared-too-large body",
      req: () =>
        new Request("https://api.metagraph.sh/api/v1/graphql", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "content-length": String(GRAPHQL_MAX_BODY_BYTES + 1),
          },
          body: JSON.stringify({ query: "{ __typename }" }),
        }),
      status: 413,
      code: "graphql_payload_too_large",
    },
    {
      name: "invalid JSON body",
      req: () =>
        new Request("https://api.metagraph.sh/api/v1/graphql", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "not json",
        }),
      status: 400,
      code: "graphql_invalid_json",
    },
    {
      name: "missing query field",
      req: () =>
        new Request("https://api.metagraph.sh/api/v1/graphql", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({}),
        }),
      status: 400,
      code: "graphql_missing_query",
    },
    {
      name: "oversized query",
      req: () =>
        new Request("https://api.metagraph.sh/api/v1/graphql", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            query: `# ${"x".repeat(GRAPHQL_MAX_QUERY_BYTES)}\n{ __typename }`,
          }),
        }),
      status: 413,
      code: "graphql_payload_too_large",
    },
    {
      name: "parse error",
      req: () =>
        new Request("https://api.metagraph.sh/api/v1/graphql", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ query: "{ not valid graphql {" }),
        }),
      status: 400,
      code: "graphql_parse_error",
    },
    {
      name: "schema validation error",
      req: () =>
        new Request("https://api.metagraph.sh/api/v1/graphql", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ query: "{ this_field_does_not_exist }" }),
        }),
      status: 400,
      code: "graphql_validation_error",
    },
  ];

  for (const { name, req, status, code } of cases) {
    const res = await handleGraphQLRequest(req(), emptyEnv);
    assert.equal(res.status, status, `${name}: status`);
    assert.equal(
      res.headers.get("x-metagraph-error-code"),
      code,
      `${name}: error code`,
    );
  }
  assert.equal(captureException.mock.calls.length, 0);
});
