// GET /api/v1/subnets/{netuid}/surface-history (#9612): when this subnet's
// public surfaces were added, changed or removed, and in which commit.
//
// `surface_history` has recorded every registry surface mutation since
// 2026-04-06 -- 8,892 rows measured 2026-08-06 -- and had no SELECT anywhere in
// the repo. The registry publishes what a subnet exposes TODAY; this answers
// when that became true, which is the question behind "did this API move?" and
// "when did this subnet stop publishing an OpenAPI spec?".
//
// ## IDENTITY IS COALESCED, AND THE FALLBACK IS NOT DEFENSIVE
//
// The upsert path omitted `surface_id` from its INSERT column list, so 8,831 of
// those rows carried a NULL and only the 61 deletes recorded one. 0024
// backfilled the column from `overlay.$.id` -- available on every row, because
// the overlay is the whole surface record -- and the writer now records it.
//
// This reader still coalesces column -> overlay rather than trusting the
// column, for a reason that outlives the fix: the backfill is a hand-applied
// migration (migrations are applied by hand here), so a fresh environment, a
// preview database, or a restore from before it will have the nulls back. The
// fallback costs one json_extract and removes an entire class of "works in
// production, empty in preview".
//
// ## THE OVERLAY IS READ, NOT REPUBLISHED
//
// Each row stores the full surface record as a blob. Serving it verbatim would
// put a ~700-byte JSON document on every entry, most of it unchanged between
// consecutive rows, and would re-publish fields the surface schema owns. Only
// the three that identify WHAT changed are lifted out -- kind, url, name -- and
// the rest stays in the table. A caller wanting the full record reads
// /subnets/{netuid}/surfaces, which is that document's actual home.

import {
  SURFACE_HISTORY_LIMIT_DEFAULT,
  SURFACE_HISTORY_LIMIT_MAX,
} from "./route-limits.ts";

export { SURFACE_HISTORY_LIMIT_DEFAULT, SURFACE_HISTORY_LIMIT_MAX };

type Row = Record<string, unknown>;

/** The minimal D1 surface used here, so tests can inject a plain object. */
export interface SurfaceHistoryDb {
  prepare(sql: string): {
    bind(...values: unknown[]): {
      all?(): Promise<{ results?: unknown[] } | null>;
    };
  };
}

export const SURFACE_HISTORY_TABLE = "surface_history";

/** The mutations the writer records. `delete` is the one that matters most to a
 * consumer: it is the only evidence a surface ever existed. */
export const SURFACE_HISTORY_ACTIONS = ["insert", "update", "delete"] as const;

/**
 * One subnet's trail, newest first. Null when the read fails.
 *
 * COALESCE, not a bare column read -- see the module header. `json_extract` is
 * plain SQLite and the fallback is what makes this correct on a database the
 * 0024 backfill has not been applied to.
 */
export async function loadSurfaceHistory(
  db: SurfaceHistoryDb | null | undefined,
  netuid: number,
  { limit = SURFACE_HISTORY_LIMIT_DEFAULT }: { limit?: number } = {},
): Promise<Row[] | null> {
  if (!db?.prepare) return null;
  try {
    const res = await (
      db
        .prepare(
          `SELECT COALESCE(surface_id, json_extract(overlay, '$.id')) AS surface_id,` +
            ` action, source_commit, recorded_at,` +
            ` json_extract(overlay, '$.kind') AS kind,` +
            ` json_extract(overlay, '$.url') AS url,` +
            ` json_extract(overlay, '$.name') AS name` +
            ` FROM ${SURFACE_HISTORY_TABLE} WHERE subnet_netuid = ?` +
            ` ORDER BY recorded_at DESC, id DESC LIMIT ${limit}`,
        )
        .bind(netuid) as {
        all?(): Promise<{ results?: unknown[] } | null>;
      }
    ).all?.();
    return (res?.results ?? []) as Row[];
  } catch {
    return null;
  }
}

/**
 * Shape the card. Pure, so the same rows produce the same payload wherever they
 * came from.
 *
 * A subnet with no recorded mutations returns an EMPTY trail, never a 404:
 * "nothing has changed here" is a real answer, and the common one for a subnet
 * whose surfaces have been stable.
 */
export function buildSurfaceHistory(
  rows: Row[] | null | undefined,
  netuid: unknown,
  { limit }: { limit?: number } = {},
): Row {
  const changes = (Array.isArray(rows) ? rows : [])
    .map((r) => ({
      surface_id: stringOrNull(r?.surface_id),
      action: knownAction(r?.action),
      kind: stringOrNull(r?.kind),
      url: stringOrNull(r?.url),
      name: stringOrNull(r?.name),
      source_commit: stringOrNull(r?.source_commit),
      recorded_at: toIsoOrNull(r?.recorded_at),
    }))
    // A row with no usable timestamp cannot be placed in a trail, and a trail is
    // an ordering -- so it is dropped rather than served at an unknown position.
    .filter((c) => c.recorded_at !== null);

  return {
    schema_version: 1,
    netuid,
    limit: limit ?? null,
    change_count: changes.length,
    // Distinct surfaces this subnet has ever had a recorded mutation for. Not
    // the same as its CURRENT surface count -- a deleted surface is counted
    // here and absent there, which is the difference this route exists to show.
    surface_count: new Set(
      changes
        .map((c) => c.surface_id)
        .filter((id): id is string => id !== null),
    ).size,
    latest_change_at: changes.length ? changes[0].recorded_at : null,
    changes,
  };
}

/**
 * A recognised action, or null.
 *
 * Not passed through verbatim: the value reaches the payload as a published
 * enum, and an unrecognised string would either break a typed client or teach a
 * consumer a vocabulary this API does not actually define.
 */
function knownAction(value: unknown): string | null {
  return typeof value === "string" &&
    (SURFACE_HISTORY_ACTIONS as readonly string[]).includes(value)
    ? value
    : null;
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
