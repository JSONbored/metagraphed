// #10443/#10516: a gate asserted only against a clean registry passes on
// nothing. Every check here is driven over a crafted document that MUST be
// rejected, and the rejection is asserted to name the right reason -- then the
// live registry is checked separately to confirm it is currently clean.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  checkEntityRole,
  checkRevenueSearch,
  checkSurfaceRevenue,
  collectViolations,
} from "../scripts/validate-revenue-provenance.ts";
import { subnetAccountSs58 } from "../src/subnet-accounts.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

function subnetWith(surface: Row): Row {
  return {
    netuid: 64,
    slug: "sn-64",
    surfaces: [
      {
        id: "sn-64-example",
        auth_required: false,
        probe: { enabled: true },
        ...surface,
      },
    ],
  };
}

describe("revenue provenance validator (#10443/#10516)", () => {
  test("a surface with no revenue block is not the validator's business", () => {
    assert.deepEqual(checkSurfaceRevenue(subnetWith({})), []);
    assert.deepEqual(checkSurfaceRevenue({}), []);
    assert.deepEqual(checkSurfaceRevenue({ surfaces: "not-an-array" }), []);
  });

  test("probe-derived on an unprobed surface is rejected", () => {
    const v = checkSurfaceRevenue(
      subnetWith({
        probe: { enabled: false },
        revenue: {
          role: "external-revenue",
          provenance: "probe-derived",
          // #10566 requires USD on a headline-eligible declaration; declared
          // here so each test below asserts the ONE rule it is about.
          currency: "USD",
        },
      }),
    );
    assert.equal(v.length, 1);
    assert.match(v[0].message, /probe\.enabled/);
  });

  test("probe-derived with no probe block at all is rejected", () => {
    // The registry-wide gap tracked in #5932 — a surface can carry no probe
    // config, which is not the same as probe.enabled being false.
    const surface: Row = {
      revenue: {
        role: "external-revenue",
        provenance: "probe-derived",
        // #10566 requires USD on a headline-eligible declaration; declared
        // here so each test below asserts the ONE rule it is about.
        currency: "USD",
      },
    };
    delete surface.probe;
    const v = checkSurfaceRevenue({
      surfaces: [{ id: "x", auth_required: false, ...surface }],
    });
    assert.equal(v.length, 1);
    assert.match(v[0].message, /probe\.enabled/);
  });

  test("probe-derived over an auth-gated surface is rejected", () => {
    const v = checkSurfaceRevenue(
      subnetWith({
        auth_required: true,
        revenue: {
          role: "external-revenue",
          provenance: "probe-derived",
          // #10566 requires USD on a headline-eligible declaration; declared
          // here so each test below asserts the ONE rule it is about.
          currency: "USD",
        },
      }),
    );
    assert.equal(v.length, 1);
    assert.match(v[0].message, /auth_required/);
  });

  test("operator-attested with no source_url is rejected", () => {
    const v = checkSurfaceRevenue(
      subnetWith({
        revenue: { role: "external-revenue", provenance: "operator-attested" },
      }),
    );
    assert.equal(v.length, 1);
    assert.match(v[0].message, /source_url/);
  });

  test("operator-attested with a source_url passes", () => {
    assert.deepEqual(
      checkSurfaceRevenue(
        subnetWith({
          auth_required: true,
          probe: { enabled: false },
          revenue: {
            role: "external-revenue",
            provenance: "operator-attested",
            source_url: "https://example.com/revenue",
          },
        }),
      ),
      [],
    );
  });

  test("the real SN64 declaration passes", () => {
    assert.deepEqual(
      checkSurfaceRevenue(
        subnetWith({
          revenue: {
            role: "external-revenue",
            provenance: "probe-derived",
            currency: "USD",
            grain: "daily",
            fields: { date: "date", amount: "total_revenue" },
          },
        }),
      ),
      [],
    );
  });

  test("a headline-eligible declaration must be USD (#10566)", () => {
    // The serving layer sums amount_usd against a USD-priced denominator.
    // Converting TAO needs the rate at each observation's OWN instant, and
    // ALPHA is circular by construction. Refused at declaration rather than
    // filtered at read: a filtered surface reads back as "not observed", which
    // is indistinguishable from a probe that has not run.
    for (const [currency, provenance] of [
      ["TAO", "probe-derived"],
      ["ALPHA", "probe-derived"],
      ["TAO", "chain-verified"],
      [undefined, "probe-derived"],
    ] as const) {
      const v = checkSurfaceRevenue(
        subnetWith({
          revenue: {
            role: "external-revenue",
            provenance,
            ...(currency ? { currency } : {}),
          },
        }),
      );
      assert.equal(
        v.length,
        1,
        `currency=${currency} provenance=${provenance} should be rejected`,
      );
      assert.match(v[0].message, /currency/);
    }
  });

  test("a non-headline tier may be denominated in anything", () => {
    // operator-attested and third-party-reported never reach the sum, so the
    // unit does not have to be comparable — and refusing them would push a real
    // declaration out of the registry for no gain.
    for (const provenance of ["operator-attested", "third-party-reported"]) {
      assert.deepEqual(
        checkSurfaceRevenue(
          subnetWith({
            auth_required: true,
            probe: { enabled: false },
            revenue: {
              role: "external-revenue",
              provenance,
              currency: "TAO",
              source_url: "https://example.com/revenue",
            },
          }),
        ),
        [],
        provenance,
      );
    }
  });

  test("a non-revenue role is not held to the currency rule", () => {
    // usage-proxy and miner-payout are verdicts about what a surface measures,
    // not figures anything sums. SN4's payout is denominated in alpha and must
    // stay recordable.
    for (const role of ["usage-proxy", "miner-payout", "not-revenue"]) {
      assert.deepEqual(
        checkSurfaceRevenue(
          subnetWith({
            revenue: { role, provenance: "probe-derived", currency: "ALPHA" },
          }),
        ),
        [],
        role,
      );
    }
  });

  test("a protocol subnet account may not carry a money role", () => {
    // The exact address #10448 nearly recorded as a Chutes revenue collector.
    const pool = subnetAccountSs58(64) as string;
    for (const category of [
      "payment-collector",
      "treasury",
      "burn",
      "multisig",
    ]) {
      const v = checkEntityRole({ ss58: pool, category });
      assert.equal(v.length, 1, `${category} was not rejected`);
      assert.match(v[0].message, /netuid 64/);
    }
  });

  test("a protocol account may still carry a descriptive label", () => {
    // Naming it "SN64 Subnet Pool" is useful and true; claiming it is a
    // treasury is not. Only the money roles are refused.
    for (const category of ["pool", "infra", "other"]) {
      assert.deepEqual(
        checkEntityRole({ ss58: subnetAccountSs58(64), category }),
        [],
      );
    }
  });

  test("an ordinary address may carry a money role", () => {
    assert.deepEqual(
      checkEntityRole({
        ss58: "5FRYKhbmfXPDoHdUUDMx27E3HuMvAzwjzFMMq3rNurUhAyS9",
        category: "treasury",
      }),
      [],
    );
    assert.deepEqual(checkEntityRole({ category: "treasury" }), []);
    assert.deepEqual(checkEntityRole({}), []);
  });

  test("the live registry is currently clean", async () => {
    const violations = await collectViolations();
    assert.deepEqual(
      violations,
      [],
      violations
        .map((v) => `${v.file}: ${v.subject} — ${v.message}`)
        .join("\n"),
    );
  });
});

