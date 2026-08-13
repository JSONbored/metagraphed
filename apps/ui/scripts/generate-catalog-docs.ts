// Generates content/docs/catalog.mdx from the curated subnet overlays
// (#6634). A THIN WRAPPER since #11109: the rendering -- frontmatter, the
// shared catalog body, and the workspace-config Prettier pass -- lives in
// scripts/lib/readme-catalog.ts (renderCatalogDocsMdx), where the
// always-running readme-catalog check holds this page beside README.md's
// section. One renderer, two destinations, one check.
//
// Committed generated output, same convention as content/docs/api-reference/**:
//
//   node scripts/generate-catalog-docs.ts
//
// (or `npm run readme:catalog` at the repo root, which writes both
// destinations.)
import { writeFile } from "node:fs/promises";
import path from "node:path";
import {
  CATALOG_DOCS_COMMITTED_PATH,
  curatedSubnetOverlays,
  loadOverlays,
  renderCatalogDocsMdx,
} from "../../../scripts/lib/readme-catalog.ts";

// CATALOG_DOCS_OUTPUT redirects the write, the same override
// generate-openapi-docs.ts takes as OPENAPI_DOCS_OUTPUT and for the same
// reason: scripts/validate-ui-docs-drift.ts regenerates into a temp directory
// and diffs, so a drift check can never leave a dirty working tree behind.
const OUTPUT_PATH = process.env.CATALOG_DOCS_OUTPUT
  ? path.resolve(process.env.CATALOG_DOCS_OUTPUT)
  : CATALOG_DOCS_COMMITTED_PATH;

async function main() {
  const overlays = loadOverlays();
  const formatted = await renderCatalogDocsMdx(overlays);
  await writeFile(OUTPUT_PATH, formatted);
  console.log(
    `Wrote ${OUTPUT_PATH === CATALOG_DOCS_COMMITTED_PATH ? "content/docs/catalog.mdx" : OUTPUT_PATH}: ${curatedSubnetOverlays(overlays).length} curated subnets.`,
  );
}

main();
