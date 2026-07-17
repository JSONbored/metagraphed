// Full-resync import of every subnet/provider/surface fact this system
// currently knows about into the registry Postgres instance (subnets /
// providers / surfaces / surface_history — see
// deploy/postgres/registry-schema.sql) — the registry-to-Postgres target
// architecture's single source of truth for BOTH the human-authored git tier
// AND the machine-discovered/promoted tier (see that schema file's own
// comment on why these live in the same tables rather than a separate
// store).
//
// Idempotent and safe to run repeatedly: every write is an upsert keyed on
// the same identity the data already carries (netuid / provider id /
// (subnet, kind, url)), so re-running never duplicates anything, and running
// it on a schedule is exactly how the machine-discovered half of the data
// stays fresh (native chain snapshot + candidate verification refresh on
// their own cadence, independent of any contributor PR merging) --
// scripts/sync-registry-to-postgres.mjs is the faster, event-driven path for
// the human-authored half specifically, triggered by a merge instead of a
// clock.
//
// This does NOT change what's authoritative for CONTRIBUTION today — git +
// the Gittensory Gate remain the sole review/merge surface for
// registry/subnets/*.json / registry/providers/*.json. This script (and its
// sibling sync script) are what makes Postgres the single place everything
// -- human-reviewed or machine-discovered -- ends up queryable together.
//
// There is no Tailscale, SSH, or direct network path from CI to the database
// at all: this script POSTs to the registry-sync Worker over HTTPS in
// row-count-bounded chunks (see workers/registry-sync-api.mjs), never opens
// a DB connection itself.
//
// Usage: REGISTRY_SYNC_SECRET=... node scripts/backfill-registry-postgres.mjs [--dry-run]
import path from "node:path";
import {
  chunkRows,
  listJsonFiles,
  postRegistrySync,
  readJson,
  repoRoot,
  stableStringify,
  subnetSurfaceKey,
} from "./lib.mjs";
import { generateBaselineOverlaySet } from "./generated-overlays.mjs";
import { OPERATIONAL_SURFACE_KINDS } from "../src/health-probe-core.mjs";
import { initSentry, endSessionAndFlush } from "./observability.mjs";

initSentry("backfill-registry-postgres");

const args = new Set(process.argv.slice(2));
const dryRun = args.has("--dry-run");
const operationalKindSet = new Set(OPERATIONAL_SURFACE_KINDS);

