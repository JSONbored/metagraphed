// Hourly operational-surfaces capture as a Worker cron writing R2 (#9096,
// following the #233 github-signals template) — the second retirement of a
// PR-based sync lane.
//
// Provenance: this replaces .github/workflows/sync-operational-surfaces.yml
// (hourly, `0 * * * *`), which ran the whole `npm run build` on a GitHub
// runner, diffed public/metagraph/operational-surfaces.json, and opened an
// auto-merged bot PR whenever it drifted. That lane's failure mode was SILENT
// STALENESS: any workflow misfire left the committed list frozen, and the
// health prober — which reads the COMMITTED copy through the ASSETS binding
// before anything else — kept probing a surface set that no longer matched the
// registry. It was measured drifting 79 -> 96 surfaces on a clean main
// checkout (2026-07-06) and, later, advertising 10 probe-enabled surfaces that
// were never probed while 4 removed ones still were (#8658). Here the cron
// writes the list straight to the R2 store the prober now reads first, so its
// freshness no longer depends on a bot PR landing.
//
// DERIVATION EQUIVALENCE — why the published surfaces.json is the same input
// the retired workflow's checkout had:
//
//   scripts/build-artifacts.ts builds ONE `surfaces` array (flattenSurfaces
//   over registry/subnets/*.json plus the curated overlays) and then uses it
//   for BOTH artifacts in the same build:
//
//     * `surfaces.json`            <- writeJson({ ..., surfaces })   verbatim
//     * `operational-surfaces.json` <- the same array, filtered by
//         `probe.enabled && public_safe && OPERATIONAL_SURFACE_KINDS.has(kind)`
//         and projected onto the prober's field subset.
//
//   So filtering the PUBLISHED surfaces.json by that same predicate reproduces
//   exactly the row set the workflow's `npm run build` produced from the git
//   checkout — the build is the only producer of either file, and it cannot
//   disagree with itself. `npm run validate:operational-surface-parity`
//   already pins that identity (617 == 617, zero drift either way).
//
// THE ONE FIELD THAT DOES NOT SURVIVE THE DERIVATION is `schema_source`, which
// build-artifacts computes from the captured schema index
// (resolveAgentServiceSchema) and which surfaces.json does not carry. It is
// therefore carried forward per surface_id from the previous store document
// (and, on a cold store, from the published operational-surfaces.json), never
// invented. Nothing in the prober reads it — it exists for
// `call_subnet_surface`'s schema resolution, whose reader still goes through
// readArtifact's R2-preferred published copy (see the reader note in
// src/health-prober.ts).
//
// Subrequest budget: one artifact read, one previous-store read, one
// conditional write, plus telemetry — a fixed handful per invocation, nowhere
// near the 1000-subrequests-per-invocation platform ceiling. There is no
// per-surface fetch here; probing is the 15-minute prober's job.

import type { StorageReadResult } from "../workers/storage.ts";
import { OPERATIONAL_SURFACE_KINDS } from "./health-probe-core.ts";
import { recordExceptionEvent } from "./usage-telemetry.ts";

type Row = Record<string, unknown>;

/**
 * Literal R2 key for the Worker-cron-written operational-surfaces store.
 *
 * Deliberately OUTSIDE the publish pipeline's `latest/` / `runs/` / `by-hash/`
 * trees (same posture as github-signals' `generated/` key and icon-proxy's
 * `icon-cache/` prefix): a publish run must never overwrite, orphan, or
 * atomically-swap this object — it has exactly one writer (this cron) and its
 * lifecycle is independent of the artifact publish.
 */
export const OPERATIONAL_SURFACES_R2_KEY =
  "generated/operational-surfaces.json";

/** The published all-surfaces artifact the list is derived from. */
export const OPERATIONAL_SURFACES_SOURCE_ARTIFACT_PATH =
  "/metagraph/surfaces.json";

/**
 * The published operational-surfaces artifact, read once on a cold store to
 * seed `schema_source` carry-forward.
 */
export const OPERATIONAL_SURFACES_ARTIFACT_PATH =
  "/metagraph/operational-surfaces.json";

