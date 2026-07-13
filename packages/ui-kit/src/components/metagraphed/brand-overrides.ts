/**
 * Brand icon resolution — single source of truth.
 *
 * Priority chain used by `<BrandIcon>` (top wins, falls through on miss/error):
 *
 *   1. `iconUrl` from API (per-entry, registry-controlled). Either a string or
 *      `{ light, dark? }`.
 *   2. Curated frontend overrides defined below.
 *   3. Icon proxy at `VITE_ICON_PROXY_URL` (when configured). See contract.
 *   4. GitHub org avatar derived from a `repo` URL.
 *   5. Monogram tile.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *  ICON PROXY CONTRACT (backend owns the implementation, lives outside this repo)
 *
 *    GET {VITE_ICON_PROXY_URL}?host={domain}&size={px}&theme={light|dark}
 *
 *    - Frontend only sends validated public http/https domains. Backend must
 *      independently reject localhost, IP literals, private/reserved DNS
 *      results, redirects to unsafe targets, and abusive request rates.
 *    - Returns 200 with image/png or image/svg+xml; payload MUST be square
 *      and have width/height >= `size` (we reject anything smaller).
 *    - Returns 404 when no usable source can be resolved.
 *    - Should set `Cache-Control: public, max-age=2592000, immutable` and
 *      support ETag/If-None-Match.
 *    - `theme` is advisory; backend may serve a dark variant when one exists.
 *    - `size` is a hint; serve >= size and ideally <= 2 × size.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Override values can be either a string (light = dark) or
 * `{ light, dark? }`. Use the object form when you have a dedicated
 * dark-mode logo; otherwise the same asset is rendered in both themes and
 * `<BrandIcon>` will apply an auto-contrast tile if the logo is dark-on-light.
 */

import type { ResolvedTheme } from "@/lib/theme";

export type IconSource = string | { light: string; dark?: string };

export interface BrandOverrideLookup {
  providerSlug?: string | null;
  subnetSlug?: string | null;
  netuid?: number | string | null;
}

/**
 * Public proxy base URL. Defaults to the production backend favicon proxy
 * (src/icon-proxy.mjs in metagraphed) so brand icons resolve out-of-the-box;
 * override with VITE_ICON_PROXY_URL for local/staging. Read defensively
 * (not `import.meta.env` directly) -- unlike apps/ui, this package doesn't
 * assume its consumer is Vite, and `import.meta.env` isn't universally
 * defined at runtime outside a Vite-processed module.
 */
const viteEnv = (import.meta as { env?: Record<string, string | undefined> })
  .env;
export const ICON_PROXY_URL: string | null =
  viteEnv?.VITE_ICON_PROXY_URL?.trim() ||
  "https://api.metagraph.sh/api/v1/icon";

const BLOCKED_PROXY_TLDS = new Set(["localhost", "local", "internal"]);

export function isIpLiteral(host: string): boolean {
  if (host.startsWith("[") && host.endsWith("]")) return true;
  if (host.includes(":")) return true;
  const parts = host.split(".");
  if (parts.length !== 4 || parts.some((p) => !/^\d+$/.test(p))) return false;
  return parts.every((p) => {
    const n = Number(p);
    return Number.isInteger(n) && n >= 0 && n <= 255;
  });
}

/**
 * Normalise + validate a hostname before forwarding it to the icon proxy.
 * The frontend only sends public-looking DNS names; the proxy service must
 * still independently enforce DNS resolution checks, private-IP filtering,
 * redirects, and rate limits before fetching remote icons.
 */
export function normalizePublicProxyHost(
  host: string | null | undefined,
): string | null {
  const normalized = String(host ?? "")
    .trim()
    .toLowerCase()
    .replace(/^www\./, "")
    .replace(/\.$/, "");
  if (!normalized || normalized.length > 253) return null;
  if (isIpLiteral(normalized)) return null;
  const labels = normalized.split(".");
  if (labels.length < 2) return null;
  const tld = labels[labels.length - 1];
  if (!tld || BLOCKED_PROXY_TLDS.has(tld)) return null;
  const ok = labels.every(
    (l) =>
      l.length > 0 &&
      l.length <= 63 &&
      /^[a-z0-9-]+$/.test(l) &&
      !l.startsWith("-") &&
      !l.endsWith("-"),
  );
  return ok ? normalized : null;
}

export function buildProxyIconUrl(
  host: string,
  size: number,
  theme: ResolvedTheme = "light",
): string | null {
  if (!ICON_PROXY_URL) return null;
  const safeHost = normalizePublicProxyHost(host);
  if (!safeHost) return null;
  const u = new URL(ICON_PROXY_URL);
  u.searchParams.set("host", safeHost);
  u.searchParams.set("size", String(size));
  u.searchParams.set("theme", theme);
  return u.toString();
}

