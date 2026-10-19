import type { z } from "zod";
import { successEnvelopeSchema } from "../schemas-src/envelope.ts";
import { EconomicsArtifactSchema } from "../schemas-src/routes/economics.ts";
import { GetEconomicsOutputSchema } from "../schemas-src/mcp-tools/get-economics.ts";
import { GetFreshnessOutputSchema } from "../schemas-src/mcp-tools/meta-artifacts-1.ts";
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
import { parseJsonBody, type Row } from "./row-type.ts";

const contract = "test-contract";
function blob(overrides: Row = {}) {
  return {
    schema_version: 1,
    generated_at: new Date(Date.now() - 60000).toISOString(),
    contract_version: contract,
    captured_at: new Date(Date.now() - 60000).toISOString(),
    network: "finney",
    chain_state: {
      block: 9000000,
      block_hash: `0x${"ab".repeat(32)}`,
      total_issuance_tao: 9_500_000,
      emission_gate_bar: null,
      emission_bar_quantile: null,
      emission_gate_exponent: null,
    },
    summary: {
      registration_open_count: 1,
      subnet_count: 1,
      total_alpha_value_tao: "0.000000000",
      total_miners: 0,
      total_network_value_tao: "0.000000000",
      total_root_value_tao: "0.000000000",
      total_stake_alpha: "0.000000000",
      total_validators: 0,
      with_economics_count: 1,
    },
    subnets: [
      {
        netuid: 7,
        alpha_out_pool: null,
        max_stake_alpha: null,
        max_uids: 256,
        max_validators: 64,
        miner_count: 0,
        owner_coldkey: null,
        owner_hotkey: null,
        registration_allowed: true,
        registration_cost_tao: null,
        subnet_volume_tao: null,
        total_stake_alpha: null,
        validator_count: 0,
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
async function mcpBatch<Schema extends z.ZodType>(
  response: Response,
  schema: Schema,
): Promise<z.output<Schema>[]> {
  const replies: unknown = await response.json();
  assert.ok(Array.isArray(replies));
  const parsed: z.output<Schema>[] = [];
  for (const rawReply of replies) {
    const reply: unknown = rawReply;
    assert.ok(typeof reply === "object" && reply !== null);
    assert.ok("result" in reply);
    const result = reply.result;
    assert.ok(typeof result === "object" && result !== null);
    assert.notEqual(
      "isError" in result ? result.isError : undefined,
      true,
      JSON.stringify(reply),
    );
    assert.ok("structuredContent" in result);
    parsed.push(await schema.parseAsync(result.structuredContent));
  }
  return parsed;
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
  const body = await parseJsonBody(
    response,
    successEnvelopeSchema(EconomicsArtifactSchema),
  );
  assert.equal(body.meta.source, "live-kv");
  assert.equal(body.meta.published_at, live.captured_at);
  assert.ok(body.data.chain_state);
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
    const body = await parseJsonBody(
      response,
      successEnvelopeSchema(EconomicsArtifactSchema),
    );
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
  const replies = await mcpBatch(response, GetEconomicsOutputSchema);
  assert.equal(replies.length, 10);
  for (const reply of replies) {
    assert.equal(reply.source, "live-kv");
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
    METAGRAPH_ARCHIVE: {
      get: async () => ({
        json: async () => ({
          schema_version: 1,
          generated_at: stamp,
          sources: [
            {
              id: "surface-health",
              status: "stale",
              as_of: null,
              lane: "health-probe",
              path: "/metagraph/health.json",
              required_for_publish: true,
              stale_after_hours: 1,
              stale_behavior: "warn",
              timestamp: null,
              timestamp_field: "last_run_at",
            },
          ],
          summary: {
            adapter_count: 0,
            adapter_snapshot_as_of: null,
            blocking_source_count: 0,
            candidate_discovery_as_of: null,
            health_surface_count: 0,
            health_probe_as_of: null,
            missing_blocking_source_count: 0,
            native_snapshot_captured_at: stamp,
            native_data_as_of: stamp,
            openapi_surface_count: 0,
            publish_ready_without_age_check: true,
            schema_snapshot_as_of: null,
            stale_window_warnings: [],
            verification_as_of: null,
            verification_generated_at: null,
            warning_source_count: 1,
          },
        }),
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
  const replies = await mcpBatch(response, GetFreshnessOutputSchema);
  assert.equal(replies.length, 10);
  for (const reply of replies) {
    const source = reply.sources.find((s) => s.id === "surface-health");
    assert.ok(source);
    assert.equal(source.status, "current");
    assert.equal(source.timestamp, stamp);
  }
  assert.equal(reads.filter((k) => k === KV_HEALTH_META).length, 1);
  assert.equal(reads.filter((k) => k === KV_ECONOMICS_CURRENT).length, 1);
});
