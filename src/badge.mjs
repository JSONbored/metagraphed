// Embeddable shields.io-style SVG badges: a subnet/provider drops
// `![metagraphed](…/badge.svg)` in its README for a backlink + a visible score.
//
//   GET /api/v1/subnets/{netuid}/badge.svg   subnet score
//   GET /api/v1/providers/{slug}/badge.svg   mean across its subnets
//
// Query options (allow-listed / sanitized in parseBadgeOptions):
//   metric=readiness   integration readiness 0–100 (default)
//   metric=uptime      window uptime %, colored by the A–F reliability grade
//                      (alias: reliability), from the live uptime rollup in D1
//   metric=grade       the A–F reliability grade letter itself (e.g. "A") —
//                      same uptime data + color band as uptime, one-glyph message
//   metric=apis        count of callable API surfaces the subnet exposes
//                      (subnet-api / openapi / sse / data-artifact); informational
//                      blue, gray for 0; for a provider, the sum across its subnets
//   metric=completeness  coverage completeness 0–100 from profiles.json
//                        (alias: coverage); provider = mean across its subnets
//   style=flat-square  square corners, no gradient (default: flat)
//   style=for-the-badge  taller (28px), uppercase bold, letter-spaced, matte
//   label=…            override the left "metagraphed" segment text
//
// Worker-computed image/svg+xml, read-only, edge-cached, CORS-open. Unknown
// entities or missing data render an "n/a" badge (200) so an <img> never breaks.
import { loadReliabilityAggregate } from "./health-serving.mjs";

const BADGE_CACHE_SECONDS = 3600;
const BADGE_LABEL = "metagraphed";
const MAX_LABEL_LENGTH = 40;
const NA_MESSAGE = "n/a";
const UNKNOWN_COLOR = "#9f9f9f";
const NA_CONTENT = { message: NA_MESSAGE, color: UNKNOWN_COLOR };

// metric query value → internal metric ("uptime"/"reliability" are aliases;
// "grade" shares the reliability data but renders the letter grade as the message).
const BADGE_METRICS = {
  readiness: "readiness",
  uptime: "reliability",
  reliability: "reliability",
  grade: "grade",
  apis: "apis",
  completeness: "completeness",
  coverage: "completeness",
};
// Allow-listed render styles; an unknown value falls back to "flat".
const BADGE_STYLES = new Set(["flat", "flat-square", "for-the-badge"]);
const FOR_THE_BADGE_HEIGHT = 28;
const FOR_THE_BADGE_PAD = 12;
const FOR_THE_BADGE_LETTER_SPACING = 1.25;
// shields.io "informational" blue, used for plain-count metrics (e.g. apis).
const INFO_COLOR = "#007ec6";
// Surface kinds that are callable machine interfaces (mirrors the build's
// callable-service set); these are what `metric=apis` counts.
const CALLABLE_SURFACE_KINDS = new Set([
  "subnet-api",
  "openapi",
  "sse",
  "data-artifact",
]);
// A–F grade → color band (gray for unknown); bands match reliability.mjs.
const GRADE_COLOR = {
  A: "#2ea44f",
  B: "#97ca00",
  C: "#a4a61d",
  D: "#dfb317",
  F: "#e05d44",
};

function escapeXml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// East Asian Wide / Fullwidth and astral (emoji) code points render about one em
// wide — far wider than the 6.5px lowercase default they would otherwise fall
// through to. Treating them as full-width keeps textWidth a safe overestimate so
// a CJK or emoji label can't clip its own segment (#1650).
function isWideCodePoint(cp) {
  return (
    (cp >= 0x1100 && cp <= 0x115f) || // Hangul Jamo
    (cp >= 0x2e80 && cp <= 0x303e) || // CJK radicals, Kangxi
    (cp >= 0x3041 && cp <= 0x33ff) || // Hiragana/Katakana .. CJK symbols
    (cp >= 0x3400 && cp <= 0x4dbf) || // CJK Ext A
    (cp >= 0x4e00 && cp <= 0x9fff) || // CJK Unified Ideographs
    (cp >= 0xa000 && cp <= 0xa4cf) || // Yi
    (cp >= 0xac00 && cp <= 0xd7a3) || // Hangul Syllables
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK Compatibility Ideographs
    (cp >= 0xfe30 && cp <= 0xfe4f) || // CJK Compatibility Forms
    (cp >= 0xff00 && cp <= 0xff60) || // Fullwidth Forms
    (cp >= 0xffe0 && cp <= 0xffe6) || // Fullwidth signs
    cp >= 0x1f000 // emoji + astral CJK extensions
  );
}

