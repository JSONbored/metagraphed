// One subnet's windowed event summary, served from a SCHEDULED PROJECTION
// artifact when the Postgres tier misses (#9146).
//
// WHY THIS CANNOT BE A REQUEST-TIME READ. The summary needs per-event_kind
// counts AND distinct hotkey/coldkey counts. That is the
// `COUNT(DISTINCT) + GROUP BY` shape R2 SQL refuses:
//
//   40015: scan budget exceeded: scanning too much data for count(DISTINCT)
//
// Measured 2026-08-03, it fails at 7d, 30d AND 90d for a single subnet -- and
// even `COUNT(DISTINCT)` with no GROUP BY at all fails on this table. Split
// into its cheap halves it still does not fit a request: the plain aggregate
// with the SUM/MIN/MAX columns is 1.61 GB at 30d for one subnet. The shipped
// request-time readers live at 47-392 MB, so this belongs in a lane.
//
// COVERS EVERY SUBNET IN ONE PASS. The lane groups by (netuid, event_kind)
// rather than per subnet, so 129 subnets cost one query per window instead of
// 129 -- 1,371 groups at 30d.
//
// `recent_events` is NOT in here. It is a short newest-first slice per subnet,
// which loadSubnetEventsColdTier already serves cheaply from
// chain.account_events (#9212) and which honours the caller's ?limit=. Baking
// a fixed slice into a daily artifact would be both staler and less flexible
// than the reader that already exists.

import type { buildSubnetEventSummary } from "./account-events.ts";
import {
  SUBNET_EVENT_SUMMARY_WINDOWS,
  DEFAULT_SUBNET_EVENT_SUMMARY_WINDOW,
} from "./account-events.ts";

export const SUBNET_EVENT_SUMMARY_PROJECTION_KEY =
  "metagraph/projections/subnet-event-summary.json";

interface ArtifactBucket {
  get(key: string): Promise<{ json(): Promise<unknown> } | null>;
}

/** The per-(netuid, event_kind) rows buildSubnetEventSummary consumes. */
export type EventSummaryKindRow = Record<string, unknown>;

/**
 * The stored per-event_kind rows for one subnet and window, or null when the
 * artifact store cannot answer FAITHFULLY (unbound, missing object,
 * unrecognized body, a window the lane did not precompute) so the caller keeps
 * its schema-stable empty. Decline, never approximate.
 *
 * Returns the ROWS rather than a finished payload: the caller still has to
 * pair them with `recent_events` from the events cold tier before handing both
 * to buildSubnetEventSummary, which owns the category rollup.
 */
export async function loadSubnetEventSummaryKindRows(
  env: Env | null | undefined,
  netuid: number,
  window?: string | null,
): Promise<EventSummaryKindRow[] | null> {
  const bucket = (env as { METAGRAPH_ARCHIVE?: ArtifactBucket } | null)
    ?.METAGRAPH_ARCHIVE;
  if (!bucket?.get) return null;
  try {
    const object = await bucket.get(SUBNET_EVENT_SUMMARY_PROJECTION_KEY);
    if (!object) return null;
    const body = (await object.json()) as {
      schema_version?: unknown;
      windows?: unknown;
    } | null;
    if (
      body?.schema_version !== 1 ||
      typeof body.windows !== "object" ||
      body.windows === null
    ) {
      return null;
    }
    const label = window ?? DEFAULT_SUBNET_EVENT_SUMMARY_WINDOW;
    // A window outside the route's set -- or one this artifact does not carry
    // -- must never be answered with a DIFFERENT window's numbers.
    if (!Object.hasOwn(SUBNET_EVENT_SUMMARY_WINDOWS, label)) return null;
    const win = (body.windows as Record<string, unknown>)[label] as {
      rows?: unknown;
    } | null;
    if (!Array.isArray(win?.rows)) return null;

    // A subnet with no rows in a covered window is a genuine zero, not a
    // decline: the lane DID compute the window, nothing happened on it.
    return (win.rows as EventSummaryKindRow[]).filter(
      (row) => Number(row?.netuid) === netuid,
    );
  } catch {
    return null;
  }
}

/** Re-exported so callers type the pairing without importing two modules. */
export type SubnetEventSummary = ReturnType<typeof buildSubnetEventSummary>;
