import assert from "node:assert/strict";
import { test, vi } from "vitest";
import { buildRuntimeStakeQuote, stakeQuoteAtomic } from "../src/runtime-stake-quote.ts";
import { readRuntimeStakeFixture } from "./fixtures/runtime-stake-quote.ts";
import { SubnetStakeQuoteArtifactSchema } from "../schemas-src/routes/stake-quote.ts";

test("decimal and exponent amounts preserve whole atomic units without dust rounding", () => {
  assert.equal(stakeQuoteAtomic(1e-9), 1n);
  assert.equal(stakeQuoteAtomic(0.123456789), 123456789n);
  assert.equal(stakeQuoteAtomic(1e10), 10000000000000000000n);
  for (const value of [undefined, null, "1", Symbol("amount"), 0, -1, Infinity, NaN, 1e-10, 1.0000000001, 2e10])
    assert.equal(stakeQuoteAtomic(value), null);
});

test("both directions and Root use the finalized simulator and include input-token fees", async () => {
  for (const direction of ["stake", "unstake"]) for (const netuid of [0, 64]) {
    const read = vi.fn(readRuntimeStakeFixture);
    const result = await buildRuntimeStakeQuote(netuid, 1000, direction, read);
    assert.ok(result.ok);
    assert.equal(result.source.runtime_spec_version, 470);
    assert.equal(result.source.finalized_block, "500");
    assert.equal(result.quote.expected_out_unit, direction === "stake" ? "alpha" : "tao");
    assert.equal(result.quote.is_root, netuid === 0);
    assert.equal(result.quote.tao_in_pool_tao, null);
    assert.equal(result.quote.alpha_in_pool, null);
    assert.equal(result.quote.price_impact_pct === 0, netuid === 0);
    assert.ok(SubnetStakeQuoteArtifactSchema.safeParse({ schema_version: 1, ...result.quote }).success);
    assert.equal(read.mock.calls.length, 1);
    assert.deepEqual(read.mock.calls[0]![0].operations.map(row => row.member), ["current_alpha_price", direction === "stake" ? "sim_swap_tao_for_alpha" : "sim_swap_alpha_for_tao"]);
    if (direction === "stake") assert.equal(result.quote.effective_price_tao, 1000 / result.quote.expected_out);
    else assert.equal(result.quote.effective_price_tao, result.quote.expected_out / 1000);
  }
});

test("bad inputs are rejected before any chain work", async () => {
  const read = vi.fn(readRuntimeStakeFixture);
  for (const [netuid, amount, direction, code] of [
    [64, 1, "swap", "invalid_direction"], [64, 0, "stake", "invalid_amount"],
    [64, 1e-10, "unstake", "invalid_amount"], [-1, 1, "stake", "invalid_netuid"],
    [65536, 1, "stake", "invalid_netuid"], [1.5, 1, "stake", "invalid_netuid"],
  ] as const) {
    const result = await buildRuntimeStakeQuote(netuid, amount, direction, read);
    assert.ok(!result.ok); assert.equal(result.status, 400); assert.equal(result.code, code);
  }
  assert.equal(read.mock.calls.length, 0);
});

test("empty, partial, zero-price and zero-output simulations cannot produce a quote", async () => {
  for (const [field, value] of [["tao_amount", "1"], ["alpha_amount", "0"], ["price", "0"]]) {
    const result = await buildRuntimeStakeQuote(64, 1, "stake", async input => {
      const artifact = await readRuntimeStakeFixture(input);
      if (field === "price") artifact.results[0]!.value = value!;
      else artifact.results[1]!.value = { tao_amount: "999000000", alpha_amount: "400000000", tao_fee: "1000000", alpha_fee: "0", tao_slippage: "0", alpha_slippage: "0", [field!]: value! };
      return artifact;
    });
    assert.ok(!result.ok); assert.equal(result.status, 422);
  }
  const empty = await buildRuntimeStakeQuote(999, 1, "stake", readRuntimeStakeFixture);
  assert.ok(!empty.ok); assert.equal(empty.code, "insufficient_liquidity");
});

test("malformed or mismatched runtime responses and transport failures never fall back to an estimate", async () => {
  const changes = [
    (r: Awaited<ReturnType<typeof readRuntimeStakeFixture>>) => { r.results.length = 0; },
    ...[0, 1].flatMap(index => ["kind", "api", "member"].map(key => (r: Awaited<ReturnType<typeof readRuntimeStakeFixture>>) => { Object.assign(r.results[index]!, { [key]: "wrong" }); })),
    ...[null, [], "bad"].map(value => (r: Awaited<ReturnType<typeof readRuntimeStakeFixture>>) => { r.results[1]!.value = value; }),
    ...[1, "bad", "01", "-1", "18446744073709551616"].map(value => (r: Awaited<ReturnType<typeof readRuntimeStakeFixture>>) => { r.results[0]!.value = value; }),
    ...["tao_amount", "alpha_amount", "tao_fee", "alpha_fee", "tao_slippage", "alpha_slippage"].map(field => (r: Awaited<ReturnType<typeof readRuntimeStakeFixture>>) => {
      const previous = r.results[1]!.value;
      assert.ok(previous && typeof previous === "object" && !Array.isArray(previous));
      r.results[1]!.value = { ...previous, [field]: "bad" };
    }),
  ];
  for (const change of changes) {
    const result = await buildRuntimeStakeQuote(64, 1, "stake", async input => { const artifact = await readRuntimeStakeFixture(input); change(artifact); return artifact; });
    assert.ok(!result.ok); assert.equal(result.status, 502); assert.equal(result.code, "stake_quote_failed");
  }
  const failed = await buildRuntimeStakeQuote(64, 1, "stake", async () => { throw new Error("fixture transport unavailable"); });
  assert.ok(!failed.ok); assert.equal(failed.status, 502);
});
