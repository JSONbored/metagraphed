// #10447: what the route does when a piece is missing, which is the normal
// case rather than the edge case.
import assert from "node:assert/strict";
import { beforeEach, describe, test } from "vitest";
import {
  SURFACES_MEMO_TTL_MS,
  groupSurfacesByNetuid,
  loadSubnetRevenue,
  resetSurfacesMemo,
  revenueSourcesFor,
  surfacesByNetuidMemoized,
  taoTotalPerBlock,
} from "../src/revenue-load.ts";

// The surfaces map is memoized per ISOLATE and the registry resets module state
// between test FILES, not between tests -- so without this a fixture from one
// case would answer the next one's read. Same reason
// tests/account-summary-projection.test.ts resets its pointer cache.
beforeEach(() => resetSurfacesMemo());

const ECONOMICS = {
  netuid: 64,
  tao_in_emission_tao: 0.012416161,
  excess_tao: 0.051199103,
  alpha_out_emission: 1,
  alpha_price_tao: 0.086933658,
};

const SURFACES = [
  {
    id: "sn-64-chutes-daily-revenue-summary",
    revenue: {
      role: "external-revenue",
      provenance: "probe-derived",
      currency: "USD",
      grain: "daily",
    },
  },
  {
    id: "sn-64-chutes-invocations-usage",
    revenue: { role: "usage-proxy", provenance: "probe-derived" },
  },
  {
    id: "sn-4-targon-miner-stats-api",
    revenue: { role: "miner-payout", provenance: "probe-derived" },
  },
  { id: "sn-64-chutes-models", name: "no revenue block" },
];

describe("taoTotalPerBlock", () => {
  test("sums the two emission channels", () => {
    assert.ok(Math.abs(taoTotalPerBlock(ECONOMICS) - 0.063615264) < 1e-9);
  });

  test("a missing channel contributes zero, not NaN", () => {
    assert.equal(taoTotalPerBlock({ tao_in_emission_tao: 1 }), 1);
    assert.equal(taoTotalPerBlock({ excess_tao: 2 }), 2);
    assert.equal(taoTotalPerBlock({}), 0);
    assert.equal(taoTotalPerBlock(null), 0);
    assert.equal(taoTotalPerBlock({ tao_in_emission_tao: "0.5" }), 0);
  });
});

describe("revenueSourcesFor", () => {
  test("only external-revenue declarations become sources", () => {
    // A response listing SN4's `payout` among its "sources" invites exactly the
    // reading the role vocabulary exists to prevent.
    const sources = revenueSourcesFor(SURFACES);
    assert.equal(sources.length, 1);
    assert.equal(sources[0].surface_id, "sn-64-chutes-daily-revenue-summary");
  });

  test("a declaration carries no figure of its own", () => {
    // #10565: this used to stamp one scalar amount per surface, which is the
    // shape that made a window unrepresentable — one number cannot answer
    // "the last 7 days" for a daily feed. Resolving a declaration against its
    // observation series belongs to revenue-serving.ts, where the grain and
    // supersedes rules live.
    const [s] = revenueSourcesFor(SURFACES);
    assert.equal(s.amount_usd, null);
    assert.equal(s.contributes, false);
  });

  test("supersedes is carried through, not dropped", () => {
    // The registry has declared this since #10441 and the composition layer
    // never read it; summing the subsets put SN64's headline 200x over.
    const [s] = revenueSourcesFor([
      {
        id: "daily-summary",
        revenue: {
          role: "external-revenue",
          provenance: "probe-derived",
          grain: "daily",
          supersedes: ["payments-list", "tao-totals"],
        },
      },
    ]);
    assert.deepEqual(s.supersedes, ["payments-list", "tao-totals"]);
  });

  test("a declaration with no supersedes leaves it undefined, not empty", () => {
    const [s] = revenueSourcesFor(SURFACES);
    assert.equal(s.supersedes, undefined);
  });

  test("a half-built declaration falls back rather than emitting undefined", () => {
    // The schema requires role and provenance, but this function reads whatever
    // reached it. "undefined" rendered into a provenance field would be read by
    // a client as a value.
    const [s] = revenueSourcesFor([
      { id: "bare", revenue: { role: "external-revenue" } },
    ]);
    assert.equal(s.provenance, "none");
    assert.equal(s.currency, "USD");
    assert.equal(s.grain, "cumulative");
  });

  test("junk input yields no sources rather than throwing", () => {
    assert.deepEqual(revenueSourcesFor(null), []);
    assert.deepEqual(revenueSourcesFor(undefined), []);
    assert.deepEqual(revenueSourcesFor([{ id: "x" }]), []);
  });
});

