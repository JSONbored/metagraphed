// #9430: query_graphql's failure classification.
//
// The bridge used to return EVERY outcome normally, so dispatchTool -- which
// derives isError from whether the handler threw -- marked a query that
// resolved to nothing but errors as a success. $mcp_tool_call carried
// is_error:false and usage_event carried ok:true on a total failure, making
// this one tool's failure rate structurally unmeasurable while every other
// tool's was not.
//
// This file lives apart from tests/mcp-server.test.ts because triggering a
// GENUINE resolver fault needs a module mock at import scope, and that file
// runs ~1,350 tests that must not inherit one. The mock target and the
// `{ economics { total } }` probe are lifted from
// tests/graphql-error-capture-and-error-code.test.ts, which established this
// as the way to produce a real uncaught resolver exception on demand.
import assert from "node:assert/strict";
import { afterEach, describe, test, vi } from "vitest";
import type { Row } from "./row-type.ts";

// loadEconomics (src/graphql.ts) awaits resolveLiveEconomics with no
// try/catch, and Query.economics awaits loadEconomics the same way -- a
// rejection propagates uncaught to execute(), which is the genuine-fault
// shape graphql.ts reports on x-metagraph-error-code. Every other export
// passes through unmocked.
const resolveLiveEconomics = vi.fn();
vi.mock("../src/health-serving.ts", async (importOriginal) => {
  const actual = (await importOriginal()) as Row;
  return { ...actual, resolveLiveEconomics };
});

const { handleMcpRequest } = await import("../src/mcp-server.ts");

const MCP_URL = "https://api.metagraph.sh/mcp";

afterEach(() => {
  resolveLiveEconomics.mockReset();
});

async function queryGraphql(query: string, env: Row = {}) {
  const request = new Request(MCP_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "query_graphql", arguments: { query } },
    }),
  });
  const response = await handleMcpRequest(request, env as unknown as Env);
  return (JSON.parse(await response.text()) as Row).result as Row;
}

describe("query_graphql fault classification", () => {
  test("a genuine resolver fault is reported as an internal tool error", async () => {
    resolveLiveEconomics.mockRejectedValue(new Error("hyperdrive unavailable"));

    const result = await queryGraphql("{ economics { total } }");

    assert.equal(result.isError, true);
    // graphql.ts answers a resolver fault with a spec-mandated 200, which
    // status alone cannot tell from a success -- the bridge reads that
    // module's own genuineFaults verdict off x-metagraph-error-code instead
    // of re-deriving one from the payload shape.
    assert.equal(
      result.structuredContent.error.code,
      "graphql_execution_error",
    );
    // OUR fault, not the caller's: classifyMcpErrorType buckets this as
    // `internal`, where a rejected query buckets as `validation`.
    assert.ok(/hyperdrive unavailable/.test(result.content[0].text));
  });

  test("the same fault over REST and over MCP agree that it failed", async () => {
    // The REST wrapper keys ok:false on this exact header value
    // (withUsageTelemetry, workers/api.ts). Reusing it here is what stops one
    // query from counting as a failure on one surface and a success on the
    // other.
    resolveLiveEconomics.mockRejectedValue(new Error("hyperdrive unavailable"));
    const { handleGraphQLRequest } = await import("../src/graphql.ts");

    const restResponse = await handleGraphQLRequest(
      new Request("https://api.metagraph.sh/api/v1/graphql", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: "{ economics { total } }" }),
      }),
      {} as unknown as Env,
    );

    assert.equal(
      restResponse.headers.get("x-metagraph-error-code"),
      "graphql_execution_error",
    );

    resolveLiveEconomics.mockRejectedValue(new Error("hyperdrive unavailable"));
    const mcpResult = await queryGraphql("{ economics { total } }");
    assert.equal(mcpResult.isError, true);
  });

  test("a healthy query is untouched by the classification", async () => {
    resolveLiveEconomics.mockResolvedValue({ total: 1 });

    const result = await queryGraphql("{ __typename }");

    assert.equal(result.isError ?? false, false);
    assert.deepEqual(result.structuredContent, {
      data: { __typename: "Query" },
      errors: [],
    });
  });
});
