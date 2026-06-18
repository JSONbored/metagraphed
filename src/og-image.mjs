// Edge-rendered Open Graph card for the api.metagraph.sh landing page
// (GET /og.png, alias /og). Renders a branded 1200x630 PNG via workers-og
// (satori + resvg-wasm) with LIVE registry stats, so link unfurls show a real,
// data-driven card instead of a frozen hand-made banner. Mirrors the
// metagraphed-ui /og pattern (loadGoogleFont, no bundled font file).
//
// workers-og is DYNAMIC-imported inside the handler so its wasm only evaluates
// when this low-traffic route is actually hit — the agent/API hot path (every
// other request) never pays the parse/instantiate cost. The whole render is
// fail-soft: any failure (artifact miss, font fetch, wasm, satori) returns a
// tiny valid PNG instead of a 500, keeping the public endpoint cheap and the
// crawler happy. workers-og + fonts + caches are injectable for unit tests.

// Brand palette (brand kit BRAND.md): Mint accent on an Ink surface; Ink-text
// reads AAA on mint. The landing page currently ships the static mint OG banner,
// so this dynamic card keeps the same mint-on-ink identity.
const MINT = "#30FFC0";
const INK = "#0B1F1A";
const INK_TEXT = "#08110E";

const OG_PATHS = new Set(["/og.png", "/og"]);
// Stats refresh on the 6h publish; an hour of edge cache + a long
// stale-while-revalidate keeps render cost near-zero without serving stale art.
const CACHE_CONTROL = "public, max-age=3600, stale-while-revalidate=86400";
const SUBTITLE = "The Bittensor subnet integration registry";
const HEADLINE = "Every subnet, metagraphed.";
const EYEBROW = "api.metagraph.sh";

// A tiny valid 1x1 PNG returned when any render dependency fails.
const FALLBACK_PNG = new Uint8Array([
  137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0,
  0, 0, 1, 8, 6, 0, 0, 0, 31, 21, 196, 137, 0, 0, 0, 13, 73, 68, 65, 84, 120,
  156, 99, 248, 255, 255, 255, 127, 0, 9, 251, 3, 253, 5, 67, 69, 202, 0, 0, 0,
  0, 73, 69, 78, 68, 174, 66, 96, 130,
]);

function fallbackResponse(status = 200) {
  return new Response(FALLBACK_PNG, {
    status,
    headers: { "cache-control": CACHE_CONTROL, "content-type": "image/png" },
  });
}

function imageHeaders(extra) {
  const headers = new Headers(extra);
  headers.set("cache-control", CACHE_CONTROL);
  headers.set("content-type", "image/png");
  return headers;
}

function formatCount(value) {
  return typeof value === "number" && Number.isFinite(value)
    ? value.toLocaleString("en-US")
    : null;
}

// Pull the live counts off registry-summary.json. Returns a human stat line, or
// the subtitle as a graceful fallback when the artifact is cold/unavailable.
async function loadStatLine(env, readArtifact) {
  try {
    if (typeof readArtifact !== "function") return null;
    const result = await readArtifact(env, "/metagraph/registry-summary.json");
    if (!result?.ok || !result.data) return null;
    const data = result.data;
    const parts = [];
    const subnets = formatCount(data.subnet_count);
    if (subnets) parts.push(`${subnets} subnets`);
    const endpoints = formatCount(data.counts?.endpoints);
    if (endpoints) parts.push(`${endpoints} endpoints`);
    const providers = formatCount(data.counts?.providers);
    if (providers) parts.push(`${providers} providers`);
    const coverage = data.coverage?.average_score;
    if (typeof coverage === "number" && Number.isFinite(coverage)) {
      parts.push(`${coverage}% avg coverage`);
    }
    return parts.length ? parts.join("  ·  ") : null;
  } catch {
    return null;
  }
}

function renderMarkup(statLine) {
  // satori is strict: any element with >1 child needs display:flex + a direction;
  // text lives in leaf divs. An ink tile with a mint "M" mirrors the brand's
  // icon-mint-on-ink lockup without risking inline-SVG rendering quirks.
  return `
    <div style="display:flex;flex-direction:column;justify-content:space-between;width:100%;height:100%;padding:72px 80px;background:${MINT};color:${INK_TEXT};font-family:'Space Grotesk';">
      <div style="display:flex;align-items:center;">
        <div style="display:flex;align-items:center;justify-content:center;width:64px;height:64px;background:${INK};border-radius:14px;">
          <div style="display:flex;font-size:40px;font-weight:700;color:${MINT};">M</div>
        </div>
        <div style="display:flex;margin-left:22px;font-size:31px;font-weight:500;letter-spacing:1px;">${EYEBROW}</div>
      </div>
      <div style="display:flex;flex-direction:column;">
        <div style="display:flex;font-size:88px;font-weight:700;line-height:1.0;max-width:1000px;">${HEADLINE}</div>
        <div style="display:flex;margin-top:20px;font-size:35px;font-weight:500;color:${INK};opacity:0.78;">${SUBTITLE}</div>
      </div>
      <div style="display:flex;flex-direction:column;">
        <div style="display:flex;width:100%;height:3px;background:${INK};opacity:0.22;margin-bottom:26px;"></div>
        <div style="display:flex;font-size:31px;font-weight:500;">${statLine}</div>
      </div>
    </div>`;
}

// Returns a Response for the OG route, or null when the path doesn't match (so
// the caller can fall through). deps: { readArtifact, og, cache } — og defaults
// to a dynamic import of workers-og; cache to the edge cache.
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
  const cacheKey = new Request(new URL("/og.png", url).toString(), {
    method: "GET",
  });
  const cached = await cache?.match(cacheKey);
  if (cached) {
    return request.method === "HEAD" ? new Response(null, cached) : cached;
  }

  if (request.method === "HEAD") {
    return new Response(null, { headers: imageHeaders() });
  }

  const statLine = (await loadStatLine(env, deps.readArtifact)) ?? SUBTITLE;

  let ImageResponse;
  let loadGoogleFont;
  try {
    ({ ImageResponse, loadGoogleFont } =
      deps.og || (await import("workers-og")));
  } catch (error) {
    console.error("og: workers-og unavailable", error);
    return fallbackResponse();
  }

  // Subset both weights to only the glyphs we render (faster, smaller fetch).
  // Includes digits/comma/percent/middot so any live stat-line variant resolves.
  const glyphs = `${EYEBROW}${HEADLINE}${SUBTITLE}${statLine}M0123456789,.%· `;
  let bold;
  let medium;
  try {
    [bold, medium] = await Promise.all([
      loadGoogleFont({ family: "Space Grotesk", weight: 700, text: glyphs }),
      loadGoogleFont({ family: "Space Grotesk", weight: 500, text: glyphs }),
    ]);
  } catch (error) {
    console.error("og: font load failed", error);
    return fallbackResponse();
  }

  try {
    const image = new ImageResponse(renderMarkup(statLine), {
      width: 1200,
      height: 630,
      fonts: [
        { name: "Space Grotesk", data: bold, weight: 700, style: "normal" },
        { name: "Space Grotesk", data: medium, weight: 500, style: "normal" },
      ],
    });
    const response = new Response(image.body, {
      status: image.status,
      headers: imageHeaders(image.headers),
    });
    if (cache) await cache.put(cacheKey, response.clone());
    return response;
  } catch (error) {
    console.error("og: render failed", error);
    return fallbackResponse();
  }
}
