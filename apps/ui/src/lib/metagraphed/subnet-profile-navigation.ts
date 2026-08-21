/**
 * The intentional jobs on a subnet dossier. The route still accepts the old
 * data-domain tab names, but no incoming link is allowed to select a view that
 * no longer exists and leave the page blank.
 */
export const SUBNET_PROFILE_VIEWS = [
  "overview",
  "build",
  "research",
  "participate",
  "records",
] as const;

export type SubnetProfileView = (typeof SUBNET_PROFILE_VIEWS)[number];

/** The one resource lens that can be restored from an incoming build link. */
export const SUBNET_RESOURCE_SEGMENTS = ["endpoints", "surfaces", "schemas"] as const;

export type SubnetResourceSegment = (typeof SUBNET_RESOURCE_SEGMENTS)[number];

/**
 * A legacy tab is a public URL contract, not an implementation detail. Each
 * retired tab has one canonical job, optional focus anchor, and—where useful—
 * a selected resource lens. Route-level redirects use this table for both SSR
 * and client navigations, so an old bookmark never depends on an effect or
 * transient component state to reveal its intended content.
 */
export interface SubnetLegacyTabDestination {
  tab: SubnetProfileView;
  hash?: string;
  resource?: SubnetResourceSegment;
}

export const RETIRED_SUBNET_PROFILE_TABS = [
  "api",
  "endpoints",
  "surfaces",
  "schemas",
  "services",
  "economics",
  "validators",
  "metagraph",
  "activity",
  "governance",
  "about",
  "identity",
  "hyperparameters",
  "candidates",
  "gaps",
  "evidence",
] as const;

export type RetiredSubnetProfileTab = (typeof RETIRED_SUBNET_PROFILE_TABS)[number];

const LEGACY_TAB_DESTINATIONS: Record<RetiredSubnetProfileTab, SubnetLegacyTabDestination> = {
  api: { tab: "build", hash: "api" },
  endpoints: { tab: "build", hash: "resources", resource: "endpoints" },
  surfaces: { tab: "build", hash: "resources", resource: "surfaces" },
  schemas: { tab: "build", hash: "resources", resource: "schemas" },
  services: { tab: "build", hash: "services" },
  economics: { tab: "research", hash: "economics" },
  validators: { tab: "participate", hash: "validators" },
  metagraph: { tab: "records", hash: "metagraph" },
  activity: { tab: "records", hash: "activity" },
  governance: { tab: "records", hash: "governance-record-detail" },
  about: { tab: "records", hash: "profile" },
  identity: { tab: "records", hash: "identity" },
  hyperparameters: { tab: "records", hash: "hyperparameters" },
  candidates: { tab: "records", hash: "candidates" },
  gaps: { tab: "records", hash: "gaps" },
  evidence: { tab: "records", hash: "evidence" },
};

function normalizedSegment(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  return normalized || undefined;
}

function isRetiredSubnetProfileTab(value: string): value is RetiredSubnetProfileTab {
  return (RETIRED_SUBNET_PROFILE_TABS as readonly string[]).includes(value);
}

/** Normalize URL state at the route boundary, including previous tab names. */
export function normalizeSubnetProfileView(value: unknown): SubnetProfileView | undefined {
  const segment = normalizedSegment(value);
  if (!segment) return undefined;
  if ((SUBNET_PROFILE_VIEWS as readonly string[]).includes(segment)) {
    return segment as SubnetProfileView;
  }
  return isRetiredSubnetProfileTab(segment) ? LEGACY_TAB_DESTINATIONS[segment].tab : undefined;
}

export function normalizeSubnetResourceSegment(value: unknown): SubnetResourceSegment | undefined {
  const segment = normalizedSegment(value);
  return SUBNET_RESOURCE_SEGMENTS.find((candidate) => candidate === segment);
}

/**
 * Returns a redirect destination only for a retired tab. Current task names
 * intentionally return undefined so their URLs stay stable.
 */
export function legacySubnetProfileDestination(
  value: unknown,
): SubnetLegacyTabDestination | undefined {
  const segment = normalizedSegment(value);
  return segment && isRetiredSubnetProfileTab(segment)
    ? LEGACY_TAB_DESTINATIONS[segment]
    : undefined;
}

export interface SubnetProfileHashDestination {
  tab: SubnetProfileView;
  /** A legacy hash may intentionally resolve to a newer, consolidated anchor. */
  target?: string;
  /** Some anchors select a concrete resource lens as part of their destination. */
  search?: Readonly<Record<string, string>>;
}

/**
 * The resolved, modern location for an old tab or cross-view fragment. A
 * value is returned only when the URL must change; ordinary current URLs stay
 * entirely untouched.
 */
