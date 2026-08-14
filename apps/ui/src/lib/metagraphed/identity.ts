/**
 * Where this project lives publicly, in one place (#11204).
 *
 * Every value here was copy-pasted across several modules before — the two
 * origins across six (server.ts, og-card.ts, uptime-badge-embed.tsx,
 * agent-resource-grid.tsx, config.ts and the JSON-LD builders), the repo URL
 * across three, the X handle across two. That is how one copy ends up stale
 * after a domain or handle change and starts emitting canonical URLs, OG
 * images, `sameAs` claims or card attribution pointing somewhere that no longer
 * answers — and structured data that names the wrong account is an identity
 * claim about someone else.
 *
 * Deliberately dependency-free: the Cloudflare Worker entry, a client-bundled
 * route and React components all import this, so it must pull in nothing that
 * exists on only one of those sides.
 */

/** The human-facing site (the apex). Canonical URLs and OG images live here. */
export const SITE_ORIGIN = "https://metagraph.sh";

/**
 * The API + artifact host.
 *
 * NOT the same thing as the client's configured API base: `config.ts` lets a
 * developer point the app at a local Worker, and this is the production default
 * it falls back to. Anything that must name the canonical host regardless of
 * that override — a redirect target, a discovery Link header — uses this.
 */
export const API_ORIGIN = "https://api.metagraph.sh";

/** The public source repository. */
export const GITHUB_REPO_URL = "https://github.com/JSONbored/metagraphed";

/** The X account, as the handle a card attributes to. */
export const X_HANDLE = "@metagraphed";

/**
 * The same account as a profile URL, derived rather than restated so the two
 * forms cannot disagree — a `sameAs` pointing at one account while the card
 * attributes another is exactly the drift this module exists to stop.
 */
export const X_PROFILE_URL = `https://x.com/${X_HANDLE.replace(/^@/, "")}`;
