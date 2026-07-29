// #8689: machine verification of catalogued surfaces from probe evidence.
//
// Before this, `machine-verified` was a tier the codebase could compute but
// that nothing could produce -- the live registry reported ZERO of them against
// 623 eligible surfaces. These tests pin the promotion bar, the demotion rules,
// and the one property that matters most: nothing gets verified by the ABSENCE
// of bad news.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  DEMOTING_CLASSIFICATIONS,
  MIN_VERIFY_DAYS,
  MIN_VERIFY_SAMPLES,
  MIN_VERIFY_UPTIME,
  isProbeDemoted,
  probeVerificationBlock,
  verifyFromProbeEvidence,
  type SurfaceProbeRecord,
} from "../src/surface-verification.ts";

const LAST_OK = "2026-07-29T13:00:55.953Z";

/** A record that clears every threshold, for single-field perturbation. */
const passing = (
  over: Partial<SurfaceProbeRecord> = {},
): SurfaceProbeRecord => ({
  day_count: 19,
  samples: 1561,
  uptime_ratio: 0.9981,
  last_ok: LAST_OK,
  classification: null,
  ...over,
});

describe("the promotion bar", () => {
  test("a healthy, long-observed surface verifies, dated to its last healthy probe", () => {
    const verdict = verifyFromProbeEvidence(passing());
    assert.equal(verdict.verified, true);
    // NOT "now": the evidence attests to when we last saw it healthy, and that
    // is the instant the per-kind freshness TTL must measure against.
    assert.equal(verdict.verifiedAt, LAST_OK);
    assert.match(verdict.reason, /19d, 1561 samples, uptime 0\.9981/);
  });

  test("each threshold is independently load-bearing", () => {
    // One field short of the bar at a time -- so a future change that drops a
    // condition cannot pass by leaning on the other two.
    const cases: [string, Partial<SurfaceProbeRecord>, RegExp][] = [
      ["too few days", { day_count: MIN_VERIFY_DAYS - 1 }, /required days/],
      [
        "too few samples",
        { samples: MIN_VERIFY_SAMPLES - 1 },
        /required samples/,
      ],
      [
        "uptime below bar",
        { uptime_ratio: MIN_VERIFY_UPTIME - 0.0001 },
        /below/,
      ],
    ];
    for (const [label, over, reason] of cases) {
      const verdict = verifyFromProbeEvidence(passing(over));
      assert.equal(verdict.verified, false, label);
      assert.equal(verdict.verifiedAt, null, label);
      assert.match(verdict.reason, reason, label);
    }
  });

  test("each threshold passes exactly AT the bar, not just above it", () => {
    // Guards an off-by-one flipping >= into >, which would silently exclude the
    // surfaces sitting precisely on the boundary.
    for (const over of [
      { day_count: MIN_VERIFY_DAYS },
      { samples: MIN_VERIFY_SAMPLES },
      { uptime_ratio: MIN_VERIFY_UPTIME },
    ]) {
      assert.equal(verifyFromProbeEvidence(passing(over)).verified, true);
    }
  });

  test("meeting the thresholds without a last_ok does NOT verify", () => {
    // There would be no honest instant to stamp, and defaulting to "now" would
    // date the verification to whenever the sync ran.
    const verdict = verifyFromProbeEvidence(passing({ last_ok: null }));
    assert.equal(verdict.verified, false);
    assert.match(verdict.reason, /no last_ok/);
  });
});

describe("absence of evidence never verifies and never demotes", () => {
  test("no record at all is unverified, not verified and not dead", () => {
    for (const input of [null, undefined]) {
      const verdict = verifyFromProbeEvidence(input);
      assert.equal(verdict.verified, false);
      assert.equal(verdict.reason, "no probe evidence");
      // Critically NOT demoted: unknown is not dead. Treating it as dead would
      // let a failed sync revoke verification across the whole registry.
      assert.equal(isProbeDemoted(input), false);
    }
  });

  test("degenerate numbers are unverified rather than throwing or passing", () => {
    // A malformed snapshot must fail closed on PROMOTION (grant nothing), which
    // is the opposite direction from the rate-limit gate's fail-open: there,
    // erring costs a paying caller their request; here, erring would advertise
    // an unverified surface as verified.
    for (const over of [
      { day_count: Number.NaN },
      { samples: Number.NaN },
      { uptime_ratio: Number.NaN },
      { day_count: undefined as unknown as number },
      { uptime_ratio: "high" as unknown as number },
    ]) {
      assert.equal(verifyFromProbeEvidence(passing(over)).verified, false);
    }
  });

  test("an empty object is unverified", () => {
    assert.equal(
      verifyFromProbeEvidence({} as SurfaceProbeRecord).verified,
      false,
    );
  });
});

describe("demotion", () => {
  test("a confirmed-dead or unsafe surface is demoted and never verified", () => {
    for (const classification of DEMOTING_CLASSIFICATIONS) {
      const record = passing({ classification });
      // Even though it clears every numeric threshold.
      assert.equal(verifyFromProbeEvidence(record).verified, false);
      assert.match(verifyFromProbeEvidence(record).reason, /classified/);
      assert.equal(isProbeDemoted(record), true);
    }
  });

  test("dead and unsafe are the only demoting classifications", () => {
    // `redirected`, `content-mismatch` and friends are real signals but are not
    // "this is gone" -- they must not revoke a maintainer's verification.
    for (const classification of [
      "live",
      "redirected",
      "content-mismatch",
      "rate-limited",
      "transient",
      "auth-required",
      "unsupported",
    ]) {
      assert.equal(
        isProbeDemoted(passing({ classification })),
        false,
        classification,
      );
    }
    assert.deepEqual([...DEMOTING_CLASSIFICATIONS].sort(), ["dead", "unsafe"]);
  });

  test("a non-string classification is not treated as demoting", () => {
    assert.equal(isProbeDemoted(passing({ classification: null })), false);
    assert.equal(
      isProbeDemoted(passing({ classification: 1 as unknown as string })),
      false,
    );
  });
});

describe("probeVerificationBlock", () => {
  test("records HOW a surface was verified, so probe and human evidence stay distinguishable", () => {
    const block = probeVerificationBlock(verifyFromProbeEvidence(passing()));
    assert.deepEqual(block, {
      verified_at: LAST_OK,
      // Health is probe-derived only -- a house rule, kept legible at the point
      // of use so a reader can weigh this against a maintainer's own vetting.
      method: "live-cron-prober",
      evidence: "19d, 1561 samples, uptime 0.9981",
    });
  });

  test("yields nothing for a failed verdict", () => {
    assert.equal(
      probeVerificationBlock(verifyFromProbeEvidence(passing({ samples: 1 }))),
      null,
    );
    assert.equal(
      probeVerificationBlock({
        verified: true,
        verifiedAt: null,
        reason: "inconsistent",
      }),
      null,
      "a verdict claiming verified with no instant is not usable",
    );
  });
});