describe("loadSubnetRevenue never throws on a missing piece", () => {
  test("the normal case: declared, not yet observed", () => {
    const r = loadSubnetRevenue({
      netuid: 64,
      window_days: 1,
      economics: ECONOMICS,
      surfaces: SURFACES,
      usd_per_tao: 204.03,
      searched_at: "2026-08-10T00:00:00Z",
      observations: null,
    });
    assert.equal(r.revenue_usd, null);
    assert.equal(r.coverage_ratio, null);
    assert.equal(r.provenance, "probe-derived");
    // The emission side is fully real even with no revenue.
    assert.ok(Math.abs(r.emission.tao - 458.03) < 0.01);
    assert.ok((r.emission.usd ?? 0) > 0);
  });

  test("with an observation it produces the published ratio", () => {
    const r = loadSubnetRevenue({
      netuid: 64,
      window_days: 1,
      economics: ECONOMICS,
      surfaces: SURFACES,
      usd_per_tao: 204.03,
      observations: new Map([
        [
          "sn-64-chutes-daily-revenue-summary",
          [
            {
              surface_id: "sn-64-chutes-daily-revenue-summary",
              period: "2026-08-10",
              amount_usd: 11668,
            },
          ],
        ],
      ]),
    });
    assert.ok(Math.abs((r.subsidy_multiple as number) - 8.0) < 0.05);
    assert.ok(Math.abs((r.coverage_ratio as number) - 0.125) < 0.001);
  });

  test("no economics at all still answers, with a zero denominator", () => {
    // An emission-gated or unknown subnet. computeCoverage turns the zero
    // denominator into null ratios rather than Infinity, so "no data" and
    // "gated" converge on the same honest output.
    const r = loadSubnetRevenue({
      netuid: 999,
      window_days: 1,
      economics: null,
      surfaces: null,
      usd_per_tao: 204.03,
      observations: null,
    });
    assert.equal(r.emission.tao, 0);
    assert.equal(r.coverage_ratio, null);
    assert.equal(r.provenance, "none");
    assert.equal(r.verification.verified, false);
  });

  test("no TAO price yields null ratios rather than a bogus USD figure", () => {
    const r = loadSubnetRevenue({
      netuid: 64,
      window_days: 1,
      economics: ECONOMICS,
      surfaces: SURFACES,
      usd_per_tao: null,
      observations: new Map([
        [
          "sn-64-chutes-daily-revenue-summary",
          [
            {
              surface_id: "sn-64-chutes-daily-revenue-summary",
              period: "2026-08-10",
              amount_usd: 11668,
            },
          ],
        ],
      ]),
    });
    // This asserted `0`, and that assertion is what kept the bug
    // pinned -- the ratios were null as the test name says, but the USD legs
    // beside them published a hard zero against a real TAO denominator.
    assert.equal(r.emission.usd, null, "a missing rate declines, never zeroes");
    assert.equal(r.emission.alternates.owner_take.usd, null);
    assert.equal(r.emission.alternates.alpha_out_priced?.usd, null);
    assert.equal(r.coverage_ratio, null, "no rate means no USD comparison");
    assert.ok(r.emission.tao > 0, "the TAO denominator is still real");
  });

  // The `?? 0` that produced the zero above lived in loadSubnetRevenue, not in
  // computeCoverage, so the unit test on the pure function could not see it.
  test("a live rate reaches every USD leg through the loader", () => {
    const r = loadSubnetRevenue({
      netuid: 64,
      window_days: 1,
      economics: ECONOMICS,
      surfaces: SURFACES,
      usd_per_tao: 200.25489144597697,
      observations: null,
    });
    assert.ok((r.emission.usd ?? 0) > 0, `${r.emission.usd}`);
    assert.ok((r.emission.alternates.owner_take.usd ?? 0) > 0);
    assert.ok((r.emission.alternates.alpha_out_priced?.usd ?? 0) > 0);
  });
});

