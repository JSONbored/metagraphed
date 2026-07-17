// Dedicated Worker serving the dynamic Open Graph card (GET /og.png, alias
// /og) -- split out of workers/api.mjs (#6502) purely for Worker bundle
// budget: workers-og (satori + resvg-wasm) alone is ~545 KiB gzipped
// (resvg-wasm 517.1 KiB + yoga-wasm 27.6 KiB), and the main Worker had no
// headroom left for @sentry/cloudflare with that weight still in its own
// bundle (confirmed via `npm run worker:bundle:budget`: 999.2 KiB before
// Sentry, already within 24.8 KiB of Cloudflare's 1024 KiB hard ceiling).
// Reached only via the main Worker's OG_IMAGE_API service binding (no
// public routes of its own) -- see workers/api.mjs's handleOgImageProxy.
//
// Needs its own METAGRAPH_ARCHIVE (R2, for reading registry-summary.json's
// live stats via readArtifact) and ASSETS (./public, for the branded
// fallback card on any render failure -- see src/og-image.mjs's own
// fallbackResponse) bindings, matching what handleOgImage always needed;
// these simply move from the main Worker's config to this one's -- the
// main Worker keeps its own METAGRAPH_ARCHIVE/ASSETS bindings unchanged,
// since both are still used by many of its other, unrelated routes.
import { handleOgImage } from "../src/og-image.mjs";
import { readArtifact } from "./storage.mjs";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const response = await handleOgImage(request, env, url, {
      readArtifact,
    });
    return response ?? new Response("Not Found", { status: 404 });
  },
};
