// The registry sync payload, derived from one commit's registry JSON (#9779).
//
// EXTRACTED SO THERE IS ONE TRANSFORMATION, NOT TWO. This is the shape
// workers/registry-sync-api.ts consumes, and until now only
// scripts/sync-registry-to-postgres.ts could build it -- a node script that
// shells out to git, which is exactly why the lane died when its GitHub
// Actions caller was retired. The Worker lane and the script now call the same
// functions, so a divergence between them is impossible rather than merely
// unlikely.
//
// PURE ON PURPOSE. Nothing here reads a file, a network or a clock: it takes
// an already-parsed overlay plus the commit it came from, and returns rows.
// That is what lets the Worker feed it bytes fetched over HTTPS while the
// script feeds it bytes read off disk, with no branch between them.
import { OPERATIONAL_SURFACE_KINDS } from "./health-probe-core.ts";
import { subnetSurfaceKey } from "./registry-surface-key.ts";

// Registry overlays are validated against the surface schema rather than a TS
// type; threading `unknown` through every `?.` would add casts without adding
// safety. Mirrors the readJson precedent in scripts/lib.ts.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Row = Record<string, any>;

const OPERATIONAL_KINDS = new Set<string>(OPERATIONAL_SURFACE_KINDS);

export interface SubnetSyncRows {
  subnet: Row;
  surfaces: Row[];
  prune: Row;
}

/** True when the overlay carries the three fields a subnet row cannot be built
 * without. Checked by both callers before building, so a malformed file is
 * skipped with a reason rather than producing a row with `undefined` in its
 * primary key. */
export function isSyncableSubnet(overlay: Row): boolean {
  return Boolean(
    Number.isInteger(overlay?.netuid) && overlay?.slug && overlay?.name,
  );
}

export function isSyncableProvider(overlay: Row): boolean {
  return Boolean(overlay?.id);
}

export function buildProviderRow(overlay: Row, sourceCommit: string): Row {
  return { id: overlay.id, overlay, source_commit: sourceCommit };
}

/**
 * One subnet file -> its subnet row, its surface rows, and its prune entry.
 *
 * `source` is unconditionally 'community' because this only ever runs for a
 * file that CHANGED: a subnet that used to be machine-generated-only correctly
 * flips the moment a contributor's first manual file for it lands, rather than
 * staying stale from before that file existed.
 *
 * The prune is scoped to `authority: "community"` for a reason that is easy to
 * get wrong. This file's `surfaces` array is only the community-authored ones;
 * it has no visibility into machine-discovered or candidate-promoted surfaces
 * the same subnet may also carry. An unscoped prune would delete rows this
 * payload has no way to know about.
 */
export function buildSubnetRows(
  overlay: Row,
  sourceCommit: string,
): SubnetSyncRows {
  const { surfaces = [], ...subnetOverlay } = overlay;
  const surfaceRows: Row[] = [];
  const currentSurfaces: Row[] = [];
  for (const surface of surfaces as Row[]) {
    currentSurfaces.push({ kind: surface.kind, url: surface.url });
    surfaceRows.push({
      subnet_netuid: overlay.netuid,
      provider_id: surface.provider || null,
      surface_key: subnetSurfaceKey(surface, overlay.netuid),
      kind: surface.kind,
      url: surface.url,
      authority: surface.authority || "community",
      review_state: surface.review?.state || "community-submitted",
      probe_eligible: Boolean(
        surface.probe?.enabled &&
        surface.public_safe &&
        OPERATIONAL_KINDS.has(surface.kind),
      ),
      public_safe: surface.public_safe !== false,
      overlay: surface,
      source_commit: sourceCommit,
    });
  }
  return {
    subnet: {
      netuid: overlay.netuid,
      slug: overlay.slug,
      name: overlay.name,
      source: "community",
      overlay: subnetOverlay,
      source_commit: sourceCommit,
    },
    surfaces: surfaceRows,
    prune: {
      subnet_netuid: overlay.netuid,
      current_surfaces: currentSurfaces,
      source_commit: sourceCommit,
      authority_scope: "community",
    },
  };
}

export interface RegistrySyncPayload {
  providers: Row[];
  subnets: Row[];
  surfaces: Row[];
  prune_surfaces: Row[];
  delete_subnets: Row[];
}

/** A file the caller resolved: its path, its parsed overlay when it still
 * exists at head, and the netuid it USED to have when it does not. */
export interface ResolvedRegistryFile {
  path: string;
  overlay?: Row | null;
  deletedNetuid?: number | null;
}

export function isRegistryPath(path: string): boolean {
  return (
    /^registry\/subnets\/[^/]+\.json$/.test(path) ||
    /^registry\/providers\/[^/]+\.json$/.test(path)
  );
}

/**
 * The whole payload, from a set of resolved files.
 *
 * A DELETION IS ONLY A DELETION IF NOTHING RE-ADDS IT. A rename shows up as one
 * removed path and one added path for the same netuid; emitting the delete
 * would drop the subnet and everything referencing it, and the upsert that
 * follows in the same request would not bring the surfaces back. So a netuid
 * present in the upserts is filtered out of the deletes -- the same guard the
 * script has always applied, kept here because the Worker is now a second
 * caller that could otherwise miss it.
 */
export function buildRegistrySyncPayload(
  files: readonly ResolvedRegistryFile[],
  sourceCommit: string,
): RegistrySyncPayload {
  const payload: RegistrySyncPayload = {
    providers: [],
    subnets: [],
    surfaces: [],
    prune_surfaces: [],
    delete_subnets: [],
  };
  for (const file of files) {
    const isSubnet = file.path.startsWith("registry/subnets/");
    if (!file.overlay) {
      if (isSubnet && Number.isInteger(file.deletedNetuid)) {
        payload.delete_subnets.push({
          netuid: file.deletedNetuid,
          source_commit: sourceCommit,
        });
      }
      continue;
    }
    if (isSubnet) {
      if (!isSyncableSubnet(file.overlay)) continue;
      const rows = buildSubnetRows(file.overlay, sourceCommit);
      payload.subnets.push(rows.subnet);
      payload.surfaces.push(...rows.surfaces);
      payload.prune_surfaces.push(rows.prune);
    } else if (isSyncableProvider(file.overlay)) {
      payload.providers.push(buildProviderRow(file.overlay, sourceCommit));
    }
  }
  const upserted = new Set(payload.subnets.map((s) => s.netuid));
  payload.delete_subnets = payload.delete_subnets.filter(
    (d) => !upserted.has(d.netuid),
  );
  return payload;
}

/** Whether the payload would change anything. An empty one must not be POSTed:
 * the sync route counts a request, and a no-op request that reports
 * `subnets_written: 0` is indistinguishable from a broken one. */
export function isEmptyPayload(payload: RegistrySyncPayload): boolean {
  return (
    payload.providers.length === 0 &&
    payload.subnets.length === 0 &&
    payload.surfaces.length === 0 &&
    payload.prune_surfaces.length === 0 &&
    payload.delete_subnets.length === 0
  );
}
