// #8658: the callable catalog and the published registry must not disagree
// about what is probe-enabled and callable.
//
// operational-surfaces.json is BOTH the cron prober's cold-start input and the
// catalog `call_subnet_surface` resolves against. surfaces.json is the full
// published registry. The first is meant to be exactly the second, filtered to
// `probe.enabled && public_safe && operational kind`. When they drift, two
// things break at once and neither is visible: surfaces advertised as
// probe-enabled are never actually probed (so they accrue no health history),
// and an agent that finds them via `list_surfaces` gets an error from
// `call_subnet_surface` for an id that demonstrably exists.
//
// Measured on 2026-07-29: 10 eligible surfaces missing from the callable
// catalog, and 4 catalogued surfaces that had left the registry entirely and
// were still being probed.
//
// The hourly refresh lane does NOT catch this, and never did. The retired
// sync-operational-surfaces workflow regenerated the file from the committed
// inputs and compared it against the committed copy, so it reported
// "617 -> 617" and passed -- it was comparing a thing to itself. Its
// replacement, the hourly Worker cron in src/operational-surfaces-sync.ts
// (#9096), DERIVES the list from the published surfaces.json by the very
// filter this validator checks, so it cannot report a divergence either: it
// is the filter. This validator compares the two ARTIFACTS the build actually
// produces, which is where a real divergence would show up.
//
// Both artifacts come from one `npm run build`, so this should always hold; the
// point is that nothing was checking, and the filter lives in build-artifacts.ts
// while the consumers live in src/mcp-server.ts and src/health-prober.ts. A
// future edit to either side that silently changes the eligible set now fails
// here instead of quietly shrinking what agents can call.
import path from "node:path";
import { R2_STAGING_RELATIVE_ROOT } from "../src/artifact-storage.ts";
import { readJson, repoRoot } from "./lib.ts";

type Row = Record<string, unknown>;

const operationalPath = path.join(
  repoRoot,
  "public/metagraph/operational-surfaces.json",
);
const surfacesPath = path.join(
  repoRoot,
  R2_STAGING_RELATIVE_ROOT,
  "surfaces.json",
);

const operational = await readJson(operationalPath);
const surfaces: Row | null = await readJson(surfacesPath).catch(() => null);

// surfaces.json is an R2-tier artifact staged by the build, not committed. On a
// checkout that has not run `npm run build` there is nothing to compare against
// -- skip rather than fail, so this validator is safe to run in any order and
// never turns "you didn't build" into a parity error.
if (!surfaces || !Array.isArray(surfaces.surfaces)) {
  console.log(
    `operational-surface parity: skipped (no staged ${path.relative(repoRoot, surfacesPath)}; run \`npm run build\` first)`,
  );
  process.exit(0);
}

const kinds = new Set(
  Array.isArray(operational.kinds) ? (operational.kinds as string[]) : [],
);
if (kinds.size === 0) {
  console.error(
    "operational-surface parity: operational-surfaces.json has no `kinds` list to filter by.",
  );
  process.exit(1);
}

const eligible = (surfaces.surfaces as Row[]).filter(
  (surface) =>
    (surface.probe as Row | undefined)?.enabled &&
    surface.public_safe &&
    typeof surface.kind === "string" &&
    kinds.has(surface.kind),
);

const eligibleIds = new Set(eligible.map((surface) => String(surface.id)));
const catalogIds = new Set(
  (operational.surfaces as Row[]).map((surface) => String(surface.surface_id)),
);

// Both directions matter, and they fail differently. A surface eligible but
// absent from the catalog is advertised and unreachable; one in the catalog but
// no longer eligible is being probed after it left the registry.
const missing = [...eligibleIds].filter((id) => !catalogIds.has(id)).sort();
const stale = [...catalogIds].filter((id) => !eligibleIds.has(id)).sort();

if (missing.length === 0 && stale.length === 0) {
  console.log(
    `operational-surface parity: OK (${eligibleIds.size} eligible surfaces, exact match).`,
  );
  process.exit(0);
}

console.error("operational-surface parity FAILED.\n");
console.error(
  `  eligible in surfaces.json          : ${eligibleIds.size}\n` +
    `  in operational-surfaces.json       : ${catalogIds.size}\n`,
);
const preview = (ids: string[]) =>
  ids
    .slice(0, 20)
    .map((id) => `    - ${id}`)
    .join("\n") +
  (ids.length > 20 ? `\n    ... and ${ids.length - 20} more` : "");
if (missing.length) {
  console.error(
    `  ${missing.length} surface(s) are probe-enabled, public-safe and a callable kind, but are\n` +
      `  ABSENT from the callable catalog. They will never be health-probed, and\n` +
      `  call_subnet_surface will reject their ids:\n${preview(missing)}\n`,
  );
}
if (stale.length) {
  console.error(
    `  ${stale.length} surface(s) are in the callable catalog but no longer eligible in the\n` +
      `  registry. They are still being probed after leaving it:\n${preview(stale)}\n`,
  );
}
console.error(
  "  Both artifacts come from one `npm run build`, so this normally means the\n" +
    "  eligibility filter in scripts/build-artifacts.ts and the consumers in\n" +
    "  src/mcp-server.ts / src/health-prober.ts have gone out of step. Rebuild\n" +
    "  and re-check before changing either.",
);
process.exit(1);
