import assert from "node:assert/strict";
import { test } from "vitest";
import {
  handleRequest,
  readHealthMetaKv,
  readEconomicsCurrentKv,
} from "../workers/api.ts";
import {
  KV_ECONOMICS_CURRENT,
  KV_HEALTH_META,
  KV_TAO_USD_CURRENT,
} from "../src/kv-keys.ts";
import {
  mcpAccountContext,
  withMcpAccount,
} from "./helpers/mcp-account-fixture.ts";
import { resetModuleState } from "../src/module-state-registry.ts";
import type { Row } from "./row-type.ts";

const contract = "test-contract";
function blob(overrides: Row = {}) {
  return {
    schema_version: 1,
    contract_version: contract,
    captured_at: new Date(Date.now() - 60000).toISOString(),
    network: "finney",
    chain_state: { block: 9000000, block_hash: "0xabc" },
    summary: { with_economics_count: 1, subnet_count: 1 },
    subnets: [
      {
        netuid: 7,
        name: "Seven",
        slug: "seven",
        emission_share: 1,
        tao_in_pool_tao: 100,
        alpha_in_pool: 1000,
        alpha_price_tao: 0.1,
      },
    ],
    ...overrides,
  };
}
function environment(live: Row | null) {
  const reads: string[] = [],
    fallback = blob({ captured_at: "2026-01-01T00:00:00.000Z" });
  const env = withMcpAccount({
    METAGRAPH_CONTRACT_VERSION: contract,
    METAGRAPH_DISABLE_REQUEST_LOGS: "true",
    METAGRAPH_CONTROL: {
      async get(key: string) {
        reads.push(key);
        if (key === KV_ECONOMICS_CURRENT) return live;
        if (key === KV_TAO_USD_CURRENT)
          return {
            usd_per_tao: 250,
            observed_at: new Date().toISOString(),
            price_basis: "fixture",
            block_number: 9000000,
          };
        return null;
      },
    },
    METAGRAPH_ARCHIVE: {
      async get(key: string) {
        if (key.endsWith("economics.json")) {
          reads.push("economics-fallback");
          return { json: async () => fallback };
        }
        return null;
      },
    },
  });
  return { env, reads, fallback };
}
async function rest(env: Env, suffix = "") {
  return handleRequest(
    new Request(`https://api.metagraph.sh/api/v1/economics${suffix}`),
    env,
    {
      waitUntil() {},
      passThroughOnException() {},
    } as unknown as ExecutionContext,
  );
}

test("healthy REST economics avoids the fallback while preserving source, freshness, spot/USD and CSV shaping", async () => {
  const live = blob(),
    f = environment(live);
  const response = await rest(f.env, "?limit=1");
  assert.equal(response.status, 200);
  const body = (await response.json()) as Row;
  assert.equal(body.meta.source, "live-kv");
  assert.equal(body.meta.published_at, live.captured_at);
  assert.equal(body.data.chain_state.block, live.chain_state.block);
  assert.equal(body.data.subnets[0].spot_price_tao, 0.1);
  assert(body.data.field_sources);
  assert.equal(f.reads.filter((k) => k === "economics-fallback").length, 0);
  const csv = await rest(f.env, "?format=csv&limit=1");
  assert.equal(csv.status, 200);
  assert.match(csv.headers.get("content-type") ?? "", /csv/);
  assert.match(await csv.text(), /netuid/);
  assert.equal(f.reads.filter((k) => k === "economics-fallback").length, 0);
});

test("cold, stale and invalid live economics still read the same fallback and report its source", async () => {
  for (const live of [
    null,
    blob({ captured_at: "2020-01-01T00:00:00.000Z" }),
    blob({ contract_version: "wrong" }),
  ]) {
    const f = environment(live);
    const response = await rest(f.env);
    assert.equal(response.status, 200);
    const body = (await response.json()) as Row;
    assert.equal(body.meta.source, "r2-fallback");
    assert.equal(f.reads.filter((k) => k === "economics-fallback").length, 1);
    assert.equal(body.data.subnets[0].netuid, 7);
  }
});

