// Public content feeds (#741) — RSS 2.0 / Atom 1.0 / JSON Feed 1.1 over data we
// ALREADY compute (the 6h changelog deltas + reconstructed incident history), so
// agents, readers, crawlers, and newsletters can subscribe to registry changes
// and incidents. Worker-computed at request time from the served artifacts — no
// new committed artifact, no new data collection. Read-only.
//
// Routes (all GET, content-negotiated):
//   /api/v1/feeds/registry[.rss|.atom|.json]
//   /api/v1/feeds/incidents[.rss|.atom|.json]
//   /api/v1/feeds/gaps[.rss|.atom|.json]
//   /api/v1/feeds/subnets/{netuid}[.rss|.atom|.json]
// Format precedence: explicit .rss/.atom/.json suffix > Accept header > JSON Feed.
//
// Optional `?tag=<tag>` narrows a feed to items carrying that tag, so a single
// feed URL can serve a focused subscription (e.g. ?tag=incident, ?tag=coverage,
// ?tag=artifact). Item tags: registry items carry "registry" + one of
// "subnet"/"artifact"/"coverage" + the change verb (added/removed/renamed/
// modified); incident items carry "incident", "sn<netuid>", and
// "ongoing"/"resolved"; gap items carry "gaps", the queue lane, "sn<netuid>",
// and each missing/direct-submission kind. An unknown tag yields an empty
// (but valid) feed.
//
// Optional `?since=<ISO-8601>` returns only items at or after that instant
// (e.g. ?since=2026-06-01 or ?since=2026-06-01T00:00:00Z), for incremental
// polling; it composes with `?tag=`. A malformed `since` is a 400.

import {
  EXPOSED_RESPONSE_HEADERS_VALUE,
  ifNoneMatchSatisfied,
  weakEtag,
} from "../workers/http.mjs";

const SITE_URL = "https://metagraph.sh";
const API_URL = "https://api.metagraph.sh";
const FEED_MAX_ITEMS = 50;
const FEED_CACHE_SECONDS = 600;

const FEED_CONTENT_TYPES = {
  json: "application/feed+json; charset=utf-8",
  rss: "application/rss+xml; charset=utf-8",
  atom: "application/atom+xml; charset=utf-8",
};

// ── text helpers ────────────────────────────────────────────────────────────

// XML 1.0 doesn't allow most C0 control chars even when escaped; strip them. The
// served artifacts are already build-sanitized (sanitizeChainText), so this is
// defense-in-depth on the public surface, not the primary trust boundary.
function stripControl(value) {
  // Drop XML-illegal C0 control chars (keep tab/newline/CR) without a
  // control-char regexp (eslint no-control-regex). Served data is already
  // build-sanitized; this is defense-in-depth on the public surface.
  let out = "";
  for (const ch of String(value ?? "")) {
    const code = ch.codePointAt(0);
    if (code < 32 && code !== 9 && code !== 10 && code !== 13) continue;
    out += ch;
  }
  return out;
}

