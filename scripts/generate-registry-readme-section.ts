// Awesome-list-style subnet catalog for the README (#1020).
//
// Renders a categorized, link-rich catalog of the CURATED subnets and injects it
// between the <!-- BEGIN:REGISTRY-CATALOG --> / <!-- END:REGISTRY-CATALOG -->
// markers in README.md.
//
// Source = the COMMITTED curated overlays (registry/subnets/*.json), which change
// only on human contributions — NOT the event-driven + daily-floor data publish.
// So the README never churns on a data publish; it regenerates only when an overlay
// changes (the gittensor flywheel: an enriched subnet shows up in the catalog →
// visibility → more contributions). Live health/readiness links out to the profile
// rather than being inlined, so there are no per-view badge requests baked into git.
//
// The pure catalog-rendering helpers live in scripts/lib/readme-catalog.ts (#6247);
// this file is a thin CLI wrapper over them.
//
//   node scripts/generate-registry-readme-section.ts           # write README.md
//   node scripts/generate-registry-readme-section.ts --check    # verify up-to-date

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { repoRoot } from "./lib.ts";
import {
  injectedReadme,
  loadOverlays,
  renderCatalog,
} from "./lib/readme-catalog.ts";

const README_PATH = path.join(repoRoot, "README.md");

function main(): void {
  const check = process.argv.includes("--check");
  const overlays = loadOverlays();
  const catalog = renderCatalog(overlays);
  const current = readFileSync(README_PATH, "utf8");
  const next = injectedReadme(current, catalog);

  if (check) {
    if (next !== current) {
      console.error(
        "README catalog is stale. Run `npm run readme:catalog` and commit README.md.",
      );
      process.exit(1);
    }
    console.log(
      `README catalog up to date (${overlays.length} curated subnets).`,
    );
    return;
  }

  writeFileSync(README_PATH, next);
  console.log(
    `Wrote README catalog: ${overlays.length} curated subnets injected.`,
  );
}

main();
