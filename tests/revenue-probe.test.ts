// #10444: the lane's three rules, each tested in the direction that fails
// silently — probing something unreadable, turning a broken fetch into a zero,
// and losing the bytes a figure came from.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  READABLE_PROVENANCES,
  SCALAR_PERIOD,
  probeEligibility,
  runRevenueProbe,
  type ProbeSurfaceInput,
} from "../src/revenue-probe.ts";

const CHUTES: ProbeSurfaceInput = {
  id: "sn-64-chutes-daily-revenue-summary",
  netuid: 64,
  url: "https://api.chutes.ai/daily_revenue_summary",
  auth_required: false,
  probe: { enabled: true },
  revenue: {
    role: "external-revenue",
    provenance: "probe-derived",
    currency: "USD",
    grain: "daily",
    shape: "flat-array",
    fields: { date: "date", amount: "total_revenue" },
    excludes: ["sponsored_inference", "pending_instance_revenue"],
  },
};
const ROW = {
  date: "2026-08-08",
  total_revenue: 9776.059599572032,
  sponsored_inference: 0,
  pending_instance_revenue: 610.8139253575,
};
const NET =
  ROW.total_revenue - ROW.sponsored_inference - ROW.pending_instance_revenue;

function deps(payload: unknown, raw = "RAW") {
  return {
    fetchPayload: async () => ({ payload, raw }),
    hash: () => "sha256:deadbeef",
    now: () => 1_786_400_000_000,
  };
}

describe("probeEligibility", () => {
  test("a readable external-revenue surface is eligible", () => {
    assert.deepEqual(probeEligibility(CHUTES), { eligible: true });
    for (const provenance of READABLE_PROVENANCES) {
      const s = { ...CHUTES, revenue: { ...CHUTES.revenue!, provenance } };
      assert.equal(probeEligibility(s).eligible, true, provenance);
    }
  });

  test("unreadable provenance is skipped, not attempted", () => {
    // Probing an operator-attested surface returns a 401 body, which a careless
    // extractor could turn into a number.
    for (const provenance of [
      "operator-attested",
      "third-party-reported",
      "none",
    ]) {
      const s = { ...CHUTES, revenue: { ...CHUTES.revenue!, provenance } };
      const r = probeEligibility(s);
      assert.equal(r.eligible, false, provenance);
      assert.match(r.eligible ? "" : r.reason, /not readable/);
    }
  });

  test("a non-revenue role is skipped", () => {
    for (const role of ["usage-proxy", "miner-payout", "not-revenue"]) {
      const s = { ...CHUTES, revenue: { ...CHUTES.revenue!, role } };
      assert.equal(probeEligibility(s).eligible, false, role);
    }
    assert.match(
      probeEligibility({ ...CHUTES, revenue: undefined }).eligible
        ? ""
        : (
            probeEligibility({ ...CHUTES, revenue: undefined }) as {
              reason: string;
            }
          ).reason,
      /no revenue declaration/,
    );
  });

  test("an unset role or provenance is named rather than rendered blank", () => {
    // A declaration can reach the lane half-built. The reason string is what an
    // operator reads in the skip list, so "role is unset" has to beat
    // "role is undefined" and an empty provenance must not render as
    // "provenance  is not readable".
    const noRole = probeEligibility({
      ...CHUTES,
      revenue: { currency: "USD" },
    }) as { reason: string };
    assert.match(noRole.reason, /role is unset/);

    const noProv = probeEligibility({
      ...CHUTES,
      revenue: { role: "external-revenue", currency: "USD" },
    }) as { reason: string };
    assert.match(noProv.reason, /provenance unset is not readable/);
  });

  test("auth-gated and unprobed surfaces are refused even if declared readable", () => {
    // The registry gate should make these unreachable; the lane must not fetch
    // an auth-gated URL on the strength of a declaration that slipped through.
    assert.match(
      (
        probeEligibility({ ...CHUTES, auth_required: true }) as {
          reason: string;
        }
      ).reason,
      /auth_required/,
    );
    assert.match(
      (
        probeEligibility({ ...CHUTES, probe: { enabled: false } }) as {
          reason: string;
        }
      ).reason,
      /probe\.enabled/,
    );
    assert.match(
      (probeEligibility({ ...CHUTES, probe: undefined }) as { reason: string })
        .reason,
      /probe\.enabled/,
    );
  });
});

