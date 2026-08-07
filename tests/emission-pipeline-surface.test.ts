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
  EMISSION_PIPELINE_SORT_FIELDS,
  narrowEmissionPipeline,
  parseEmissionPipelineNarrowing,
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

describe("emission-pipeline surface — narrowing (#9720)", () => {
  const surface = () => projectEmissionPipeline(ECONOMICS)!;

  test("an empty narrowing leaves the body byte-for-byte unchanged", () => {
    // The whole back-compat claim in one assertion: every caller who does not
    // narrow must receive exactly what they received before this shipped,
    // including the ABSENCE of the two count fields.
    const before = surface();
    const after = narrowEmissionPipeline(before, {});
    assert.deepEqual(after, before);
    assert.equal("matched_subnet_count" in after, false);
    assert.equal("returned_subnet_count" in after, false);
  });

  test("sorts by final_share largest-first, and order flips it", () => {
    // final_share, not emission_share: #9707 established that the stage-1 price
    // share is not the number that answers "where is the emission", and subnet
    // 2 here is exactly that case -- a positive emission_share gated to zero.
    const [first] = narrowEmissionPipeline(surface(), {
      sort: "final_share",
    }).subnets;
    assert.equal(first.netuid, 1);
    assert.ok((first.final_share as number) > 0);

    const asc = narrowEmissionPipeline(surface(), {
      sort: "final_share",
      order: "asc",
    }).subnets;
    assert.equal(asc[0].netuid, 2);
    assert.equal(asc[0].final_share, 0);

    // The stage-1 share orders the other way round, which is the whole reason
    // both are offered.
    const byStage1 = narrowEmissionPipeline(surface(), {
      sort: "emission_share",
    }).subnets;
    assert.equal(byStage1[0].netuid, 2);
  });

  test("limit pages without hiding how many matched", () => {
    const narrowed = narrowEmissionPipeline(surface(), { limit: 1 });
    assert.equal(narrowed.subnets.length, 1);
    assert.equal(narrowed.matched_subnet_count, 2);
    assert.equal(narrowed.returned_subnet_count, 1);
  });

  test("fields projects the row and nothing else", () => {
    const narrowed = narrowEmissionPipeline(surface(), {
      fields: ["netuid", "final_share"],
    });
    for (const row of narrowed.subnets) {
      assert.deepEqual(Object.keys(row).sort(), ["final_share", "netuid"]);
    }
    assert.equal(narrowed.matched_subnet_count, 2);
  });

  test("NARROWING THE RESPONSE NEVER NARROWS THE MEASUREMENT", () => {
    // The one that matters. A caller asking for one row must still receive an
    // aggregate and a verification computed over EVERY subnet -- an identity
    // evaluated on a one-row slice is not a thing that can be verified, and
    // silently rescoping it would turn a narrowed response into an unsound one.
    const full = surface();
    const narrowed = narrowEmissionPipeline(full, {
      limit: 1,
      fields: ["netuid"],
      sort: "final_share",
    });
    assert.deepEqual(narrowed.aggregate, full.aggregate);
    assert.deepEqual(narrowed.verification, full.verification);
    assert.deepEqual(narrowed.chain_state, full.chain_state);
    assert.deepEqual(narrowed.field_sources, full.field_sources);
    // Spelled out rather than left to deepEqual: the aggregate counts BOTH
    // subnets while exactly one row is served, which is the property under
    // test. Rescoping the aggregate to the page would make these read 1 and 0.
    assert.equal(narrowed.subnets.length, 1);
    assert.equal(narrowed.aggregate.eligible_count, 2);
    assert.equal(narrowed.aggregate.disabled_count, 1);
    assert.equal(narrowed.aggregate.total_final_share, 1);
    assert.equal(
      narrowed.verification.checks.length,
      full.verification.checks.length,
    );
  });

  test("a row missing the sort column sinks in EITHER direction", () => {
    // `liquidity_fraction` is null on netuid 2 (tao_total is 0) and a real
    // number on netuid 1 -- a genuine mixed column, so this cannot pass
    // vacuously the way a fixture with no nulls in it would.
    const full = surface();
    assert.equal(
      (full.subnets.find((row) => row.netuid === 2) as unknown as Row)
        .liquidity_fraction,
      null,
      "fixture no longer produces a null sort value; the test would prove nothing",
    );

    for (const order of ["asc", "desc"] as const) {
      const rows = narrowEmissionPipeline(full, {
        sort: "liquidity_fraction",
        order,
      }).subnets;
      assert.equal(
        rows[rows.length - 1].netuid,
        2,
        `a null sort value floated on order=${order}`,
      );
      assert.equal(rows[0].netuid, 1);
    }

    // Nulls interleaved with values, so the comparator meets a missing value
    // as its LEFT operand as well as its right -- two rows only ever exercise
    // one of the two arms.
    const zeroTao = { tao_in_emission_tao: "0", excess_tao: "0" };
    const interleaved = projectEmissionPipeline({
      ...ECONOMICS,
      subnets: [
        { ...SUBNETS[0], netuid: 1, ...zeroTao },
        { ...SUBNETS[0], netuid: 2 },
        { ...SUBNETS[0], netuid: 3, ...zeroTao },
        { ...SUBNETS[0], netuid: 4 },
      ],
    })!;
    for (const order of ["asc", "desc"] as const) {
      const rows = narrowEmissionPipeline(interleaved, {
        sort: "liquidity_fraction",
        order,
      }).subnets;
      const measured = rows.filter(
        (row) => (row as unknown as Row).liquidity_fraction != null,
      );
      const missing = rows.filter(
        (row) => (row as unknown as Row).liquidity_fraction == null,
      );
      assert.equal(measured.length, 2);
      assert.equal(missing.length, 2);
      assert.deepEqual(
        rows.slice(-2).map((row) => row.netuid),
        missing.map((row) => row.netuid),
        `nulls did not sink to the end on order=${order}`,
      );
    }
  });

  test("equal sort values break on netuid, so the order is total", () => {
    const tied = projectEmissionPipeline({
      ...ECONOMICS,
      subnets: [
        { ...SUBNETS[0], netuid: 5 },
        { ...SUBNETS[0], netuid: 3 },
        { ...SUBNETS[0], netuid: 4 },
      ],
    })!;
    for (const order of ["asc", "desc"] as const) {
      assert.deepEqual(
        narrowEmissionPipeline(tied, {
          sort: "emission_share",
          order,
        }).subnets.map((row) => row.netuid),
        [3, 4, 5],
        `tie-break was not netuid-ascending on order=${order}`,
      );
    }
  });
});