function escapeXml(value) {
  return stripControl(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function clamp(value, max = 500) {
  const s = stripControl(value).trim();
  // Measure (and truncate) by code points, not UTF-16 code units: a plain
  // slice() can sever a non-BMP character (e.g. an emoji) straddling the
  // boundary into a lone surrogate, which is invalid in XML and breaks the
  // RSS/Atom feed. The length guard must use the same unit, or a string that
  // fits within `max` code points but has more code units (multiple emoji) gets
  // spuriously truncated.
  const points = [...s];
  if (points.length <= max) return s;
  return `${points.slice(0, max - 1).join("")}…`;
}

// Accept an ISO string or epoch-ms; return a normalized ISO string or null.
function toIso(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return new Date(value).toISOString();
  }
  if (typeof value === "string") {
    const t = Date.parse(value);
    if (!Number.isNaN(t)) return new Date(t).toISOString();
  }
  return null;
}

function toRfc822(iso) {
  return new Date(iso).toUTCString();
}

// ── item builders (from existing served artifacts) ──────────────────────────

// Registry feed: the latest changelog window's subnet + artifact + coverage
// changes. `netuid` (optional) filters to one subnet.
function registryItems(changelog, netuid) {
  const at = toIso(changelog?.generated_at) || new Date().toISOString();
  const items = [];

  // changelog.subnets is { added: [...], removed: [...], renamed: [...] }, each
  // entry a netuid or { netuid, name }.
  const subnets = changelog?.subnets || {};
  for (const change of ["added", "removed", "renamed"]) {
    for (const entry of subnets[change] || []) {
      const n = typeof entry === "number" ? entry : entry?.netuid;
      if (typeof n !== "number") continue;
      if (netuid != null && n !== netuid) continue;
      const name = typeof entry === "object" ? entry?.name : null;
      items.push({
        id: `registry:subnet:${n}:${change}:${at}`,
        url: `${SITE_URL}/subnets/${n}`,
        title: `Subnet ${n} ${change}${name ? ` — ${clamp(name, 80)}` : ""}`,
        summary: clamp(`Subnet ${n} ${change} in the registry.`),
        timestamp: at,
        tags: ["registry", "subnet", change],
      });
    }
  }

  // Per-subnet feeds are subnet-scoped only; the global registry feed also lists
  // artifact + coverage deltas. changelog.artifacts is { added, modified, removed }.
  if (netuid == null) {
    const artifacts = changelog?.artifacts || {};
    const verb = { added: "Added", modified: "Updated", removed: "Removed" };
    for (const change of ["added", "modified", "removed"]) {
      for (const a of artifacts[change] || []) {
        const path = a?.path || a?.artifact_path || a?.id;
        if (!path) continue;
        const cleanPath = String(path).replace(/^\/?(?:metagraph\/)?/, "");
        items.push({
          id: `registry:artifact:${change}:${path}:${at}`,
          url: `${API_URL}/metagraph/${cleanPath}`,
          title: `${verb[change]} ${clamp(path, 80)}`,
          summary: clamp(`Artifact ${path} ${change}.`),
          timestamp: at,
          tags: ["registry", "artifact", change],
        });
      }
    }
    const cov = changelog?.summary?.coverage_delta;
    const surfaceDelta = cov?.surface_count?.delta || 0;
    const candidateDelta = cov?.candidate_count?.delta || 0;
    if (surfaceDelta || candidateDelta) {
      const sign = (n) => (n >= 0 ? `+${n}` : `${n}`);
      // Only describe the side(s) actually present — a partial coverage_delta
      // (e.g. candidate_count only) must not emit "+0 surfaces" or interpolate
      // "Surfaces undefined→undefined" for the absent side.
      const titleParts = [];
      const summaryParts = [];
      if (cov?.surface_count) {
        titleParts.push(`${sign(surfaceDelta)} surfaces`);
        summaryParts.push(
          `Surfaces ${cov.surface_count.before}→${cov.surface_count.after}`,
        );
      }
      if (cov?.candidate_count) {
        titleParts.push(`${sign(candidateDelta)} candidates`);
        summaryParts.push(
          `candidates ${cov.candidate_count.before}→${cov.candidate_count.after}`,
        );
      }
      items.push({
        id: `registry:coverage:${at}`,
        url: `${SITE_URL}/gaps`,
        title: `Coverage updated: ${titleParts.join(", ")}`,
        summary: clamp(`${summaryParts.join("; ")}.`),
        timestamp: at,
        tags: ["registry", "coverage"],
      });
    }
  }

  return items;
}

// Gaps feed: ranked enrichment targets from the served enrichment queue.
function gapsItems(enrichmentQueue) {
  const at = toIso(enrichmentQueue?.generated_at) || new Date().toISOString();
  const items = [];
  for (const entry of enrichmentQueue?.queue || []) {
    const netuid = entry?.netuid;
    if (typeof netuid !== "number") continue;
    const name = entry?.name ? clamp(entry.name, 80) : `Subnet ${netuid}`;
    const missing = Array.isArray(entry.missing_kinds)
      ? entry.missing_kinds.filter(Boolean)
      : [];
    const targets = Array.isArray(entry.direct_submission_kinds)
      ? entry.direct_submission_kinds.filter(Boolean)
      : [];
    const lane = entry?.lane || "unknown";
    const priority =
      typeof entry?.priority_score === "number" ? entry.priority_score : null;
    const completeness =
      typeof entry?.completeness_score === "number"
        ? entry.completeness_score
        : null;
    const action = entry?.recommended_action
      ? clamp(entry.recommended_action, 120)
      : "Review enrichment opportunities";
    const summaryParts = [`Lane: ${lane}.`];
    if (priority != null) summaryParts.push(`Priority ${priority}.`);
    if (missing.length) {
      summaryParts.push(`Missing: ${missing.join(", ")}.`);
    }
    if (targets.length) {
      summaryParts.push(`Target kinds: ${targets.join(", ")}.`);
    }
    if (completeness != null) {
      summaryParts.push(`Completeness ${completeness}/100.`);
    }
    items.push({
      id: `gaps:sn${netuid}:${at}`,
      url: `${SITE_URL}/subnets/${netuid}`,
      title: `SN${netuid} ${name} — ${action}`,
      summary: clamp(summaryParts.join(" ")),
      timestamp: at,
      tags: [
        "gaps",
        lane,
        `sn${netuid}`,
        ...missing,
        ...targets.filter((kind) => !missing.includes(kind)),
      ],
    });
  }
  return items;
}

// Incidents feed: each reconstructed incident from the served incidents artifact.
// `netuid` (optional) filters to one subnet.
function incidentItems(incidents, netuid) {
  const items = [];
  for (const surface of incidents?.surfaces || []) {
    if (netuid != null && surface?.netuid !== netuid) continue;
    for (const inc of surface?.incidents || []) {
      const started = toIso(inc.started_at);
      const ended = toIso(inc.ended_at);
      const ongoing = !ended;
      const minutes = Math.round((inc.duration_ms || 0) / 60000);
      items.push({
        id: `incident:${surface.surface_id}:${inc.started_at}`,
        url: `${SITE_URL}/subnets/${surface.netuid}`,
        title: `${ongoing ? "Ongoing" : "Resolved"} incident — ${clamp(surface.surface_id, 80)}`,
        summary: clamp(
          `Surface ${surface.surface_id} (sn${surface.netuid}) ` +
            `${ongoing ? "is currently down" : `was down for ~${minutes}m`}` +
            `${inc.failed_samples ? `, ${inc.failed_samples} failed probes` : ""}.`,
        ),
        timestamp: ended || started || new Date().toISOString(),
        tags: [
          "incident",
          `sn${surface.netuid}`,
          ongoing ? "ongoing" : "resolved",
        ],
      });
    }
  }
  return items;
}

// ── serializers ─────────────────────────────────────────────────────────────

function sortAndCap(items) {
  return [...items]
    .sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp))
    .slice(0, FEED_MAX_ITEMS);
}

