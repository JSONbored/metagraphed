// #10933: what a subnet's own published source says it allocates to a treasury,
// against what the chain shows.
//
// Some subnets take a share of miner emission in their own validator code,
// applied before emission is ever assigned. That is not a chain event: no
// indexer in this ecosystem can see it, and none does. We can, because the
// registry already tracks 142 `source-repo` surfaces pointing at the exact
// repositories where such an allocation would live.
//
// ## THIS IS A DISCLOSED BUSINESS MODEL, NOT A DISCOVERY
//
// A treasury cut written into a public repo is something the team published. It
// is mostly boring, and for most subnets the answer will be "declared matches
// observed" -- which is the credibility of the whole surface and is published
// as prominently as any divergence. A surface that only surfaced mismatches
// would be an accusation engine with a data source.
//
// ## THREE STATES, AND COLLAPSING THEM IS THE FAILURE
//
//   no record at all      nobody has read this repo        -> silence
//   found: false          read at a commit, found nothing  -> EVIDENCE
//   found: true           read at a commit, found a cut    -> evidence
//
// The middle state is the one that costs work to produce and the one a naive
// shape drops. "No treasury cut found" for a repo nobody opened is a claim
// about every subnet we did not get to.
//
// ## WHAT IS PUBLISHED BEFORE REVIEW, AND WHAT IS NOT
//
// A deterministic extractor writes `candidate` rows from a private lane. Rule 5
// of the issue is that a machine reading is not a measurement, so:
//
//   - the READ STATUS of every row is public -- which repo, which commit, when.
//     That is how "have we looked at this subnet yet" stays answerable, the
//     same way attribution_search already answers it for wallets.
//   - the FINDING is public only once a maintainer has promoted the row.
//
// So an unreviewed candidate publishes "read at abc123 on the 12th, finding
// pending review" and never publishes the share. Both halves are honest and
// neither leaks an unreviewed claim.
//
// Pure shaping only: rows arrive from the store, so the same rows always
// produce the same payload.
import { round9 } from "./lib/rao.ts";
import type { TreasuryReadings } from "../generated/db/types.ts";
import {
  TREASURY_REVIEW_STATES,
  TREASURY_APPLIES_TO_VALUES,
} from "../schemas-src/treasury.ts";

type Row = Record<string, unknown>;

/**
 * One `treasury_readings` row as the store returns it.
 *
 * Was a hand-written interface in #11025, because the migration had not been
 * applied yet and the generated types are introspected from the LIVE schema --
 * they cannot know about a table its own PR is creating. That is now done: the
 * migration applied, the snapshot refreshed, and this is the generated type as
 * that comment promised, so the shape can no longer drift from the column set.
 */
export type TreasuryReadingRow = TreasuryReadings;

/** Tolerance on `declared_matches_observed`. The declared side is a round
 * number a human wrote in a config; the observed side is a ratio of measured
 * emission over a window, so they will never be bit-equal. One percentage
 * point of the SHARE, not of the emission -- a 10% declared cut matches an
 * observed 0.09..0.11. */
export const TREASURY_MATCH_TOLERANCE = 0.01;

export const SUBNET_TREASURY_FIELD_SOURCES = {
  "readings.found": { kind: "measured", storage: "treasury_readings" },
  "readings.declared_share": {
    kind: "measured",
    storage: "treasury_readings",
  },
  "readings.evidence.read_at_sha": {
    kind: "measured",
    storage: "treasury_readings",
  },
  observed_share: { kind: "reconstructed", storage: null },
  declared_matches_observed: { kind: "reconstructed", storage: null },
  repos_read: { kind: "measured", storage: "treasury_readings" },
} as const;

function text(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Millis to ISO, or null. A citation with an unreadable date is not a
 * citation, so a bad cell nulls the field rather than inventing "now". */
function isoOrNull(value: unknown): string | null {
  const ms = Number(value);
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function reviewState(value: unknown): string {
  const s = text(value);
  return s !== null && (TREASURY_REVIEW_STATES as readonly string[]).includes(s)
    ? s
    : "candidate";
}

function appliesTo(value: unknown): string | null {
  const s = text(value);
  return s !== null &&
    (TREASURY_APPLIES_TO_VALUES as readonly string[]).includes(s)
    ? s
    : null;
}

/**
 * One stored row projected to its served shape.
 *
 * THE FINDING IS WITHHELD UNTIL REVIEWED. An unreviewed row publishes its read
 * status and nothing else -- `found` is null rather than false, because "a
 * machine thinks it found nothing" and "nobody has established anything" are
 * the same epistemic state before review and only one of them is a claim.
 */
function readingRow(row: Row): Row {
  const state = reviewState(row?.review_state);
  const published = state === "reviewed";
  const evidence = {
    source_url: text(row?.source_url),
    read_at_sha: text(row?.read_at_sha),
    evidence_path: text(row?.evidence_path),
    observed_at: isoOrNull(row?.observed_at),
    first_seen: isoOrNull(row?.first_seen),
  };
  return {
    review_state: state,
    evidence,
    // Read status is public at every state; the finding is not.
    found: published ? Boolean(row?.found) : null,
    declared_share: published ? finite(row?.declared_share) : null,
    treasury_address: published ? text(row?.treasury_address) : null,
    applies_to: published ? appliesTo(row?.applies_to) : null,
  };
}

/**
 * Compare the declared share against the observed one.
 *
 * TRI-STATE, and the third state is the common one. `null` means the comparison
 * was not possible -- either side unread -- and it must never render as
 * `false`, which reads as "the team is not doing what they said".
 */
export function declaredMatchesObserved(
  declared: number | null,
  observed: number | null,
): boolean | null {
  if (declared === null || observed === null) return null;
  return Math.abs(declared - observed) <= TREASURY_MATCH_TOLERANCE;
}

/**
 * Build one subnet's treasury card.
 *
 * Null-safe: a cold store yields `repos_read: 0` and an empty list, which is
 * the correct answer for the 128 subnets nobody has read yet and is
 * distinguishable from a subnet read with nothing found.
 */
export function buildSubnetTreasury(
  rows: readonly (Row | TreasuryReadingRow)[] | null | undefined,
  netuid: unknown,
  { observed_share }: { observed_share?: number | null } = {},
): Row {
  const list: Row[] = Array.isArray(rows) ? (rows as Row[]) : [];
  const readings = list.map(readingRow);
  const reviewed = readings.filter((r) => r.review_state === "reviewed");

  // The headline declared share is the sum of REVIEWED findings that apply to
  // miner emission -- summing across `applies_to` would add a payout fee to an
  // emission cut, which are taken from different bases.
  const minerCuts = reviewed.filter(
    (r) => r.found === true && r.applies_to === "miner-emission",
  );
  const declaredShare = minerCuts.length
    ? round9(
        minerCuts.reduce(
          (sum, r) => sum + ((r.declared_share as number) ?? 0),
          0,
        ),
      )
    : null;

  const observed = finite(observed_share) ?? null;

  return {
    schema_version: 1,
    netuid,
    // "Have we looked, and at how many of this subnet's repos." Public
    // regardless of review state -- this is the question that stops an empty
    // card reading as "no treasury cut".
    repos_read: readings.length,
    reviewed_count: reviewed.length,
    pending_review_count: readings.length - reviewed.length,
    declared_share: declaredShare,
    observed_share: observed,
    // Tri-state. Null is the normal answer today.
    declared_matches_observed: declaredMatchesObserved(declaredShare, observed),
    readings,
    field_sources: SUBNET_TREASURY_FIELD_SOURCES,
  };
}
