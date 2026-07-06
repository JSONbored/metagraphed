// Full-resync import of every subnet/provider/surface fact this system
// currently knows about into the Postgres tables added in
// deploy/postgres/schema.sql (subnets / providers / surfaces /
// surface_history) — the registry-to-Postgres target architecture's single
// source of truth for BOTH the human-authored git tier AND the
// machine-discovered/promoted tier (see schema.sql's own comment on why
// these live in the same tables rather than a separate store).
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
// Usage: DATABASE_URL=postgres://... node scripts/backfill-registry-postgres.mjs [--dry-run]
import path from "node:path";
import postgres from "postgres";
import {
  listJsonFiles,
  readJson,
  repoRoot,
  stableStringify,
  subnetSurfaceKey,
} from "./lib.mjs";
import { generateBaselineOverlaySet } from "./generated-overlays.mjs";
import { OPERATIONAL_SURFACE_KINDS } from "../src/health-probe-core.mjs";

const args = new Set(process.argv.slice(2));
const dryRun = args.has("--dry-run");
const operationalKindSet = new Set(OPERATIONAL_SURFACE_KINDS);

async function main() {
  // Graceful no-op (not a failure) when unset -- this same script backs the
  // scheduled resync-registry-postgres.yml workflow, which must be safe to
  // merge before REGISTRY_DATABASE_URL is actually provisioned (see that
  // workflow's own comment). A manual one-time invocation with a genuinely
  // missing DATABASE_URL still gets a clear message, just via exit 0 so a
  // scheduled run before provisioning doesn't show as a failing workflow.
  if (!dryRun && !process.env.DATABASE_URL) {
    console.log(
      "DATABASE_URL not set — registry-to-Postgres sync isn't provisioned yet, nothing to do.",
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
    providers.push({ id: overlay.id, overlay });
  }

  // manualOverlays here is already baseline-AUGMENTED (candidate-promoted
  // surfaces merged in where a manual file doesn't explicitly exclude them
  // via baseline_excluded_surface_ids/_urls) -- exactly what the live build
  // serves today, not a re-derivation of it.
  const { manualOverlays, generatedOverlays } =
    await generateBaselineOverlaySet();

  const subnets = [];
  const surfaces = [];
  collectOverlays(manualOverlays, "community", subnets, surfaces);
  collectOverlays(generatedOverlays, "machine-generated", subnets, surfaces);

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

  const sql = postgres(process.env.DATABASE_URL, {
    max: 5,
    prepare: false,
    fetch_types: false,
  });

  try {
    // Providers first, then subnets, then surfaces (FK order). A provider a
    // surface references but whose file is missing/unreadable is left NULL
    // rather than failing the whole run — surfaces.provider_id is nullable.
    for (const provider of providers) {
      await sql`
        INSERT INTO providers (id, overlay, source_commit)
        VALUES (${provider.id}, ${sql.json(provider.overlay)}, ${sourceCommit})
        ON CONFLICT (id) DO UPDATE SET
          overlay = EXCLUDED.overlay,
          source_commit = EXCLUDED.source_commit,
          updated_at = now()`;
    }

    const knownProviderIds = new Set(providers.map((p) => p.id));

    for (const subnet of subnets) {
      await sql`
        INSERT INTO subnets (netuid, slug, name, source, overlay, source_commit)
        VALUES (${subnet.netuid}, ${subnet.slug}, ${subnet.name}, ${subnet.source}, ${sql.json(subnet.overlay)}, ${sourceCommit})
        ON CONFLICT (netuid) DO UPDATE SET
          slug = EXCLUDED.slug,
          name = EXCLUDED.name,
          source = EXCLUDED.source,
          overlay = EXCLUDED.overlay,
          source_commit = EXCLUDED.source_commit,
          updated_at = now()`;
    }

    let inserted = 0;
    let skippedDuplicates = 0;
    for (const surface of surfaces) {
      const providerId = knownProviderIds.has(surface.providerId)
        ? surface.providerId
        : null;
      const result = await sql`
        INSERT INTO surfaces (
          subnet_netuid, provider_id, surface_key, kind, url,
          authority, review_state, probe_eligible, public_safe,
          overlay, source_commit
        )
        VALUES (
          ${surface.subnetNetuid}, ${providerId}, ${surface.surfaceKey}, ${surface.kind}, ${surface.url},
          ${surface.authority}, ${surface.reviewState}, ${surface.probeEligible}, ${surface.publicSafe},
          ${sql.json(surface.overlay)}, ${sourceCommit}
        )
        ON CONFLICT (subnet_netuid, kind, url) DO UPDATE SET
          provider_id = EXCLUDED.provider_id,
          surface_key = EXCLUDED.surface_key,
          authority = EXCLUDED.authority,
          review_state = EXCLUDED.review_state,
          probe_eligible = EXCLUDED.probe_eligible,
          public_safe = EXCLUDED.public_safe,
          overlay = EXCLUDED.overlay,
          source_commit = EXCLUDED.source_commit,
          updated_at = now()
        RETURNING (xmax = 0) AS inserted`;
      if (result[0]?.inserted) {
        inserted += 1;
      } else {
        skippedDuplicates += 1;
      }
      const action = result[0]?.inserted ? "insert" : "update";
      await sql`
        INSERT INTO surface_history (subnet_netuid, action, overlay, source_commit)
        VALUES (${surface.subnetNetuid}, ${action}, ${sql.json(surface.overlay)}, ${sourceCommit})`;
    }

    console.log(
      stableStringify({
        providers_written: providers.length,
        subnets_written: subnets.length,
        surfaces_inserted: inserted,
        surfaces_updated: skippedDuplicates,
      }),
    );
  } finally {
    await sql.end({ timeout: 5 });
  }
}

function collectOverlays(overlays, source, subnetsOut, surfacesOut) {
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
    });
    for (const surface of subnetSurfaces) {
      surfacesOut.push({
        subnetNetuid: overlay.netuid,
        surfaceKey: subnetSurfaceKey(surface, overlay.netuid),
        kind: surface.kind,
        url: surface.url,
        providerId: surface.provider || null,
        authority: surface.authority || "community",
        reviewState: surface.review?.state || "community-submitted",
        probeEligible: Boolean(
          surface.probe?.enabled &&
          surface.public_safe &&
          operationalKindSet.has(surface.kind),
        ),
        publicSafe: surface.public_safe !== false,
        overlay: surface,
      });
    }
  }
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
