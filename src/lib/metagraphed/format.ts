// Small formatting + UI helpers
export function formatNumber(n: number | undefined | null, fallback = "—"): string {
  if (n === undefined || n === null || !Number.isFinite(n)) return fallback;
  return new Intl.NumberFormat("en-US").format(n);
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

export function isStaleFreshness(iso?: string | null, thresholdMs = 5 * 60_000): boolean {
  // Treat missing, invalid, and placeholder timestamps conservatively so
  // untrusted metadata cannot make stale or unknown snapshots look fresh.
  if (!isUsableTimestamp(iso)) return true;
  return Date.now() - Date.parse(iso) > thresholdMs;
}

export function classNames(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

/**
 * Humanise a duration in seconds into a compact label like "42s", "5m",
 * "5h 39m", or "2d 4h". Used for freshness / age numbers that would
 * otherwise display as raw seconds (e.g. "20363s").
 */
export function humaniseSeconds(
  sec: number | null | undefined,
  fallback = "—",
): string {
  if (sec === null || sec === undefined || !Number.isFinite(sec)) return fallback;
  const s = Math.max(0, Math.round(sec));
  if (s < 60) return `${s}s`;
  if (s < 3600) {
    const m = Math.floor(s / 60);
    const rs = s % 60;
    return rs && m < 10 ? `${m}m ${rs}s` : `${m}m`;
  }
  if (s < 86400) {
    const h = Math.floor(s / 3600);
    const rm = Math.round((s % 3600) / 60);
    return rm && h < 10 ? `${h}h ${rm}m` : `${h}h`;
  }
  const d = Math.floor(s / 86400);
  const rh = Math.round((s % 86400) / 3600);
  return rh && d < 10 ? `${d}d ${rh}h` : `${d}d`;
}

/**
 * Compute a compact "elapsed" label between two ISO timestamps. If `end`
 * is null/undefined the duration runs to now (useful for ongoing incidents).
 */
export function durationLabel(
  start?: string | null,
  end?: string | null,
): string {
  if (!start) return "—";
  const sMs = Date.parse(start);
  if (!Number.isFinite(sMs)) return "—";
  const eMs = end ? Date.parse(end) : Date.now();
  return humaniseSeconds(Math.max(0, (eMs - sMs) / 1000));
}
