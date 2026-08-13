// #10928: the three surfaces over the recipient split, driven through their own
// entry points.
//
// tests/emission-split.test.ts covers the arithmetic. What is only reachable
// from here is the WIRING — and every branch of it exists because the normal
// case is a cold store: `neuron_daily` is ~27-33 days deep, the DATA_API tier
// is unbound in a hermetic test, and a subnet registered today has no rollup at
// all. A test that only walked the happy path would prove nothing.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { handleRequest } from "../workers/api.ts";
import { MCP_TOOLS } from "../src/mcp-server.ts";
import { handleGraphQLRequest } from "../src/graphql.ts";
import {
  canonicalSubnetEmissionSplitHistoryCachePath,
  handleSubnetEmissionSplitHistory,
} from "../workers/request-handlers/entities.ts";
import { jsonBody, mockEnv, type Row } from "./row-type.ts";

const NETUID = 7;
const PATH = `/api/v1/subnets/${NETUID}/emission-split/history`;

const req = (path: string) => new Request(`https://api.metagraph.sh${path}`);
const asUrl = (path: string) => new URL(`https://api.metagraph.sh${path}`);

function tool(name: string) {
  const found = MCP_TOOLS.find((t) => t.name === name);
  assert.ok(found, `${name} must be registered`);
  return found as { handler: (a: Row, c: unknown) => Promise<unknown> };
}

const mcpCtx = () => ({ env: mockEnv() }) as never;

describe("GET /api/v1/subnets/{netuid}/emission-split/history", () => {
  test("a cold store answers 200 with an empty series, never 404", async () => {
    const res = await handleRequest(req(PATH), mockEnv());
    assert.equal(res.status, 200);
    const data = (await jsonBody(res)).data as Row;
    assert.equal(data.netuid, NETUID);
    assert.equal(data.point_count, 0);
    assert.deepEqual(data.points, []);
    assert.equal(
      data.window,
      "30d",
      "the default window is resolved, not null",
    );
  });

  test("provenance rides with the payload on the REST surface", async () => {
    const res = await handleRequest(req(PATH), mockEnv());
    const data = (await jsonBody(res)).data as Row;
    const sources = data.field_sources as Row;
    assert.ok(sources, "field_sources must be published");
    assert.equal(
      (sources["points.validator_alpha"] as Row).kind,
      "measured",
      "the measured half must say so",
    );
    assert.equal(
      (sources["points.owner_alpha"] as Row).kind,
      "reconstructed",
      "the owner leg is never presented as a reading",
    );
  });

  test("every published window resolves", async () => {
    for (const window of ["7d", "30d", "90d"]) {
      const res = await handleRequest(
        req(`${PATH}?window=${window}`),
        mockEnv(),
      );
      assert.equal(res.status, 200, window);
      assert.equal(((await jsonBody(res)).data as Row).window, window);
    }
  });

  test("an unsupported window is a typed 400, not a silent default", async () => {
    const res = await handleRequest(req(`${PATH}?window=1y`), mockEnv());
    assert.equal(res.status, 400);
    const body = await jsonBody(res);
    assert.equal(body.ok, false);
    assert.equal((body.error as Row).code, "invalid_query");
    assert.equal((body.meta as Row).parameter, "window");
  });

  test("an unknown query parameter is refused rather than ignored", async () => {
    // The route is in ROUTE_QUERY_SCHEMAS, so the router validates rather than
    // accepting anything — the trap NO_QUERY_PARAMETERS exists to avoid.
    const res = await handleRequest(
      req(`${PATH}?__definitely_not_a_param=1`),
      mockEnv(),
    );
    assert.equal(res.status, 400);
  });

  test("the netuid guard answers before any store is read", async () => {
    const res = await handleSubnetEmissionSplitHistory(
      req(PATH),
      mockEnv(),
      NETUID,
      asUrl(`${PATH}?format=pdf`),
    );
    assert.equal(res.status, 400, "an unsupported format is refused");
  });
});

describe("network addressing", () => {
  test("the route is mainnet-only, in the router as well as the contract", async () => {
    // `neuron_daily` carries no network dimension, so serving this under a
    // /testnet/ prefix would publish mainnet data as testnet data. The
    // contract list and the router predicate are asserted equal in both
    // directions by tests/network-addressing.test.ts; this pins the router
    // side for THIS path specifically.
    const { isMainnetOnlyApiPath } = await import("../workers/api.ts");
    assert.equal(isMainnetOnlyApiPath(PATH), true);
    assert.equal(
      isMainnetOnlyApiPath("/api/v1/subnets/7/definitely-not-a-route"),
      false,
    );
  });

  test("the testnet prefix does not serve it", async () => {
    const res = await handleRequest(
      req(`/api/v1/testnet/subnets/${NETUID}/emission-split/history`),
      mockEnv(),
    );
    assert.notEqual(res.status, 200);
  });
});

