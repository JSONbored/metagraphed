// Daily surface-verification capture as a Worker cron writing R2 (#9096,
// following the #233 github-signals template) — the third retirement of a
// PR-based sync lane.
//
// Provenance: this replaces .github/workflows/sync-surface-verification.yml
// (daily, `40 4 * * *`), which ran `npm run sync:surface-verification` on a
// GitHub runner, diffed registry/verification/surface-health.json, and opened
// an auto-merged bot PR whenever the evidence moved. That lane's failure mode
// was SILENT STALENESS with TEETH: this snapshot is the ONLY producer of
// `machine-verified` (scripts/lib.ts flattenSurfaces reads it to derive
// `last_verified_at`), so a frozen file freezes the registry's trust tiers —
// surfaces that stopped meeting the bar keep their verification, and surfaces
// that earned it never get it.
//
// SOURCE — why D1 rather than our own HTTP API. The retired script made one
// `GET /api/v1/subnets/{netuid}/uptime` request per subnet against our own
// edge, spaced 50ms apart to avoid tripping our own rate limiter. That route's
// handler (workers/request-handlers/analytics-routes.ts handleUptime) resolves
// to `loadSubnetUptime(netuid, { window: "90d", observedAt: <KV health:meta
// last_run_at> })` over D1's `surface_uptime_daily` whenever the Postgres tier
// misses. Running INSIDE the Worker, this cron calls that same loader directly
// with the same arguments: same SQL, same 90-day window, same
// MAX_UPTIME_ROWS cap, same formatUptime aggregation, same observed_at. The
// only thing removed is the network hop through our own edge (and with it the
// rate-limit spacing, the edge cache, and the possibility of a partial sweep
// because a few requests timed out).
//
// ONE DELIBERATE SEMANTIC CHANGE, and it is a fix. The retired script took
// whatever the API returned, which meant a subnet answered from the DYING
// Postgres tier contributed evidence stamped with that tier's stale
// `observed_at`: the committed snapshot on 2026-08-02 carried two distinct
// `last_ok` values, one of them 2026-07-16 — a seventeen-day-old attestation
// riding on a fresh run. Reading D1 directly makes every record attest to the
// same instant, the prober's real `last_run_at`. Verification dates get
// strictly more honest; no surface's day_count/samples/uptime_ratio changes.
//
// Subrequest budget: one artifact read (the subnet list), one D1 query per
// subnet (~129 today), one previous-store read, one conditional write, plus
// telemetry — well under the 1000-subrequests-per-invocation platform ceiling,
// and it grows one query per newly registered subnet.

import type { StorageReadResult } from "../workers/storage.ts";
import {
  currentD1ReadFailureGeneration,
  loadSubnetUptime,
  type ObservationsReadDb,
} from "./analytics-live.ts";
import { KV_HEALTH_META } from "./kv-keys.ts";
import {
  buildSurfaceHealthArtifact,
  collectSurfaceProbeRecords,
  surfaceHealthContentDigest,
  type SurfaceHealthArtifact,
  type SurfaceProbeRecord,
} from "./surface-verification.ts";
import { recordExceptionEvent } from "./usage-telemetry.ts";

type Row = Record<string, unknown>;

/**
 * Literal R2 key for the Worker-cron-written surface-health store.
 *
 * Deliberately OUTSIDE the publish pipeline's `latest/` / `runs/` / `by-hash/`
 * trees (same posture as the github-signals and operational-surfaces stores):
 * a publish run must never overwrite, orphan, or atomically-swap this object —
 * it has exactly one writer (this cron) and its lifecycle is independent of
 * the artifact publish. It is also not an artifact at all: nothing serves it,
 * the artifact BUILD consumes it.
 */
export const SURFACE_HEALTH_R2_KEY = "generated/surface-health.json";

/** The published subnets artifact the netuid sweep list comes from. */
export const SURFACE_HEALTH_SUBNETS_ARTIFACT_PATH = "/metagraph/subnets.json";

/**
 * The window the evidence is computed over. Matches the `/uptime` route's own
 * default, which is what the retired script requested by omitting `?window=`.
 */
export const SURFACE_HEALTH_WINDOW = "90d";

export interface SurfaceVerificationSyncDeps {
  readArtifact?: (env: Env, path: string) => Promise<StorageReadResult>;
  /** Uptime loader seam; defaults to the real D1-backed loadSubnetUptime. */
  loadUptime?: typeof loadSubnetUptime;
  /** Clock seam for tests; stamps generated_at. */
  now?: () => number;
  /** Telemetry seam for tests; defaults to the real recordExceptionEvent. */
  recordException?: typeof recordExceptionEvent;
}

