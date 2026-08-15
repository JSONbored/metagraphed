// GET /api/v1/review/attribution-candidates (#11227): the queue the attribution
// sweep exists to fill, in front of the human it exists to reach.
//
// #10818 fixed the sweep so it actually fetches sources, and it started writing
// to `attribution_candidates` — a table **nothing read**. No route, no handler,
// no artifact. src/attribution-sweep.ts's own header says why that is not a
// small gap:
//
//   > Clearing docs/nametag-evidence-bar.md is a human judgement, and this lane
//   > exists to put candidates in front of one, not to skip it.
//
// A candidate nobody can see is the same as no candidate, so the fix converted
// one silent failure (finding nothing) into another (finding things nobody
// looks at).
//
// ## A CANDIDATE IS NOT AN ATTRIBUTION, AND THIS SURFACE MUST NOT READ AS ONE
//
// Every row here is an ss58 string that appeared in a blob of text on a page a
// subnet published. That is a lead. The common false positive is a validator
// hotkey inside an API response — somebody else's key, published by them — and
// nothing in this table distinguishes it from a team's own treasury. So this
// route lives under `/review/`, beside the other surfaces whose job is to hand
// a person something to check, and it carries `source_url` on every row so a
// reviewer goes and looks at the page rather than trusting the row.
//
// ## THE LISTING RULE IS APPLIED AGAIN AT READ TIME, FROM THE DATA
//
// The sweep already drops a source that yielded more than LISTING_ADDRESS_CAP
// distinct addresses: "this page is a listing" is a fact about the page, and
// keeping the first twelve of a metagraph dump would be twelve strangers' keys
// chosen by document order. That cap is enforced when a row is WRITTEN.
//
// It is re-derived here, over the table, for three reasons that are not
// belt-and-braces:
//
//   1. ROWS OUTLIVE THE RULE. Measured 2026-08-15: the table held 4,913 rows
//      from 87 sources, of which 25 sources — `/allHolders`, `/api/miners`,
//      `/snap/metagraph` and their kin — accounted for 4,751. Those predate the
//      cap. A reader that trusts the writer serves a queue that is 97%
//      somebody else's keys, forever, and no backfill makes that not true of
//      the NEXT rule change.
//   2. THE CAP CAN MOVE. It is a judgement calibrated on an empty band in one
//      day's distribution, and its own comment says so. When it moves, a
//      read-time derivation moves the whole history with it; a write-time-only
//      one leaves a stratum behind.
//   3. IT COSTS NOTHING TO BE RIGHT. The population is small and the rule is a
//      GROUP BY over a table that is already being read.
//
// Applying it leaves **162 rows across 49 subnets from 62 sources** against the
// same 4,913 — which is the difference between a queue and a landfill.
//
// ## AND THE SUPPRESSION IS PUBLISHED, NEVER SILENT
//
// A filter a caller cannot see is a filter they cannot check. `suppressed_count`,
// `suppressed_source_count` and `listing_address_cap` ride on every response, so
// "162 candidates" reads as "162 of 4,913, the rest from 25 pages that are
// listings" rather than as the whole population. That is also the number to
// watch: if it stops falling as a share, the sweep's fan-out needs narrowing
// before a human is asked to read the result.
//
// ## COUNTS ARE UNBOUNDED, THE LIST IS BOUNDED
//
// The registry's older list routes publish no totals at all, so counting a
// limited fetch silently reports the limit as the population. This one reports
// `reviewable_count` over the whole table beside a `?limit=`-trimmed array, so
// the two can never be confused.

import { LISTING_ADDRESS_CAP } from "./attribution-sweep.ts";
import { ATTRIBUTION_CANDIDATES_LIMIT_DEFAULT } from "./route-limits.ts";
import type {
  AttributionCandidate,
  AttributionCandidatesReviewArtifact,
} from "../schemas-src/routes/attribution-candidates-review.ts";

type Row = Record<string, unknown>;

