// src/treasury-readings.ts — a disclosed business model, and the three states.
//
// Nearly every test here is about a distinction that a naive shape collapses.
// The arithmetic is trivial; what is not trivial is that "nobody read this
// repo", "read it and found nothing", and "found a cut" stay three answers,
// and that an unreviewed machine reading never publishes a finding.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  buildSubnetTreasury,
  declaredMatchesObserved,
  SUBNET_TREASURY_FIELD_SOURCES,
  TREASURY_MATCH_TOLERANCE,
} from "../src/treasury-readings.ts";
import { SubnetTreasuryArtifactSchema } from "../schemas-src/routes/treasury.ts";

type Row = Record<string, unknown>;

const MS = 1_760_000_000_000;

function row(over: Row = {}): Row {
  return {
    netuid: 74,
    source_url: "https://github.com/example/subnet",
    read_at_sha: "abc1234def5678",
    observed_at: MS,
    first_seen: MS - 86_400_000,
    found: false,
    declared_share: null,
    treasury_address: null,
    applies_to: null,
    evidence_path: null,
    review_state: "reviewed",
    reviewed_at: MS,
    ...over,
  };
}

describe("the three states", () => {
  test("NOBODY LOOKED is an empty card that claims nothing", () => {
    const out = buildSubnetTreasury([], 74);
    assert.equal(out.repos_read, 0);
    assert.deepEqual(out.readings, []);
    assert.equal(out.declared_share, null);
    // The critical one: an unread subnet must NOT report a mismatch.
    assert.equal(out.declared_matches_observed, null);
  });

  test("READ AND FOUND NOTHING is a measurement, distinguishable from it", () => {
    const out = buildSubnetTreasury([row({ found: false })], 74);
    assert.equal(out.repos_read, 1, "we looked");
    const r = (out.readings as Row[])[0];
    assert.equal(r.found, false, "and found nothing — this is evidence");
    assert.equal((r.evidence as Row).read_at_sha, "abc1234def5678");
    // Still no declared share, but for a different reason than the empty card.
    assert.equal(out.declared_share, null);
  });

  test("a found allocation publishes its share", () => {
    const out = buildSubnetTreasury(
      [row({ found: true, declared_share: 0.1, applies_to: "miner-emission" })],
      74,
    );
    assert.equal(out.declared_share, 0.1);
    assert.equal((out.readings as Row[])[0].found, true);
  });
});

describe("the review gate", () => {
  test("A CANDIDATE PUBLISHES ITS READ STATUS AND NOT ITS FINDING", () => {
    // Rule 5: a machine's summary of source code is not evidence. The read
    // status is still public, because that is what keeps "have we looked at
    // this subnet" answerable.
    const out = buildSubnetTreasury(
      [
        row({
          review_state: "candidate",
          found: true,
          declared_share: 0.6,
          treasury_address: "5Treasury",
          applies_to: "miner-emission",
        }),
      ],
      74,
    );
    const r = (out.readings as Row[])[0];
    assert.equal(r.review_state, "candidate");
    // The read status survives.
    assert.equal((r.evidence as Row).read_at_sha, "abc1234def5678");
    assert.equal(out.repos_read, 1);
    // The finding does NOT.
    assert.equal(r.found, null, "an unreviewed finding must be withheld");
    assert.equal(r.declared_share, null);
    assert.equal(r.treasury_address, null);
    assert.equal(out.declared_share, null, "and never reaches the headline");
    assert.equal(out.pending_review_count, 1);
    assert.equal(out.reviewed_count, 0);
  });

  test("a rejected reading publishes nothing either", () => {
    const out = buildSubnetTreasury(
      [row({ review_state: "rejected", found: true, declared_share: 0.9 })],
      74,
    );
    assert.equal((out.readings as Row[])[0].found, null);
    assert.equal(out.declared_share, null);
  });

  test("an unknown review_state is treated as a candidate, not published", () => {
    // Fail closed: a state nobody defined must not be a publish path.
    const out = buildSubnetTreasury(
      [
        row({
          review_state: "approved-by-someone",
          found: true,
          declared_share: 0.5,
        }),
      ],
      74,
    );
    assert.equal((out.readings as Row[])[0].review_state, "candidate");
    assert.equal((out.readings as Row[])[0].declared_share, null);
  });
});

