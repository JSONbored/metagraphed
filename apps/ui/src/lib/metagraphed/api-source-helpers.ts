export interface ApiSource {
  path: string;
  artifact?: string;
  label?: string;
  /**
   * Absolute origin for sources served outside the configured v1 API base
   * (the modern v2 explorer reads). Undefined means "the active API base".
   */
  origin?: string;
}

/**
 * The absolute URL a registered source links to: its own origin when it
 * declared one, otherwise the active API base. Null when neither yields a
 * usable absolute URL.
 */
export function apiSourceHref(source: ApiSource, apiBase: string): string | null {
  const base = source.origin ?? apiBase;
  if (!base || !source.path) return null;
  return `${base}${source.path}`;
}

/** Merges registered source groups with first-wins origin+path deduplication. */
export function dedupeApiSources(groups: Iterable<ApiSource[]>): ApiSource[] {
  const out: ApiSource[] = [];
  const seen = new Set<string>();
  for (const arr of groups) {
    for (const s of arr) {
      const key = JSON.stringify([s.origin ?? null, s.path]);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(s);
    }
  }
  return out;
}