// Optional `?tag=` filter: keep only items whose tags array includes the value.
// A falsy/absent tag is a no-op (the whole feed). The tag is only ever compared,
// never rendered into the feed body, so it needs no escaping.
function filterByTag(items, tag) {
  if (!tag) return items;
  return items.filter((item) => (item.tags || []).includes(tag));
}

// Optional `?since=` filter: keep only items at or after `sinceMs` (epoch ms).
// A null bound (absent param) is a no-op; items whose timestamp can't be parsed
// are dropped, so a malformed feed entry never leaks past an explicit `since`.
function filterSince(items, sinceMs) {
  if (sinceMs == null) return items;
  return items.filter((item) => {
    const t = Date.parse(item.timestamp);
    return !Number.isNaN(t) && t >= sinceMs;
  });
}

function jsonFeed(meta, items) {
  return `${JSON.stringify(
    {
      version: "https://jsonfeed.org/version/1.1",
      title: meta.title,
      home_page_url: meta.homeUrl,
      feed_url: meta.feedUrl,
      description: meta.description,
      items: items.map((it) => ({
        id: it.id,
        url: it.url,
        title: it.title,
        content_text: it.summary,
        date_published: it.timestamp,
        tags: it.tags,
      })),
    },
    null,
    2,
  )}\n`;
}

