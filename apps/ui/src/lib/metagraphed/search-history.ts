const KEY = "mg.search.recent";
const STATE_KEY = "mg.search.state.v1";
const MAX = 5;

export function loadRecent(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v) => typeof v === "string").slice(0, MAX) : [];
  } catch {
    return [];
  }
}

export function pushRecent(q: string): void {
  if (typeof window === "undefined") return;
  const trimmed = q.trim();
  if (!trimmed) return;
  try {
    const cur = loadRecent().filter((v) => v.toLowerCase() !== trimmed.toLowerCase());
    cur.unshift(trimmed);
    window.localStorage.setItem(KEY, JSON.stringify(cur.slice(0, MAX)));
  } catch {
    /* ignore */
  }
}

export function clearRecent(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}

export const SUGGESTED_QUERIES = ["bittensor", "taostats", "rpc", "openapi", "sn7"];

// --- Persisted palette state (query + scope) ---

export interface PaletteState {
  q: string;
  scope: string;
}

export function loadPaletteState(): PaletteState | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(STATE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PaletteState>;
    return {
      q: typeof parsed.q === "string" ? parsed.q : "",
      scope: typeof parsed.scope === "string" ? parsed.scope : "all",
    };
  } catch {
    return null;
  }
}

export function savePaletteState(state: PaletteState): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STATE_KEY, JSON.stringify(state));
  } catch {
    /* ignore */
  }
}
