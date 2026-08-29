/**
 * `format.ts` is the ONLY module in this app allowed to call `toFixed`,
 * `toLocaleString` or `Intl.NumberFormat` (#11628, enforced by a lint rule).
 *
 * Not a style rule. Those three are where rounding decisions live, and when
 * they are scattered a "0.6%" in one section and a "0.57%" in another are the
 * same number formatted by two people. The share of a page's numbers that
 * agree with each other is a correctness property, so it gets one home.
 */

/**
 * Format a generic number for UI display. Nullish / non-finite → fallback.
 * Tiering mirrors formatTao's magnitude rule so dust never collapses to "0":
 *  - exactly 0 → "0"
 *  - |n| ≥ 1 → grouped, up to 4 fraction digits ("1,234.5679")
 *  - 0 < |n| < 1 → up to 4 significant digits ("0.0001662")
 * Sign is preserved. Integers stay thousands-grouped with no decimal point.
 */
export function formatNumber(n: number | undefined | null, fallback = "—"): string {
  if (n === undefined || n === null || !Number.isFinite(n)) return fallback;
  if (n === 0) return "0";
  const magnitude = Math.abs(n);
  if (magnitude >= 1) {
    return new Intl.NumberFormat("en-US", { maximumFractionDigits: 4 }).format(n);
  }
  return new Intl.NumberFormat("en-US", {
    maximumSignificantDigits: 4,
  }).format(n);
}

/**
 * Format a TAO (τ) amount for compact display, tiering the precision by
 * magnitude so both dust and whole-subnet aggregates stay readable in a
 * single cell: ≥1e6 → "1.23Mτ", ≥1e3 → "1.2kτ", ≥1 → "1.23τ", and
 * sub-unit values keep 4 decimals ("0.5000τ"). Tiering is by magnitude
 * (|v|), not v itself, so a negative amount gets the same tier a positive
 * one of equal size would ("-2.00Mτ", not "-2000000.0000τ") -- the sign
 * is preserved by dividing the signed value, not the magnitude. Nullish /
 * non-finite input renders the em-dash fallback. Shared by the per-subnet
 * EconomicsPanel tiles and the /subnets table Registration column so the
 * two never drift.
 */
export function formatTao(v?: number | null): string {
  return formatAmount(v, "τ");
}

/**
 * {@link formatTao} for any unit: the same magnitude tiering with the caller's
 * symbol.
 *
 * Seven logic modules had written their own — `fmtStake`, `fmtAlpha`,
 * `fmtCompactTao`, `fmtTaoCompact`, `fmtStake` again — each a copy of this
 * ladder with a different suffix and, in two cases, a different threshold.
 * Two subnets' α could therefore be tiered differently on two pages.
 */
export function formatAmount(v: number | null | undefined, unit: string): string {
  if (v == null || !Number.isFinite(v)) return "—";
  const magnitude = Math.abs(v);
  if (magnitude >= 1_000_000) return joinAmountUnit(`${(v / 1_000_000).toFixed(2)}M`, unit);
  if (magnitude >= 1_000) return joinAmountUnit(`${(v / 1_000).toFixed(1)}k`, unit);
  if (magnitude >= 1) return joinAmountUnit(v.toFixed(2), unit);
  return joinAmountUnit(v.toFixed(4), unit);
}

/**
 * Join an already-formatted numeric amount to its unit. TAO's currency glyph
 * is a suffix and stays attached to the number; alpha and word units retain a
 * separating space. Keeping that distinction here prevents narrow tables,
 * charts and forms from inventing competing typography.
 */
export function joinAmountUnit(value: string, unit: string): string {
  return unit === "τ" ? `${value}${unit}` : `${value} ${unit}`;
}

/**
 * Normalize TAO amounts embedded in source-provided prose. Some decoded event
 * summaries arrive as complete sentences rather than numeric fields, so they
 * cannot pass through {@link formatAmount}. Limit the rewrite to a numeric
 * token immediately followed by whitespace and the TAO glyph; ordinary prose
 * such as "a τ amount" is intentionally unchanged.
 */
export function normalizeTaoUnitSpacing(value: string): string {
  return value.replace(/(\d)\s+τ/g, "$1τ");
}

/**
 * {@link formatAmount} with no unit: `2.40M`, `4.5k`, `12.50`.
 *
 * Alpha and raw counts are tiered the same way TAO is but carry their unit in
 * the column header rather than the cell.
 */
