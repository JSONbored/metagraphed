// Renders the /og card variants to PNG for visual review (#8489).
//
// Why this exists: the OG card is the one surface in this app that CANNOT be
// checked by opening the site — it only exists as a rasterized image produced
// on the Worker, so "it looks fine in the browser" says nothing about it. Three
// real layout defects in the #8489 rebuild (a cropped stat rail, a card 160px
// wider than its own canvas, and copy washed out under the decorative diagonal)
// were invisible in code review and only showed up by rendering the markup and
// measuring the result. This script makes that check repeatable.
//
// It renders through SATORI, not Chromium. An earlier version of this script
// used Playwright, and that turned out to be structurally blind to a whole
// class of bug: satori subsets each font to the glyphs the card declares, so a
// character the subset misses rasterizes as a tofu box — but Chromium
// substitutes a full system font and paints it perfectly. Two real tofu bugs
// (the tau in every τ value, and the uppercased eyebrow pill) got through a
// green Chromium preview. Rendering with the same library the Worker uses is
// the only preview that can catch them.
//
// The Worker imports satori via workers-og, which can't load under Node (its
// yoga `.wasm` isn't resolvable by Node's ESM loader — the same reason
// handleOgImage imports it lazily). satori + satori-html + resvg here are the
// same pipeline workers-og runs, assembled directly.
//
// Usage:  npx tsx apps/ui/scripts/render-og-preview.ts [outDir]

import fs from "node:fs";
import path from "node:path";
import { Resvg } from "@resvg/resvg-js";
import satori from "satori";
import { html } from "satori-html";
import { glyphsForMarkup, renderCardMarkup } from "../src/lib/og-image.ts";

type Variant = Parameters<typeof renderCardMarkup>[0];

/**
 * One case per card shape the app actually emits, plus the pathological title
 * length `normalizeTitle` allows — that last one is the case that previously
 * pushed the stat rail off the canvas.
 *
 * `icon` values are the resolved data URIs handleOgImage passes in; the
 * variants below deliberately cover BOTH branches, because the interesting
 * case is the one where the icon does not resolve.
 */
const VARIANTS: Record<string, Variant> = {
  "1-home": {
    title: "Metagraphed",
    subtitle: "The Bittensor subnet integration registry",
    eyebrow: null,
    stats: [],
  },
  "2-subnet": {
    title: "Chutes",
    subtitle:
      "Chutes: Bittensor subnet 64 — interfaces, endpoints, schemas and live health (healthy), machine-readable on Metagraphed.",
    eyebrow: "Subnet",
    entity: true,
    status: "ok",
    // Resolved at render time below, from the real icon proxy.
    icon: null,
    stats: [
      { label: "Netuid", value: "SN64" },
      { label: "Price", value: "0.0832 τ" },
      { label: "Emission", value: "3.41%" },
    ],
  },
  "3-validator": {
    // The monogram case: tao.bot publishes a favicon, but no aggregator the
    // proxy queries has one, so `icon` is null and the tile must show "TA" —
    // exactly what the site's BrandIcon falls back to.
    title: "tao.bot",
    subtitle: "Cross-subnet performance, nominators, and staking history.",
    eyebrow: "Validator",
    entity: true,
    stats: [
      { label: "Total stake", value: "62.6M τ" },
      { label: "Subnets", value: "116" },
    ],
  },
  "4-account": {
    title: "5Grwva…GKutQY",
    subtitle: "Cross-subnet activity, registrations, and chain-event history.",
    eyebrow: "Account",
    entity: true,
    stats: [
      { label: "Events", value: "12,481" },
      { label: "Subnets", value: "9" },
    ],
  },
  "5-agents": {
    // One of OUR routes: not an entity, so the avatar slot takes the
    // Metagraphed mark rather than a meaningless "AG" monogram.
    title: "Agents & MCP",
    subtitle: "Connect an AI agent to the Bittensor subnet registry over MCP.",
    eyebrow: "Agents",
    stats: [],
  },
  "6-longtitle": {
    title:
      "A deliberately very long subnet name that should clamp rather than overflow the card edge",
    subtitle:
      "Bounded-input check: the title is capped at 110 chars and the subtitle at 90 before it ever reaches the renderer.",
    eyebrow: "Subnet",
    entity: true,
    status: "down",
    stats: [
      { label: "Netuid", value: "SN128" },
      { label: "Price", value: "0.0001 τ" },
      { label: "Total stake", value: "912.4K τ" },
    ],
  },
};

