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
//
// Optional `?until=<ISO-8601>` returns only items at or before that instant
// (same strict parsing as `since`) and composes with `?since=` and `?tag=` to
// page a bounded window; a malformed `until` is a 400. A bare calendar date is
// inclusive of the whole UTC day (end-of-day), so `?until=2026-06-30` keeps
// every item from June 30 rather than only the midnight tick — symmetric with
// the inclusive start-of-day a bare-date `?since=` resolves to.
//
// Optional `?limit=<1..50>` caps the number of returned items (default/max 50);
// it composes with `?since=`/`?until=`/`?tag=` and clamps a larger value to the
// 50-item hard cap. A non-integer or `< 1` value is a 400.

import {
  EXPOSED_RESPONSE_HEADERS_VALUE,
  ifNoneMatchSatisfied,
  weakEtag,
} from "../workers/http.ts";
import type { StorageReadResult } from "../workers/storage.ts";

const SITE_URL = "https://metagraph.sh";
const API_URL = "https://api.metagraph.sh";
export const FEED_MAX_ITEMS = 50;
const FEED_CACHE_SECONDS = 600;

type FeedFormat = "json" | "rss" | "atom";

const FEED_CONTENT_TYPES: Record<FeedFormat, string> = {
  json: "application/feed+json; charset=utf-8",
  rss: "application/rss+xml; charset=utf-8",
  atom: "application/atom+xml; charset=utf-8",
};

export interface FeedItem {
  id: string;
  url: string;
  title: string;
  summary: string;
  timestamp: string;
  tags: string[];
}

interface FeedMeta {
  title: string;
  description: string;
  homeUrl: string;
  feedUrl: string;
  updated: string;
}

// ── text helpers ────────────────────────────────────────────────────────────

// XML 1.0 doesn't allow most C0 control chars even when escaped; strip them. The
// served artifacts are already build-sanitized (sanitizeChainText), so this is
// defense-in-depth on the public surface, not the primary trust boundary.
function stripControl(value: unknown): string {
  // Drop XML-illegal C0 control chars (keep tab/newline/CR) without a
  // control-char regexp (eslint no-control-regex). Served data is already
  // build-sanitized; this is defense-in-depth on the public surface.
  let out = "";
  for (const ch of String(value ?? "")) {
    const code = ch.codePointAt(0);
    if (code != null && code < 32 && code !== 9 && code !== 10 && code !== 13) {
      continue;
    }
    out += ch;
  }
  return out;
}

