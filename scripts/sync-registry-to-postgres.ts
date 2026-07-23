// Merge-triggered FAST PATH: upserts the registry/subnets/*.json +
// registry/providers/*.json files that changed in a push into the registry
// Postgres instance, within seconds/minutes of a merge rather than waiting
// for the next scheduled full resync. Its sibling,
// scripts/backfill-registry-postgres.ts, run on a schedule, is what keeps
// the machine-discovered half of the same tables (subnets with no manual
// file, candidate-promoted surfaces) fresh on ITS OWN cadence — that content
// isn't tied to a git commit the way this script's trigger is. Together they
// make Postgres the single, always-fresh source of truth for every
// subnet/provider/surface fact, human-authored or machine-discovered (see
// deploy/postgres/registry-schema.sql's own comment for why these live in
// one table set).
//
// Contribution/review is UNCHANGED: a contributor's PR still touches only
// registry/subnets/<slug>.json, still gets scored by the Gittensory Gate
// exactly as today. This script only runs AFTER a merge lands on main, reading
// the already-reviewed file — the write path a contributor's credentials
// never reach. There is no Tailscale, SSH, or direct network path from the
// caller to the database at all: this script POSTs to the registry-sync
// Worker over HTTPS (see workers/registry-sync-api.mjs); the database itself
// stays exactly as private as it already was.
//
// Called by the box-side registry-sync-fast job (see
// scripts/data-refresh-node-entrypoint.sh), a 3-minute poll standing in for
// the retired push-triggered .github/workflows/sync-registry-to-postgres.yml
// (moved off GitHub Actions 2026-07-15, consolidating recurring bittensor
// data jobs onto the box rather than fragmenting them across two places) --
// --base/--head are the last-synced and current commit SHAs from that poll,
// not a GitHub Actions push event's before/sha.
//
// Independently re-validates each changed subnet file against
// scripts/validate-surface.ts before sending it (defense in depth: the Gate
// already checked it pre-merge, this checks again post-merge) rather than
// trusting the git content blindly.
//
// Safe to run before REGISTRY_SYNC_SECRET is provisioned: with no
// REGISTRY_SYNC_SECRET, this exits 0 having done nothing.
//
// Usage:
//   REGISTRY_SYNC_SECRET=... node scripts/sync-registry-to-postgres.ts \
//     --base <sha> --head <sha>
import { spawnSync } from "node:child_process";
import path from "node:path";
import {
  postRegistrySync,
  readJson,
  repoRoot,
  stableStringify,
  subnetSurfaceKey,
} from "./lib.ts";
import { OPERATIONAL_SURFACE_KINDS } from "../src/health-probe-core.ts";
import { initSentry, endSessionAndFlush } from "./observability.ts";

// Registry overlay files here are read via readJson (already `any`) and
// re-validated against the schema (validate-surface.ts) before this script
// ever sends them anywhere -- typing every dynamic hop through `unknown`
// would force a cast at every `?.` in a script whose real safety net is the
// schema, not TS. Mirrors the readJson/readArtifactJson precedent in lib.ts.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

interface ParsedArgs {
  base?: string;
  head?: string;
}

initSentry("sync-registry-to-postgres");

const args = parseArgs(process.argv.slice(2));
const operationalKindSet = new Set(OPERATIONAL_SURFACE_KINDS);

