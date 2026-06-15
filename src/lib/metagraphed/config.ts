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
function sanitizeApiBase(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim().replace(/\/$/, "");
  try {
    const { protocol } = new URL(trimmed);
    if (protocol !== "http:" && protocol !== "https:") return null;
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

function readStoredNetwork(): ChainNetwork | null {
  if (typeof window === "undefined") return null;
  try {
    const id = window.localStorage.getItem(NETWORK_STORAGE_KEY);
    return id ? (CHAIN_NETWORKS.find((n) => n.id === id) ?? null) : null;
  } catch {
    return null;
  }
}

/** Current chain network. Safe in both SSR and CSR (defaults to mainnet). */
export function getNetwork(): ChainNetwork {
  if (cachedNetwork) return cachedNetwork;
  cachedNetwork = readStoredNetwork() ?? DEFAULT_NETWORK;
  return cachedNetwork;
}

/** The path prefix for the current network ("" for mainnet). */
export function getNetworkPrefix(): string {
  return getNetwork().prefix;
}

/** Select + persist a chain network. Dispatches an event subscribers react to. */
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

export const GITHUB_REPO =
  env?.VITE_METAGRAPHED_REPO || "https://github.com/metagraphed/metagraphed";
