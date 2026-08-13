// #10931: the three surfaces over the miner-fairness card.
//
// tests/miner-fairness.test.ts covers the framing and the arithmetic. What is
// only reachable from here is the WIRING — and one claim in particular that a
// builder test cannot make: that `days_covered` survives every surface. A
// distribution published without it is a distribution over an unknown number
// of days, which is the misreading the whole card is shaped to prevent.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { handleRequest } from "../workers/api.ts";
import { MCP_TOOLS } from "../src/mcp-server.ts";
import { handleGraphQLRequest } from "../src/graphql.ts";
import {
  canonicalSubnetMinerFairnessCachePath,
  handleSubnetMinerFairness,
} from "../workers/request-handlers/entities.ts";
import { jsonBody, mockEnv, type Row } from "./row-type.ts";

const NETUID = 7;
const PATH = `/api/v1/subnets/${NETUID}/miner-fairness`;

const req = (path: string) => new Request(`https://api.metagraph.sh${path}`);
const asUrl = (path: string) => new URL(`https://api.metagraph.sh${path}`);

function tool(name: string) {
  const found = MCP_TOOLS.find((t) => t.name === name);
  assert.ok(found, `${name} must be registered`);
  return found as {
    handler: (a: Row, c: unknown) => Promise<unknown>;
    description: string;
  };
}

const mcpCtx = () => ({ env: mockEnv() }) as never;

describe("GET /api/v1/subnets/{netuid}/miner-fairness", () => {
  test("a cold store answers 200 with an empty series, never 404", async () => {
    const res = await handleRequest(req(PATH), mockEnv());
    assert.equal(res.status, 200);
    const data = (await jsonBody(res)).data as Row;
    assert.equal(data.netuid, NETUID);
    assert.equal(data.days_covered, 0);
    assert.deepEqual(data.points, []);
    assert.equal(data.window, "30d");
  });

  test("an unsupported window is a 400 naming the parameter", async () => {
    const res = await handleRequest(req(`${PATH}?window=1d`), mockEnv());
    assert.equal(res.status, 400);
    const body = await jsonBody(res);
    assert.equal((body.error as Row)?.code, "invalid_query");
    assert.equal((body.meta as Row)?.parameter, "window");
  });

  test("each published window resolves and is echoed", async () => {
    for (const window of ["7d", "30d", "90d"]) {
      const res = await handleRequest(
        req(`${PATH}?window=${window}`),
        mockEnv(),
      );
      assert.equal(res.status, 200, `on ${window}`);
      assert.equal((await jsonBody(res)).data.window, window);
    }
  });

  test("provenance rides with the payload", async () => {
    const res = await handleRequest(req(PATH), mockEnv());
    const sources = ((await jsonBody(res)).data as Row).field_sources as Row;
    assert.ok(sources);
    assert.equal((sources["points.zero_emission_pct"] as Row).kind, "measured");
  });

  test("the handler is reachable directly with the same answer", async () => {
    const res = await handleSubnetMinerFairness(
      req(PATH),
      mockEnv(),
      NETUID,
      asUrl(PATH),
    );
    assert.equal(res.status, 200);
    assert.equal((await jsonBody(res)).data.netuid, NETUID);
  });

  test("the cache key is the window alone", () => {
    assert.equal(
      canonicalSubnetMinerFairnessCachePath(asUrl(`${PATH}?window=7d`)),
      `${PATH}?window=7d`,
    );
    // The bare path canonicalises to the default rather than to an empty
    // string, so `?window=30d` and no window share one entry.
    assert.equal(
      canonicalSubnetMinerFairnessCachePath(asUrl(PATH)),
      `${PATH}?window=30d`,
    );
    // A rejected query passes through verbatim, so a 400 cannot be cached
    // under a valid key.
    assert.equal(
      canonicalSubnetMinerFairnessCachePath(asUrl(`${PATH}?window=1d`)),
      `${PATH}?window=1d`,
    );
  });
});

