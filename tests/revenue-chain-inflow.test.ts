// #10445: four rules, each of which was a wrong answer before it was a rule.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { aggregateChainInflow } from "../src/revenue-chain-inflow.ts";
import { subnetAccountSs58 } from "../src/subnet-accounts.ts";

const COLLECTOR = "5FRYKhbmfXPDoHdUUDMx27E3HuMvAzwjzFMMq3rNurUhAyS9";
const PAYER = "5DJJAZLqnR3P4Um1UFuuZQ9DFVqoGwmeDXvcZDVPhH5V9NUY";

function transfer(
  over: Partial<
    Parameters<typeof aggregateChainInflow>[0]["transfers"][0]
  > = {},
) {
  return {
    to: COLLECTOR,
    from: PAYER,
    amount_tao: 0.05,
    block_number: 8813462,
    observed_at: 1_786_400_000_000,
    ...over,
  };
}

function run(over: Partial<Parameters<typeof aggregateChainInflow>[0]> = {}) {
  return aggregateChainInflow({
    collectors: [COLLECTOR],
    netuid: 64,
    transfers: [transfer()],
    usdAtInstant: () => 204.03,
    ...over,
  });
}

describe("inbound only", () => {
  test("sums inbound to a declared collector", () => {
    const r = run({ transfers: [transfer(), transfer({ amount_tao: 0.1 })] });
    assert.ok(Math.abs(r.tao - 0.15) < 1e-9);
    assert.equal(r.transfer_count, 2);
    assert.ok(Math.abs((r.usd as number) - 0.15 * 204.03) < 1e-4);
  });

  test("outbound is excluded and NAMED, never netted", () => {
    // Netting would let a subnet reduce its own reported revenue by moving its
    // money out of the collector.
    const r = run({
      transfers: [
        transfer(),
        transfer({ to: PAYER, from: COLLECTOR, amount_tao: 5 }),
      ],
    });
    assert.ok(Math.abs(r.tao - 0.05) < 1e-9, "outbound must not be subtracted");
    assert.equal(r.transfer_count, 1);
    const out = r.excluded.find((e) => e.reason.includes("outbound"));
    assert.equal(out?.count, 1);
    assert.equal(out?.tao, 5);
  });

  test("a transfer to an unrelated address is ignored entirely", () => {
    const r = run({ transfers: [transfer({ to: "5Unrelated" })] });
    assert.equal(r.tao, 0);
    assert.equal(r.transfer_count, 0);
    assert.deepEqual(r.excluded, []);
  });
});

describe("protocol accounts are refused", () => {
  test("a subnet's own TAO reserve cannot be a collector", () => {
    // The exact address #10448 nearly recorded as a Chutes revenue collector.
    const pool = subnetAccountSs58(64) as string;
    const r = run({
      collectors: [pool],
      transfers: [transfer({ to: pool, amount_tao: 105 })],
    });
    assert.equal(r.tao, 0, "no inflow may be counted for a rejected collector");
    assert.equal(r.rejected_collectors.length, 1);
    assert.match(r.rejected_collectors[0].reason, /netuid 64/);
    assert.match(r.rejected_collectors[0].reason, /capital flow, not revenue/);
  });

  test("rejecting one collector does not reject the others", () => {
    const pool = subnetAccountSs58(64) as string;
    const r = run({
      collectors: [pool, COLLECTOR],
      transfers: [transfer(), transfer({ to: pool, amount_tao: 105 })],
    });
    assert.ok(Math.abs(r.tao - 0.05) < 1e-9);
    assert.equal(r.rejected_collectors.length, 1);
  });
});

describe("pricing at the instant", () => {
  test("each transfer is priced at its own moment, not a window average", () => {
    // Two transfers of equal size at different prices must not both take the
    // later rate.
    const rates: Record<number, number> = {
      1000000000000: 100,
      2000000000000: 300,
    };
    const r = run({
      transfers: [
        transfer({ observed_at: 1000000000000, amount_tao: 1 }),
        transfer({ observed_at: 2000000000000, amount_tao: 1 }),
      ],
      usdAtInstant: (at) => rates[at] ?? null,
    });
    assert.equal(r.tao, 2);
    assert.equal(r.usd, 400); // 1*100 + 1*300, not 2*300 or 2*100
  });

  test("an unpriceable total is null, not zero", () => {
    const r = run({ usdAtInstant: () => null });
    assert.ok(r.tao > 0, "the TAO total is still real");
    assert.equal(r.usd, null);
  });

  test("partial pricing reports what it could price", () => {
    const r = run({
      transfers: [
        transfer({ observed_at: 1, amount_tao: 1 }),
        transfer({ observed_at: 2, amount_tao: 1 }),
      ],
      usdAtInstant: (at) => (at === 1 ? 100 : null),
    });
    assert.equal(r.tao, 2);
    assert.equal(r.usd, 100);
    assert.equal(r.transfer_count, 2, "the gap is visible from transfer_count");
  });

  test("a non-finite rate is treated as unpriced, not as NaN", () => {
    const r = run({ usdAtInstant: () => Number.NaN });
    assert.equal(r.usd, null);
  });
});

describe("alpha is classified, not summed", () => {
  test("an alpha-denominated inflow is excluded as circular", () => {
    const r = run({
      transfers: [transfer(), transfer({ amount_tao: 99, alpha_netuid: 64 })],
    });
    assert.ok(Math.abs(r.tao - 0.05) < 1e-9);
    const alpha = r.excluded.find((e) => e.reason.includes("circular"));
    assert.equal(alpha?.count, 1);
    assert.equal(alpha?.tao, 99);
  });

  test("a null alpha_netuid is a TAO transfer, not an alpha one", () => {
    const r = run({ transfers: [transfer({ alpha_netuid: null })] });
    assert.ok(Math.abs(r.tao - 0.05) < 1e-9);
    assert.deepEqual(r.excluded, []);
  });
});

describe("degenerate amounts", () => {
  test("zero, negative and non-finite amounts are excluded with a reason", () => {
    const r = run({
      transfers: [
        transfer(),
        transfer({ amount_tao: 0 }),
        transfer({ amount_tao: -1 }),
        transfer({ amount_tao: Number.NaN }),
      ],
    });
    assert.ok(Math.abs(r.tao - 0.05) < 1e-9);
    assert.equal(r.transfer_count, 1);
    const bad = r.excluded.find((e) => e.reason.includes("non-positive"));
    assert.equal(bad?.count, 3);
  });

  test("an empty window is a real zero with a null price", () => {
    const r = run({ transfers: [] });
    assert.equal(r.tao, 0);
    assert.equal(r.usd, null);
    assert.equal(r.transfer_count, 0);
    assert.equal(r.netuid, 64);
  });
});
