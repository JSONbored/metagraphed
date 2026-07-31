// #8744 tri-surface parity: the shared projection plus the two surfaces built
// on it in this change (GraphQL's emission_pipeline field and the
// get_emission_pipeline MCP tool). REST's own route tests live alongside the
// other analytics routes in tests/analytics.test.ts.
//
// The point of these is not that each surface returns *a* decomposition, but
// that all three return the SAME one from the same capture -- so the parity
// assertion at the bottom compares the three bodies field for field rather
// than spot-checking each in isolation.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  EMISSION_PIPELINE_UNAVAILABLE_CODE,
  EMISSION_PIPELINE_UNAVAILABLE_MESSAGE,
  projectEmissionPipeline,
  resolveEmissionPipelineEconomics,
} from "../src/emission-pipeline-surface.ts";
import { handleGraphQLRequest } from "../src/graphql.ts";
import { handleMcpRequest } from "../src/mcp-server.ts";
import { KV_ECONOMICS_CURRENT } from "../src/kv-keys.ts";
import type { Row } from "./row-type.ts";

const CHAIN_STATE = {
  block: 8_740_436,
  block_hash: `0x${"ab".repeat(32)}`,
  total_issuance_tao: 9_500_000,
  emission_gate_bar: 0.00927284254359668,
  emission_bar_quantile: 0.75,
  emission_gate_exponent: null,
};

const SUBNETS = [
  {
    netuid: 1,
    moving_price_pinned: 0.4,
    miner_burned_fraction: 0.1,
    emission_enabled: true,
    subtoken_enabled: true,
    registration_allowed_pinned: true,
    emission_share: 0.4,
    first_emission_block: 5_228_683,
    tao_in_emission_tao: "0.001185079",
    excess_tao: "0.001106056",
    alpha_in_emission: 0,
    alpha_out_emission: 1,
  },
  {
    netuid: 2,
    moving_price_pinned: 0.6,
    miner_burned_fraction: 0.2,
    emission_enabled: false,
    subtoken_enabled: true,
    registration_allowed_pinned: true,
    emission_share: 0.6,
    first_emission_block: 5_228_684,
    tao_in_emission_tao: "0.000000000",
    excess_tao: "0.000000000",
    alpha_in_emission: 0,
    alpha_out_emission: 1,
  },
];

const ECONOMICS = { chain_state: CHAIN_STATE, subnets: SUBNETS };

describe("emission-pipeline surface — projectEmissionPipeline", () => {
  test("decomposes a capture and labels every field's provenance", () => {
    const data = projectEmissionPipeline(ECONOMICS)!;
    assert.equal(data.chain_state.block, 8_740_436);
    assert.equal(data.subnets.length, 2);
    // Stage 5: the disabled subnet is zeroed and its share redistributed.
    assert.equal(data.subnets[1].final_share, 0);
    assert.ok(Math.abs(data.subnets[0].final_share! - 1) < 1e-9);
    assert.equal(data.field_sources.final_share.kind, "reconstructed");
    assert.equal(
      data.field_sources.tao_in_emission.storage,
      "SubtensorModule.SubnetTaoInEmission",
    );
    // ADR 0023 decision 3 in band: the identities are checked on these rows.
    assert.equal(typeof data.verification.verified, "boolean");
  });

  test("netuid narrows the rows and leaves the aggregate network-wide", () => {
    const data = projectEmissionPipeline(ECONOMICS, 1)!;
    assert.equal(data.subnets.length, 1);
    assert.equal(data.subnets[0].netuid, 1);
    // A filtered view must not silently redefine "the network split" as
    // "this subnet" -- both rows still count toward the aggregate.
    assert.equal(data.aggregate.eligible_count, 2);
    assert.equal(
      data.aggregate.tao_total,
      projectEmissionPipeline(ECONOMICS)!.aggregate.tao_total,
    );
  });

  test("a capture with no subnets array decomposes to no rows", () => {
    // Not an error: a chain_state without rows is a degraded capture, not an
    // unpinned one, and the aggregate of nothing is honestly zero.
    const data = projectEmissionPipeline({ chain_state: CHAIN_STATE })!;
    assert.deepEqual(data.subnets, []);
    assert.equal(data.aggregate.tao_total, 0);
  });

  test("null rather than a partial body when nothing pinned the inputs", () => {
    assert.equal(projectEmissionPipeline(null), null);
    assert.equal(projectEmissionPipeline(undefined), null);
    assert.equal(projectEmissionPipeline({ subnets: SUBNETS }), null);
  });
});

