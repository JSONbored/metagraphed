// Merge-triggered FAST PATH: upserts the registry/subnets/*.json +
// registry/providers/*.json files that changed in a push into the Postgres
// tables added in deploy/postgres/schema.sql, within seconds/minutes of a
// merge rather than waiting for the next scheduled full resync. Its sibling,
// scripts/backfill-registry-postgres.mjs, run on a schedule, is what keeps
// the machine-discovered half of the same tables (subnets with no manual
// file, candidate-promoted surfaces) fresh on ITS OWN cadence — that content
// isn't tied to a git commit the way this script's trigger is. Together they
// make Postgres the single, always-fresh source of truth for every
// subnet/provider/surface fact, human-authored or machine-discovered (see
// schema.sql's own comment for why these live in one table set).
//
// Contribution/review is UNCHANGED: a contributor's PR still touches only
// registry/subnets/<slug>.json, still gets scored by the Gittensory Gate
// exactly as today. This script only runs AFTER a merge lands on main, reading
// the already-reviewed file — the write path a contributor's credentials
// never reach (see .github/workflows/sync-registry-to-postgres.yml, which
// this script is called from).
//
// Independently re-validates each changed subnet file against
// scripts/validate-surface.mjs before writing (defense in depth: the Gate
// already checked it pre-merge, this checks again post-merge) rather than
// trusting the git content blindly.
//
// Safe to merge/run before DATABASE_URL is provisioned: with no DATABASE_URL,
// this exits 0 having done nothing, so adding this workflow can't break
// anything ahead of the real credential existing.
//
// Usage:
//   DATABASE_URL=postgres://... node scripts/sync-registry-to-postgres.mjs \
//     --base <sha> --head <sha>
import { spawnSync } from "node:child_process";
import path from "node:path";
import postgres from "postgres";
import {
  readJson,
  repoRoot,
  stableStringify,
  subnetSurfaceKey,
} from "./lib.mjs";
import { OPERATIONAL_SURFACE_KINDS } from "../src/health-probe-core.mjs";

const args = parseArgs(process.argv.slice(2));
const operationalKindSet = new Set(OPERATIONAL_SURFACE_KINDS);