describe("declared vs observed", () => {
  test("agreement is a real answer and is published as one", () => {
    const out = buildSubnetTreasury(
      [row({ found: true, declared_share: 0.1, applies_to: "miner-emission" })],
      74,
      { observed_share: 0.104 },
    );
    assert.equal(out.declared_matches_observed, true);
  });

  test("divergence is reported without being dressed up", () => {
    const out = buildSubnetTreasury(
      [row({ found: true, declared_share: 0.1, applies_to: "miner-emission" })],
      74,
      { observed_share: 0.4 },
    );
    assert.equal(out.declared_matches_observed, false);
  });

  test("NULL IS NOT A MISMATCH", () => {
    // The single most dangerous coercion on this surface: rendering "we could
    // not compare" as "they are not doing what they said".
    assert.equal(declaredMatchesObserved(null, 0.4), null);
    assert.equal(declaredMatchesObserved(0.1, null), null);
    assert.equal(declaredMatchesObserved(null, null), null);
    // A declared cut with no observed side must not resolve to false.
    const out = buildSubnetTreasury(
      [row({ found: true, declared_share: 0.1, applies_to: "miner-emission" })],
      74,
    );
    assert.equal(out.declared_matches_observed, null);
  });

  test("the tolerance admits a rounded declaration, not a real gap", () => {
    assert.equal(
      declaredMatchesObserved(0.1, 0.1 + TREASURY_MATCH_TOLERANCE / 2),
      true,
    );
    assert.equal(
      declaredMatchesObserved(0.1, 0.1 + TREASURY_MATCH_TOLERANCE * 2),
      false,
    );
  });

  test("SHARES WITH DIFFERENT BASES ARE NEVER SUMMED", () => {
    // A payout fee and an emission cut are taken from different quantities.
    // Adding them would report a 15% emission cut where 10% was declared.
    const out = buildSubnetTreasury(
      [
        row({
          source_url: "a",
          found: true,
          declared_share: 0.1,
          applies_to: "miner-emission",
        }),
        row({
          source_url: "b",
          found: true,
          declared_share: 0.05,
          applies_to: "fee",
        }),
      ],
      74,
    );
    assert.equal(out.declared_share, 0.1, "only the emission cut");
  });
});

describe("shaping", () => {
  test("a cold store answers rather than throwing", () => {
    for (const input of [null, undefined, []]) {
      const out = buildSubnetTreasury(input, 74);
      assert.equal(out.repos_read, 0);
      assert.equal(out.declared_matches_observed, null);
    }
  });

  test("an unreadable timestamp nulls the date rather than inventing one", () => {
    // A citation with a fabricated date cannot be aged out.
    const out = buildSubnetTreasury(
      [row({ observed_at: null, first_seen: "nope" })],
      74,
    );
    const e = (out.readings as Row[])[0].evidence as Row;
    assert.equal(e.observed_at, null);
    assert.equal(e.first_seen, null);
  });

  test("a numerically finite but unrepresentable date nulls rather than throws", () => {
    // Postgres BIGINT can hold a value Date cannot represent. `new Date(1e18)`
    // is an Invalid Date, and formatting it would throw -- so the guard is a
    // real path, not defensive decoration.
    const out = buildSubnetTreasury([row({ observed_at: 1e18 })], 74);
    assert.equal(
      ((out.readings as Row[])[0].evidence as Row).observed_at,
      null,
    );
  });

  test("a reviewed finding with no share contributes nothing to the total", () => {
    // The DB CHECK allows `found: true` with only a treasury_address and no
    // share -- an allocation we can name but not quantify. It must not read
    // as a 0% cut in the headline.
    const out = buildSubnetTreasury(
      [
        row({
          found: true,
          declared_share: null,
          treasury_address: "5T",
          applies_to: "miner-emission",
        }),
      ],
      74,
    );
    assert.equal(out.declared_share, 0, "quantified as nothing, not omitted");
    assert.equal((out.readings as Row[])[0].treasury_address, "5T");
  });

  test("an unknown applies_to is dropped rather than passed through", () => {
    const out = buildSubnetTreasury(
      [row({ found: true, declared_share: 0.2, applies_to: "vibes" })],
      74,
    );
    assert.equal((out.readings as Row[])[0].applies_to, null);
    assert.equal(out.declared_share, null, "and cannot reach the headline");
  });

  test("field_sources rides with the payload from the builder", () => {
    const out = buildSubnetTreasury([row()], 74);
    assert.equal(out.field_sources, SUBNET_TREASURY_FIELD_SOURCES);
    assert.equal(
      SUBNET_TREASURY_FIELD_SOURCES["readings.found"].kind,
      "measured",
    );
    assert.equal(
      SUBNET_TREASURY_FIELD_SOURCES.declared_matches_observed.kind,
      "reconstructed",
    );
  });
});

describe("the contract", () => {
  // The schema is not self-enforcing over a Record<string, unknown>.
  test("a populated payload validates against the served schema", () => {
    const out = buildSubnetTreasury(
      [
        row({ found: true, declared_share: 0.1, applies_to: "miner-emission" }),
        row({ source_url: "b", review_state: "candidate", found: true }),
      ],
      74,
      { observed_share: 0.11 },
    );
    const parsed = SubnetTreasuryArtifactSchema.safeParse(out);
    assert.equal(
      parsed.success,
      true,
      JSON.stringify(parsed.error?.issues?.slice(0, 3)),
    );
  });

  test("the empty card validates too", () => {
    const parsed = SubnetTreasuryArtifactSchema.safeParse(
      buildSubnetTreasury([], 74),
    );
    assert.equal(
      parsed.success,
      true,
      JSON.stringify(parsed.error?.issues?.slice(0, 3)),
    );
  });
});