describe("the CSV export", () => {
  test("serves the declared columns, oldest-first", async () => {
    const res = await handleSubnetEmissionSplitHistory(
      req(`${PATH}?format=csv`),
      mockEnv(),
      NETUID,
      asUrl(`${PATH}?format=csv`),
    );
    assert.equal(res.status, 200);
    assert.match(String(res.headers.get("content-type")), /text\/csv/);
    const header = (await res.text()).split("\n")[0].trim();
    // The measured legs, the counts they are compared against, then the
    // reconstructed absolutes — the order the column list declares.
    assert.equal(
      header,
      "snapshot_date,neuron_count,validator_count,miner_count," +
        "earning_validator_count,earning_miner_count,validator_alpha," +
        "miner_alpha,uid_alpha,validator_share_of_uid,miner_share_of_uid," +
        "owner_cut,total_alpha,owner_alpha,owner_share,validator_share," +
        "miner_share,alpha_price_tao,total_tao",
    );
  });
  test("the CSV rows are sorted oldest-first", async () => {
    // The route serves newest-first; a spreadsheet wants the opposite. With
    // fewer than two rows the comparator never runs, so this needs two.
    const res = await handleSubnetEmissionSplitHistory(
      req(`${PATH}?format=csv`),
      {
        ...(mockEnv() as unknown as Record<string, unknown>),
        METAGRAPH_NEURONS_SOURCE: "data-api",
        DATA_API: {
          fetch: async () =>
            Response.json({
              schema_version: 1,
              netuid: NETUID,
              window: "30d",
              point_count: 2,
              points: [
                { snapshot_date: "2026-08-12", miner_count: 2 },
                { snapshot_date: "2026-08-11", miner_count: 1 },
              ],
              field_sources: {},
            }),
        },
      } as never,
      NETUID,
      asUrl(`${PATH}?format=csv`),
    );
    assert.equal(res.status, 200);
    const rows = (await res.text()).trim().split("\n");
    assert.match(rows[1], /^2026-08-11/, "oldest row first");
    assert.match(rows[2], /^2026-08-12/);
  });
});

describe("the edge-cache key", () => {
  test("an omitted window and the explicit default collapse to one key", () => {
    // Otherwise the two spellings of the same request are two cache entries.
    assert.equal(
      canonicalSubnetEmissionSplitHistoryCachePath(asUrl(PATH)),
      canonicalSubnetEmissionSplitHistoryCachePath(asUrl(`${PATH}?window=30d`)),
    );
  });

  test("different windows do not collapse", () => {
    assert.notEqual(
      canonicalSubnetEmissionSplitHistoryCachePath(asUrl(`${PATH}?window=7d`)),
      canonicalSubnetEmissionSplitHistoryCachePath(asUrl(`${PATH}?window=90d`)),
    );
  });

  test("an invalid query is not canonicalised into a valid key", () => {
    // Canonicalising a rejected request would cache a 400 under the key a
    // valid request would later read.
    const path = canonicalSubnetEmissionSplitHistoryCachePath(
      asUrl(`${PATH}?window=1y`),
    );
    assert.match(path, /window=1y/);
  });

  test("an unsupported format is not canonicalised either", () => {
    // The format guard is a separate early return from the query guard, and
    // canonicalising a request that will 400 would poison the key a valid one
    // later reads.
    const path = canonicalSubnetEmissionSplitHistoryCachePath(
      asUrl(`${PATH}?format=pdf`),
    );
    assert.match(path, /format=pdf/);
  });

  test("a CSV request keys separately from JSON", () => {
    assert.notEqual(
      canonicalSubnetEmissionSplitHistoryCachePath(asUrl(PATH)),
      canonicalSubnetEmissionSplitHistoryCachePath(asUrl(`${PATH}?format=csv`)),
    );
  });
});

describe("the get_subnet_emission_split_history MCP tool", () => {
  test("a cold store is an empty series, not a tool error", async () => {
    const out = (await tool("get_subnet_emission_split_history").handler(
      { netuid: NETUID },
      mcpCtx(),
    )) as Row;
    assert.equal(out.netuid, NETUID);
    assert.equal(out.point_count, 0);
    assert.equal(out.window, "30d");
  });

  test("MCP publishes the same provenance map as REST", async () => {
    // Emitted by the builder, so the two surfaces cannot disagree about which
    // half is reconstructed.
    const out = (await tool("get_subnet_emission_split_history").handler(
      { netuid: NETUID },
      mcpCtx(),
    )) as Row;
    const res = await handleRequest(req(PATH), mockEnv());
    const rest = (await jsonBody(res)).data as Row;
    assert.deepEqual(out.field_sources, rest.field_sources);
  });

  test("an explicit window is honoured", async () => {
    const out = (await tool("get_subnet_emission_split_history").handler(
      { netuid: NETUID, window: "7d" },
      mcpCtx(),
    )) as Row;
    assert.equal(out.window, "7d");
  });

  test("an unsupported window is invalid_params, not a silent default", async () => {
    await assert.rejects(
      () =>
        tool("get_subnet_emission_split_history").handler(
          { netuid: NETUID, window: "1y" },
          mcpCtx(),
        ),
      /window must be one of/,
    );
  });

  test("a negative netuid is refused", async () => {
    await assert.rejects(
      () =>
        tool("get_subnet_emission_split_history").handler(
          { netuid: -1 },
          mcpCtx(),
        ),
      /netuid/,
    );
  });

  test("a netuid above the u16 ceiling is refused, not answered empty", async () => {
    // Fixed in this PR: `requireNetuid` now bounds the u16 range, so a netuid
    // the chain cannot have is `invalid_params` rather than an empty card that
    // reads as "this subnet has no data".
    await assert.rejects(
      () =>
        tool("get_subnet_emission_split_history").handler(
          { netuid: 70000 },
          mcpCtx(),
        ),
      /u16 range/,
    );
  });
});

