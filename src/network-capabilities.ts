// Per-network capability matrix (#8699).
//
// 105 of our 188 routes 404 under a network prefix. The 404 body is honest —
// "{path} is only available on mainnet, not the testnet network" — but it is
// discoverable only by making the request and failing.
//
// That matters more here than on a typical API because our primary consumer is
// an AGENT. An agent planning a multi-step task cannot plan around a capability
// it can only discover by tripping over it, and a mid-plan 404 reads as a
// broken tool rather than an unsupported network. This module makes the absence
// of data legible in advance.
//
// It adds no data and moves no boundary itself — it states where the boundary
// currently is. #8700 moved that boundary for the first time, taking the live
// chain-storage routes off the mainnet-only side, and this matrix followed
// automatically because it is derived: the only change needed here was
// teaching it that a route can be served without publishing an artifact.
//
// ── DERIVED, NEVER HAND-MAINTAINED ─────────────────────────────────────────
//
// The served/unserved split comes from the same MAINNET_ONLY_ROUTE_PATHS the
// spec annotation uses, which #8698 proved against the router's own predicate
// in both directions. A hand-written matrix would drift the first time someone
// edited that predicate, and a WRONG capability matrix is worse than none: it
// makes an agent confidently plan a call that 404s. So nothing here is typed by
// hand — the families are computed from the route table, and the tests assert
// the result against real requests rather than a fixture.

/** A group of routes an agent reasons about as one capability. */
export interface RouteFamily {
  /** Family key, e.g. "chain" — the first meaningful path segment. */
  family: string;
  /** How many routes are in it. */
  route_count: number;
  /** Example path, so a reader can see what the family means. */
  example: string;
}

export interface NetworkCapability {
  id: string;
  chain: string;
  aliases: string[];
  is_default: boolean;
  /** True when this network hosts registry data at all. */
  serves_data: boolean;
  served_families: RouteFamily[];
  unserved_families: RouteFamily[];
  /** Families where some routes serve and some do not — the honest middle. */
  partial_families: RouteFamily[];
  note: string | null;
}

/**
 * The family a route template belongs to.
 *
 * The first path segment after `/api/v1`, with two deliberate exceptions:
 * a bare `/api/v1/x` route is its own family, and `subnets/{netuid}/...` stays
 * under `subnets` rather than fragmenting into one family per sub-resource —
 * an agent asks "is subnet data available", not "is subnet-concentration-
 * history available".
 */