function rssFeed(meta, items) {
  const body = items
    .map((it) =>
      [
        "    <item>",
        `      <guid isPermaLink="false">${escapeXml(it.id)}</guid>`,
        `      <link>${escapeXml(it.url)}</link>`,
        `      <title>${escapeXml(it.title)}</title>`,
        `      <description>${escapeXml(it.summary)}</description>`,
        `      <pubDate>${toRfc822(it.timestamp)}</pubDate>`,
        ...(it.tags || []).map(
          (t) => `      <category>${escapeXml(t)}</category>`,
        ),
        "    </item>",
      ].join("\n"),
    )
    .join("\n");
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">',
    "  <channel>",
    `    <title>${escapeXml(meta.title)}</title>`,
    `    <link>${escapeXml(meta.homeUrl)}</link>`,
    `    <atom:link href="${escapeXml(meta.feedUrl)}" rel="self" type="application/rss+xml"/>`,
    `    <description>${escapeXml(meta.description)}</description>`,
    `    <lastBuildDate>${toRfc822(meta.updated)}</lastBuildDate>`,
    body,
    "  </channel>",
    "</rss>",
    "",
  ]
    .filter((line) => line !== "")
    .join("\n");
}

function atomFeed(meta, items) {
  const body = items
    .map((it) =>
      [
        "  <entry>",
        `    <id>urn:metagraphed:${escapeXml(it.id)}</id>`,
        `    <title>${escapeXml(it.title)}</title>`,
        `    <link href="${escapeXml(it.url)}"/>`,
        `    <updated>${it.timestamp}</updated>`,
        `    <summary>${escapeXml(it.summary)}</summary>`,
        ...(it.tags || []).map((t) => `    <category term="${escapeXml(t)}"/>`),
        "  </entry>",
      ].join("\n"),
    )
    .join("\n");
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<feed xmlns="http://www.w3.org/2005/Atom">',
    `  <title>${escapeXml(meta.title)}</title>`,
    `  <link href="${escapeXml(meta.homeUrl)}"/>`,
    `  <link href="${escapeXml(meta.feedUrl)}" rel="self" type="application/atom+xml"/>`,
    `  <id>${escapeXml(meta.feedUrl)}</id>`,
    `  <updated>${meta.updated}</updated>`,
    `  <subtitle>${escapeXml(meta.description)}</subtitle>`,
    body,
    "</feed>",
    "",
  ]
    .filter((line) => line !== "")
    .join("\n");
}

const SERIALIZERS = { json: jsonFeed, rss: rssFeed, atom: atomFeed };

// ── request handling ────────────────────────────────────────────────────────

export function resolveFeedFormat(pathname, accept) {
  if (pathname.endsWith(".rss")) return "rss";
  if (pathname.endsWith(".atom")) return "atom";
  if (pathname.endsWith(".json")) return "json";
  const a = String(accept || "").toLowerCase();
  if (a.includes("application/rss+xml")) return "rss";
  if (a.includes("application/atom+xml")) return "atom";
  return "json";
}

// Parse `/api/v1/feeds/...` into { kind, netuid } or null for an unknown feed.
export function parseFeedPath(pathname) {
  const rest = pathname
    .replace(/^\/api\/v1\/feeds\/?/, "")
    .replace(/\.(rss|atom|json)$/, "")
    .replace(/\/$/, "");
  if (rest === "registry") return { kind: "registry" };
  if (rest === "incidents") return { kind: "incidents" };
  if (rest === "gaps") return { kind: "gaps" };
  const subnet = /^subnets\/(\d+)$/.exec(rest);
  if (subnet) return { kind: "subnet", netuid: Number(subnet[1]) };
  return null;
}