export function formatCompactAmount(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "—";
  const magnitude = Math.abs(v);
  if (magnitude >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M`;
  if (magnitude >= 1_000) return `${(v / 1_000).toFixed(1)}k`;
  if (magnitude >= 1) return v.toFixed(2);
  return v.toFixed(4);
}

/**
 * A signed, unitless delta for narrow ranked columns. Values below 0.01 use
 * three-significant-digit scientific notation so a real microscopic movement
 * never becomes either `0.0000` or an ellipsis.
 */
export function formatCompactDelta(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "—";
  if (v === 0) return "0";
  const sign = v > 0 ? "+" : "−";
  const magnitude = Math.abs(v);
  if (magnitude >= 1) return `${sign}${formatCompactAmount(magnitude)}`;
  if (magnitude >= 0.01) return `${sign}${formatNumber(magnitude)}`;
  const scientific = magnitude
    .toExponential(2)
    .replace(/\.0+(?=e)/, "")
    .replace(/(\.\d*?)0+(?=e)/, "$1")
    .replace("e-", "e−")
    .replace("e+", "e+");
  return `${sign}${scientific}`;
}

/** An amount at a fixed precision with its unit: `12.50τ`. */
export function formatAmountFixed(v: number | null | undefined, places = 2, unit = "τ"): string {
  if (v == null || !Number.isFinite(v)) return "—";
  return joinAmountUnit(v.toFixed(places), unit);
}

/**
 * A signed amount, with an explicit `+` on the positive side.
 *
 * A stake delta of `12τ` and one of `-12τ` are opposite events, and a column
 * that renders the first without a sign makes the reader infer direction from
 * the absence of a character.
 */
export function formatSignedAmount(v: number | null | undefined, unit = "τ"): string {
  if (v == null || !Number.isFinite(v)) return "—";
  const body = formatAmount(Math.abs(v), unit);
  // A signed zero says nothing: "+0τ" and "−0τ" are the same event, and a
  // reader scanning a column for direction reads the sign, not the digits.
  if (v === 0) return body;
  // U+2212 MINUS, not the hyphen: it is the width of the plus it alternates
  // with, so a column of signed amounts stays aligned.
  return v < 0 ? `−${body}` : `+${body}`;
}

/**
 * Approximate USD for a τ amount at the live client-side TAO price (#8373).
 * Convenience conversion only — not historical price-at-tx. Returns null when
 * either input is missing/non-finite so callers can omit the secondary line.
 * Precision mirrors TaoValue / formatNumber: 2dp for ≥$1; sub-dollar amounts
 * keep significant digits so dust never collapses to "$0".
 */
export function formatUsdApprox(
  tao: number | null | undefined,
  priceUsd: number | null | undefined,
): string | null {
  if (tao == null || !Number.isFinite(tao)) return null;
  if (priceUsd == null || !Number.isFinite(priceUsd)) return null;
  const usd = tao * priceUsd;
  if (Math.abs(usd) >= 1) {
    return `$${formatNumber(Number(usd.toFixed(2)))}`;
  }
  return `$${formatNumber(usd)}`;
}

/**
 * A directly observed USD amount, not a TAO conversion.
 *
 * Revenue contracts already publish dollars over their measured window, so
 * routing them through {@link formatUsdApprox} would imply a second,
 * client-side price conversion. Keep this formatter separate: it rounds
 * whole-dollar amounts to cents, preserves sub-dollar precision, and only
 * abbreviates values at the million scale where a ledger cell would stop
 * being scannable.
 */
export function formatUsd(value: number | null | undefined, fallback = "—"): string {
  if (value == null || !Number.isFinite(value)) return fallback;
  const sign = value < 0 ? "−" : "";
  const amount = Math.abs(value);
  if (amount >= 1_000_000) return `${sign}$${(amount / 1_000_000).toFixed(2)}M`;
  if (amount >= 1) return `${sign}$${formatNumber(Number(amount.toFixed(2)))}`;
  return `${sign}$${formatNumber(amount)}`;
}

/**
 * A compact USD reading for narrow analytical marks. Unlike {@link formatUsd},
 * this abbreviates at the thousand boundary so a live block tile can retain
 * both its TAO and dollar readings without clipping either one.
 */
export function formatCompactUsd(value: number | null | undefined, fallback = "—"): string {
  if (value == null || !Number.isFinite(value)) return fallback;
  const sign = value < 0 ? "−" : "";
  const amount = Math.abs(value);
  if (amount >= 1_000_000_000) return `${sign}$${(amount / 1_000_000_000).toFixed(1)}B`;
  if (amount >= 1_000_000) return `${sign}$${(amount / 1_000_000).toFixed(1)}M`;
  if (amount >= 1_000) return `${sign}$${(amount / 1_000).toFixed(1)}k`;
  return formatUsd(value, fallback);
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

// Canonical implementation lives in packages/ui-kit (#7847) -- re-exported
// here so every existing "@/lib/metagraphed/format" import site is unaffected.
export { classNames } from "@jsonbored/ui-kit";

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

// Display-only estimate (Bittensor's well-known ~12s block time), mirroring
// take-extrinsics.ts's own APPROX_SECONDS_PER_BLOCK convention -- never used
// for anything gating/correctness-critical, only this "roughly how old" label.
const APPROX_SECONDS_PER_BLOCK = 12;

/**
 * A subnet's age in whole days, estimated from the block delta between its
 * registration block and the current chain block (#6643). Null when either
 * input is missing/non-finite, or when the delta would be negative (a
 * mid-flight/inconsistent snapshot -- never show a nonsensical negative age).
 */
export function subnetAgeDays(
  registeredAtBlock?: number | null,
  currentBlock?: number | null,
): number | null {
  if (registeredAtBlock == null || currentBlock == null) return null;
  if (!Number.isFinite(registeredAtBlock) || !Number.isFinite(currentBlock)) return null;
  const ageBlocks = currentBlock - registeredAtBlock;
  if (ageBlocks < 0) return null;
  return Math.floor((ageBlocks * APPROX_SECONDS_PER_BLOCK) / 86400);
}

/** Formats a day count from {@link subnetAgeDays} as "N days old" ("1 day old" singular). */
export function formatSubnetAge(days: number | null): string {
  if (days == null) return "—";
  return `${formatNumber(days)} day${days === 1 ? "" : "s"} old`;
}

/**
 * A ratio (0…1) as a percentage string.
 *
 * The single most common hand-rolled format in this app was
 * `${(x * 100).toFixed(1)}%`, and floating point makes it wrong often enough
 * to notice: `0.57 * 100` is `56.99999999999999`, so a naive `toFixed(2)`
 * prints "57.00%" while `toFixed(0)` prints "57%" and a third call site
 * printing `(x * 100).toFixed(1)` gets "57.0%". One function, one rounding.
 *
 * Pass `digits` for the precision the reader needs; a share of emission wants
 * one decimal, a take rate wants two.
 */
export function formatPct(ratio: number | null | undefined, digits = 1, fallback = "—"): string {
  if (ratio == null || !Number.isFinite(ratio)) return fallback;
  const pct = ratio * 100;
  // Round FIRST, then format: `toFixed` on the raw product carries the
  // multiplication's error into the string.
  const rounded = Math.round(pct * 10 ** digits) / 10 ** digits;
  return `${rounded.toFixed(digits)}%`;
}

/**
 * A count as a compact magnitude string: `1.23M`, `4.5k`, `812`.
 *
 * Tiering matches {@link formatTao}'s, by magnitude rather than by value, so a
 * negative gets the same tier a positive of equal size would. Unlike
 * `formatTao` it carries no unit -- the caller's label says what is being
 * counted.
 */
export function formatCompact(n: number | null | undefined, fallback = "—"): string {
  if (n == null || !Number.isFinite(n)) return fallback;
  const magnitude = Math.abs(n);
  if (magnitude >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (magnitude >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  // A non-integer below a thousand is capped at two decimals rather than
  // handed to `formatNumber`, which keeps four (#11681). That fall-through put
  // "295.2016" in a column whose other rows read "5.9k" and "1.2k" -- three
  // precisions in one column, from the formatter whose entire job is to be
  // compact. A whole number still renders bare, because a COUNT of 812 is
  // "812" and not "812.00"; that is the only thing this differs from
  // {@link formatCompactAmount} in, and the reason both exist.
  if (magnitude >= 1 && !Number.isInteger(n)) return n.toFixed(2);
  return formatNumber(n, fallback);
}

/**
 * A number at a fixed number of decimals, or the fallback when it is not a
 * number at all.
 *
 * The plain-`toFixed` replacement: it exists so a call site does not have to
 * guard `Number.isFinite` itself, which was the actual bug behind every
 * "NaN.00" this app has ever rendered.
 */
export function formatDecimal(n: number | null | undefined, digits = 2, fallback = "—"): string {
  if (n == null || !Number.isFinite(n)) return fallback;
  return n.toFixed(digits);
}

/**
 * An absolute timestamp in the site's one locale: `Aug 23, 2026, 7:52 AM`.
 *
 * Dates are formatted here for the same reason numbers are: two call sites
 * that pick their own locale render the same instant two ways, and a reader
 * comparing a freshness stamp on one page with one on another has no way to
 * know whether they disagree about the time or only about the format.
 */
export function formatAbsoluteTime(iso?: string | null): string | null {
  if (!iso) return null;
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return null;
  return t.toLocaleString("en-US");
}

/**
 * A signed percentage for a `FactCell` delta, with the tone the sign implies.
 *
 * Here rather than beside one route's derivations (#11693): the subnet hero's
 * Momentum and the validator hero's both state a window's change, and two
 * copies of this would be two roundings of the same movement -- exactly what
 * the module comment above says it exists to prevent.
 */
export function deltaCell(
  change: number | null,
  better: "high" | "low" = "high",
): { text: string; tone: "good" | "bad" | "neutral" } | undefined {
  if (change === null || !Number.isFinite(change)) return undefined;
  const pct = change * 100;
  const text = `${pct >= 0 ? "+" : ""}${formatDecimal(pct, Math.abs(pct) >= 10 ? 0 : 1)}%`;
  if (Math.abs(pct) < 0.05) return { text: "0%", tone: "neutral" };
  const good = better === "high" ? pct > 0 : pct < 0;
  return { text, tone: good ? "good" : "bad" };
}
