import type { z } from "zod";
import {
  ErrorEnvelopeSchema,
  successEnvelopeSchema,
} from "../schemas-src/envelope.ts";
import { EconomicsArtifactSchema } from "../schemas-src/routes/economics.ts";
import { GetEconomicsOutputSchema } from "../schemas-src/mcp-tools/get-economics.ts";
import {
  mcpAccountContext,
  withMcpAccount,
} from "./helpers/mcp-account-fixture.ts";
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { handleRequest } from "../workers/api.ts";
import { KV_ECONOMICS_CURRENT } from "../src/kv-keys.ts";
import { parseJsonBody } from "./row-type.ts";

// REST and MCP answer the same question about the same resource, and an
// external consumer found them holding two different snapshots of it — economics
// three hours and ~900 blocks apart between `GET /api/v1/economics` and the MCP
// `get_economics` tool.
//
// The two paths could not have disagreed at one instant: both read one KV key. But
// they read it through DIFFERENT code — REST via the memoized `readEconomicsCurrentKv`,
// MCP via a second raw `readHealthKv` — and nothing anywhere asserted they agree. This
// file is that assertion. It goes through `handleRequest` for BOTH surfaces rather than
// calling the composers directly, because the defect was in the Worker's wiring, not in
// either composer: a test that injects its own readers would have passed throughout.
//
// It matters most on MCP specifically: an agent there has no second, independent path
// to the same data, so a stale answer is indistinguishable from a current one. The
// external report said exactly that — it nearly shipped a conclusion that a rebuild was
// impossible because the API looked frozen.

// RELATIVE, not a literal. resolveLiveEconomics rejects a blob older than
// ECONOMICS_FRESHNESS_MAX_AGE_MS (8h) and falls through to R2 -- which this
// harness deliberately leaves empty so the KV tier is the one under test. A
// hardcoded stamp therefore makes this file a time bomb: it was committed dated
// slightly in the future, passed while wall-clock time was behind it, and went
// permanently red 8 hours after that instant, with a `not_found` from the R2
// fallback rather than anything resembling the freshness cause. Anchoring to
// now keeps the blob perpetually fresh, which is the precondition of the test,
// not its subject.
const CAPTURED_AT = new Date(Date.now() - 60_000).toISOString();
const BLOCK = 8_775_311;

const ECONOMICS_BLOB = {
  contract_version: "test-contract",
  captured_at: CAPTURED_AT,
  schema_version: 1,
  generated_at: CAPTURED_AT,
  network: "finney",
  chain_state: {
    block: BLOCK,
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
      alpha_price_tao: 0.01,
      alpha_out_pool: null,
      max_stake_alpha: null,
      max_uids: 256,
      max_validators: 64,
      miner_count: 0,
      owner_coldkey: null,
      owner_hotkey: null,
      registration_cost_tao: null,
      subnet_volume_tao: null,
      total_stake_alpha: null,
      validator_count: 0,
      name: "Allways",
      slug: "allways",
      block: BLOCK,
      emission_share: 1,
      registration_allowed: true,
      tao_in_pool_tao: 1000,
      alpha_in_pool: 100_000,
    },
  ],
};

/**
 * One env, one KV blob, both surfaces — the shape the defect lived in.
 *
 * `reads` counts every `economics:current` fetch so the test can also show the two
 * surfaces are not racing two independent reads of it.
 */
function makeEnv() {
  const reads: string[] = [];
  return {
    reads,
    env: withMcpAccount({
      METAGRAPH_CONTRACT_VERSION: "test-contract",
      METAGRAPH_CONTROL: {
        async get(key: string) {
          reads.push(key);
          return key === KV_ECONOMICS_CURRENT ? ECONOMICS_BLOB : null;
        },
      },
      // R2 must answer for the committed fallback path; returning nothing forces the
      // live KV tier to be the one under test.
      METAGRAPH_ARCHIVE: { get: async () => null },
    }),
  };
}

