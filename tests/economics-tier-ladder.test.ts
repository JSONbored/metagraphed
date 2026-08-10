// REST and MCP read the economics blob off the SAME ladder (#10307).
//
// The cross-surface sweep found them answering different numbers for the same
// subnet, both stable across repeated calls:
//
//   GET /api/v1/subnets/64/validator-economics   tao_inflow_per_day 89.4820752
//   get_subnet_validator_economics {netuid: 64}  tao_inflow_per_day 91.0483919
//
// 1.7% apart. Not a moving window read at two instants -- two blobs refreshed
// on different cadences. `get_subnet_validator_economics` overrides the
// economics reader because MCP resolves artifacts through `ctx` rather than off
// `env`, a correct fix for #9229 that in making it dropped the LIVE rung and
// read the published artifact alone.
//
// WHAT THIS PINS is the property that makes the two agree: the ladder tries
// live-KV first and falls back to the artifact, and the artifact READER is the
// only part a caller supplies. A surface cannot acquire one tier and miss the
// other by overriding a loader, because the ORDER is not a thing it passes.
//
// Driving `resolveEconomicsBlob` directly rather than the two handlers: the
// handlers differ in a dozen ways that are not this, and a test that stood them
// up whole would pass or fail for reasons unrelated to which tier each read.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { resolveEconomicsBlob } from "../workers/request-handlers/entities.ts";
import { KV_ECONOMICS_CURRENT } from "../src/kv-keys.ts";
import { handleMcpRequest } from "../src/mcp-server.ts";
import type { Row } from "./row-type.ts";

/** A live blob that clears every gate `resolveLiveEconomics` applies. */
function liveBlob(taoInEmission: number): Row {
  return {
    captured_at: new Date().toISOString(),
    summary: { with_economics_count: 1 },
    subnets: [
      { netuid: 64, tao_in_emission_tao: taoInEmission, emission_share: 1 },
    ],
  };
}

/** An env whose KV holds `blob` under the economics key, or nothing. */
function envWith(blob: Row | null) {
  return {
    // `readHealthKv` calls `get(key, { type: "json" })`, so the double hands
    // back the parsed object rather than a string.
    METAGRAPH_CONTROL: {
      get: async (key: string) => (key === KV_ECONOMICS_CURRENT ? blob : null),
    },
  } as unknown as Parameters<typeof resolveEconomicsBlob>[0];
}

/** The live value, distinct from the artifact so the two are tellable apart. */
const LIVE_TAO_IN_EMISSION = 0.0124281;

const ARTIFACT: Row = {
  captured_at: new Date().toISOString(),
  subnets: [{ netuid: 64, tao_in_emission_tao: 0.0126456, emission_share: 1 }],
};

describe("the economics tier ladder is shared, not per-surface", () => {
  test("the live tier wins when it has rows", async () => {
    const blob = await resolveEconomicsBlob(
      envWith(liveBlob(0.0124281)),
      async () => ARTIFACT,
    );
    assert.equal(
      (blob?.subnets as Row[])[0].tao_in_emission_tao,
      0.0124281,
      "a live blob that passes every gate must outrank the published artifact",
    );
  });

  test("the artifact is the fallback, not the first choice", async () => {
    const blob = await resolveEconomicsBlob(
      envWith(null),
      async () => ARTIFACT,
    );
    assert.equal((blob?.subnets as Row[])[0].tao_in_emission_tao, 0.0126456);
  });

  test("both readers reach the same blob for the same env", async () => {
    // The two surfaces differ ONLY in how they read the artifact. Given a live
    // tier, that difference must not be observable -- which is exactly what
    // #10307 was: the MCP reader was consulted where REST's never would be.
    const env = envWith(liveBlob(0.0124281));
    const viaWorkerReader = await resolveEconomicsBlob(
      env,
      async () => ARTIFACT,
    );
    const viaCtxReader = await resolveEconomicsBlob(env, async () => {
      throw new Error("a ctx read must not happen while the live tier answers");
    });
    assert.deepEqual(viaCtxReader, viaWorkerReader);
  });

  test("neither tier answering is null, not an empty blob", async () => {
    // A schema-stable empty object here would read as "this subnet has no
    // economics" rather than "we could not read them" -- the #9803 shape.
    assert.equal(
      await resolveEconomicsBlob(envWith(null), async () => null),
      null,
    );
  });
});

describe("the MCP tool climbs that ladder, not a private one", () => {
  // THE regression test. The three above prove the ladder is correct; this one
  // proves `get_subnet_validator_economics` is on it, which is the half #10307
  // was actually about -- the tool had a working ladder available and read
  // around it. Without this, reverting the tool to its private artifact read
  // leaves every assertion above green.
  test("a live economics blob reaches get_subnet_validator_economics", async () => {
    const response = await handleMcpRequest(
      new Request("https://api.metagraph.sh/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "get_subnet_validator_economics",
            arguments: { netuid: 64 },
          },
        }),
      }),
      envWith(liveBlob(LIVE_TAO_IN_EMISSION)) as Parameters<
        typeof handleMcpRequest
      >[1],
    );
    const body = (await response.json()) as Row;
    const card = (body?.result as Row)?.structuredContent as Row;
    // `tao_inflow_per_day` is `tao_in_emission_tao * BLOCKS_PER_DAY`, and the
    // 7200 is not restated here -- the point is that the number came from the
    // LIVE blob rather than any artifact, which only the live value can show.
    assert.equal(
      card?.tao_inflow_per_day,
      LIVE_TAO_IN_EMISSION * 7200,
      "the tool must read the live tier before the published artifact",
    );
  });
});