/** The minimal store surface used here — the owned `query()` verb, served by
 * both readStore and the producer store — so tests can inject a plain
 * object. */
export interface AttributionCandidatesDb {
  query?<T>(text: string, values?: unknown[]): Promise<T[]>;
}

export const ATTRIBUTION_CANDIDATES_TABLE = "attribution_candidates";

/** Sources whose distinct-address count puts them over the cap. Shared by both
 * statements below so the rule cannot be stated twice and drift once. */
const PER_SOURCE_CTE =
  `per_source AS (SELECT source_url, COUNT(DISTINCT ss58) AS addrs` +
  ` FROM ${ATTRIBUTION_CANDIDATES_TABLE} GROUP BY source_url)`;

export interface AttributionCandidatesTotals {
  reviewable: number;
  suppressed: number;
  suppressedSources: number;
}

/**
 * The population, before any `?limit=`.
 *
 * A SEPARATE STATEMENT rather than a window function on the page: the counts
 * describe the whole table and the page describes a slice of it, and computing
 * one from the other is exactly the confusion this route exists not to make.
 */
export async function loadAttributionCandidateTotals(
  db: AttributionCandidatesDb | null | undefined,
  { netuid }: { netuid?: number } = {},
): Promise<AttributionCandidatesTotals | null> {
  if (!db?.query) return null;
  const scoped = typeof netuid === "number";
  try {
    const rows = await db.query<Row>(
      `WITH ${PER_SOURCE_CTE}` +
        ` SELECT` +
        ` COUNT(*) FILTER (WHERE p.addrs <= ?) AS reviewable,` +
        ` COUNT(*) FILTER (WHERE p.addrs > ?) AS suppressed,` +
        ` COUNT(DISTINCT c.source_url) FILTER (WHERE p.addrs > ?)` +
        ` AS suppressed_sources` +
        ` FROM ${ATTRIBUTION_CANDIDATES_TABLE} c` +
        ` JOIN per_source p ON p.source_url = c.source_url` +
        (scoped ? ` WHERE c.netuid = ?` : ``),
      scoped
        ? [
            LISTING_ADDRESS_CAP,
            LISTING_ADDRESS_CAP,
            LISTING_ADDRESS_CAP,
            netuid,
          ]
        : [LISTING_ADDRESS_CAP, LISTING_ADDRESS_CAP, LISTING_ADDRESS_CAP],
    );
    const row = rows[0];
    if (!row) return null;
    return {
      reviewable: countOf(row.reviewable),
      suppressed: countOf(row.suppressed),
      suppressedSources: countOf(row.suppressed_sources),
    };
  } catch {
    return null;
  }
}

/**
 * One page of reviewable candidates, newest-seen first within a subnet.
 *
 * `source_address_count` rides on every row because it is the reviewer's first
 * filter: an address found on a page carrying eleven others is a weaker lead
 * than one found on a page carrying only it, and that is visible here without
 * opening anything.
 */
export async function loadAttributionCandidates(
  db: AttributionCandidatesDb | null | undefined,
  {
    netuid,
    limit = ATTRIBUTION_CANDIDATES_LIMIT_DEFAULT,
    offset = 0,
  }: { netuid?: number; limit?: number; offset?: number } = {},
): Promise<Row[] | null> {
  if (!db?.query) return null;
  const scoped = typeof netuid === "number";
  try {
    return await db.query<Row>(
      `WITH ${PER_SOURCE_CTE}` +
        ` SELECT c.netuid, c.ss58, c.source_url, c.first_seen, c.last_seen,` +
        ` p.addrs AS source_address_count` +
        ` FROM ${ATTRIBUTION_CANDIDATES_TABLE} c` +
        ` JOIN per_source p ON p.source_url = c.source_url` +
        ` WHERE p.addrs <= ?` +
        (scoped ? ` AND c.netuid = ?` : ``) +
        // Deterministic to the last key, so two identical requests return the
        // same page: an unstable ORDER BY under an OFFSET silently drops and
        // repeats rows across a reviewer's pagination.
        ` ORDER BY c.netuid ASC, c.last_seen DESC, c.ss58 ASC, c.source_url ASC` +
        ` LIMIT ? OFFSET ?`,
      scoped
        ? [LISTING_ADDRESS_CAP, netuid, limit, offset]
        : [LISTING_ADDRESS_CAP, limit, offset],
    );
  } catch {
    return null;
  }
}