describe("emission-pipeline surface — resolveEmissionPipelineEconomics", () => {
  const freshBlob = {
    captured_at: new Date(Date.now() - 60_000).toISOString(),
    summary: { with_economics_count: SUBNETS.length },
    ...ECONOMICS,
  };

  test("prefers the live KV tier and never touches R2 when it serves", async () => {
    let artifactReads = 0;
    const data = await resolveEmissionPipelineEconomics({
      env: {} as unknown as Env,
      readHealthKv: async (_env, key) =>
        key === KV_ECONOMICS_CURRENT ? freshBlob : null,
      contractVersion: "v1",
      readArtifact: async () => {
        artifactReads += 1;
        return null;
      },
    });
    assert.equal((data as Row).chain_state.block, 8_740_436);
    assert.equal(artifactReads, 0);
  });

  test("falls back to the committed artifact when the live tier is cold", async () => {
    const data = await resolveEmissionPipelineEconomics({
      env: {} as unknown as Env,
      // No reader at all is the cold case resolveLiveEconomics returns null for.
      contractVersion: "v1",
      readArtifact: async () => ECONOMICS,
    });
    assert.equal((data as Row).chain_state.block, 8_740_436);
  });

  test("passes a stale live blob over to R2 rather than decomposing it", async () => {
    // resolveLiveEconomics rejects a blob whose emission_share no longer sums
    // to ~1 (a partial write). The fallback must still produce a body.
    const data = await resolveEmissionPipelineEconomics({
      env: {} as unknown as Env,
      readHealthKv: async () => ({
        ...freshBlob,
        subnets: [{ ...SUBNETS[0], emission_share: 0.1 }],
        summary: { with_economics_count: 1 },
      }),
      contractVersion: "v1",
      readArtifact: async () => ECONOMICS,
    });
    assert.equal((data as Row).subnets.length, 2);
  });
});

// GraphQL reads its own live-preferring economics memo; with no KV tier the
// R2 fixture is what it decomposes.
function graphqlEnv(economics: Row | null): Row {
  return {
    METAGRAPH_R2_LATEST_PREFIX: "latest/",
    METAGRAPH_ARCHIVE: {
      async get(key: string) {
        if (key !== "latest/economics.json" || !economics) return null;
        return {
          async json() {
            return economics;
          },
        };
      },
    },
  };
}

async function gql(query: string, env: Row) {
  const res = await handleGraphQLRequest(
    new Request("https://api.metagraph.sh/api/v1/graphql", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query }),
    }),
    env as unknown as Env,
  );
  return (await res.json()) as Row;
}

// Split across two queries on purpose: selecting every field of this type at
// once costs 51 against the schema's 50-point complexity budget, so a client
// wanting the whole decomposition through GraphQL has to page it the same way.
const GQL_ROWS_QUERY = `{
  emission_pipeline {
    chain_state { block block_hash emission_gate_bar emission_gate_exponent }
    block_emission_tao
    block_emission_halvings
    field_sources
    subnets {
      netuid ineligible_reason emission_share miner_burned weighted_share
      gated_share emission_enabled final_share gate_delta distance_to_bar
      tao_in_emission excess_tao tao_total liquidity_fraction
      alpha_in_emission alpha_out_emission
    }
  }
}`;

const GQL_ROLLUP_QUERY = `{
  emission_pipeline {
    aggregate {
      eligible_count disabled_count tao_in_emission excess_tao tao_total
      liquidity_fraction total_final_share
    }
    verification {
      verified subnet_share_tolerance aggregate_tolerance_rao
      checks { name ok detail }
    }
  }
}`;

