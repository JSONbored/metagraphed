// The human gate on treasury readings (#10933), argument rules and printing.
//
// The database half is not mocked here: `main` is a thin sequence of two SQL
// statements whose real behaviour is the CHECK constraints and the UPDATE's
// own RETURNING, both exercised against real Postgres in
// tests/data-api-neurons.test.ts. What is worth pinning here is everything a
// wrong keystroke reaches -- because the failure mode of this tool is
// promoting the wrong row, and the row it promotes becomes a published claim
// about somebody's business.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  PROMOTABLE_STATES,
  formatCandidate,
  parseReviewArgs,
} from "../scripts/review-treasury-readings.ts";

const ROW = {
  netuid: 7,
  source_url: "https://github.com/a/b",
  read_at_sha: "abc1234def5678",
  observed_at: "2026-08-13T00:00:00.000Z",
  found: true,
  declared_share: 0.1,
  treasury_address: "5Txyz",
  applies_to: "miner-emission",
  evidence_path: "neurons/validator.py",
  review_state: "candidate",
};

describe("PROMOTABLE_STATES", () => {
  test("a maintainer may not promote back to candidate", () => {
    // `candidate` is what the extractor writes. Moving a row back to it would
    // be undoing a review rather than making one.
    assert.deepEqual([...PROMOTABLE_STATES], ["reviewed", "rejected"]);
  });

  test("it is derived from the schema's vocabulary, not restated", () => {
    // If TREASURY_REVIEW_STATES grows a state, this list must grow with it --
    // a hand-written copy here would silently refuse the new one.
    assert.equal(PROMOTABLE_STATES.includes("candidate" as never), false);
    assert.ok(PROMOTABLE_STATES.length > 0);
  });
});

describe("parseReviewArgs", () => {
  test("list takes no arguments", () => {
    assert.deepEqual(parseReviewArgs(["list"]), {
      command: { action: "list" },
    });
  });

  test("promote needs the source_url, not just the subnet", () => {
    // A subnet can register more than one source repo and they can disagree.
    // Naming the subnet alone would promote whichever the database returned
    // first, which is the shape of publishing the wrong finding.
    const result = parseReviewArgs(["promote", "7"]);
    assert.ok("error" in result);
    assert.match(result.error, /more \n?than one/);
  });

  test("promote refuses a state outside the vocabulary", () => {
    for (const state of ["candidate", "approved", "", "REVIEWED"]) {
      const result = parseReviewArgs(["promote", "7", "https://x", state]);
      assert.ok("error" in result, `${state} must be refused`);
      assert.match(result.error, /reviewed, rejected/);
    }
  });

  test("promote refuses a netuid that is not one", () => {
    for (const netuid of ["", "x", "-1", "1.5"]) {
      const result = parseReviewArgs([
        "promote",
        netuid,
        "https://x",
        "reviewed",
      ]);
      assert.ok("error" in result, `${netuid} must be refused`);
      assert.match(result.error, /needs a netuid/);
    }
  });

  test("an unknown or absent action is named, not defaulted", () => {
    for (const argv of [[], ["review"], ["--help"]]) {
      const result = parseReviewArgs(argv);
      assert.ok("error" in result);
      assert.match(result.error, /Expected "list" or "promote"/);
    }
  });

  test("a well-formed promote parses whole", () => {
    assert.deepEqual(
      parseReviewArgs(["promote", "7", "https://github.com/a/b", "rejected"]),
      {
        command: {
          action: "promote",
          netuid: 7,
          sourceUrl: "https://github.com/a/b",
          state: "rejected",
        },
      },
    );
  });
});

describe("formatCandidate", () => {
  test("PRINTS THE FINDING THE SERVED CARD WITHHOLDS", () => {
    // The whole point of the gate. A review tool that does not show what you
    // are about to publish is a rubber stamp with extra steps.
    const out = formatCandidate(ROW);
    assert.match(out, /10\.00%/);
    assert.match(out, /miner-emission/);
    assert.match(out, /5Txyz/);
    assert.match(out, /abc1234def56/);
    assert.match(out, /neurons\/validator\.py/);
  });

  test("a read that found nothing says so rather than printing blanks", () => {
    const out = formatCandidate({
      ...ROW,
      found: false,
      declared_share: null,
      treasury_address: null,
      applies_to: null,
      evidence_path: null,
    });
    assert.match(out, /read, nothing allocated/);
    assert.equal(/%/.test(out), false);
  });

  test("a partial finding prints the parts it has", () => {
    // A finding can name an address without a share, or the reverse. Printing
    // "undefined" for the missing half is how a reviewer approves a row they
    // misread.
    const out = formatCandidate({
      ...ROW,
      declared_share: null,
      applies_to: null,
    });
    assert.match(out, /FINDING: to 5Txyz/);
    assert.equal(/undefined|null/.test(out), false);
  });
});
