// metagraphed#7731: confirms captureAiRouteError (workers/api.ts) actually
// reaches PostHog's $exception capture for a genuine AI-backend failure on
// /api/v1/search/semantic and /api/v1/ask, and stays silent for an expected,
// caller-fixable input rejection (the `aiInput` branch). metagraphed#7766:
// the equivalent Sentry.captureException assertions this file used to also
// make are gone -- Sentry fully removed once PostHog parity was proven. A
// separate small file rather than folded into tests/ai-search.test.ts: that
// file's other ~80 tests already exercise these same routes.
import assert from "node:assert/strict";
import { afterEach, test } from "vitest";
import { POSTHOG_PROJECT_TOKEN_ENV } from "../src/usage-telemetry.ts";
import type { Row } from "./row-type.ts";

const { handleRequest } = await import("../workers/api.ts");
const { createLocalArtifactEnv } = await import("../scripts/lib.ts");

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const SEMANTIC_URL = "https://api.metagraph.sh/api/v1/search/semantic";
const ASK_URL = "https://api.metagraph.sh/api/v1/ask";

function stubAi(run: () => Promise<unknown>) {
  return { run };
}

function aiWorkerEnv(overrides: Record<string, unknown> = {}) {
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

test("a semantic-search backend failure returns a clean 502 with error code ai_error", async () => {
  const env = aiWorkerEnv({
    AI: stubAi(() => Promise.reject(new Error("model down"))),
  });
  const res = await handleRequest(
    new Request(`${SEMANTIC_URL}?q=x`),
    env as unknown as Env,
    {},
  );
  assert.equal(res.status, 502);
  assert.equal((await res.json()).error.code, "ai_error");
});

test("a semantic-search backend failure reaches PostHog as $exception, tagged by the same route", async () => {
  const posted: Row[] = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    posted.push({ url, body: JSON.parse(init!.body as string) });
    return { ok: true };
  }) as typeof fetch;
  const env = aiWorkerEnv({
    [POSTHOG_PROJECT_TOKEN_ENV]: "phc_test_token",
    AI: stubAi(() => Promise.reject(new Error("model down"))),
  });
  const res = await handleRequest(
    new Request(`${SEMANTIC_URL}?q=x`),
    env as unknown as Env,
    {},
  );
  assert.equal(res.status, 502);
  assert.equal(posted.length, 1);
  assert.equal(posted[0].body.event, "$exception");
  assert.equal(posted[0].body.properties.route, "semantic_search");
  assert.equal(posted[0].body.properties.error_code, "ai_error");
  assert.equal(
    posted[0].body.properties.$exception_list[0].value,
    "model down",
  );
});

test("an ask backend failure also reaches PostHog as $exception, tagged by the same route", async () => {
  const posted: Row[] = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    posted.push({ url, body: JSON.parse(init!.body as string) });
    return { ok: true };
  }) as typeof fetch;
  const env = aiWorkerEnv({
    [POSTHOG_PROJECT_TOKEN_ENV]: "phc_test_token",
    AI: stubAi(() => Promise.reject(new Error("model down"))),
  });
  const res = await handleRequest(
    new Request(ASK_URL, {
      method: "POST",
      body: JSON.stringify({ question: "x" }),
    }),
    env as unknown as Env,
    {},
  );
  assert.equal(res.status, 502);
  assert.equal(posted.length, 1);
  assert.equal(posted[0].body.properties.route, "ask");
});

test("a caller-input rejection (aiInput) on either route never reaches PostHog either", async () => {
  const posted: Row[] = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    posted.push({ url, body: JSON.parse(init!.body as string) });
    return { ok: true };
  }) as typeof fetch;
  const env = aiWorkerEnv({ [POSTHOG_PROJECT_TOKEN_ENV]: "phc_test_token" });
  await handleRequest(
    new Request(`${SEMANTIC_URL}?q=x&type=bogus`),
    env as unknown as Env,
    {},
  );
  await handleRequest(
    new Request(ASK_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ question: "which?", type: "bogus" }),
    }),
    env as unknown as Env,
    {},
  );
  assert.equal(posted.length, 0);
});

test("a caller-input rejection (aiInput) on either route returns a clean 400", async () => {
  const env = aiWorkerEnv();
  const semanticRes = await handleRequest(
    new Request(`${SEMANTIC_URL}?q=x&type=bogus`),
    env as unknown as Env,
    {},
  );
  assert.equal(semanticRes.status, 400);
  const askRes = await handleRequest(
    new Request(ASK_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ question: "which?", type: "bogus" }),
    }),
    env as unknown as Env,
    {},
  );
  assert.equal(askRes.status, 400);
});
