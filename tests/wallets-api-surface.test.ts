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
//   - the emission store, whose current split's owner slot is the share
//     (MET-7385) -- unbound, unobserved or unreadable, the accrual is NULL
//     rather than silently 18%, which is the whole point of #10484.
//
// A test that only walked the happy path here would prove nothing: an empty
// entities artifact IS the production state.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { handleRequest } from "../workers/api.ts";
import { handleSubnetOwnerCut } from "../workers/request-handlers/entities.ts";
import { MCP_TOOLS } from "../src/mcp-server.ts";
import { RetainedHistoryUnavailableError } from "../src/retained-history-store.ts";
import { jsonBody, mockEnv, type Row } from "./row-type.ts";
import {
  DECLARED_OWNER_PARTS,
  DEFAULT_OWNER_PARTS,
  emissionStore,
} from "./helpers/emission-store.ts";

const ECONOMICS_PATH = "/metagraph/economics.json";
const ENTITIES_PATH = "/metagraph/entities.json";

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

/** The default split's owner slot: SubnetOwnerCut's 11796/65535, not 1/6. */
const OWNER_CUT_EFFECTIVE = 11796 / 65535;

/** SN64's emission store, bound: `ownerParts` in its current split's owner
 * slot, or no capture observed at all when null. The share is read from here
 * (MET-7385), so this is the seam a test drives it through. */
const share = (ownerParts: bigint | null) => ({
  SUBNET_EMISSION_STORE: emissionStore(
    ownerParts === null ? null : { 64: ownerParts },
  ),
});

type ArtifactMap = Record<string, unknown>;

/** An env whose artifact reads are exactly the map given -- anything else 404s,
 * which is what an unpublished artifact really does.
 *
 * BOTH bindings are stubbed on purpose: readArtifact picks a storage tier per
 * path, and an r2-tier artifact returns the R2 miss WITHOUT consulting ASSETS.
 * An ASSETS-only env would serve nothing for economics.json, which looks
 * exactly like "this subnet has no owner" and would let these tests pass while
 * proving nothing. */
function artifactEnv(
  artifacts: ArtifactMap,
  bindings: Record<string, unknown> = share(DEFAULT_OWNER_PARTS),
) {
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
    ...bindings,
  });
}

function req(path: string) {
  return new Request(`https://api.metagraph.sh${path}`);
}