interface Ctx {
  waitUntil?: (promise: Promise<unknown>) => void;
}

export interface SurfaceVerificationSyncResult {
  ok: boolean;
  skipped?: boolean;
  reason?: string;
  changed?: boolean;
  surface_count?: number;
  verified_count?: number;
  subnets_reached?: number;
  subnets_total?: number;
}

/**
 * The registry netuid sweep list, from the published subnets artifact's rows.
 * Deduped and sorted, exactly as the retired script derived it from
 * `loadSubnets()` over the git checkout.
 */
export function netuidsFromSubnets(rows: unknown): number[] {
  return [
    ...new Set(
      (Array.isArray(rows) ? (rows as Row[]) : [])
        .map((subnet) => Number(subnet?.netuid))
        .filter((netuid) => Number.isInteger(netuid) && netuid >= 0),
    ),
  ].sort((a, b) => a - b);
}

/**
 * The prober's last run instant from KV `health:meta` — the same value
 * handleUptime passes to loadSubnetUptime as `observedAt`, and therefore the
 * instant every record's `last_ok` attests to.
 *
 * Null (KV unbound, cold, or malformed) is tolerated: it makes every record's
 * `last_ok` null, which `verifyFromProbeEvidence` treats as "meets thresholds
 * but has no last_ok instant to attest to" — i.e. it WITHHOLDS verification
 * rather than inventing a date. That is the correct degrade, but it would also
 * mass-demote the registry, so the caller refuses to write in that case.
 */
export async function readProberLastRunAt(env: Env): Promise<string | null> {
  try {
    const meta = (await env.METAGRAPH_CONTROL?.get(KV_HEALTH_META, {
      type: "json",
    })) as Row | null;
    const lastRunAt = meta?.last_run_at;
    return typeof lastRunAt === "string" && lastRunAt ? lastRunAt : null;
  } catch {
    return null;
  }
}

/**
 * The daily cron tick: sweep every registry subnet's 90-day uptime history out
 * of D1, verify each surface against the promotion bar, and write the R2 store
 * ONLY when the evidence actually moved (generated_at excluded — the same
 * content-only gate the retired workflow got from git-diff).
 *
 * WITHOUT the METAGRAPH_HEALTH_DB binding (or with the prober's KV meta cold)
 * this no-ops LOUDLY — console.error plus one recordExceptionEvent — and never
 * writes. This is the single most important guard in the lane: `d1All` degrades
 * a failed read to ZERO ROWS, so an unbound or broken D1 would produce a
 * perfectly well-formed snapshot in which every surface has no evidence, and
 * flattenSurfaces would strip `machine-verified` from the entire registry on
 * the next build. Publishing plausible-but-wrong trust data is far worse than
 * publishing nothing, so the lane refuses to run rather than run degraded.
 */
