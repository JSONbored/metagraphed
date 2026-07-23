// Coverage for #5992: promote-reviewed.ts must promote curation.level to
// maintainer-reviewed from ANY lower pre-tier (not just machine-verified), and
// validate.mjs must catch a recorded maintainer-reviewed decision that never
// materialized on its overlay. Both behaviours live in the pure, side-effect-free
// helpers in scripts/lib.ts (promoteCurationLevel /
// findUnmaterializedMaintainerReviews) so they unit-test directly.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  CEILING_TRUST_LEVELS,
  promoteCurationLevel,
  findUnmaterializedMaintainerReviews,
} from "../scripts/lib.ts";

describe("promoteCurationLevel (#5992)", () => {
  const PRE_TIERS = [
    "native",
    "candidate-discovered",
    "community-seeded",
    "machine-verified",
  ];

  test("a maintainer-reviewed decision promotes EVERY pre-tier level (not just machine-verified)", () => {
    for (const level of PRE_TIERS) {
      assert.equal(
        promoteCurationLevel(level, "maintainer-reviewed"),
        "maintainer-reviewed",
        `expected ${level} to promote to maintainer-reviewed`,
      );
    }
  });

  test("a ceiling trust tier is never downgraded or re-touched by a decision", () => {
    for (const level of CEILING_TRUST_LEVELS) {
      assert.equal(promoteCurationLevel(level, "maintainer-reviewed"), level);
    }
    // adapter-backed specifically: the first-party self-referential entries
    // (SN7 allways / SN74 gittensor) must stay adapter-backed despite a decision.
    assert.equal(
      promoteCurationLevel("adapter-backed", "maintainer-reviewed"),
      "adapter-backed",
    );
  });

  test("a non-maintainer-reviewed decision never moves the level", () => {
    assert.equal(
      promoteCurationLevel("community-seeded", "rejected"),
      "community-seeded",
    );
    assert.equal(
      promoteCurationLevel("machine-verified", "needs-info"),
      "machine-verified",
    );
  });
});

describe("findUnmaterializedMaintainerReviews (#5992)", () => {
  function subnetsByNetuid(entries) {
    return new Map(entries.map((s) => [s.netuid, s]));
  }

  test("flags a decision whose overlay is still at a lower pre-tier (the SN107 drift)", () => {
    const decisions = [{ netuid: 107, decision: "maintainer-reviewed" }];
    const subnets = subnetsByNetuid([
      { netuid: 107, slug: "minos", curation: { level: "community-seeded" } },
    ]);
    const violations = findUnmaterializedMaintainerReviews(decisions, subnets);
    assert.deepEqual(violations, [
      { netuid: 107, slug: "minos", level: "community-seeded" },
    ]);
  });

  test("does NOT flag a decision materialized to either ceiling tier", () => {
    const decisions = [
      { netuid: 107, decision: "maintainer-reviewed" },
      { netuid: 7, decision: "maintainer-reviewed" },
    ];
    const subnets = subnetsByNetuid([
      // materialized straight to maintainer-reviewed
      {
        netuid: 107,
        slug: "minos",
        curation: { level: "maintainer-reviewed" },
      },
      // adapter-backed is a valid ceiling terminal (SN7 allways) — not drift
      { netuid: 7, slug: "allways", curation: { level: "adapter-backed" } },
    ]);
    assert.deepEqual(
      findUnmaterializedMaintainerReviews(decisions, subnets),
      [],
    );
  });

  test("ignores non-maintainer-reviewed decisions and decisions for unknown netuids", () => {
    const decisions = [
      { netuid: 5, decision: "rejected" }, // not a maintainer-reviewed decision
      { netuid: 999, decision: "maintainer-reviewed" }, // no overlay
    ];
    const subnets = subnetsByNetuid([
      { netuid: 5, slug: "sn-5", curation: { level: "community-seeded" } },
    ]);
    assert.deepEqual(
      findUnmaterializedMaintainerReviews(decisions, subnets),
      [],
    );
  });

  test("handles a null/absent decisions list and an overlay with no curation block", () => {
    assert.deepEqual(findUnmaterializedMaintainerReviews(null, new Map()), []);
    // A decision whose overlay has no curation block at all is still drift
    // (level is undefined, which is not a ceiling tier).
    const violations = findUnmaterializedMaintainerReviews(
      [{ netuid: 3, decision: "maintainer-reviewed" }],
      new Map([[3, { netuid: 3, slug: "sn-3" }]]),
    );
    assert.deepEqual(violations, [
      { netuid: 3, slug: "sn-3", level: undefined },
    ]);
  });
});
