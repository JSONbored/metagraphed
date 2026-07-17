// Open Graph card for the api.metagraph.sh landing page (GET /og.png, alias
// /og), with LIVE registry stats baked in so link unfurls show a real,
// data-driven card instead of a frozen hand-made banner.
//
// The render itself (satori + resvg, via workers-og's dependencies) does NOT
// happen here or in any live Worker request path — see #6502. workers-og's
// wasm (satori + resvg-wasm, ~545 KiB gzipped) was originally dynamic-imported
// inside this route's handler, but Cloudflare's bundler ships every reachable
// import (static or dynamic) in the one deployed script, so it was still
// costing this Worker's own bundle budget on every deploy, and eventually
// left no headroom for @sentry/cloudflare. Since the underlying stats only
// change once per data publish anyway (this route was re-rendering an
// unchanged image on every cache miss), the render moved to publish time:
// scripts/refresh-og-image.mjs runs in plain Node, using the SAME renderMarkup
// below plus satori + satori-html + @resvg/resvg-js (Node-native bindings,
// not wasm-import — workers-og itself can't load outside workerd, see that
// script's own header), and stores the PNG in R2 like every other artifact.
//
// handleOgImage below is now just a binary R2 read + the existing edge cache;
// on any miss/error (cold R2, timeout) it falls back to the branded full-size
// static card on a short cache, so an unfurl always shows something on brand
// and a transient failure isn't pinned for the hour. readR2Object/cache/assets
// are injectable for unit tests.

// Brand palette (brand kit BRAND.md): Mint accent on an Ink surface; Ink-text
// reads AAA on mint. The landing page currently ships the static mint OG banner,
// so this dynamic card keeps the same mint-on-ink identity.
const MINT = "#30FFC0";
const INK = "#0B1F1A";
const INK_TEXT = "#08110E";

const OG_PATHS = new Set(["/og.png", "/og"]);
// Stats refresh on the data publish; an hour of edge cache + a long
// stale-while-revalidate keeps render cost near-zero without serving stale art.
const CACHE_CONTROL = "public, max-age=3600, stale-while-revalidate=86400";
// Render failures are transient, so the fallback gets a short cache (not the
// long success window, no stale-while-revalidate) and is never pinned for long.
const FALLBACK_CACHE_CONTROL = "public, max-age=60";
// Branded 1200x630 card under public/ (ASSETS binding), shown when a render
// fails. Regenerate from banner-og-social-mint.png on brand changes.
const FALLBACK_ASSET_PATH = "/brand/og-fallback.png";
// Bump on any visual change to the card. It's part of the edge-cache key, so a
// new version renders fresh on the next deploy instead of serving the previous
// design from cache for up to an hour.
const CARD_VERSION = "2";
// The R2 artifact scripts/refresh-og-image.mjs publishes the rendered card to,
// read tier-aware (latest-prefix + timeout guard) via readR2Object -- same
// convention as every other /metagraph/* artifact.
export const OG_IMAGE_ARTIFACT_PATH = "/metagraph/og-image.png";
const WORDMARK = "Metagraphed";
const TAGLINE = "The Bittensor subnet integration registry";
// Shown in the stat row only when registry-summary is cold (rare, transient).
// ASCII-only on purpose — see the glyph note in handleOgImage.
const FALLBACK_STAT = "Live health, schemas, and discovery for every subnet";

