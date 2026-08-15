// metagraphed registry-sync Worker — the ONLY write path into the registry
// database (`metagraphed`, schema in tests/fixtures/sqlite-schema/0001_registry.sql).
//
// MOVED OFF THE SELF-HOSTED POSTGRES. The registry lived on a dedicated
// Postgres on the indexer box, reached through Hyperdrive. That box is being
// decommissioned, so the whole tier moved: 9,157 rows across four tables, which
// is roughly 450x under the store's ceiling. The Hyperdrive binding and the postgres.js
// driver are gone from this Worker entirely.
//
// WHAT CHANGED SEMANTICALLY. Three things, each documented where it happens
// rather than only here: the jsonb `overlay` columns are TEXT, so anything
// reading inside them must use json_extract(); `now()` becomes an epoch-ms
// integer; and D1 had no interactive transactions, which reshapes the write
// path into a read phase and one atomic batch (see applyRegistrySyncToStore).
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
import { SELF_HEALTH_PROBE_CRON } from "./config.ts";
import { runSelfHealthProbe } from "../src/self-health-prober.ts";
import { recordExceptionEvent } from "../src/usage-telemetry.ts";
import {
  newSpanId,
  newTraceId,
  recordTraceSpan,
  shouldRecordTraceSpan,
} from "../src/tracing.ts";
import { timingSafeEqual } from "../src/webhooks.ts";
import { resolveClientIp } from "./config.ts";
import {
  applyRegistrySyncToNeon,
  type RegistrySyncNeonDeps,
} from "../src/registry-sync-neon.ts";

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

export interface RegistrySyncSummary {
  providers_written: number;
  subnets_written: number;
  surfaces_written: number;
  surfaces_deleted: number;
  subnets_deleted: number;
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
/**
 * The writer's dependencies, overridable for tests (#10101).
 *
 * The handler's payload handling -- required-field validation, the prune's
 * authority scoping, the defaults -- is store-independent and was covered by
 * twelve tests that drove it through a fake D1. Deleting the store writer took
 * their seam with it, and re-pointing them at a real connection string turned
 * them into DNS lookups.
 *
 * Mirrors configureAnalytics' shape rather than inventing one: a module-level
 * object the suite swaps a clientFactory into, so those twelve keep asserting
 * the payload rules without a database of either kind.
 */
export const registrySyncDeps: RegistrySyncNeonDeps = {};

async function captureRegistrySyncError(
  error: unknown,
  env: RegistrySyncApiEnv,
) {
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
  env: RegistrySyncApiEnv,
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
    // Neon is the registry's only store (#10101). The D1 fallback is gone
    // along with the binding: while both existed, an unbound Hyperdrive
    // silently wrote the D1 copy instead of failing, so a misconfiguration
    // looked like a successful sync into a database nothing reads.
    if (!env.HYPERDRIVE?.connectionString) {
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
      // ONE atomic batch, via applyRegistrySyncToStore -- see that function's
      // header for why the reads have to happen before it and what that costs.
      // The old `SET statement_timeout` has no D1 equivalent and is dropped:
      // D1 enforces its own query limits, and a bare SET was only ever needed
      // because Hyperdrive could hand the follow-up query a different physical
      // connection.
      // NEON WHEN IT IS BOUND, and then D1 is not written at all (#10060).
      //
      // No dual-write here, unlike every producer lane. Those mirror because a
      // probe or a metagraph pass not stored is gone forever, so the second
      // copy has to prove itself before the first is dropped. These four tables
      // are re-derived from registry/subnets/*.json on every sync, so the proof
      // is just running the lane again -- and a second copy nothing reads is
      // the exact hazard the binding comment in wrangler.registry.jsonc
      // describes.
      const payload = {
        providers,
        subnets,
        surfaces,
        pruneSurfaces,
        deleteSubnets,
      };
      const summary = await applyRegistrySyncToNeon(
        env.HYPERDRIVE.connectionString,
        payload,
        registrySyncDeps,
      );
      return json({ ok: true, store: "neon", ...summary });
    } catch (err) {
      console.error("registry-sync-api write failed:", err);
      await captureRegistrySyncError(err, env);
      return json({ error: "write failed" }, 502);
    }
  }
}

export default {
  /**
   * metagraphed's own uptime probe (#10194), and it runs on THIS Worker for one
   * reason: it is the only one in the fleet with no public route at all.
   *
   * api.metagraph.sh is a custom domain of the `metagraphed` Worker, so probing
   * it from inside that Worker is a self-fetch -- Cloudflare refuses, the probe
   * came back 522 every time, and /api/v1/self-health published
   * `verdict: "outage"` on a healthy API. The one component that worked,
   * `site`, is the only target that Worker does not serve.
   *
   * A registry-sync Worker probing uptime looks unrelated, and that IS the
   * point: the measurement has to be taken from somewhere that is not the thing
   * being measured. This Worker is reached only through a service binding, so
   * the fetch leaves and comes back through the real edge -- the same DNS, TLS
   * and routing a user's request takes, which is what the lane claims to
   * measure. It already has HYPERDRIVE for the write, and no crons of its own
   * to collide with.
   */
  async scheduled(
    controller: ScheduledController,
    env: RegistrySyncApiEnv,
    ctx: ExecutionContext,
  ) {
    if (controller?.cron !== SELF_HEALTH_PROBE_CRON) {
      return { ok: false, skipped: true, reason: "unknown cron" };
    }
    return runSelfHealthProbe(env, ctx);
  },
  async fetch(request: Request, env: RegistrySyncApiEnv): Promise<Response> {
    // metagraphed#7768: PostHog distributed tracing (alpha), one root span
    // per request -- replaces @sentry/cloudflare's automatic withSentry() HTTP
    // instrumentation. This Worker's fetch has no ExecutionContext (CI-only,
    // low-traffic write path -- see captureRegistrySyncError's own comment),
    // so the span is awaited directly rather than scheduled via waitUntil,
    // same tradeoff already accepted for error capture on this Worker.
    // #9440: capture uncaught faults REGARDLESS of trace sampling, and
    // outside the sampled block -- tracing is off by default and this config
    // sets no rate, so an error capture nested inside the sampled path would
    // fire exactly never. captureRegistrySyncError already covers the write
    // path's own catch (:543); this covers everything that escapes it, which
    // until now reached only Cloudflare's logs.
    // The pre-dispatch sampling branch collapsed into the single path below
    // for the same reason as workers/data-api.ts: the keep/drop decision is
    // outcome-aware now (shouldRecordTraceSpan) and `ok` is only known in the
    // finally. captureRegistrySyncError still runs on every escape, exactly
    // as it did from the unsampled branch this replaces.
    const startedAt = Date.now();
    const route = "registry-sync";
    let ok = true;
    try {
      const response = await dispatchRegistrySyncRequest(request, env);
      ok = response.status < 500;
      return response;
    } catch (error) {
      ok = false;
      await captureRegistrySyncError(error, env);
      throw error;
    } finally {
      if (shouldRecordTraceSpan(env, { name: route, ok })) {
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
    }
  },
};