describe("groupSurfacesByNetuid — one bulk read in place of 129 (#11422)", () => {
  test("groups every surface under its own netuid", () => {
    // The `bucket ? push : set` pair, both arms: SN7 arrives twice so the
    // second surface must join the first rather than replace it. A map that
    // kept only the last surface per subnet would silently drop revenue
    // declarations on any subnet declaring more than one -- SN64 has three.
    const grouped = groupSurfacesByNetuid([
      { id: "a", netuid: 7 },
      { id: "b", netuid: 9 },
      { id: "c", netuid: 7 },
    ]);
    assert.deepEqual(
      [...grouped.keys()].sort((x, y) => x - y),
      [7, 9],
    );
    assert.deepEqual(
      grouped.get(7)?.map((s) => s.id),
      ["a", "c"],
    );
    assert.deepEqual(
      grouped.get(9)?.map((s) => s.id),
      ["b"],
    );
  });

  test("a surface with no usable netuid is skipped, never bucketed", () => {
    // The per-subnet read this replaces could not produce one -- the netuid was
    // the path. Reading them out of the bulk artifact makes an unusable value
    // reachable, and bucketing it under NaN would put surfaces on a subnet
    // nobody can ask for.
    const grouped = groupSurfacesByNetuid([
      { id: "ok", netuid: 3 },
      { id: "missing" },
      { id: "text", netuid: "seven" },
      { id: "fractional", netuid: 3.5 },
      { id: "null", netuid: null },
    ]);
    assert.deepEqual([...grouped.keys()], [3]);
    assert.deepEqual(
      grouped.get(3)?.map((s) => s.id),
      ["ok"],
    );
  });

  test("an absent or unreadable artifact is an empty map, not a throw", () => {
    // `readArtifact` answers `{ ok: false }` and MCP's loader throws; both
    // arrive here as nothing to group. Empty means "no declarations", which is
    // the same answer a missing per-subnet artifact gave.
    for (const input of [null, undefined, []]) {
      assert.equal(groupSurfacesByNetuid(input).size, 0, JSON.stringify(input));
    }
  });
});

describe("surfacesByNetuidMemoized — the read, not the schedule (#11422)", () => {
  test("reads once inside the TTL and again after it", async () => {
    // Collapsing 129 reads into one bulk read cut the BYTES tenfold and not the
    // latency -- REST stayed at ~1.7s and GraphQL went 1.0s -> 2.0s, because one
    // 3.5 MB read parsed serially costs about what eight waves of concurrent
    // small reads cost. The artifact is immutable between publishes, so the fix
    // is to stop doing it per request.
    let reads = 0;
    const load = async () => {
      reads += 1;
      return [{ id: "a", netuid: 7 }];
    };
    let now = 1_000_000;
    const clock = () => now;

    assert.equal((await surfacesByNetuidMemoized(load, clock)).size, 1);
    assert.equal(reads, 1);
    await surfacesByNetuidMemoized(load, clock);
    await surfacesByNetuidMemoized(load, clock);
    assert.equal(reads, 1, "inside the TTL the artifact is not re-read");

    now += SURFACES_MEMO_TTL_MS + 1;
    await surfacesByNetuidMemoized(load, clock);
    assert.equal(reads, 2, "past the TTL it re-reads");
  });

  test("concurrent callers on a cold isolate share ONE read", async () => {
    // The PROMISE is memoized, not the value. Three surfaces compose this
    // answer and can arrive together, so memoizing the resolved map would still
    // let them race to issue three reads of a 3.5 MB artifact.
    let reads = 0;
    const load = async () => {
      reads += 1;
      return [{ id: "a", netuid: 7 }];
    };
    const clock = () => 1_000_000;
    await Promise.all([
      surfacesByNetuidMemoized(load, clock),
      surfacesByNetuidMemoized(load, clock),
      surfacesByNetuidMemoized(load, clock),
    ]);
    assert.equal(reads, 1);
  });

  test("a read that yields nothing is NOT memoized for the TTL", async () => {
    // Otherwise a transient miss costs five minutes of empty declarations,
    // which is the shape #11467 fixed on the account-summary pointer: a failure
    // held for a TTL turns one bad read into an outage.
    let reads = 0;
    const load = async () => {
      reads += 1;
      return reads === 1 ? null : [{ id: "a", netuid: 7 }];
    };
    const clock = () => 1_000_000;
    assert.equal((await surfacesByNetuidMemoized(load, clock)).size, 0);
    assert.equal((await surfacesByNetuidMemoized(load, clock)).size, 1);
    assert.equal(reads, 2, "the empty answer was retried, not cached");
  });
});