describe("the MCP tool", () => {
  test("is registered and answers on a cold store", async () => {
    const out = (await tool("get_subnet_miner_fairness").handler(
      { netuid: NETUID },
      mcpCtx(),
    )) as Row;
    assert.equal(out.netuid, NETUID);
    assert.equal(out.days_covered, 0);
  });

  test("rejects an out-of-enum window rather than defaulting", async () => {
    // Dispatch does not validate against the published input schema, so an
    // enum there is documentation until the handler enforces it.
    await assert.rejects(
      () =>
        tool("get_subnet_miner_fairness").handler(
          { netuid: NETUID, window: "1d" },
          mcpCtx(),
        ),
      /7d, 30d, 90d/,
    );
  });

  test("rejects a netuid outside the u16 range", async () => {
    await assert.rejects(
      () =>
        tool("get_subnet_miner_fairness").handler({ netuid: 70000 }, mcpCtx()),
      /u16 range/,
    );
  });

  test("THE DESCRIPTION FORBIDS THE JUDGEMENT THE DATA INVITES", () => {
    // An agent handed a Gini and a 99% zero rate will reach for "unfair"
    // unless told not to. The tool description is the only instruction it
    // reads, so the prohibition is asserted rather than assumed.
    const description = tool("get_subnet_miner_fairness").description;
    assert.match(description, /DESCRIPTIVE ONLY/);
    assert.match(description, /not misconduct/i);
    assert.match(description, /days_covered/);
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

  test("serves the card with days_covered intact", async () => {
    const { status, body } = await gql(
      `query { subnet_miner_fairness(netuid: ${NETUID}) {
         netuid window days_covered point_count miner_uid_count entity_count
       } }`,
    );
    assert.equal(status, 200);
    assert.equal(body.errors, undefined);
    const card = body.data.subnet_miner_fairness as Row;
    assert.equal(card.netuid, NETUID);
    assert.equal(card.days_covered, 0);
  });

  test("an unsupported window is rejected, not silently defaulted", async () => {
    const { body } = await gql(
      `query { subnet_miner_fairness(netuid: ${NETUID}, window: "1d") { window } }`,
    );
    assert.ok(body.errors, "1d was accepted");
    assert.equal((body.errors as Row[])[0].extensions?.code, "BAD_USER_INPUT");
  });

  test("each published window reaches the resolver", async () => {
    for (const window of ["7d", "30d", "90d"]) {
      const { body } = await gql(
        `query { subnet_miner_fairness(netuid: ${NETUID}, window: "${window}") { window } }`,
      );
      assert.equal(body.errors, undefined, `errored on ${window}`);
      assert.equal((body.data.subnet_miner_fairness as Row).window, window);
    }
  });
});

describe("the DATA_API tier, when it is bound", () => {
  function tierEnv(body: unknown) {
    return {
      ...(mockEnv() as unknown as Record<string, unknown>),
      METAGRAPH_NEURONS_SOURCE: "data-api",
      DATA_API: { fetch: async () => Response.json(body) },
    } as never;
  }

  const FORWARDED = {
    schema_version: 1,
    netuid: NETUID,
    window: "30d",
    days_covered: 31,
    point_count: 1,
    points: [
      {
        snapshot_date: "2026-08-12",
        miner_count: 240,
        earning_miner_count: 14,
        zero_emission_pct: 0.941666667,
      },
    ],
    miner_uid_count: 240,
    persistence: {
      never_earned_count: 200,
      earned_every_day_count: 2,
      median_earning_days: 0,
      max_earning_days: 31,
    },
    entity_count: 78,
    uids_per_entity: 3.08,
    concentration: {
      entity: { holders: 78, gini: 0.63, nakamoto_coefficient: 4 },
      uid: { holders: 14, gini: 0.41, nakamoto_coefficient: 5 },
    },
    field_sources: {},
  };

  test("a forwarded card reaches the REST payload intact", async () => {
    const res = await handleRequest(req(PATH), tierEnv(FORWARDED));
    const data = (await jsonBody(res)).data as Row;
    assert.equal(data.days_covered, 31);
    assert.equal((data.points as Row[])[0].earning_miner_count, 14);
    assert.equal((data.concentration as Row).entity !== null, true);
  });

  test("a forwarded card reaches GraphQL with every block intact", async () => {
    const { body } = await gqlWith(
      `query { subnet_miner_fairness(netuid: ${NETUID}) {
         days_covered miner_uid_count entity_count uids_per_entity
         points { snapshot_date miner_count earning_miner_count zero_emission_pct }
         persistence { never_earned_count earned_every_day_count median_earning_days max_earning_days }
         concentration { entity { gini nakamoto_coefficient holders } uid { gini holders } }
       } }`,
      tierEnv(FORWARDED),
    );
    assert.equal(body.errors, undefined);
    const card = body.data.subnet_miner_fairness as Row;
    assert.equal(card.days_covered, 31);
    assert.equal(card.uids_per_entity, 3.08);
    assert.equal((card.persistence as Row).never_earned_count, 200);
    // The two lenses both survive. A resolver naming only one would still
    // pass every other test here.
    assert.equal(((card.concentration as Row).entity as Row).gini, 0.63);
    assert.equal(((card.concentration as Row).uid as Row).gini, 0.41);
  });

  test("GRAPHQL SURVIVES AN UPSTREAM BODY MISSING EVERY FIELD", async () => {
    // A cold data Worker answers `{}`. Each `??` arm in the resolver exists
    // for this, and an untested one is how a null reaches a non-null GraphQL
    // field and errors the whole query.
    const { body } = await gqlWith(
      `query { subnet_miner_fairness(netuid: ${NETUID}) {
         schema_version netuid window days_covered point_count
         miner_uid_count entity_count uids_per_entity
         points { snapshot_date } persistence { never_earned_count }
         concentration { entity { gini } }
       } }`,
      tierEnv({}),
    );
    assert.equal(body.errors, undefined, "an empty body must not error");
    const card = body.data.subnet_miner_fairness as Row;
    assert.equal(card.days_covered, 0);
    assert.equal(card.miner_uid_count, 0);
    assert.equal(card.entity_count, 0);
    assert.equal(card.uids_per_entity, null);
    assert.equal(card.persistence, null);
    assert.equal(card.concentration, null);
    assert.deepEqual(card.points, []);
  });

  test("the MCP tool forwards the tier's card unchanged", async () => {
    const out = (await tool("get_subnet_miner_fairness").handler(
      { netuid: NETUID, window: "7d" },
      { env: tierEnv(FORWARDED) } as never,
    )) as Row;
    assert.equal(out.days_covered, 31);
  });

  async function gqlWith(query: string, env: unknown) {
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
  }
});