describe("runRevenueProbe", () => {
  test("extracts a net observation and stamps it with the response hash", async () => {
    const r = await runRevenueProbe([CHUTES], deps([ROW]));
    assert.equal(r.observations.length, 1);
    const [o] = r.observations;
    assert.equal(o.surface_id, CHUTES.id);
    assert.equal(o.netuid, 64);
    assert.equal(o.period, "2026-08-08");
    assert.equal(o.grain, "daily");
    assert.ok(Math.abs(o.amount - NET) < 1e-9);
    assert.equal(o.currency, "USD");
    assert.equal(o.provenance, "probe-derived");
    assert.equal(o.response_hash, "sha256:deadbeef");
    assert.equal(o.observed_at, 1_786_400_000_000);
    assert.deepEqual(r.failures, []);
  });

  test("a thrown fetch becomes a failure row, never a zero observation", async () => {
    const r = await runRevenueProbe([CHUTES], {
      ...deps(null),
      fetchPayload: async () => {
        throw new Error("ECONNRESET");
      },
    });
    assert.deepEqual(r.observations, []);
    assert.equal(r.failures.length, 1);
    assert.match(r.failures[0].reason, /fetch failed: ECONNRESET/);
    assert.equal(r.failures[0].netuid, 64);
  });

  test("an unextractable payload becomes a failure carrying the reason", async () => {
    // The feed answered, but with something the declaration cannot read — a
    // silent 0 here would be indistinguishable from a subnet earning nothing.
    const r = await runRevenueProbe([CHUTES], deps({ oops: true }));
    assert.deepEqual(r.observations, []);
    assert.match(r.failures[0].reason, /expected an array/);
  });

  test("a genuine zero IS stored, because it is a measurement", async () => {
    const zero = { ...ROW, total_revenue: 0, pending_instance_revenue: 0 };
    const r = await runRevenueProbe([CHUTES], deps([zero]));
    assert.equal(r.observations.length, 1);
    assert.equal(r.observations[0].amount, 0);
    assert.deepEqual(r.failures, []);
  });

  test("a scalar total is stored under the sentinel period", async () => {
    const scalar: ProbeSurfaceInput = {
      ...CHUTES,
      id: "sn-64-chutes-tao-payment-totals-api",
      revenue: {
        role: "external-revenue",
        provenance: "probe-derived",
        currency: "USD",
        grain: "cumulative",
        shape: "scalar",
        fields: { amount: "total" },
      },
    };
    const r = await runRevenueProbe([scalar], deps({ total: 2322291.89 }));
    assert.equal(r.observations[0].period, SCALAR_PERIOD);
    assert.equal(r.observations[0].grain, "cumulative");
  });

  test("mixed grain in one pass keeps each surface's own", async () => {
    // SN51 is monthly where SN64 is daily; a lane that assumed one would
    // mislabel the other's periods.
    const lium: ProbeSurfaceInput = {
      id: "sn-51-lium-revenue-for-validators",
      netuid: 51,
      url: "https://lium.io/api/billing/revenue-for-validators",
      auth_required: false,
      probe: { enabled: true },
      revenue: {
        role: "external-revenue",
        provenance: "probe-derived",
        currency: "USD",
        grain: "monthly",
        shape: "keyed-map",
      },
    };
    let call = 0;
    const r = await runRevenueProbe([CHUTES, lium], {
      hash: () => "h",
      now: () => 1_786_400_000_000,
      fetchPayload: async () => {
        call += 1;
        return call === 1
          ? { payload: [ROW], raw: "a" }
          : { payload: { "2026-07": { v1: 604678.83 } }, raw: "b" };
      },
    });
    const grains = Object.fromEntries(
      r.observations.map((o) => [o.netuid, o.grain]),
    );
    assert.deepEqual(grains, { 64: "daily", 51: "monthly" });
  });

  test("skips are reported, not silently omitted", async () => {
    // A lane that quietly probes nothing looks identical to one whose every
    // surface passed.
    const gated: ProbeSurfaceInput = {
      ...CHUTES,
      id: "gated",
      auth_required: true,
      revenue: { ...CHUTES.revenue!, provenance: "operator-attested" },
    };
    const r = await runRevenueProbe([gated], deps([ROW]));
    assert.deepEqual(r.observations, []);
    assert.deepEqual(r.failures, []);
    assert.equal(r.skipped.length, 1);
    assert.equal(r.skipped[0].surface_id, "gated");
  });

  test("one broken surface does not abort the pass", async () => {
    let call = 0;
    const r = await runRevenueProbe(
      [
        { ...CHUTES, id: "a" },
        { ...CHUTES, id: "b" },
      ],
      {
        hash: () => "h",
        now: () => 1_786_400_000_000,
        fetchPayload: async () => {
          call += 1;
          if (call === 1) throw new Error("boom");
          return { payload: [ROW], raw: "ok" };
        },
      },
    );
    assert.equal(r.failures.length, 1);
    assert.equal(r.observations.length, 1);
    assert.equal(r.observations[0].surface_id, "b");
  });

  test("a non-Error throw still yields a readable reason", async () => {
    // fetch implementations reject with strings and objects too; String(error)
    // is what stops the failure row reading "fetch failed: [object Object]".
    const r = await runRevenueProbe([CHUTES], {
      ...deps(null),
      fetchPayload: async () => {
        throw "socket hang up";
      },
    });
    assert.match(r.failures[0].reason, /fetch failed: socket hang up/);
  });

  test("a surface with no declared grain falls back to cumulative", async () => {
    const noGrain: ProbeSurfaceInput = {
      ...CHUTES,
      revenue: {
        role: "external-revenue",
        provenance: "probe-derived",
        currency: "USD",
        shape: "flat-array",
        fields: { date: "date", amount: "total_revenue" },
      },
    };
    const r = await runRevenueProbe([noGrain], deps([ROW]));
    assert.equal(r.observations[0].grain, "cumulative");
  });

  test("an async hash is awaited", async () => {
    const r = await runRevenueProbe([CHUTES], {
      ...deps([ROW]),
      hash: async () => "sha256:async",
    });
    assert.equal(r.observations[0].response_hash, "sha256:async");
  });
});
