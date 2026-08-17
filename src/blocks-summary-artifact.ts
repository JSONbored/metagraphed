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

import { z } from "zod";

import { type ChainNetworkId, DEFAULT_CHAIN_NETWORK } from "./chain-network.ts";
import { readArtifactObject } from "./projection-store.ts";
import {
  type BlocksSummaryArtifact,
  BlocksSummaryArtifactSchema,
} from "../schemas-src/routes/blocks-summary.ts";

export const BLOCKS_SUMMARY_PROJECTION_KEY =
  "metagraph/projections/blocks-summary.json";

/**
 * The stored envelope, validated against the schema the ROUTE publishes.
 *
 * This one is not shaped like its windowed siblings -- there is no window set,
 * just a single `summary` -- but it was carrying the worst cast of the group:
 * `body.summary as BlocksSummaryResult` asserted a fully specified RESPONSE
 * shape over arbitrary JSON and then served it. Every field the OpenAPI
 * document promises callers -- `block_time.p90_ms`, `throughput`,
 * `author_concentration` -- was a claim nothing checked, so a drifted artifact
 * reached callers as a response that satisfied the compiler and not the
 * contract.
 *
 * Reusing `BlocksSummaryArtifactSchema` rather than writing a second shape here
 * is the point: the read now proves the stored bytes are exactly what
 * `/api/v1/blocks/summary` publishes, and a lane that drifts from the contract
 * declines to a schema-stable zeroed card instead of serving the drift.
 */
const BlocksSummaryEnvelopeSchema = z.object({
  schema_version: z.literal(1),
  summary: BlocksSummaryArtifactSchema,
});

/**
 * The projected block-production summary, or null when the artifact store
 * cannot answer FAITHFULLY (unbound, missing object, unrecognized body) so the
 * caller keeps its schema-stable zeroed card. Decline, never approximate.
 */
export async function loadBlocksSummaryFromArtifact(
  env: Env | null | undefined,
  /** Which chain's projection to read (#9412). */
  network: ChainNetworkId = DEFAULT_CHAIN_NETWORK,
): Promise<BlocksSummaryArtifact | null> {
  const body = await readArtifactObject(
    env,
    BLOCKS_SUMMARY_PROJECTION_KEY,
    network,
    BlocksSummaryEnvelopeSchema,
  );
  return body?.summary ?? null;
}