describe("revenue_search cross-check (#10543)", () => {
  function withSearch(outcome: string, revenueRole?: string): Row {
    const surface: Row = { id: "sn-64-x", auth_required: false };
    if (revenueRole) {
      surface.revenue = { role: revenueRole, provenance: "probe-derived" };
      surface.probe = { enabled: true };
    }
    return {
      netuid: 64,
      surfaces: [surface],
      revenue_search: {
        searched_at: "2026-08-10T00:00:00Z",
        outcome,
        checked: ["website", "docs"],
      },
    };
  }

  test("a subnet with no search record is not the validator's business", () => {
    assert.deepEqual(checkRevenueSearch({ netuid: 1, surfaces: [] }), []);
    assert.deepEqual(checkRevenueSearch({}), []);
  });

  test("none-found agrees with a subnet declaring no revenue", () => {
    assert.deepEqual(checkRevenueSearch(withSearch("none-found")), []);
    // A usage-proxy or miner-payout surface is not external revenue, so it
    // does not contradict none-found — that distinction is the whole point of
    // the role vocabulary.
    assert.deepEqual(
      checkRevenueSearch(withSearch("none-found", "miner-payout")),
      [],
    );
    assert.deepEqual(
      checkRevenueSearch(withSearch("none-found", "usage-proxy")),
      [],
    );
  });

  test("none-found is REJECTED once a surface declares external revenue", () => {
    // The stale-summary case: searched in March, revenue surface added in
    // August, and the subnet keeps asserting it has none.
    const v = checkRevenueSearch(withSearch("none-found", "external-revenue"));
    assert.equal(v.length, 1);
    assert.match(v[0].message, /none-found/);
    assert.match(v[0].message, /sn-64-x/);
  });

  test("surfaces-declared is REJECTED when nothing declares external revenue", () => {
    const v = checkRevenueSearch(withSearch("surfaces-declared"));
    assert.equal(v.length, 1);
    assert.match(v[0].message, /surfaces-declared/);
  });

  test("surfaces-declared agrees with a real declaration", () => {
    assert.deepEqual(
      checkRevenueSearch(withSearch("surfaces-declared", "external-revenue")),
      [],
    );
  });
});
