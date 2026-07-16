// #5992: promote-reviewed.mjs only promoted curation.level from
// "machine-verified", so a maintainer-reviewed decision against any other
// starting tier (community-seeded / candidate-discovered / native) silently
// never took effect — live drift on SN59/SN107. These tests pin the shared
// helpers both scripts now use: curationForDecision (the writer) and
// maintainerReviewedDrift (the CI guard).
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  TOP_TRUST_LEVELS,
  curationForDecision,
  maintainerReviewedDrift,
} from "../scripts/lib/maintainer-reviewed.mjs";

const reviewedDecision = (netuid = 59) => ({
  netuid,
  slug: `sn-${netuid}`,
  decision: "maintainer-reviewed",
  reviewed_at: "2026-06-20T00:00:00.000Z",
});

describe("curationForDecision (#5992)", () => {
  for (const startLevel of [
    "community-seeded",
    "candidate-discovered",
    "native",
    "machine-verified",
  ]) {
    test(`promotes level to maintainer-reviewed from ${startLevel}`, () => {
      const next = curationForDecision(
        { level: startLevel, review_state: "unreviewed" },
        reviewedDecision(),
      );
      assert.equal(next.level, "maintainer-reviewed");
      assert.equal(next.review_state, "maintainer-reviewed");
      assert.equal(next.reviewed_at, "2026-06-20T00:00:00.000Z");
    });
  }

  test("never downgrades an adapter-backed overlay", () => {
    const next = curationForDecision(
      { level: "adapter-backed", review_state: "maintainer-reviewed" },
      reviewedDecision(7),
    );
    assert.equal(next.level, "adapter-backed");
    // still records the decision's review metadata
    assert.equal(next.reviewed_at, "2026-06-20T00:00:00.000Z");
  });

  test("leaves an already maintainer-reviewed level unchanged", () => {
    const next = curationForDecision(
      { level: "maintainer-reviewed" },
      reviewedDecision(),
    );
    assert.equal(next.level, "maintainer-reviewed");
  });

  test("a non-maintainer-reviewed decision records state but never promotes level", () => {
    const next = curationForDecision(
      { level: "community-seeded" },
      { decision: "rejected", reviewed_at: "2026-06-20T00:00:00.000Z" },
    );
    assert.equal(next.level, "community-seeded");
    assert.equal(next.review_state, "rejected");
  });

  test("handles a missing curation block", () => {
    const next = curationForDecision(undefined, reviewedDecision());
    assert.equal(next.level, "maintainer-reviewed");
    assert.equal(next.review_state, "maintainer-reviewed");
  });
});

describe("maintainerReviewedDrift (#5992)", () => {
  const decisions = [
    reviewedDecision(59),
    reviewedDecision(7),
    { netuid: 3, slug: "sn-3", decision: "rejected", reviewed_at: "x" },
  ];

  test("flags a maintainer-reviewed decision whose overlay is a lower tier", () => {
    const drift = maintainerReviewedDrift(
      [{ netuid: 59, slug: "sn-59", curation: { level: "community-seeded" } }],
      decisions,
    );
    assert.deepEqual(drift, [
      { netuid: 59, slug: "sn-59", level: "community-seeded" },
    ]);
  });

  test("does not flag an overlay already at a top-trust tier", () => {
    const drift = maintainerReviewedDrift(
      [
        {
          netuid: 59,
          slug: "sn-59",
          curation: { level: "maintainer-reviewed" },
        },
        { netuid: 7, slug: "sn-7", curation: { level: "adapter-backed" } },
      ],
      decisions,
    );
    assert.deepEqual(drift, []);
  });

  test("ignores a decision with no loaded overlay", () => {
    const drift = maintainerReviewedDrift([], decisions);
    assert.deepEqual(drift, []);
  });

  test("ignores non-maintainer-reviewed decisions", () => {
    const drift = maintainerReviewedDrift(
      [{ netuid: 3, slug: "sn-3", curation: { level: "community-seeded" } }],
      decisions,
    );
    assert.deepEqual(drift, []);
  });

  test("adapter-backed is the higher of the two top-trust tiers", () => {
    assert.ok(TOP_TRUST_LEVELS.has("maintainer-reviewed"));
    assert.ok(TOP_TRUST_LEVELS.has("adapter-backed"));
  });
});
