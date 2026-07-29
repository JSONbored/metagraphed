// #8608: a quota unit is a COST unit, not a request. These tests pin the SHAPE
// ADR 0022 establishes -- which family is dearer than which, and roughly by how
// much -- rather than the magnitudes, which are explicitly provisional until
// #8597 produces measured per-family cost data.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  DEFAULT_ROUTE_COST_WEIGHT,
  ROUTE_COST_WEIGHTS,
  routeCost,
} from "../src/route-cost-weights.ts";

describe("route cost families (#8608)", () => {
  test("classifies each of ADR 0022's four cost shapes", () => {
    const cases: [string, string, number][] = [
      // ai -- the one family with a real, immediate per-call cost.
      ["/api/v1/ask", "ai", 25],
      ["/ask", "ai", 25],
      ["/api/v1/search/semantic", "ai", 25],
      // archive -- storage + egress, genuine scaling bandwidth cost.
      ["/datasets/subnets.parquet", "archive", 10],
      ["/metagraph/history/2026-07.json", "archive", 10],
      // deep-history -- fixed capacity; the cost is pool contention.
      ["/api/v1/chain-events", "deep-history", 5],
      ["/api/v1/accounts/5Abc/events", "deep-history", 5],
      ["/api/v1/accounts/5Abc/transfers", "deep-history", 5],
      ["/api/v1/subnets/18/ownership-history", "deep-history", 5],
      ["/api/v1/extrinsics", "deep-history", 5],
      ["/api/v1/blocks", "deep-history", 5],
      // edge -- cached, near-zero marginal, the overwhelming majority.
      ["/api/v1/subnets", "edge", 1],
      ["/api/v1/coverage", "edge", 1],
      ["/", "edge", 1],
    ];
    for (const [pathname, family, weight] of cases) {
      assert.deepEqual(
        routeCost(pathname),
        { family, weight },
        `${pathname} is ${family}`,
      );
    }
  });

  test("the ordering ADR 0022 establishes holds: ai > archive > deep-history > edge", () => {
    // The magnitudes are provisional; this ranking is the part that must not
    // silently invert when someone retunes the numbers after #8597.
    const weightOf = (family: string) =>
      ROUTE_COST_WEIGHTS.find((entry) => entry.family === family)!.weight;
    assert.ok(weightOf("ai") > weightOf("archive"));
    assert.ok(weightOf("archive") > weightOf("deep-history"));
    assert.ok(weightOf("deep-history") > weightOf("edge"));
    assert.equal(weightOf("edge"), DEFAULT_ROUTE_COST_WEIGHT);
  });

  test("an unmatched path falls back to edge rather than throwing or free-riding", () => {
    // The last entry matches /^\//, so nothing normally reaches the fallback --
    // but a pathname that is not rooted (a malformed URL, a relative path) must
    // still cost something. Charging 0 would make the quota bypassable by
    // whatever shape slipped through.
    assert.deepEqual(routeCost(""), {
      family: "edge",
      weight: DEFAULT_ROUTE_COST_WEIGHT,
    });
    assert.deepEqual(routeCost("api/v1/subnets"), {
      family: "edge",
      weight: DEFAULT_ROUTE_COST_WEIGHT,
    });
  });

  test("families are matched in order, so the specific ones win over edge", () => {
    // edge's /^\// matches everything, so it must stay last -- an ordering
    // regression would silently price every route at 1 and make the whole
    // weighting inert.
    assert.equal(ROUTE_COST_WEIGHTS.at(-1)!.family, "edge");
    assert.ok(
      ROUTE_COST_WEIGHTS.slice(0, -1).every((entry) => entry.weight > 1),
      "every family ahead of edge is dearer than it",
    );
  });

  test("a prefix that merely starts the same is not misclassified", () => {
    // \b anchors matter: /api/v1/blocks-summary is not the deep-history
    // /api/v1/blocks scan, and /asking is not /ask.
    assert.equal(routeCost("/api/v1/asks").family, "edge");
    assert.equal(routeCost("/api/v1/subnets/18/lease-terms").family, "edge");
  });
});
