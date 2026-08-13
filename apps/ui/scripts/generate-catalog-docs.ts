// Generates content/docs/catalog.mdx from the curated subnet overlays
// (#6634, follow-on from #1652's "catalog / resources sections generated
// from registry artifacts" acceptance line, never actually built). Reuses
// the exact same rendering helpers scripts/generate-registry-readme-section.ts
// already uses for the README's own catalog section (scripts/lib/readme-catalog.ts)
// so the two never drift apart on what counts as "curated" or how a subnet
// entry renders -- one source, two destinations (README + this docs page).
//
// Committed generated output, same convention as content/docs/api-reference/**
// (scripts/generate-openapi-docs.ts) -- re-run this after a registry overlay
// changes:
//
//   node scripts/generate-catalog-docs.ts
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import prettier from "prettier";
import {
  curatedSubnetOverlays,
  loadOverlays,
  renderCatalog,
} from "../../../scripts/lib/readme-catalog.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// CATALOG_DOCS_OUTPUT redirects the write, the same override
// generate-openapi-docs.ts takes as OPENAPI_DOCS_OUTPUT and for the same
// reason: scripts/validate-ui-docs-drift.ts regenerates into a temp directory
// and diffs, so a drift check can never leave a dirty working tree behind.
const COMMITTED_PATH = path.join(__dirname, "../content/docs/catalog.mdx");
const OUTPUT_PATH = process.env.CATALOG_DOCS_OUTPUT
  ? path.resolve(process.env.CATALOG_DOCS_OUTPUT)
  : COMMITTED_PATH;

function frontmatter(curatedCount: number) {
  return [
    "---",
    "title: Subnet catalog",
    `description: ${curatedCount} curated subnets, generated from the registry overlays in registry/subnets/ -- focus areas, links, and coverage at a glance.`,
    "---",
    "",
    "",
  ].join("\n");
}

async function main() {
  const overlays = loadOverlays();
  // metagraphed#8352: this used to pass the raw overlays.length (includes
  // root/SN0) straight into the frontmatter description, silently
  // disagreeing with renderCatalog's own body text below it, which
  // (correctly) excludes root from "curated subnets" -- one number, computed
  // one way, used in both places.
  const curatedCount = curatedSubnetOverlays(overlays).length;
  const catalog = renderCatalog(overlays);
  const raw = `${frontmatter(curatedCount)}${catalog}\n`;
  // Run through this workspace's own Prettier config (MDX treats <sub> as
  // JSX, which reflows differently than the plain-markdown formatting the
  // shared renderer's output otherwise matches) so the committed file is
  // always byte-identical to what `format:check` -- and this generator
  // re-run -- both expect, regardless of which one runs first.
  // prettier.format() does NOT read .prettierrc on its own (that's CLI-only
  // behavior) -- resolveConfig() is required to pick it up here.
  // Resolve against COMMITTED_PATH, never OUTPUT_PATH: prettier looks the
  // config up from the file's directory, and a CATALOG_DOCS_OUTPUT pointing at
  // a temp dir would find none -- formatting the drift check's copy differently
  // from the committed file and reporting drift that does not exist.
  const config = (await prettier.resolveConfig(COMMITTED_PATH)) ?? {};
  const formatted = await prettier.format(raw, {
    ...config,
    filepath: COMMITTED_PATH,
  });
  await writeFile(OUTPUT_PATH, formatted);
  console.log(
    `Wrote ${OUTPUT_PATH === COMMITTED_PATH ? "content/docs/catalog.mdx" : OUTPUT_PATH}: ${curatedCount} curated subnets.`,
  );
}

main();
