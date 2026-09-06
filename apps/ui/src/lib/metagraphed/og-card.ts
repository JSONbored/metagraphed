import { SITE_ORIGIN } from "./identity";
import { OG_CARD_VERSION, OG_LIMITS } from "./og-card-limits";
import { clampText } from "./truncate";

// Builds the /og card URL a route puts in its own og:image (#8489).
//
// Deliberately a SEPARATE module from src/lib/og-image.ts (which renders the
// card on the Worker): that file pulls in the satori/workers-og types and the
// full markup, and route files are client-bundled -- importing the renderer
// just to build a URL would drag the card into every page's JS. This module is
// ~60 lines of string building with no dependencies.
//
// The two files therefore share a CONTRACT, not code: the param names written
// here must match the ones `readCardParams` reads there. Both sides name the
// other in a comment; change one, change both.
//
// WHY ROUTES OWN THIS AT ALL. og:image used to be injected globally in
// src/server.ts from the pathname alone, which is why every card was generic:
// that injection runs in the Worker's HTMLRewriter pass and has no access to
// the route's loader data, so it could never say "SN64, Chutes, healthy" --
// only "Subnet 64". A route's own head() DOES have loaderData, so the entity
// routes emit their own og:image and server.ts skips those paths
// (routeOwnsOgImage below is the single source of truth for which). That keeps
// exactly one og:image tag on every page.

/** One "LABEL / value" cell in the card's stat rail. Max three are rendered. */
export interface OgCardStat {
  label: string;
  value: string;
}

export interface OgCardOptions {
  title: string;
  subtitle?: string | null;
  /** Small pill next to the wordmark, e.g. "SUBNET" / "VALIDATOR". */
  eyebrow?: string | null;
  stats?: OgCardStat[];
  /** Bare DNS name (use `logoHostFrom`). The card renders it through the
   * SSRF-safe icon proxy; absent, it falls back to a monogram. */
  logoHost?: string | null;
  /**
   * Path to one of OUR OWN cached logo assets (use `firstPartyLogoPath`),
   * e.g. `/logos/cache/<sha256>.png`. Preferred over `logoHost` when present:
   * it is the logo the registry curated, and the card reads it from the
   * Worker's ASSETS binding rather than guessing at a favicon.
   */
  logoPath?: string | null;
  /**
   * Health state ("ok" | "warn" | "down" | "unknown") — colours the card's
   * footer dot the way the site's health pill colours itself. Anything outside
   * that vocabulary is dropped by the renderer rather than guessed at.
   */
  status?: string | null;
  /**
   * Is this card about a NAMED THING (a subnet, a validator, an account) or
   * about one of OUR pages?
   *
   * Defaults to true, because until #8624 only entity routes called this. It
   * decides the avatar-slot fallback: an entity with no resolvable icon gets a
   * monogram ("TA" for tao.bot), one of our pages gets the Metagraphed mark.
   * Docs pass false -- "EC" for /docs/economics would be meaningless, and the
   * mark is the honest answer for a page that is ours.
   */
  entity?: boolean;
}

/**
 * Absolute /og URL carrying this page's card content.
 *
 * Only non-empty values are appended, so the card's own fallbacks apply
 * naturally and the URL stays short -- the endpoint refuses an over-long query
 * outright, and every param is bounded on both sides from OG_LIMITS.
 */
