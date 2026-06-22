/**
 * Lightweight client-side history of recently visited entity pages.
 * Powers the homepage "Continue exploring" rail and any future
 * personalised deep-link surfaces. Pure localStorage — no network.
 */

export type RecentVisitKind = "subnet" | "provider" | "surface" | "endpoint" | "page";

export interface RecentVisit {
  kind: RecentVisitKind;
  id: string; // netuid, provider slug, or path segment
  href: string; // canonical href to deep-link back to
  label?: string; // optional human label (best-effort)
  ts: number;
}

const KEY = "mg.recent.visits.v1";
const MAX = 12;

export function loadRecentVisits(): RecentVisit[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (v): v is RecentVisit =>
          v &&
          typeof v === "object" &&
          typeof v.kind === "string" &&
          typeof v.id === "string" &&
          typeof v.href === "string",
      )
      .slice(0, MAX);
  } catch {
    return [];
  }
}

export function pushRecentVisit(v: Omit<RecentVisit, "ts">): void {
  if (typeof window === "undefined") return;
  if (!v.id) return;
  try {
    const cur = loadRecentVisits().filter((e) => !(e.kind === v.kind && e.id === v.id));
    cur.unshift({ ...v, ts: Date.now() });
    window.localStorage.setItem(KEY, JSON.stringify(cur.slice(0, MAX)));
    // Notify listeners in-page (storage event only fires across tabs).
    window.dispatchEvent(new CustomEvent("mg:recent-visits"));
  } catch {
    /* ignore */
  }
}

export function clearRecentVisits(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(KEY);
    window.dispatchEvent(new CustomEvent("mg:recent-visits"));
  } catch {
    /* ignore */
  }
}

/** Parse a pathname into a RecentVisit, or null if it isn't an entity page. */
export function visitFromPath(pathname: string): Omit<RecentVisit, "ts"> | null {
  const m1 = pathname.match(/^\/subnets\/([^/?#]+)/);
  if (m1) {
    return { kind: "subnet", id: decodeURIComponent(m1[1]), href: `/subnets/${m1[1]}` };
  }
  const m2 = pathname.match(/^\/providers\/([^/?#]+)/);
  if (m2) {
    return { kind: "provider", id: decodeURIComponent(m2[1]), href: `/providers/${m2[1]}` };
  }
  return null;
}
