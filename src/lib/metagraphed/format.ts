// Small formatting + UI helpers
export function formatNumber(n: number | undefined | null, fallback = "—"): string {
  if (n === undefined || n === null || !Number.isFinite(n)) return fallback;
  return new Intl.NumberFormat("en-US").format(n);
}

export function formatRelative(iso?: string | null): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "—";
  const diff = Date.now() - t;
  const abs = Math.abs(diff);
  const past = diff >= 0;
  const units: Array<[number, string]> = [
    [1000, "s"],
    [60_000, "m"],
    [3_600_000, "h"],
    [86_400_000, "d"],
  ];
  let value = abs / 1000;
  let unit = "s";
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
  void units;
  return past ? `${value}${unit} ago` : `in ${value}${unit}`;
}

export function isStaleFreshness(iso?: string | null, thresholdMs = 5 * 60_000): boolean {
  if (!iso) return true;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return true;
  return Date.now() - t > thresholdMs;
}

export function classNames(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}
