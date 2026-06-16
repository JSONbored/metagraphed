// Embeddable shields.io-style SVG badges (#744) — a distribution flywheel: a
// subnet/provider drops `![metagraphed](…/badge.svg)` in its README, creating a
// backlink + social pressure to improve the score we already compute.
//
//   GET /api/v1/subnets/{netuid}/badge.svg   → that subnet's integration readiness
//   GET /api/v1/providers/{slug}/badge.svg   → mean readiness across its subnets
//
// Worker-computed (image/svg+xml, not a JSON-envelope route), read-only, edge-
// cached. Unknown entities degrade to an "n/a" badge (HTTP 200) so an embedded
// <img> never shows a broken image.

const BADGE_CACHE_SECONDS = 3600;
const BADGE_LABEL = "metagraphed";

function escapeXml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// Approximate px width of text in the 11px sans the badge renders with. Per-char
// widths are a safe overestimate so text never overflows its segment.
function textWidth(text) {
  let w = 0;
  for (const ch of String(text)) {
    if (/[ilj.,:'!|]/.test(ch)) w += 3;
    else if (/[A-Z0-9mw%@]/.test(ch)) w += 8;
    else w += 6.5;
  }
  return Math.ceil(w);
}

// Accessible score → color (green / amber / red; gray for unknown).
export function scoreColor(score) {
  if (typeof score !== "number" || Number.isNaN(score)) return "#9f9f9f";
  if (score >= 80) return "#2ea44f";
  if (score >= 50) return "#dfb317";
  return "#e05d44";
}

// Render a flat two-segment badge: gray label + colored message.
export function renderBadge(message, color, label = BADGE_LABEL) {
  const eLabel = escapeXml(label);
  const eMsg = escapeXml(message);
  const pad = 12;
  const labelW = textWidth(label) + pad;
  const msgW = textWidth(message) + pad;
  const total = labelW + msgW;
  const labelMid = labelW / 2;
  const msgMid = labelW + msgW / 2;
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${total}" height="20" role="img" aria-label="${eLabel}: ${eMsg}">`,
    `<title>${eLabel}: ${eMsg}</title>`,
    `<linearGradient id="s" x2="0" y2="100%"><stop offset="0" stop-color="#bbb" stop-opacity=".1"/><stop offset="1" stop-opacity=".1"/></linearGradient>`,
    `<clipPath id="r"><rect width="${total}" height="20" rx="3" fill="#fff"/></clipPath>`,
    `<g clip-path="url(#r)">`,
    `<rect width="${labelW}" height="20" fill="#555"/>`,
    `<rect x="${labelW}" width="${msgW}" height="20" fill="${color}"/>`,
    `<rect width="${total}" height="20" fill="url(#s)"/>`,
    `</g>`,
    `<g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11">`,
    `<text x="${labelMid}" y="15" fill="#010101" fill-opacity=".3">${eLabel}</text>`,
    `<text x="${labelMid}" y="14">${eLabel}</text>`,
    `<text x="${msgMid}" y="15" fill="#010101" fill-opacity=".3">${eMsg}</text>`,
    `<text x="${msgMid}" y="14">${eMsg}</text>`,
    `</g>`,
    `</svg>`,
    ``,
  ].join("\n");
}

async function readData(readArtifact, env, path) {
  try {
    const result = await readArtifact(env, path);
    return result?.ok ? result.data : null;
  } catch {
    return null;
  }
}

// Mean integration_readiness across a provider's subnets, rounded — or null when
// none of them resolve to a numeric score.
function averageReadiness(netuids, subnetsIndex) {
  const byNetuid = new Map(
    (subnetsIndex?.subnets || []).map((s) => [
      s.netuid,
      s.integration_readiness,
    ]),
  );
  const scores = (netuids || [])
    .map((n) => byNetuid.get(n))
    .filter((v) => typeof v === "number");
  if (!scores.length) return null;
  return Math.round(scores.reduce((a, b) => a + b, 0) / scores.length);
}

export function parseBadgePath(pathname) {
  let m = /^\/api\/v1\/subnets\/(\d+)\/badge\.svg$/.exec(pathname);
  if (m) return { kind: "subnet", netuid: Number(m[1]) };
  m = /^\/api\/v1\/providers\/([a-z0-9][a-z0-9._-]*)\/badge\.svg$/i.exec(
    pathname,
  );
  if (m) return { kind: "provider", slug: m[1].toLowerCase() };
  return null;
}

export async function handleBadgeRequest(request, env, url, deps = {}) {
  const readArtifact = deps.readArtifact;
  const target = parseBadgePath(url.pathname);
  let score = null;

  if (target && typeof readArtifact === "function") {
    if (target.kind === "subnet") {
      const index = await readData(
        readArtifact,
        env,
        "/metagraph/subnets.json",
      );
      const s = (index?.subnets || []).find((x) => x.netuid === target.netuid);
      if (s && typeof s.integration_readiness === "number") {
        score = s.integration_readiness;
      }
    } else {
      const [providers, index] = await Promise.all([
        readData(readArtifact, env, "/metagraph/providers.json"),
        readData(readArtifact, env, "/metagraph/subnets.json"),
      ]);
      const p = (providers?.providers || []).find(
        (x) => (x.slug || x.id) === target.slug,
      );
      if (p) score = averageReadiness(p.netuids, index);
    }
  }

  const message = typeof score === "number" ? `${score}/100` : "n/a";
  const svg = renderBadge(message, scoreColor(score));
  return new Response(request.method === "HEAD" ? null : svg, {
    status: 200,
    headers: {
      "content-type": "image/svg+xml; charset=utf-8",
      "cache-control": `public, max-age=${BADGE_CACHE_SECONDS}`,
      "x-content-type-options": "nosniff",
    },
  });
}