export async function runSurfaceVerificationSync(
  env: Env,
  ctx?: Ctx,
  deps: SurfaceVerificationSyncDeps = {},
): Promise<SurfaceVerificationSyncResult> {
  const db = env.METAGRAPH_HEALTH_DB as ObservationsReadDb | undefined;
  const loud = (message: string, errorCode: string, reason: string) => {
    console.error(`[surface-verification-sync] ${message}`);
    const pending = Promise.resolve(
      (deps.recordException ?? recordExceptionEvent)(env, {
        error: new Error(message),
        route: "cron:surface-verification-sync",
        errorCode,
      }),
    ).catch(() => false);
    ctx?.waitUntil?.(pending);
    return { ok: false, skipped: true, reason };
  };
  if (!db?.prepare) {
    return loud(
      "METAGRAPH_HEALTH_DB is not bound; refusing to run. A D1-less sweep " +
        "reads zero rows for every subnet, which would publish a snapshot " +
        "that strips machine-verified from the whole registry.",
      "surface_verification_d1_missing",
      "d1_binding_missing",
    );
  }
  const bucket = env.METAGRAPH_ARCHIVE;
  if (!bucket?.get || !bucket?.put) {
    return loud(
      "METAGRAPH_ARCHIVE is not bound; the probe-evidence snapshot cannot be " +
        "refreshed and the registry's machine-verified tiers will age against " +
        "the committed seed until this is fixed.",
      "surface_verification_bucket_missing",
      "r2_binding_missing",
    );
  }
  if (typeof deps.readArtifact !== "function") {
    return { ok: false, reason: "reader_unavailable" };
  }
  try {
    const observedAt = await readProberLastRunAt(env);
    if (!observedAt) {
      return loud(
        "the prober's KV health:meta carries no last_run_at; refusing to " +
          "run. Every record would attest to no instant, which withholds " +
          "verification from every surface at once.",
        "surface_verification_prober_meta_cold",
        "prober_meta_cold",
      );
    }

    const subnetsRead = await deps.readArtifact(
      env,
      SURFACE_HEALTH_SUBNETS_ARTIFACT_PATH,
    );
    if (!subnetsRead?.ok) {
      return { ok: false, reason: "subnets_artifact_unavailable" };
    }
    const netuids = netuidsFromSubnets(
      (subnetsRead.data as { subnets?: unknown } | null)?.subnets,
    );
    if (netuids.length === 0) {
      // An artifact with no netuids is a broken input, not an empty registry.
      return { ok: false, reason: "no_subnets" };
    }

    // d1All contains a failed read as zero rows, so "no evidence" and "the
    // read broke" look identical from here. Snapshot its failure generation
    // and abort the whole run if ANY query failed — a partially-read sweep
    // demotes exactly the surfaces whose query happened to fail.
    const d1Generation = currentD1ReadFailureGeneration();
    const loadUptime = deps.loadUptime ?? loadSubnetUptime;
    const records: Record<string, SurfaceProbeRecord> = {};
    for (const netuid of netuids) {
      const data = await loadUptime(netuid, {
        window: SURFACE_HEALTH_WINDOW,
        observedAt,
        db,
      });
      collectSurfaceProbeRecords(data, records);
    }
    if (currentD1ReadFailureGeneration() !== d1Generation) {
      return loud(
        "a D1 read failed mid-sweep; refusing to write a partial snapshot " +
          "that would demote exactly the surfaces whose query failed.",
        "surface_verification_d1_read_failed",
        "d1_read_failed",
      );
    }

    const artifact = buildSurfaceHealthArtifact({
      records,
      // Every subnet is read from the same D1 sweep, and a failed read aborts
      // above, so reaching this point means all of them were read. Under the
      // retired lane this counted successful HTTP responses and could land
      // below the total; it is now all-or-nothing by construction.
      subnetsReached: netuids.length,
      subnetsTotal: netuids.length,
      generatedAt: new Date((deps.now ?? Date.now)()).toISOString(),
    });
    if (artifact.surface_count === 0) {
      // Zero surfaces with a healthy D1 means the uptime rollup is cold, not
      // that the registry has no surfaces — never let that wipe the store.
      return { ok: false, reason: "no_probe_evidence" };
    }

    let previousDoc: unknown = null;
    try {
      const object = await bucket.get(SURFACE_HEALTH_R2_KEY);
      previousDoc = object ? await object.json() : null;
    } catch {
      // A cold or unreadable previous store just means "write it".
      previousDoc = null;
    }
    const previousSurfaces = (previousDoc as Row | null)?.surfaces;
    const previousDigest =
      previousSurfaces &&
      typeof previousSurfaces === "object" &&
      !Array.isArray(previousSurfaces)
        ? surfaceHealthContentDigest(previousDoc as SurfaceHealthArtifact)
        : null;
    if (previousDigest === surfaceHealthContentDigest(artifact)) {
      return {
        ok: true,
        changed: false,
        surface_count: artifact.surface_count,
        verified_count: artifact.verified_count,
        subnets_reached: artifact.subnets_reached,
        subnets_total: artifact.subnets_total,
      };
    }

    await bucket.put(SURFACE_HEALTH_R2_KEY, JSON.stringify(artifact), {
      httpMetadata: { contentType: "application/json" },
    });
    return {
      ok: true,
      changed: true,
      surface_count: artifact.surface_count,
      verified_count: artifact.verified_count,
      subnets_reached: artifact.subnets_reached,
      subnets_total: artifact.subnets_total,
    };
  } catch (error) {
    // One failed tick is one stale day, not an outage — contained, but never
    // silent (handleScheduled records the ok:false cron outcome too).
    console.error(
      "[surface-verification-sync]",
      String((error as Error)?.message),
    );
    return { ok: false, reason: "unreachable" };
  }
}