// Approximate px width of text in the 11px sans the badge renders with. Per-char
// widths are a safe overestimate so text never overflows its segment.
function textWidth(text) {
  let w = 0;
  for (const ch of String(text)) {
    const cp = ch.codePointAt(0);
    if (cp <= 0x7f) {
      if (/[ilj.,:'!|]/.test(ch)) w += 3;
      else if (/[A-Z0-9mw%@]/.test(ch)) w += 8;
      else w += 6.5;
    } else if (isWideCodePoint(cp)) {
      w += 11; // ~1em: safe overestimate for full-width / emoji glyphs
    } else {
      w += 8; // other non-ASCII (e.g. accented Latin): at least capital width
    }
  }
  return Math.ceil(w);
}

// Width estimate for the shields `for-the-badge` style: uppercase bold 10px
// Verdana plus synthetic letter-spacing. Safe overestimate so glyphs never clip.
function forTheBadgeTextWidth(text) {
  const upper = String(text).toUpperCase();
  let w = 0;
  for (const ch of upper) {
    const cp = ch.codePointAt(0);
    if (cp <= 0x7f) {
      if (/[ilj.,:'!|]/.test(ch)) w += 4;
      else if (/[MW%@]/.test(ch)) w += 11;
      else if (/[A-Z0-9]/.test(ch)) w += 9;
      else w += 7;
    } else if (isWideCodePoint(cp)) {
      w += 12;
    } else {
      w += 9;
    }
    w += FOR_THE_BADGE_LETTER_SPACING;
  }
  return Math.ceil(w);
}

// Readiness score (0–100) → color (green / amber / red; gray for unknown).
export function scoreColor(score) {
  if (typeof score !== "number" || Number.isNaN(score)) return UNKNOWN_COLOR;
  if (score >= 80) return "#2ea44f";
  if (score >= 50) return "#dfb317";
  return "#e05d44";
}

// Reliability grade (A–F) → color band; gray when unknown / no data.
export function gradeColor(grade) {
  return GRADE_COLOR[grade] || UNKNOWN_COLOR;
}

// Render a two-segment badge: gray label + colored message. `style` is "flat"
// (rounded + glossy gradient), "flat-square" (square, matte), or "for-the-badge"
// (28px tall, uppercase bold, letter-spaced, matte).
export function renderBadge(message, color, options = {}) {
  const { label = BADGE_LABEL, style = "flat" } = options;
  if (style === "for-the-badge") {
    const displayLabel = String(label).toUpperCase();
    const displayMessage = String(message).toUpperCase();
    const eLabel = escapeXml(displayLabel);
    const eMsg = escapeXml(displayMessage);
    const labelTextW = forTheBadgeTextWidth(displayLabel);
    const msgTextW = forTheBadgeTextWidth(displayMessage);
    const labelW = labelTextW + FOR_THE_BADGE_PAD;
    const msgW = msgTextW + FOR_THE_BADGE_PAD;
    const total = labelW + msgW;
    const labelMid = labelW / 2;
    const msgMid = labelW + msgW / 2;
    return [
      `<svg xmlns="http://www.w3.org/2000/svg" width="${total}" height="${FOR_THE_BADGE_HEIGHT}" role="img" aria-label="${eLabel}: ${eMsg}">`,
      `<title>${eLabel}: ${eMsg}</title>`,
      `<clipPath id="r"><rect width="${total}" height="${FOR_THE_BADGE_HEIGHT}" rx="0" fill="#fff"/></clipPath>`,
      `<g clip-path="url(#r)">`,
      `<rect width="${labelW}" height="${FOR_THE_BADGE_HEIGHT}" fill="#555"/>`,
      `<rect x="${labelW}" width="${msgW}" height="${FOR_THE_BADGE_HEIGHT}" fill="${color}"/>`,
      `</g>`,
      `<g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="10" font-weight="bold">`,
      `<text x="${labelMid}" y="20" textLength="${labelTextW}" lengthAdjust="spacing">${eLabel}</text>`,
      `<text x="${msgMid}" y="20" textLength="${msgTextW}" lengthAdjust="spacing">${eMsg}</text>`,
      `</g>`,
      `</svg>`,
      ``,
    ].join("\n");
  }

  const eLabel = escapeXml(label);
  const eMsg = escapeXml(message);
  const pad = 12;
  const labelW = textWidth(label) + pad;
  const msgW = textWidth(message) + pad;
  const total = labelW + msgW;
  const labelMid = labelW / 2;
  const msgMid = labelW + msgW / 2;
  const square = style === "flat-square";
  const rx = square ? 0 : 3;
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${total}" height="20" role="img" aria-label="${eLabel}: ${eMsg}">`,
    `<title>${eLabel}: ${eMsg}</title>`,
    square
      ? null
      : `<linearGradient id="s" x2="0" y2="100%"><stop offset="0" stop-color="#bbb" stop-opacity=".1"/><stop offset="1" stop-opacity=".1"/></linearGradient>`,
    `<clipPath id="r"><rect width="${total}" height="20" rx="${rx}" fill="#fff"/></clipPath>`,
    `<g clip-path="url(#r)">`,
    `<rect width="${labelW}" height="20" fill="#555"/>`,
    `<rect x="${labelW}" width="${msgW}" height="20" fill="${color}"/>`,
    square ? null : `<rect width="${total}" height="20" fill="url(#s)"/>`,
    `</g>`,
    `<g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11">`,
    `<text x="${labelMid}" y="15" fill="#010101" fill-opacity=".3">${eLabel}</text>`,
    `<text x="${labelMid}" y="14">${eLabel}</text>`,
    `<text x="${msgMid}" y="15" fill="#010101" fill-opacity=".3">${eMsg}</text>`,
    `<text x="${msgMid}" y="14">${eMsg}</text>`,
    `</g>`,
    `</svg>`,
    ``,
  ]
    .filter((line) => line != null)
    .join("\n");
}

async function readData(readArtifact, env, path) {
  try {
    const result = await readArtifact(env, path);
    return result?.ok ? result.data : null;
  } catch {
    return null;
  }
}

// A provider entry by slug (providers carry either `slug` or legacy `id`).
function findProvider(providers, slug) {
  return (providers?.providers || []).find((p) => (p.slug || p.id) === slug);
}

// Mean integration_readiness across a provider's subnets, rounded; null when
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

// Mean completeness_score across a provider's subnets, rounded; null when
// none of them resolve to a numeric score.
function averageCompleteness(netuids, profilesArtifact) {
  const byNetuid = new Map(
    (profilesArtifact?.profiles || []).map((p) => [
      p.netuid,
      p.completeness_score,
    ]),
  );
  const scores = (netuids || [])
    .map((n) => byNetuid.get(n))
    .filter((v) => typeof v === "number");
  if (!scores.length) return null;
  return Math.round(scores.reduce((a, b) => a + b, 0) / scores.length);
}

// uptime_ratio (0–1) → trimmed percent: 0.9983 → "99.83%", 1 → "100%".
export function formatUptimePercent(ratio) {
  const value = Number(ratio) || 0;
  let pct = Math.round(value * 10000) / 100;
  // Only an exact full ratio reads as "100%". A sub-1 ratio in [0.99995, 1)
  // rounds up to 100, which would render a perfect-uptime badge for a service
  // that is not actually at 100%; clamp it down to the largest 2-decimal value
  // below 100 so the badge never overstates reliability.
  if (pct >= 100 && value < 1) {
    pct = 99.99;
  }
  return `${pct}%`;
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

// Drop C0 control chars + DEL (invalid in XML), trim, then length-cap so a label
// override can't break the SVG or overflow a segment. A code-point filter (no
// control-char regex literals) keeps the source clean.
function sanitizeLabel(raw) {
  let out = "";
  for (const ch of String(raw)) {
    const code = ch.codePointAt(0);
    if (code >= 0x20 && code !== 0x7f) out += ch;
  }
  // Cap by code points, not UTF-16 code units: a plain slice() can sever a
  // non-BMP character (e.g. an emoji) straddling the boundary into a lone
  // surrogate, which is invalid in XML and corrupts the SVG.
  return [...out.trim()].slice(0, MAX_LABEL_LENGTH).join("") || BADGE_LABEL;
}

// Parse the public query options. Metric + style are allow-listed; the label is
// sanitized (escapeXml runs again at render).
export function parseBadgeOptions(searchParams) {
  const metric =
    BADGE_METRICS[(searchParams.get("metric") || "").toLowerCase()] ||
    "readiness";
  const styleParam = (searchParams.get("style") || "").toLowerCase();
  const style = BADGE_STYLES.has(styleParam) ? styleParam : "flat";
  const rawLabel = searchParams.get("label");
  const label = rawLabel == null ? BADGE_LABEL : sanitizeLabel(rawLabel);
  return { metric, style, label };
}

// Completeness: the subnet's coverage completeness_score, or a provider's mean.
async function completenessContent({ target, readArtifact, env }) {
  let score = null;
  if (target.kind === "subnet") {
    const profiles = await readData(
      readArtifact,
      env,
      "/metagraph/profiles.json",
    );
    const row = (profiles?.profiles || []).find(
      (p) => p.netuid === target.netuid,
    );
    if (row && typeof row.completeness_score === "number") {
      score = row.completeness_score;
    }
  } else {
    const [providers, profiles] = await Promise.all([
      readData(readArtifact, env, "/metagraph/providers.json"),
      readData(readArtifact, env, "/metagraph/profiles.json"),
    ]);
    const provider = findProvider(providers, target.slug);
    if (provider) score = averageCompleteness(provider.netuids, profiles);
  }
  return {
    message: typeof score === "number" ? `${score}/100` : NA_MESSAGE,
    color: scoreColor(score),
  };
}

// Readiness: the subnet's own integration_readiness, or a provider's mean.
async function readinessContent({ target, readArtifact, env }) {
  let score = null;
  if (target.kind === "subnet") {
    const index = await readData(readArtifact, env, "/metagraph/subnets.json");
    const s = (index?.subnets || []).find((x) => x.netuid === target.netuid);
    if (s && typeof s.integration_readiness === "number") {
      score = s.integration_readiness;
    }
  } else {
    const [providers, index] = await Promise.all([
      readData(readArtifact, env, "/metagraph/providers.json"),
      readData(readArtifact, env, "/metagraph/subnets.json"),
    ]);
    const provider = findProvider(providers, target.slug);
    if (provider) score = averageReadiness(provider.netuids, index);
  }
  return {
    message: typeof score === "number" ? `${score}/100` : NA_MESSAGE,
    color: scoreColor(score),
  };
}

// Reliability: the subnet's netuid, or all of a provider's netuids, scored from
// the live uptime rollup in one aggregate query, colored by the A–F grade band.
// The message is the window uptime % — or, for metric=grade, the grade letter.
async function reliabilityContent({
  target,
  readArtifact,
  env,
  db,
  loadReliability,
  metric,
}) {
  let netuids = [];
  if (target.kind === "subnet") {
    netuids = [target.netuid];
  } else {
    const providers = await readData(
      readArtifact,
      env,
      "/metagraph/providers.json",
    );
    const provider = findProvider(providers, target.slug);
    if (provider) netuids = provider.netuids || [];
  }
  const rel = netuids.length ? await loadReliability({ db, netuids }) : null;
  return rel
    ? {
        message:
          metric === "grade"
            ? rel.grade
            : formatUptimePercent(rel.uptime_ratio),
        color: gradeColor(rel.grade),
      }
    : NA_CONTENT;
}

// Count a subnet's callable API surfaces from its per-subnet surfaces artifact.
// Returns null when the artifact is missing/malformed (so the badge renders
// "n/a" rather than a misleading 0).
async function callableApiCount(readArtifact, env, netuid) {
  const data = await readData(
    readArtifact,
    env,
    `/metagraph/surfaces/${netuid}.json`,
  );
  if (!Array.isArray(data?.surfaces)) return null;
  return data.surfaces.filter((s) => CALLABLE_SURFACE_KINDS.has(s?.kind))
    .length;
}

// APIs: the subnet's callable API-surface count, or the sum across a provider's
// subnets. Informational blue for >0, gray for 0; "n/a" when there is no data.
async function apisContent({ target, readArtifact, env }) {
  let count = null;
  if (target.kind === "subnet") {
    count = await callableApiCount(readArtifact, env, target.netuid);
  } else {
    const providers = await readData(
      readArtifact,
      env,
      "/metagraph/providers.json",
    );
    const netuids = findProvider(providers, target.slug)?.netuids || [];
    if (netuids.length) {
      const counts = (
        await Promise.all(
          netuids.map((n) => callableApiCount(readArtifact, env, n)),
        )
      ).filter((c) => typeof c === "number");
      if (counts.length) count = counts.reduce((a, b) => a + b, 0);
    }
  }
  if (count == null) return NA_CONTENT;
  return {
    message: `${count} ${count === 1 ? "api" : "apis"}`,
    color: count > 0 ? INFO_COLOR : UNKNOWN_COLOR,
  };
}

function badgeHeaders() {
  return {
    "content-type": "image/svg+xml; charset=utf-8",
    "cache-control": `public, max-age=${BADGE_CACHE_SECONDS}`,
    "x-content-type-options": "nosniff",
    // Public read-only SVG: fetchable cross-origin like every apiHeaders() response.
    "access-control-allow-origin": "*",
  };
}

export async function handleBadgeRequest(request, env, url, deps = {}) {
  const readArtifact = deps.readArtifact;
  const target = parseBadgePath(url.pathname);
  const { metric, style, label } = parseBadgeOptions(url.searchParams);
  const ctx = {
    target,
    readArtifact,
    env,
    db: deps.db ?? env?.METAGRAPH_HEALTH_DB,
    loadReliability: deps.loadReliability || loadReliabilityAggregate,
  };

  let content = NA_CONTENT;
  if (target && typeof readArtifact === "function") {
    if (metric === "apis") {
      content = await apisContent(ctx);
    } else if (metric === "reliability" || metric === "grade") {
      content = await reliabilityContent({ ...ctx, metric });
    } else if (metric === "completeness") {
      content = await completenessContent(ctx);
    } else {
      content = await readinessContent(ctx);
    }
  }

  const svg = renderBadge(content.message, content.color, { label, style });
  return new Response(request.method === "HEAD" ? null : svg, {
    status: 200,
    headers: badgeHeaders(),
  });
}