describe("the DATA_API tier, when it is bound", () => {
  /** An env whose neurons tier forwards to a stubbed data Worker. */
  function tierEnv(body: unknown) {
    return {
      ...(mockEnv() as unknown as Record<string, unknown>),
      METAGRAPH_NEURONS_SOURCE: "data-api",
      DATA_API: { fetch: async () => Response.json(body) },
    } as never;
  }

  test("a forwarded series reaches the REST payload", async () => {
    const res = await handleRequest(
      req(PATH),
      tierEnv({
        schema_version: 1,
        netuid: NETUID,
        window: "30d",
        point_count: 1,
        points: [{ snapshot_date: "2026-08-12", validator_share_of_uid: 0.88 }],
        field_sources: {},
      }),
    );
    assert.equal(res.status, 200);
    const data = (await jsonBody(res)).data as Row;
    assert.equal(data.point_count, 1);
    assert.equal((data.points as Row[])[0].validator_share_of_uid, 0.88);
  });

  test("GraphQL survives an upstream body missing every field", async () => {
    // The non-null SDL fields (`point_count: Int!`, `points: [...]!`) must not
    // come back undefined if the data Worker answers with something partial --
    // that is a GraphQL execution error, not a degraded card. This is the only
    // thing exercising the resolver's fallbacks.
    const res = await handleGraphQLRequest(
      new Request("https://api.metagraph.sh/graphql", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          query: `query { subnet_emission_split_history(netuid: ${NETUID}) { schema_version netuid window point_count points { snapshot_date } } }`,
        }),
      }),
      tierEnv({}),
    );
    const body = (await res.json()) as Row;
    assert.equal(body.errors, undefined, JSON.stringify(body.errors));
    const card = (body.data as Row).subnet_emission_split_history as Row;
    assert.equal(card.schema_version, 1);
    assert.equal(card.netuid, NETUID);
    assert.equal(card.window, "30d");
    assert.equal(card.point_count, 0);
    assert.deepEqual(card.points, []);
  });
});

describe("subnet_emission_split_history over GraphQL", () => {
  async function gql(query: string) {
    const res = await handleGraphQLRequest(
      new Request("https://api.metagraph.sh/graphql", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query }),
      }),
      mockEnv(),
    );
    return { status: res.status, body: (await res.json()) as Row };
  }

  test("resolves a schema-stable empty series, never null", async () => {
    const { status, body } = await gql(
      `query { subnet_emission_split_history(netuid: ${NETUID}) { netuid window point_count points { snapshot_date } } }`,
    );
    assert.equal(status, 200);
    assert.equal(body.errors, undefined, JSON.stringify(body.errors));
    const card = (body.data as Row).subnet_emission_split_history as Row;
    assert.equal(card.netuid, NETUID);
    assert.equal(card.point_count, 0);
    assert.deepEqual(card.points, []);
    assert.equal(card.window, "30d");
  });

  test("an unsupported window is a BAD_USER_INPUT error from dispatch", async () => {
    // NOT hand-written in the resolver: the window is published in
    // ROUTE_QUERY_SCHEMAS, so parseArgumentsAtDispatch rejects it before the
    // resolver runs. This proves that path is actually wired.
    const { body } = await gql(
      `query { subnet_emission_split_history(netuid: ${NETUID}, window: "1y") { point_count } }`,
    );
    const errors = body.errors as Row[] | undefined;
    assert.ok(errors?.length, "an unsupported window must error");
    assert.equal(((errors[0].extensions as Row) ?? {}).code, "BAD_USER_INPUT");
  });

  test("a negative netuid is a BAD_USER_INPUT error from the resolver", async () => {
    // netuid is a PATH parameter, so dispatch does not parse it — this is the
    // one hand-written check, and the ceiling raise documents why.
    const { body } = await gql(
      `query { subnet_emission_split_history(netuid: -1) { point_count } }`,
    );
    const errors = body.errors as Row[] | undefined;
    assert.ok(errors?.length);
    assert.equal(((errors[0].extensions as Row) ?? {}).code, "BAD_USER_INPUT");
  });

  test("an explicit window reaches the card", async () => {
    const { body } = await gql(
      `query { subnet_emission_split_history(netuid: ${NETUID}, window: "90d") { window } }`,
    );
    assert.equal(
      ((body.data as Row).subnet_emission_split_history as Row).window,
      "90d",
    );
  });
});
