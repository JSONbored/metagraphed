// #10486: what moves through a declared wallet.
//
// The load-bearing rule is that TAO and alpha are never summed, and that two
// alpha figures are only comparable when they share a netuid. A single "value
// moved" field would be the unit trap this epic already catalogues -- a path
// named /tao returning USD -- except self-inflicted.
//
// The second is that this module never decides ownership. It is handed
// addresses somebody already proved, and reports what moved through them.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  aggregateDeclaredWallets,
  aggregateWalletActivity,
  type WalletFlowRow,
} from "../src/wallet-activity.ts";

const A = "5FRYKhbmfXPDoHdUUDMx27E3HuMvAzwjzFMMq3rNurUhAyS9";
const B = "5CS3g6nVJM6ouns8n9buN9CzFf2C1YDHVcVGRcxoirKs2xbV";

function row(over: Partial<WalletFlowRow> = {}): WalletFlowRow {
  return {
    address: A,
    denomination: "tao",
    direction: "in",
    amount: 10,
    observed_at: "2026-08-10T00:00:00Z",
    ...over,
  };
}

describe("denominations are never mixed", () => {
  test("TAO and alpha land on separate legs", () => {
    const r = aggregateWalletActivity(A, [
      row({ denomination: "tao", amount: 100 }),
      row({ denomination: "alpha", netuid: 64, amount: 5 }),
    ]);
    assert.equal(r.legs.length, 2);
    const tao = r.legs.find((l) => l.denomination === "tao");
    const alpha = r.legs.find((l) => l.denomination === "alpha");
    assert.equal(tao?.in, 100);
    assert.equal(alpha?.in, 5);
    // There is deliberately no total field to assert against.
    assert.ok(!Object.hasOwn(r, "total"));
  });

  test("alpha on two subnets stays on two legs", () => {
    // 1 alpha on SN64 and 1 alpha on SN51 are different values; summing them
    // would produce a number that means nothing.
    const r = aggregateWalletActivity(A, [
      row({ denomination: "alpha", netuid: 64, amount: 3 }),
      row({ denomination: "alpha", netuid: 51, amount: 7 }),
    ]);
    assert.equal(r.legs.length, 2);
    assert.deepEqual(
      r.legs.map((l) => [l.netuid, l.in]),
      [
        [51, 7],
        [64, 3],
      ],
    );
  });

  test("alpha with no netuid is skipped with a reason, not pooled", () => {
    // There is no single "alpha" bucket to add it to, so pooling it would be
    // the exact conflation this module refuses.
    const r = aggregateWalletActivity(A, [
      row({ denomination: "alpha", netuid: null, amount: 9 }),
    ]);
    assert.equal(r.legs.length, 0);
    assert.equal(r.event_count, 0);
    assert.match(r.skipped[0].reason, /no netuid/);
  });
});

describe("the arithmetic", () => {
  test("net is in minus out, and may be negative", () => {
    // More left than arrived is a real answer about a treasury, not an error.
    const r = aggregateWalletActivity(A, [
      row({ direction: "in", amount: 10 }),
      row({ direction: "out", amount: 25 }),
    ]);
    const tao = r.legs[0];
    assert.equal(tao.in, 10);
    assert.equal(tao.out, 25);
    assert.equal(tao.net, -15);
    assert.equal(tao.events, 2);
  });

  test("tracks the observed window bounds", () => {
    const r = aggregateWalletActivity(A, [
      row({ observed_at: "2026-08-05T00:00:00Z" }),
      row({ observed_at: "2026-08-09T00:00:00Z" }),
      row({ observed_at: null }),
    ]);
    assert.equal(r.first_observed_at, "2026-08-05T00:00:00Z");
    assert.equal(r.last_observed_at, "2026-08-09T00:00:00Z");
    assert.equal(r.event_count, 3, "a stampless row still counts as movement");
  });
});

describe("nothing is dropped silently", () => {
  test("a row for a different address is skipped, with a reason", () => {
    // Attribution belongs to the registry. A row that arrived here for the
    // wrong wallet must not quietly become this wallet's flow.
    const r = aggregateWalletActivity(A, [row({ address: B, amount: 999 })]);
    assert.equal(r.event_count, 0);
    assert.match(r.skipped[0].reason, /different address/);
  });

  test("unreadable rows are counted rather than discarded", () => {
    // A quietly-discarded movement makes a net figure look complete when it is
    // not.
    const r = aggregateWalletActivity(A, [
      row({ amount: null }),
      row({ amount: Number.NaN }),
      row({ amount: -1 }),
      row({ direction: "sideways" as never }),
      row({ denomination: "usd" as never }),
    ]);
    assert.equal(r.event_count, 0);
    const total = r.skipped.reduce((s, e) => s + e.count, 0);
    assert.equal(total, 5);
    assert.ok(r.skipped.some((e) => /amount not readable/.test(e.reason)));
    assert.ok(r.skipped.some((e) => /direction/.test(e.reason)));
    assert.ok(r.skipped.some((e) => /denomination/.test(e.reason)));
  });

  test("junk input yields an empty activity rather than throwing", () => {
    for (const rows of [null, undefined, [], "no" as unknown as []]) {
      const r = aggregateWalletActivity(A, rows as never);
      assert.equal(r.event_count, 0);
      assert.deepEqual(r.legs, []);
    }
  });
});

describe("the declared set", () => {
  const WALLETS = [
    { ss58: A, category: "treasury", netuid: 64, source_urls: ["https://x"] },
    { ss58: B, category: "burn", netuid: 64 },
    { ss58: "", category: "treasury" },
    // A non-string ss58 is not an address; it must not become one.
    { ss58: undefined as unknown as string, category: "treasury" },
  ];

  test("a declared wallet with no rows is INCLUDED, with empty legs", () => {
    // "We watched this address and nothing moved" is a finding. Dropping it
    // would make the set of ACTIVE wallets look like the set of DECLARED ones.
    const out = aggregateDeclaredWallets(
      WALLETS,
      new Map([[A, [row({ amount: 42 })]]]),
    );
    assert.equal(
      out.length,
      2,
      "the empty and non-string ss58 entries are skipped",
    );
    const burn = out.find((w) => w.ss58 === B);
    assert.ok(burn);
    assert.deepEqual(burn.activity.legs, []);
    assert.equal(burn.activity.event_count, 0);
  });

  test("the declared role and its evidence are carried through untouched", () => {
    // A consumer reading an attribution must be able to check it without a
    // second call -- and this module must never be the thing that decided it.
    const out = aggregateDeclaredWallets(WALLETS, new Map());
    const treasury = out.find((w) => w.ss58 === A);
    assert.equal(treasury?.category, "treasury");
    assert.deepEqual(treasury?.source_urls, ["https://x"]);
    assert.equal(treasury?.netuid, 64);
  });

  test("junk input yields no wallets rather than throwing", () => {
    for (const wallets of [null, undefined, [], "no" as unknown as []]) {
      assert.deepEqual(aggregateDeclaredWallets(wallets as never, null), []);
    }
  });
});