// Strictly parse the public `?since=` contract instead of delegating validation
// to Date.parse(), which accepts implementation-defined inputs and normalizes
// overflow dates. Accepted forms are an ISO calendar date (UTC midnight) or an
// ISO date-time with an explicit UTC/offset designator.
function parseSinceParam(value) {
  const raw = String(value);
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (dateOnly) {
    const [, year, month, day] = dateOnly;
    const ms = Date.UTC(Number(year), Number(month) - 1, Number(day));
    return new Date(ms).toISOString().slice(0, 10) === raw ? ms : Number.NaN;
  }

  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.exec(
      raw,
    );
  if (!match) return Number.NaN;

  const [, year, month, day, hour, minute, second, fraction = "", zone] = match;
  const date = `${year}-${month}-${day}`;
  const dateMs = Date.UTC(Number(year), Number(month) - 1, Number(day));
  if (new Date(dateMs).toISOString().slice(0, 10) !== date) return Number.NaN;

  const hourNumber = Number(hour);
  const minuteNumber = Number(minute);
  const secondNumber = Number(second);
  if (hourNumber > 23 || minuteNumber > 59 || secondNumber > 59) {
    return Number.NaN;
  }

  const normalizedFraction = fraction
    ? fraction.slice(0, 4).padEnd(4, "0")
    : ".000";
  const utcMs = Date.parse(
    `${date}T${hour}:${minute}:${second}${normalizedFraction}Z`,
  );
  const offsetMs =
    zone === "Z"
      ? 0
      : (() => {
          const sign = zone[0] === "-" ? -1 : 1;
          const hours = Number(zone.slice(1, 3));
          const minutes = Number(zone.slice(4, 6));
          if (hours > 23 || minutes > 59) return Number.NaN;
          return sign * (hours * 60 + minutes) * 60_000;
        })();
  if (Number.isNaN(offsetMs)) return Number.NaN;

  return utcMs - offsetMs;
}

function feedError(code, message, status) {
  return new Response(JSON.stringify({ ok: false, error: { code, message } }), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      // Public feeds are a cross-origin surface (browser feed readers / agents),
      // so errors must be CORS-readable like every sibling response (#2078).
      "access-control-allow-origin": "*",
    },
  });
}

async function readData(readArtifact, env, path) {
  try {
    const result = await readArtifact(env, path);
    return result?.ok ? result.data : null;
  } catch {
    return null;
  }
}

async function loadIncidentsData(deps, env) {
  if (typeof deps.loadLiveIncidents === "function") {
    try {
      return await deps.loadLiveIncidents(env);
    } catch {
      return null;
    }
  }
  return readData(deps.readArtifact, env, "/metagraph/incidents.json");
}

