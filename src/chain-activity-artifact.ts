// Chain-activity served from a SCHEDULED PROJECTION artifact when the
// Postgres tier misses (#9146). Same shape as src/chain-transfers-artifact.ts
// (see that header for the projection-vs-reader argument): the chain-activity
// lane stores data-api's per-UTC-day extrinsics/blocks aggregates — with the
// DISTINCT-signer counts already merged into the extrinsic rows, exactly as
// data-api merges them — for every supported window, and this reader hands
// them to the SAME buildChainActivity formatter the Postgres tier fed. The
// handlers' own #8242 window trim applies AFTER this tier resolves, exactly
// as it applies to a live Postgres answer.

import { z } from "zod";

import { buildChainActivity } from "./chain-analytics.ts";
import { readProjectionWindow } from "./projection-store.ts";
import { ProjectionRowsSchema } from "../schemas-src/projection-artifact.ts";
import { type ChainNetworkId, DEFAULT_CHAIN_NETWORK } from "./chain-network.ts";
import {
  ANALYTICS_WINDOW_DAYS,
  DEFAULT_ANALYTICS_WINDOW,
} from "../workers/config.ts";

export const CHAIN_ACTIVITY_PROJECTION_KEY =
  "metagraph/projections/chain-activity.json";

/**
 * TWO row sets per window, and both are required.
 *
 * The card joins extrinsic counts to block counts per day; a cell carrying only
 * one of them cannot be halved into a partial answer, so it declines.
 * `newest_observed` stays `unknown` because `newestObservedIso` already owns
 * the coercion and returns null for anything unusable.
 */
const ChainActivityCellSchema = z.object({
  extrinsic_rows: ProjectionRowsSchema,
  block_rows: ProjectionRowsSchema,
  newest_observed: z.unknown().optional(),
});

const DAY_MS = 24 * 60 * 60 * 1000;

/** Render one integer UTC epoch-day (the day key the lane GROUPs BY, since
 * R2 SQL has no proven date-render function) as the 'YYYY-MM-DD' label
 * data-api's to_char(to_timestamp(...)) produces for the same rows, or null
 * for anything that is not a renderable non-negative day index. Lives here so
 * the writer (src/projection-lanes.ts) and any future reader share one
 * definition of the day boundary. */
export function epochDayIso(dayIndex: unknown): string | null {
  // Number(null) and Number("") both coerce to 0 — a "valid" epoch day.
  // A missing index must decline, never silently label rows 1970-01-01
  // (src/r2-sql.ts's safeBlockNumber guards the same trap).
  if (dayIndex == null) return null;
  if (typeof dayIndex === "string" && dayIndex.trim() === "") return null;
  const n = Number(dayIndex);
  if (!Number.isFinite(n) || n < 0) return null;
  const date = new Date(n * DAY_MS);
  return Number.isFinite(date.getTime())
    ? date.toISOString().slice(0, 10)
    : null;
}

/** data-api's latestObservedIso over the stored blocks freshness read: the
 * queried rows' own MAX(observed_at) as ISO, or null. */
function newestObservedIso(value: unknown): string | null {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? new Date(n).toISOString() : null;
}

/**
 * The projected chain-activity daily series for one window, or null when the
 * artifact store cannot answer FAITHFULLY (unbound, missing object,
 * unrecognized body, a window the lane did not precompute) so the caller
 * keeps its schema-stable empty. Decline, never approximate.
 */
export async function loadChainActivityFromArtifact(
  env: Env | null | undefined,
  query: { window?: string | null },
  /** Which chain's projection to read (#9412). */
  network: ChainNetworkId = DEFAULT_CHAIN_NETWORK,
): Promise<ReturnType<typeof buildChainActivity> | null> {
  const read = await readProjectionWindow(env, {
    key: CHAIN_ACTIVITY_PROJECTION_KEY,
    network,
    window: query.window,
    defaultWindow: DEFAULT_ANALYTICS_WINDOW,
    windows: ANALYTICS_WINDOW_DAYS,
    cell: ChainActivityCellSchema,
  });
  if (!read) return null;
  return buildChainActivity({
    window: read.label,
    observedAt: newestObservedIso(read.cell.newest_observed),
    extrinsicRows: read.cell.extrinsic_rows,
    blockRows: read.cell.block_rows,
  });
}
