// #10488/#10510: the money-map surfaces -- the REST routes and the MCP tools --
// driven through their own entry points.
//
// wallets-load.test.ts covers the composition. What is only reachable from here
// is the WIRING, and every branch of it exists because the normal case is
// missing data:
//
//   - the netuid guard, which must answer 400 rather than read an artifact
//     under a netuid the chain cannot have;
//   - the entities artifact, which is allowed to be absent (128 of 128 subnets
//     have nothing declared today) and must then serve the chain-derived owner
//     keys rather than an error;
//   - network/parameters.json, whose `subnet_owner_cut_effective` is allowed to
//     be missing or non-numeric -- in which case the accrual is NULL rather
//     than silently 18%, which is the whole point of #10484.
//
// A test that only walked the happy path here would prove nothing: an empty
// entities artifact IS the production state.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { handleRequest } from "../workers/api.ts";
import { MCP_TOOLS } from "../src/mcp-server.ts";
import { jsonBody, mockEnv, type Row } from "./row-type.ts";

const ECONOMICS_PATH = "/metagraph/economics.json";
const ENTITIES_PATH = "/metagraph/entities.json";
const PARAMETERS_PATH = "/metagraph/network/parameters.json";

const OWNER_COLD = "5FRYKhbmfXPDoHdUUDMx27E3HuMvAzwjzFMMq3rNurUhAyS9";
const OWNER_HOT = "5CS3g6nVJM6ouns8n9buN9CzFf2C1YDHVcVGRcxoirKs2xbV";
const TREASURY = "5EvYE2R9HhPpCk9M2hGgAy9HJ3seergi2cc14hqVkh3aeUy1";

const SN64_ECONOMICS = {
  netuid: 64,
  owner_coldkey: OWNER_COLD,
  owner_hotkey: OWNER_HOT,
  alpha_out_emission: 1,
  alpha_price_tao: 0.086933658,
};

const DECLARED_TREASURY = {
  ss58: TREASURY,
  netuid: 64,
  category: "treasury",
  name: "Example Treasury",
  source_urls: ["https://example.org/treasury"],
};

/** SubnetOwnerCut reconstructed: 11796/65535, not one sixth. */
const OWNER_CUT_EFFECTIVE = 11796 / 65535;

type ArtifactMap = Record<string, unknown>;

/** An env whose artifact reads are exactly the map given -- anything else 404s,
 * which is what an unpublished artifact really does.
 *
 * BOTH bindings are stubbed on purpose: readArtifact picks a storage tier per
 * path, and an r2-tier artifact returns the R2 miss WITHOUT consulting ASSETS.
 * An ASSETS-only env would serve nothing for economics.json, which looks
 * exactly like "this subnet has no owner" and would let these tests pass while
 * proving nothing. */
function artifactEnv(artifacts: ArtifactMap) {
  const r2Object = (value: unknown) => ({
    async json() {
      return value;
    },
  });
  return mockEnv({
    ASSETS: {
      async fetch(request: Request) {
        const { pathname } = new URL(request.url);
        if (pathname in artifacts) {
          return Response.json((artifacts[pathname] ?? null) as Row);
        }
        return new Response("{}", { status: 404 });
      },
    },
    METAGRAPH_ARCHIVE: {
      async get(key: string) {
        const pathname = `/metagraph/${String(key).replace(/^latest\//, "")}`;
        return pathname in artifacts ? r2Object(artifacts[pathname]) : null;
      },
    },
  });
}

function req(path: string) {
  return new Request(`https://api.metagraph.sh${path}`);
}