export function routeFamily(path: string): string | null {
  if (!path.startsWith("/api/v1")) return null;
  const rest = path.slice("/api/v1".length).replace(/^\//, "");
  if (rest === "") return "root";
  const first = rest.split("/")[0];
  return first.startsWith("{") ? "root" : first;
}

interface RouteLike {
  path: string;
}

/**
 * Group routes into families, keeping the shortest path as the example.
 *
 * Shortest rather than first, so the example is the most recognisable member
 * (`/api/v1/chain/calls`, not `/api/v1/chain/weights/setters`).
 */
function familiesOf(routes: readonly RouteLike[]): RouteFamily[] {
  const byFamily = new Map<string, { count: number; example: string }>();
  for (const route of routes) {
    const family = routeFamily(route?.path ?? "");
    if (!family) continue;
    const existing = byFamily.get(family);
    if (!existing) {
      byFamily.set(family, { count: 1, example: route.path });
      continue;
    }
    existing.count += 1;
    if (route.path.length < existing.example.length) {
      existing.example = route.path;
    }
  }
  return [...byFamily.entries()]
    .map(([family, value]) => ({
      family,
      route_count: value.count,
      example: value.example,
    }))
    .sort((a, b) => a.family.localeCompare(b.family));
}

/**
 * Build the matrix for every network.
 *
 * `isMainnetOnly` is injected rather than imported so this module stays free of
 * the Worker's route table and the caller supplies the one authority — the same
 * predicate #8698 exported. Passing a different predicate changes the output,
 * which is what the derivation test exploits.
 */
export function buildNetworkCapabilities(input: {
  routes: readonly (RouteLike & { artifact_path?: string })[];
  networks: Readonly<
    Record<
      string,
      { id: string; chain: string; prefix: string; isDefault: boolean }
    >
  >;
  isMainnetOnly: (path: string) => boolean;
  /**
   * Artifact paths the build publishes for non-default networks.
   *
   * The second half of the availability rule. Without it the matrix
   * over-promises: a route can be perfectly network-addressable and still 404
   * because nothing ever wrote its testnet artifact.
   */
  publishedArtifacts: readonly string[];
  /**
   * Route templates answered from live chain storage instead of an artifact.
   *
   * The third term in the availability rule (#8700). These routes publish no
   * artifact — they read `state_getStorage` at request time — so testing them
   * against `publishedArtifacts` alone reports them unserved while the router
   * answers them 200. Under-reporting is as harmful here as over-reporting:
   * this document is how an agent decides a route is not worth calling.
   */
  liveChainRoutes?: readonly string[];
  localNote?: string;
}): NetworkCapability[] {
  const { routes, networks, isMainnetOnly } = input;
  const published = new Set(input.publishedArtifacts);
  const liveChain = new Set(input.liveChainRoutes ?? []);
  const servesOffMainnet = (route: RouteLike & { artifact_path?: string }) =>
    !isMainnetOnly(route.path) &&
    (published.has(route.artifact_path ?? "") || liveChain.has(route.path));
  const mainnetOnly = routes.filter((route) => !servesOffMainnet(route));
  const universal = routes.filter(servesOffMainnet);

  // Aliases collapse onto their canonical id: `finney` and `mainnet` are one
  // network reported once, with both spellings listed.
  const byId = new Map<
    string,
    { id: string; chain: string; aliases: string[]; isDefault: boolean }
  >();
  for (const [alias, network] of Object.entries(networks)) {
    const existing = byId.get(network.id);
    if (existing) {
      existing.aliases.push(alias);
      continue;
    }
    byId.set(network.id, {
      id: network.id,
      chain: network.chain,
      aliases: [alias],
      isDefault: network.isDefault,
    });
  }

  const universalFamilies = familiesOf(universal);
  const mainnetOnlyFamilies = familiesOf(mainnetOnly);
  // A family can appear in both lists — `subnets` serves most routes off
  // mainnet but not `subnets/{netuid}/health`. Reporting it as simply "served"
  // would send an agent into the exact 404 this exists to prevent, so it is
  // reported as partial.
  const partialKeys = new Set(
    universalFamilies
      .map((entry) => entry.family)
      .filter((family) =>
        mainnetOnlyFamilies.some((entry) => entry.family === family),
      ),
  );

  return [...byId.values()].map((network) => {
    const isLocal = network.id === "local";
    const isMainnet = network.isDefault;
    if (isLocal) {
      // Local hosts nothing: it is a per-developer node we cannot reach.
      // Reporting families for it would be describing a registry that does not
      // exist rather than one that is merely incomplete.
      return {
        id: network.id,
        chain: network.chain,
        aliases: network.aliases.sort(),
        is_default: false,
        serves_data: false,
        served_families: [],
        unserved_families: familiesOf(routes),
        partial_families: [],
        note:
          input.localNote ??
          "Local is a subnet chain you run yourself — metagraphed hosts no registry data for it. Point your SDK at your own node and use mainnet or testnet here as the reference registry.",
      };
    }
    if (isMainnet) {
      return {
        id: network.id,
        chain: network.chain,
        aliases: network.aliases.sort(),
        is_default: true,
        serves_data: true,
        served_families: familiesOf(routes),
        unserved_families: [],
        partial_families: [],
        note: null,
      };
    }
    return {
      id: network.id,
      chain: network.chain,
      aliases: network.aliases.sort(),
      is_default: false,
      serves_data: true,
      served_families: universalFamilies.filter(
        (entry) => !partialKeys.has(entry.family),
      ),
      unserved_families: mainnetOnlyFamilies.filter(
        (entry) => !partialKeys.has(entry.family),
      ),
      partial_families: universalFamilies.filter((entry) =>
        partialKeys.has(entry.family),
      ),
      // Accurate as of #8700, and deliberately specific about WHICH kind of
      // chain data is missing. The previous wording said registry data
      // including "surfaces" was served on every network, which was wrong --
      // /api/v1/testnet/surfaces has always 404'd, because the testnet build
      // emits native-chain registry artifacts only, not curated ones.
      note: "Live chain state (burn, balances, network parameters, sudo key, crowdloans) is read from this network's own RPC and served here. Indexed chain HISTORY -- blocks, extrinsics, events and the analytics built on them -- is indexed for mainnet only, so those families and the curated-registry families (surfaces, profiles, endpoints, health) are unavailable.",
    };
  });
}

/** The response body for GET /api/v1/networks. */
export function buildNetworksPayload(input: {
  routes: readonly (RouteLike & { artifact_path?: string })[];
  networks: Readonly<
    Record<
      string,
      { id: string; chain: string; prefix: string; isDefault: boolean }
    >
  >;
  isMainnetOnly: (path: string) => boolean;
  publishedArtifacts: readonly string[];
  liveChainRoutes?: readonly string[];
}): {
  schema_version: 1;
  default_network: string;
  path_form: string;
  network_count: number;
  networks: NetworkCapability[];
} {
  const networks = buildNetworkCapabilities(input);
  return {
    schema_version: 1,
    default_network:
      networks.find((network) => network.is_default)?.id ?? "mainnet",
    path_form: "/api/v1/{network}/...",
    network_count: networks.length,
    networks,
  };
}
