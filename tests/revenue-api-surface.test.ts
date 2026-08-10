// #10447: the two revenue surfaces -- the REST routes and the MCP tools --
// driven through their own entry points.
//
// revenue-serving.test.ts and revenue-load.test.ts cover the arithmetic. What
// is only reachable from here is the WIRING, and every branch of it exists
// because the normal case is missing data:
//
//   - the netuid guard, which must answer 400 rather than read an artifact
//     under a netuid the chain cannot have;
//   - three artifact reads (economics, the subnet record, TAO/USD) that are
//     each allowed to come back absent, malformed, or throwing, because a
//     subnet with no revenue is the rule and not the exception;
//   - the per-row skip in the cross-subnet sweep, which keeps ONE malformed
//     economics entry from turning a 128-subnet answer into a failure.
//
// A test that only walks the happy path here would prove nothing: the happy
// path is the rare one.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { handleRequest } from "../workers/api.ts";
import { MCP_TOOLS } from "../src/mcp-server.ts";
import { jsonBody, mockEnv, type Row } from "./row-type.ts";

const ECONOMICS_PATH = "/metagraph/economics.json";
const TAO_USD_PATH = "/metagraph/network/tao-usd.json";
const SUBNET_PATH = (netuid: number) => `/metagraph/subnets/${netuid}.json`;

/** One economics row shaped like the published blob's entries. */
const SN64_ECONOMICS = {
  netuid: 64,
  tao_in_emission_tao: 0.012416161,
  excess_tao: 0.051199103,
  alpha_out_emission: 1,
  alpha_price_tao: 0.086933658,
};

/** A declared, readable revenue surface -- the two-of-128 case. */
const REVENUE_SURFACE = {
  id: "sn-64-chutes-daily-revenue-summary",
  revenue: {
    role: "external-revenue",
    provenance: "probe-derived",
    currency: "USD",
    grain: "daily",
  },
};

type ArtifactMap = Record<string, unknown>;

/** An env whose artifact reads are exactly the map given -- anything else
 * 404s, which is what an unpublished artifact really does. `throwOn` makes a
 * path fail hard rather than 404, the case the catch blocks exist for.
 *
 * BOTH bindings are stubbed on purpose. readArtifact picks a storage tier per
 * path: an r2-tier artifact returns the R2 miss WITHOUT consulting ASSETS
 * unless METAGRAPH_ALLOW_R2_STATIC_FALLBACK is set, so an ASSETS-only env
 * silently serves nothing for economics.json and the subnet records -- which
 * looks exactly like "this subnet declares no revenue" and would let these
 * tests pass while proving nothing. */
function artifactEnv(artifacts: ArtifactMap, throwOn?: string) {
  const r2Object = (value: unknown) => ({
    async json() {
      return value;
    },
  });
  return mockEnv({
    ASSETS: {
      async fetch(request: Request) {
        const { pathname } = new URL(request.url);
        if (throwOn && pathname === throwOn) {
          throw new Error("asset read exploded");
        }
        if (pathname in artifacts) {
          // `?? null`: a mapped-but-empty artifact is a 200 carrying no body
          // object -- a real state (a published file that decoded to nothing)
          // and the one the `?? null` guards downstream exist for.
          return Response.json((artifacts[pathname] ?? null) as Row);
        }
        return new Response("{}", { status: 404 });
      },
    },
    METAGRAPH_ARCHIVE: {
      async get(key: string) {
        const pathname = `/metagraph/${String(key).replace(/^latest\//, "")}`;
        if (throwOn && pathname === throwOn) {
          throw new Error("r2 read exploded");
        }
        return pathname in artifacts ? r2Object(artifacts[pathname]) : null;
      },
    },
  });
}

function req(path: string) {
  return new Request(`https://api.metagraph.sh${path}`);
}

/** An MCP context whose artifact reads are the map given. */
function mcpCtx(artifacts: ArtifactMap, throwOn?: string) {
  return {
    env: mockEnv(),
    readArtifact: async (_env: unknown, path: string) => {
      if (throwOn && path === throwOn)
        throw new Error("artifact read exploded");
      if (path in artifacts) return { ok: true, data: artifacts[path] };
      return { ok: false, status: 404, code: "artifact_not_found" };
    },
  } as never;
}

