// Edge-rendered Open Graph image (/og). Renders a branded 1200×630 PNG card via
// workers-og (satori + resvg-wasm) so social/link unfurls have a real image. The
// title comes from ?title= (server.ts derives it from the route). Infra module
// (imported by the Worker entry), so it survives Lovable regens.
import { ImageResponse, loadGoogleFont } from "workers-og";

const OG_PATH = "/og";
const SUBTITLE = "The Bittensor subnet integration registry";

// Escape text for safe embedding in the HTML string satori parses.
function escapeText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Render the /og card, or return null when the path doesn't match.
export async function handleOgImage(request: Request): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== OG_PATH) return null;
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method Not Allowed", { status: 405, headers: { allow: "GET, HEAD" } });
  }

  const rawTitle = (url.searchParams.get("title") || "Metagraphed").trim();
  const title = escapeText(rawTitle.length > 110 ? `${rawTitle.slice(0, 109)}…` : rawTitle);
  // Subset each weight to only the glyphs we render (smaller + faster fetch).
  const glyphs = `${rawTitle}${SUBTITLE}metagraph.sh`;
  const [bold, regular] = await Promise.all([
    loadGoogleFont({ family: "Inter", weight: 700, text: glyphs }),
    loadGoogleFont({ family: "Inter", weight: 400, text: glyphs }),
  ]);

  const markup = `
    <div style="display:flex;flex-direction:column;justify-content:space-between;width:100%;height:100%;padding:80px;background:#0a0a0a;color:#fafafa;font-family:Inter;">
      <div style="display:flex;align-items:center;font-size:30px;font-weight:400;color:#a1a1aa;letter-spacing:1px;">metagraph.sh</div>
      <div style="display:flex;font-size:76px;font-weight:700;line-height:1.05;max-width:1040px;">${title}</div>
      <div style="display:flex;font-size:34px;font-weight:400;color:#a1a1aa;">${SUBTITLE}</div>
    </div>`;

  const image = new ImageResponse(markup, {
    width: 1200,
    height: 630,
    fonts: [
      { name: "Inter", data: bold, weight: 700, style: "normal" },
      { name: "Inter", data: regular, weight: 400, style: "normal" },
    ],
  });
  const headers = new Headers(image.headers);
  headers.set("cache-control", "public, max-age=86400, stale-while-revalidate=604800");
  return new Response(image.body, { status: image.status, headers });
}