async function main() {
  if (!process.env.DATABASE_URL) {
    console.log(
      "DATABASE_URL not set — registry-to-Postgres sync isn't provisioned yet, nothing to do.",
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

  const sql = postgres(process.env.DATABASE_URL, {
    max: 5,
    prepare: false,
    fetch_types: false,
  });

  const summary = {
    providers_written: 0,
    subnets_written: 0,
    surfaces_written: 0,
    skipped_invalid: [],
  };

  try {
    for (const file of changedFiles) {
      const absolutePath = path.join(repoRoot, file);
      const stillExists = fileExistsAtHead(file);
      if (!stillExists) {
        // Deletions aren't synced yet (rare — this repo's surface model is
        // append-only in practice); leaving the last-known row in place is
        // safer than guessing at removal semantics here.
        console.log(
          `${file} was deleted in this push; leaving its row(s) as-is`,
        );
        continue;
      }

      if (file.startsWith("registry/subnets/")) {
        const revalidation = spawnSync(
          process.execPath,
          ["scripts/validate-surface.mjs", "--", file],
          { cwd: repoRoot, encoding: "utf8" },
        );
        if (revalidation.status !== 0) {
          console.error(
            `skipping ${file}: failed independent re-validation post-merge (should be unreachable if the Gate is working — investigate)`,
          );
          summary.skipped_invalid.push(file);
          continue;
        }
        await syncSubnetFile(sql, absolutePath, summary);
      } else {
        await syncProviderFile(sql, absolutePath, summary);
      }
    }
    console.log(stableStringify(summary));
    if (summary.skipped_invalid.length > 0) {
      // A file the Gate already merged failing re-validation here is a real
      // signal something is wrong (a race, or a Gate/schema drift) — surface
      // it as a failure so it pages someone rather than silently skipping.
      process.exit(1);
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function syncProviderFile(sql, absolutePath, summary) {
  const overlay = await readJson(absolutePath);
  if (!overlay.id) {
    console.error(`skipping ${absolutePath}: missing required "id" field`);
    return;
  }
  const sourceCommit = args.head;
  await sql`
    INSERT INTO providers (id, overlay, source_commit)
    VALUES (${overlay.id}, ${sql.json(overlay)}, ${sourceCommit})
    ON CONFLICT (id) DO UPDATE SET
      overlay = EXCLUDED.overlay,
      source_commit = EXCLUDED.source_commit,
      updated_at = now()
    WHERE providers.overlay IS DISTINCT FROM EXCLUDED.overlay`;
  summary.providers_written += 1;
}

async function syncSubnetFile(sql, absolutePath, summary) {
  const overlay = await readJson(absolutePath);
  if (!Number.isInteger(overlay.netuid) || !overlay.slug || !overlay.name) {
    console.error(
      `skipping ${absolutePath}: missing required netuid/slug/name field`,
    );
    return;
  }
  const sourceCommit = args.head;
  const { surfaces = [], ...subnetOverlay } = overlay;

  // This script only ever runs because registry/subnets/<slug>.json changed,
  // so `source` is unconditionally 'community' here -- explicitly SET it
  // (not just relied on as the column default) so a subnet that used to be
  // machine-generated-only correctly flips to 'community' the moment a
  // contributor's first manual file for it merges, rather than staying
  // stale from before that file existed.
  await sql`
    INSERT INTO subnets (netuid, slug, name, source, overlay, source_commit)
    VALUES (${overlay.netuid}, ${overlay.slug}, ${overlay.name}, 'community', ${sql.json(subnetOverlay)}, ${sourceCommit})
    ON CONFLICT (netuid) DO UPDATE SET
      slug = EXCLUDED.slug,
      name = EXCLUDED.name,
      source = 'community',
      overlay = EXCLUDED.overlay,
      source_commit = EXCLUDED.source_commit,
      updated_at = now()
    WHERE subnets.overlay IS DISTINCT FROM EXCLUDED.overlay OR subnets.source IS DISTINCT FROM 'community'`;
  summary.subnets_written += 1;

  for (const surface of surfaces) {
    const providerRow = surface.provider
      ? await sql`SELECT id FROM providers WHERE id = ${surface.provider}`
      : [];
    const providerId = providerRow[0]?.id ?? null;
    const surfaceKey = subnetSurfaceKey(surface, overlay.netuid);
    const probeEligible = Boolean(
      surface.probe?.enabled &&
      surface.public_safe &&
      operationalKindSet.has(surface.kind),
    );
    const reviewState = surface.review?.state || "community-submitted";
    const authority = surface.authority || "community";
    const publicSafe = surface.public_safe !== false;

    // Only log a history row when the surface's overlay actually changed --
    // otherwise every merge that happens to touch a sibling surface in the
    // same file would re-log every unrelated surface as "updated" noise.
    const existing = await sql`
      SELECT overlay FROM surfaces WHERE subnet_netuid = ${overlay.netuid} AND kind = ${surface.kind} AND url = ${surface.url}`;
    const changed =
      existing.length === 0 ||
      stableStringify(existing[0].overlay) !== stableStringify(surface);

    const result = await sql`
      INSERT INTO surfaces (
        subnet_netuid, provider_id, surface_key, kind, url,
        authority, review_state, probe_eligible, public_safe,
        overlay, source_commit
      )
      VALUES (
        ${overlay.netuid}, ${providerId}, ${surfaceKey}, ${surface.kind}, ${surface.url},
        ${authority}, ${reviewState}, ${probeEligible}, ${publicSafe},
        ${sql.json(surface)}, ${sourceCommit}
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

    if (changed) {
      const action = result[0]?.inserted ? "insert" : "update";
      await sql`
        INSERT INTO surface_history (subnet_netuid, action, overlay, source_commit)
        VALUES (${overlay.netuid}, ${action}, ${sql.json(surface)}, ${sourceCommit})`;
      summary.surfaces_written += 1;
    }
  }
}

function gitDiffFiles(base, head) {
  const result = spawnSync("git", ["diff", "--name-only", `${base}..${head}`], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`git diff ${base}..${head} failed: ${result.stderr}`);
  }
  return result.stdout.split("\n").filter(Boolean);
}

function fileExistsAtHead(file) {
  const result = spawnSync("git", ["cat-file", "-e", `${args.head}:${file}`], {
    cwd: repoRoot,
  });
  return result.status === 0;
}

function parseArgs(argv) {
  const parsed = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--base") parsed.base = argv[++i];
    if (argv[i] === "--head") parsed.head = argv[++i];
  }
  return parsed;
}

await main();