function tool(name: string) {
  const found = MCP_TOOLS.find((t) => t.name === name);
  assert.ok(found, `${name} must be registered`);
  return found!;
}

describe("GET /api/v1/subnets/{netuid}/revenue", () => {
  test("a netuid outside the u16 range is a 400, not an artifact read", async () => {
    // The guard exists so an out-of-range netuid cannot become a read for
    // /metagraph/subnets/99999.json and surface as artifact_not_found -- an
    // incident code for what is a malformed request.
    const res = await handleRequest(
      req("/api/v1/subnets/99999/revenue"),
      artifactEnv({}),
    );
    assert.equal(res.status, 400);
    const body = await jsonBody(res);
    assert.equal((body.error as Row)?.code, "invalid_netuid");
  });

  test("serves the ratio when economics, surfaces and a TAO price are all present", async () => {
    const res = await handleRequest(
      req("/api/v1/subnets/64/revenue"),
      artifactEnv({
        [ECONOMICS_PATH]: { subnets: [SN64_ECONOMICS] },
        [SUBNET_PATH(64)]: { surfaces: [REVENUE_SURFACE] },
        [TAO_USD_PATH]: { latest: { usd_per_tao: 204.03 } },
      }),
    );
    assert.equal(res.status, 200);
    const body = await jsonBody(res);
    const data = body.data as Row;
    assert.equal(data.netuid, 64);
    const revenue = data.revenue as Row;
    // Declared and readable, but no probe observation yet: the source is
    // reported, the headline stays null. Absent is not zero.
    assert.equal(revenue.provenance, "probe-derived");
    assert.equal(revenue.revenue_usd, null);
    assert.equal(revenue.coverage_ratio, null);
    assert.equal((revenue.sources as unknown[]).length, 1);
    // The emission side is measured regardless of whether revenue is.
    assert.ok(((revenue.emission as Row).tao as number) > 0);
    assert.ok(data.field_sources, "provenance map is always published");
  });

  test("a subnet with no published record answers, rather than 404ing", async () => {
    // 126 of 128 subnets are in this state. An error here would make the
    // normal case look like a broken endpoint.
    const res = await handleRequest(
      req("/api/v1/subnets/64/revenue"),
      artifactEnv({ [ECONOMICS_PATH]: { subnets: [SN64_ECONOMICS] } }),
    );
    assert.equal(res.status, 200);
    const revenue = (await jsonBody(res)).data as Row;
    assert.equal((revenue.revenue as Row).provenance, "none");
  });

  test("a subnet record carrying no surfaces array reads as no declarations", async () => {
    // The record exists but has no `surfaces` key at all -- distinct from the
    // record being missing, and it must not throw on the way past.
    const res = await handleRequest(
      req("/api/v1/subnets/64/revenue"),
      artifactEnv({
        [ECONOMICS_PATH]: { subnets: [SN64_ECONOMICS] },
        [SUBNET_PATH(64)]: { netuid: 64 },
      }),
    );
    assert.equal(res.status, 200);
    const revenue = (await jsonBody(res)).data as Row;
    assert.equal((revenue.revenue as Row).provenance, "none");
  });
});

describe("the TAO/USD read is allowed to come back empty", () => {
  test("a price artifact that is absent prices the emission at no USD", async () => {
    const res = await handleRequest(
      req("/api/v1/subnets/64/revenue"),
      artifactEnv({ [ECONOMICS_PATH]: { subnets: [SN64_ECONOMICS] } }),
    );
    assert.equal(res.status, 200);
    const revenue = (await jsonBody(res)).data as Row;
    assert.equal(((revenue.revenue as Row).emission as Row).usd, 0);
  });

  test("a non-numeric usd_per_tao is refused rather than coerced", async () => {
    // A string here would multiply into NaN and publish it. Null is the only
    // honest reading of a price that is not a number.
    const res = await handleRequest(
      req("/api/v1/subnets/64/revenue"),
      artifactEnv({
        [ECONOMICS_PATH]: { subnets: [SN64_ECONOMICS] },
        [TAO_USD_PATH]: { latest: { usd_per_tao: "204.03" } },
      }),
    );
    assert.equal(res.status, 200);
    const revenue = (await jsonBody(res)).data as Row;
    assert.equal(((revenue.revenue as Row).emission as Row).usd, 0);
  });

  test("a price artifact with no latest block is likewise not a failure", async () => {
    const res = await handleRequest(
      req("/api/v1/subnets/64/revenue"),
      artifactEnv({
        [ECONOMICS_PATH]: { subnets: [SN64_ECONOMICS] },
        [TAO_USD_PATH]: { schema_version: 1 },
      }),
    );
    assert.equal(res.status, 200);
  });

  test("a price read that THROWS is caught, not propagated to the caller", async () => {
    // The whole route must not 500 because the price lane is broken: the
    // revenue answer does not depend on it.
    const res = await handleRequest(
      req("/api/v1/subnets/64/revenue"),
      artifactEnv(
        { [ECONOMICS_PATH]: { subnets: [SN64_ECONOMICS] } },
        TAO_USD_PATH,
      ),
    );
    assert.equal(res.status, 200);
    const revenue = (await jsonBody(res)).data as Row;
    assert.equal(((revenue.revenue as Row).emission as Row).usd, 0);
  });
});