export async function handleFeedRequest(request, env, url, deps = {}) {
  const readArtifact = deps.readArtifact;
  // Feed errors go through the shared canonical envelope (workers/http.mjs
  // errorResponse), injected by the Worker so they match every other API
  // error — schema_version, data: null, meta.contract_version, and the
  // standard headers. feedError is the bare fallback when none is injected.
  const fail =
    typeof deps.errorResponse === "function" ? deps.errorResponse : feedError;
  const target = parseFeedPath(url.pathname);
  if (!target || typeof readArtifact !== "function") {
    return fail(
      "feed_not_found",
      "Unknown feed. Available: /api/v1/feeds/registry, /api/v1/feeds/incidents, /api/v1/feeds/gaps, /api/v1/feeds/subnets/{netuid} (each as .rss/.atom/.json or via Accept).",
      404,
    );
  }
  const format = resolveFeedFormat(url.pathname, request.headers.get("accept"));

  // Optional `?since=` lower bound (parsed once, here, so a malformed value is
  // rejected before any artifact work). null when the param is absent.
  let sinceMs = null;
  const sinceParam = url.searchParams.get("since");
  if (sinceParam != null) {
    sinceMs = parseSinceParam(sinceParam);
    if (Number.isNaN(sinceMs)) {
      return fail(
        "invalid_since",
        "`since` must be an ISO-8601 date or date-time, e.g. 2026-06-01 or 2026-06-01T00:00:00Z.",
        400,
      );
    }
  }

  let items;
  let title;
  let description;
  let homeUrl = SITE_URL;
  let updatedSource;

  if (target.kind === "registry") {
    const changelog = await readData(
      readArtifact,
      env,
      "/metagraph/changelog.json",
    );
    items = registryItems(changelog);
    title = "metagraphed — registry changes";
    description =
      "New and updated Bittensor subnets, surfaces, and coverage from the metagraphed registry.";
    updatedSource = changelog?.generated_at;
  } else if (target.kind === "incidents") {
    const incidents = await loadIncidentsData(deps, env);
    items = incidentItems(incidents);
    title = "metagraphed — surface incidents";
    description =
      "Operational incidents across Bittensor subnet surfaces (probe-detected downtime).";
    updatedSource = incidents?.observed_at;
  } else if (target.kind === "gaps") {
    const enrichmentQueue = await readData(
      readArtifact,
      env,
      "/metagraph/review/enrichment-queue.json",
    );
    items = gapsItems(enrichmentQueue);
    title = "metagraphed — coverage gaps";
    description =
      "Ranked Bittensor subnet enrichment targets: missing surfaces, contributor lanes, and recommended next actions from the metagraphed registry.";
    homeUrl = `${SITE_URL}/gaps`;
    updatedSource = enrichmentQueue?.generated_at;
  } else {
    const [changelog, incidents] = await Promise.all([
      readData(readArtifact, env, "/metagraph/changelog.json"),
      loadIncidentsData(deps, env),
    ]);
    items = [
      ...registryItems(changelog, target.netuid),
      ...incidentItems(incidents, target.netuid),
    ];
    title = `metagraphed — subnet ${target.netuid} feed`;
    description = `Registry changes and incidents for Bittensor subnet ${target.netuid}.`;
    homeUrl = `${SITE_URL}/subnets/${target.netuid}`;
    updatedSource = changelog?.generated_at;
  }

  items = filterByTag(items, url.searchParams.get("tag"));
  items = filterSince(items, sinceMs);
  items = sortAndCap(items);
  const meta = {
    title,
    description,
    homeUrl,
    feedUrl: `${url.origin}${url.pathname}`,
    updated:
      items[0]?.timestamp || toIso(updatedSource) || new Date().toISOString(),
  };

  const body = SERIALIZERS[format](meta, items);
  // The body is deterministic for its inputs, so its hash is a stable validator.
  const etag = await weakEtag(body);
  const headers = {
    "content-type": FEED_CONTENT_TYPES[format],
    "cache-control": `public, max-age=${FEED_CACHE_SECONDS}`,
    vary: "Accept",
    "x-content-type-options": "nosniff",
    etag,
    // Feeds are meant for cross-origin consumption (JSON Feed in browser JS, the
    // discovery Link header on /api/v1/subnets). Without CORS, cross-origin
    // clients can't read the body or the etag for conditional polling. Mirror the
    // canonical apiHeaders CORS pair so the 200/304/HEAD paths are readable.
    "access-control-allow-origin": "*",
    "access-control-expose-headers": EXPOSED_RESPONSE_HEADERS_VALUE,
  };
  // Unchanged poll → cheap 304, same validators, no body.
  if (ifNoneMatchSatisfied(request, etag)) {
    return new Response(null, { status: 304, headers });
  }
  return new Response(request.method === "HEAD" ? null : body, {
    status: 200,
    headers,
  });
}

// RFC 8288 Link header value advertising the feeds for an entity endpoint, so a
// crawler/agent on /api/v1/subnets or a subnet profile discovers them.
export function feedLinkHeader(originUrl, netuid) {
  const base =
    netuid != null
      ? `${originUrl}/api/v1/feeds/subnets/${netuid}`
      : `${originUrl}/api/v1/feeds/registry`;
  return (
    `<${base}.json>; rel="alternate"; type="application/feed+json", ` +
    `<${base}.rss>; rel="alternate"; type="application/rss+xml", ` +
    `<${base}.atom>; rel="alternate"; type="application/atom+xml"`
  );
}

// Exported for unit tests.
export const __test = {
  registryItems,
  incidentItems,
  gapsItems,
  jsonFeed,
  rssFeed,
  atomFeed,
  escapeXml,
  filterByTag,
  filterSince,
  parseSinceParam,
};
