// #10932: the three surfaces over the cost-to-participate card.
//
// What is only reachable from here is the WIRING, and one claim in particular
// that a builder test cannot make: that all three surfaces merge the SAME entry
// costs. The Neon tier cannot reach the validator-economics composer, so REST,
// MCP and GraphQL each merge those three fields on top of the tier's answer --
// and a surface that forgot to would serve a card with null costs while its two
// siblings served real ones, with nothing else in the repo noticing.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { handleRequest } from "../workers/api.ts";
import { MCP_TOOLS } from "../src/mcp-server.ts";
import { handleGraphQLRequest } from "../src/graphql.ts";
import { handleSubnetCostToParticipate } from "../workers/request-handlers/entities.ts";
import { jsonBody, mockEnv, type Row } from "./row-type.ts";

const NETUID = 7;
const PATH = `/api/v1/subnets/${NETUID}/cost-to-participate`;
const req = (p: string) => new Request(`https://api.metagraph.sh${p}`);

function tool(name: string) {
  const found = MCP_TOOLS.find((t) => t.name === name);
  assert.ok(found, `${name} must be registered`);
  return found as {
    handler: (a: Row, c: unknown) => Promise<unknown>;
    description: string;
  };
}

/** A tier that answers with a declaration — including the inconsistent GPU
 * stanza, which is the one that must survive every hop unchanged. */
function tierEnv(body: unknown) {
  return {
    ...(mockEnv() as unknown as Record<string, unknown>),
    METAGRAPH_NEURONS_SOURCE: "data-api",
    DATA_API: { fetch: async () => Response.json(body) },
  } as never;
}

const INCONSISTENT_SPEC = {
  gpu: {
    requirement: "declared-inconsistently",
    declared_required: false,
    declared_min_vram_gb: 8,
    declared_min_count: null,
    declared_model: "NVIDIA A100",
  },
  cpu: { min_cores: 4, min_speed_ghz: 2.5, architecture: "x86_64" },
  memory: { min_ram_gb: 16, min_swap_gb: 4 },
  storage: { min_space_gb: 10, min_iops: 1000, type: "SSD" },
  network: { min_download_speed_mbps: null, min_upload_speed_mbps: null },
};

const EVIDENCE = {
  source_url: "https://raw.githubusercontent.com/a/b/main/min_compute.yml",
  read_at_sha: "abc1234",
  spec_version: "0.0.17",
  observed_at: "2026-08-13T00:00:00.000Z",
  first_seen: "2026-08-01T00:00:00.000Z",
};

const WITH_DECLARATION = {
  schema_version: 1,
  netuid: NETUID,
  entry_cost: {
    registration_cost_tao: null,
    validator_permit_floor_tao: null,
    validator_earning_floor_tao: null,
  },
  declarations_read: 1,
  declared_compute: {
    miner: INCONSISTENT_SPEC,
    validator: null,
    evidence: EVIDENCE,
  },
  declarations: [
    {
      evidence: EVIDENCE,
      found: true,
      miner: INCONSISTENT_SPEC,
      validator: null,
    },
  ],
  earnings: {
    days_covered: 8,
    miner_uid_count: 247,
    zero_emission_pct: 0.96,
    never_earned_count: 237,
    median_earning_days: 0,
  },
  not_modelled: [
    "A declared minimum is the floor to RUN, not the spec to EARN.",
  ],
  field_sources: {},
};

describe("GET /api/v1/subnets/{netuid}/cost-to-participate", () => {
  test("a cold store answers 200 with declarations_read 0, never 404", async () => {
    const res = await handleRequest(req(PATH), mockEnv());
    assert.equal(res.status, 200);
    const data = (await jsonBody(res)).data as Row;
    assert.equal(data.netuid, NETUID);
    assert.equal(data.declarations_read, 0);
    assert.deepEqual(data.declarations, []);
    // Null, not an empty spec: "nobody has looked" is not "needs nothing".
    assert.equal((data.declared_compute as Row).miner, null);
    // The entry-cost block is always present even when its values are not.
    assert.equal(
      (data.entry_cost as Row).registration_cost_tao,
      null,
      "an unread entry cost is not a free one",
    );
    assert.ok((data.not_modelled as string[]).length > 0);
  });

  test("rejects an unsupported query parameter", async () => {
    // The route is in NO_QUERY_PARAMETERS; without that it would silently
    // accept anything.
    const res = await handleRequest(req(`${PATH}?window=7d`), mockEnv());
    assert.equal(res.status, 400);
    assert.equal(((await jsonBody(res)).error as Row)?.code, "invalid_query");
  });

  test("the handler merges the entry costs the tier cannot reach", async () => {
    // The composer is injected so the merge is exercised rather than only the
    // degraded arm -- without this the handler's whole reason for existing
    // (three exact numbers a Neon read cannot produce) is untested.
    const res = await handleSubnetCostToParticipate(
      req(PATH),
      mockEnv(),
      NETUID,
      {
        loadEntryCost: async () => ({
          data: {
            registration_cost_tao: 0.5,
            permit_floor_cost_tao: 1200,
            earning_floor_cost_tao: 8400,
          },
          generatedAt: null,
        }),
      },
    );
    assert.equal(res.status, 200);
    const entry = (await jsonBody(res)).data.entry_cost as Row;
    assert.equal(entry.registration_cost_tao, 0.5);
    assert.equal(entry.validator_permit_floor_tao, 1200);
    assert.equal(entry.validator_earning_floor_tao, 8400);
  });

  test("a forwarded card reaches REST with the tri-state intact", async () => {
    const res = await handleRequest(req(PATH), tierEnv(WITH_DECLARATION));
    const data = (await jsonBody(res)).data as Row;
    assert.equal(data.declarations_read, 1);
    const gpu = ((data.declared_compute as Row).miner as Row).gpu as Row;
    assert.equal(gpu.requirement, "declared-inconsistently");
    assert.equal(gpu.declared_min_vram_gb, 8);
  });
});

