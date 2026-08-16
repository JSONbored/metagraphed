// Chain-transfers served from a SCHEDULED PROJECTION artifact when the
// Postgres tier misses (#9146).
//
// WHY A PROJECTION AND NOT A REQUEST-TIME LAKEHOUSE READER. This route's
// windows anchor to the current date, so the one-shot materialization that
// closed top-holders would rot within a day here — and its five aggregate
// scans over account_events' highest-volume kind are second-scale EACH in
// R2 SQL, fine on a cron and wrong under a request. So the chain-transfers
// projection lane (src/projection-lanes.ts) recomputes every supported window
// on an interval, and this reader serves the stored rows through the SAME
// buildChainTransfers formatter the Postgres tier fed, so a caller cannot
// tell which tier answered.
//
// The artifact holds each window's totals plus both leaderboards precomputed
// at the route's MAXIMUM limit; a smaller ?limit= is a prefix slice of the
// same total order (volume DESC, address ASC), so one artifact serves every
// window/limit combination the route accepts. The slice happens BEFORE the
// formatter because top_sender_share is defined over the returned page —
// data-api computes it from its LIMIT-ed fetch, and this must match.

import { z } from "zod";

import {
  buildChainTransfers,
  CHAIN_TRANSFER_LIMIT_DEFAULT,
  CHAIN_TRANSFER_LIMIT_MAX,
  CHAIN_TRANSFER_WINDOWS,
  DEFAULT_CHAIN_TRANSFER_WINDOW,
} from "./chain-transfers.ts";
import { type ChainNetworkId, DEFAULT_CHAIN_NETWORK } from "./chain-network.ts";
import { readProjectionWindow } from "./projection-store.ts";
import {
  ProjectionRowSchema,
  ProjectionRowsSchema,
} from "../schemas-src/projection-artifact.ts";

export const CHAIN_TRANSFERS_PROJECTION_KEY =
  "metagraph/projections/chain-transfers.json";

/**
 * Totals plus two leaderboards, all required.
 *
 * `totals` is NOT nullable here, unlike its transfer-pairs sibling: this card
 * reads `observed_at` out of it and reports network-wide sums from it, so a
 * cell without one has no whole to report parts of.
 */
const ChainTransfersCellSchema = z.object({
  totals: ProjectionRowSchema,
  senders: ProjectionRowsSchema,
  receivers: ProjectionRowsSchema,
});

/** The route's limit contract (1..100, default 25) re-applied at the reader:
 * both callers pass already-validated values, but a direct call must not
 * page past the route's own maximum. */
function normalizedLimit(value: unknown): number {
  const floored = Math.floor(Number(value));
  if (!Number.isFinite(floored)) return CHAIN_TRANSFER_LIMIT_DEFAULT;
  return Math.max(0, Math.min(floored, CHAIN_TRANSFER_LIMIT_MAX));
}

/** data-api's latestObservedIso over the stored single-row aggregate: the
 * queried rows' own MAX(observed_at) as ISO, or null — the same freshness
 * signal the live tier reported for what was actually read. */
function newestObservedIso(totals: Record<string, unknown>): string | null {
  const n = Number(totals["newest_observed"]);
  return Number.isFinite(n) && n > 0 ? new Date(n).toISOString() : null;
}

/**
 * The projected chain-transfers scorecard for one window, or null when the
 * artifact store cannot answer FAITHFULLY (unbound, missing object,
 * unrecognized body, a window the lane did not precompute) so the caller
 * keeps its schema-stable empty. Decline, never approximate.
 */
export async function loadChainTransfersFromArtifact(
  env: Env | null | undefined,
  query: { window?: string | null; limit?: unknown },
  /** Which chain's projection to read (#9412). */
  network: ChainNetworkId = DEFAULT_CHAIN_NETWORK,
): Promise<ReturnType<typeof buildChainTransfers> | null> {
  const read = await readProjectionWindow(env, {
    key: CHAIN_TRANSFERS_PROJECTION_KEY,
    network,
    window: query.window,
    defaultWindow: DEFAULT_CHAIN_TRANSFER_WINDOW,
    windows: CHAIN_TRANSFER_WINDOWS,
    cell: ChainTransfersCellSchema,
  });
  if (!read) return null;
  const limit = normalizedLimit(query.limit);
  return buildChainTransfers({
    window: read.label,
    observedAt: newestObservedIso(read.cell.totals),
    totals: read.cell.totals,
    senders: read.cell.senders.slice(0, limit),
    receivers: read.cell.receivers.slice(0, limit),
  });
}