/** Picks the right URL for the current theme out of an IconSource. */
export function pickIconSource(
  src: IconSource | null | undefined,
  theme: ResolvedTheme,
): string | null {
  if (!src) return null;
  if (typeof src === "string") return src;
  if (theme === "dark" && src.dark) return src.dark;
  return src.light;
}

// Use GitHub org avatars (always crisp, CDN-served, retina-friendly) where
// available; otherwise apple-touch-icon from the project's own domain.
const PROVIDER_ICONS: Record<string, IconSource> = {
  // Subnet teams with strong GH org presence
  bitmind: "https://github.com/BitMind-AI.png?size=192",
  chutes: "https://github.com/chutesai.png?size=192",
  "compute-horde": "https://github.com/backend-developers-ltd.png?size=192",
  desearch: "https://github.com/Desearch-ai.png?size=192",
  macrocosmos: "https://github.com/macrocosm-os.png?size=192",
  taostats: {
    light: "https://github.com/taostats.png?size=192",
    dark: "https://github.com/taostats.png?size=192",
  },
  tensorplex: "https://github.com/tensorplex-labs.png?size=192",
  datura: "https://github.com/Datura-ai.png?size=192",
  nineteen: "https://github.com/namoray.png?size=192",
  corcel: "https://github.com/corcel-api.png?size=192",
  targon: "https://github.com/manifold-inc.png?size=192",
  manifold: "https://github.com/manifold-inc.png?size=192",
  "cortex-t": "https://github.com/corcel-api.png?size=192",
  allways: "https://github.com/allways-ai.png?size=192",
  gittensor: "https://github.com/eden-network.png?size=192",
  bitads: "https://github.com/FirstTensorLabs.png?size=192",
  academia: "https://github.com/fx-integral.png?size=192",
  adtao: "https://github.com/ippcteam.png?size=192",
  bitrecs: "https://github.com/bitrecs.png?size=192",
  cacheon: "https://github.com/latent-to.png?size=192",
  chipforge: "https://github.com/TatsuProject.png?size=192",
  coldint: "https://github.com/coldint.png?size=192",
  compelle: "https://github.com/compelle.png?size=192",
  connito: "https://github.com/Connito-AI.png?size=192",
  djinn: "https://github.com/Djinn-Inc.png?size=192",

  // Infra / data providers
  dwellir: "https://github.com/Dwellir.png?size=192",
  blockmachine: "https://github.com/blockmachine-io.png?size=192",
  "opentensor-foundation": "https://github.com/opentensor.png?size=192",
  opentensor: "https://github.com/opentensor.png?size=192",
  bittensor: "https://github.com/opentensor.png?size=192",
};

const SUBNET_ICONS_BY_NETUID: Record<string, IconSource> = {
  "0": "https://github.com/opentensor.png?size=192",
};

const SUBNET_ICONS_BY_SLUG: Record<string, IconSource> = {};

function normaliseKey(
  value: string | number | null | undefined,
): string | null {
  if (value === null || value === undefined) return null;
  const str = String(value).trim().toLowerCase();
  return str || null;
}

/**
 * Look up a curated override for a provider/subnet. Returns the URL
 * appropriate to the active theme (dark variant if defined, else light).
 */
export function resolveBrandOverride(
  lookup: BrandOverrideLookup,
  theme: ResolvedTheme = "light",
): string | null {
  const providerKey = normaliseKey(lookup.providerSlug);
  if (providerKey && PROVIDER_ICONS[providerKey]) {
    return pickIconSource(PROVIDER_ICONS[providerKey], theme);
  }
  const netuidKey = normaliseKey(lookup.netuid);
  if (netuidKey && SUBNET_ICONS_BY_NETUID[netuidKey]) {
    return pickIconSource(SUBNET_ICONS_BY_NETUID[netuidKey], theme);
  }
  const subnetKey = normaliseKey(lookup.subnetSlug);
  if (subnetKey && SUBNET_ICONS_BY_SLUG[subnetKey]) {
    return pickIconSource(SUBNET_ICONS_BY_SLUG[subnetKey], theme);
  }
  // A subnet slug can also match a provider-icon key (e.g. a team that runs the
  // subnet); fall back to that before giving up.
  if (subnetKey && PROVIDER_ICONS[subnetKey]) {
    return pickIconSource(PROVIDER_ICONS[subnetKey], theme);
  }
  return null;
}
