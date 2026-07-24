// Handler + economics-resolver coverage for GET /api/v1/subnets/{netuid}/
// stake-quote (#5235), driven directly against the entities handler (api.ts
// pulls in a graphql-ws dep this env lacks). The pure slippage math is unit
// tested in stake-quote.test.mjs; the api.ts route dispatch is exercised in
// api-coverage.test.mjs.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
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
  test("stake quote from the live economics tier: alpha out, positive impact", async () => {
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

  test("unstake quote resolved from the committed economics.json fallback: tao out", async () => {
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

  test("no economics tier available → 422 insufficient_liquidity", async () => {
    const { status, json } = await call(
      {},
      `/api/v1/subnets/${NETUID}/stake-quote?amount=1`,
    );
    assert.equal(status, 422);
    assert.equal(json.error.code, "insufficient_liquidity");
  });

  test("unknown query param → 400", async () => {
    const { status } = await call(
      liveEconomicsEnv(),
      `/api/v1/subnets/${NETUID}/stake-quote?amount=1&foo=bar`,
    );
    assert.equal(status, 400);
  });

  test("bad direction → 400 invalid_direction", async () => {
    const { status, json } = await call(
      {},
      `/api/v1/subnets/${NETUID}/stake-quote?amount=1&direction=swap`,
    );
    assert.equal(status, 400);
    assert.equal(json.error.code, "invalid_direction");
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
