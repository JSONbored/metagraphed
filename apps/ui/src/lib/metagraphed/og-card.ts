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

const SITE_ORIGIN = "https://metagraph.sh";

/** One "LABEL / value" cell in the card's stat rail. Max two are rendered. */
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
 * naturally and the URL stays short -- the endpoint rejects a query over
 * MAX_QUERY_LENGTH (512), and every param here is additionally length-bounded
 * on the render side.
 */
export function buildOgImageUrl(options: OgCardOptions): string {
  const params = new URLSearchParams({ title: options.title });
  if (options.subtitle) params.set("subtitle", options.subtitle);
  if (options.eyebrow) params.set("eyebrow", options.eyebrow);
  if (options.logoHost) params.set("logo", options.logoHost);
  if (options.status) params.set("status", options.status);
  // The flag tells the renderer which fallback to use when there is no icon: a
  // monogram for a named thing, our mark for one of our own pages. "TA" is
  // right for tao.bot; the Metagraphed "M" is right for /docs/economics.
  // Defaults on, since every caller before #8624 was an entity route.
  if (options.entity ?? true) params.set("entity", "1");
  // Only the first three stats are rendered; sending more would just push the
  // URL toward the length cap for content the card ignores.
  (options.stats ?? []).slice(0, 3).forEach((stat, index) => {
    if (!stat.label || !stat.value) return;
    params.set(`stat${index + 1}`, stat.label);
    params.set(`stat${index + 1}v`, stat.value);
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
      if (url.hostname) return url.hostname.toLowerCase();
    } catch {
      // Unparseable candidate — try the next one rather than failing the card.
    }
  }
  return null;
}

/** The og:image + twitter:image meta a route's head() returns. */
export function ogImageMeta(options: OgCardOptions) {
  const url = buildOgImageUrl(options);
  return [
    { property: "og:image", content: url },
    { property: "og:image:width", content: "1200" },
    { property: "og:image:height", content: "630" },
    { name: "twitter:image", content: url },
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
    // #8624: /docs/* too. The docs splat route has the page's real title and
    // description in loaderData; server.ts, working from the pathname alone,
    // gave all 20 doc pages the identical brand card. Note this matches the
    // splat's CHILDREN only -- /docs itself has an OG_SECTIONS entry and keeps
    // the server-injected card.
    /^\/docs\/.+$/.test(pathname)
  );
}
