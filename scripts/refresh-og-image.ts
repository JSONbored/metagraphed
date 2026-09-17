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
// logs a warning and exits 0. The final publication guard restores the active
// approved PNGs and their provenance when the render receipt is incomplete (or, if nothing has ever published
// successfully, the live route's own R2 miss falls back to the static ASSETS
// card) -- a stale-but-valid card is always better than blocking the data
// publish over a decorative image.
//
// Runs in build.ts productionSteps after the final build-artifacts (which
// writes registry-summary.json to the R2 staging tree) and before r2-manifest
// (which picks up this file from the same tree). Production-only, like its
// sibling live-network steps -- local/PR builds skip it.
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { R2_STAGING_RELATIVE_ROOT } from "../src/artifact-storage.ts";
import { CARD_VERSION, OG_IMAGE_FILE_NAMES } from "../src/og-card-version.ts";
import { renderImageRelease } from "./og-image-render.ts";
import { repoRoot, stableStringify } from "./lib.ts";
import {
  initObservability,
  endSessionAndFlush,
  captureExceptionAndContinue,
} from "./observability.ts";

initObservability("refresh-og-image");
const root = path.join(repoRoot, R2_STAGING_RELATIVE_ROOT);
const receiptPath = path.join(root, "og-image-render.json");
await mkdir(root, { recursive: true });
// Invalidate a previous successful receipt before beginning a tolerant attempt.
await writeFile(
  receiptPath,
  stableStringify({ status: "skipped", renderer_version: CARD_VERSION }),
);
try {
  const source = await readFile(path.join(root, "registry-summary.json"));
  const revision = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repoRoot,
    encoding: "utf8",
  }).trim();
  const { receipt, pngs } = await renderImageRelease(source, revision);
  for (const name of OG_IMAGE_FILE_NAMES) {
    const output = path.join(root, name);
    await writeFile(output + ".pending", pngs[`/metagraph/${name}`]);
    await rename(output + ".pending", output);
  }
  // A complete receipt is written last; stale or partially renamed PNGs cannot
  // be treated as a successful replacement by the final publication guard.
  await writeFile(receiptPath + ".pending", stableStringify(receipt) + "\n");
  await rename(receiptPath + ".pending", receiptPath);
  console.log(stableStringify({ step: "refresh-og-image", ...receipt }));
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

function summarizeError(error: unknown): string {
  return String((error as { message?: unknown })?.message || error)
    .split("\n")[0]
    .slice(0, 240);
}
