// #11001 backfill. handleExtrinsic's cache profile is not cosmetic any more:
// withChainDetailEdgeCache reads `x-metagraph-cache-profile` to decide what may
// be stored at the edge for an hour, so getting this wrong caches a moving
// answer rather than merely mis-advertising one. #11010 landed the ternary
// without covering either tier arm.
//
// The COLD arm is here (it needs only the R2 SQL stub, no module mock); the HOT
// arm is asserted in tests/chain-detail-serving.test.ts, which already owns the
// pg double that makes the live-follow window answer.
import assert from "node:assert/strict";
import { afterEach, describe, test } from "vitest";
import { handleExtrinsic } from "../workers/request-handlers/entities.ts";
import { R2_SQL_TOKEN_ENV } from "../src/r2-sql.ts";

const TOKEN = { [R2_SQL_TOKEN_ENV]: "cfut_test" };
const HASH = `0x${"ab".repeat(32)}`;
const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

/** Stubs the lakehouse so the cold tier answers; mirrors extrinsics-cold-tier.test.ts. */
function sqlFetch(...responses: unknown[][]) {
  let call = 0;
  globalThis.fetch = (async () => {
    const rows = responses[Math.min(call, responses.length - 1)] ?? [];
    call += 1;
    return {
      ok: true,
      status: 200,
      json: async () => ({ success: true, result: { rows } }),
    } as unknown as Response;
  }) as unknown as typeof fetch;
}

function extrinsicRow() {
  return {
    block_number: 8_281_545,
    extrinsic_index: 0,
    extrinsic_hash: HASH,
    signer: "5EYCAe5jLQhn6ofDSvqF6iY53erXNkwhyE1aCEgvi1NNs91F",
    call_module: "SubtensorModule",
    call_function: "set_weights",
    success: true,
    fee_tao: null,
    tip_tao: null,
    call_args: null,
    observed_at: 1_700_000_000_000,
  };
}

const req = () =>
  new Request(`https://api.metagraph.sh/api/v1/extrinsics/${HASH}`);

describe("extrinsic detail names the immutability its tier knows (#11001)", () => {
  test("a lakehouse answer is settled, so it takes the storable profile", async () => {
    sqlFetch([extrinsicRow()], []);
    const res = await handleExtrinsic(req(), TOKEN as never, HASH);
    assert.equal(res.status, 200);
    // The one assertion that matters: this is the header the edge cache reads.
    assert.equal(res.headers.get("x-metagraph-cache-profile"), "static");
  });

  test("an unresolved hash stays short — absence from a window proves nothing", async () => {
    // The schema-stable `extrinsic: null`, which a client must be able to
    // re-check rather than have pinned at the edge for an hour.
    sqlFetch([]);
    const res = await handleExtrinsic(req(), TOKEN as never, HASH);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("x-metagraph-cache-profile"), "short");
  });
});
