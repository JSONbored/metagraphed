/**
 * Curated, hand-picked icon overrides for well-known providers and subnets.
 *
 * These take priority over the auto favicon chain in `<BrandIcon>`. Prefer
 * high-resolution sources (apple-touch-icon, SVG, or GitHub org avatar at
 * size >= 128). If a URL stops resolving the multi-source fallback still
 * delivers a usable icon, so this map can grow organically.
 *
 * Keys are case-insensitive. Provider slugs match the API's `id`/`slug`,
 * subnet keys can be either the numeric netuid (as a string) or the subnet
 * slug.
 */

export interface BrandOverrideLookup {
  providerSlug?: string | null;
  subnetSlug?: string | null;
  netuid?: number | string | null;
}

// Use GitHub org avatars (always crisp, CDN-served, retina-friendly) where
// available; otherwise apple-touch-icon from the project's own domain.
const PROVIDER_ICONS: Record<string, string> = {
  // Subnet teams with strong GH org presence
  bitmind: "https://github.com/BitMind-AI.png?size=192",
  chutes: "https://github.com/chutesai.png?size=192",
  "compute-horde": "https://github.com/backend-developers-ltd.png?size=192",
  desearch: "https://github.com/Desearch-ai.png?size=192",
  macrocosmos: "https://github.com/macrocosm-os.png?size=192",
  taostats: "https://github.com/taostats.png?size=192",
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

// Numeric netuid → icon URL. Use when the subnet has a curated logo distinct
// from its primary provider's avatar, or when the subnet has no provider link.
const SUBNET_ICONS_BY_NETUID: Record<string, string> = {
  // Root chain
  "0": "https://github.com/opentensor.png?size=192",
};

// Subnet slug → icon URL (lowercase). Falls through to provider lookup.
const SUBNET_ICONS_BY_SLUG: Record<string, string> = {};

function normaliseKey(value: string | number | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const str = String(value).trim().toLowerCase();
  return str || null;
}

export function resolveBrandOverride(
  lookup: BrandOverrideLookup,
): string | null {
  const providerKey = normaliseKey(lookup.providerSlug);
  if (providerKey && PROVIDER_ICONS[providerKey]) {
    return PROVIDER_ICONS[providerKey];
  }
  const netuidKey = normaliseKey(lookup.netuid);
  if (netuidKey && SUBNET_ICONS_BY_NETUID[netuidKey]) {
    return SUBNET_ICONS_BY_NETUID[netuidKey];
  }
  const subnetKey = normaliseKey(lookup.subnetSlug);
  if (subnetKey && SUBNET_ICONS_BY_SLUG[subnetKey]) {
    return SUBNET_ICONS_BY_SLUG[subnetKey];
  }
  // Subnets sometimes share a slug with their provider — try that too.
  if (subnetKey && PROVIDER_ICONS[subnetKey]) {
    return PROVIDER_ICONS[subnetKey];
  }
  return null;
}
