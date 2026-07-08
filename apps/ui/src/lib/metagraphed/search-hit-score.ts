/** Minimum scoreHit value for an exact title match (before kind bonuses). */
export const EXACT_TITLE_MATCH_SCORE = 100;

export interface ScorableHit {
  kind?: string;
  type?: string;
  title?: string;
  url?: string;
  id?: string;
  netuid?: number;
}

export function hitKind(hit: ScorableHit): string {
  return (hit.kind ?? hit.type ?? "").toLowerCase();
}

/** Mirrors command-palette-body.tsx scoreHit — shared for omnibox subnet promotion (#3394). */
export function scoreHit(hit: ScorableHit, q: string, recentSet: Set<string> = new Set()): number {
  const t = (hit.title ?? hit.url ?? hit.id ?? "").toLowerCase();
  const n = q.toLowerCase();
  let s = 0;
  if (!n) return 0;
  if (t === n) s += EXACT_TITLE_MATCH_SCORE;
  else if (t.startsWith(n)) s += 60;
  else if (t.includes(` ${n}`)) s += 30;
  else if (t.includes(n)) s += 10;
  if (recentSet.has(n) && t.includes(n)) s += 8;
  const kind = hitKind(hit);
  if (kind === "subnet" || kind === "provider") s += 2;
  return s;
}

/** Best subnet hit to promote into omnibox "Go to" when the title matches exactly. */
export function pickPromotedSubnetHit<T extends ScorableHit>(hits: T[], q: string): T | null {
  const query = q.trim();
  if (!query) return null;

  let best: T | null = null;
  let bestScore = 0;
  for (const hit of hits) {
    if (hitKind(hit) !== "subnet") continue;
    if (hit.netuid == null) continue;
    const s = scoreHit(hit, query);
    if (s > bestScore) {
      bestScore = s;
      best = hit;
    }
  }

  if (!best || bestScore < EXACT_TITLE_MATCH_SCORE) return null;
  return best;
}
