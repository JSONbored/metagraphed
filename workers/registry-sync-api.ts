// metagraphed registry-sync Worker — the ONLY write path into the registry
// database, now D1 (`metagraphed`, schema in migrations/d1/0001_registry.sql).
//
// MOVED OFF THE SELF-HOSTED POSTGRES. The registry lived on a dedicated
// Postgres on the indexer box, reached through Hyperdrive. That box is being
// decommissioned, so the whole tier moved: 9,157 rows across four tables, which
// is roughly 450x under D1's ceiling. The Hyperdrive binding and the postgres.js
// driver are gone from this Worker entirely.
//
// WHAT CHANGED SEMANTICALLY. Three things, each documented where it happens
// rather than only here: the jsonb `overlay` columns are TEXT, so anything
// reading inside them must use json_extract(); `now()` becomes an epoch-ms
// integer; and D1 has no interactive transactions, which reshapes the write
// path into a read phase and one atomic batch (see applyRegistrySyncToD1).
//
// Kept SEPARATE from the main api.ts Worker for the same reason ADR 0013 split
// data-api.ts out -- this is a write tier with its own auth gate, and the main
// Worker should not grow one.
//
// Reached only via the main Worker's REGISTRY_SYNC_API service binding (no
// public routes of its own) -- see workers/api.ts's handleRegistrySyncProxy,
// which forwards the request here unchanged. This Worker's shared-secret
// check below is the only auth gate in the whole path.
//
// This is the write path scripts/sync-registry-to-postgres.ts (merge-
// triggered) and scripts/backfill-registry-postgres.ts (scheduled full
// resync) call over HTTPS from GitHub Actions. GitHub Actions only ever needs
// a REGISTRY_SYNC_SECRET value and the public HTTPS endpoint -- it never had,
// and still does not have, any direct network path to the database.
import { recordExceptionEvent } from "../src/usage-telemetry.ts";
import {
  newSpanId,
  newTraceId,
  recordTraceSpan,
  shouldSampleTrace,
} from "../src/tracing.ts";
import { timingSafeEqual } from "../src/webhooks.ts";
import { resolveClientIp } from "./config.ts";

const TOKEN_HEADER = "x-registry-sync-token";
const MAX_BODY_BYTES = 4_194_304; // 4 MiB -- the full registry is ~1.5k surfaces, comfortably under this
const MAX_ROWS_PER_KIND = 5_000;
// Per-caller abuse control (#5548) -- see wrangler.registry.jsonc's
// REGISTRY_SYNC_RATE_LIMITER comment for why 30/60s rather than the tighter
// 10/60s used by other shared-secret write routes.
const RATE_LIMIT = { limit: 30, windowSeconds: 60 };

interface ProviderSyncRow {
  id?: string;
  overlay?: unknown;
  source_commit?: string;
}
interface SubnetSyncRow {
  netuid?: unknown;
  slug?: string;
  name?: string;
  source?: string;
  overlay?: unknown;
  source_commit?: string;
}
interface PruneSurfacesRow {
  subnet_netuid?: unknown;
  current_surfaces?: unknown;
  source_commit?: string;
  authority_scope?: string;
}
interface DeleteSubnetRow {
  netuid?: unknown;
  source_commit?: string;
}
interface SurfaceSyncRow {
  subnet_netuid?: unknown;
  provider_id?: string | null;
  surface_key?: string;
  kind?: string;
  url?: string;
  authority?: string;
  review_state?: string;
  probe_eligible?: unknown;
  public_safe?: unknown;
  overlay?: unknown;
  source_commit?: string;
}

// Epoch-milliseconds "now", matching the INTEGER convention the D1 schema uses
// for every timestamp column (migrations/d1/0001_registry.sql translation 4).
// Postgres' now() returned a timestamptz; there is no such type here.
const NOW_MS = "(unixepoch() * 1000)";

export interface RegistrySyncSummary {
  providers_written: number;
  subnets_written: number;
  surfaces_written: number;
  surfaces_deleted: number;
  subnets_deleted: number;
}

interface D1Like {
  prepare(sql: string): {
    bind(...values: unknown[]): {
      all(): Promise<{ results?: unknown[] }>;
    };
  };
  batch(statements: unknown[]): Promise<unknown>;
}

