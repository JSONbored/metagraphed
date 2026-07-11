// Yield is an emission/stake return rate — tiny fractions (~1e-5..1e-1). Render
// as a percentage with adaptive precision; null/non-finite collapses to em-dash.
//
// The 0.001-1% band uses significant-figure precision (toPrecision), not a
// fixed decimal count (toFixed) — validator yields in this subnet-scale range
// commonly cluster within a few percent of each other (e.g. 0.0041529% vs
// 0.0041496% vs 0.0041425%), and a fixed toFixed(4) rounds several of them to
// the exact same displayed string even though the underlying values genuinely
// differ, making an otherwise-ranked leaderboard look like a data bug.
export function fmtYield(v?: number | null): string {
  if (v == null || !Number.isFinite(v)) return "—";
  if (v === 0) return "0%";
  const pct = v * 100;
  if (Math.abs(pct) >= 1) return `${pct.toFixed(2)}%`;
  if (Math.abs(pct) >= 0.001) return `${pct.toPrecision(5)}%`;
  return `${pct.toExponential(2)}%`;
}
