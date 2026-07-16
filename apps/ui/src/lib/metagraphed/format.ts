// Small formatting + UI helpers
export function formatNumber(n: number | undefined | null, fallback = "—"): string {
  if (n === undefined || n === null || !Number.isFinite(n)) return fallback;
  return new Intl.NumberFormat("en-US").format(n);
}

/**
 * Format a TAO (τ) amount for compact display, tiering the precision by
 * magnitude so both dust and whole-subnet aggregates stay readable in a
 * single cell: ≥1e6 → "1.23M τ", ≥1e3 → "1.2k τ", ≥1 → "1.23 τ", and
 * sub-unit values keep 4 decimals ("0.5000 τ"). Tiering is by magnitude
 * (|v|), not v itself, so a negative amount gets the same tier a positive
 * one of equal size would ("-2.00M τ", not "-2000000.0000 τ") -- the sign
 * is preserved by dividing the signed value, not the magnitude. Nullish /
 * non-finite input renders the em-dash fallback. Shared by the per-subnet
 * EconomicsPanel tiles and the /subnets table Registration column so the
 * two never drift.
 */
export function formatTao(v?: number | null): string {
  if (v == null || !Number.isFinite(v)) return "—";
  const magnitude = Math.abs(v);
  if (magnitude >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M τ`;
  if (magnitude >= 1_000) return `${(v / 1_000).toFixed(1)}k τ`;
  if (magnitude >= 1) return `${v.toFixed(2)} τ`;
  return `${v.toFixed(4)} τ`;
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

/**
 * Options controlling how {@link relativeFromDiff} renders a "time ago" label.
 * The two behavioural differences between this codebase's freshness stamp
 * (`relative` in freshness.ts) and this general formatter are captured here so
 * there is ONE bucketing implementation, not two that silently drift (#6020).
 */
export interface RelativeOptions {
  /**
   * How to treat a future (negative) diff — a timestamp ahead of the caller's
   * clock. `false` (default) surfaces it as `"in Xunit"` (a genuine future
   * event). `true` clamps it to the zero point (`"0s ago"`): for a *freshness*
   * stamp a `generated_at`/`updated_at` ahead of the client clock is clock
   * skew, not real future data, so "just now" is the correct read — never
   * "in Xs" (#6020).
   */
  clampFuture?: boolean;
  /** Floor for the seconds bucket — 1 hides a sub-second `"0s"`, 0 allows it. */
  secondsFloor?: number;
  /** Hours before rolling over to a `"Xd"` label (24 = days past one day; 48 = keep an hours label up to 47h). */
  hourCapHours?: number;
}

/**
 * Single "time ago" bucketing core (#6020), shared by {@link formatRelative}
 * and the freshness `relative` stamp so the two can't silently diverge again.
 * `diffMs` is (now - timestamp): positive is the past. Defaults reproduce
 * {@link formatRelative}'s historical behaviour exactly; see {@link RelativeOptions}
 * for the freshness-stamp overrides.
 */
export function relativeFromDiff(
  diffMs: number,
  { clampFuture = false, secondsFloor = 1, hourCapHours = 24 }: RelativeOptions = {},
): string {
  const diff = clampFuture ? Math.max(0, diffMs) : diffMs;
  const past = diff >= 0;
  const abs = Math.abs(diff);
  let value: number;
  let unit: string;
  if (abs < 60_000) {
    value = Math.max(secondsFloor, Math.round(abs / 1000));
    unit = "s";
  } else if (abs < 3_600_000) {
    value = Math.round(abs / 60_000);
    unit = "m";
  } else if (abs < hourCapHours * 3_600_000) {
    value = Math.round(abs / 3_600_000);
    unit = "h";
  } else {
    value = Math.round(abs / 86_400_000);
    unit = "d";
  }
  return past ? `${value}${unit} ago` : `in ${value}${unit}`;
}

export function formatRelative(iso?: string | null): string {
  if (!isUsableTimestamp(iso)) return "—";
  // General relative formatter: surfaces a genuine future event as "in Xunit".
  return relativeFromDiff(Date.now() - Date.parse(iso));
}

export function isStaleFreshness(iso?: string | null, thresholdMs = 12 * 60 * 60_000): boolean {
  // Data refreshes on a ~6h cycle, so only flag a snapshot as stale once it has
  // clearly missed multiple cycles (12h). The old 5-minute threshold fired on
  // every page constantly — noise, not signal. Missing/invalid/placeholder
  // timestamps stay conservative so callers can show an unknown-freshness cue.
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
export function humaniseSeconds(sec: number | null | undefined, fallback = "—"): string {
  if (sec === null || sec === undefined || !Number.isFinite(sec)) return fallback;
  const s = Math.max(0, Math.round(sec));
  if (s < 60) return `${s}s`;
  if (s < 3600) {
    const m = Math.floor(s / 60);
    const rs = s % 60;
    return rs && m < 10 ? `${m}m ${rs}s` : `${m}m`;
  }
  if (s < 86400) {
    const totalMinutes = Math.round(s / 60);
    const h = Math.floor(totalMinutes / 60);
    const rm = totalMinutes % 60;
    if (h >= 24) return "1d";
    return rm && h < 10 ? `${h}h ${rm}m` : `${h}h`;
  }
  const totalHours = Math.round(s / 3600);
  const d = Math.floor(totalHours / 24);
  const rh = totalHours % 24;
  return rh && d < 10 ? `${d}d ${rh}h` : `${d}d`;
}

/**
 * Compute a compact "elapsed" label between two ISO timestamps. If `end`
 * is null/undefined the duration runs to now (useful for ongoing incidents).
 */
export function durationLabel(start?: string | null, end?: string | null): string {
  if (!start) return "—";
  const sMs = Date.parse(start);
  if (!Number.isFinite(sMs)) return "—";
  const eMs = end ? Date.parse(end) : Date.now();
  return humaniseSeconds(Math.max(0, (eMs - sMs) / 1000));
}