interface SurfaceRow {
  id?: unknown;
  subnet_netuid?: unknown;
  overlay?: unknown;
}

function bound(db: D1Like, sql: string, values: unknown[]) {
  return db.prepare(sql).bind(...values);
}

async function readRows(
  db: D1Like,
  sql: string,
  values: unknown[],
): Promise<SurfaceRow[]> {
  const { results } = await bound(db, sql, values).all();
  return (results as SurfaceRow[]) ?? [];
}

// One history row per surface that a prune/delete removed. Split out because
// both the prune path and the delete-subnets path need exactly this, and the
// original Postgres version duplicated it via DELETE ... RETURNING.
function historyForDeleted(
  db: D1Like,
  rows: SurfaceRow[],
  sourceCommit: string,
) {
  return rows.map((row) =>
    bound(
      db,
      `INSERT INTO surface_history (surface_id, subnet_netuid, action, overlay, source_commit, recorded_at)
       VALUES (?, ?, 'delete', ?, ?, ${NOW_MS})`,
      [
        row.id ?? null,
        row.subnet_netuid ?? null,
        typeof row.overlay === "string"
          ? row.overlay
          : JSON.stringify(row.overlay ?? {}),
        sourceCommit,
      ],
    ),
  );
}

/**
 * Apply one sync payload to D1.
 *
 * TWO PHASES, AND WHY. Postgres gave this an interactive transaction
 * (`sql.begin`), so it could DELETE ... RETURNING and then write a history row
 * per returned id inside one atomic unit. D1 has no interactive transactions --
 * `batch()` is a transaction, but it is a fixed list of statements decided
 * before any of them runs. So the reads move to phase 1 and every write lands in
 * a single phase-2 batch.
 *
 * The cost is a TOCTOU window between the two phases, and it is stated here
 * rather than hidden: a surface deleted by a concurrent call between phases
 * would produce a history row for a row that is already gone. That is acceptable
 * for THIS path specifically -- it is CI-only, rate-limited to 30/60s, and in
 * practice serialized by the workflows that call it -- and it is strictly better
 * than the alternative of writing history outside a transaction entirely.
 *
 * Atomicity of the writes themselves is preserved: one batch, all-or-nothing,
 * so a mid-batch failure can no longer leave a partial sync the way the
 * pre-transaction version could.
 */
