// #10929: the three surfaces over the owner-capture card, driven through their
// own entry points.
//
// tests/owner-capture.test.ts covers the arithmetic and the epistemics.
// What is only reachable from here is the WIRING — and one claim in particular
// that a builder test cannot make: that `blind_spots` survives every surface.
// The builder emitting them proves nothing if a resolver's field list drops
// them on the way out, and a capture figure published without the layers it
// excludes is the failure this whole surface is shaped to avoid.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { handleRequest } from "../workers/api.ts";
import { MCP_TOOLS } from "../src/mcp-server.ts";
import { handleGraphQLRequest } from "../src/graphql.ts";
import {
  canonicalSubnetOwnerCaptureCachePath,
  handleSubnetOwnerCapture,
} from "../workers/request-handlers/entities.ts";
import { jsonBody, mockEnv, type Row } from "./row-type.ts";

const NETUID = 7;
const PATH = `/api/v1/subnets/${NETUID}/owner-capture`;

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

describe("GET /api/v1/subnets/{netuid}/owner-capture", () => {
  test("a cold store answers 200 with an empty series, never 404", async () => {
    const res = await handleRequest(req(PATH), mockEnv());
    assert.equal(res.status, 200);
    const data = (await jsonBody(res)).data as Row;
    assert.equal(data.netuid, NETUID);
    assert.equal(data.point_count, 0);
    assert.deepEqual(data.points, []);
    assert.equal(data.window, "30d", "the default window is resolved");
    assert.equal(data.owner_coldkey, null, "unknown owner is null, not empty");
  });

  test("THE BLIND SPOTS SURVIVE THE COLD PATH", () => {
    // The empty card is the one most likely to be quoted uncritically, and it
    // is exactly the one a `?? []` in a resolver would strip.
    return handleRequest(req(PATH), mockEnv())
      .then((res) => jsonBody(res))
      .then((body) => {
        const spots = (body.data as Row).blind_spots as Row[];
        assert.equal(Array.isArray(spots), true);
        assert.deepEqual(
          spots.map((s) => s.layer),
          ["L3", "L4", "L5"],
        );
      });
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

  test("provenance rides with the payload on the REST surface", async () => {
    const res = await handleRequest(req(PATH), mockEnv());
    const sources = ((await jsonBody(res)).data as Row).field_sources as Row;
    assert.ok(sources, "field_sources must be published");
    assert.equal(
      (sources["points.owner_attributed_share_of_uid"] as Row).kind,
      "measured",
      "the parameter-free ratio is a reading",
    );
    assert.equal(
      (sources["points.owner_attributed_share"] as Row).kind,
      "reconstructed",
      "the whole-day share carries the owner cut and must say so",
    );
  });

  test("the handler is reachable directly with the same answer", async () => {
    // The router and the handler are two entry points and both are exported;
    // a test that only drove one would miss a dispatch that never fires.
    const res = await handleSubnetOwnerCapture(
      req(PATH),
      mockEnv(),
      NETUID,
      asUrl(PATH),
    );
    assert.equal(res.status, 200);
    assert.equal((await jsonBody(res)).data.netuid, NETUID);
  });

  test("the cache key is the window alone, so two callers share an entry", () => {
    assert.equal(
      canonicalSubnetOwnerCaptureCachePath(asUrl(`${PATH}?window=7d`)),
      `${PATH}?window=7d`,
    );
    // An omitted window canonicalises to the default rather than to an empty
    // string — otherwise `?window=30d` and the bare path are two entries for
    // one answer.
    assert.equal(
      canonicalSubnetOwnerCaptureCachePath(asUrl(PATH)),
      `${PATH}?window=30d`,
    );
    // A rejected query is passed through verbatim rather than canonicalised
    // onto a valid key, so a 400 cannot be cached as if it were an answer.
    assert.equal(
      canonicalSubnetOwnerCaptureCachePath(asUrl(`${PATH}?window=1d`)),
      `${PATH}?window=1d`,
    );
  });
});

describe("the MCP tool", () => {
  test("is registered and answers on a cold store", async () => {
    const out = (await tool("get_subnet_owner_capture").handler(
      { netuid: NETUID },
      mcpCtx(),
    )) as Row;
    assert.equal(out.netuid, NETUID);
    assert.equal(out.point_count, 0);
    assert.equal((out.blind_spots as Row[]).length, 3);
  });

  test("rejects an out-of-enum window rather than defaulting", async () => {
    // Dispatch does not validate against the published input schema, so an
    // enum there is documentation until the handler enforces it. Without this,
    // `window: "1d"` would silently return the 30-day answer.
    await assert.rejects(
      () =>
        tool("get_subnet_owner_capture").handler(
          { netuid: NETUID, window: "1d" },
          mcpCtx(),
        ),
      /7d, 30d, 90d/,
    );
  });

  test("rejects a netuid outside the u16 range before reading anything", async () => {
    await assert.rejects(
      () =>
        tool("get_subnet_owner_capture").handler({ netuid: 70000 }, mcpCtx()),
      /u16 range/,
    );
  });

  test("THE DESCRIPTION TELLS AN AGENT WHAT NOT TO CONCLUDE", () => {
    // The tool description is the only instruction an agent reads before
    // quoting this data, and this surface's failure mode is a confident
    // sentence about a team. Asserted, not assumed.
    const description = tool("get_subnet_owner_capture").description;
    assert.match(description, /unresolved/);
    assert.match(description, /NOT `WHAT THE OWNER TAKES`/);
    assert.match(
      description,
      /exchange|delegation service/,
      "the innocent explanations have to be named, not gestured at",
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

  const FORWARDED = {
    schema_version: 1,
    netuid: NETUID,
    window: "30d",
    owner_coldkey: "5OwnerCold",
    point_count: 1,
    points: [{ snapshot_date: "2026-08-12", owner_attributed_share: 0.315 }],
    owner_uid_count: 1,
    owner_uids: [{ uid: 4, take: null, nominator_share: 0.9977 }],
    attribution: [
      {
        coldkey: "5Whale",
        stake_share: 0.9977,
        verdict: "unresolved",
        evidence: [],
      },
    ],
    attribution_vocabulary: [
      "unresolved",
      "third-party",
      "affiliated",
      "owner",
    ],
    blind_spots: [
      { layer: "L3", summary: "x" },
      { layer: "L4", summary: "y" },
      { layer: "L5", summary: "z" },
    ],
    field_sources: {},
  };

  test("a forwarded card reaches the REST payload intact", async () => {
    const res = await handleRequest(req(PATH), tierEnv(FORWARDED));
    assert.equal(res.status, 200);
    const data = (await jsonBody(res)).data as Row;
    assert.equal(data.owner_coldkey, "5OwnerCold");
    assert.equal((data.points as Row[])[0].owner_attributed_share, 0.315);
    assert.equal((data.owner_uids as Row[])[0].nominator_share, 0.9977);
  });

  test("a forwarded card reaches GraphQL with every list intact", async () => {
    // The resolver names each field explicitly, so a list it forgot would be
    // dropped silently. Every one of them is asserted here.
    const res = await handleGraphQLRequest(
      new Request("https://api.metagraph.sh/api/v1/graphql", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          query: `query { subnet_owner_capture(netuid: ${NETUID}) {
            netuid window owner_coldkey point_count owner_uid_count
            points { snapshot_date owner_attributed_share }
            owner_uids { uid take nominator_share }
            attribution { coldkey stake_share verdict evidence }
            attribution_vocabulary
            blind_spots { layer summary }
          } }`,
        }),
      }),
      tierEnv(FORWARDED),
      undefined,
    );
    const body = (await res.json()) as Row;
    assert.equal(body.errors, undefined);
    const card = body.data.subnet_owner_capture as Row;
    assert.equal(card.owner_coldkey, "5OwnerCold");
    assert.equal(card.owner_uid_count, 1);
    assert.equal((card.points as Row[])[0].owner_attributed_share, 0.315);
    // `take: null` survives the whole trip as null. This is the field most
    // likely to be coalesced to 0 by a defensive resolver.
    assert.equal((card.owner_uids as Row[])[0].take, null);
    assert.equal((card.attribution as Row[])[0].verdict, "unresolved");
    assert.deepEqual(card.attribution_vocabulary, [
      "unresolved",
      "third-party",
      "affiliated",
      "owner",
    ]);
    assert.equal((card.blind_spots as Row[]).length, 3);
  });

  test("GRAPHQL SURVIVES AN UPSTREAM BODY MISSING EVERY FIELD", () => {
    // The tier answering `{}` is not hypothetical -- a cold data Worker does
    // exactly that. Each `??` arm in the resolver exists for this, and an
    // untested one is how a null reaches a non-null GraphQL field and turns
    // the whole query into an error.
    return handleGraphQLRequest(
      new Request("https://api.metagraph.sh/api/v1/graphql", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          query: `query { subnet_owner_capture(netuid: ${NETUID}) {
            schema_version netuid window owner_coldkey point_count
            owner_uid_count points { snapshot_date }
            owner_uids { uid } attribution { coldkey }
            attribution_vocabulary blind_spots { layer }
          } }`,
        }),
      }),
      tierEnv({}),
      undefined,
    )
      .then((res) => res.json() as Promise<Row>)
      .then((body) => {
        assert.equal(body.errors, undefined, "an empty body must not error");
        const card = body.data.subnet_owner_capture as Row;
        assert.equal(card.schema_version, 1);
        assert.equal(card.netuid, NETUID);
        assert.equal(card.window, "30d");
        assert.equal(card.owner_coldkey, null);
        assert.equal(card.point_count, 0);
        assert.equal(card.owner_uid_count, null);
        assert.deepEqual(card.points, []);
        assert.deepEqual(card.owner_uids, []);
        assert.deepEqual(card.attribution, []);
        assert.deepEqual(card.attribution_vocabulary, []);
        assert.deepEqual(card.blind_spots, []);
      });
  });

  test("the MCP tool forwards the tier's card unchanged", async () => {
    const out = (await tool("get_subnet_owner_capture").handler(
      { netuid: NETUID, window: "7d" },
      { env: tierEnv(FORWARDED) } as never,
    )) as Row;
    assert.equal(out.owner_coldkey, "5OwnerCold");
    assert.equal((out.blind_spots as Row[]).length, 3);
  });
});