describe("emission-pipeline surface — GraphQL", () => {
  test("emission_pipeline serves the decomposition", async () => {
    const body = await gql(GQL_ROWS_QUERY, graphqlEnv(ECONOMICS as Row));
    assert.equal(body.errors, undefined);
    const data = body.data.emission_pipeline;
    assert.equal(data.chain_state.block, 8_740_436);
    // Null h reaches the client as null, not as the resolved default 3 -- the
    // consumer resolves it, exactly as chain_state's own contract says.
    assert.equal(data.chain_state.emission_gate_exponent, null);
    assert.equal(data.subnets.length, 2);
    assert.equal(data.subnets[1].emission_enabled, false);
    assert.equal(data.subnets[1].final_share, 0);
    assert.equal(data.field_sources.final_share.kind, "reconstructed");
  });

  test("emission_pipeline serves the rollup and the identity checks", async () => {
    const body = await gql(GQL_ROLLUP_QUERY, graphqlEnv(ECONOMICS as Row));
    assert.equal(body.errors, undefined);
    const data = body.data.emission_pipeline;
    assert.equal(data.aggregate.eligible_count, 2);
    assert.equal(typeof data.verification.verified, "boolean");
    assert.ok(Array.isArray(data.verification.checks));
    // A rao count is a string; a JSON number is the wrong type for a bigint.
    assert.equal(typeof data.verification.aggregate_tolerance_rao, "string");
  });

  test("netuid narrows the rows only", async () => {
    const body = await gql(
      "{ emission_pipeline(netuid: 2) { subnets { netuid } aggregate { eligible_count } } }",
      graphqlEnv(ECONOMICS as Row),
    );
    assert.equal(body.data.emission_pipeline.subnets.length, 1);
    assert.equal(body.data.emission_pipeline.subnets[0].netuid, 2);
    assert.equal(body.data.emission_pipeline.aggregate.eligible_count, 2);
  });

  test("errors rather than serving an unpinned decomposition", async () => {
    // Not the schema-stable-empty treatment blocks/validators get: without the
    // block there is no honest body to return, only an error.
    const body = await gql(
      "{ emission_pipeline { chain_state { block } } }",
      graphqlEnv({ subnets: SUBNETS } as Row),
    );
    assert.equal(body.data, null);
    assert.equal(
      body.errors[0].extensions.code,
      EMISSION_PIPELINE_UNAVAILABLE_CODE.toUpperCase(),
    );
    assert.equal(body.errors[0].message, EMISSION_PIPELINE_UNAVAILABLE_MESSAGE);
  });
});

async function callTool(args: Row, economics: Row | null) {
  const response = await handleMcpRequest(
    new Request("https://metagraph.sh/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "get_emission_pipeline", arguments: args },
      }),
    }),
    {} as unknown as Env,
    {
      readArtifact: async (_env: Row, path: string) =>
        path === "/metagraph/economics.json" && economics
          ? { ok: true, data: economics }
          : { ok: false, status: 404 },
    },
  );
  return ((await response.json()) as Row).result;
}

describe("emission-pipeline surface — MCP", () => {
  test("get_emission_pipeline serves the decomposition", async () => {
    const result = await callTool({}, ECONOMICS as Row);
    assert.notEqual(result.isError, true);
    const data = result.structuredContent;
    assert.equal(data.chain_state.block, 8_740_436);
    assert.equal(data.subnets.length, 2);
    assert.equal(data.field_sources.emission_share.kind, "measured");
    assert.equal(typeof data.verification.verified, "boolean");
  });

  test("netuid narrows the rows only", async () => {
    const result = await callTool({ netuid: 1 }, ECONOMICS as Row);
    assert.equal(result.structuredContent.subnets.length, 1);
    assert.equal(result.structuredContent.subnets[0].netuid, 1);
    assert.equal(result.structuredContent.aggregate.eligible_count, 2);
  });

  test("errors rather than serving an unpinned decomposition", async () => {
    const result = await callTool({}, { subnets: SUBNETS } as Row);
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /pinned to/);
  });

  test("errors when the economics tier is cold entirely", async () => {
    const result = await callTool({}, null);
    assert.equal(result.isError, true);
  });
});

describe("emission-pipeline surface — tri-surface parity", () => {
  test("REST, GraphQL, and MCP decompose one capture identically", async () => {
    // The shared projection IS what REST serves (workers/request-handlers/
    // analytics-routes.ts hands it straight to the envelope), so comparing the
    // other two against it is comparing all three.
    const shared = JSON.parse(
      JSON.stringify(projectEmissionPipeline(ECONOMICS)),
    );
    const env = graphqlEnv(ECONOMICS as Row);
    const rows = (await gql(GQL_ROWS_QUERY, env)).data.emission_pipeline;
    const rollup = (await gql(GQL_ROLLUP_QUERY, env)).data.emission_pipeline;
    const mcp = (await callTool({}, ECONOMICS as Row)).structuredContent;

    assert.deepEqual(mcp, shared);
    // GraphQL is selection-shaped, so compare the fields each query selected
    // rather than the whole object.
    assert.deepEqual(rows.subnets, shared.subnets);
    assert.equal(rows.block_emission_tao, shared.block_emission_tao);
    assert.deepEqual(rows.field_sources, shared.field_sources);
    assert.deepEqual(rollup.aggregate, shared.aggregate);
    assert.deepEqual(rollup.verification, shared.verification);
  });
});
