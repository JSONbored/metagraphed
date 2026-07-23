// Renders the live Open Graph card (api.metagraph.sh's /og.png) in plain Node
// at publish time and stores it in R2 like every other artifact -- see
// src/og-image.ts's own header for why this moved out of the live Worker
// request path (#6502).
//
// workers-og itself (satori + resvg-wasm) can't load in plain Node: its wasm
// chunks are pulled in via `import wasmModule from "./foo.wasm"`, a
// Cloudflare/wrangler-bundler-specific convention that only workerd's module
// resolution understands -- confirmed empirically, plain Node's ESM loader
// throws trying to parse the .wasm binary as a JS module. So this script uses
// satori directly (pure JS, the same renderer workers-og wraps) + satori-html
// (parses the HTML-string markup renderMarkup() already produces into the
// node tree satori expects -- the same conversion workers-og's ImageResponse
// does internally) + @resvg/resvg-js (the Node-native/napi build of the same
// resvg engine workers-og's resvg-wasm wraps, no wasm-import involved) to
// rasterize the SVG satori returns into a PNG. Confirmed to render the same
// card design as the old live path.
//
// Tolerant by design, matching refresh-native-snapshot.ts/refresh-candidates.ts
// in this same productionSteps() phase: ANY failure (missing/cold
// registry-summary.json, a Google Fonts fetch failure, a satori/resvg error)
// logs a warning and exits 0 WITHOUT writing a new PNG, leaving whatever card
// is already published in R2 untouched (or, if nothing has ever published
// successfully, the live route's own R2 miss falls back to the static ASSETS
// card) -- a stale-but-valid card is always better than blocking the data
// publish over a decorative image.
//
// Runs in build.mjs productionSteps after the final build-artifacts (which
// writes registry-summary.json to the R2 staging tree) and before r2-manifest
// (which picks up this file from the same tree). Production-only, like its
// sibling live-network steps -- local/PR builds skip it.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { Resvg } from "@resvg/resvg-js";
import satori from "satori";
import { html } from "satori-html";
import { R2_STAGING_RELATIVE_ROOT } from "../src/artifact-storage.ts";
import { buildStatParts, renderMarkup } from "../src/og-image.ts";
import { repoRoot, stableStringify } from "./lib.ts";
import { initSentry, endSessionAndFlush } from "./observability.ts";
import * as Sentry from "@sentry/node";

initSentry("refresh-og-image");

const CARD_WIDTH = 1200;
const CARD_HEIGHT = 630;
const FALLBACK_STAT = "Live health, schemas, and discovery for every subnet";
const OUTPUT_PATH = path.join(
  repoRoot,
  R2_STAGING_RELATIVE_ROOT,
  "og-image.png",
);
const SUMMARY_PATH = path.join(
  repoRoot,
  R2_STAGING_RELATIVE_ROOT,
  "registry-summary.json",
);

try {
  const statParts = await loadStatParts();
  const png = await renderCard(statParts);
  await mkdir(path.dirname(OUTPUT_PATH), { recursive: true });
  await writeFile(OUTPUT_PATH, png);
  console.log(
    stableStringify({
      step: "refresh-og-image",
      status: "rendered",
      stat_line: (statParts ?? [FALLBACK_STAT]).join(" · "),
      size_bytes: png.length,
    }),
  );
} catch (error) {
  Sentry.captureException(error);
  await Sentry.flush(2000);
  console.warn(
    `::warning::og-image render failed (${summarizeError(error)}); leaving the previously published card in place.`,
  );
  console.log(
    stableStringify({
      step: "refresh-og-image",
      status: "skipped",
      error: summarizeError(error),
    }),
  );
}

await endSessionAndFlush();
process.exit(0);

async function loadStatParts() {
  try {
    const raw = await readFile(SUMMARY_PATH, "utf8");
    return buildStatParts(JSON.parse(raw));
  } catch {
    return null;
  }
}

async function renderCard(statParts) {
  const [bold, medium] = await Promise.all([
    loadGoogleFont("Space Grotesk", 700),
    loadGoogleFont("Space Grotesk", 500),
  ]);
  const svg = await satori(html(renderMarkup(statParts)), {
    width: CARD_WIDTH,
    height: CARD_HEIGHT,
    fonts: [
      { name: "Space Grotesk", data: bold, weight: 700, style: "normal" },
      { name: "Space Grotesk", data: medium, weight: 500, style: "normal" },
    ],
  });
  const resvg = new Resvg(svg, {
    fitTo: { mode: "width", value: CARD_WIDTH },
  });
  return resvg.render().asPng();
}

// No per-request latency pressure at build time (unlike the old live path),
// so this fetches the standard Latin subset rather than reproducing
// workers-og's loadGoogleFont per-glyph subsetting -- one Google Fonts CSS2
// API call per weight, immune to drift if the rendered copy changes later.
async function loadGoogleFont(family, weight) {
  const cssUrl = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(family)}:wght@${weight}`;
  const cssResponse = await fetch(cssUrl, {
    // Google Fonts serves modern woff2 only to browser-like UAs; a bare
    // Node fetch UA gets an older, less complete format back.
    headers: {
      "user-agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
    },
  });
  if (!cssResponse.ok) {
    throw new Error(`Google Fonts CSS request failed: ${cssResponse.status}`);
  }
  const css = await cssResponse.text();
  const match = css.match(
    /src: url\(([^)]+)\) format\('(?:opentype|truetype|woff2?)'\)/,
  );
  if (!match) {
    throw new Error(`no @font-face src found for ${family} ${weight}`);
  }
  const fontResponse = await fetch(match[1]);
  if (!fontResponse.ok) {
    throw new Error(`font file fetch failed: ${fontResponse.status}`);
  }
  return await fontResponse.arrayBuffer();
}

function summarizeError(error) {
  return String(error?.message || error)
    .split("\n")[0]
    ?.slice(0, 240);
}
