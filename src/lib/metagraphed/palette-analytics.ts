// Lightweight client-side analytics for the command palette.
// Stored entirely in localStorage; no network calls. Inspect via
// `window.__mgPaletteAnalytics?.()` in the browser devtools.

const KEY = "mg.palette.analytics.v1";
const MAX_QUERIES = 50;
const MAX_ZERO = 50;

export interface PaletteAnalytics {
  opens: number;
  selections: number;
  lastOpenedAt?: string;
  topQueries: Record<string, number>;
  zeroResultQueries: Record<string, number>;
  scopeUsage: Record<string, number>;
  actionUsage: Record<string, number>;
}

function empty(): PaletteAnalytics {
  return {
    opens: 0,
    selections: 0,
    topQueries: {},
    zeroResultQueries: {},
    scopeUsage: {},
    actionUsage: {},
  };
}

function read(): PaletteAnalytics {
  if (typeof window === "undefined") return empty();
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return empty();
    return { ...empty(), ...(JSON.parse(raw) as PaletteAnalytics) };
  } catch {
    return empty();
  }
}

function write(state: PaletteAnalytics): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    /* ignore */
  }
}

function trim(map: Record<string, number>, max: number): Record<string, number> {
  const entries = Object.entries(map)
    .sort((a, b) => b[1] - a[1])
    .slice(0, max);
  return Object.fromEntries(entries);
}

export function trackOpen(): void {
  const s = read();
  s.opens += 1;
  s.lastOpenedAt = new Date().toISOString();
  write(s);
}

export function trackScope(scope: string): void {
  const s = read();
  s.scopeUsage[scope] = (s.scopeUsage[scope] ?? 0) + 1;
  write(s);
}

export function trackQuery(query: string, resultCount: number): void {
  const q = query.trim().toLowerCase();
  if (!q) return;
  const s = read();
  s.topQueries[q] = (s.topQueries[q] ?? 0) + 1;
  s.topQueries = trim(s.topQueries, MAX_QUERIES);
  if (resultCount === 0) {
    s.zeroResultQueries[q] = (s.zeroResultQueries[q] ?? 0) + 1;
    s.zeroResultQueries = trim(s.zeroResultQueries, MAX_ZERO);
  }
  write(s);
}

export function trackSelection(kind: string): void {
  const s = read();
  s.selections += 1;
  s.actionUsage[`select:${kind}`] = (s.actionUsage[`select:${kind}`] ?? 0) + 1;
  write(s);
}

export function trackAction(action: string): void {
  const s = read();
  s.actionUsage[action] = (s.actionUsage[action] ?? 0) + 1;
  write(s);
}

export function getAnalytics(): PaletteAnalytics {
  return read();
}

export function resetAnalytics(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}

if (typeof window !== "undefined") {
  (window as unknown as { __mgPaletteAnalytics?: () => PaletteAnalytics }).__mgPaletteAnalytics =
    getAnalytics;
}