export interface OperationalSurfaceRow {
  surface_id: unknown;
  surface_key: unknown;
  netuid: number;
  subnet_slug: unknown;
  subnet_name: unknown;
  kind: unknown;
  provider: unknown;
  authority: unknown;
  url: unknown;
  auth_required: boolean;
  public_safe: boolean;
  probe: {
    method: unknown;
    expect: unknown;
    timeout_ms: number | null;
  };
  schema_source: unknown;
}

export interface OperationalSurfacesArtifact {
  schema_version: 1;
  generated_at: string;
  source: "worker-cron";
  surface_count: number;
  kinds: string[];
  surfaces: OperationalSurfaceRow[];
}

/**
 * Index a document's rows by surface_id, so `schema_source` survives a
 * derivation that cannot recompute it. An unusable document yields an empty
 * map, which degrades every `schema_source` to null rather than throwing.
 */
export function schemaSourcesById(doc: unknown): Map<string, unknown> {
  const rows = (doc as { surfaces?: unknown } | null)?.surfaces;
  const byId = new Map<string, unknown>();
  for (const row of Array.isArray(rows) ? (rows as Row[]) : []) {
    const id = row?.surface_id;
    if (typeof id === "string" && id && row.schema_source != null) {
      byId.set(id, row.schema_source);
    }
  }
  return byId;
}

/**
 * Derive the prober's input list from the published all-surfaces artifact —
 * the same filter + projection + sort scripts/build-artifacts.ts applies to
 * the identical in-memory array (see the module header's equivalence note).
 */
export function deriveOperationalSurfaces(
  rows: unknown,
  schemaSources: Map<string, unknown> = new Map(),
): OperationalSurfaceRow[] {
  const kinds = new Set<unknown>(OPERATIONAL_SURFACE_KINDS);
  return (Array.isArray(rows) ? (rows as Row[]) : [])
    .filter((surface) => {
      const probe = surface?.probe as Row | undefined;
      return Boolean(
        probe?.enabled && surface.public_safe && kinds.has(surface.kind),
      );
    })
    .map((surface) => {
      const probe = surface.probe as Row;
      const timeoutMs = probe.timeout_ms;
      return {
        surface_id: surface.id,
        surface_key: surface.key,
        netuid: Number(surface.netuid),
        subnet_slug: surface.subnet_slug,
        subnet_name: surface.subnet_name,
        kind: surface.kind,
        provider: surface.provider,
        authority: surface.authority,
        url: surface.url,
        auth_required: Boolean(surface.auth_required),
        public_safe: Boolean(surface.public_safe),
        probe: {
          method: probe.method,
          expect: probe.expect,
          timeout_ms: Number.isInteger(timeoutMs)
            ? (timeoutMs as number)
            : null,
        },
        schema_source:
          typeof surface.id === "string"
            ? (schemaSources.get(surface.id) ?? null)
            : null,
      };
    })
    .sort(
      (a, b) =>
        a.netuid - b.netuid ||
        String(a.surface_id).localeCompare(String(b.surface_id)),
    );
}

// Key-sorted stringify, so the digest is insensitive to property order. Same
// local-copy convention as github-signals-core.ts's own stableStringify --
// tiny, and keeping this module free of script-side imports matters more than
// deduping ~10 lines.
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const record = value as Row;
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
}

/**
 * Content identity of the list with the volatile `generated_at` excluded — the
 * cron's write-only-when-changed gate, equivalent to the retired workflow's
 * `git diff --quiet` gate (which was content-only because the build stamps a
 * fixed-epoch generated_at).
 */
export function operationalSurfacesContentDigest(
  artifact: OperationalSurfacesArtifact,
): string {
  return stableStringify({ ...artifact, generated_at: null });
}

export interface OperationalSurfacesSyncDeps {
  readArtifact?: (env: Env, path: string) => Promise<StorageReadResult>;
  /** Clock seam for tests; stamps generated_at. */
  now?: () => number;
  /** Telemetry seam for tests; defaults to the real recordExceptionEvent. */
  recordException?: typeof recordExceptionEvent;
}

interface Ctx {
  waitUntil?: (promise: Promise<unknown>) => void;
}

export interface OperationalSurfacesSyncResult {
  ok: boolean;
  skipped?: boolean;
  reason?: string;
  changed?: boolean;
  surface_count?: number;
}

