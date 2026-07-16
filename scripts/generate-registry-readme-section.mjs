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
// The pure catalog logic (loadOverlays / focusTags / links / renderCatalog /
// injectedReadme) lives in scripts/lib/registry-readme-section.mjs (#6247) so it
// is unit-tested directly; this entrypoint keeps only the README read/write and
// the --check wiring.
//
//   node scripts/generate-registry-readme-section.mjs           # write README.md
//   node scripts/generate-registry-readme-section.mjs --check    # verify up-to-date

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { repoRoot } from "./lib.mjs";
import {
  loadOverlays,
  renderCatalog,
  injectedReadme,
} from "./lib/registry-readme-section.mjs";

const README_PATH = path.join(repoRoot, "README.md");

function main() {
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