// The brand "M" mark (continuous zig-zag, brand kit icon) recolored to Ink, as a
// transparent-background SVG data URI so it floats on the mint card. Injected via
// <img> rather than inline <svg> for reliable satori rasterization. The wordmark
// beside it is live text in Space Grotesk Bold, so the lockup matches the brand
// banner exactly without embedding the wordmark paths.
const LOGO_DATA_URI =
  "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI1MTIiIGhlaWdodD0iNTEyIiB2aWV3Qm94PSIwIDAgNTEyIDUxMiIgZmlsbD0ibm9uZSI+CjxwYXRoIHRyYW5zZm9ybT0idHJhbnNsYXRlKDgxLjkyMCwxNTEuNzM4KSBzY2FsZSgwLjQ2NTQ1KSIgZD0iTSAzMTUuNSwxLjE5OTk5OTk5OTk5OTk4ODYgQyAzMTMuNDAwMDAwMDAwMDAwMDMsMS42OTk5OTk5OTk5OTk5ODg2IDI4MS43LDMyLjc5OTk5OTk5OTk5OTk1NSAyMDYuNSwxMDcuODk5OTk5OTk5OTk5OTggQyAxNDYuNSwxNjcuODk5OTk5OTk5OTk5OTggOTkuMzAwMDAwMDAwMDAwMDEsMjE0LjM5OTk5OTk5OTk5OTk4IDk3LjcsMjE1LjAgQyA5NS45LDIxNS42IDc5LjQsMjE2LjAgNTIuMzAwMDAwMDAwMDAwMDA0LDIxNi4wIEMgMTEuNCwyMTYuMCA5LjYwMDAwMDAwMDAwMDAwMSwyMTYuMSA2LjUsMjE4LjAgQyAtMC40LDIyMi4yOTk5OTk5OTk5OTk5OCAwLjAsMjE1Ljc5OTk5OTk5OTk5OTk4IDAuMCwzMjguNyBDIDAuMCw0MjguNSAwLjAsNDMwLjYgMi4wLDQzMy44IEMgNi4wLDQ0MC4zIDEyLjksNDQyLjUgMTkuNSw0MzkuNCBDIDIxLjMsNDM4LjYgNzAuOSwzODkuNCAxMzAuNiwzMjkuMyBDIDIyMy45LDIzNS41IDIzOS4yMDAwMDAwMDAwMDAwMiwyMjAuMzk5OTk5OTk5OTk5OTggMjQzLjgsMjE4LjM5OTk5OTk5OTk5OTk4IEMgMjQ5LjAsMjE2LjAgMjQ5LjUsMjE2LjAgMjgxLjgsMjE2LjAgQyAzMTIuNDAwMDAwMDAwMDAwMDMsMjE2LjAgMzE0LjcwMDAwMDAwMDAwMDA1LDIxNi4xIDMxNy43MDAwMDAwMDAwMDAwNSwyMTguMCBDIDMxOS40MDAwMDAwMDAwMDAwMywyMTkuMCAzMjEuNSwyMjAuODk5OTk5OTk5OTk5OTggMzIyLjIwMDAwMDAwMDAwMDA1LDIyMi4yIEMgMzIzLjIwMDAwMDAwMDAwMDA1LDIyNC4wIDMyMy42LDI0NS4xIDMyNC4wLDMyOC4wIEwgMzI0LjUsNDMxLjUgTCAzMjYuOCw0MzQuOCBDIDMzMS4wLDQ0MC42IDMzOC4xLDQ0Mi42IDM0My44LDQzOS42IEMgMzQ1LjMsNDM4LjggMzk1LjgsMzg4LjggNDU2LjAsMzI4LjUgQyA1MTYuMiwyNjguMiA1NjYuNywyMTguMiA1NjguMiwyMTcuMzk5OTk5OTk5OTk5OTggQyA1NzAuNCwyMTYuMjk5OTk5OTk5OTk5OTggNTc3LjMwMDAwMDAwMDAwMDEsMjE2LjAgNjA1LjIsMjE2LjAgQyA2MzcuNDAwMDAwMDAwMDAwMSwyMTYuMCA2MzkuNywyMTYuMSA2NDIuNywyMTguMCBDIDY0NC40MDAwMDAwMDAwMDAxLDIxOS4wIDY0Ni41LDIyMC44OTk5OTk5OTk5OTk5OCA2NDcuMiwyMjIuMiBDIDY0OC4yLDIyNC4wIDY0OC42LDI0NS43IDY0OS4wLDMzMS43IEMgNjQ5LjUsNDM4LjEgNjQ5LjUsNDM4LjkgNjUxLjYsNDQxLjcgQyA2NTQuODAwMDAwMDAwMDAwMSw0NDYuMSA2NTkuNyw0NDguMiA2NjUuMCw0NDcuNSBDIDY2OS40MDAwMDAwMDAwMDAxLDQ0Ny4wIDY3MC42LDQ0NS45IDcwNy4zMDAwMDAwMDAwMDAxLDQwOS4yIEMgNzI4LjEsMzg4LjUgNzQ1LjgwMDAwMDAwMDAwMDEsMzcwLjMgNzQ2LjYsMzY4LjggQyA3NDcuODAwMDAwMDAwMDAwMSwzNjYuNSA3NDguMCwzNTQuOSA3NDguMCwyOTUuNzk5OTk5OTk5OTk5OTUgQyA3NDguMCwyMjguMCA3NDcuOTAwMDAwMDAwMDAwMSwyMjUuMzk5OTk5OTk5OTk5OTggNzQ2LjAsMjIyLjI5OTk5OTk5OTk5OTk4IEMgNzQyLjUsMjE2LjUgNzQyLjYsMjE2LjUgNzAzLjMwMDAwMDAwMDAwMDEsMjE2LjAgQyA2NjguNywyMTUuNSA2NjcuMCwyMTUuMzk5OTk5OTk5OTk5OTggNjY0LjMwMDAwMDAwMDAwMDEsMjEzLjM5OTk5OTk5OTk5OTk4IEMgNjYyLjgwMDAwMDAwMDAwMDEsMjEyLjI5OTk5OTk5OTk5OTk4IDY2MC43LDIwOS43OTk5OTk5OTk5OTk5OCA2NTkuODAwMDAwMDAwMDAwMSwyMDcuODk5OTk5OTk5OTk5OTggQyA2NTguMSwyMDQuNyA2NTguMCwxOTcuODk5OTk5OTk5OTk5OTggNjU4LjAsMTA3Ljc5OTk5OTk5OTk5OTk1IEMgNjU4LjAsLTAuNzAwMDAwMDAwMDAwMDQ1NSA2NTguNDAwMDAwMDAwMDAwMSw1Ljc5OTk5OTk5OTk5OTk1NDUgNjUwLjgwMDAwMDAwMDAwMDEsMS44OTk5OTk5OTk5OTk5NzczIEMgNjQ2LjYsLTAuMjAwMDAwMDAwMDAwMDQ1NDcgNjQzLjQwMDAwMDAwMDAwMDEsLTAuNSA2MzkuMzAwMDAwMDAwMDAwMSwxLjA5OTk5OTk5OTk5OTk2NiBDIDYzNy43LDEuNjk5OTk5OTk5OTk5OTg4NiA1OTAuMiw0OC41OTk5OTk5OTk5OTk5NjYgNTI5LjksMTA5LjA5OTk5OTk5OTk5OTk3IEwgNDIzLjMsMjE2LjEgTCAzODIuNzAwMDAwMDAwMDAwMDUsMjE1Ljc5OTk5OTk5OTk5OTk4IEMgMzQzLjUsMjE1LjUgMzQyLjEsMjE1LjM5OTk5OTk5OTk5OTk4IDMzOS4zLDIxMy4zOTk5OTk5OTk5OTk5OCBDIDMzNy44LDIxMi4yOTk5OTk5OTk5OTk5OCAzMzUuNzAwMDAwMDAwMDAwMDUsMjA5Ljc5OTk5OTk5OTk5OTk4IDMzNC44LDIwNy44OTk5OTk5OTk5OTk5OCBDIDMzMy4xLDIwNC43IDMzMy4wLDE5Ny44OTk5OTk5OTk5OTk5OCAzMzMuMCwxMDcuNjk5OTk5OTk5OTk5OTkgQyAzMzMuMCw0LjA5OTk5OTk5OTk5OTk2NiAzMzMuMjAwMDAwMDAwMDAwMDUsOC4xOTk5OTk5OTk5OTk5ODkgMzI4LjEsMy41OTk5OTk5OTk5OTk5NjYgQyAzMjUuNiwxLjI5OTk5OTk5OTk5OTk1NDUgMzE5LjUsMC4wOTk5OTk5OTk5OTk5NjU5IDMxNS41LDEuMTk5OTk5OTk5OTk5OTg4NiIgZmlsbD0iIzA4MTEwRSIvPgo8L3N2Zz4K";