export interface CanonicalSubnetProfileDestination {
  tab: SubnetProfileView;
  hash?: string;
  resource?: SubnetResourceSegment;
  /** A resource lens belongs only to Build, so clear it when another job wins. */
  clearResource: boolean;
}

/**
 * One typed registry for every cross-view anchor. Keeping it next to URL
 * normalization makes removed tabs, broken hashes, and blank bodies testable.
 */
export const SUBNET_PROFILE_SECTIONS: Record<string, SubnetProfileHashDestination> = {
  "start-integrating": { tab: "build" },
  "uptime-90d": { tab: "build" },
  "endpoints-glance": {
    tab: "build",
    target: "resources",
    search: { resource: "endpoints" },
  },
  endpoints: { tab: "build", target: "resources", search: { resource: "endpoints" } },
  surfaces: { tab: "build", target: "resources", search: { resource: "surfaces" } },
  schemas: { tab: "build", target: "resources", search: { resource: "schemas" } },
  "schema-drift": { tab: "build", target: "resources", search: { resource: "schemas" } },
  "health-trends": { tab: "build", target: "health-trends" },
  operational: { tab: "build", target: "health-trends" },
  resources: { tab: "build" },
  reliability: { tab: "build", target: "reliability" },
  services: { tab: "build", target: "services" },
  "agent-readiness": { tab: "build", target: "services" },
  api: { tab: "build", target: "api" },
  incidents: { tab: "build", target: "incidents" },

  ohlc: { tab: "research" },
  economics: { tab: "research" },
  "revenue-coverage": { tab: "research", target: "revenue-coverage" },
  "money-map": { tab: "research", target: "money-map" },
  "emission-pipeline": { tab: "research", target: "emission-detail" },
  "volume-24h": { tab: "research", target: "volume-24h" },
  "stake-quote": { tab: "research", target: "stake-quote" },

  validators: { tab: "participate", target: "validator-detail" },
  "validator-set": { tab: "participate", target: "validator-detail" },
  weights: { tab: "participate", target: "validator-detail" },
  concentration: { tab: "participate", target: "concentration" },
  yield: { tab: "participate", target: "yield" },
  turnover: { tab: "participate", target: "turnover" },

  metagraph: { tab: "records", target: "metagraph" },
  neuron: { tab: "records", target: "neuron" },
  holders: { tab: "records", target: "holders" },
  history: { tab: "records", target: "history" },
  "recent-activity": { tab: "overview" },
  "registry-activity": { tab: "records", target: "registry-activity" },
  activity: { tab: "records", target: "activity" },
  governance: { tab: "records", target: "governance-record-detail" },
  conviction: { tab: "records", target: "conviction" },
  "ownership-history": { tab: "records", target: "ownership-history" },
  lifecycle: { tab: "records", target: "lifecycle" },
  "pipeline-history": { tab: "records", target: "pipeline-history" },
  "surface-history": { tab: "records", target: "surface-history" },
  lease: { tab: "records", target: "lease" },
  hyperparameters: { tab: "records", target: "hyperparameters" },
  "hyperparameters-history": { tab: "records", target: "hyperparameters-history" },
  about: { tab: "records", target: "profile" },
  profile: { tab: "records", target: "profile" },
  identity: { tab: "records", target: "identity" },
  lineage: { tab: "records", target: "lineage" },
  evidence: { tab: "records", target: "evidence" },
  "evidence-preview": { tab: "records", target: "evidence" },
  gaps: { tab: "records", target: "gaps" },
  candidates: { tab: "records", target: "candidates" },
  watch: { tab: "records", target: "profile-tools-detail" },
  alerts: { tab: "records", target: "profile-tools-detail" },

  // Canonical disclosure anchors: they are valid direct destinations too,
  // and registering them lets useHashScroll reveal the closed record on an
  // initial load as well as after an in-app route transition.
  "operational-detail": { tab: "build" },
  "build-artifacts-detail": { tab: "build" },
  "market-detail": { tab: "research" },
  "emission-detail": { tab: "research" },
  "validator-detail": { tab: "participate" },
  "participation-detail": { tab: "participate" },
  "activity-record-detail": { tab: "records" },
  "metagraph-record-detail": { tab: "records" },
  "governance-record-detail": { tab: "records" },
  "profile-record-detail": { tab: "records" },
  "profile-tools-detail": { tab: "records" },
};

/**
 * Resolve a public profile URL to the one modern dossier destination. This is
 * deliberately pure so the router, pre-hydration browser redirect, and tests
 * share one decision model instead of each reinventing old-link behaviour.
 *
 * A fragment is always more specific than a retired tab. For example,
 * `?tab=api#evidence` means "show the evidence record", not "open API".
 */