/**
 * The hourly cron tick: derive the prober's surface list from the published
 * registry and write the R2 store ONLY when the content actually moved
 * (generated_at excluded — the same content-only gate the retired workflow got
 * from git-diff).
 *
 * WITHOUT the METAGRAPH_ARCHIVE R2 binding this no-ops LOUDLY — console.error
 * plus one recordExceptionEvent. It never degrades to "write nothing and
 * report success": a lane whose whole purpose is to end silent staleness must
 * not itself go quiet when it cannot write.
 */
export async function runOperationalSurfacesSync(
  env: Env,
  ctx?: Ctx,
  deps: OperationalSurfacesSyncDeps = {},
): Promise<OperationalSurfacesSyncResult> {
  const bucket = env.METAGRAPH_ARCHIVE;
  if (!bucket?.get || !bucket?.put) {
    console.error(
      "[operational-surfaces-sync] METAGRAPH_ARCHIVE is not bound; the " +
        "prober's surface list cannot be refreshed and will age against the " +
        "committed cold-start copy until this is fixed.",
    );
    const pending = Promise.resolve(
      (deps.recordException ?? recordExceptionEvent)(env, {
        error: new Error("METAGRAPH_ARCHIVE not bound"),
        route: "cron:operational-surfaces-sync",
        errorCode: "operational_surfaces_bucket_missing",
      }),
    ).catch(() => false);
    ctx?.waitUntil?.(pending);
    return { ok: false, skipped: true, reason: "r2_binding_missing" };
  }
  if (typeof deps.readArtifact !== "function") {
    return { ok: false, reason: "reader_unavailable" };
  }
  try {
    const sourceRead = await deps.readArtifact(
      env,
      OPERATIONAL_SURFACES_SOURCE_ARTIFACT_PATH,
    );
    if (!sourceRead?.ok) {
      return { ok: false, reason: "surfaces_artifact_unavailable" };
    }

    let previousDoc: unknown = null;
    try {
      const object = await bucket.get(OPERATIONAL_SURFACES_R2_KEY);
      previousDoc = object ? await object.json() : null;
    } catch {
      // A cold or unreadable previous store degrades to "no carry-forward",
      // the same as the lane's very first run.
      previousDoc = null;
    }
    // schema_source carry-forward: the store's own last copy first, then the
    // published artifact (which the build DOES compute it in) on a cold store.
    let schemaSources = schemaSourcesById(previousDoc);
    if (schemaSources.size === 0) {
      const publishedRead = await deps
        .readArtifact(env, OPERATIONAL_SURFACES_ARTIFACT_PATH)
        .catch(() => null);
      if (publishedRead?.ok) {
        schemaSources = schemaSourcesById(publishedRead.data);
      }
    }

    const surfaces = deriveOperationalSurfaces(
      (sourceRead.data as { surfaces?: unknown } | null)?.surfaces,
      schemaSources,
    );
    if (surfaces.length === 0) {
      // An artifact with zero operational surfaces is a broken input, not an
      // empty registry — never let it wipe the store and blind the prober.
      return { ok: false, reason: "no_operational_surfaces" };
    }

    const artifact: OperationalSurfacesArtifact = {
      schema_version: 1,
      generated_at: new Date((deps.now ?? Date.now)()).toISOString(),
      source: "worker-cron",
      surface_count: surfaces.length,
      kinds: [...OPERATIONAL_SURFACE_KINDS].sort(),
      surfaces,
    };

    const previousDigest = Array.isArray((previousDoc as Row | null)?.surfaces)
      ? operationalSurfacesContentDigest(
          previousDoc as OperationalSurfacesArtifact,
        )
      : null;
    if (previousDigest === operationalSurfacesContentDigest(artifact)) {
      return { ok: true, changed: false, surface_count: surfaces.length };
    }

    await bucket.put(OPERATIONAL_SURFACES_R2_KEY, JSON.stringify(artifact), {
      httpMetadata: { contentType: "application/json" },
    });
    return { ok: true, changed: true, surface_count: surfaces.length };
  } catch (error) {
    // One failed tick is one stale hour, not an outage — contained, but never
    // silent (handleScheduled records the ok:false cron outcome too).
    console.error(
      "[operational-surfaces-sync]",
      String((error as Error)?.message),
    );
    return { ok: false, reason: "unreachable" };
  }
}