/** An MCP context whose artifact reads are the map given. */
function mcpCtx(
  artifacts: ArtifactMap,
  ownerParts: bigint | null = DEFAULT_OWNER_PARTS,
) {
  return {
    env: mockEnv(share(ownerParts)),
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

  test("an UNAVAILABLE flow read leaves the accrual unresolved", async () => {
    // The route DOES read the stake streams now (#10930) -- but this env binds
    // no lakehouse, so the cold-tier read answers null and the disposition
    // stays unresolved. That is the correct answer for a read that could not
    // happen: reporting `held-as-stake` from a read we did not perform is the
    // false negative #10485 exists to prevent, and it must survive the streams
    // being wired.
    const res = await handleSubnetOwnerCut(
      req("/api/v1/subnets/64/owner-cut"),
      artifactEnv({ [ECONOMICS_PATH]: { subnets: [SN64_ECONOMICS] } }),
      64,
    );
    assert.equal(res.status, 200);
    const data = (await jsonBody(res)).data as Row;
    assert.equal(data.owner_coldkey, OWNER_COLD);
    const accrual = data.accrual as Row;
    assert.ok(
      Math.abs((accrual.owner_cut as number) - OWNER_CUT_EFFECTIVE) < 1e-3,
    );
    assert.ok((accrual.alpha as number) > 0);
    const disposition = data.disposition as Row;
    assert.equal((disposition.buckets as Row)["held-as-stake"], null);
    assert.ok(((disposition.buckets as Row).unresolved as number) > 0);
    assert.equal(disposition.reconciles, false);
  });

  test("A REAL FLOW READ POPULATES THE UNSTAKED BUCKET", async () => {
    // #10930's headline: the classifier has been complete since #10485 and was
    // handed nothing. `loadFlows` is injected, so the wiring is driven without
    // a lakehouse binding.
    const res = await handleSubnetOwnerCut(
      req("/api/v1/subnets/64/owner-cut"),
      artifactEnv({ [ECONOMICS_PATH]: { subnets: [SN64_ECONOMICS] } }),
      64,
      {
        loadFlows: async () =>
          ({
            data: null,
            generatedAt: null,
            rows: [
              { netuid: 64, event_kind: "StakeAdded", total_alpha: 900 },
              { netuid: 64, event_kind: "StakeRemoved", total_alpha: 250 },
              // Another subnet in the same read, which must not leak in.
              { netuid: 7, event_kind: "StakeRemoved", total_alpha: 5000 },
            ],
          }) as never,
      },
    );
    assert.equal(res.status, 200);
    const disposition = ((await jsonBody(res)).data as Row).disposition as Row;
    const buckets = disposition.buckets as Row;
    assert.equal(buckets.unstaked, 250, "netuid 7's 5000 must not appear");
    // Held is still unread on this surface, so the remainder is unresolved
    // rather than assumed -- a partial attribution is a real answer.
    assert.equal(buckets["held-as-stake"], null);
    assert.ok((buckets.unresolved as number) > 0);
    assert.equal(disposition.reconciles, false);
  });

  test("an owner who moved NOTHING reports a measured 0", async () => {
    // The distinction the payload has to carry: a read that returned no rows
    // for this subnet is a measurement, and it must not sit in `unresolved`
    // alongside a read that never happened.
    const res = await handleSubnetOwnerCut(
      req("/api/v1/subnets/64/owner-cut"),
      artifactEnv({ [ECONOMICS_PATH]: { subnets: [SN64_ECONOMICS] } }),
      64,
      {
        loadFlows: async () =>
          ({ data: null, generatedAt: null, rows: [] }) as never,
      },
    );
    const disposition = ((await jsonBody(res)).data as Row).disposition as Row;
    assert.equal(
      (disposition.buckets as Row).unstaked,
      0,
      "measured, not null",
    );
    const notes = (disposition.notes as string[]).join(" ");
    assert.equal(
      notes.includes("not read for this window"),
      false,
      "the streams WERE read; the note would contradict the payload",
    );
    assert.match(notes, /does NOT mean sold/i);
    assert.match(notes, /owner_coldkey only/);
  });

  test("accrues at the subnet's DECLARED share, not the network's 18%", async () => {
    // MET-7385: since runtime 497 each subnet's owner is paid its own split's
    // owner slot. A subnet declaring 33% accrued at 18% on this route, and one
    // declaring none accrued 18% it never received.
    const accrual = async (ownerParts: bigint) => {
      const res = await handleSubnetOwnerCut(
        req("/api/v1/subnets/64/owner-cut"),
        artifactEnv(
          { [ECONOMICS_PATH]: { subnets: [SN64_ECONOMICS] } },
          share(ownerParts),
        ),
        64,
      );
      assert.equal(res.status, 200);
      const data = (await jsonBody(res)).data as Row;
      assert.deepEqual((data.field_sources as Row)["accrual.owner_cut"], {
        kind: "measured",
        storage: "SubtensorModule.SubnetEmissionWeights",
      });
      return data.accrual as Row;
    };
    const fallback = await accrual(DEFAULT_OWNER_PARTS);
    assert.ok(
      Math.abs((fallback.owner_cut as number) - OWNER_CUT_EFFECTIVE) < 1e-9,
      `expected the default split's 18%, got ${fallback.owner_cut}`,
    );
    const declared = await accrual(DECLARED_OWNER_PARTS);
    assert.ok(Math.abs((declared.owner_cut as number) - 0.33) < 1e-9);
    // 1 alpha/block x 7200 x 30 days x 0.33, against the default's 18%.
    assert.ok(Math.abs((declared.alpha as number) - 7200 * 30 * 0.33) < 1e-3);
    assert.ok(
      Math.abs(
        (declared.alpha as number) / (fallback.alpha as number) -
          0.33 / OWNER_CUT_EFFECTIVE,
      ) < 1e-9,
    );
    const none = await accrual(0n);
    assert.equal(none.owner_cut, 0);
    assert.equal(none.alpha, 0);
  });

  test("a split that is not observed nulls the accrual, never assumes 18%", async () => {
    // A store bound before its first capture, and no store at all: neither is
    // a share, and assuming the default would make an unread share
    // indistinguishable from a declared one.
    for (const bindings of [share(null), {}]) {
      const res = await handleSubnetOwnerCut(
        req("/api/v1/subnets/64/owner-cut"),
        artifactEnv(
          { [ECONOMICS_PATH]: { subnets: [SN64_ECONOMICS] } },
          bindings,
        ),
        64,
      );
      assert.equal(res.status, 200);
      const accrual = ((await jsonBody(res)).data as Row).accrual as Row;
      assert.equal(accrual.owner_cut, null);
      assert.equal(accrual.alpha, null);
      assert.match(String(accrual.reason), /owner cut share not read/);
    }
  });

  test("an unanswerable retained flow read is the unread decline, not a 503", async () => {
    // The fleet's shape on 2026-11-28: a retained owner is configured
    // (NATIVE_PROJECTIONS enabled) and cannot answer the stake streams, so
    // the read raised history_unavailable and the router served the WHOLE
    // route as a 503, the accrual included. The disposition already has the
    // answer for streams it could not read.
    const res = await handleRequest(
      req("/api/v1/subnets/64/owner-cut"),
      artifactEnv(
        { [ECONOMICS_PATH]: { subnets: [SN64_ECONOMICS] } },
        { ...share(DEFAULT_OWNER_PARTS), NATIVE_PROJECTIONS: "enabled" },
      ),
    );
    assert.equal(res.status, 200);
    const data = (await jsonBody(res)).data as Row;
    assert.ok(
      Math.abs(
        ((data.accrual as Row).owner_cut as number) - OWNER_CUT_EFFECTIVE,
      ) < 1e-9,
    );
    const disposition = data.disposition as Row;
    assert.equal((disposition.buckets as Row).unstaked, null);
    assert.ok(((disposition.buckets as Row).unresolved as number) > 0);
    assert.match((disposition.notes as string[]).join(" "), /not read/);
  });

  test("any other flow-read failure still fails the route", async () => {
    // The decline is for an unanswerable retained read alone: a defect in
    // the read must not become a quiet `unresolved`.
    await assert.rejects(
      () =>
        handleSubnetOwnerCut(
          req("/api/v1/subnets/64/owner-cut"),
          artifactEnv({ [ECONOMICS_PATH]: { subnets: [SN64_ECONOMICS] } }),
          64,
          {
            loadFlows: async () => {
              throw new Error("flow read defect");
            },
          },
        ),
      /flow read defect/,
    );
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
      mcpCtx({ [ECONOMICS_PATH]: { subnets: [SN64_ECONOMICS] } }),
    )) as Row;
    assert.ok(
      Math.abs(
        ((out.accrual as Row).owner_cut as number) - OWNER_CUT_EFFECTIVE,
      ) < 1e-3,
    );
    // No USD leg: the tool does not read TAO/USD, and a null price must not
    // become a zero-dollar accrual.
    assert.equal((out.accrual as Row).usd, null);
    assert.equal(((out.disposition as Row).buckets as Row).unstaked, null);
  });

  test("THE MCP TOOL READS THE SAME FLOWS AS REST", async () => {
    // #10930's deliverable: not a REST-only disposition. Same cold-tier
    // function, same window, same classifier -- so an agent and a browser
    // cannot disagree about whether a subnet's owner has moved anything.
    const out = (await tool("get_subnet_owner_cut").handler({ netuid: 64 }, {
      ...(mcpCtx({
        [ECONOMICS_PATH]: { subnets: [SN64_ECONOMICS] },
      }) as object),
      loadStakeFlow: async () => ({
        data: null,
        generatedAt: null,
        rows: [
          { netuid: 64, event_kind: "StakeRemoved", total_alpha: 250 },
          { netuid: 7, event_kind: "StakeRemoved", total_alpha: 5000 },
        ],
      }),
    } as never)) as Row;
    const disposition = out.disposition as Row;
    assert.equal(
      (disposition.buckets as Row).unstaked,
      250,
      "netuid 7's rows must not leak into this subnet",
    );
    const notes = (disposition.notes as string[]).join(" ");
    assert.match(notes, /does NOT mean sold/i);
    assert.equal(notes.includes("not read for this window"), false);
  });

  test("reads the subnet's declared share, as REST does", async () => {
    const out = (await tool("get_subnet_owner_cut").handler(
      { netuid: 64 },
      mcpCtx(
        { [ECONOMICS_PATH]: { subnets: [SN64_ECONOMICS] } },
        DECLARED_OWNER_PARTS,
      ),
    )) as Row;
    const accrual = out.accrual as Row;
    assert.ok(Math.abs((accrual.owner_cut as number) - 0.33) < 1e-9);
    assert.ok(Math.abs((accrual.alpha as number) - 7200 * 30 * 0.33) < 1e-3);
  });

  test("an unanswerable retained flow read leaves the streams unread", async () => {
    const out = (await tool("get_subnet_owner_cut").handler({ netuid: 64 }, {
      ...(mcpCtx({
        [ECONOMICS_PATH]: { subnets: [SN64_ECONOMICS] },
      }) as object),
      loadStakeFlow: async () => {
        throw new RetainedHistoryUnavailableError();
      },
    } as never)) as Row;
    assert.ok((out.accrual as Row).alpha as number);
    const disposition = out.disposition as Row;
    assert.equal((disposition.buckets as Row).unstaked, null);
    assert.match((disposition.notes as string[]).join(" "), /not read/);
  });
});

// ── no store bound ──────────────────────────────────────────────────────────
//
// Both surfaces read the share from the bound emission store, and a
// deployment without one has no share: the accrual is null, NOT the 18%
// runtime default. "The default split" and "we could not read the split" are
// different answers.
describe("with no emission store bound", () => {
  test("the REST handler nulls the share", async () => {
    const res = await handleSubnetOwnerCut(
      req("/api/v1/subnets/64/owner-cut"),
      artifactEnv({ [ECONOMICS_PATH]: { subnets: [SN64_ECONOMICS] } }, {}),
      64,
    );
    assert.equal(res.status, 200);
    const accrual = ((await jsonBody(res)).data as Row).accrual as Row;
    assert.equal(accrual.owner_cut, null);
    assert.equal(accrual.alpha, null);
    assert.match(String(accrual.reason), /owner cut share not read/);
  });

  test("the MCP tool nulls it too", async () => {
    const out = (await tool("get_subnet_owner_cut").handler({ netuid: 64 }, {
      env: {},
      readArtifact: async () => ({ ok: false, status: 404 }),
    } as never)) as Row;
    assert.equal((out.accrual as Row).owner_cut, null);
  });
});
