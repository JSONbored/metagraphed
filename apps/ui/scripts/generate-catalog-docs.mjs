// Generates content/docs/catalog.mdx from the curated subnet overlays
// (#6634, follow-on from #1652's "catalog / resources sections generated
// from registry artifacts" acceptance line, never actually built). Reuses
// the exact same rendering helpers scripts/generate-registry-readme-section.mjs
// already uses for the README's own catalog section (scripts/lib/readme-catalog.mjs)
// so the two never drift apart on what counts as "curated" or how a subnet
// entry renders -- one source, two destinations (README + this docs page).
//
// Committed generated output, same convention as content/docs/api-reference/**
// (scripts/generate-openapi-docs.mjs) -- re-run this after a registry overlay
// changes:
//
//   node scripts/generate-catalog-docs.mjs
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import prettier from "prettier";
import { loadOverlays, renderCatalog } from "../../../scripts/lib/readme-catalog.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_PATH = path.join(__dirname, "../content/docs/catalog.mdx");

function frontmatter(overlays) {
  return [
    "---",
    "title: Subnet catalog",
    `description: ${overlays.length} curated subnets, generated from the registry overlays in registry/subnets/ -- focus areas, links, and coverage at a glance.`,
    "---",
    "",
    "",
  ].join("\n");
}

async function main() {
  const overlays = loadOverlays();
  const catalog = renderCatalog(overlays);
  const raw = `${frontmatter(overlays)}${catalog}\n`;
  // Run through this workspace's own Prettier config (MDX treats <sub> as
  // JSX, which reflows differently than the plain-markdown formatting the
  // shared renderer's output otherwise matches) so the committed file is
  // always byte-identical to what `format:check` -- and this generator
  // re-run -- both expect, regardless of which one runs first.
  // prettier.format() does NOT read .prettierrc on its own (that's CLI-only
  // behavior) -- resolveConfig() is required to pick it up here.
  const config = (await prettier.resolveConfig(OUTPUT_PATH)) ?? {};
  const formatted = await prettier.format(raw, {
    ...config,
    filepath: OUTPUT_PATH,
  });
  await writeFile(OUTPUT_PATH, formatted);
  console.log(`Wrote content/docs/catalog.mdx: ${overlays.length} curated subnets.`);
}

main();