/** An MCP context whose artifact reads are the map given. */
function mcpCtx(artifacts: ArtifactMap) {
  return {
    env: mockEnv(),
    readArtifact: async (_env: unknown, path: string) => {
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

describe("GET /api/v1/subnets/{netuid}/wallets", () => {
  test("a netuid outside the u16 range is a 400, not an artifact read", async () => {
    // Without the guard this becomes a read for /metagraph/subnets/99999.json
    // and surfaces as artifact_not_found -- an incident code for what is
    // really a malformed request.
    const res = await handleRequest(
      req("/api/v1/subnets/99999/wallets"),
      artifactEnv({}),
    );
    assert.equal(res.status, 400);
    assert.equal(((await jsonBody(res)).error as Row)?.code, "invalid_netuid");
  });

  test("serves the chain-derived owner keys and the declared treasury", async () => {
    const res = await handleRequest(
      req("/api/v1/subnets/64/wallets"),
      artifactEnv({
        [ECONOMICS_PATH]: { subnets: [SN64_ECONOMICS] },
        [ENTITIES_PATH]: { entities: [DECLARED_TREASURY] },
      }),
    );
    assert.equal(res.status, 200);
    const data = (await jsonBody(res)).data as Row;
    assert.equal(data.netuid, 64);
    assert.equal(data.wallet_count, 3);
    const wallets = data.wallets as Row[];
    // The owner keys are chain-derived and carry no evidence, because the
    // chain IS the evidence. The treasury is a human attribution and carries
    // the source_urls that back it, IN the response.
    assert.deepEqual(
      wallets.map((w) => w.chain_derived),
      [true, true, false],
    );
    const treasury = wallets.find((w) => w.ss58 === TREASURY);
    assert.deepEqual(treasury?.source_urls, ["https://example.org/treasury"]);
    assert.ok(data.field_sources);
  });

  test("no entities artifact still answers, with only the owner keys", async () => {
    // This is production: nothing is declared for any subnet yet. An error
    // here would turn a 128-subnet sweep into 128 failures.
    const res = await handleRequest(
      req("/api/v1/subnets/64/wallets"),
      artifactEnv({ [ECONOMICS_PATH]: { subnets: [SN64_ECONOMICS] } }),
    );
    assert.equal(res.status, 200);
    const data = (await jsonBody(res)).data as Row;
    assert.equal(data.wallet_count, 2);
    for (const w of data.wallets as Row[]) assert.equal(w.role, "owner");
  });

  test("an unknown subnet is an empty list, not a 404", async () => {
    // "Nothing has been attributed" and "this subnet does not exist" are
    // different facts, and only the first one is ours to report.
    const res = await handleRequest(
      req("/api/v1/subnets/999/wallets"),
      artifactEnv({}),
    );
    assert.equal(res.status, 200);
    const data = (await jsonBody(res)).data as Row;
    assert.equal(data.wallet_count, 0);
    assert.deepEqual(data.wallets, []);
  });
});

describe("GET /api/v1/subnets/{netuid}/owner-cut", () => {
  test("a netuid outside the u16 range is a 400", async () => {
    const res = await handleRequest(
      req("/api/v1/subnets/99999/owner-cut"),
      artifactEnv({}),
    );
    assert.equal(res.status, 400);
    assert.equal(((await jsonBody(res)).error as Row)?.code, "invalid_netuid");
  });

  test("prices the accrual and reports the disposition as UNRESOLVED", async () => {
    // The route does not read the stake streams, so every accrued alpha is
    // unresolved. Reporting `held-as-stake` from a read we did not perform is
    // the false negative #10485 exists to prevent.
    const res = await handleRequest(
      req("/api/v1/subnets/64/owner-cut"),
      artifactEnv({
        [ECONOMICS_PATH]: { subnets: [SN64_ECONOMICS] },
        [PARAMETERS_PATH]: { subnet_owner_cut_effective: OWNER_CUT_EFFECTIVE },
      }),
    );
    assert.equal(res.status, 200);
    const data = (await jsonBody(res)).data as Row;
    assert.equal(data.owner_coldkey, OWNER_COLD);
    const accrual = data.accrual as Row;
    assert.equal(accrual.owner_cut, OWNER_CUT_EFFECTIVE);
    assert.ok((accrual.alpha as number) > 0);
    const disposition = data.disposition as Row;
    assert.equal((disposition.buckets as Row)["held-as-stake"], null);
    assert.ok(((disposition.buckets as Row).unresolved as number) > 0);
    assert.equal(disposition.reconciles, false);
  });

  test("no parameters artifact nulls the accrual rather than assuming 18%", async () => {
    // The share is knowable but was not read here. Substituting the runtime
    // default would make an unread value indistinguishable from a read one.
    const res = await handleRequest(
      req("/api/v1/subnets/64/owner-cut"),
      artifactEnv({ [ECONOMICS_PATH]: { subnets: [SN64_ECONOMICS] } }),
    );
    assert.equal(res.status, 200);
    const accrual = ((await jsonBody(res)).data as Row).accrual as Row;
    assert.equal(accrual.owner_cut, null);
    assert.equal(accrual.alpha, null);
    assert.match(String(accrual.reason), /owner cut share not read/);
  });

  test("a non-numeric owner cut is treated as unread, not coerced", async () => {
    const res = await handleRequest(
      req("/api/v1/subnets/64/owner-cut"),
      artifactEnv({
        [ECONOMICS_PATH]: { subnets: [SN64_ECONOMICS] },
        [PARAMETERS_PATH]: { subnet_owner_cut_effective: null },
      }),
    );
    assert.equal(res.status, 200);
    const accrual = ((await jsonBody(res)).data as Row).accrual as Row;
    assert.equal(accrual.owner_cut, null);
  });
});

describe("MCP get_subnet_wallets", () => {
  test("rejects a netuid outside the u16 range", async () => {
    await assert.rejects(
      () => tool("get_subnet_wallets").handler({ netuid: 70000 }, mcpCtx({})),
      /u16 range/,
    );
  });

  test("returns the owner keys plus the declared treasury with its evidence", async () => {
    const out = (await tool("get_subnet_wallets").handler(
      { netuid: 64 },
      mcpCtx({
        [ECONOMICS_PATH]: { subnets: [SN64_ECONOMICS] },
        [ENTITIES_PATH]: { entities: [DECLARED_TREASURY] },
      }),
    )) as Row;
    assert.equal(out.wallet_count, 3);
    const treasury = (out.wallets as Row[]).find((w) => w.ss58 === TREASURY);
    // The evidence travels WITH the attribution: an agent repeating this to
    // someone must be able to hand over the proof in the same breath.
    assert.deepEqual(treasury?.source_urls, ["https://example.org/treasury"]);
    assert.equal(treasury?.chain_derived, false);
  });

  test("no entities artifact answers with the owner keys, not an error", async () => {
    const out = (await tool("get_subnet_wallets").handler(
      { netuid: 64 },
      mcpCtx({ [ECONOMICS_PATH]: { subnets: [SN64_ECONOMICS] } }),
    )) as Row;
    assert.equal(out.wallet_count, 2);
    assert.ok(out.field_sources);
  });
});

describe("MCP get_subnet_owner_cut", () => {
  test("rejects a netuid outside the u16 range", async () => {
    await assert.rejects(
      () => tool("get_subnet_owner_cut").handler({ netuid: 70000 }, mcpCtx({})),
      /u16 range/,
    );
  });

  test("echoes the share and resolves the disposition to unresolved", async () => {
    const out = (await tool("get_subnet_owner_cut").handler(
      { netuid: 64 },
      mcpCtx({
        [ECONOMICS_PATH]: { subnets: [SN64_ECONOMICS] },
        [PARAMETERS_PATH]: { subnet_owner_cut_effective: OWNER_CUT_EFFECTIVE },
      }),
    )) as Row;
    assert.equal((out.accrual as Row).owner_cut, OWNER_CUT_EFFECTIVE);
    // No USD leg: the tool does not read TAO/USD, and a null price must not
    // become a zero-dollar accrual.
    assert.equal((out.accrual as Row).usd, null);
    assert.equal(((out.disposition as Row).buckets as Row).unstaked, null);
  });

  test("an unread share nulls the accrual rather than assuming the default", async () => {
    const out = (await tool("get_subnet_owner_cut").handler(
      { netuid: 64 },
      mcpCtx({ [ECONOMICS_PATH]: { subnets: [SN64_ECONOMICS] } }),
    )) as Row;
    assert.equal((out.accrual as Row).owner_cut, null);
    assert.equal((out.accrual as Row).alpha, null);
  });
});
