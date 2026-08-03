// Chain-activity served from a SCHEDULED PROJECTION artifact when the
// Postgres tier misses (#9146). Same shape as src/chain-transfers-artifact.ts
// (see that header for the projection-vs-reader argument): the chain-activity
// lane stores data-api's per-UTC-day extrinsics/blocks aggregates — with the
// DISTINCT-signer counts already merged into the extrinsic rows, exactly as
// data-api merges them — for every supported window, and this reader hands
// them to the SAME buildChainActivity formatter the Postgres tier fed. The
// handlers' own #8242 window trim applies AFTER this tier resolves, exactly
// as it applies to a live Postgres answer.

import { buildChainActivity } from "./chain-analytics.ts";
import {
  ANALYTICS_WINDOWS,
  DEFAULT_ANALYTICS_WINDOW,
} from "../workers/config.ts";

export const CHAIN_ACTIVITY_PROJECTION_KEY =
  "metagraph/projections/chain-activity.json";

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

interface ArtifactBucket {
  get(key: string): Promise<{ json(): Promise<unknown> } | null>;
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
): Promise<ReturnType<typeof buildChainActivity> | null> {
  const bucket = (env as { METAGRAPH_ARCHIVE?: ArtifactBucket } | null)
    ?.METAGRAPH_ARCHIVE;
  if (!bucket?.get) return null;
  try {
    const object = await bucket.get(CHAIN_ACTIVITY_PROJECTION_KEY);
    if (!object) return null;
    const body = (await object.json()) as {
      schema_version?: unknown;
      windows?: unknown;
    } | null;
    // A body that is not the artifact the lane wrote is a decline, not a
    // guess — same contract as src/top-holders-artifact.ts.
    if (
      body?.schema_version !== 1 ||
      typeof body.windows !== "object" ||
      body.windows === null
    ) {
      return null;
    }
    const label = query.window ?? DEFAULT_ANALYTICS_WINDOW;
    // A window outside the route's set — or one this artifact does not carry
    // — must never be answered with a DIFFERENT window's numbers.
    if (!Object.hasOwn(ANALYTICS_WINDOWS, label)) return null;
    const win = (body.windows as Record<string, unknown>)[label] as {
      extrinsic_rows?: unknown;
      block_rows?: unknown;
      newest_observed?: unknown;
    } | null;
    if (!Array.isArray(win?.extrinsic_rows) || !Array.isArray(win?.block_rows))
      return null;
    return buildChainActivity({
      window: label,
      observedAt: newestObservedIso(win.newest_observed),
      extrinsicRows: win.extrinsic_rows as Record<string, unknown>[],
      blockRows: win.block_rows as Record<string, unknown>[],
    });
  } catch {
    return null;
  }
}
