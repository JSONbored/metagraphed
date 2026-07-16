// Unit tests for the promotion helper behind scripts/promote-reviewed.mjs (#5992).
// promoteCuration lives in scripts/lib.mjs (not the script) so it can be imported
// side-effect-free — importing promote-reviewed.mjs would execute its top-level
// process.argv / file-reading body under vitest. The fix under test: a
// maintainer-reviewed decision must promote curation.level from ANY non-top tier
// (community-seeded / candidate-discovered / native / machine-verified), not only
// from "machine-verified" as the old script did — while leaving subnets already
// at a TOP-TRUST tier (adapter-backed / maintainer-reviewed) untouched so an
// equal-trust "adapter-backed" is never downgraded.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { promoteCuration, TOP_TRUST_LEVELS } from "../scripts/lib.mjs";

const decision = {
  decision: "maintainer-reviewed",
  reviewed_at: "2026-06-20T00:00:00.000Z",
};

describe("promoteCuration (#5992 level-promotion fix)", () => {
  test("TOP_TRUST_LEVELS is the shared two-tier set", () => {
    assert.deepEqual([...TOP_TRUST_LEVELS].sort(), [
      "adapter-backed",
      "maintainer-reviewed",
    ]);
  });

  for (const level of [
    "community-seeded",
    "candidate-discovered",
    "native",
    "machine-verified",
  ]) {
    test(`promotes curation.level from "${level}" to maintainer-reviewed`, () => {
      const next = promoteCuration({ level }, decision);
      assert.equal(next.level, "maintainer-reviewed");
      assert.equal(next.review_state, "maintainer-reviewed");
      assert.equal(next.reviewed_at, "2026-06-20T00:00:00.000Z");
    });
  }

  test("promotes when curation is missing entirely", () => {
    const next = promoteCuration(undefined, decision);
    assert.equal(next.level, "maintainer-reviewed");
    assert.equal(next.review_state, "maintainer-reviewed");
    assert.equal(next.reviewed_at, "2026-06-20T00:00:00.000Z");
  });

  for (const level of ["adapter-backed", "maintainer-reviewed"]) {
    test(`leaves an already TOP-TRUST "${level}" level unchanged`, () => {
      const next = promoteCuration({ level }, decision);
      assert.equal(next.level, level, "top-trust level must not change");
      // review_state / reviewed_at are still recorded from the decision.
      assert.equal(next.review_state, "maintainer-reviewed");
      assert.equal(next.reviewed_at, "2026-06-20T00:00:00.000Z");
    });
  }

  test("a non-maintainer-reviewed decision never touches the level", () => {
    const next = promoteCuration(
      { level: "community-seeded" },
      { decision: "needs-review", reviewed_at: "2026-06-20T00:00:00.000Z" },
    );
    assert.equal(next.level, "community-seeded");
    assert.equal(next.review_state, "needs-review");
  });

  test("preserves other curation fields and does not mutate the input", () => {
    const curation = { level: "community-seeded", source_count: 4 };
    const next = promoteCuration(curation, decision);
    assert.equal(next.source_count, 4);
    // input untouched (pure)
    assert.equal(curation.level, "community-seeded");
    assert.equal(curation.review_state, undefined);
  });
});