describe("emission-pipeline surface — parseEmissionPipelineNarrowing (#9720)", () => {
  const rows = () =>
    projectEmissionPipeline(ECONOMICS)!.subnets as unknown as Row[];
  const parse = (qs: string) =>
    parseEmissionPipelineNarrowing(new URLSearchParams(qs), rows(), {
      limitMax: 512,
    });

  test("an empty query narrows nothing", () => {
    assert.deepEqual(parse(""), {
      sort: null,
      order: null,
      limit: null,
      fields: null,
    });
  });

  test("accepts every published sort field", () => {
    for (const sort of EMISSION_PIPELINE_SORT_FIELDS) {
      assert.equal((parse(`sort=${sort}`) as Row).sort, sort);
    }
  });

  test("names the offending parameter and lists what is valid", () => {
    const sort = parse("sort=whatever") as { error: Row };
    assert.equal(sort.error.parameter, "sort");
    assert.match(sort.error.message as string, /final_share/);

    const order = parse("order=sideways") as { error: Row };
    assert.equal(order.error.parameter, "order");

    const fields = parse("fields=netuid,not_a_column") as { error: Row };
    assert.equal(fields.error.parameter, "fields");
    assert.match(fields.error.message as string, /not_a_column/);
    assert.match(fields.error.message as string, /emission pipeline subnets/);
  });

  test("an out-of-range limit is REJECTED, never clamped", () => {
    for (const bad of ["0", "-1", "513", "1.5", "abc"]) {
      const result = parse(`limit=${encodeURIComponent(bad)}`) as {
        error: Row;
      };
      assert.ok("error" in result, `limit=${bad} should have been rejected`);
      assert.equal(result.error.parameter, "limit");
    }
    assert.equal((parse("limit=1") as Row).limit, 1);
    assert.equal((parse("limit=512") as Row).limit, 512);
  });

  test("a valid fields list comes back parsed and de-duplicated", () => {
    const parsed = parse("fields=netuid,final_share,netuid") as Row;
    assert.deepEqual(parsed.fields, ["netuid", "final_share"]);
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
    // The MCP tool applies a narrowing DEFAULT the other two surfaces do not
    // (#9720: a browser can stream 56 KB and a context window cannot), so
    // parity is asserted on the decomposition rather than on the page. Passing
    // an explicit limit above the subnet count removes the only difference.
    const mcp = (await callTool({ limit: 512 }, ECONOMICS as Row))
      .structuredContent;

    assert.deepEqual(mcp.subnets, shared.subnets);
    assert.deepEqual(mcp.aggregate, shared.aggregate);
    assert.deepEqual(mcp.verification, shared.verification);
    assert.deepEqual(mcp.chain_state, shared.chain_state);
    assert.deepEqual(mcp.field_sources, shared.field_sources);
    assert.equal(mcp.block_emission_tao, shared.block_emission_tao);

    // And the default really does narrow, so the asymmetry above is a
    // deliberate difference rather than a test written around a bug.
    const defaulted = (await callTool({}, ECONOMICS as Row)).structuredContent;
    assert.equal(defaulted.returned_subnet_count, shared.subnets.length);
    assert.equal(defaulted.matched_subnet_count, shared.subnets.length);
    assert.deepEqual(defaulted.aggregate, shared.aggregate);
    // GraphQL is selection-shaped, so compare the fields each query selected
    // rather than the whole object.
    assert.deepEqual(rows.subnets, shared.subnets);
    assert.equal(rows.block_emission_tao, shared.block_emission_tao);
    assert.deepEqual(rows.field_sources, shared.field_sources);
    assert.deepEqual(rollup.aggregate, shared.aggregate);
    assert.deepEqual(rollup.verification, shared.verification);
  });
});
