// Metagraphed API client config.
//
// Two independent runtime dimensions, both persisted to localStorage:
//   1. API base (origin) — which Worker the app talks to. Defaults to the
//      production API subdomain api.metagraph.sh; overridable for dev.
//   2. Chain network — which Bittensor network's DATA to show. The client
//      prepends `/{prefix}/` to /api/v1 + /metagraph paths (mainnet = no prefix,
//      testnet = /testnet/). Same origin, different data partition.

const env = (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env;

// ─── API base (origin) ───────────────────────────────────────────────────────

const STORAGE_KEY = "metagraphed:api-base";
const EVT = "metagraphed:api-base-changed";

export const DEFAULT_API_BASE = (
  env?.VITE_METAGRAPH_API_BASE ||
  env?.VITE_METAGRAPHED_API_BASE ||
  "https://api.metagraph.sh"
).replace(/\/$/, "");

let cached: string | null = null;

/**
 * An API base must be an http(s) origin. Rejects javascript:/data:/etc. so a
 * persisted or user-supplied value can never flow into an `href` as an
 * executable URL — this is the taint barrier for CodeQL js/xss-through-dom
 * (the base is read from localStorage and rendered as a link in the footer).
 */
export function sanitizeApiBase(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim().replace(/\/$/, "");
  // Scheme allowlist on the value that actually flows downstream — only an
  // http(s) origin may reach the footer href. The leading-anchored regexp is
  // the taint barrier CodeQL js/xss-through-dom recognizes; the URL parse then
  // rejects anything malformed (e.g. "https:" with no host).
  if (!/^https?:\/\/[^\s/$.?#][^\s]*$/i.test(trimmed)) return null;
  try {
    new URL(trimmed);
  } catch {
    return null;
  }
  return trimmed;
}

function readStored(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return sanitizeApiBase(window.localStorage.getItem(STORAGE_KEY));
  } catch {
    return null;
  }
}

/** Current runtime API base (origin). Safe in both SSR and CSR. */
export function getApiBase(): string {
  if (cached) return cached;
  const next = readStored() ?? DEFAULT_API_BASE;
  cached = next;
  return next;
}

/** Set + persist a new API base. Dispatches an event subscribers can react to. */
export function setApiBase(url: string) {
  const next = sanitizeApiBase(url) ?? DEFAULT_API_BASE;
  cached = next;
  if (typeof window !== "undefined") {
    try {
      if (next === DEFAULT_API_BASE) window.localStorage.removeItem(STORAGE_KEY);
      else window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      /* ignore */
    }
    window.dispatchEvent(new CustomEvent(EVT, { detail: cached }));
  }
}

export function onApiBaseChange(cb: (next: string) => void): () => void {
  if (typeof window === "undefined") return () => {};
  const handler = (e: Event) => cb((e as CustomEvent<string>).detail);
  window.addEventListener(EVT, handler);
  return () => window.removeEventListener(EVT, handler);
}

/**
 * Back-compat: many callsites import `API_BASE` for display only. This is a
 * snapshot of the current base at module read time. For live values prefer
 * `getApiBase()` or the `useApiBase()` hook.
 */
export const API_BASE = getApiBase();

// ─── Chain network (data partition on the API) ───────────────────────────────

const NETWORK_STORAGE_KEY = "metagraphed:network";
const NETWORK_EVT = "metagraphed:network-changed";

export interface ChainNetwork {
  id: string;
  label: string;
  /** Path segment inserted after /api/v1 + /metagraph; "" for the mainnet default. */
  prefix: string;
  description: string;
}

/**
 * The data networks the backend actually hosts. `local` is intentionally NOT
 * here — it's a per-developer chain metagraphed can't enumerate, surfaced as a
 * dev-mode pointer (see LOCAL_DEV) rather than a browsable data network.
 */
export const CHAIN_NETWORKS: ChainNetwork[] = [
  {
    id: "mainnet",
    label: "Mainnet",
    prefix: "",
    description: "Bittensor mainnet (finney) — the full registry: services, health, schemas.",
  },
  {
    id: "testnet",
    label: "Testnet",
    prefix: "testnet",
    description:
      "Bittensor testnet — native chain registry only (identities; no curated services/health).",
  },
];

export const DEFAULT_NETWORK = CHAIN_NETWORKS[0]!;

/** Developer "Local" affordance — not a data network; points at a local chain. */
export const LOCAL_DEV = {
  label: "Local dev",
  rpc: "ws://127.0.0.1:9944",
  description:
    "Run a local subtensor and point your Bittensor SDK / RPC at it — metagraphed hosts no data for a local chain.",
  guideUrl: `${DEFAULT_API_BASE}/api/v1/local`,
};

let cachedNetwork: ChainNetwork | null = null;

/**
 * The apex that carries per-network subdomains (#8229). testnet.metagraph.sh
 * is a Cloudflare custom domain on the same metagraphed-ui Worker as the apex,
 * so within this family the leading label names the network and the bare apex
 * means mainnet.
 *
 * Everything OFF this family -- `vite dev` on localhost, a *.workers.dev
 * preview, an IP -- has no per-network sibling to navigate to, so those keep
 * the pure localStorage behavior. That split is the whole reason this is an
 * explicit suffix rather than "does the first label happen to name a network":
 * a preview host must not be told it is authoritative when its `testnet.`
 * sibling would not resolve.
 */
const NETWORK_HOST_APEX = "metagraph.sh";

function isNetworkHostFamily(host: string): boolean {
  return host === NETWORK_HOST_APEX || host.endsWith(`.${NETWORK_HOST_APEX}`);
}

/**
 * The network the current hostname designates, or null when the host carries
 * no network signal at all (so the caller falls back to localStorage).
 *
 * Within the host family this is authoritative in BOTH directions: a
 * `testnet.` label resolves to testnet, and the bare apex resolves to mainnet
 * rather than deferring to a stale stored preference from an earlier visit.
 */
function readHostNetwork(): ChainNetwork | null {
  if (typeof window === "undefined") return null;
  // `window.location` is absent in the unit-test harness's minimal window and
  // in any non-DOM embedder -- treat it as "no host signal", never a throw.
  const host = window.location?.hostname?.toLowerCase();
  if (!host || !isNetworkHostFamily(host)) return null;
  const label = host.split(".")[0];
  return (
    CHAIN_NETWORKS.find((n) => n.id === label && n.id !== DEFAULT_NETWORK.id) ?? DEFAULT_NETWORK
  );
}

function readStoredNetwork(): ChainNetwork | null {
  if (typeof window === "undefined") return null;
  try {
    const id = window.localStorage.getItem(NETWORK_STORAGE_KEY);
    return id ? (CHAIN_NETWORKS.find((n) => n.id === id) ?? null) : null;
  } catch {
    return null;
  }
}

/**
 * Current chain network. Safe in both SSR and CSR (defaults to mainnet).
 *
 * Hostname wins over the stored preference: on testnet.metagraph.sh the URL is
 * the explicit, shareable request, and a stale localStorage value from an
 * earlier visit to the apex must not silently override it (nor the reverse --
 * a testnet preference must not follow you back to the apex).
 *
 * SSR still resolves to the default: `window` is absent there, and the request
 * hostname cannot be threaded in through a module-level value without leaking
 * across concurrent requests in a shared Workers isolate. The client corrects
 * immediately on hydration. See #8229 for the request-scoped follow-up.
 */
export function getNetwork(): ChainNetwork {
  if (cachedNetwork) return cachedNetwork;
  cachedNetwork = readHostNetwork() ?? readStoredNetwork() ?? DEFAULT_NETWORK;
  return cachedNetwork;
}

/** The path prefix for the current network ("" for mainnet). */
export function getNetworkPrefix(): string {
  return getNetwork().prefix;
}

/**
 * The hostname a given network is served from, or null when the current host
 * has no per-network sibling (#8229).
 *
 * Returns null for single-label hosts (localhost) and bare IPs: `vite dev` and
 * preview/IP access have no `testnet.` sibling to reach, so those keep the
 * pure localStorage behavior instead of navigating somewhere that won't
 * resolve. Registrable-domain detection is deliberately naive (strip a leading
 * known-network label, keep the rest) because the only hosts this ever runs
 * against are metagraph.sh and its per-network subdomains.
 */
export function networkHostname(next: ChainNetwork, currentHost: string): string | null {
  const host = currentHost.toLowerCase();
  // Same gate readHostNetwork uses, so the read and write sides can't drift:
  // only hosts that actually carry per-network siblings are navigable.
  if (!isNetworkHostFamily(host)) return null;
  const [label, ...rest] = host.split(".");
  // Drop the current network label (if any) to recover the apex, so switching
  // testnet→mainnet→testnet doesn't stack labels.
  const isNetworkLabel = CHAIN_NETWORKS.some((n) => n.id === label && n.id !== DEFAULT_NETWORK.id);
  const apex = isNetworkLabel ? rest.join(".") : host;
  return next.id === DEFAULT_NETWORK.id ? apex : `${next.id}.${apex}`;
}

/**
 * Select + persist a chain network. Dispatches an event subscribers react to.
 *
 * On a per-network host (#8229) this navigates to the sibling hostname rather
 * than only flipping in-page state: the URL is the shareable, reloadable
 * source of truth, and `getNetwork()` reads the hostname first, so staying put
 * would leave the two disagreeing on the next reload. Falls back to the
 * in-page switch wherever no sibling host exists (dev, previews, IPs).
 */
export function setNetwork(id: string) {
  const next = CHAIN_NETWORKS.find((n) => n.id === id) ?? DEFAULT_NETWORK;
  cachedNetwork = next;
  if (typeof window !== "undefined") {
    try {
      if (next.id === DEFAULT_NETWORK.id) window.localStorage.removeItem(NETWORK_STORAGE_KEY);
      else window.localStorage.setItem(NETWORK_STORAGE_KEY, next.id);
    } catch {
      /* ignore */
    }
    const host = window.location?.hostname;
    const target = host ? networkHostname(next, host) : null;
    if (target && target !== host && typeof window.location?.assign === "function") {
      // Same path + query on the sibling host, so switching network keeps you
      // on the page you were reading. Full navigation, not a router push --
      // it's a different origin.
      const url = new URL(window.location.href);
      url.hostname = target;
      window.location.assign(url.toString());
      return;
    }
    window.dispatchEvent(new CustomEvent(NETWORK_EVT, { detail: next.id }));
  }
}

export function onNetworkChange(cb: (next: ChainNetwork) => void): () => void {
  if (typeof window === "undefined") return () => {};
  const handler = (e: Event) =>
    cb(CHAIN_NETWORKS.find((n) => n.id === (e as CustomEvent<string>).detail) ?? DEFAULT_NETWORK);
  window.addEventListener(NETWORK_EVT, handler);
  return () => window.removeEventListener(NETWORK_EVT, handler);
}

export const DEFAULT_GITHUB_REPO = "https://github.com/JSONbored/metagraphed";
export const GITHUB_REPO = env?.VITE_METAGRAPHED_REPO || DEFAULT_GITHUB_REPO;

export const DEFAULT_DISCORD_URL = "https://discord.gg/nj9m9yVDnb";
export const DISCORD_URL = env?.VITE_METAGRAPHED_DISCORD || DEFAULT_DISCORD_URL;