test("production ten-tool MCP batch coalesces the cold economics read without reading fallback", async () => {
  const f = environment(blob());
  const messages = Array.from({ length: 10 }, (_, id) => ({
    jsonrpc: "2.0",
    id: id + 1,
    method: "tools/call",
    params: { name: "get_economics", arguments: { limit: 1 } },
  }));
  const response = await handleRequest(
    new Request("https://api.metagraph.sh/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(messages),
    }),
    f.env,
    {
      ...mcpAccountContext,
      passThroughOnException() {},
    } as unknown as ExecutionContext,
  );
  const replies = (await response.json()) as Row[];
  assert.equal(replies.length, 10);
  for (const reply of replies) {
    assert.notEqual(reply.result?.isError, true);
    assert.equal(reply.result.structuredContent.source, "live-kv");
  }
  assert.equal(f.reads.filter((k) => k === KV_ECONOMICS_CURRENT).length, 1);
  assert.equal(f.reads.filter((k) => k === "economics-fallback").length, 0);
});

test("production health/economics cold misses share pending reads and reset clears both owners", async () => {
  const reads: string[] = [],
    env = {
      METAGRAPH_CONTROL: {
        async get(key: string) {
          reads.push(key);
          await Promise.resolve();
          return key === KV_HEALTH_META ? { last_run_at: "health" } : blob();
        },
      },
    } as unknown as Env;
  await Promise.all(
    Array.from({ length: 10 }, () => readHealthMetaKv(env, 1000)),
  );
  await Promise.all(
    Array.from({ length: 10 }, () => readEconomicsCurrentKv(env, 1000)),
  );
  assert.equal(reads.filter((k) => k === KV_HEALTH_META).length, 1);
  assert.equal(reads.filter((k) => k === KV_ECONOMICS_CURRENT).length, 1);
  resetModuleState();
  await readHealthMetaKv(env, 1001);
  await readEconomicsCurrentKv(env, 1001);
  assert.equal(reads.filter((k) => k === KV_HEALTH_META).length, 2);
  assert.equal(reads.filter((k) => k === KV_ECONOMICS_CURRENT).length, 2);
});

test("production MCP freshness batch shares health-meta and economics while retaining live source stamps", async () => {
  const reads: string[] = [];
  const stamp = new Date().toISOString();
  const env = withMcpAccount({
    METAGRAPH_CONTRACT_VERSION: contract,
    METAGRAPH_DISABLE_REQUEST_LOGS: "true",
    ASSETS: {
      fetch: async () =>
        Response.json({
          schema_version: 1,
          sources: [{ id: "surface-health", status: "stale" }],
          summary: {},
        }),
    },
    METAGRAPH_CONTROL: {
      get: async (key: string) => {
        reads.push(key);
        if (key === KV_HEALTH_META) return { last_run_at: stamp };
        if (key === KV_ECONOMICS_CURRENT) return blob();
        return null;
      },
    },
  });
  const response = await handleRequest(
    new Request("https://api.metagraph.sh/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(
        Array.from({ length: 10 }, (_, id) => ({
          jsonrpc: "2.0",
          id: id + 1,
          method: "tools/call",
          params: { name: "get_freshness", arguments: {} },
        })),
      ),
    }),
    env,
    {
      ...mcpAccountContext,
      passThroughOnException() {},
    } as unknown as ExecutionContext,
  );
  const replies = await response.json<Row[]>();
  assert.equal(replies.length, 10);
  for (const reply of replies) {
    assert.notEqual(reply.result?.isError, true);
    const source = reply.result.structuredContent.sources.find(
      (s: Row) => s.id === "surface-health",
    );
    assert.equal(source.status, "current");
    assert.equal(source.timestamp, stamp);
  }
  assert.equal(reads.filter((k) => k === KV_HEALTH_META).length, 1);
  assert.equal(reads.filter((k) => k === KV_ECONOMICS_CURRENT).length, 1);
});
