import assert from "node:assert/strict";
import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, test } from "vitest";
import { apiEnv } from "../scripts/lib/worker-env.ts";
import { listToolDefinitions } from "../src/mcp-server.ts";
import { handleRequest } from "../workers/api.ts";
import { withMcpProxyFixture } from "./fixtures/mcp-proxy.ts";
import type { Row } from "./row-type.ts";

const context = { waitUntil() {}, props: { accountId: 7 } };
async function call(env: Row, name: string, args: unknown) {
  const response = await handleRequest(new Request("https://mcp-proxy-fixture.example/mcp", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 41, method: "tools/call", params: { name, arguments: args } }),
  }), apiEnv(env), context);
  assert.equal(response.status, 200);
  const body = await response.json() as Row;
  assert.equal(body.id, 41);
  return body.result as Row;
}
const validators = new Map(listToolDefinitions().filter((tool) => ["call_rpc", "query_graphql", "list_subnets"].includes(tool.name)).map((tool) =>
  [tool.name, new Ajv2020({ strict: false }).compile(tool.outputSchema!)] as const,
));
function successful(name: string, result: Row) {
  assert.equal(result.isError, false);
  const validate = validators.get(name)!;
  assert.ok(validate(result.structuredContent), JSON.stringify(validate.errors));
  return result.structuredContent as Row;
}

