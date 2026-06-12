// Metagraphed API client config.
// Live calls only. The API base is mutable at runtime via the Network switcher
// (persisted to localStorage) so the preview can point at staging/local
// without a rebuild.

const env = (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env;

const STORAGE_KEY = "metagraphed:api-base";
const EVT = "metagraphed:api-base-changed";

export const DEFAULT_API_BASE = (
  env?.VITE_METAGRAPH_API_BASE ||
  env?.VITE_METAGRAPHED_API_BASE ||
  "https://api.metagraph.sh"
).replace(/\/$/, "");

export interface ApiNetwork {
  id: string;
  label: string;
  url: string;
  description?: string;
}

export const NETWORKS: ApiNetwork[] = [
  {
    id: "finney",
    label: "Finney (prod)",
    url: DEFAULT_API_BASE,
    description: "Production Cloudflare Worker backing api.metagraph.sh.",
  },
  {
    id: "preview",
    label: "Preview",
    url: "https://preview.metagraph.sh",
    description: "Latest preview build (if exposed).",
  },
  {
    id: "local",
    label: "Local",
    url: "http://localhost:8787",
    description: "Local wrangler dev worker.",
  },
];

let cached: string | null = null;

function readStored(): string | null {
  if (typeof window === "undefined") return null;
  try {
    const v = window.localStorage.getItem(STORAGE_KEY);
    return v ? v.replace(/\/$/, "") : null;
  } catch {
    return null;
  }
}

/** Current runtime API base. Safe in both SSR and CSR. */
export function getApiBase(): string {
  if (cached) return cached;
  const next = readStored() ?? DEFAULT_API_BASE;
  cached = next;
  return next;
}

/** Set + persist a new API base. Dispatches an event subscribers can react to. */
export function setApiBase(url: string) {
  const clean = url.trim().replace(/\/$/, "");
  const next = clean || DEFAULT_API_BASE;
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

export const GITHUB_REPO =
  env?.VITE_METAGRAPHED_REPO || "https://github.com/metagraphed/metagraphed";