export async function applyRegistrySyncToD1(
  db: D1Like,
  payload: {
    providers: ProviderSyncRow[];
    subnets: SubnetSyncRow[];
    surfaces: SurfaceSyncRow[];
    pruneSurfaces: PruneSurfacesRow[];
    deleteSubnets: DeleteSubnetRow[];
  },
): Promise<RegistrySyncSummary> {
  const summary: RegistrySyncSummary = {
    providers_written: 0,
    subnets_written: 0,
    surfaces_written: 0,
    surfaces_deleted: 0,
    subnets_deleted: 0,
  };
  const writes: unknown[] = [];

  for (const p of payload.providers) {
    if (!p.id || !p.overlay || !p.source_commit) continue;
    writes.push(
      bound(
        db,
        `INSERT INTO providers (id, overlay, source_commit, updated_at)
         VALUES (?, ?, ?, ${NOW_MS})
         ON CONFLICT (id) DO UPDATE SET
           overlay = excluded.overlay,
           source_commit = excluded.source_commit,
           updated_at = ${NOW_MS}
         -- SQLite's IS NOT is exactly Postgres' IS DISTINCT FROM (NULL-safe),
         -- so the "only touch the row when the overlay actually changed"
         -- semantics carry over verbatim.
         WHERE providers.overlay IS NOT excluded.overlay`,
        [p.id, JSON.stringify(p.overlay), p.source_commit],
      ),
    );
    summary.providers_written += 1;
  }

  const writtenSubnetNetuids = new Set<unknown>();
  for (const s of payload.subnets) {
    if (
      !Number.isInteger(s.netuid) ||
      !s.slug ||
      !s.name ||
      !s.overlay ||
      !s.source_commit
    )
      continue;
    writes.push(
      bound(
        db,
        `INSERT INTO subnets (netuid, slug, name, source, overlay, source_commit, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ${NOW_MS})
         ON CONFLICT (netuid) DO UPDATE SET
           slug = excluded.slug,
           name = excluded.name,
           source = excluded.source,
           overlay = excluded.overlay,
           source_commit = excluded.source_commit,
           updated_at = ${NOW_MS}`,
        [
          s.netuid as number,
          s.slug,
          s.name,
          s.source || "community",
          JSON.stringify(s.overlay),
          s.source_commit,
        ],
      ),
    );
    summary.subnets_written += 1;
    writtenSubnetNetuids.add(s.netuid);
  }

  for (const prune of payload.pruneSurfaces) {
    if (
      !Number.isInteger(prune.subnet_netuid) ||
      !Array.isArray(prune.current_surfaces) ||
      !prune.source_commit
    )
      continue;
    const keep = prune.current_surfaces
      .filter((s) => s?.kind && s?.url)
      .map((s) => ({ k: s.kind, u: s.url }));
    // json_each over ONE bound JSON array rather than 2 placeholders per kept
    // surface. The Postgres version built a VALUES join with positional binds,
    // which here would mean thousands of parameters for a large subnet and run
    // into SQLite's variable ceiling. This also keeps the statement text
    // constant, so D1 can reuse the prepared plan.
    const scopeToCommunity = prune.authority_scope === "community" ? 1 : 0;
    const doomed = await readRows(
      db,
      `SELECT id, subnet_netuid, overlay FROM surfaces
       WHERE subnet_netuid = ?
         AND (? = 0 OR authority = 'community')
         AND NOT EXISTS (
           SELECT 1 FROM json_each(?) AS keep
           WHERE json_extract(keep.value, '$.k') = surfaces.kind
             AND json_extract(keep.value, '$.u') = surfaces.url
         )`,
      [prune.subnet_netuid as number, scopeToCommunity, JSON.stringify(keep)],
    );
    if (!doomed.length) continue;
    // Delete by the exact ids just read, not by re-running the predicate: the
    // history rows below describe THESE rows, and re-evaluating the predicate
    // inside the batch could delete a different set than the one being recorded.
    writes.push(
      bound(
        db,
        `DELETE FROM surfaces WHERE id IN (SELECT value FROM json_each(?))`,
        [JSON.stringify(doomed.map((r) => r.id))],
      ),
      ...historyForDeleted(db, doomed, prune.source_commit),
    );
    summary.surfaces_deleted += doomed.length;
  }

  for (const deletion of payload.deleteSubnets) {
    if (!Number.isInteger(deletion.netuid) || !deletion.source_commit) continue;
    if (writtenSubnetNetuids.has(deletion.netuid)) continue;
    const doomed = await readRows(
      db,
      `SELECT id, subnet_netuid, overlay FROM surfaces WHERE subnet_netuid = ?`,
      [deletion.netuid as number],
    );
    writes.push(
      bound(db, `DELETE FROM surfaces WHERE subnet_netuid = ?`, [
        deletion.netuid as number,
      ]),
      ...historyForDeleted(db, doomed, deletion.source_commit),
      bound(db, `DELETE FROM subnets WHERE netuid = ?`, [
        deletion.netuid as number,
      ]),
    );
    summary.surfaces_deleted += doomed.length;
    summary.subnets_deleted += 1;
  }

  for (const surf of payload.surfaces) {
    if (
      !Number.isInteger(surf.subnet_netuid) ||
      !surf.surface_key ||
      !surf.kind ||
      !surf.url ||
      !surf.overlay ||
      !surf.source_commit
    )
      continue;
    const overlay = JSON.stringify(surf.overlay);
    // Postgres answered "was this an insert or an update?" with
    // `RETURNING (xmax = 0)`, which reads MVCC internals SQLite does not have.
    // Asking directly is both portable and clearer -- and it subsumes the old
    // `WHERE ... IS DISTINCT FROM` guard, because an unchanged overlay is now
    // skipped here instead of being sent and silently no-op'd.
    const [existing] = await readRows(
      db,
      `SELECT id, overlay FROM surfaces WHERE subnet_netuid = ? AND kind = ? AND url = ?`,
      [surf.subnet_netuid as number, surf.kind, surf.url],
    );
    if (existing && existing.overlay === overlay) continue;
    const action = existing ? "update" : "insert";
    writes.push(
      bound(
        db,
        `INSERT INTO surfaces (
           id, subnet_netuid, provider_id, surface_key, kind, url,
           authority, review_state, probe_eligible, public_safe,
           overlay, source_commit, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${NOW_MS})
         ON CONFLICT (subnet_netuid, kind, url) DO UPDATE SET
           provider_id = excluded.provider_id,
           surface_key = excluded.surface_key,
           authority = excluded.authority,
           review_state = excluded.review_state,
           probe_eligible = excluded.probe_eligible,
           public_safe = excluded.public_safe,
           overlay = excluded.overlay,
           source_commit = excluded.source_commit,
           updated_at = ${NOW_MS}`,
        [
          // The D1 schema deliberately has NO default for surfaces.id (a
          // fabricated surrogate is worse than a failed insert), so the caller
          // supplies it. Ignored on the UPDATE branch, which keeps the row's
          // existing id.
          (existing?.id as string) ?? crypto.randomUUID(),
          surf.subnet_netuid as number,
          surf.provider_id ?? null,
          surf.surface_key,
          surf.kind,
          surf.url,
          surf.authority || "community",
          surf.review_state || "community-submitted",
          // Booleans are 0/1 with a CHECK constraint in the D1 schema.
          surf.probe_eligible ? 1 : 0,
          surf.public_safe === false ? 0 : 1,
          overlay,
          surf.source_commit,
        ],
      ),
      bound(
        db,
        `INSERT INTO surface_history (subnet_netuid, action, overlay, source_commit, recorded_at)
         VALUES (?, ?, ?, ?, ${NOW_MS})`,
        [surf.subnet_netuid as number, action, overlay, surf.source_commit],
      ),
    );
    summary.surfaces_written += 1;
  }

  if (writes.length) await db.batch(writes);
  return summary;
}

