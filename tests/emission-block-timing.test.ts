import assert from "node:assert/strict";
import { describe, test } from "vitest";
import fixture from "./fixtures/emission-block-timing.json" with { type: "json" };
import pipeline from "./fixtures/emission-pipeline.json" with { type: "json" };
import { checkEmissionDrift } from "../src/emission-drift-check.ts";

type CapturedBlock = (typeof fixture.blocks)[number];

function capturedFetch(
  block: CapturedBlock,
  usePostBlockInputs = false,
): typeof fetch {
  const names = new Map(
    Object.entries(pipeline.item_hashes).map(([name, hash]) => [hash, name]),
  );
  return async (_url, init) => {
    const { method, params } = JSON.parse(String(init?.body)) as {
      method: string;
      params: unknown[];
    };
    let result: unknown;
    if (method === "chain_getBlockHash") {
      assert.deepEqual(params, []);
      result = block.block_hash;
    } else if (method === "chain_getHeader") {
      assert.deepEqual(params, [block.block_hash]);
      result = {
        number: `0x${block.block_number.toString(16)}`,
        parentHash: block.parent_hash,
      };
    } else {
      const keys =
        method === "state_getStorage"
          ? [String(params[0])]
          : (params[0] as string[]);
      const key = keys[0];
      const name = names.get(
        key.slice(34, method === "state_getStorage" ? undefined : -4),
      )!;
      const isOutput = [
        "emission_gate_bar",
        "tao_in_emission",
        "excess_tao",
      ].includes(name);
      assert.equal(params[1], isOutput ? block.block_hash : block.parent_hash);
      const source =
        usePostBlockInputs && !isOutput ? fixture.post_block_inputs : block;
      if (method === "state_getStorage") {
        result = (source.values as Record<string, string | null>)[name];
      } else {
        assert.equal(method, "state_queryStorageAt");
        const map = (source.maps as Record<string, Record<string, string>>)[
          name
        ];
        result = [
          {
            changes: keys.map((k) => {
              const suffix = k.slice(-4);
              const netuid =
                parseInt(suffix.slice(0, 2), 16) +
                256 * parseInt(suffix.slice(2), 16);
              return [k, map[String(netuid)] ?? null];
            }),
          },
        ];
      }
    }
    return Response.json({ result });
  };
}

describe("emission inputs precede their block's outputs", () => {
  test.each(fixture.blocks)(
    "reconstructs captured block $block_number, including the gate boundary",
    async (block) => {
      const result = await checkEmissionDrift({
        rpcUrl: fixture.source,
        fetchImpl: capturedFetch(block),
      });
      assert.deepEqual(result.reasons, []);
      assert.equal(result.summary.identities_failed, 0);
      assert.ok(result.summary.max_share_error < 2e-8);
    },
  );

  test("reproduces the observed SN100 alarm with the old post-block inputs", async () => {
    const result = await checkEmissionDrift({
      rpcUrl: fixture.source,
      fetchImpl: capturedFetch(fixture.blocks[0], true),
    });
    assert.equal(result.summary.max_share_error_netuid, 100);
    assert.equal(result.summary.max_share_error.toExponential(3), "5.065e-4");
    assert.match(result.reasons.join(";"), /netuid 100 off by 5.065e-4/);
  });
});