async function restEconomics<Schema extends z.ZodType>(
  env: Env,
  schema: Schema,
) {
  const response = await handleRequest(
    new Request("https://api.metagraph.sh/api/v1/economics?limit=1"),
    env,
    {
      waitUntil() {},
      passThroughOnException() {},
    } as unknown as ExecutionContext,
  );
  return parseJsonBody(response, schema);
}

async function mcpEconomics(env: Env) {
  const response = await handleRequest(
    new Request("https://api.metagraph.sh/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "get_economics", arguments: { limit: 1 } },
      }),
    }),
    env,
    {
      ...mcpAccountContext,
      passThroughOnException() {},
    } as unknown as ExecutionContext,
  );
  const body: unknown = await response.json();
  assert.ok(typeof body === "object" && body !== null);
  assert.ok("result" in body);
  const result = body.result;
  assert.ok(typeof result === "object" && result !== null);
  assert.ok("content" in result && Array.isArray(result.content));
  const content: unknown = result.content[0];
  assert.ok(typeof content === "object" && content !== null);
  assert.ok("text" in content && typeof content.text === "string");
  assert.ok(
    content.text,
    `MCP returned no tool content: ${JSON.stringify(body)}`,
  );
  const parsed: unknown = JSON.parse(content.text);
  return GetEconomicsOutputSchema.parseAsync(parsed);
}

describe("economics: REST and MCP resolve one snapshot", () => {
  test("both surfaces report the same captured_at and block", async () => {
    const { env } = makeEnv();
    const rest = await restEconomics(
      env,
      successEnvelopeSchema(EconomicsArtifactSchema),
    );
    const mcp = await mcpEconomics(env);

    const restData = rest.data;
    assert.ok(restData.chain_state);
    assert.equal(
      restData.captured_at,
      CAPTURED_AT,
      "REST did not serve the live KV tier — the fixture, not the assertion, is wrong",
    );
    assert.equal(
      mcp.captured_at,
      restData.captured_at,
      "MCP and REST are holding different snapshots of the same resource",
    );
    assert.equal(
      mcp.subnets[0].block,
      restData.chain_state.block,
      "the block an agent would cite differs by surface",
    );
  });

  test("both report the same tier, so neither can silently fall back alone", async () => {
    const { env } = makeEnv();
    const rest = await restEconomics(
      env,
      successEnvelopeSchema(EconomicsArtifactSchema),
    );
    const mcp = await mcpEconomics(env);
    assert.equal(rest.meta.source, "live-kv");
    assert.equal(mcp.source, rest.meta.source);
  });

  test("a cold KV tier degrades both surfaces the same way", async () => {
    // The failure that matters is not "both broken" but "one broken": if only one
    // surface falls back, an agent comparing them cannot tell which is right.
    const env = withMcpAccount({
      METAGRAPH_CONTRACT_VERSION: "test-contract",
      METAGRAPH_CONTROL: { get: async () => null },
      METAGRAPH_ARCHIVE: { get: async () => null },
    });
    const rest = await restEconomics(env, ErrorEnvelopeSchema);
    const mcp = await mcpEconomics(env).catch((error) => ({
      error: String(error),
    }));
    assert.equal(
      rest.ok,
      false,
      "no tier could answer, so REST must say so rather than serve an empty snapshot",
    );
    assert.ok(
      "error" in mcp || mcp.source !== "live-kv",
      "MCP claimed the live tier while REST could not reach it",
    );
  });

  test("the two surfaces share one read of the blob, not one each", async () => {
    // Not a performance assertion: two independently-timed reads of one key is the
    // structure that let the surfaces drift apart in the first place.
    const { env, reads } = makeEnv();
    await restEconomics(env, successEnvelopeSchema(EconomicsArtifactSchema));
    await mcpEconomics(env);
    const economicsReads = reads.filter((key) => key === KV_ECONOMICS_CURRENT);
    assert.ok(
      economicsReads.length <= 1,
      `both surfaces re-read economics:current independently (${economicsReads.length} reads)`,
    );
  });
});
