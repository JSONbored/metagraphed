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
//   node scripts/generate-registry-readme-section.mjs           # write README.md
//   node scripts/generate-registry-readme-section.mjs --check    # verify up-to-date

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { repoRoot } from "./lib.mjs";

const BEGIN = "<!-- BEGIN:REGISTRY-CATALOG -->";
const END = "<!-- END:REGISTRY-CATALOG -->";
const README_PATH = path.join(repoRoot, "README.md");
const OVERLAYS_DIR = path.join(repoRoot, "registry/subnets");
const SITE = "https://metagraph.sh";
const API = "https://api.metagraph.sh";

// Provenance / process tags (how an entry was curated) are noise in a catalog —
// keep only the use-case "focus" tags. Prefix-matched so new official-*/baseline-*
// tags are filtered automatically.
const PROVENANCE_PREFIX = /^(official|baseline|identity)-/;
const PROVENANCE_EXACT = new Set([
  "pilot",
  "root",
  "system",
  "native-only",
  "macrocosmos",
]);

function loadOverlays() {
  return readdirSync(OVERLAYS_DIR)
    .filter((file) => file.endsWith(".json"))
    .map((file) =>
      JSON.parse(readFileSync(path.join(OVERLAYS_DIR, file), "utf8")),
    )
    .filter((overlay) => Number.isInteger(overlay?.netuid))
    .sort((a, b) => a.netuid - b.netuid);
}

function focusTags(overlay) {
  return (overlay.categories || [])
    .filter((tag) => !PROVENANCE_PREFIX.test(tag) && !PROVENANCE_EXACT.has(tag))
    .sort();
}

function links(overlay) {
  const out = [];
  if (overlay.website_url) out.push(`[site](${overlay.website_url})`);
  if (overlay.docs_url) out.push(`[docs](${overlay.docs_url})`);
  if (overlay.source_repo) out.push(`[repo](${overlay.source_repo})`);
  return out.join(" · ") || "—";
}

function renderCatalog(overlays) {
  const focusCounts = new Map();
  for (const overlay of overlays) {
    for (const tag of focusTags(overlay)) {
      focusCounts.set(tag, (focusCounts.get(tag) || 0) + 1);
    }
  }
  const topFocus = [...focusCounts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 12)
    .map(([tag, count]) => `\`${tag}\` ${count}`)
    .join(" · ");

  const withSite = overlays.filter((o) => o.website_url).length;
  const withDocs = overlays.filter((o) => o.docs_url).length;
  const withRepo = overlays.filter((o) => o.source_repo).length;

  // A bulleted list (not a markdown table): Prettier pads table cells to the
  // widest column, which at ~90 rows of long URLs explodes the diff — a list
  // stays Prettier-stable and renders just as cleanly on GitHub.
  const items = overlays.map((overlay) => {
    const name = overlay.name || `Subnet ${overlay.netuid}`;
    const focus = focusTags(overlay)
      .map((tag) => `\`${tag}\``)
      .join(" ");
    const linkStr = links(overlay);
    return (
      `- **[${name}](${SITE}/subnets/${overlay.netuid})** \`SN${overlay.netuid}\`` +
      (focus ? ` — ${focus}` : "") +
      (linkStr !== "—" ? ` · ${linkStr}` : "")
    );
  });

  return [
    `**${overlays.length} curated subnets** — ${withSite} with a site, ${withDocs} with docs, ${withRepo} with a public repo. Live health, search, and the full list (every active subnet, not just the curated ones) at **[metagraph.sh](${SITE})**; per-subnet JSON at \`${API}/api/v1/subnets/{netuid}\`.`,
    "",
    `**Focus areas:** ${topFocus}`,
    "",
    ...items,
    "",
    `<sub>Auto-generated from the curated overlays in \`registry/subnets/\` by \`scripts/generate-registry-readme-section.mjs\` — enrich a subnet (one PR) and it appears here. Not the live list; browse + monitor everything at [metagraph.sh](${SITE}).</sub>`,
  ].join("\n");
}

function injectedReadme(readme, catalog) {
  const beginAt = readme.indexOf(BEGIN);
  const endAt = readme.indexOf(END);
  if (beginAt === -1 || endAt === -1 || endAt < beginAt) {
    throw new Error(
      `README.md is missing the ${BEGIN} / ${END} markers (add them where the catalog should render).`,
    );
  }
  const before = readme.slice(0, beginAt + BEGIN.length);
  const after = readme.slice(endAt);
  return `${before}\n\n${catalog}\n\n${after}`;
}

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