async function main(): Promise<void> {
  if (!process.env.REGISTRY_SYNC_SECRET) {
    console.log(
      "REGISTRY_SYNC_SECRET not set — registry-to-Postgres sync isn't provisioned yet, nothing to do.",
    );
    return;
  }
  if (!args.base || !args.head) {
    console.error("--base <sha> and --head <sha> are both required.");
    process.exit(1);
  }

  const changedFiles = gitDiffFiles(args.base, args.head).filter(
    (file) =>
      /^registry\/subnets\/[^/]+\.json$/.test(file) ||
      /^registry\/providers\/[^/]+\.json$/.test(file),
  );

  if (changedFiles.length === 0) {
    console.log("no registry/subnets or registry/providers files changed.");
    return;
  }
  console.log(
    stableStringify({ base: args.base, head: args.head, changedFiles }),
  );

  const providers: Row[] = [];
  const subnets: Row[] = [];
  const surfaces: Row[] = [];
  const pruneSurfaces: Row[] = [];
  const deleteSubnets: Row[] = [];
  const skippedInvalid: string[] = [];

  for (const file of changedFiles) {
    const stillExists = fileExistsAtHead(file);
    if (!stillExists) {
      if (file.startsWith("registry/subnets/")) {
        const deletedSubnet = readSubnetFromCommit(args.base, file);
        if (deletedSubnet) {
          deleteSubnets.push({
            netuid: deletedSubnet.netuid,
            source_commit: args.head,
          });
        }
      }
      continue;
    }
    const absolutePath = path.join(repoRoot, file);

    if (file.startsWith("registry/subnets/")) {
      const revalidation = spawnSync(
        process.execPath,
        ["scripts/validate-surface.ts", "--", file],
        { cwd: repoRoot, encoding: "utf8" },
      );
      if (revalidation.status !== 0) {
        console.error(
          `skipping ${file}: failed independent re-validation post-merge (should be unreachable if the Gate is working — investigate)`,
        );
        skippedInvalid.push(file);
        continue;
      }
      await collectSubnetFile(absolutePath, subnets, surfaces, pruneSurfaces);
    } else {
      await collectProviderFile(absolutePath, providers);
    }
  }

  const upsertedSubnetNetuids = new Set(subnets.map((subnet) => subnet.netuid));
  const safeDeleteSubnets = deleteSubnets.filter(
    (deletion) => !upsertedSubnetNetuids.has(deletion.netuid),
  );

  const summary = {
    providers_written: 0,
    subnets_written: 0,
    surfaces_written: 0,
    surfaces_deleted: 0,
    subnets_deleted: 0,
    skipped_invalid: skippedInvalid,
  };

  if (
    providers.length ||
    subnets.length ||
    surfaces.length ||
    pruneSurfaces.length ||
    safeDeleteSubnets.length
  ) {
    const result = await postRegistrySync({
      providers,
      subnets,
      surfaces,
      prune_surfaces: pruneSurfaces,
      delete_subnets: safeDeleteSubnets,
    });
    summary.providers_written = (result?.providers_written as number) ?? 0;
    summary.subnets_written = (result?.subnets_written as number) ?? 0;
    summary.surfaces_written = (result?.surfaces_written as number) ?? 0;
    summary.surfaces_deleted = (result?.surfaces_deleted as number) ?? 0;
    summary.subnets_deleted = (result?.subnets_deleted as number) ?? 0;
  }

  console.log(stableStringify(summary));
  if (skippedInvalid.length > 0) {
    // A file the Gate already merged failing re-validation here is a real
    // signal something is wrong (a race, or a Gate/schema drift) — surface
    // it as a failure so it pages someone rather than silently skipping.
    process.exit(1);
  }
}

async function collectProviderFile(
  absolutePath: string,
  providersOut: Row[],
): Promise<void> {
  const overlay = await readJson(absolutePath);
  if (!overlay.id) {
    console.error(`skipping ${absolutePath}: missing required "id" field`);
    return;
  }
  providersOut.push({ id: overlay.id, overlay, source_commit: args.head });
}

async function collectSubnetFile(
  absolutePath: string,
  subnetsOut: Row[],
  surfacesOut: Row[],
  pruneSurfacesOut: Row[],
): Promise<void> {
  const overlay = await readJson(absolutePath);
  if (!Number.isInteger(overlay.netuid) || !overlay.slug || !overlay.name) {
    console.error(
      `skipping ${absolutePath}: missing required netuid/slug/name field`,
    );
    return;
  }
  const { surfaces = [], ...subnetOverlay } = overlay;

  // This script only ever runs because registry/subnets/<slug>.json changed,
  // so `source` is unconditionally 'community' here — a subnet that used to
  // be machine-generated-only correctly flips to 'community' the moment a
  // contributor's first manual file for it merges, rather than staying
  // stale from before that file existed.
  subnetsOut.push({
    netuid: overlay.netuid,
    slug: overlay.slug,
    name: overlay.name,
    source: "community",
    overlay: subnetOverlay,
    source_commit: args.head,
  });

  const currentSurfaces: Row[] = [];
  for (const surface of surfaces) {
    currentSurfaces.push({ kind: surface.kind, url: surface.url });
    surfacesOut.push({
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
        operationalKindSet.has(surface.kind),
      ),
      public_safe: surface.public_safe !== false,
      overlay: surface,
      source_commit: args.head,
    });
  }
  pruneSurfacesOut.push({
    subnet_netuid: overlay.netuid,
    current_surfaces: currentSurfaces,
    source_commit: args.head,
    // This file's `surfaces` array is only ever the community-authored ones --
    // it has no visibility into machine-generated/candidate-promoted surfaces
    // the same subnet may also carry (that's generateBaselineOverlaySet's job,
    // via the scheduled backfill). Scope the Worker's prune to authority =
    // 'community' so this fast path can never delete a row it has no way to
    // know about.
    authority_scope: "community",
  });
}

function gitDiffFiles(base: string, head: string): string[] {
  const result = spawnSync("git", ["diff", "--name-only", `${base}..${head}`], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`git diff ${base}..${head} failed: ${result.stderr}`);
  }
  return result.stdout.split("\n").filter(Boolean);
}

function readSubnetFromCommit(commit: string, file: string): Row | null {
  const result = spawnSync("git", ["show", `${commit}:${file}`], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  if (result.status !== 0) return null;
  try {
    const overlay = JSON.parse(result.stdout);
    if (Number.isInteger(overlay.netuid)) return overlay;
  } catch {
    return null;
  }
  return null;
}

function fileExistsAtHead(file: string): boolean {
  const result = spawnSync("git", ["cat-file", "-e", `${args.head}:${file}`], {
    cwd: repoRoot,
  });
  return result.status === 0;
}

function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--base") parsed.base = argv[++i];
    if (argv[i] === "--head") parsed.head = argv[++i];
  }
  return parsed;
}

await main();
await endSessionAndFlush();
