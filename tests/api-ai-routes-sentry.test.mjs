// metagraphed#7731: confirms captureAiRouteError (workers/api.mjs) actually
// reaches Sentry for a genuine AI-backend failure on /api/v1/search/semantic
// and /api/v1/ask, and stays silent for an expected, caller-fixable input
// rejection (the `aiInput` branch). A separate small file rather than folded
// into tests/ai-search.test.mjs: vi.mock is file-scoped and hoisted, and that
// file's other ~80 tests already exercise these same routes through the real
// (unmocked) Sentry no-op path -- mocking it there risks disturbing tests
// this issue doesn't own. Mirrors tests/mcp-server-sentry-args-safety.test.mjs's
// same rationale for src/mcp-server.mjs.
import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";

const captureException = vi.hoisted(() => vi.fn());

vi.mock("@sentry/cloudflare", () => ({
  captureException,
}));

const { handleRequest } = await import("../workers/api.mjs");
const { createLocalArtifactEnv } = await import("../scripts/lib.ts");

afterEach(() => {
  captureException.mockClear();
});

const SEMANTIC_URL = "https://api.metagraph.sh/api/v1/search/semantic";
const ASK_URL = "https://api.metagraph.sh/api/v1/ask";

function stubAi(run) {
  return { run };
}

function aiWorkerEnv(overrides = {}) {
  return {
    ...createLocalArtifactEnv(),
    METAGRAPH_ENABLE_AI: "true",
    AI: stubAi(() => Promise.resolve({ response: "ok" })),
    VECTORIZE: {
      query: () => Promise.resolve({ matches: [] }),
      upsert: () => Promise.resolve({ count: 0 }),
      deleteByIds: () => Promise.resolve({ count: 0 }),
    },
    ...overrides,
  };
}

test("a semantic-search backend failure reaches Sentry, tagged by route", async () => {
  const env = aiWorkerEnv({
    AI: stubAi(() => Promise.reject(new Error("model down"))),
  });
  const res = await handleRequest(new Request(`${SEMANTIC_URL}?q=x`), env, {});
  assert.equal(res.status, 502);
  assert.equal((await res.json()).error.code, "ai_error");
  assert.equal(captureException.mock.calls.length, 1);
  const [capturedError, context] = captureException.mock.calls[0];
  assert.equal(capturedError.message, "model down");
  assert.deepEqual(context, { tags: { route: "semantic_search" } });
});

test("an ask backend failure reaches Sentry, tagged by route", async () => {
  const env = aiWorkerEnv({
    AI: stubAi(() => Promise.reject(new Error("model down"))),
  });
  const res = await handleRequest(
    new Request(ASK_URL, {
      method: "POST",
      body: JSON.stringify({ question: "x" }),
    }),
    env,
    {},
  );
  assert.equal(res.status, 502);
  assert.equal(captureException.mock.calls.length, 1);
  const [capturedError, context] = captureException.mock.calls[0];
  assert.equal(capturedError.message, "model down");
  assert.deepEqual(context, { tags: { route: "ask" } });
});

test("a caller-input rejection (aiInput) on either route never reaches Sentry", async () => {
  const env = aiWorkerEnv();
  const semanticRes = await handleRequest(
    new Request(`${SEMANTIC_URL}?q=x&type=bogus`),
    env,
    {},
  );
  assert.equal(semanticRes.status, 400);
  const askRes = await handleRequest(
    new Request(ASK_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ question: "which?", type: "bogus" }),
    }),
    env,
    {},
  );
  assert.equal(askRes.status, 400);
  // Expected, caller-fixable input errors -- not exceptional, must never
  // count as a Sentry-worthy fault.
  assert.equal(captureException.mock.calls.length, 0);
});
