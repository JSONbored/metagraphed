// #10933: how a surface is allowed to talk about a subnet's treasury allocation.
//
// Sibling of schemas-src/attribution.ts, and for the same reason: the claim
// "this team quietly takes a cut of miner emission" is not retractable once an
// agent has quoted it, so the shape has to make the unsupportable version
// unserialisable rather than merely discouraged.
//
// THE FRAMING THIS FILE ENFORCES. A treasury allocation written into a public
// repo is a DISCLOSED BUSINESS MODEL, not a discovery. Most subnets take none,
// and for most of the rest the declared share will match what the chain shows.
// The publishable signal is `declared_matches_observed`, and agreement is the
// normal, expected, prominently-published answer.
//
// THREE STATES THAT MUST NOT COLLAPSE INTO TWO:
//
//   nobody has read this repo          -> no record at all
//   read at a commit, found nothing    -> a record with `found: false`
//   read at a commit, found a cut      -> a record with the finding
//
// The middle one is evidence. The first is silence. A surface that renders both
// as "no treasury cut" is making a claim about every subnet nobody got to.
import { z } from "zod";

/** What the allocation is taken out of. Narrow on purpose: each value names a
 * place in a codebase a reviewer can go and look at. */
export const TREASURY_APPLIES_TO_VALUES = [
  "miner-emission",
  "validator-emission",
  "payout",
  "fee",
] as const;
export const TreasuryAppliesToSchema = z.enum(TREASURY_APPLIES_TO_VALUES);

/**
 * How far a reading has got through the human gate.
 *
 * DELIBERATELY NOT the registry's community-submitted/maintainer-reviewed/
 * rejected vocabulary. That axis is about a contribution somebody offered; this
 * one is about a machine reading nobody offered, promoted by a maintainer from
 * a private lane. Sharing the words would imply a shared workflow and invite a
 * contributor to think they can submit one.
 */
export const TREASURY_REVIEW_STATES = [
  "candidate",
  "reviewed",
  "rejected",
] as const;
export const TreasuryReviewStateSchema = z.enum(TREASURY_REVIEW_STATES);

/**
 * The citation. `read_at_sha` is required and that is the whole point: a branch
 * moves under a claim, so the evidence for a finding is the commit that was
 * HEAD when it was read. A reading without one cannot be constructed.
 */
export const TreasuryEvidenceSchema = z
  .object({
    source_url: z.string().meta({
      description:
        "The public repository surface that was read. Points at a branch, correctly — a human clicks this and wants the current code. The pinned half is `read_at_sha`.",
    }),
    read_at_sha: z.string().min(7).meta({
      description:
        "The commit that was HEAD when this repo was read. THE CITATION: it is what makes the finding re-derivable by someone who does not trust us, and what a re-read diffs against to know the repo moved.",
    }),
    evidence_path: z.string().nullable().optional().meta({
      description:
        "Where in the repo, so a reviewer opens the right file rather than the whole project.",
    }),
    observed_at: z.string().meta({
      description:
        "When this reading was taken. A citation without a date cannot be aged out, and a repo that has moved since is exactly what re-reading exists to catch.",
    }),
  })
  .strict();

// The WRITE-side schema (a reading as an extractor produces it) deliberately
// does not live here. The extractor runs in metagraphed-infra against
// DATABASE_URL with no route in front of it, so a Zod schema in this repo could
// not gate it -- the enforcement that actually fires is the CHECK constraints
// in migrations/neon/0028_treasury_readings.sql, which refuse a finding with
// nothing found and a non-finding carrying a share. A copy here would be a
// second statement of the same rules that nothing validates against.
