import assert from "node:assert/strict";
import { afterEach, beforeEach, test, vi } from "vitest";
import { handleRequest } from "../workers/api.ts";
import { withResponseTiming } from "../workers/request-lifecycle.ts";
import { handleGraphQLRequest } from "../src/graphql.ts";
import { handleMcpRequest } from "../src/mcp-server.ts";
import { resetModuleState } from "../src/module-state-registry.ts";
import type { Row } from "./row-type.ts";
import {
  requireRetainedHistoryAnswer,
  declineRetainedHistoryFailure,
  RetainedHistoryUnavailableError,
} from "../src/retained-history-store.ts";

const address = "5EvjtQiXJSkH3f9dQSZSe2SoKsNMoBm7nrGL1vwzNpS2JaPx";
beforeEach(() => resetModuleState());
afterEach(() => vi.unstubAllGlobals());

function unavailable(broken = false): Env {
  return {
    NATIVE_PROJECTIONS: "enabled",
    METAGRAPH_ARCHIVE: {
      get: async () => {
        if (broken) throw new Error("R2 read failed");
        return null;
      },
    },
  } as unknown as Env;
}

test("configured missing and failed history returns REST 503 without HTTP fallback", async () => {
  const fetch = vi.fn(async () => {
    throw new Error("No SQL or RPC fallback");
  });
  vi.stubGlobal("fetch", fetch);
  for (const broken of [false, true]) {
    for (const path of [
      `accounts/${address}/events`,
      `accounts/${address}/transfers`,
      `accounts/${address}/stake-flow`,
      "extrinsics?limit=5",
    ]) {
      const response = await handleRequest(
        new Request(`https://api.metagraph.sh/api/v1/${path}`),
        unavailable(broken),
      );
      assert.equal(response.status, 503, path);
      assert.match(await response.text(), /history_unavailable/);
    }
  }
  assert.equal(fetch.mock.calls.length, 0);
});

test("GraphQL reports an unavailable account feed as a field error", async () => {
  const response = await handleGraphQLRequest(
    new Request("https://api.metagraph.sh/api/v1/graphql", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        query: `{ account_events(ss58: "${address}") { event_count } }`,
      }),
    }),
    unavailable(),
  );
  const body = (await response.json()) as Row;
  assert.equal(body.data?.account_events ?? null, null);
  assert.equal(body.errors.length, 1);
  assert.match(body.errors[0].message, /historical data is unavailable/);
});

test("MCP reports an unavailable account feed as a tool error", async () => {
  const response = await handleMcpRequest(
    new Request("https://api.metagraph.sh/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "get_account_events", arguments: { ss58: address } },
      }),
    }),
    unavailable(),
  );
  const body = (await response.json()) as Row;
  assert.equal(body.result.isError, true);
  assert.ok(body.result.structuredContent.error);
  assert.equal(body.result.structuredContent.events, undefined);
});

test("verified empty answers and unconfigured deployments keep their contracts", async () => {
  const empty: unknown[] = [];
  assert.equal(
    await requireRetainedHistoryAnswer(unavailable(), Promise.resolve(empty)),
    empty,
  );
  assert.equal(
    await requireRetainedHistoryAnswer({}, Promise.resolve(undefined)),
    undefined,
  );
  assert.equal(
    await requireRetainedHistoryAnswer(null, Promise.resolve(null)),
    null,
  );
  await assert.rejects(
    requireRetainedHistoryAnswer(unavailable(), Promise.resolve(null)),
    RetainedHistoryUnavailableError,
  );
});

test("the REST history boundary preserves unrelated failures", async () => {
  const error = new Error("Unrelated request failure");
  const request = new Request("https://api.metagraph.sh/api/v1/blocks");
  Object.defineProperty(request, "url", {
    get: () => {
      throw error;
    },
  });
  await assert.rejects(
    handleRequest(request, {} as Env),
    (actual) => actual === error,
  );
  await assert.rejects(
    withResponseTiming(async () => {
      throw error;
    }),
    (actual) => actual === error,
  );
  await assert.rejects(
    declineRetainedHistoryFailure(Promise.reject(error)),
    (actual) => actual === error,
  );
});