export function buildOgImageUrl(options: OgCardOptions): string {
  // Clamped HERE as well as in the renderer, from the same shared bounds. The
  // renderer truncates anyway, so an over-long value only ever bought a longer
  // URL -- and once the first-party logo path joined the query (#11204) that
  // slack was enough to push a legitimate card past the endpoint's own
  // MAX_QUERY_LENGTH, which answers 414 and unfurls with no image at all.
  const params = new URLSearchParams({
    title: clampText(options.title, OG_LIMITS.title),
    v: OG_CARD_VERSION,
  });
  const subtitle = clampText(options.subtitle, OG_LIMITS.subtitle);
  if (subtitle) params.set("subtitle", subtitle);
  const eyebrow = clampText(options.eyebrow, OG_LIMITS.eyebrow);
  if (eyebrow) params.set("eyebrow", eyebrow);
  if (options.logoPath) params.set("logop", options.logoPath);
  if (options.logoHost) params.set("logo", options.logoHost.slice(0, OG_LIMITS.logoHost));
  if (options.status) params.set("status", options.status);
  // The flag tells the renderer which fallback to use when there is no icon: a
  // monogram for a named thing, our mark for one of our own pages. "TA" is
  // right for tao.bot; the Metagraphed "M" is right for /docs/economics.
  // Defaults on, since every caller before #8624 was an entity route.
  if (options.entity ?? true) params.set("entity", "1");
  // Only the first three stats are rendered; sending more would just push the
  // URL toward the length cap for content the card ignores.
  (options.stats ?? []).slice(0, 3).forEach((stat, index) => {
    const label = clampText(stat.label, OG_LIMITS.statLabel);
    const value = clampText(stat.value, OG_LIMITS.statValue);
    // Both halves required, matching readCardParams: a value with no label is
    // unreadable, and a label with no value is an empty promise.
    if (!label || !value) return;
    params.set(`stat${index + 1}`, label);
    params.set(`stat${index + 1}v`, value);
  });
  return `${SITE_ORIGIN}/og?${params.toString()}`;
}

/**
 * Reduce whatever logo-ish value a route has to the bare HOST the card accepts.
 *
 * Routes hold full URLs (a subnet's `icon_url`/`website`, a validator
 * identity's `image`/`url`/`github`) but /og deliberately takes a hostname,
 * never a URL — see normalizeLogoHost in src/lib/og-image.ts for why. This
 * does that reduction in one place so each route doesn't hand-roll it.
 *
 * Candidates are tried in the same order the site's BrandIcon uses, so the
 * card resolves to the icon the page itself would show. Returns null when
 * nothing usable is present, and the card falls back to a monogram.
 */
export function logoHostFrom(
  ...candidates: Array<string | { light?: string; dark?: string } | null | undefined>
): string | null {
  for (const candidate of candidates) {
    const raw =
      typeof candidate === "string" ? candidate : (candidate?.dark ?? candidate?.light ?? null);
    if (!raw) continue;
    try {
      // Accept a bare host too, not just an absolute URL.
      const url = new URL(raw.includes("://") ? raw : `https://${raw}`);
      // OUR host is never an identity signal. The registry caches an entity's
      // logo at metagraph.sh/logos/cache/<sha>.<ext>, and reducing that to a
      // host asks the favicon proxy for METAGRAPHED's icon — so an entity that
      // has a curated logo would wear our mark, or (as today, since the proxy
      // has no icon for us) fall through to a monogram. Those URLs are handled
      // by firstPartyLogoPath instead; here they must not shadow the entity's
      // own website, which is the next-best identity we have.
      if (url.hostname && !isFirstPartyHost(url.hostname)) return url.hostname.toLowerCase();
    } catch {
      // Unparseable candidate — try the next one rather than failing the card.
    }
  }
  return null;
}

const SITE_HOST = new URL(SITE_ORIGIN).hostname.toLowerCase();

function isFirstPartyHost(hostname: string): boolean {
  return hostname.toLowerCase() === SITE_HOST;
}

/**
 * The two shapes the registry's own logo assets take: a subnet's
 * content-addressed cache entry, and a provider's slug.
 *
 * Mirrors `LOGO_ASSET_PATH` in src/lib/og-image.ts, which validates the param
 * again on the way in — /og is a public endpoint and must never trust a
 * caller, including us. The name charset excludes `.`, so `..` cannot be
 * spelled and the path can only ever name an image this repo ships.
 */
const LOGO_ASSET_PATH =
  /^\/logos\/(?:cache\/[0-9a-f]{64}|[a-z0-9][a-z0-9-]{0,62})\.(?:png|svg|jpg|jpeg|webp)$/;

/** The first candidate that is one of OUR OWN logo assets, as a path. */
export function firstPartyLogoPath(
  ...candidates: Array<string | { light?: string; dark?: string } | null | undefined>
): string | null {
  for (const candidate of candidates) {
    const raw =
      typeof candidate === "string" ? candidate : (candidate?.dark ?? candidate?.light ?? null);
    if (!raw) continue;
    try {
      const url = new URL(raw, SITE_ORIGIN);
      if (!isFirstPartyHost(url.hostname)) continue;
      if (LOGO_ASSET_PATH.test(url.pathname)) {
        return url.pathname;
      }
    } catch {
      // Unparseable candidate — try the next one.
    }
  }
  return null;
}