function escapeXml(value: unknown): string {
  return stripControl(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function clamp(value: unknown, max = 500): string {
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
function toIso(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    // A finite but out-of-range epoch (|ms| > 8.64e15, the JS Date limit) makes
    // toISOString() throw a RangeError, which would 500 the whole feed on a
    // single corrupt incident/changelog timestamp. Guard the Date range and drop
    // it to null instead, matching the string branch's NaN guard below.
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date.toISOString() : null;
  }
  if (typeof value === "string") {
    let t = Date.parse(value);
    // D1 can return INTEGER epoch-ms as a numeric string Date.parse cannot read
    // (e.g. "1781266255266"). Only fall back to Number() for long digit runs —
    // short ones like "2026" must keep Date.parse semantics (year → 2026-01-01).
    if (Number.isNaN(t) && /^\d{10,}$/.test(value)) {
      t = Number(value);
    }
    if (!Number.isNaN(t)) {
      const date = new Date(t);
      return Number.isFinite(date.getTime()) ? date.toISOString() : null;
    }
  }
  return null;
}

function toRfc822(iso: unknown): string | null {
  if (iso == null) return null;
  const ms = Date.parse(String(iso));
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toUTCString();
}

// ── item builders (from existing served artifacts) ──────────────────────────

// Title + summary for one subnet change. A renamed entry carries before/after
// (the diffSubnets shape), so render the actual name change instead of dropping
// it; added/removed entries carry `name`. Falls back to the bare verb when no
// names are present (e.g. a legacy/bare `{ netuid }` entry).
function subnetRenameSide(value: unknown): string {
  return value == null ? "?" : clamp(String(value).trim(), 60) || "?";
}

function subnetChangeText(
  n: number,
  change: string,
  entry: Record<string, unknown> | null,
): { title: string; summary: string } {
  if (change === "renamed" && (entry?.before != null || entry?.after != null)) {
    const before = subnetRenameSide(entry?.before);
    const after = subnetRenameSide(entry?.after);
    return {
      title: `Subnet ${n} renamed — ${before} → ${after}`,
      summary: `Subnet ${n} renamed from ${before} to ${after} in the registry.`,
    };
  }
  const name = typeof entry?.name === "string" ? entry.name : null;
  return {
    title: `Subnet ${n} ${change}${name ? ` — ${clamp(name, 80)}` : ""}`,
    summary: `Subnet ${n} ${change} in the registry.`,
  };
}

// Registry feed: the latest changelog window's subnet + artifact + coverage
// changes. `netuid` (optional) filters to one subnet.
export function registryItems(
  changelog: unknown,
  netuid?: number | null,
): FeedItem[] {
  const c = (changelog ?? {}) as Record<string, unknown>;
  const at = toIso(c.generated_at) || new Date().toISOString();
  const items: FeedItem[] = [];

  // changelog.subnets is { added: [...], removed: [...], renamed: [...] }.
  // added/removed entries are { netuid, name, slug }; renamed entries are
  // { netuid, before, after } (see scripts/changelog.ts diffSubnets).
  const subnets = (c.subnets ?? {}) as Record<string, unknown>;
  for (const change of ["added", "removed", "renamed"]) {
    const entries = (subnets[change] as unknown[]) || [];
    for (const entry of entries) {
      const n =
        typeof entry === "number"
          ? entry
          : (entry as Record<string, unknown> | undefined)?.netuid;
      if (typeof n !== "number") continue;
      if (netuid != null && n !== netuid) continue;
      const entryObj =
        typeof entry === "object" && entry
          ? (entry as Record<string, unknown>)
          : null;
      const { title, summary } = subnetChangeText(n, change, entryObj);
      items.push({
        id: `registry:subnet:${n}:${change}:${at}`,
        url: `${SITE_URL}/subnets/${n}`,
        title,
        summary: clamp(summary),
        timestamp: at,
        tags: ["registry", "subnet", change],
      });
    }
  }

  // Per-subnet feeds are subnet-scoped only; the global registry feed also lists
  // artifact + coverage deltas. changelog.artifacts is { added, modified, removed }.
  if (netuid == null) {
    const artifacts = (c.artifacts ?? {}) as Record<string, unknown>;
    const verb: Record<string, string> = {
      added: "Added",
      modified: "Updated",
      removed: "Removed",
    };
    for (const change of ["added", "modified", "removed"]) {
      const entries = (artifacts[change] as unknown[]) || [];
      for (const a of entries) {
        const aObj = (a ?? {}) as Record<string, unknown>;
        const path = aObj.path || aObj.artifact_path || aObj.id;
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
    const summary = (c.summary ?? {}) as Record<string, unknown>;
    const cov = summary.coverage_delta as Record<string, unknown> | undefined;
    const surfaceCount = cov?.surface_count as
      Record<string, unknown> | undefined;
    const candidateCount = cov?.candidate_count as
      Record<string, unknown> | undefined;
    const surfaceDelta = (surfaceCount?.delta as number) || 0;
    const candidateDelta = (candidateCount?.delta as number) || 0;
    if (surfaceDelta || candidateDelta) {
      const sign = (n: number) => (n >= 0 ? `+${n}` : `${n}`);
      // Only describe the side(s) actually present — a partial coverage_delta
      // (e.g. candidate_count only) must not emit "+0 surfaces" or interpolate
      // "Surfaces undefined→undefined" for the absent side.
      const titleParts: string[] = [];
      const summaryParts: string[] = [];
      if (surfaceCount) {
        titleParts.push(`${sign(surfaceDelta)} surfaces`);
        summaryParts.push(
          `Surfaces ${surfaceCount.before}→${surfaceCount.after}`,
        );
      }
      if (candidateCount) {
        titleParts.push(`${sign(candidateDelta)} candidates`);
        summaryParts.push(
          `candidates ${candidateCount.before}→${candidateCount.after}`,
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
export function gapsItems(enrichmentQueue: unknown): FeedItem[] {
  const q = (enrichmentQueue ?? {}) as Record<string, unknown>;
  const at = toIso(q.generated_at) || new Date().toISOString();
  const items: FeedItem[] = [];
  const queue = (q.queue as unknown[]) || [];
  for (const rawEntry of queue) {
    const entry = (rawEntry ?? {}) as Record<string, unknown>;
    const netuid = entry.netuid;
    if (typeof netuid !== "number") continue;
    const name = entry.name ? clamp(entry.name, 80) : `Subnet ${netuid}`;
    const missing = Array.isArray(entry.missing_kinds)
      ? (entry.missing_kinds as unknown[]).filter(Boolean)
      : [];
    const targets = Array.isArray(entry.direct_submission_kinds)
      ? (entry.direct_submission_kinds as unknown[]).filter(Boolean)
      : [];
    const lane = entry.lane || "unknown";
    const priority =
      typeof entry.priority_score === "number" ? entry.priority_score : null;
    const completeness =
      typeof entry.completeness_score === "number"
        ? entry.completeness_score
        : null;
    const action = entry.recommended_action
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
        String(lane),
        `sn${netuid}`,
        ...(missing as string[]),
        ...(targets as string[]).filter((kind) => !missing.includes(kind)),
      ],
    });
  }
  return items;
}

// Incidents feed: each reconstructed incident from the served incidents artifact.
// `netuid` (optional) filters to one subnet.
export function incidentItems(
  incidents: unknown,
  netuid?: number | null,
): FeedItem[] {
  const items: FeedItem[] = [];
  const inc = (incidents ?? {}) as Record<string, unknown>;
  const surfaces = (inc.surfaces as unknown[]) || [];
  for (const rawSurface of surfaces) {
    const surface = (rawSurface ?? {}) as Record<string, unknown>;
    if (netuid != null && surface.netuid !== netuid) continue;
    const surfaceIncidents = (surface.incidents as unknown[]) || [];
    for (const rawInc of surfaceIncidents) {
      const inc = (rawInc ?? {}) as Record<string, unknown>;
      const started = toIso(inc.started_at);
      const ended = toIso(inc.ended_at);
      const ongoing = !ended;
      const minutes = Math.round(((inc.duration_ms as number) || 0) / 60000);
      items.push({
        id: `incident:${surface.surface_id}:${inc.started_at}`,
        url: `${SITE_URL}/subnets/${surface.netuid}`,
        title: `${ongoing ? "Ongoing" : "Resolved"} incident — ${clamp(surface.surface_id, 80)}`,
        summary: clamp(
          `Surface ${surface.surface_id} (sn${surface.netuid}) ` +
            `${ongoing ? "is currently down" : `was down for ~${minutes}m`}` +
            `${inc.failed_samples ? `, ${inc.failed_samples} failed probes` : ""}.`,
        ),
        // Window filters (?since= / ?until=) key on when the incident *started*,
        // not when it resolved — otherwise a resolved incident that began inside
        // a bounded window vanishes from that window once ended_at moves past ?until=.
        timestamp: started || ended || new Date().toISOString(),
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

export function sortAndCap(
  items: FeedItem[],
  max = FEED_MAX_ITEMS,
): FeedItem[] {
  return [...items]
    .sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp))
    .slice(0, max);
}

// Optional `?limit=` cap on the number of returned items: a positive integer,
// clamped to the FEED_MAX_ITEMS hard cap (so `?limit=100` yields at most 50).
// Returns NaN for a non-integer or < 1 value (→ 400), mirroring the strict
// `?since=`/`?until=` parsing.
function parseFeedLimit(raw: string): number {
  const value = raw.trim();
  if (!/^\d+$/.test(value)) return Number.NaN;
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 1) return Number.NaN;
  return Math.min(n, FEED_MAX_ITEMS);
}

// Optional `?tag=` filter: keep only items whose tags array includes the value.
// A falsy/absent tag is a no-op (the whole feed). The tag is only ever compared,
// never rendered into the feed body, so it needs no escaping.
export function filterByTag(items: FeedItem[], tag: unknown): FeedItem[] {
  if (!tag) return items;
  return items.filter((item) => (item.tags || []).includes(tag as string));
}

// Optional `?since=` filter: keep only items at or after `sinceMs` (epoch ms).
// A null bound (absent param) is a no-op; items whose timestamp can't be parsed
// are dropped, so a malformed feed entry never leaks past an explicit `since`.
export function filterSince(
  items: FeedItem[],
  sinceMs: number | null,
): FeedItem[] {
  if (sinceMs == null) return items;
  return items.filter((item) => {
    const t = Date.parse(item.timestamp);
    return !Number.isNaN(t) && t >= sinceMs;
  });
}

// Optional `?until=` filter: keep only items at or before `untilMs` (epoch ms).
// A null bound (absent param) is a no-op; items whose timestamp can't be parsed
// are dropped, so a malformed feed entry never leaks past an explicit `until`.
export function filterUntil(
  items: FeedItem[],
  untilMs: number | null,
): FeedItem[] {
  if (untilMs == null) return items;
  return items.filter((item) => {
    const t = Date.parse(item.timestamp);
    return !Number.isNaN(t) && t <= untilMs;
  });
}

function jsonFeed(meta: FeedMeta, items: FeedItem[]): string {
  return `${JSON.stringify(
    {
      version: "https://jsonfeed.org/version/1.1",
      title: meta.title,
      home_page_url: meta.homeUrl,
      feed_url: meta.feedUrl,
      description: meta.description,
      items: items.map((it) => {
        const datePublished = toIso(it.timestamp);
        return {
          id: it.id,
          url: it.url,
          title: it.title,
          content_text: it.summary,
          // date_published must be an RFC 3339 timestamp per JSON Feed 1.1; drop
          // it for a corrupt timestamp rather than emit an invalid value, matching
          // the rssFeed pubDate (toRfc822) and atomFeed updated (toIso, #3218) guards.
          ...(datePublished ? { date_published: datePublished } : {}),
          tags: it.tags,
        };
      }),
    },
    null,
    2,
  )}\n`;
}

function rssFeed(meta: FeedMeta, items: FeedItem[]): string {
  const body = items
    .map((it) => {
      const pubDate = toRfc822(it.timestamp);
      return [
        "    <item>",
        `      <guid isPermaLink="false">${escapeXml(it.id)}</guid>`,
        `      <link>${escapeXml(it.url)}</link>`,
        `      <title>${escapeXml(it.title)}</title>`,
        `      <description>${escapeXml(it.summary)}</description>`,
        ...(pubDate ? [`      <pubDate>${escapeXml(pubDate)}</pubDate>`] : []),
        ...(it.tags || []).map(
          (t) => `      <category>${escapeXml(t)}</category>`,
        ),
        "    </item>",
      ].join("\n");
    })
    .join("\n");
  const lastBuildDate = toRfc822(meta.updated);
  const lastBuildDateLine = lastBuildDate
    ? `    <lastBuildDate>${escapeXml(lastBuildDate)}</lastBuildDate>`
    : null;
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">',
    "  <channel>",
    `    <title>${escapeXml(meta.title)}</title>`,
    `    <link>${escapeXml(meta.homeUrl)}</link>`,
    `    <atom:link href="${escapeXml(meta.feedUrl)}" rel="self" type="application/rss+xml"/>`,
    `    <description>${escapeXml(meta.description)}</description>`,
    ...(lastBuildDateLine ? [lastBuildDateLine] : []),
    body,
    "  </channel>",
    "</rss>",
    "",
  ]
    .filter((line) => line !== "")
    .join("\n");
}

function atomFeed(meta: FeedMeta, items: FeedItem[]): string {
  const feedUpdated = toIso(meta.updated);
  const body = items
    .map((it) => {
      const updated = toIso(it.timestamp);
      return [
        "  <entry>",
        `    <id>urn:metagraphed:${escapeXml(it.id)}</id>`,
        `    <title>${escapeXml(it.title)}</title>`,
        `    <link href="${escapeXml(it.url)}"/>`,
        ...(updated ? [`    <updated>${escapeXml(updated)}</updated>`] : []),
        `    <summary>${escapeXml(it.summary)}</summary>`,
        ...(it.tags || []).map((t) => `    <category term="${escapeXml(t)}"/>`),
        "  </entry>",
      ].join("\n");
    })
    .join("\n");
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<feed xmlns="http://www.w3.org/2005/Atom">',
    `  <title>${escapeXml(meta.title)}</title>`,
    `  <link href="${escapeXml(meta.homeUrl)}"/>`,
    `  <link href="${escapeXml(meta.feedUrl)}" rel="self" type="application/atom+xml"/>`,
    `  <id>${escapeXml(meta.feedUrl)}</id>`,
    ...(feedUpdated ? [`  <updated>${escapeXml(feedUpdated)}</updated>`] : []),
    `  <subtitle>${escapeXml(meta.description)}</subtitle>`,
    body,
    "</feed>",
    "",
  ]
    .filter((line) => line !== "")
    .join("\n");
}

const SERIALIZERS: Record<
  FeedFormat,
  (meta: FeedMeta, items: FeedItem[]) => string
> = { json: jsonFeed, rss: rssFeed, atom: atomFeed };

// ── request handling ────────────────────────────────────────────────────────

export function resolveFeedFormat(
  pathname: string,
  accept: unknown,
): FeedFormat {
  if (pathname.endsWith(".rss")) return "rss";
  if (pathname.endsWith(".atom")) return "atom";
  if (pathname.endsWith(".json")) return "json";
  const a = String(accept || "").toLowerCase();
  if (a.includes("application/rss+xml")) return "rss";
  if (a.includes("application/atom+xml")) return "atom";
  return "json";
}

export type FeedTarget =
  | { kind: "registry" }
  | { kind: "incidents" }
  | { kind: "gaps" }
  | { kind: "subnet"; netuid: number };

// Parse `/api/v1/feeds/...` into { kind, netuid } or null for an unknown feed.
export function parseFeedPath(pathname: string): FeedTarget | null {
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

// Strictly parse the public `?since=`/`?until=` contract instead of delegating
// validation to Date.parse(), which accepts implementation-defined inputs and
// normalizes overflow dates. Accepted forms are an ISO calendar date or an ISO
// date-time with an explicit UTC/offset designator.
//
// A bare calendar date denotes a whole UTC day. For a lower bound (`since`) that
// resolves to the day's first instant (UTC midnight); for an upper bound
// (`until`, `endOfDay: true`) it resolves to the day's last instant
// (23:59:59.999Z) so the bound stays inclusive of the named day — `?until=DATE`
// keeps every item from that day rather than dropping all but the midnight tick.
// A date-time (with an explicit time) is an exact instant, unaffected by the flag.
export function parseSinceParam(
  value: unknown,
  { endOfDay = false }: { endOfDay?: boolean } = {},
): number {
  const raw = String(value);
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (dateOnly) {
    const [, year, month, day] = dateOnly;
    const ms = Date.UTC(Number(year), Number(month) - 1, Number(day));
    if (new Date(ms).toISOString().slice(0, 10) !== raw) return Number.NaN;
    return endOfDay
      ? Date.UTC(Number(year), Number(month) - 1, Number(day) + 1) - 1
      : ms;
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

function feedError(code: string, message: string, status: number): Response {
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

async function readData(
  readArtifact:
    ((env: Env, path: string) => Promise<StorageReadResult>) | undefined,
  env: Env,
  path: string,
): Promise<unknown> {
  try {
    if (!readArtifact) return null;
    const result = await readArtifact(env, path);
    return result?.ok ? result.data : null;
  } catch {
    return null;
  }
}

interface FeedRequestDeps {
  readArtifact?: (env: Env, path: string) => Promise<StorageReadResult>;
  errorResponse?: (code: string, message: string, status: number) => Response;
  loadLiveIncidents?: (env: Env) => Promise<unknown>;
}

async function loadIncidentsData(
  deps: FeedRequestDeps,
  env: Env,
): Promise<unknown> {
  if (typeof deps.loadLiveIncidents === "function") {
    try {
      return await deps.loadLiveIncidents(env);
    } catch {
      return null;
    }
  }
  return readData(deps.readArtifact, env, "/metagraph/incidents.json");
}

export async function handleFeedRequest(
  request: Request,
  env: Env,
  url: URL,
  deps: FeedRequestDeps = {},
): Promise<Response> {
  const readArtifact = deps.readArtifact;
  // Feed errors go through the shared canonical envelope (workers/http.mjs
  // errorResponse), injected by the Worker so they match every other API
  // error — schema_version, data: null, meta.contract_version, and the
  // standard headers. feedError is the bare fallback when none is injected.
  const fail = deps.errorResponse ?? feedError;
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
  let sinceMs: number | null = null;
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

  // Optional `?until=` upper bound (same strict ISO-8601 contract as `since`),
  // parsed up front so a malformed value is rejected before any artifact work.
  let untilMs: number | null = null;
  const untilParam = url.searchParams.get("until");
  if (untilParam != null) {
    // A bare-date `until` is inclusive of the whole named day (end-of-day),
    // mirroring the inclusive start-of-day a bare-date `since` resolves to.
    untilMs = parseSinceParam(untilParam, { endOfDay: true });
    if (Number.isNaN(untilMs)) {
      return fail(
        "invalid_until",
        "`until` must be an ISO-8601 date or date-time, e.g. 2026-06-30 or 2026-06-30T00:00:00Z.",
        400,
      );
    }
  }

  // Optional `?limit=` cap (1..FEED_MAX_ITEMS), parsed up front like the window
  // bounds so a malformed value is rejected before any artifact work.
  let limit = FEED_MAX_ITEMS;
  const limitParam = url.searchParams.get("limit");
  if (limitParam != null) {
    limit = parseFeedLimit(limitParam);
    if (Number.isNaN(limit)) {
      return fail(
        "invalid_limit",
        `\`limit\` must be an integer between 1 and ${FEED_MAX_ITEMS}.`,
        400,
      );
    }
  }

  let items: FeedItem[];
  let title: string;
  let description: string;
  let homeUrl = SITE_URL;
  let updatedSource: unknown;

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
    updatedSource = (changelog as Record<string, unknown> | null)?.generated_at;
  } else if (target.kind === "incidents") {
    const incidents = await loadIncidentsData(deps, env);
    items = incidentItems(incidents);
    title = "metagraphed — surface incidents";
    description =
      "Operational incidents across Bittensor subnet surfaces (probe-detected downtime).";
    updatedSource = (incidents as Record<string, unknown> | null)?.observed_at;
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
    updatedSource = (enrichmentQueue as Record<string, unknown> | null)
      ?.generated_at;
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
    updatedSource = (changelog as Record<string, unknown> | null)?.generated_at;
  }

  items = filterByTag(items, url.searchParams.get("tag"));
  items = filterSince(items, sinceMs);
  items = filterUntil(items, untilMs);
  items = sortAndCap(items, limit);
  const meta: FeedMeta = {
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
export function feedLinkHeader(
  originUrl: string,
  netuid?: number | null,
): string {
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
  toIso,
  toRfc822,
  registryItems,
  incidentItems,
  gapsItems,
  jsonFeed,
  rssFeed,
  atomFeed,
  escapeXml,
  filterByTag,
  filterSince,
  filterUntil,
  parseSinceParam,
};
