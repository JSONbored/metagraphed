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
// It renders the SAME `renderCardMarkup` output the Worker uses, in Chromium at
// exactly 1200x630. Chromium is a stand-in for satori's rasterizer, not an
// exact match — satori implements a subset of CSS — but every property this
// card relies on (flexbox, absolute positioning, border-radius, explicit px
// sizing) is well inside that subset, and layout/overflow bugs reproduce
// faithfully. The authoritative render still happens on the Worker.
//
// Usage:  npx tsx apps/ui/scripts/render-og-preview.ts [outDir]

import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import { renderCardMarkup } from "../src/lib/og-image.ts";

type Variant = Parameters<typeof renderCardMarkup>[0];

/** One case per card shape the app actually emits, plus the pathological
 * title length `normalizeTitle` allows — that last one is the case that
 * previously pushed the stat rail off the canvas. */
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
    stats: [
      { label: "Netuid", value: "SN64" },
      { label: "Alpha price", value: "0.0832 τ" },
    ],
  },
  "3-validator": {
    title: "tao.bot",
    subtitle: "Cross-subnet performance, nominators, and staking history.",
    eyebrow: "Validator",
    stats: [
      { label: "Total stake", value: "1.42M τ" },
      { label: "Subnets", value: "37" },
    ],
  },
  "4-account": {
    title: "5Grwva…GKutQY",
    subtitle: "Cross-subnet activity, registrations, and chain-event history.",
    eyebrow: "Account",
    stats: [
      { label: "Events", value: "12,481" },
      { label: "Subnets", value: "9" },
    ],
  },
  "5-docs": {
    title: "Chain events — Metagraphed docs",
    subtitle: "The Bittensor subnet integration registry",
    eyebrow: null,
    stats: [],
  },
  "6-longtitle": {
    title:
      "A deliberately very long subnet name that should clamp rather than overflow the card edge",
    subtitle:
      "Bounded-input check: the title is capped at 110 chars and the subtitle at 90 before it ever reaches the renderer.",
    eyebrow: "Subnet",
    stats: [
      { label: "Netuid", value: "SN128" },
      { label: "Alpha price", value: "0.0001 τ" },
    ],
  },
};

const outDir = process.argv[2] ?? "/tmp/og-preview";
fs.mkdirSync(outDir, { recursive: true });

// The card sets its own 1200x630; the wrapper only needs to not constrain it,
// so the screenshot bounds are the card's real box (this is how the
// content-box overflow bug was caught — a wrapper that forced the size would
// have hidden it).
function page(variant: Variant): string {
  return `<!doctype html><meta charset="utf-8">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;700&display=swap" rel="stylesheet">
<style>html,body{margin:0;padding:0}#card{display:inline-flex}</style>
<div id="card">${renderCardMarkup(variant)}</div>`;
}

const browser = await chromium.launch();
const tab = await browser.newPage({
  viewport: { width: 1200, height: 630 },
  deviceScaleFactor: 1,
});

for (const [name, variant] of Object.entries(VARIANTS)) {
  const htmlPath = path.join(outDir, `${name}.html`);
  fs.writeFileSync(htmlPath, page(variant));
  await tab.goto(`file://${htmlPath}`, { waitUntil: "networkidle" });
  // Let the webfont settle; a fallback-font render would misreport line counts.
  await tab.waitForTimeout(600);

  const box = await tab.evaluate(() => {
    const card = document.querySelector("#card > div") as HTMLElement;
    const r = card.getBoundingClientRect();
    return { w: Math.round(r.width), h: Math.round(r.height) };
  });
  // Assert rather than just report: a card that isn't exactly the canvas is
  // the defect this script exists to catch, and a silent PNG would hide it.
  if (box.w !== 1200 || box.h !== 630) {
    throw new Error(`${name}: card is ${box.w}x${box.h}, expected 1200x630`);
  }

  const pngPath = path.join(outDir, `${name}.png`);
  await tab.locator("#card").screenshot({ path: pngPath });
  console.log(`${name}  ${box.w}x${box.h}  ${pngPath}`);
}

await browser.close();
console.log(`\n${Object.keys(VARIANTS).length} variants rendered to ${outDir}`);