describe("public MCP RPC and GraphQL offline conformance", () => {
  test("RPC and REST use identical request bytes and the selected network", async () => {
    await withMcpProxyFixture({}, async (env, state) => {
      for (const network of ["finney", "test"] as const) {
        const args = { network, method: "system_chain", params: [] };
        const result = successful("call_rpc", await call(env, "call_rpc", args));
        const response = await handleRequest(new Request(`https://mcp-proxy-fixture.example/rpc/v1/${network}`, {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: args.method, params: [] }),
        }), apiEnv(env), context);
        assert.equal(response.status, 200);
        assert.deepEqual(result.result, (await response.json() as Row).result);
        assert.equal(result.network, network);
        assert.equal(result.endpoint_id, `fixture-${network}`);
        assert.equal(result.provider, `fixture-${network}`);
        const pair = state.requests.slice(-2);
        assert.equal(pair.length, 2);
        assert.equal(pair[0]!.url, pair[1]!.url);
        assert.equal(pair[0]!.body, pair[1]!.body);
        assert.deepEqual([...pair[0]!.headers], [...pair[1]!.headers]);
      }
      assert.equal(state.requests.length, 4);
    });
  });

  for (const result of [null, false, true, 0, -1, "fixture", [], [null, false, "18446744073709551615"], { wide: "18446744073709551615", nullable: null }]) {
    test(`preserves a valid RPC result ${JSON.stringify(result)}`, async () => {
      await withMcpProxyFixture({}, async (env, state) => {
        state.responseBody = JSON.stringify({ jsonrpc: "2.0", id: 1, result });
        const value = successful("call_rpc", await call(env, "call_rpc", { method: "system_chain" }));
        assert.deepEqual(value.result, result);
        assert.equal(value.error, null);
        assert.equal(state.requests.length, 1);
      });
    });
  }

  for (const envelope of [null, false, true, 0, 1, "fixture", [], [{ jsonrpc: "2.0", id: 1, result: "wrong-batch" }]]) {
    test(`refuses a non-object single RPC envelope ${JSON.stringify(envelope)}`, async () => {
      await withMcpProxyFixture({}, async (env, state) => {
        state.responseBody = JSON.stringify(envelope);
        const result = await call(env, "call_rpc", { method: "system_chain" });
        assert.equal(result.isError, true);
        assert.equal(result.structuredContent.error.code, "rpc_invalid_response");
        assert.equal(state.requests.length, 1, "Invalid envelope is not replayed");
        assert.ok(!result.content[0].text.includes("TypeError"));
      });
    });
  }

  test("retains numeric normalization inside a valid envelope", async () => {
    await withMcpProxyFixture({}, async (env, state) => {
      state.responseBody = '{"jsonrpc":"2.0","id":1,"result":{"negative_zero":-0,"overflow":1e400}}';
      const result = successful("call_rpc", await call(env, "call_rpc", { method: "system_chain" }));
      assert.deepEqual(result.result, { negative_zero: 0, overflow: null });
      assert.equal(Object.is(result.result.negative_zero, -0), false);
    });
  });

  test("retains legacy object-envelope defaults", async () => {
    await withMcpProxyFixture({}, async (env, state) => {
      state.responseBody = "{}";
      const result = successful("call_rpc", await call(env, "call_rpc", { method: "system_chain" }));
      assert.equal(result.jsonrpc, "2.0");
      assert.equal(result.result, null);
      assert.equal(result.error, null);
    });
  });

  test("keeps structured RPC errors and non-2xx error handling", async () => {
    await withMcpProxyFixture({}, async (env, state) => {
      state.responseBody = JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32602, message: "fixture invalid params", data: { wide: "18446744073709551615" } } });
      const result = successful("call_rpc", await call(env, "call_rpc", { method: "system_chain" }));
      assert.equal(result.result, null);
      assert.equal(result.error.code, -32602);
      assert.equal(result.error.data.wide, "18446744073709551615");
      state.responseStatus = 400;
      state.responseBody = JSON.stringify("fixture rejection");
      const denied = await call(env, "call_rpc", { method: "system_chain" });
      assert.equal(denied.isError, true);
      assert.equal(denied.structuredContent.error.code, "rpc_upstream_error");
      assert.ok(denied.content[0].text.includes("HTTP 400: fixture rejection"));
      assert.equal(state.requests.length, 2);
    });
  });

  test("method, state-key, disabled-proxy and rate gates refuse before forwarding", async () => {
    await withMcpProxyFixture({}, async (env, state) => {
      for (const args of [{ method: "author_submitExtrinsic" }, { method: "state_getStorage", params: ["not-hex"] }]) {
        assert.equal((await call(env, "call_rpc", args)).isError, true);
      }
      const disabled = await call({ ...env, METAGRAPH_ENABLE_RPC_PROXY: "false" }, "call_rpc", { method: "system_chain" });
      assert.equal(disabled.structuredContent.error.code, "rpc_proxy_disabled");
      const limited = await call({ ...env, RPC_RATE_LIMITER: { limit: async ({ key }: {key: string}) => ({ success: !key.startsWith("rpc:") }) } }, "call_rpc", { method: "system_chain" });
      assert.equal(limited.structuredContent.error.code, "rpc_rate_limited");
      assert.equal(state.requests.length, 0);
    });
  });

  test("GraphQL selects populated rows, variables, nulls and root network pages without provider calls", async () => {
    await withMcpProxyFixture({}, async (env, state) => {
      const query = `query Q($netuid: Int!) {
        main: subnet(netuid: $netuid) { netuid name description }
        test: subnet(netuid: $netuid, network: test) { netuid name description }
        page: subnets(limit: 1) { items { netuid name } total next_cursor captured_at }
      }`;
      const result = successful("query_graphql", await call(env, "query_graphql", { query, variables: { netuid: 7 } }));
      assert.deepEqual(result.errors, []);
      assert.deepEqual(result.data.main, { netuid: 7, name: "finney fixture 7", description: null });
      assert.deepEqual(result.data.test, { netuid: 7, name: "test fixture 7", description: null });
      assert.equal(result.data.page.total, 2);
      assert.equal(result.data.page.next_cursor, "7");
      assert.deepEqual(result.data.page.items, [{ netuid: 7, name: "finney fixture 7" }]);
      const next = successful("query_graphql", await call(env, "query_graphql", { query: 'query { subnets(limit: 1, cursor: "7") { items { netuid name } total next_cursor } }' }));
      assert.deepEqual(next.data.subnets.items, [{ netuid: 8, name: "finney fixture 8" }]);
      assert.equal(next.data.subnets.next_cursor, null);
      const list = successful("list_subnets", await call(env, "list_subnets", { limit: 2 }));
      assert.deepEqual(list.subnets.map((row: Row) => ({ netuid: row.netuid, name: row.title })), [result.data.page.items[0], next.data.subnets.items[0]]);
      const rest = await handleRequest(new Request("https://mcp-proxy-fixture.example/api/v1/subnets?limit=2"), apiEnv(env), context);
      assert.equal(rest.status, 200);
      const data = await rest.json() as Row;
      assert.deepEqual(data.data.subnets.map((row: Row) => ({ netuid: row.netuid, name: row.name })), [result.data.page.items[0], next.data.subnets.items[0]]);
      assert.equal(state.requests.length, 0);
    });
  });

  test("GraphQL preserves rejected document, mutation and throttle errors", async () => {
    await withMcpProxyFixture({}, async (env, state) => {
      for (const query of ["{ definitely_not_a_fixture_field }", "mutation { __typename }", "{", `{ ${Array.from({length: 11}, (_, index) => `f${index}: subnet_serving(netuid: 7) { netuid }`).join(" ")} }`]) {
        const denied = await call(env, "query_graphql", { query });
        assert.equal(denied.isError, true);
        assert.equal(denied.structuredContent.error.code, "invalid_graphql_query");
      }
      const limited = await call({ ...env, RPC_RATE_LIMITER: { limit: async ({ key }: {key: string}) => ({ success: !key.startsWith("gql:") }) } }, "query_graphql", { query: "{ __typename }" });
      assert.equal(limited.structuredContent.error.code, "graphql_rate_limited");
      assert.equal(state.requests.length, 0);
    });
  });

  test("GraphQL keeps partial selected data alongside field errors", async () => {
    await withMcpProxyFixture({}, async (env, state) => {
      const result = successful("query_graphql", await call(env, "query_graphql", {
        query: '{ __typename subnet(netuid: 7) { endpoints(kind: "bogus") { id } } }',
      }));
      assert.deepEqual(result.data, { __typename: "Query", subnet: null });
      assert.equal(result.errors.length, 1);
      assert.equal(result.errors[0].extensions.code, "BAD_USER_INPUT");
      assert.deepEqual(result.errors[0].path, ["subnet", "endpoints"]);
      assert.equal(state.requests.length, 0);
    });
  });
});
