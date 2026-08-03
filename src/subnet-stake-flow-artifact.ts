// One subnet's stake flow served from the SAME scheduled projection artifact
// the chain-wide route reads (#9146).
//
// NO NEW LANE, AND THAT IS THE POINT. The chain-stake-flow lane already
// groups by (netuid, event_kind) — the per-subnet numbers were being computed,
// written to R2, and then thrown away, while
// GET /api/v1/subnets/{netuid}/stake-flow served zeros. This reader filters
// the rows the lane already wrote to one netuid and hands them to the SAME
// buildStakeFlow formatter the Postgres tier fed, so the two routes cannot
// disagree about a subnet's flow: they are two slices of one aggregate.
//
// `direction` is applied here rather than in the lane. data-api narrowed it in
// SQL (`AND event_kind = ...`), but the projection stores both kinds per
// netuid, so the identical narrowing is a row filter — exact, not an
// approximation, because buildStakeFlow attributes each kind independently.
//
// The subnet route accepts a 90d window the chain route does not, which is why
// the lane computes the UNION of both window sets
// (STAKE_FLOW_PROJECTION_WINDOWS in projection-lanes.ts). A window this
// artifact does not carry is declined, never answered with another window's
// numbers.

import {
  buildStakeFlow,
  DEFAULT_STAKE_FLOW_WINDOW,
  STAKE_ADDED_KIND,
  STAKE_FLOW_WINDOWS,
  STAKE_REMOVED_KIND,
} from "./stake-flow.ts";
import { CHAIN_STAKE_FLOW_PROJECTION_KEY } from "./chain-stake-flow-artifact.ts";

interface ArtifactBucket {
  get(key: string): Promise<{ json(): Promise<unknown> } | null>;
}

export interface SubnetStakeFlowFromArtifact {
  data: ReturnType<typeof buildStakeFlow>;
  /** Newest event behind the window, for the envelope's generated_at. */
  generatedAt: string | null;
}

/** The event_kind a `direction` narrows to, or null for "both". */
function kindForDirection(direction: string | null | undefined): string | null {
  if (direction === "in") return STAKE_ADDED_KIND;
  if (direction === "out") return STAKE_REMOVED_KIND;
  return null;
}

/**
 * One subnet's projected stake flow, or null when the artifact store cannot
 * answer FAITHFULLY (unbound, missing object, unrecognized body, a window the
 * lane did not precompute) so the caller keeps its schema-stable empty.
 * Decline, never approximate.
 */
export async function loadSubnetStakeFlowFromArtifact(
  env: Env | null | undefined,
  netuid: number,
  query: { window?: string | null; direction?: string | null } = {},
): Promise<SubnetStakeFlowFromArtifact | null> {
  const bucket = (env as { METAGRAPH_ARCHIVE?: ArtifactBucket } | null)
    ?.METAGRAPH_ARCHIVE;
  if (!bucket?.get) return null;
  try {
    const object = await bucket.get(CHAIN_STAKE_FLOW_PROJECTION_KEY);
    if (!object) return null;
    const body = (await object.json()) as {
      schema_version?: unknown;
      windows?: unknown;
    } | null;
    // A body that is not the artifact the lane wrote is a decline, not a guess.
    if (
      body?.schema_version !== 1 ||
      typeof body.windows !== "object" ||
      body.windows === null
    ) {
      return null;
    }
    const label = query.window ?? DEFAULT_STAKE_FLOW_WINDOW;
    if (!Object.hasOwn(STAKE_FLOW_WINDOWS, label)) return null;
    const win = (body.windows as Record<string, unknown>)[label] as {
      rows?: unknown;
    } | null;
    if (!Array.isArray(win?.rows)) return null;

    const wanted = kindForDirection(query.direction);
    const rows = (win.rows as Record<string, unknown>[]).filter(
      (row) =>
        Number(row?.netuid) === netuid &&
        (wanted === null || row?.event_kind === wanted),
    );
    // A subnet with no stake events in the window is a genuine zero, not a
    // decline: the lane DID cover it, the answer is simply nothing moved.
    return {
      data: buildStakeFlow(rows, netuid, { window: label }),
      generatedAt: latestObserved(rows),
    };
  } catch {
    return null;
  }
}

/** Newest `last_observed` across the rows, as ISO, or null when absent. */
function latestObserved(rows: Record<string, unknown>[]): string | null {
  let newest: number | null = null;
  for (const row of rows) {
    const value = Number(row?.last_observed);
    if (Number.isFinite(value) && (newest === null || value > newest)) {
      newest = value;
    }
  }
  return newest === null ? null : new Date(newest).toISOString();
}
