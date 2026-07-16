// Coverage for the FORWARD maintainer-reviewed drift guard added to
// scripts/validate.mjs (#5992). validate.mjs is a monolithic top-level script
// that loads the real registry (and its non-committed generated artifacts), so
// the guard's decision logic is extracted into the pure, side-effect-free
// findUnpromotedMaintainerDecisions() in scripts/lib.mjs. That is exactly what
// validate.mjs asserts on, and what is exercised here with synthetic fixtures:
// a maintainer-reviewed decision whose subnet still sits below the top trust
// tier is flagged (validation would fail), while a decision whose subnet is at a
// TOP-TRUST tier (adapter-backed or maintainer-reviewed) passes.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { findUnpromotedMaintainerDecisions } from "../scripts/lib.mjs";

const reviewedDecision = (netuid, slug) => ({
  netuid,
  slug,
  decision: "maintainer-reviewed",
  reviewed_at: "2026-06-20T00:00:00.000Z",
});

describe("findUnpromotedMaintainerDecisions (#5992 forward drift guard)", () => {
  test("flags a maintainer-reviewed decision whose subnet is community-seeded", () => {
    const drift = findUnpromotedMaintainerDecisions({
      decisions: [reviewedDecision(59, "sn-59")],
      subnets: [{ netuid: 59, curation: { level: "community-seeded" } }],
    });
    assert.equal(drift.length, 1);
    assert.deepEqual(drift[0], {
      netuid: 59,
      slug: "sn-59",
      level: "community-seeded",
    });
  });

  test("passes a subnet promoted to maintainer-reviewed", () => {
    const drift = findUnpromotedMaintainerDecisions({
      decisions: [reviewedDecision(59, "sn-59")],
      subnets: [{ netuid: 59, curation: { level: "maintainer-reviewed" } }],
    });
    assert.deepEqual(drift, []);
  });

  test("passes an adapter-backed subnet with a decision (no downgrade)", () => {
    const drift = findUnpromotedMaintainerDecisions({
      decisions: [reviewedDecision(74, "gittensor")],
      subnets: [{ netuid: 74, curation: { level: "adapter-backed" } }],
    });
    assert.deepEqual(drift, []);
  });

  test("skips a decision whose netuid has no subnet overlay", () => {
    const drift = findUnpromotedMaintainerDecisions({
      decisions: [reviewedDecision(999, "ghost")],
      subnets: [{ netuid: 59, curation: { level: "maintainer-reviewed" } }],
    });
    assert.deepEqual(drift, []);
  });

  test("ignores non-maintainer-reviewed decisions", () => {
    const drift = findUnpromotedMaintainerDecisions({
      decisions: [
        { netuid: 59, slug: "sn-59", decision: "needs-review" },
        { netuid: 60, slug: "sn-60", decision: "rejected" },
      ],
      subnets: [
        { netuid: 59, curation: { level: "community-seeded" } },
        { netuid: 60, curation: { level: "community-seeded" } },
      ],
    });
    assert.deepEqual(drift, []);
  });

  test("reports every drifted decision, not just the first", () => {
    const drift = findUnpromotedMaintainerDecisions({
      decisions: [
        reviewedDecision(59, "sn-59"),
        reviewedDecision(107, "sn-107"),
      ],
      subnets: [
        { netuid: 59, curation: { level: "community-seeded" } },
        { netuid: 107, curation: { level: "candidate-discovered" } },
      ],
    });
    assert.equal(drift.length, 2);
    assert.deepEqual(
      drift.map((d) => d.netuid).sort((a, b) => a - b),
      [59, 107],
    );
  });
});
