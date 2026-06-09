const KEY = "mg.search.recent";
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
