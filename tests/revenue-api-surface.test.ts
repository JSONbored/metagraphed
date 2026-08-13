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
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, test, vi } from "vitest";

// The price now comes from `tao_usd_index` through readStore, which builds its
// own client -- there is no binding a route caller can inject. Mocking the
// module is the seam; see tests/helpers/pg-mock.ts for why the controller has
// to be built inside vi.hoisted.
const { pg } = await vi.hoisted(async () => ({
  pg: (await import("./helpers/pg-mock.ts")).createPgMock(),
}));
vi.mock("pg", () => pg.module);

import { handleRequest } from "../workers/api.ts";
import { MCP_TOOLS } from "../src/mcp-server.ts";
import { jsonBody, mockEnv, type Row } from "./row-type.ts";
import { pgMockEnv } from "./helpers/pg-mock.ts";
import { TAO_USD_MAX_AGE_MS } from "../src/alpha-usd.ts";

// The real DDL, so the CHECK pairing a null price with `insufficient_pools` is
// enforced here too -- a fixture that could store a null price under
// `wrapped_onchain_median` would be testing a state production cannot reach.
const TAO_USD_SCHEMA = (() => {
  const sql = fs.readFileSync(
    path.join(
      process.cwd(),
      "tests/fixtures/sqlite-schema/0004_user_state.sql",
    ),
    "utf8",
  );
  const start = sql.indexOf("CREATE TABLE IF NOT EXISTS tao_usd_index");
  const end = sql.indexOf(
    "CREATE INDEX IF NOT EXISTS idx_tao_usd_index_observed",
  );
  return sql.slice(start, sql.indexOf(";", end) + 1);
})();

let taoUsdDb: InstanceType<typeof DatabaseSync>;

beforeEach(() => {
  taoUsdDb = new DatabaseSync(":memory:");
  taoUsdDb.exec(TAO_USD_SCHEMA);
  pg.control.db = taoUsdDb;
  pg.control.queries.length = 0;
});

/** One reading in the index, `ageMs` old. A null price stores itself as the
 * `insufficient_pools` decline the CHECK constraint requires. */