function json(
  data: unknown,
  status = 200,
  extraHeaders: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...extraHeaders,
    },
  });
}

function isValidRow(row: unknown): row is Record<string, unknown> {
  return Boolean(row) && typeof row === "object" && !Array.isArray(row);
}

// metagraphed#7766: Sentry fully removed (was captureException here,
// parallel-run alongside PostHog since #7758; Sentry decommissioned once
// parity was proven). This Worker's top-level fetch has no ExecutionContext
// (see the default export below), so every capture here is awaited directly
// rather than scheduled via waitUntil -- the write batch below is already
// caught and converted to a clean 502, so nothing reaches PostHog's own
// top-level catch for the write-failure path without this. Same gap, same
// fix, as workers/api.ts's captureAiRouteError / workers/data-api.ts's
// captureDataApiError.
async function captureRegistrySyncError(error: unknown, env: Env) {
  await recordExceptionEvent(env, {
    error,
    route: "registry-sync",
    errorCode: "internal_error",
  });
}

// The actual write dispatcher, extracted from the default export's fetch so
// the top-level export (below) can wrap it with a PostHog trace span
// (metagraphed#7768) without indenting this whole function. Tests import
// this raw handler directly (unaffected by the wrapper).
async function dispatchRegistrySyncRequest(
  request: Request,
  env: Env,
): Promise<Response> {
  {
    if (request.method !== "POST") {
      return json({ error: "method not allowed" }, 405);
    }
    if (!env.REGISTRY_SYNC_SECRET) {
      return json(
        { error: "registry sync is not provisioned on this deployment" },
        503,
      );
    }
    const provided = request.headers.get(TOKEN_HEADER) || "";
    if (!provided || !timingSafeEqual(provided, env.REGISTRY_SYNC_SECRET)) {
      return json({ error: `provide a valid ${TOKEN_HEADER} header` }, 401);
    }
    // Rate-limit AFTER auth so an unauthenticated caller is rejected without
    // consuming limiter budget. Optional-chained so it's a no-op when the
    // binding is absent (local dev/CI).
    if (env.REGISTRY_SYNC_RATE_LIMITER?.limit) {
      const { success } = await env.REGISTRY_SYNC_RATE_LIMITER.limit({
        key: resolveClientIp(request),
      });
      if (!success) {
        return json(
          { error: "too many registry sync requests; slow down" },
          429,
          {
            "retry-after": String(RATE_LIMIT.windowSeconds),
            "x-ratelimit-limit": String(RATE_LIMIT.limit),
            "x-ratelimit-policy": `${RATE_LIMIT.limit};w=${RATE_LIMIT.windowSeconds}`,
            "x-ratelimit-remaining": "0",
          },
        );
      }
    }
    if (!env.REGISTRY_DB) {
      return json({ error: "registry database binding unavailable" }, 503);
    }

    const raw = await request.text();
    if (new TextEncoder().encode(raw).length > MAX_BODY_BYTES) {
      return json({ error: `body exceeds ${MAX_BODY_BYTES} bytes` }, 413);
    }
    let body: {
      subnets?: unknown;
      providers?: unknown;
      surfaces?: unknown;
      prune_surfaces?: unknown;
      delete_subnets?: unknown;
    };
    try {
      body = JSON.parse(raw);
    } catch {
      return json({ error: "body must be JSON" }, 400);
    }
    const subnets: SubnetSyncRow[] = Array.isArray(body?.subnets)
      ? body.subnets
      : [];
    const providers: ProviderSyncRow[] = Array.isArray(body?.providers)
      ? body.providers
      : [];
    const surfaces: SurfaceSyncRow[] = Array.isArray(body?.surfaces)
      ? body.surfaces
      : [];
    const pruneSurfaces: PruneSurfacesRow[] = Array.isArray(
      body?.prune_surfaces,
    )
      ? body.prune_surfaces
      : [];
    const deleteSubnets: DeleteSubnetRow[] = Array.isArray(body?.delete_subnets)
      ? body.delete_subnets
      : [];
    const rowGroups: Array<[string, unknown[]]> = [
      ["subnets", subnets],
      ["providers", providers],
      ["surfaces", surfaces],
      ["prune_surfaces", pruneSurfaces],
      ["delete_subnets", deleteSubnets],
    ];
    for (const [name, rows] of rowGroups) {
      if (rows.length > MAX_ROWS_PER_KIND) {
        return json(
          { error: `at most ${MAX_ROWS_PER_KIND} ${name} rows per request` },
          413,
        );
      }
      if (!rows.every(isValidRow)) {
        return json({ error: `${name} must be an array of row objects` }, 400);
      }
    }
    if (
      !subnets.length &&
      !providers.length &&
      !surfaces.length &&
      !pruneSurfaces.length &&
      !deleteSubnets.length
    ) {
      return json({ error: "no rows provided" }, 400);
    }

    try {
      // ONE atomic batch, via applyRegistrySyncToD1 -- see that function's
      // header for why the reads have to happen before it and what that costs.
      // The old `SET statement_timeout` has no D1 equivalent and is dropped:
      // D1 enforces its own query limits, and a bare SET was only ever needed
      // because Hyperdrive could hand the follow-up query a different physical
      // connection.
      const summary = await applyRegistrySyncToD1(
        env.REGISTRY_DB as unknown as D1Like,
        { providers, subnets, surfaces, pruneSurfaces, deleteSubnets },
      );
      return json({ ok: true, ...summary });
    } catch (err) {
      console.error("registry-sync-api write failed:", err);
      await captureRegistrySyncError(err, env);
      return json({ error: "write failed" }, 502);
    }
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // metagraphed#7768: PostHog distributed tracing (alpha), one root span
    // per request -- replaces @sentry/cloudflare's automatic withSentry() HTTP
    // instrumentation. This Worker's fetch has no ExecutionContext (CI-only,
    // low-traffic write path -- see captureRegistrySyncError's own comment),
    // so the span is awaited directly rather than scheduled via waitUntil,
    // same tradeoff already accepted for error capture on this Worker.
    if (!shouldSampleTrace(env)) {
      return dispatchRegistrySyncRequest(request, env);
    }
    const startedAt = Date.now();
    const route = "registry-sync";
    let ok = true;
    try {
      const response = await dispatchRegistrySyncRequest(request, env);
      ok = response.status < 500;
      return response;
    } catch (error) {
      ok = false;
      throw error;
    } finally {
      await recordTraceSpan(env, {
        traceId: newTraceId(),
        spanId: newSpanId(),
        name: route,
        startTimeMs: startedAt,
        endTimeMs: Date.now(),
        ok,
        serviceName: "metagraphed-registry-sync-api",
        attributes: { route },
      });
    }
  },
};