/**
 * Summarize per-endpoint probe verdicts into the card's one status dot.
 *
 * A SUMMARY of probe-derived counts, never a health judgement of our own: the
 * input is `endpoint_summary.by_status`, which the prober owns. All-ok counts
 * are ok; warning counts or mixed known verdicts are warn; only failed counts
 * are down. Missing or unknown evidence returns null and uses the brand dot.
 *
 * Lives here because this is where a route's data becomes card params, next to
 * logoHostFrom and firstPartyLogoPath.
 */
export function healthFromStatusCounts(
  byStatus: Record<string, number> | undefined | null,
): "ok" | "warn" | "down" | null {
  if (!byStatus) return null;
  let ok = 0;
  let total = 0;
  let warning = false;
  for (const [status, count] of Object.entries(byStatus)) {
    if (typeof count !== "number" || !Number.isFinite(count) || count <= 0) continue;
    if (!["ok", "warn", "degraded", "down", "failed"].includes(status)) return null;
    total += count;
    if (status === "ok") ok += count;
    if (status === "warn" || status === "degraded") warning = true;
  }
  if (total === 0) return null;
  if (ok === total) return "ok";
  return warning || ok > 0 ? "warn" : "down";
}

/** The og:image + twitter:image meta a route's head() returns. */
export function ogImageMeta(options: OgCardOptions) {
  const url = buildOgImageUrl(options);
  // #11204: og:image:alt was emitted ONLY by the server-injected card, so every
  // page that took ownership of its own card silently lost it -- all 129 subnet
  // pages, every validator, account, doc and news page. It is what a screen
  // reader announces for an unfurl and what several platforms show as the
  // caption, and the card's own copy is exactly the right text: it IS what the
  // image says. Built the same way server.ts builds its own.
  const alt = options.subtitle ? `${options.title} — ${options.subtitle}` : options.title;
  return [
    { property: "og:image", content: url },
    { property: "og:image:width", content: "1200" },
    { property: "og:image:height", content: "630" },
    { property: "og:image:alt", content: alt },
    { name: "twitter:image", content: url },
    { name: "twitter:image:alt", content: alt },
  ];
}

/**
 * Whether the route at `pathname` emits its own og:image in head().
 *
 * src/server.ts consults this and skips its global injection for these paths,
 * so a page never carries two og:image tags. Kept here, next to the routes'
 * own builder, rather than in server.ts -- the list belongs with the thing it
 * describes, and a route that starts emitting its own card should only have to
 * change one file.
 *
 * Matches the three entity detail routes that have real per-entity data to
 * put on a card. Everything else (home, docs, status, list pages) keeps the
 * server-injected brand-skinned fallback.
 */
export function routeOwnsOgImage(pathname: string): boolean {
  return (
    /^\/subnets\/[^/]+\/?$/.test(pathname) ||
    /^\/validators\/[^/]+\/?$/.test(pathname) ||
    /^\/accounts\/[^/]+\/?$/.test(pathname) ||
    // #11204: /providers/* too. All 138 provider pages were unfurling the
    // pathname-derived card -- the raw slug as a title ("404-gen"), no logo and
    // no numbers -- because server.ts builds that card from the URL alone. The
    // route has the provider's real name, its curated logo and its endpoint
    // counts in loaderData, and 102 of the 138 have a logo to show.
    /^\/providers\/[^/]+\/?$/.test(pathname) ||
    // #8624: /docs/* too. The docs splat route has the page's real title and
    // description in loaderData; server.ts, working from the pathname alone,
    // gave all 20 doc pages the identical brand card. Note this matches the
    // splat's CHILDREN only -- /docs itself has an OG_SECTIONS entry and keeps
    // the server-injected card.
    /^\/docs\/.+$/.test(pathname) ||
    // #8705: /news/* for the same reason. A weekly digest's whole value is
    // that it says something specific ("Subnet 104 - 2026-W29"), and these are
    // the pages the issue expects search and social to land on -- a shared
    // brand card would waste exactly the unfurl that matters most.
    /^\/news\/.+$/.test(pathname)
  );
}