function imageHeaders(extra, cacheControl = CACHE_CONTROL) {
  const headers = new Headers(extra);
  headers.set("cache-control", cacheControl);
  headers.set("content-type", "image/png");
  return headers;
}

// Serve the branded card from ASSETS (a separate subsystem, so it survives
// workers-og/font/satori failures) at 200 with a short cache; the caller never
// edge-caches it. If the asset is gone too, 503 no-store so crawlers fall back
// to the page meta tags instead of caching a blank.
async function fallbackResponse(assets, url) {
  if (assets?.fetch) {
    try {
      const asset = await assets.fetch(
        new Request(new URL(FALLBACK_ASSET_PATH, url).toString()),
      );
      if (asset.ok) {
        return new Response(asset.body, {
          headers: imageHeaders(undefined, FALLBACK_CACHE_CONTROL),
        });
      }
      await asset.body?.cancel?.();
    } catch (error) {
      console.error("og: fallback asset unavailable", error);
    }
  }
  return new Response("og image temporarily unavailable\n", {
    status: 503,
    headers: {
      "cache-control": "no-store",
      "content-type": "text/plain; charset=utf-8",
    },
  });
}

function formatCount(value) {
  return typeof value === "number" && Number.isFinite(value)
    ? value.toLocaleString("en-US")
    : null;
}