function seedTaoUsd(usd: number | null, ageMs = 60_000) {
  taoUsdDb
    .prepare(
      `INSERT INTO tao_usd_index
         (block_number, observed_at, usd_per_tao, price_basis, eth_usd, pool_count, pools)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      25_692_599,
      Date.now() - ageMs,
      usd,
      usd === null ? "insufficient_pools" : "wrapped_onchain_median",
      1906.04,
      usd === null ? 0 : 2,
      "[]",
    );
}

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

/** artifactEnv plus the Hyperdrive binding the price read resolves its store
 * from, so a route test can exercise the priced path as well as the declining
 * one. */
function pricedEnv(artifacts: ArtifactMap, throwOn?: string) {
  return {
    ...(artifactEnv(artifacts, throwOn) as unknown as Record<string, unknown>),
    ...pgMockEnv(),
  } as never;
}

/** An MCP context whose artifact reads are the map given. */
function mcpCtx(artifacts: ArtifactMap, throwOn?: string) {
  return {
    env: {
      ...(mockEnv() as unknown as Record<string, unknown>),
      ...pgMockEnv(),
    },
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

  // #10925: the third surface. REST needs no hand-written guard either -- the
  // router validates against the published query schema and answers
  // `invalid_query` -- but the point of this issue is that all three surfaces
  // resolve ONE vocabulary, and "they must agree" is worth an assertion on each
  // rather than an argument about the wiring.
  test("each published window reaches window_days", async () => {
    for (const [window, days] of [
      ["1d", 1],
      ["7d", 7],
      ["30d", 30],
    ] as const) {
      const res = await handleRequest(
        req(`/api/v1/subnets/64/revenue?window=${window}`),
        artifactEnv({ [ECONOMICS_PATH]: { subnets: [SN64_ECONOMICS] } }),
      );
      assert.equal(res.status, 200, `on ${window}`);
      const body = await jsonBody(res);
      assert.equal(
        ((body.data as Row).revenue as Row).window_days,
        days,
        `on ${window}`,
      );
    }
  });

  test("an out-of-enum window is a 400, not the default window", async () => {
    const res = await handleRequest(
      req("/api/v1/subnets/64/revenue?window=90d"),
      artifactEnv({ [ECONOMICS_PATH]: { subnets: [SN64_ECONOMICS] } }),
    );
    assert.equal(res.status, 400);
    const body = await jsonBody(res);
    assert.equal((body.error as Row)?.code, "invalid_query");
    assert.equal((body.meta as Row)?.parameter, "window");
  });

  test("an omitted window is the default, unchanged from before #10925", async () => {
    const res = await handleRequest(
      req("/api/v1/subnets/64/revenue"),
      artifactEnv({ [ECONOMICS_PATH]: { subnets: [SN64_ECONOMICS] } }),
    );
    const body = await jsonBody(res);
    assert.equal(((body.data as Row).revenue as Row).window_days, 1);
  });

  test("the coverage route takes the same vocabulary", async () => {
    const ok = await handleRequest(
      req("/api/v1/chain/revenue-coverage?window=30d"),
      artifactEnv({ [ECONOMICS_PATH]: { subnets: [SN64_ECONOMICS] } }),
    );
    assert.equal(ok.status, 200);
    assert.equal((await jsonBody(ok)).data.window_days, 30);
    const bad = await handleRequest(
      req("/api/v1/chain/revenue-coverage?window=90d"),
      artifactEnv({ [ECONOMICS_PATH]: { subnets: [SN64_ECONOMICS] } }),
    );
    assert.equal(bad.status, 400);
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

// The price comes from `tao_usd_index`, NOT from
// /metagraph/network/tao-usd.json -- that artifact is never published, so the
// old read returned null on every request and every USD leg went with it.
// These tests drive the real source, and assert null rather than the 0 they
// used to pin.
describe("the TAO/USD read is allowed to come back empty", () => {
  test("no store bound declines every USD leg, and zeroes none", async () => {
    const res = await handleRequest(
      req("/api/v1/subnets/64/revenue"),
      artifactEnv({ [ECONOMICS_PATH]: { subnets: [SN64_ECONOMICS] } }),
    );
    assert.equal(res.status, 200);
    const emission = (((await jsonBody(res)).data as Row).revenue as Row)
      .emission as Row;
    assert.ok((emission.tao as number) > 0, "the TAO leg is measured anyway");
    assert.equal(emission.usd, null, "no rate declines, never zeroes");
    const alternates = emission.alternates as Row;
    assert.equal((alternates.owner_take as Row).usd, null);
    assert.equal((alternates.alpha_out_priced as Row).usd, null);
  });

  test("an unpriced newest reading declines rather than publishing a 0 rate", async () => {
    // `price_basis: insufficient_pools` with a null price is ADR 0025's
    // published decline. Multiplying by it would say TAO is worthless.
    seedTaoUsd(null);
    const res = await handleRequest(
      req("/api/v1/subnets/64/revenue"),
      pricedEnv({ [ECONOMICS_PATH]: { subnets: [SN64_ECONOMICS] } }),
    );
    assert.equal(res.status, 200);
    const emission = (((await jsonBody(res)).data as Row).revenue as Row)
      .emission as Row;
    assert.equal(emission.usd, null);
  });

  test("a reading past the freshness bound declines too", async () => {
    seedTaoUsd(204.03, TAO_USD_MAX_AGE_MS + 60_000);
    const res = await handleRequest(
      req("/api/v1/subnets/64/revenue"),
      pricedEnv({ [ECONOMICS_PATH]: { subnets: [SN64_ECONOMICS] } }),
    );
    const emission = (((await jsonBody(res)).data as Row).revenue as Row)
      .emission as Row;
    assert.equal(emission.usd, null, "a frozen rate must not keep serving");
  });

  test("a price read that THROWS is caught, not propagated to the caller", async () => {
    // The whole route must not 500 because the price lane is broken: the
    // revenue answer does not depend on it.
    const env = pricedEnv({ [ECONOMICS_PATH]: { subnets: [SN64_ECONOMICS] } });
    pg.control.db = {
      prepare() {
        throw new Error("store exploded");
      },
    } as never;
    const res = await handleRequest(req("/api/v1/subnets/64/revenue"), env);
    assert.equal(res.status, 200);
    const emission = (((await jsonBody(res)).data as Row).revenue as Row)
      .emission as Row;
    assert.equal(emission.usd, null);
  });
});

// The requirement the whole fix exists for: a live price must reach the
// payload as a real number. Nothing asserted this before -- the happy-path
// test above checks the ratio and never looks at `emission.usd`, which is how
// a hard 0 shipped to all 129 subnets unnoticed.
describe("a live price reaches every USD leg", () => {
  test("non-zero TAO emission with a live rate never serialises usd: 0", async () => {
    seedTaoUsd(204.03);
    const res = await handleRequest(
      req("/api/v1/subnets/64/revenue"),
      pricedEnv({ [ECONOMICS_PATH]: { subnets: [SN64_ECONOMICS] } }),
    );
    assert.equal(res.status, 200);
    const emission = (((await jsonBody(res)).data as Row).revenue as Row)
      .emission as Row;
    const alternates = emission.alternates as Row;
    for (const [name, usd] of [
      ["emission.usd", emission.usd],
      ["owner_take.usd", (alternates.owner_take as Row).usd],
      ["alpha_out_priced.usd", (alternates.alpha_out_priced as Row).usd],
    ] as const) {
      assert.notEqual(
        usd,
        0,
        `${name} serialised a zero against real emission`,
      );
      assert.equal(typeof usd, "number", `${name} must be priced`);
      assert.ok((usd as number) > 0, `${name} must be positive`);
    }
    // 458.03 TAO/day x $204.03 -- the conversion, not merely "non-zero".
    assert.ok(
      Math.abs((emission.usd as number) - 93452) < 5,
      `${emission.usd}`,
    );
  });

  test("the cross-subnet sweep prices every row the same way", async () => {
    seedTaoUsd(204.03);
    const res = await handleRequest(
      req("/api/v1/chain/revenue-coverage"),
      pricedEnv({ [ECONOMICS_PATH]: { subnets: [SN64_ECONOMICS] } }),
    );
    assert.equal(res.status, 200);
    const subnets = ((await jsonBody(res)).data as Row).subnets as Row[];
    assert.ok(subnets.length > 0);
    for (const row of subnets) {
      const emission = row.emission as Row;
      assert.notEqual(emission.usd, 0, `netuid ${row.netuid} zeroed`);
      assert.ok((emission.usd as number) > 0);
    }
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

  // #10925: the window is a real argument here, and MCP dispatch does not
  // validate against the published input schema -- so these two tools are the
  // only thing standing between an out-of-enum window and a confidently wrong
  // answer. `revenueWindowDays` falls back to 1d by design (the REST router has
  // already rejected anything else by the time it runs), which on this path
  // would mean `window: "90d"` silently returns the ONE-DAY figure.
  test("an out-of-enum window is an error, NOT the default window", async () => {
    await assert.rejects(
      () =>
        tool("get_subnet_revenue").handler(
          { netuid: 64, window: "90d" },
          mcpCtx({ [ECONOMICS_PATH]: { subnets: [SN64_ECONOMICS] } }),
        ),
      /must be one of: 1d, 7d, 30d/,
    );
  });

  test("a non-string window is rejected too", async () => {
    // `30` is the shape a caller reaches for after reading `window_days` in the
    // response body, and `allowed.includes(30)` is false -- but only because
    // the guard checks the type first. Without that check the number would
    // reach the day map and miss, i.e. the 1d answer again.
    await assert.rejects(
      () =>
        tool("get_subnet_revenue").handler(
          { netuid: 64, window: 30 },
          mcpCtx({ [ECONOMICS_PATH]: { subnets: [SN64_ECONOMICS] } }),
        ),
      /must be one of/,
    );
  });

  test("each published window is accepted and reaches the body", async () => {
    for (const [window, days] of [
      ["1d", 1],
      ["7d", 7],
      ["30d", 30],
    ] as const) {
      const out = (await tool("get_subnet_revenue").handler(
        { netuid: 64, window },
        mcpCtx({ [ECONOMICS_PATH]: { subnets: [SN64_ECONOMICS] } }),
      )) as Row;
      assert.equal((out.revenue as Row).window_days, days, `on ${window}`);
    }
  });

  test("an omitted window is the default, not an error", async () => {
    const out = (await tool("get_subnet_revenue").handler(
      { netuid: 64 },
      mcpCtx({ [ECONOMICS_PATH]: { subnets: [SN64_ECONOMICS] } }),
    )) as Row;
    assert.equal((out.revenue as Row).window_days, 1);
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

  test("no readable price declines the USD legs rather than zeroing them", async () => {
    const out = (await tool("get_subnet_revenue").handler(
      { netuid: 64 },
      mcpCtx({ [ECONOMICS_PATH]: { subnets: [SN64_ECONOMICS] } }),
    )) as Row;
    const emission = (out.revenue as Row).emission as Row;
    assert.ok((emission.tao as number) > 0);
    assert.equal(emission.usd, null);
    assert.equal(((emission.alternates as Row).owner_take as Row).usd, null);
  });

  test("a price read that throws is caught, not propagated", async () => {
    const ctx = mcpCtx({ [ECONOMICS_PATH]: { subnets: [SN64_ECONOMICS] } });
    pg.control.db = {
      prepare() {
        throw new Error("store exploded");
      },
    } as never;
    const out = (await tool("get_subnet_revenue").handler(
      { netuid: 64 },
      ctx,
    )) as Row;
    assert.equal(((out.revenue as Row).emission as Row).usd, null);
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

  test("rejects an out-of-enum window rather than defaulting", async () => {
    await assert.rejects(
      () =>
        tool("list_revenue_coverage").handler(
          { window: "90d" },
          mcpCtx({ [ECONOMICS_PATH]: { subnets: [SN64_ECONOMICS] } }),
        ),
      /must be one of: 1d, 7d, 30d/,
    );
  });

  test("carries the requested window into every row", async () => {
    const out = (await tool("list_revenue_coverage").handler(
      { window: "30d" },
      mcpCtx({ [ECONOMICS_PATH]: { subnets: [SN64_ECONOMICS] } }),
    )) as Row;
    assert.equal(out.window_days, 30);
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
