// #10933: the three surfaces over the treasury card.
//
// What is only reachable from here is the WIRING, and one claim in particular
// that a builder test cannot make: that an unreviewed finding does not leak
// through a resolver's field list. The builder withholding it proves nothing
// if GraphQL names `declared_share` off the raw row.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { handleRequest } from "../workers/api.ts";
import { MCP_TOOLS } from "../src/mcp-server.ts";
import { handleGraphQLRequest } from "../src/graphql.ts";
import { handleSubnetTreasury } from "../workers/request-handlers/entities.ts";
import { jsonBody, mockEnv, type Row } from "./row-type.ts";

const NETUID = 7;
const PATH = `/api/v1/subnets/${NETUID}/treasury`;
const req = (p: string) => new Request(`https://api.metagraph.sh${p}`);

function tool(name: string) {
  const found = MCP_TOOLS.find((t) => t.name === name);
  assert.ok(found, `${name} must be registered`);
  return found as {
    handler: (a: Row, c: unknown) => Promise<unknown>;
    description: string;
  };
}

/** A tier that answers with a candidate finding — the shape that must not leak. */
function tierEnv(body: unknown) {
  return {
    ...(mockEnv() as unknown as Record<string, unknown>),
    METAGRAPH_NEURONS_SOURCE: "data-api",
    DATA_API: { fetch: async () => Response.json(body) },
  } as never;
}

const WITH_CANDIDATE = {
  schema_version: 1,
  netuid: NETUID,
  repos_read: 2,
  reviewed_count: 1,
  pending_review_count: 1,
  declared_share: 0.1,
  observed_share: 0.104,
  declared_matches_observed: true,
  readings: [
    {
      review_state: "reviewed",
      evidence: {
        source_url: "https://github.com/a/b",
        read_at_sha: "abc1234",
        evidence_path: "neurons/validator.py",
        observed_at: "2026-08-12T00:00:00.000Z",
        first_seen: "2026-08-01T00:00:00.000Z",
      },
      found: true,
      declared_share: 0.1,
      treasury_address: "5T",
      applies_to: "miner-emission",
    },
    {
      review_state: "candidate",
      evidence: {
        source_url: "https://github.com/c/d",
        read_at_sha: "def5678",
        evidence_path: null,
        observed_at: "2026-08-12T00:00:00.000Z",
        first_seen: null,
      },
      found: null,
      declared_share: null,
      treasury_address: null,
      applies_to: null,
    },
  ],
  field_sources: {},
};

describe("GET /api/v1/subnets/{netuid}/treasury", () => {
  test("a cold store answers 200 with repos_read 0, never 404", async () => {
    const res = await handleRequest(req(PATH), mockEnv());
    assert.equal(res.status, 200);
    const data = (await jsonBody(res)).data as Row;
    assert.equal(data.netuid, NETUID);
    assert.equal(data.repos_read, 0);
    assert.deepEqual(data.readings, []);
    // An unread subnet must not report a mismatch.
    assert.equal(data.declared_matches_observed, null);
  });

  test("rejects an unsupported query parameter", async () => {
    // The route is in NO_QUERY_PARAMETERS; without that it would silently
    // accept anything.
    const res = await handleRequest(req(`${PATH}?window=7d`), mockEnv());
    assert.equal(res.status, 400);
    assert.equal(((await jsonBody(res)).error as Row)?.code, "invalid_query");
  });

  test("the handler is reachable directly with the same answer", async () => {
    const res = await handleSubnetTreasury(req(PATH), mockEnv(), NETUID);
    assert.equal(res.status, 200);
    assert.equal((await jsonBody(res)).data.netuid, NETUID);
  });

  test("a forwarded card reaches REST with the candidate still withheld", async () => {
    const res = await handleRequest(req(PATH), tierEnv(WITH_CANDIDATE));
    const data = (await jsonBody(res)).data as Row;
    assert.equal(data.repos_read, 2);
    const candidate = (data.readings as Row[])[1];
    assert.equal(candidate.review_state, "candidate");
    assert.equal(candidate.found, null);
    assert.equal(candidate.declared_share, null);
  });
});

describe("the MCP tool", () => {
  test("is registered and answers on a cold store", async () => {
    const out = (await tool("get_subnet_treasury").handler({ netuid: NETUID }, {
      env: mockEnv(),
    } as never)) as Row;
    assert.equal(out.netuid, NETUID);
    assert.equal(out.repos_read, 0);
    assert.equal(out.declared_matches_observed, null);
  });

  test("rejects a netuid outside the u16 range", async () => {
    await assert.rejects(
      () =>
        tool("get_subnet_treasury").handler({ netuid: 70000 }, {
          env: mockEnv(),
        } as never),
      /u16 range/,
    );
  });

  test("THE DESCRIPTION FORBIDS THE INFERENCE THE DATA INVITES", () => {
    // This tool's failure mode is an agent reporting "no treasury cut" for a
    // subnet nobody read, or reading a null comparison as a mismatch. The
    // description is the only instruction it gets.
    const d = tool("get_subnet_treasury").description;
    assert.match(d, /NOBODY HAS READ/);
    assert.match(d, /do NOT report that as 'no treasury cut'/);
    assert.match(d, /TRI-STATE/);
    assert.match(d, /not a discovery/i);
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
      `query { subnet_treasury(netuid: ${NETUID}) {
         netuid repos_read reviewed_count pending_review_count
         declared_share observed_share declared_matches_observed
       } }`,
    );
    assert.equal(status, 200);
    assert.equal(body.errors, undefined);
    const card = body.data.subnet_treasury as Row;
    assert.equal(card.repos_read, 0);
    assert.equal(card.declared_matches_observed, null);
  });

  test("AN UNREVIEWED FINDING DOES NOT LEAK THROUGH THE RESOLVER", async () => {
    // The claim a builder test cannot make. A resolver naming declared_share
    // off the raw row would publish exactly what the gate exists to hold.
    const { body } = await gql(
      `query { subnet_treasury(netuid: ${NETUID}) {
         readings { review_state found declared_share treasury_address
                    evidence { source_url read_at_sha observed_at } }
       } }`,
      tierEnv(WITH_CANDIDATE),
    );
    assert.equal(body.errors, undefined);
    const readings = (body.data.subnet_treasury as Row).readings as Row[];
    const candidate = readings.find(
      (r) => r.review_state === "candidate",
    ) as Row;
    assert.equal(candidate.found, null);
    assert.equal(candidate.declared_share, null);
    assert.equal(candidate.treasury_address, null);
    // ...while its read status survives, which is the half that must.
    assert.equal((candidate.evidence as Row).read_at_sha, "def5678");
  });

  test("survives an upstream body missing every field", async () => {
    const { body } = await gql(
      `query { subnet_treasury(netuid: ${NETUID}) {
         schema_version netuid repos_read reviewed_count pending_review_count
         declared_share observed_share declared_matches_observed
         readings { review_state }
       } }`,
      tierEnv({}),
    );
    assert.equal(body.errors, undefined, "an empty body must not error");
    const card = body.data.subnet_treasury as Row;
    assert.equal(card.repos_read, 0);
    assert.equal(card.declared_matches_observed, null);
    assert.deepEqual(card.readings, []);
  });
});
