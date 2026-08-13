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

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { repoRoot } from "./lib.ts";
import {
  CATALOG_DOCS_COMMITTED_PATH,
  injectedReadme,
  loadOverlays,
  renderCatalog,
  renderCatalogDocsMdx,
} from "./lib/readme-catalog.ts";

const README_PATH = path.join(repoRoot, "README.md");

async function main(): Promise<void> {
  const check = process.argv.includes("--check");
  const overlays = loadOverlays();
  const catalog = renderCatalog(overlays);
  const current = readFileSync(README_PATH, "utf8");
  const next = injectedReadme(current, catalog);
  // ONE RENDERER, TWO DESTINATIONS, ONE CHECK (#11109). catalog.mdx's drift
  // check used to live only in the path-filtered ui job, which registry-only
  // PRs skip -- so the PR that caused a drift passed and every unrelated PR
  // after it failed. Held here because this command runs on every PR. A
  // checkout without apps/ui (the pipeline sandbox copies data dirs only) is
  // not this check's problem to report.
  const docsPresent = existsSync(path.dirname(CATALOG_DOCS_COMMITTED_PATH));
  const docsNext = docsPresent ? await renderCatalogDocsMdx(overlays) : null;

  if (check) {
    if (next !== current) {
      console.error(
        "README catalog is stale. Run `npm run readme:catalog` and commit README.md.",
      );
      process.exit(1);
    }
    if (
      docsNext !== null &&
      (!existsSync(CATALOG_DOCS_COMMITTED_PATH) ||
        readFileSync(CATALOG_DOCS_COMMITTED_PATH, "utf8") !== docsNext)
    ) {
      console.error(
        "apps/ui/content/docs/catalog.mdx is stale. Run `npm run readme:catalog` and commit it -- a registry overlay change regenerates BOTH catalog destinations.",
      );
      process.exit(1);
    }
    console.log(
      `README catalog up to date (${overlays.length} curated overlays, incl. root)` +
        (docsNext !== null ? "; docs catalog page matches." : "."),
    );
    return;
  }

  writeFileSync(README_PATH, next);
  if (docsNext !== null) writeFileSync(CATALOG_DOCS_COMMITTED_PATH, docsNext);
  console.log(
    `Wrote README catalog: ${overlays.length} curated overlays injected (incl. root)` +
      (docsNext !== null ? "; docs catalog page regenerated." : "."),
  );
}

await main();
