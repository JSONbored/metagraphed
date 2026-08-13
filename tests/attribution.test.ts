// #10924: the attribution rules, enforced by the schema rather than by prose.
//
// The published statement (apps/ui/content/docs/attribution-method.mdx) says a
// verdict above `unresolved` needs checkable evidence. A rule that lives only
// in a docs page is a rule a surface can forget; these tests pin the refusals
// so forgetting is a parse failure.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  ATTRIBUTION_EVIDENCE_KINDS,
  ATTRIBUTION_VERDICT_VALUES,
  AttributedColdkeySchema,
  AttributionEvidenceSchema,
  DEFAULT_ATTRIBUTION_VERDICT,
} from "../schemas-src/attribution.ts";

const observed_at = "2026-08-12T00:00:00.000Z";
const fundingPath = {
  kind: "funding-path",
  extrinsic_hash: "0xdead",
  observed_at,
};

describe("unresolved is the default, not a failure state", () => {
  test("a bare coldkey is unresolved", () => {
    const parsed = AttributedColdkeySchema.parse({ coldkey: "5abc" });
    assert.equal(parsed.verdict, "unresolved");
    assert.deepEqual(parsed.evidence, []);
  });

  test("the default is the first value, so it reads as the weakest claim", () => {
    assert.equal(ATTRIBUTION_VERDICT_VALUES[0], DEFAULT_ATTRIBUTION_VERDICT);
    assert.equal(DEFAULT_ATTRIBUTION_VERDICT, "unresolved");
  });

  test("unresolved needs no evidence, because it claims nothing", () => {
    assert.equal(
      AttributedColdkeySchema.safeParse({
        coldkey: "5a",
        verdict: "unresolved",
      }).success,
      true,
    );
  });
});

describe("a claim above unresolved cannot be made without evidence", () => {
  for (const verdict of ["affiliated", "third-party"] as const) {
    test(`${verdict} with no evidence is REFUSED`, () => {
      // The rule the whole page exists for: an inferred affiliation published
      // as fact is a defamation exposure, not a bug.
      const parsed = AttributedColdkeySchema.safeParse({
        coldkey: "5a",
        verdict,
      });
      assert.equal(parsed.success, false);
    });

    test(`${verdict} with a citable funding path is accepted`, () => {
      assert.equal(
        AttributedColdkeySchema.safeParse({
          coldkey: "5a",
          verdict,
          evidence: [fundingPath],
        }).success,
        true,
      );
    });
  }

  test("owner is the ONE exemption -- the chain read is the citation", () => {
    // `SubtensorModule.SubnetOwner` is itself the evidence, so requiring a
    // second citation would make the only fully-measured verdict the hardest
    // one to publish.
    assert.equal(
      AttributedColdkeySchema.safeParse({ coldkey: "5a", verdict: "owner" })
        .success,
      true,
    );
  });
});

describe("evidence a reader cannot follow is not evidence", () => {
  test("neither a source_url nor an extrinsic_hash is REFUSED", () => {
    assert.equal(
      AttributionEvidenceSchema.safeParse({
        kind: "self-declared",
        observed_at,
      }).success,
      false,
    );
  });

  test("either one alone is enough", () => {
    for (const citation of [
      { source_url: "https://github.com/x/y/blob/abc123/weights.py" },
      { extrinsic_hash: "0xdead" },
    ]) {
      assert.equal(
        AttributionEvidenceSchema.safeParse({
          kind: "self-declared",
          observed_at,
          ...citation,
        }).success,
        true,
      );
    }
  });

  test("observed_at is required, so a citation can be aged out", () => {
    // A wallet relationship true last quarter may not be true today.
    assert.equal(
      AttributionEvidenceSchema.safeParse({
        kind: "funding-path",
        extrinsic_hash: "0xdead",
      }).success,
      false,
    );
  });

  test("the evidence kinds exclude correlation on purpose", () => {
    // Timing, similar stake sizes and same-block registration are reviewer
    // hints. Admitting them as evidence kinds is how a coincidence becomes an
    // allegation, so they are absent by construction rather than by review.
    for (const notEvidence of [
      "timing",
      "same-block",
      "stake-size",
      "cluster",
    ]) {
      assert.equal(
        (ATTRIBUTION_EVIDENCE_KINDS as readonly string[]).includes(notEvidence),
        false,
        notEvidence,
      );
    }
    assert.equal(ATTRIBUTION_EVIDENCE_KINDS.length, 5);
  });

  test("an unknown verdict is refused rather than passed through", () => {
    assert.equal(
      AttributedColdkeySchema.safeParse({ coldkey: "5a", verdict: "team" })
        .success,
      false,
    );
  });
});
