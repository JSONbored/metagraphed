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
 *   5. DuckDuckGo icons service.
 *   6. Google S2 favicons at sz=128.
 *   7. Monogram tile.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *  ICON PROXY CONTRACT (backend owns the implementation, lives outside this repo)
 *
 *    GET {VITE_ICON_PROXY_URL}?host={domain}&size={px}&theme={light|dark}
 *
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

/** Public proxy base URL, e.g. "https://metagraph.sh/api/v1/icon". */
export const ICON_PROXY_URL: string | null =
  (import.meta.env.VITE_ICON_PROXY_URL as string | undefined)?.trim() || null;

export function buildProxyIconUrl(
  host: string,
  size: number,
  theme: ResolvedTheme = "light",
): string | null {
  if (!ICON_PROXY_URL) return null;
  const u = new URL(ICON_PROXY_URL);
  u.searchParams.set("host", host);
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

function normaliseKey(value: string | number | null | undefined): string | null {
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
  if (subnetKey && PROVIDER_ICONS[subnetKey]) {
    return pickIconSource(PROVIDER_ICONS[subnetKey], theme);
  }
  return null;
}
