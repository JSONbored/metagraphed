// Keep the real quote/runtime/codec path; only the chain transport is synthetic.
vi.mock("../src/runtime-stake-quote.ts", async () => {
  const actual = await vi.importActual<typeof import("../src/runtime-stake-quote.ts")>("../src/runtime-stake-quote.ts");
  const { readRuntimeStakeFixture } = await import("./fixtures/runtime-stake-quote.ts");
  return { ...actual, buildRuntimeStakeQuote: (netuid: number, amount: unknown, direction: string) => actual.buildRuntimeStakeQuote(netuid, amount, direction, readRuntimeStakeFixture) };
});

// Handler + economics-resolver coverage for GET /api/v1/subnets/{netuid}/
// stake-quote (#5235), driven directly against the entities handler (api.ts
// pulls in a graphql-ws dep this env lacks). The pure slippage math is unit
// tested in stake-quote.test.ts; the api.ts route dispatch is exercised in
// api-coverage.test.ts.
import assert from "node:assert/strict";
import { describe, test, vi } from "vitest";
import { handleRequest } from "../workers/api.ts";
import { handleSubnetStakeQuote } from "../workers/request-handlers/entities.ts";
import type { Row } from "./row-type.ts";

const NETUID = 64;
const RESERVES = {
  tao_in_pool_tao: 201959.938748425,
  alpha_in_pool: 2730860.150574127,
};
const req = (path: string) => new Request(`https://api.metagraph.sh${path}`);
const url = (path: string) => new URL(`https://api.metagraph.sh${path}`);
const body = async (res: Response) => ({
  status: res.status,
  json: (await res.json()) as Row,
});

// A live-economics KV blob that passes resolveLiveEconomics' freshness +
// integrity gates (recent captured_at, emission_share summing to ~1).
function liveEconomicsEnv() {
  const blob = {
    captured_at: new Date().toISOString(),
    generated_at: "2026-07-14T00:00:00.000Z",
    subnets: [{ netuid: NETUID, ...RESERVES, emission_share: 1 }],
  };
  return { METAGRAPH_CONTROL: { get: async () => blob } };
}

// No live tier — force the committed-R2 economics.json fallback path instead.
function artifactEconomicsEnv() {
  const blob = {
    generated_at: "2026-07-14T00:00:00.000Z",
    subnets: [{ netuid: NETUID, ...RESERVES }],
  };
  const artifactBody = () => ({
    async json() {
      return blob;
    },
    async text() {
      return JSON.stringify(blob);
    },
  });
  return {
    METAGRAPH_ARCHIVE: { get: async () => artifactBody() },
    ASSETS: {
      async fetch() {
        return Response.json(blob);
      },
    },
    METAGRAPH_ALLOW_R2_STATIC_FALLBACK: "true",
  };
}

async function call(env: Row, path: string) {
  return body(
    await handleSubnetStakeQuote(
      req(path),
      env as unknown as Env,
      extractNetuid(path),
      url(path),
    ),
  );
}
function extractNetuid(path: string) {
  return Number(path.match(/\/subnets\/(\d+)\//)![1]);
}

describe("handleSubnetStakeQuote (#5235)", () => {
  test("reports the finalized source instead of claiming snapshot provenance", async () => {
    const { status, json } = await call({}, "/api/v1/subnets/64/stake-quote?amount=1");
    assert.equal(status, 200);
    assert.equal(json.meta.source, "chain-runtime");
    assert.equal(json.meta.native_source.runtime_spec_version, 470);
    assert.equal(json.meta.native_source.finalized_block, "500");
    assert.equal(json.data.tao_in_pool_tao, null);
    assert.equal(json.data.alpha_in_pool, null);
  });

  test("applies the existing native work limiter before simulation", async () => {
    const keys: string[] = [];
    const { status, json } = await call({ RPC_RATE_LIMITER: { limit: async ({ key }: { key: string }) => { keys.push(key); return { success: false }; } } }, "/api/v1/subnets/64/stake-quote?amount=1");
    assert.equal(status, 429);
    assert.equal(json.error.code, "stake_quote_rate_limited");
    assert.equal(keys.length, 1);
    assert.ok(keys[0]!.startsWith("native-runtime:"));
  });

  test("stake quote from finalized runtime: alpha out, positive impact", async () => {
    const { status, json } = await call(
      liveEconomicsEnv(),
      `/api/v1/subnets/${NETUID}/stake-quote?amount=1000&direction=stake`,
    );
    assert.equal(status, 200);
    assert.equal(json.data.direction, "stake");
    assert.equal(json.data.expected_out_unit, "alpha");
    assert.ok(json.data.expected_out > 0);
    assert.ok(json.data.price_impact_pct > 0);
    assert.equal(json.data.netuid, NETUID);
    assert.equal(json.data.is_root, false);
  });

  test("unstake quote from finalized runtime: tao out", async () => {
    const { status, json } = await call(
      artifactEconomicsEnv(),
      `/api/v1/subnets/${NETUID}/stake-quote?amount=50000&direction=unstake`,
    );
    assert.equal(status, 200);
    assert.equal(json.data.expected_out_unit, "tao");
    assert.ok(json.data.expected_out > 0);
  });

  test("direction defaults to stake when omitted", async () => {
    const { status, json } = await call(
      liveEconomicsEnv(),
      `/api/v1/subnets/${NETUID}/stake-quote?amount=1000`,
    );
    assert.equal(status, 200);
    assert.equal(json.data.direction, "stake");
  });

  test("root subnet (netuid 0) returns a 1:1 zero-impact quote with null reserves", async () => {
    const { status, json } = await call(
      {},
      `/api/v1/subnets/0/stake-quote?amount=5`,
    );
    assert.equal(status, 200);
    assert.equal(json.data.is_root, true);
    assert.equal(json.data.expected_out, 5);
    assert.equal(json.data.price_impact_pct, 0);
    assert.equal(json.data.tao_in_pool_tao, null);
  });

  test("empty runtime simulation → 422 insufficient_liquidity", async () => {
    const { status, json } = await call(
      {},
      `/api/v1/subnets/999/stake-quote?amount=1`,
    );
    assert.equal(status, 422);
    assert.equal(json.error.code, "insufficient_liquidity");
  });

  test("bad direction → 400 from the router's published enum", async () => {
    // `invalid_direction` was computeStakeQuote's own code, reached because the
    // handler forwarded whatever string arrived. The router parses `direction`
    // against the route's published enum first (#10060), so a caller now gets
    // the same 400 with the surface's uniform `invalid_query` code and the
    // parameter named -- and the builder's guard is unreachable from REST.
    const res = await handleRequest(
      new Request(
        `https://api.metagraph.sh/api/v1/subnets/${NETUID}/stake-quote?amount=1&direction=swap`,
      ),
      {} as never,
      {} as never,
    );
    assert.equal(res.status, 400);
    const json = (await res.json()) as Row;
    assert.equal(json.error.code, "invalid_query");
    assert.equal(json.meta.parameter, "direction");
  });

  test("zero amount → 400 invalid_amount", async () => {
    const { status, json } = await call(
      {},
      `/api/v1/subnets/${NETUID}/stake-quote?amount=0`,
    );
    assert.equal(status, 400);
    assert.equal(json.error.code, "invalid_amount");
  });
});
