// Render actual Satori/Resvg social cards with the production font loader.
// All entity data and logos are local fixtures; no catalog or endpoint probes.
// Usage: node --experimental-strip-types apps/ui/scripts/render-og-preview.ts [output] [--write-fallback]
import fs from "node:fs";
import path from "node:path";
import { Resvg } from "@resvg/resvg-js";
import type { ReactNode } from "react";
import satori from "satori";
import { html } from "satori-html";
import {
  CARD_FONT_FACES,
  fontSubsetText,
  loadCardFont,
  markDataUri,
  normalizeSubtitle,
  normalizeTitle,
  renderCardMarkup,
} from "../src/lib/og-image.ts";

type Variant = Parameters<typeof renderCardMarkup>[0];
const variants: Record<string, Variant> = {
  home: {
    title: "Metagraphed",
    subtitle: "Explore Bittensor. Follow the chain, subnets and public interfaces.",
    eyebrow: "Explorer",
    stats: [],
  },
  agents: {
    title: "Agents",
    subtitle: "Connect an AI agent to Bittensor — MCP tools, playbooks and live data",
    eyebrow: "Agents",
    stats: [],
  },
  subnet: {
    title: "Example subnet",
    subtitle: "Interfaces, endpoints, schemas and observed surface health.",
    eyebrow: "Subnet",
    entity: true,
    icon: markDataUri("black"),
    stats: [
      { label: "Netuid", value: "SN19" },
      { label: "Price", value: "0.0832 τ" },
      { label: "Emission", value: "3.41%" },
    ],
  },
  validator: {
    title: "Example operator",
    subtitle: "Hotkeys, identities, observed take and subnet memberships.",
    eyebrow: "Validator",
    entity: true,
    stats: [
      { label: "Hotkeys", value: "3" },
      { label: "Subnets", value: "24" },
    ],
  },
  account: {
    title: "5Grwva…GKutQY",
    subtitle: "Account activity, registrations and chain-event history.",
    eyebrow: "Account",
    entity: true,
    stats: [{ label: "Events", value: "12,481" }],
  },
  documentation: {
    title: "Working with the API",
    subtitle: "Find public interfaces and read the data behind the explorer.",
    eyebrow: "Documentation",
    stats: [],
  },
  long: {
    title: normalizeTitle(
      "An exceptionally long page title with complete context and identifiers that must remain readable when this link is shared",
    ),
    subtitle: normalizeSubtitle(
      "A bounded description that stays inside the image and remains legible alongside three maximum-length statistic fields.",
    ),
    eyebrow: "A long category name for a page",
    entity: true,
    stats: [
      { label: "Longest supported label", value: "1234567890123456789012345678" },
      { label: "Unknown measurement", value: "Not available" },
      { label: "Observed count", value: "0" },
    ],
  },
  unbroken: {
    title: normalizeTitle("W".repeat(110)),
    subtitle: normalizeSubtitle(
      "An identifier at the maximum allowed length with no spaces and a full supporting description.",
    ),
    eyebrow: "Entity",
    entity: true,
    stats: [{ label: "Observed count", value: "0" }],
  },
  maximum: {
    title: normalizeTitle("W".repeat(110)),
    subtitle: normalizeSubtitle("W".repeat(90)),
    eyebrow: "W".repeat(32),
    entity: true,
    stats: Array.from({ length: 3 }, () => ({ label: "W".repeat(24), value: "W".repeat(28) })),
  },
  unicode: {
    title: "Économie & τ — observations",
    subtitle: "Prices, percentages and symbols: 0.61% · 0.0832 τ → 0.09 τ",
    eyebrow: "Data",
    stats: [{ label: "Change", value: "−2.3%" }],
  },
  unknown: {
    title: "Example service",
    subtitle: "No current surface-health observation is available.",
    eyebrow: "Provider",
    entity: true,
    status: "unknown",
    stats: [],
  },
};
const outDir = process.argv[2] ?? "/tmp/og-preview";
fs.mkdirSync(outDir, { recursive: true });
for (const [name, variant] of Object.entries(variants)) {
  const markup = renderCardMarkup(variant);
  const text = fontSubsetText(markup);
  const fonts = await Promise.all(
    CARD_FONT_FACES.map(async (face) => ({
      ...face,
      data: await loadCardFont(face.name, face.weight, text),
      style: "normal" as const,
    })),
  );
  const svg = await satori(html(markup) as ReactNode, { width: 1200, height: 630, fonts });
  const rendered = new Resvg(svg).render();
  if (rendered.width !== 1200 || rendered.height !== 630)
    throw new Error(`${name}: invalid canvas`);
  fs.writeFileSync(path.join(outDir, `${name}.png`), rendered.asPng());
  fs.writeFileSync(path.join(outDir, `${name}.svg`), svg);
  console.log(`${name}: 1200×630 PNG`);
}

// Regenerate the committed full-size recovery asset deliberately with the art.
if (process.argv.includes("--write-fallback")) {
  fs.copyFileSync(
    path.join(outDir, "home.png"),
    new URL("../public/og-fallback.png", import.meta.url),
  );
  console.log("Updated public/og-fallback.png from the current home render");
}