/**
 * Shape the queue. Pure, so the same rows produce the same payload wherever
 * they came from.
 *
 * An empty queue is a real answer: every candidate reviewed, or every source a
 * listing, or a subnet nobody has swept. `reviewable_count` beside an empty
 * array is what tells those apart from a truncated page.
 */
export function buildAttributionCandidatesReview(
  rows: Row[] | null | undefined,
  totals: AttributionCandidatesTotals | null,
  {
    netuid,
    limit,
    offset,
  }: { netuid?: number; limit?: number; offset?: number } = {},
): AttributionCandidatesReviewArtifact {
  const candidates: AttributionCandidate[] = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const ss58 = stringOrNull(row?.ss58);
    const sourceUrl = stringOrNull(row?.source_url);
    const subnet = intOrNull(row?.netuid);
    // A row that cannot name the address, the page it came from, or the subnet
    // it was swept for is not reviewable — those three ARE the review.
    if (ss58 === null || sourceUrl === null || subnet === null) continue;
    candidates.push({
      netuid: subnet,
      ss58,
      source_url: sourceUrl,
      first_seen: toIsoOrNull(row?.first_seen),
      last_seen: toIsoOrNull(row?.last_seen),
      source_address_count: intOrNull(row?.source_address_count),
    });
  }

  return {
    schema_version: 1,
    netuid: typeof netuid === "number" ? netuid : null,
    limit: typeof limit === "number" ? limit : null,
    offset: typeof offset === "number" ? offset : null,
    // Rows on THIS page.
    candidate_count: candidates.length,
    // The population the page is a slice of, over the whole table. Null when
    // the totals read failed — never defaulted to the page length, which would
    // report the limit as the population.
    reviewable_count: totals ? totals.reviewable : null,
    // What the listing rule removed, so the filter is checkable rather than
    // invisible.
    suppressed_count: totals ? totals.suppressed : null,
    suppressed_source_count: totals ? totals.suppressedSources : null,
    // The rule itself, published so a reader can reproduce the split.
    listing_address_cap: LISTING_ADDRESS_CAP,
    candidates,
  };
}

/** A decline, for a read that could not be made at all. */
export function declineAttributionCandidatesReview(
  reason: "unavailable",
  {
    netuid,
    limit,
    offset,
  }: { netuid?: number; limit?: number; offset?: number } = {},
): AttributionCandidatesReviewArtifact {
  return {
    schema_version: 1,
    netuid: typeof netuid === "number" ? netuid : null,
    limit: typeof limit === "number" ? limit : null,
    offset: typeof offset === "number" ? offset : null,
    degraded: { reason },
    // NULL, not zero. A zero would assert the sweep has found nothing, which
    // is the lane's most important NEGATIVE result and must never be
    // manufactured by a failed read.
    candidate_count: null,
    reviewable_count: null,
    suppressed_count: null,
    suppressed_source_count: null,
    listing_address_cap: LISTING_ADDRESS_CAP,
    candidates: [],
  };
}

/** A count from the store. `COUNT(*)` arrives as a string from node-postgres
 * whenever the value is not exactly representable, so it is parsed rather than
 * asserted to be a number. */
function countOf(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : 0;
}

function intOrNull(value: unknown): number | null {
  if (value == null) return null;
  const n = Number(value);
  return Number.isInteger(n) ? n : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function toIsoOrNull(value: unknown): string | null {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  const date = new Date(n);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}
