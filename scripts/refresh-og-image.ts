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
// Runs in build.ts productionSteps after the final build-artifacts (which
// writes registry-summary.json to the R2 staging tree) and before r2-manifest
// (which picks up this file from the same tree). Production-only, like its
// sibling live-network steps -- local/PR builds skip it.
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { Resvg } from "@resvg/resvg-js";
import type { ReactNode } from "react";
import satori from "satori";
import { html } from "satori-html";
import { R2_STAGING_RELATIVE_ROOT } from "../src/artifact-storage.ts";
import { buildStatParts, renderMarkup } from "../src/og-image.ts";
import { CARD_VERSION, CARD_WIDTH, CARD_HEIGHT } from "../src/og-card-style.ts";
import { loadCardFonts } from "../src/og-card-fonts.ts";
import { OG_IMAGE_FILE_NAMES } from "../src/og-card-version.ts";
import { repoRoot, stableStringify } from "./lib.ts";
import {
  initObservability,
  endSessionAndFlush,
  captureExceptionAndContinue,
} from "./observability.ts";

initObservability("refresh-og-image");

const OUTPUT_PATHS = OG_IMAGE_FILE_NAMES.map((name) =>
  path.join(repoRoot, R2_STAGING_RELATIVE_ROOT, name),
);
const SUMMARY_PATH = path.join(
  repoRoot,
  R2_STAGING_RELATIVE_ROOT,
  "registry-summary.json",
);

try {
  const statParts = await loadStatParts();
  const png = await renderCard(statParts);
  await mkdir(path.dirname(OUTPUT_PATHS[0]), { recursive: true });
  // Old Workers still read the legacy file. Update it first, then the current
  // version. A partial attempt cannot claim current-version completion.
  for (const outputPath of OUTPUT_PATHS) {
    const pendingPath = outputPath + ".pending";
    await writeFile(pendingPath, png);
    await rename(pendingPath, outputPath);
  }
  console.log(
    stableStringify({
      step: "refresh-og-image",
      status: "rendered",
      renderer_version: CARD_VERSION,
      artifact_paths: OG_IMAGE_FILE_NAMES.map((name) => `/metagraph/${name}`),
      sha256: createHash("sha256").update(png).digest("hex"),
      stat_line: (statParts ?? []).join(" · "),
      size_bytes: png.length,
    }),
  );
} catch (error) {
  await captureExceptionAndContinue(error);
  console.warn(
    `::warning::og-image refresh incomplete (${summarizeError(error)}); current-version publication was not confirmed.`,
  );
  console.log(
    stableStringify({
      step: "refresh-og-image",
      status: "skipped",
      renderer_version: CARD_VERSION,
      error: summarizeError(error),
    }),
  );
}

await endSessionAndFlush();
process.exit(0);

async function loadStatParts(): Promise<string[] | null> {
  try {
    const raw = await readFile(SUMMARY_PATH, "utf8");
    return buildStatParts(JSON.parse(raw));
  } catch {
    return null;
  }
}

async function renderCard(statParts: string[] | null): Promise<Buffer> {
  const markup = renderMarkup(statParts);
  const fonts = await loadCardFonts(markup);
  // satori-html returns satori's own `VNode`; satori's published signature
  // says `ReactNode` because React is its reference renderer. Both describe
  // the same runtime object -- satori walks `{ type, props }` and never
  // touches a React internal -- but neither package declares the other, so the
  // relationship is stated once, here. `as ReactNode` and not `as never`: the
  // latter accepts every value there is, including the `undefined` that a
  // renderMarkup returning nothing would hand over.
  const svg = await satori(html(markup) as ReactNode, {
    width: CARD_WIDTH,
    height: CARD_HEIGHT,
    fonts,
  });
  const resvg = new Resvg(svg, {
    fitTo: { mode: "width", value: CARD_WIDTH },
  });
  return Buffer.from(resvg.render().asPng());
}

function summarizeError(error: unknown): string | undefined {
  return String((error as { message?: unknown })?.message || error)
    .split("\n")[0]
    ?.slice(0, 240);
}