// Pull the live counts off registry-summary.json's data into an array of stat
// strings, or null when there are no formattable counts (the caller then shows
// a generic fallback line). Pure -- scripts/refresh-og-image.mjs is the only
// caller now (it reads registry-summary.json off disk at publish time); the
// live route no longer computes stats at all, it just serves the pre-rendered
// card.
export function buildStatParts(data) {
  if (!data) return null;
  const parts = [];
  const subnets = formatCount(data.subnet_count);
  if (subnets) parts.push(`${subnets} subnets`);
  const endpoints = formatCount(data.counts?.endpoints);
  if (endpoints) parts.push(`${endpoints} endpoints`);
  const providers = formatCount(data.counts?.providers);
  if (providers) parts.push(`${providers} providers`);
  const coverage = data.coverage?.average_score;
  if (typeof coverage === "number" && Number.isFinite(coverage)) {
    parts.push(`${coverage}% coverage`);
  }
  return parts.length ? parts : null;
}

// Build the stat row: each stat in its own leaf div, joined by a small ink dot
// (a div, not a glyph — the "·" character doesn't survive loadGoogleFont
// subsetting and renders as tofu). When stats are cold, show the ASCII fallback.
function renderStatRow(statParts) {
  const items = statParts && statParts.length ? statParts : [FALLBACK_STAT];
  const dot = `<div style="display:flex;width:8px;height:8px;border-radius:4px;background:${INK};opacity:0.55;margin:0 20px;"></div>`;
  return items
    .map((part) => `<div style="display:flex;">${part}</div>`)
    .join(dot);
}

// Centered lockup (brand "M" mark + "Metagraphed" wordmark) over a divider rule
// over the live stat row — matching the brand banner's hierarchy with generous
// breathing room. Exported so the local preview harness renders the exact card.
// satori is strict: any element with >1 child needs display:flex; text lives in
// leaf divs.
export function renderMarkup(statParts) {
  return `
    <div style="position:relative;display:flex;flex-direction:column;align-items:center;justify-content:center;width:100%;height:100%;background:${MINT};color:${INK_TEXT};font-family:'Space Grotesk';overflow:hidden;">
      <div style="position:absolute;top:-250px;right:-210px;width:740px;height:740px;background:#5BFFD2;opacity:0.5;transform:rotate(34deg);display:flex;"></div>
      <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;width:100%;height:100%;padding:0 90px;">
        <div style="display:flex;align-items:center;">
          <img src="${LOGO_DATA_URI}" style="width:168px;height:168px;" />
          <div style="display:flex;font-size:120px;font-weight:700;letter-spacing:-3px;">${WORDMARK}</div>
        </div>
        <div style="display:flex;width:780px;height:3px;background:${INK};opacity:0.82;margin:34px 0 30px 0;"></div>
        <div style="display:flex;font-size:33px;font-weight:500;color:${INK};opacity:0.72;margin-bottom:28px;">${TAGLINE}</div>
        <div style="display:flex;align-items:center;font-size:32px;font-weight:500;">${renderStatRow(statParts)}</div>
      </div>
    </div>`;
}

// Returns a Response for the OG route, or null when the path doesn't match (so
// the caller can fall through). deps: { readR2Object, cache, assets } —
// readR2Object defaults to none (a missing/non-function dep degrades to the
// fallback, same as a cold R2 read); cache to the edge cache; assets to
// env.ASSETS (the binding that serves the branded fallback card on a miss).
export async function handleOgImage(request, env, url, deps = {}) {
  if (!OG_PATHS.has(url.pathname)) return null;
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method Not Allowed", {
      status: 405,
      headers: { allow: "GET, HEAD" },
    });
  }

  // Cache on a canonical /og.png key so /og and /og.png share one cached render.
  const cache =
    deps.cache !== undefined
      ? deps.cache
      : (globalThis.caches?.default ?? null);
  const assets =
    deps.assets !== undefined ? deps.assets : (env?.ASSETS ?? null);
  const cacheKey = new Request(
    new URL(`/og.png?v=${CARD_VERSION}`, url).toString(),
    { method: "GET" },
  );
  const cached = await cache?.match(cacheKey);
  if (cached) {
    return request.method === "HEAD" ? new Response(null, cached) : cached;
  }

  if (request.method === "HEAD") {
    return new Response(null, { headers: imageHeaders() });
  }

  const readR2Object = deps.readR2Object;
  let result;
  try {
    result =
      typeof readR2Object === "function"
        ? await readR2Object(env, OG_IMAGE_ARTIFACT_PATH, "r2")
        : { ok: false };
  } catch (error) {
    console.error("og: r2 read failed", error);
    result = { ok: false };
  }
  if (!result?.ok) {
    return fallbackResponse(assets, url);
  }

  const response = new Response(result.object.body, {
    headers: imageHeaders(),
  });
  if (cache) await cache.put(cacheKey, response.clone());
  return response;
}