describe("GET /api/v1/chain/revenue-coverage", () => {
  test("includes the uncovered subnets rather than dropping them", async () => {
    // Omitting them would make the covered set look like the whole network --
    // observed_count against subnet_count is the honest headline.
    const res = await handleRequest(
      req("/api/v1/chain/revenue-coverage"),
      artifactEnv({
        [ECONOMICS_PATH]: {
          subnets: [SN64_ECONOMICS, { ...SN64_ECONOMICS, netuid: 1 }],
        },
        [SUBNET_PATH(64)]: { surfaces: [REVENUE_SURFACE] },
      }),
    );
    assert.equal(res.status, 200);
    const data = (await jsonBody(res)).data as Row;
    assert.equal(data.subnet_count, 2);
    assert.equal(data.observed_count, 0, "declared but not yet observed");
    assert.equal((data.subnets as unknown[]).length, 2);
  });

  test("one malformed economics row is skipped, not fatal to the sweep", async () => {
    // A row whose netuid does not parse cannot be addressed, but it must not
    // take the other 127 answers down with it.
    const res = await handleRequest(
      req("/api/v1/chain/revenue-coverage"),
      artifactEnv({
        [ECONOMICS_PATH]: {
          subnets: [SN64_ECONOMICS, { netuid: "not-a-netuid" }, {}],
        },
      }),
    );
    assert.equal(res.status, 200);
    const data = (await jsonBody(res)).data as Row;
    assert.equal(data.subnet_count, 1, "only the addressable row survives");
  });

  test("an economics blob with no subnets array answers empty, not 500", async () => {
    const res = await handleRequest(
      req("/api/v1/chain/revenue-coverage"),
      artifactEnv({ [ECONOMICS_PATH]: { schema_version: 1 } }),
    );
    assert.equal(res.status, 200);
    const data = (await jsonBody(res)).data as Row;
    assert.equal(data.subnet_count, 0);
    assert.equal(data.observed_count, 0);
  });

  test("an economics artifact that reads successfully but decodes to nothing", async () => {
    // The read SUCCEEDS and the body is empty -- distinct from a 404, and the
    // only way to reach the `?? null` that keeps `undefined` out of the blob.
    const res = await handleRequest(
      req("/api/v1/chain/revenue-coverage"),
      artifactEnv({ [ECONOMICS_PATH]: undefined }),
    );
    assert.equal(res.status, 200);
    const data = (await jsonBody(res)).data as Row;
    assert.equal(data.subnet_count, 0);
  });
});

