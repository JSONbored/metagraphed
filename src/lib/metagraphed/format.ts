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
  // No usable timestamp ⇒ we don't *know* it's stale; don't flag it.
  if (!isUsableTimestamp(iso)) return false;
  return Date.now() - Date.parse(iso) > thresholdMs;
}

export function classNames(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}