async function main() {
  // Graceful no-op (not a failure) when unset -- this same script backs the
  // indexer-box registry-sync systemd timer (data-refresh-node role,
  // JSONbored/metagraphed-infra -- moved off the former GitHub Actions
  // resync-registry-postgres.yml 2026-07-15), which must be safe to merge
  // before REGISTRY_SYNC_SECRET is actually provisioned. A manual one-time
  // invocation with a genuinely missing REGISTRY_SYNC_SECRET still gets a
  // clear message, just via exit 0 so a run before provisioning doesn't
  // show as a failure.
  if (!dryRun && !process.env.REGISTRY_SYNC_SECRET) {
    console.log(
      "REGISTRY_SYNC_SECRET not set — registry-to-Postgres sync isn't provisioned yet, nothing to do.",
    );
    return;
  }

  const sourceCommit = await currentCommitSha();
  const providerFiles = await listJsonFiles(
    path.join(repoRoot, "registry/providers"),
  );

  const providers = [];
  for (const filePath of providerFiles) {
    const overlay = await readJson(filePath);
    if (!overlay.id) {
      console.error(`skipping ${filePath}: missing required "id" field`);
      continue;
    }
    providers.push({ id: overlay.id, overlay, source_commit: sourceCommit });
  }

  // manualOverlays here is already baseline-AUGMENTED (candidate-promoted
  // surfaces merged in where a manual file doesn't explicitly exclude them
  // via baseline_excluded_surface_ids/_urls) -- exactly what the live build
  // serves today, not a re-derivation of it.
  const { manualOverlays, generatedOverlays } =
    await generateBaselineOverlaySet();

  const subnets = [];
  const surfaces = [];
  collectOverlays(manualOverlays, "community", sourceCommit, subnets, surfaces);
  collectOverlays(
    generatedOverlays,
    "machine-generated",
    sourceCommit,
    subnets,
    surfaces,
  );

  console.log(
    stableStringify({
      mode: dryRun ? "dry-run" : "write",
      subnets: subnets.length,
      subnets_community: manualOverlays.length,
      subnets_machine_generated: generatedOverlays.length,
      providers: providers.length,
      surfaces: surfaces.length,
      source_commit: sourceCommit,
    }),
  );

  if (dryRun) {
    return;
  }

  const summary = {
    providers_written: 0,
    subnets_written: 0,
    surfaces_written: 0,
    surfaces_deleted: 0,
  };

  // Providers + subnets are small (low hundreds) -- one request each is
  // plenty. Surfaces are the largest set by far, so they're chunked to stay
  // under the Worker's rows-per-kind cap regardless of how large the
  // registry grows.
  if (providers.length || subnets.length) {
    const result = await postRegistrySync({ providers, subnets });
    summary.providers_written += result?.providers_written ?? 0;
    summary.subnets_written += result?.subnets_written ?? 0;
  }
  for (const chunk of chunkRows(surfaces)) {
    if (!chunk.length) continue;
    const result = await postRegistrySync({ surfaces: chunk });
    summary.surfaces_written += result?.surfaces_written ?? 0;
  }

  for (const chunk of chunkRows(buildSurfacePruneRows(subnets, surfaces))) {
    if (!chunk.length) continue;
    const result = await postRegistrySync({ prune_surfaces: chunk });
    summary.surfaces_deleted += result?.surfaces_deleted ?? 0;
  }

  console.log(stableStringify(summary));
}

function collectOverlays(
  overlays,
  source,
  sourceCommit,
  subnetsOut,
  surfacesOut,
) {
  for (const overlay of overlays) {
    if (!Number.isInteger(overlay.netuid) || !overlay.slug || !overlay.name) {
      console.error(
        `skipping a ${source} overlay: missing required netuid/slug/name field`,
      );
      continue;
    }
    const { surfaces: subnetSurfaces = [], ...subnetOverlay } = overlay;
    subnetsOut.push({
      netuid: overlay.netuid,
      slug: overlay.slug,
      name: overlay.name,
      source,
      overlay: subnetOverlay,
      source_commit: sourceCommit,
    });
    for (const surface of subnetSurfaces) {
      surfacesOut.push({
        subnet_netuid: overlay.netuid,
        surface_key: subnetSurfaceKey(surface, overlay.netuid),
        kind: surface.kind,
        url: surface.url,
        provider_id: surface.provider || null,
        authority: surface.authority || "community",
        review_state: surface.review?.state || "community-submitted",
        probe_eligible: Boolean(
          surface.probe?.enabled &&
          surface.public_safe &&
          operationalKindSet.has(surface.kind),
        ),
        public_safe: surface.public_safe !== false,
        overlay: surface,
        source_commit: sourceCommit,
      });
    }
  }
}

function buildSurfacePruneRows(subnets, surfaces) {
  const bySubnet = new Map(
    subnets.map((subnet) => [
      subnet.netuid,
      {
        subnet_netuid: subnet.netuid,
        current_surfaces: [],
        source_commit: subnet.source_commit,
      },
    ]),
  );
  for (const surface of surfaces) {
    bySubnet.get(surface.subnet_netuid)?.current_surfaces.push({
      kind: surface.kind,
      url: surface.url,
    });
  }
  return [...bySubnet.values()];
}

async function currentCommitSha() {
  const { spawnSync } = await import("node:child_process");
  const result = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  return result.stdout.trim() || "unknown";
}

await main();
await endSessionAndFlush();