describe("the GraphQL field", () => {
  const gql = async (query: string) => {
    const res = await handleGraphQLRequest(
      new Request("https://api.metagraph.sh/api/v1/graphql", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query }),
      }),
      mockEnv() as never,
      undefined,
    );
    return { status: res.status, body: (await res.json()) as Row };
  };

  test("serves the card, blind spots included", async () => {
    const { status, body } = await gql(
      `query { subnet_owner_capture(netuid: ${NETUID}) {
         netuid window owner_coldkey point_count
         blind_spots { layer summary }
       } }`,
    );
    assert.equal(status, 200);
    assert.equal(body.errors, undefined);
    const card = body.data.subnet_owner_capture as Row;
    assert.equal(card.netuid, NETUID);
    assert.equal(card.owner_coldkey, null);
    assert.deepEqual(
      (card.blind_spots as Row[]).map((s) => s.layer),
      ["L3", "L4", "L5"],
      "a resolver field list that dropped these would pass every other test",
    );
  });

  test("an unsupported window is rejected, not silently defaulted", async () => {
    const { body } = await gql(
      `query { subnet_owner_capture(netuid: ${NETUID}, window: "1d") { window } }`,
    );
    assert.ok(body.errors, "1d was accepted");
    assert.equal((body.errors as Row[])[0].extensions?.code, "BAD_USER_INPUT");
  });

  test("each published window reaches the resolver", async () => {
    for (const window of ["7d", "30d", "90d"]) {
      const { body } = await gql(
        `query { subnet_owner_capture(netuid: ${NETUID}, window: "${window}") { window } }`,
      );
      assert.equal(body.errors, undefined, `errored on ${window}`);
      assert.equal(
        (body.data.subnet_owner_capture as Row).window,
        window,
        `on ${window}`,
      );
    }
  });

  test("the verdict enum cannot express more than the vocabulary", async () => {
    // Schema-level: GraphQL types the verdict from the shared enum, so a
    // surface inventing a fifth word would not even serialise.
    const { body } = await gql(
      `query { __type(name: "SubnetOwnerCaptureStakeholder") {
         fields { name type { name kind ofType { name kind } } }
       } }`,
    );
    const fields = (body.data.__type as Row)?.fields as Row[] | undefined;
    assert.ok(fields, "the stakeholder type must be published");
    assert.ok(
      fields.some((f) => f.name === "verdict"),
      "verdict must be part of the published type",
    );
  });
});
