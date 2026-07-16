// Pure rendering helpers for the README subnet catalog (#1020), extracted from
// scripts/generate-registry-readme-section.mjs (#6247 testability decomposition)
// so the catalog logic — focus-tag filtering, link composition, ranking, and
// marker injection — is unit-tested directly, matching the convention every
// other scripts/lib/*.mjs helper follows. The generator keeps only the README
// read/write + --check wiring; everything here is a pure function over plain
// objects/strings (loadOverlays takes its directory as an argument, so it too
// is testable against a fixture dir).

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { repoRoot } from "../lib.mjs";

export const BEGIN = "<!-- BEGIN:REGISTRY-CATALOG -->";
export const END = "<!-- END:REGISTRY-CATALOG -->";
export const OVERLAYS_DIR = path.join(repoRoot, "registry/subnets");
export const SITE = "https://metagraph.sh";
export const API = "https://api.metagraph.sh";

// Provenance / process tags (how an entry was curated) are noise in a catalog —
// keep only the use-case "focus" tags. Prefix-matched so new official-*/baseline-*
// tags are filtered automatically.
export const PROVENANCE_PREFIX = /^(official|baseline|identity)-/;
export const PROVENANCE_EXACT = new Set([
  "pilot",
  "root",
  "system",
  "native-only",
  "macrocosmos",
]);

export function loadOverlays(dir = OVERLAYS_DIR) {
  return readdirSync(dir)
    .filter((file) => file.endsWith(".json"))
    .map((file) => JSON.parse(readFileSync(path.join(dir, file), "utf8")))
    .filter((overlay) => Number.isInteger(overlay?.netuid))
    .sort((a, b) => a.netuid - b.netuid);
}

export function focusTags(overlay) {
  return (overlay.categories || [])
    .filter((tag) => !PROVENANCE_PREFIX.test(tag) && !PROVENANCE_EXACT.has(tag))
    .sort();
}

export function links(overlay) {
  const out = [];
  if (overlay.website_url) out.push(`[site](${overlay.website_url})`);
  if (overlay.docs_url) out.push(`[docs](${overlay.docs_url})`);
  if (overlay.source_repo) out.push(`[repo](${overlay.source_repo})`);
  return out.join(" · ") || "—";
}

export function renderCatalog(overlays) {
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

export function injectedReadme(readme, catalog) {
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