describe("the MCP tool", () => {
  test("is registered and answers on a cold store", async () => {
    const out = (await tool("get_subnet_cost_to_participate").handler(
      { netuid: NETUID },
      { env: mockEnv() } as never,
    )) as Row;
    assert.equal(out.netuid, NETUID);
    assert.equal(out.declarations_read, 0);
    // The merge runs on this surface too, so the block is present rather than
    // missing -- an absent entry_cost would fail the tool's own outputSchema.
    assert.ok(out.entry_cost);
  });

  test("rejects a netuid outside the u16 range", async () => {
    await assert.rejects(
      () =>
        tool("get_subnet_cost_to_participate").handler({ netuid: 70000 }, {
          env: mockEnv(),
        } as never),
      /u16 range/,
    );
  });

  test("THE DESCRIPTION FORBIDS THE ARITHMETIC THE DATA INVITES", () => {
    // This tool's failure mode is an agent multiplying a declared minimum by a
    // rental rate and subtracting it from an emission figure. The description
    // is the only instruction it gets.
    const d = tool("get_subnet_cost_to_participate").description;
    assert.match(d, /DO NOT COMPUTE A PROFIT/);
    assert.match(d, /floor to \n?RUN, not the spec to EARN/);
    assert.match(d, /NOT report it as either boolean/);
    assert.match(d, /NO DECLARATION HAS BEEN \n?READ/);
  });
});

describe("the GraphQL field", () => {
  const gql = async (query: string, env: unknown = mockEnv()) => {
    const res = await handleGraphQLRequest(
      new Request("https://api.metagraph.sh/api/v1/graphql", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query }),
      }),
      env as never,
      undefined,
    );
    return { status: res.status, body: (await res.json()) as Row };
  };

  test("serves the empty card without erroring", async () => {
    const { status, body } = await gql(
      `query { subnet_cost_to_participate(netuid: ${NETUID}) {
         netuid declarations_read not_modelled
         entry_cost { registration_cost_tao validator_earning_floor_tao }
         declared_compute { miner { gpu { requirement } } }
       } }`,
    );
    assert.equal(status, 200);
    assert.equal(body.errors, undefined);
    const card = body.data.subnet_cost_to_participate as Row;
    assert.equal(card.declarations_read, 0);
    assert.equal((card.declared_compute as Row).miner, null);
    assert.equal((card.entry_cost as Row).registration_cost_tao, null);
  });

  test("THE TRI-STATE SURVIVES THE RESOLVER'S FIELD LIST", async () => {
    // The claim a builder test cannot make. A resolver that named
    // `declared_required` where the schema names `requirement` would publish a
    // boolean for the one case that must never be one.
    const { body } = await gql(
      `query { subnet_cost_to_participate(netuid: ${NETUID}) {
         declarations { found
           miner { gpu { requirement declared_required declared_min_vram_gb declared_model } }
           evidence { read_at_sha spec_version } }
         earnings { zero_emission_pct days_covered }
       } }`,
      tierEnv(WITH_DECLARATION),
    );
    assert.equal(body.errors, undefined);
    const card = body.data.subnet_cost_to_participate as Row;
    const [declaration] = card.declarations as Row[];
    const gpu = (declaration.miner as Row).gpu as Row;
    assert.equal(gpu.requirement, "declared-inconsistently");
    assert.equal(gpu.declared_required, false);
    assert.equal(gpu.declared_min_vram_gb, 8);
    assert.equal(gpu.declared_model, "NVIDIA A100");
    assert.equal((declaration.evidence as Row).read_at_sha, "abc1234");
    // The earnings side must survive too — a floor-to-run without it is the
    // reading this surface exists to prevent.
    assert.equal((card.earnings as Row).zero_emission_pct, 0.96);
  });

  test("survives an upstream body missing every field", async () => {
    const { body } = await gql(
      `query { subnet_cost_to_participate(netuid: ${NETUID}) {
         schema_version netuid declarations_read not_modelled
         entry_cost { registration_cost_tao }
         declared_compute { miner { gpu { requirement } } validator { gpu { requirement } } }
         declarations { found }
         earnings { days_covered }
       } }`,
      tierEnv({}),
    );
    assert.equal(body.errors, undefined, "an empty body must not error");
    const card = body.data.subnet_cost_to_participate as Row;
    assert.equal(card.declarations_read, 0);
    assert.deepEqual(card.declarations, []);
    assert.equal(card.earnings, null);
    assert.equal((card.declared_compute as Row).validator, null);
  });
});