const outDir = process.argv[2] ?? "/tmp/og-preview";
fs.mkdirSync(outDir, { recursive: true });

/**
 * Same subsetting the Worker does — `text=` is what makes a missing glyph
 * render as tofu, so the preview has to fetch fonts the same way or it proves
 * nothing about the thing this script exists to catch.
 */
async function loadFont(family: string, weight: number, text: string): Promise<ArrayBuffer> {
  const url =
    `https://fonts.googleapis.com/css2?family=${encodeURIComponent(family)}:wght@${weight}` +
    `&text=${encodeURIComponent(text)}`;
  const css = await (
    await fetch(url, { headers: { "user-agent": "Mozilla/5.0 (compatible; og-preview)" } })
  ).text();
  const src = css.match(/src:\s*url\(([^)]+)\)/)?.[1];
  if (!src) throw new Error(`no font URL for ${family} ${weight}`);
  return await (await fetch(src)).arrayBuffer();
}

/** Resolve a real icon through the live proxy, exactly as handleOgImage does. */
async function resolveLiveIcon(host: string): Promise<string | null> {
  const res = await fetch(
    `https://api.metagraph.sh/api/v1/icon?host=${encodeURIComponent(host)}&size=128&theme=light`,
  );
  if (!res.ok) return null;
  const buf = Buffer.from(await res.arrayBuffer());
  return `data:${res.headers.get("content-type")?.split(";")[0]};base64,${buf.toString("base64")}`;
}

const subnetIcon = await resolveLiveIcon("chutes.ai");
const validatorIcon = await resolveLiveIcon("tao.bot");
if (VARIANTS["2-subnet"]) VARIANTS["2-subnet"].icon = subnetIcon;
console.log(`chutes.ai icon: ${subnetIcon ? "resolved" : "NOT RESOLVED → monogram fallback"}`);
console.log(`tao.bot   icon: ${validatorIcon ? "resolved" : "NOT RESOLVED → monogram fallback"}`);

for (const [name, variant] of Object.entries(VARIANTS)) {
  const markup = renderCardMarkup(variant);
  const glyphs = glyphsForMarkup(markup);
  const [bold, medium, regular, interBold, interRegular] = await Promise.all([
    loadFont("Space Grotesk", 700, glyphs),
    loadFont("Space Grotesk", 500, glyphs),
    loadFont("Space Grotesk", 400, glyphs),
    loadFont("Inter", 700, glyphs),
    loadFont("Inter", 400, glyphs),
  ]);

  const svg = await satori(html(markup) as never, {
    width: 1200,
    height: 630,
    fonts: [
      { name: "Space Grotesk", data: bold, weight: 700, style: "normal" },
      { name: "Space Grotesk", data: medium, weight: 500, style: "normal" },
      { name: "Space Grotesk", data: regular, weight: 400, style: "normal" },
      { name: "Inter", data: interBold, weight: 700, style: "normal" },
      { name: "Inter", data: interRegular, weight: 400, style: "normal" },
    ],
  });

  // Assert rather than just report: a card that isn't exactly the canvas is
  // the defect this script exists to catch, and a silent PNG would hide it.
  const dims = svg.match(/<svg[^>]*width="(\d+)"[^>]*height="(\d+)"/);
  if (dims && (dims[1] !== "1200" || dims[2] !== "630")) {
    throw new Error(`${name}: card is ${dims[1]}x${dims[2]}, expected 1200x630`);
  }

  const pngPath = path.join(outDir, `${name}.png`);
  fs.writeFileSync(pngPath, new Resvg(svg).render().asPng());
  console.log(`${name}  ${glyphs.length} glyphs  ${pngPath}`);
}

console.log(`\n${Object.keys(VARIANTS).length} variants rendered to ${outDir}`);