describe("the get_subnet_revenue MCP tool", () => {
  test("rejects a netuid outside the u16 range before reading anything", async () => {
    await assert.rejects(
      () => tool("get_subnet_revenue").handler({ netuid: 70000 }, mcpCtx({})),
      /u16 range/,
    );
  });

  test("returns the composed view when every artifact is present", async () => {
    const out = (await tool("get_subnet_revenue").handler(
      { netuid: 64 },
      mcpCtx({
        [ECONOMICS_PATH]: { subnets: [SN64_ECONOMICS] },
        [SUBNET_PATH(64)]: { surfaces: [REVENUE_SURFACE] },
        [TAO_USD_PATH]: { latest: { usd_per_tao: 204.03 } },
      }),
    )) as Row;
    assert.equal(out.netuid, 64);
    const revenue = out.revenue as Row;
    assert.equal(revenue.provenance, "probe-derived");
    assert.equal(revenue.coverage_ratio, null, "declared, not yet observed");
    assert.ok(((revenue.emission as Row).tao as number) > 0);
    assert.ok(out.field_sources);
  });

  test("a missing subnet record is 'nothing declared', not a tool error", async () => {
    const out = (await tool("get_subnet_revenue").handler(
      { netuid: 64 },
      mcpCtx({ [ECONOMICS_PATH]: { subnets: [SN64_ECONOMICS] } }),
    )) as Row;
    assert.equal((out.revenue as Row).provenance, "none");
  });

  test("a subnet record with no surfaces array reads the same way", async () => {
    const out = (await tool("get_subnet_revenue").handler(
      { netuid: 64 },
      mcpCtx({
        [ECONOMICS_PATH]: { subnets: [SN64_ECONOMICS] },
        [SUBNET_PATH(64)]: { netuid: 64 },
      }),
    )) as Row;
    assert.equal((out.revenue as Row).provenance, "none");
  });

  test("an economics read that throws yields no denominator, not a failure", async () => {
    const out = (await tool("get_subnet_revenue").handler(
      { netuid: 64 },
      mcpCtx({}, ECONOMICS_PATH),
    )) as Row;
    assert.equal(((out.revenue as Row).emission as Row).tao, 0);
  });

  test("a non-numeric TAO price is read as no price", async () => {
    const out = (await tool("get_subnet_revenue").handler(
      { netuid: 64 },
      mcpCtx({
        [ECONOMICS_PATH]: { subnets: [SN64_ECONOMICS] },
        [TAO_USD_PATH]: { latest: { usd_per_tao: null } },
      }),
    )) as Row;
    assert.equal(((out.revenue as Row).emission as Row).usd, 0);
  });

  test("a TAO price read that throws is caught", async () => {
    const out = (await tool("get_subnet_revenue").handler(
      { netuid: 64 },
      mcpCtx({ [ECONOMICS_PATH]: { subnets: [SN64_ECONOMICS] } }, TAO_USD_PATH),
    )) as Row;
    assert.equal(((out.revenue as Row).emission as Row).usd, 0);
  });
});

describe("the list_revenue_coverage MCP tool", () => {
  test("counts what is observed against what exists", async () => {
    const out = (await tool("list_revenue_coverage").handler(
      {},
      mcpCtx({
        [ECONOMICS_PATH]: {
          subnets: [SN64_ECONOMICS, { ...SN64_ECONOMICS, netuid: 1 }],
        },
        [SUBNET_PATH(64)]: { surfaces: [REVENUE_SURFACE] },
      }),
    )) as Row;
    assert.equal(out.subnet_count, 2);
    assert.equal(out.observed_count, 0);
    assert.equal((out.subnets as unknown[]).length, 2);
  });

  test("skips a row whose netuid does not parse", async () => {
    const out = (await tool("list_revenue_coverage").handler(
      {},
      mcpCtx({
        [ECONOMICS_PATH]: {
          subnets: [SN64_ECONOMICS, { netuid: "not-a-netuid" }],
        },
      }),
    )) as Row;
    assert.equal(out.subnet_count, 1);
  });

  test("an unreadable economics blob is an empty answer, not a throw", async () => {
    const out = (await tool("list_revenue_coverage").handler(
      {},
      mcpCtx({}, ECONOMICS_PATH),
    )) as Row;
    assert.equal(out.subnet_count, 0);
    assert.equal(out.observed_count, 0);
  });

  test("an economics blob with no subnets array answers empty too", async () => {
    const out = (await tool("list_revenue_coverage").handler(
      {},
      mcpCtx({ [ECONOMICS_PATH]: { schema_version: 1 } }),
    )) as Row;
    assert.equal(out.subnet_count, 0);
  });

  test("an economics read that succeeds with an empty body is still empty", async () => {
    // ok:true carrying no data. Without the `?? null` this hands `undefined`
    // down as though it were a blob.
    const out = (await tool("list_revenue_coverage").handler(
      {},
      mcpCtx({ [ECONOMICS_PATH]: undefined }),
    )) as Row;
    assert.equal(out.subnet_count, 0);
  });
});
