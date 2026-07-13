// Small formatting + UI helpers, duplicated from apps/ui/src/lib/metagraphed/format.ts
// and freshness.ts (both broad, pervasively-used app utility files apps/ui keeps
// unchanged for their 100+ other callers) -- only the functions the migrated
// packages/ui-kit components actually need come along here.

export function classNames(
  ...parts: Array<string | false | null | undefined>
): string {
  return parts.filter(Boolean).join(" ");
}

/**
 * The upstream registry frequently emits "1970-01-01T00:00:00.000Z" as a
 * placeholder when an artifact hasn't been timestamped yet. Treat any
 * pre-2000 date as "unknown" so the UI doesn't claim freshness/staleness
 * about something the API never measured.
 */
export function isUsableTimestamp(iso?: string | null): iso is string {
  if (!iso) return false;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return false;
  return t > 946_684_800_000; // 2000-01-01
}

export function formatRelative(iso?: string | null): string {
  if (!isUsableTimestamp(iso)) return "—";
  const t = Date.parse(iso);
  const diff = Date.now() - t;
  const abs = Math.abs(diff);
  const past = diff >= 0;
  let value: number;
  let unit: string;
  if (abs < 60_000) {
    value = Math.max(1, Math.round(abs / 1000));
    unit = "s";
  } else if (abs < 3_600_000) {
    value = Math.round(abs / 60_000);
    unit = "m";
  } else if (abs < 86_400_000) {
    value = Math.round(abs / 3_600_000);
    unit = "h";
  } else {
    value = Math.round(abs / 86_400_000);
    unit = "d";
  }
  return past ? `${value}${unit} ago` : `in ${value}${unit}`;
}

export function isStaleFreshness(
  iso?: string | null,
  thresholdMs = 12 * 60 * 60_000,
): boolean {
  // Data refreshes on a ~6h cycle, so only flag a snapshot as stale once it has
  // clearly missed multiple cycles (12h). Missing/invalid/placeholder
  // timestamps stay conservative so callers can show an unknown-freshness cue.
  if (!isUsableTimestamp(iso)) return true;
  return Date.now() - Date.parse(iso) > thresholdMs;
}

/**
 * Centralized freshness formatter — used by StatWithSpark, NoDataSpark,
 * MethodologyCallout and OperationalPanel so every "last-updated" stamp
 * across the app reads the same way.
 */
export function formatFreshness(
  updatedAt?: string | null,
  windowLabel?: string | null,
): string | null {
  const parts: string[] = [];
  if (updatedAt) {
    const t = new Date(updatedAt);
    if (!Number.isNaN(t.getTime())) {
      const diffMs = Date.now() - t.getTime();
      parts.push(`updated ${relative(diffMs)}`);
    }
  }
  if (windowLabel) parts.push(`${windowLabel} window`);
  return parts.length ? parts.join(" · ") : null;
}

export function formatFreshnessAbsolute(
  updatedAt?: string | null,
): string | null {
  if (!updatedAt) return null;
  const t = new Date(updatedAt);
  if (Number.isNaN(t.getTime())) return null;
  return t.toLocaleString();
}

export function relative(diffMs: number): string {
  const sec = Math.max(0, Math.round(diffMs / 1000));
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 48) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  return `${day}d ago`;
}
