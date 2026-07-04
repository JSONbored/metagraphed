// Edge-rendered Open Graph image (/og). Renders a branded 1200×630 PNG card via
// workers-og (satori + resvg-wasm) so social/link unfurls have a real image. The
// title comes from ?title= (server.ts derives it from the route). Infra module
// (imported by the Worker entry), so it survives Lovable regens.
//
// workers-og is loaded lazily inside handleOgImage (see below), NOT statically:
// it pulls in a yoga `.wasm` that Node's ESM loader can't resolve, which would
// break `vite dev` SSR for every route. It only has to work on the Cloudflare
// Worker, which reaches the dynamic import only on an actual /og request.
type WorkersOg = typeof import("workers-og");

const OG_PATH = "/og";
const SUBTITLE = "The Bittensor subnet integration registry";
const DEFAULT_TITLE = "Metagraphed";
const MAX_TITLE_LENGTH = 110;
const MAX_QUERY_LENGTH = 512;
const CACHE_CONTROL = "public, max-age=86400, stale-while-revalidate=604800";

// A tiny valid PNG returned when rendering dependencies fail. This keeps the
// public endpoint cheap and predictable instead of retrying expensive work.
const FALLBACK_PNG = new Uint8Array([
  137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0,
  0, 31, 21, 196, 137, 0, 0, 0, 13, 73, 68, 65, 84, 120, 156, 99, 248, 255, 255, 255, 127, 0, 9,
  251, 3, 253, 5, 67, 69, 202, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130,
]);

type EdgeCache = {
  match(request: Request): Promise<Response | undefined>;
  put(request: Request, response: Response): Promise<void>;
};

const cacheStorage = (globalThis as { caches?: { default?: EdgeCache } }).caches?.default ?? null;

// Escape text for safe embedding in the HTML string satori parses.
function escapeText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function normalizeTitle(value: string | null): string {
  const trimmed = (value || DEFAULT_TITLE).trim() || DEFAULT_TITLE;
  return trimmed.length > MAX_TITLE_LENGTH ? `${trimmed.slice(0, MAX_TITLE_LENGTH - 1)}…` : trimmed;
}

function makeCacheKey(url: URL, title: string): Request {
  const cacheUrl = new URL(url);
  cacheUrl.search = "";
  cacheUrl.searchParams.set("title", title);
  return new Request(cacheUrl.toString(), { method: "GET" });
}

function withOgHeaders(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("cache-control", CACHE_CONTROL);
  headers.set("content-type", "image/png");
  return new Response(response.body, { status: response.status, headers });
}

function fallbackImageResponse(status = 200): Response {
  return new Response(FALLBACK_PNG, {
    status,
    headers: {
      "cache-control": CACHE_CONTROL,
      "content-type": "image/png",
    },
  });
}

// Render the /og card, or return null when the path doesn't match.
export async function handleOgImage(request: Request): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== OG_PATH) return null;
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method Not Allowed", { status: 405, headers: { allow: "GET, HEAD" } });
  }
  if (url.search.length > MAX_QUERY_LENGTH) {
    return new Response("Query Too Large", { status: 414 });
  }

  const normalizedTitle = normalizeTitle(url.searchParams.get("title"));
  const cacheKey = makeCacheKey(url, normalizedTitle);
  const cached = await cacheStorage?.match(cacheKey);
  if (cached) {
    const response = withOgHeaders(cached);
    return request.method === "HEAD" ? new Response(null, response) : response;
  }

  if (request.method === "HEAD") {
    return new Response(null, {
      headers: {
        "cache-control": CACHE_CONTROL,
        "content-type": "image/png",
      },
    });
  }

  // Lazily pull in workers-og (satori + yoga wasm) only now that we're actually
  // rendering — keeps the wasm out of the SSR module graph so `vite dev` works.
  // Failure here returns the fallback PNG rather than throwing, since this runs
  // outside server.ts's try/catch.
  let ImageResponse: WorkersOg["ImageResponse"];
  let loadGoogleFont: WorkersOg["loadGoogleFont"];
  try {
    ({ ImageResponse, loadGoogleFont } = await import("workers-og"));
  } catch (error) {
    console.error("Failed to load workers-og", error);
    return fallbackImageResponse();
  }

  const title = escapeText(normalizedTitle);
  // Subset each weight to only the bounded glyphs we render (smaller + faster fetch).
  const glyphs = `${normalizedTitle}${SUBTITLE}metagraph.sh`;
  let bold: ArrayBuffer;
  let regular: ArrayBuffer;
  try {
    [bold, regular] = await Promise.all([
      loadGoogleFont({ family: "Inter", weight: 700, text: glyphs }),
      loadGoogleFont({ family: "Inter", weight: 400, text: glyphs }),
    ]);
  } catch (error) {
    console.error("Failed to load OG image fonts", error);
    return fallbackImageResponse();
  }

  const markup = `
    <div style="display:flex;flex-direction:column;justify-content:space-between;width:100%;height:100%;padding:80px;background:#0a0a0a;color:#fafafa;font-family:Inter;">
      <div style="display:flex;align-items:center;font-size:30px;font-weight:400;color:#a1a1aa;letter-spacing:1px;">metagraph.sh</div>
      <div style="display:flex;font-size:76px;font-weight:700;line-height:1.05;max-width:1040px;">${title}</div>
      <div style="display:flex;font-size:34px;font-weight:400;color:#a1a1aa;">${SUBTITLE}</div>
    </div>`;

  try {
    const image = new ImageResponse(markup, {
      width: 1200,
      height: 630,
      fonts: [
        { name: "Inter", data: bold, weight: 700, style: "normal" },
        { name: "Inter", data: regular, weight: 400, style: "normal" },
      ],
    });
    const response = withOgHeaders(image);
    await cacheStorage?.put(cacheKey, response.clone());
    return response;
  } catch (error) {
    console.error("Failed to render OG image", error);
    return fallbackImageResponse();
  }
}