export function canonicalSubnetProfileDestination(
  search: Readonly<{
    tab?: string;
    resource?: SubnetResourceSegment;
    uid?: number;
  }>,
  hash: string,
): CanonicalSubnetProfileDestination | undefined {
  const legacyTab = legacySubnetProfileDestination(search.tab);
  const incomingHash = hash.replace(/^#/, "");
  const legacyDefaultHash =
    legacyTab?.hash === "metagraph" && search.uid != null ? "neuron" : legacyTab?.hash;
  const requestedHash = incomingHash || legacyDefaultHash;
  // A neuron can only be selected with a valid UID. Bare historic links still
  // reveal the stable metagraph record rather than focusing an absent node.
  const resolvedHash = requestedHash === "neuron" && search.uid == null ? "metagraph" : requestedHash;
  const hashDestination = resolvedHash ? SUBNET_PROFILE_SECTIONS[resolvedHash] : undefined;
  const tab = hashDestination?.tab ?? legacyTab?.tab;
  if (!tab) return undefined;

  // A resource tab's own default `#resources` preserves its selected lens;
  // a different explicit fragment (for example `?tab=surfaces#evidence`)
  // intentionally switches jobs and must not carry Build-only state along.
  const usesLegacyDefault = !incomingHash || incomingHash === legacyDefaultHash;
  const resource = normalizeSubnetResourceSegment(
    hashDestination?.search?.resource ?? (usesLegacyDefault ? legacyTab?.resource : undefined),
  );
  const clearResource = tab !== "build" && search.resource != null;
  const canonicalHash = hashDestination?.target ?? resolvedHash;
  const searchNeedsCanonicalization =
    search.tab !== tab ||
    (resource != null && search.resource !== resource) ||
    clearResource;
  const hashNeedsCanonicalization = (canonicalHash ?? "") !== incomingHash;
  if (!searchNeedsCanonicalization && !hashNeedsCanonicalization) return undefined;

  return {
    tab,
    ...(canonicalHash ? { hash: canonicalHash } : {}),
    ...(resource ? { resource } : {}),
    clearResource,
  };
}

/**
 * Fragments are intentionally omitted from HTTP requests. When an old
 * bookmark includes one, a server-side 301 cannot distinguish
 * `?tab=api` from `?tab=api#evidence` without destroying the reader's more
 * specific request. This tiny route-owned bootstrap runs in the document head
 * before the page paints, makes the exact same typed conversion as the router,
 * and replaces the history entry. It is not component fallback state and it
 * never runs for current URLs.
 */
export function subnetProfileCanonicalizationScript(): string {
  const legacyTabs = JSON.stringify(LEGACY_TAB_DESTINATIONS).replaceAll("<", "\\u003c");
  const sections = JSON.stringify(SUBNET_PROFILE_SECTIONS).replaceAll("<", "\\u003c");

  return `(() => {
  const url = new URL(window.location.href);
  const legacyTabs = ${legacyTabs};
  const sections = ${sections};
  const tab = (url.searchParams.get("tab") || "").trim().toLowerCase();
  const legacy = legacyTabs[tab];
  if (!legacy) return;
  let incomingHash = url.hash.slice(1);
  try { incomingHash = decodeURIComponent(incomingHash); } catch { /* leave malformed fragments alone */ }
  const uid = Number(url.searchParams.get("uid"));
  const hasUid = Number.isInteger(uid) && uid >= 0;
  const legacyDefaultHash = legacy.hash === "metagraph" && hasUid ? "neuron" : legacy.hash;
  const requestedHash = incomingHash || legacyDefaultHash;
  const resolvedHash = requestedHash === "neuron" && !hasUid ? "metagraph" : requestedHash;
  const destination = sections[resolvedHash];
  const nextTab = (destination && destination.tab) || legacy.tab;
  const nextHash = (destination && destination.target) || resolvedHash;
  const usesLegacyDefault = !incomingHash || incomingHash === legacyDefaultHash;
  const nextResource =
    (destination && destination.search && destination.search.resource) ||
    (usesLegacyDefault && legacy.resource);
  const currentResource = url.searchParams.get("resource");
  const shouldClearResource = nextTab !== "build" && currentResource !== null;
  const needsRewrite =
    tab !== nextTab ||
    (nextResource && currentResource !== nextResource) ||
    shouldClearResource ||
    incomingHash !== nextHash;
  if (!needsRewrite) return;
  url.searchParams.set("tab", nextTab);
  if (nextResource) url.searchParams.set("resource", nextResource);
  else if (shouldClearResource) url.searchParams.delete("resource");
  url.hash = nextHash ? "#" + nextHash : "";
  window.location.replace(url.pathname + url.search + url.hash);
})();`;
}
