// Block-production summary served from a SCHEDULED PROJECTION artifact when
// the Postgres tier misses (#9146).
//
// STORES THE CARD, NOT THE ROWS -- unlike the chain-* lanes, which store rows
// verbatim so one artifact can serve every window/limit the route accepts.
// GET /api/v1/blocks/summary takes NO parameters (validateQueryParams(url, [])),
// so there is exactly one output shape, and shipping 5,000 raw block rows to
// R2 to re-derive that one shape on every request would be pure overhead.
//
// WHY A PROJECTION AND NOT A COLD-TIER READER. loadBlockColdTier answers a
// single block by key; this is an aggregate over the last
// BLOCKS_SUMMARY_SCAN_CAP blocks with percentiles and an authorship
// concentration scorecard. #9146 is explicit that request-time scans of the
// large chain tables are the wrong shape for R2 SQL (~1-2s/query, no indexes)
// and that scheduled projections are the right one.
//
// The card is written by the lane using the SAME buildBlocksSummary shaper the
// Postgres tier fed, so a summary served from R2 is identical in shape to one
// served from Postgres.

import type { BlocksSummaryResult } from "./blocks-summary.ts";

export const BLOCKS_SUMMARY_PROJECTION_KEY =
  "metagraph/projections/blocks-summary.json";

interface ArtifactBucket {
  get(key: string): Promise<{ json(): Promise<unknown> } | null>;
}

/**
 * The projected block-production summary, or null when the artifact store
 * cannot answer FAITHFULLY (unbound, missing object, unrecognized body) so the
 * caller keeps its schema-stable zeroed card. Decline, never approximate.
 */
export async function loadBlocksSummaryFromArtifact(
  env: Env | null | undefined,
): Promise<BlocksSummaryResult | null> {
  const bucket = (env as { METAGRAPH_ARCHIVE?: ArtifactBucket } | null)
    ?.METAGRAPH_ARCHIVE;
  if (!bucket?.get) return null;
  try {
    const object = await bucket.get(BLOCKS_SUMMARY_PROJECTION_KEY);
    if (!object) return null;
    const body = (await object.json()) as {
      schema_version?: unknown;
      summary?: unknown;
    } | null;
    // A body that is not the artifact the lane wrote is a decline, not a guess.
    if (
      body?.schema_version !== 1 ||
      typeof body.summary !== "object" ||
      body.summary === null
    ) {
      return null;
    }
    return body.summary as BlocksSummaryResult;
  } catch {
    return null;
  }
}
