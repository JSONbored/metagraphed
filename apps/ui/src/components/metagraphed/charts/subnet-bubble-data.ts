/**
 * Pure "shape the /subnets list into bubble/radar chart points" logic (#6884).
 * Kept separate from the rendering component (subnet-bubble-view.tsx) so the
 * axis-normalization and size-scaling math get direct unit coverage without a
 * React render — mirrors validator-dominance-ranking.ts's split.
 *
 * Axis defaults, chosen from what's already sortable on the /subnets table
 * today, what get_registry_leaderboards ranks by, AND verified against live
 * /api/v1/subnets + /api/v1/economics data before picking (129 live subnets,
 * 2026-07-19):
 *   - X = emission_share: already the sortable "Emission" table column; the
 *     direct client analogue of the "highest-emission" leaderboard board.
 *     127/129 subnets have a distinct value live — the best-spread economic
 *     metric already on the row (participants was rejected: 109/129 subnets
 *     sit at the exact 256-slot cap, which would collapse most bubbles onto
 *     one x position; integration_readiness was rejected for the same
 *     reason — 90/129 cluster on just two tiers, 83 and 86).
 *   - Y = surfaces_count: already the sortable "Surfaces" table column; the
 *     closest client-visible analogue to the "most-complete" /
 *     "most-enriched" boards (breadth of registered surfaces). 25 distinct
 *     values live, no single value shared by more than ~20 rows.
 *   - size = candidates_count: unreviewed candidate-surface backlog, already
 *     on every row from the base /api/v1/subnets payload (`candidate_count`,
 *     normalized by normalizeSubnet) — a third, independent dimension
 *     (community-discovered activity) that doesn't collapse onto either
 *     axis. 16 distinct values live, well spread.
 *   - color = health: already a table column + filter; the direct client
 *     analogue to the "healthiest" leaderboard board.
 * All four are already fetched for the existing table (no new query).
 *
 * Position uses PERCENTILE RANK, not linear min-max scaling. emission_share
 * and surfaces_count are both power-law distributed in the live registry
 * (most subnets earn a small emission share and carry few surfaces, with a
 * long tail of outliers) — a linear scale would crush the majority into one
 * corner. Percentile rank spreads every row across the full axis by relative
 * standing instead, which is what a "scan for outliers" view needs: the
 * bubbles that matter are the ones far from their peers, not the ones with a
 * large absolute number.
 */

/** Minimal shape this module needs from a joined /subnets row. */
export interface SubnetBubbleSource {
  netuid: number;
  name?: string | null;
  symbol?: string | null;
  emission_share?: number;
  surfaces_count?: number;
  candidates_count?: number;
  health?: string;
}

/** One chart-ready bubble, pre-positioned as percentages of the plot area. */
export interface SubnetBubblePoint {
  netuid: number;
  name?: string | null;
  symbol?: string | null;
  health: string;
  emissionShare: number;
  surfacesCount: number;
  candidatesCount: number;
  /** 0-100 position along the x axis (emission_share percentile rank), left to right. */
  xPct: number;
  /** 0-100 position along the y axis (surfaces_count percentile rank); more surfaces renders nearer the top. */
  yPct: number;
  /** 0-100 relative size, sqrt-scaled so bubble AREA (not radius) is proportional to candidatesCount. */
  sizePct: number;
  /** Bubble diameter in px, linearly interpolated between the configured min/max bounds. */
  diameterPx: number;
}

export interface SubnetBubbleLayoutOptions {
  /** Bubble diameter in px for the smallest candidates_count in the set. */
  minDiameterPx?: number;
  /** Bubble diameter in px for the largest candidates_count in the set. */
  maxDiameterPx?: number;
}

const DEFAULT_MIN_DIAMETER_PX = 14;
const DEFAULT_MAX_DIAMETER_PX = 48;
const DEFAULT_HEALTH = "unknown";

/**
 * Percentile rank (0-100) for each value in `values`, preserving input
 * order. Uses fractional ("average") ranking for ties — values sharing an
 * exact tie are placed at the mean rank position of the tied group, rather
 * than stacked in input order or all pinned to the same edge. A single value
 * (n === 1) has no meaningful spread, so it's placed at the midpoint (50).
 */
export function percentileRanks(values: readonly number[]): number[] {
  const n = values.length;
  if (n === 0) return [];
  if (n === 1) return [50];

  const order = values.map((_, i) => i).sort((a, b) => values[a] - values[b]);
  const avgPositionByValue = new Map<number, number>();
  let i = 0;
  while (i < n) {
    let j = i;
    while (j + 1 < n && values[order[j + 1]] === values[order[i]]) j++;
    avgPositionByValue.set(values[order[i]], (i + j) / 2);
    i = j + 1;
  }
  return values.map((v) => (avgPositionByValue.get(v)! / (n - 1)) * 100);
}

/**
 * Build normalized bubble points from joined /subnets rows. Rows missing
 * either axis metric (emission_share or surfaces_count) are excluded —
 * there's nothing meaningful to plot without both coordinates.
 * `candidates_count` and `health` are treated as optional/defaultable since
 * they only drive size and color, not position.
 */
export function buildSubnetBubblePoints(
  rows: readonly SubnetBubbleSource[],
  options: SubnetBubbleLayoutOptions = {},
): SubnetBubblePoint[] {
  const minDiameterPx = options.minDiameterPx ?? DEFAULT_MIN_DIAMETER_PX;
  const maxDiameterPx = options.maxDiameterPx ?? DEFAULT_MAX_DIAMETER_PX;

  const plottable = rows.filter(
    (r): r is SubnetBubbleSource & { emission_share: number; surfaces_count: number } =>
      typeof r.emission_share === "number" && typeof r.surfaces_count === "number",
  );
  if (plottable.length === 0) return [];

  const xRanks = percentileRanks(plottable.map((r) => r.emission_share));
  const yRanksRaw = percentileRanks(plottable.map((r) => r.surfaces_count));
  const sizes = plottable.map((r) => r.candidates_count ?? 0);
  const sizeMax = Math.max(...sizes);

  return plottable.map((r, idx) => {
    const size = r.candidates_count ?? 0;
    const sizePct = sizeMax > 0 ? Math.sqrt(size / sizeMax) * 100 : 0;
    const diameterPx = minDiameterPx + (sizePct / 100) * (maxDiameterPx - minDiameterPx);
    return {
      netuid: r.netuid,
      name: r.name,
      symbol: r.symbol,
      health: r.health ?? DEFAULT_HEALTH,
      emissionShare: r.emission_share,
      surfacesCount: r.surfaces_count,
      candidatesCount: size,
      xPct: xRanks[idx],
      // Invert so higher surfaces_count renders nearer the top of the plot area.
      yPct: 100 - yRanksRaw[idx],
      sizePct,
      diameterPx,
    };
  });
}
