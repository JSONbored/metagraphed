export interface ApiSource {
  path: string;
  artifact?: string;
  label?: string;
}

/** Merges registered source groups with first-wins path deduplication. */
export function dedupeApiSources(groups: Iterable<ApiSource[]>): ApiSource[] {
  const out: ApiSource[] = [];
  const seen = new Set<string>();
  for (const arr of groups) {
    for (const s of arr) {
      if (seen.has(s.path)) continue;
      seen.add(s.path);
      out.push(s);
    }
  }
  return out;
}
