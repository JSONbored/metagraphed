import type { ConcentrationMetrics, ScoreDistribution } from "@/lib/metagraphed/types";

// #3471: pure derivation logic behind the network decentralization scorecard.
// Kept in a plain module (not the .tsx) so the composite-score algorithm and its
// formatters are unit-testable and don't trip react-refresh's component-only rule.

export type DecentralizationTone = "default" | "ok" | "warn" | "down";

/** Gini / HHI / top-share are 0–1 where lower = more decentralized → map to a tone. */
export function concentrationTone(v?: number | null): DecentralizationTone {
  if (v == null || !Number.isFinite(v)) return "default";
  if (v < 0.4) return "ok";
  if (v < 0.7) return "warn";
  return "down";
}

/** Percentile band width (p90 − p10) of a 0–1 score, or null when unavailable. */
export function scoreSpread(d?: ScoreDistribution | null): number | null {
  if (!d || d.p90 == null || d.p10 == null || !Number.isFinite(d.p90) || !Number.isFinite(d.p10)) {
    return null;
  }
  return d.p90 - d.p10;
}

/**
 * Composite 0–100 decentralization score. Averages the "balance" (1 − metric) of
 * every available concentration lens across the stake + emission distributions,
 * plus a Nakamoto breadth term normalized against the holder count. Higher = more
 * decentralized. Returns null when no lens carries a usable metric.
 */
export function decentralizationScore(
  stake: ConcentrationMetrics | null | undefined,
  emission: ConcentrationMetrics | null | undefined,
): number | null {
  const parts: number[] = [];
  const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
  const addBalance = (v?: number | null) => {
    if (v != null && Number.isFinite(v)) parts.push(clamp01(1 - v));
  };
  const addBreadth = (m?: ConcentrationMetrics | null) => {
    if (m?.nakamoto_coefficient != null && m.holders && m.holders > 0) {
      // In a well-distributed network, reaching 51% takes ~20% of the holders.
      parts.push(clamp01(m.nakamoto_coefficient / (m.holders * 0.2)));
    }
  };
  for (const m of [stake, emission]) {
    if (!m) continue;
    addBalance(m.gini);
    addBalance(m.hhi_normalized);
    addBalance(m.top_1pct_share);
    addBreadth(m);
  }
  if (parts.length === 0) return null;
  return Math.round((parts.reduce((a, b) => a + b, 0) / parts.length) * 100);
}

/** Letter grade + tone for a 0–100 decentralization score. */
export function gradeFor(score: number): { letter: string; tone: DecentralizationTone } {
  if (score >= 80) return { letter: "A", tone: "ok" };
  if (score >= 65) return { letter: "B", tone: "ok" };
  if (score >= 50) return { letter: "C", tone: "warn" };
  if (score >= 35) return { letter: "D", tone: "warn" };
  return { letter: "F", tone: "down" };
}

/** Fixed-precision ratio (e.g. Gini/HHI/entropy); em-dash on nullish/non-finite. */
export function fmtRatio(v?: number | null, dp = 3): string {
  return v == null || !Number.isFinite(v) ? "—" : v.toFixed(dp);
}

/** A 0–1 share rendered as a percentage; em-dash on nullish/non-finite. */
export function fmtPct(v?: number | null): string {
  return v == null || !Number.isFinite(v) ? "—" : `${(v * 100).toFixed(1)}%`;
}

/** A count with thousands separators; em-dash on nullish/non-finite. */
export function fmtCount(v?: number | null): string {
  return v == null || !Number.isFinite(v) ? "—" : Math.round(v).toLocaleString("en-US");
}
