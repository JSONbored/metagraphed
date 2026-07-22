// Reliability scoring over the durable daily uptime history (surface_uptime_daily).
//
// A reliability score (0–100) is a single, comparable signal of how dependable a
// subnet's surfaces have been over a window. It is computed ONLY from real probe
// history — `null` when there is no data (never a fabricated value).
//
// Formula (documented + stable so the score is reproducible and explainable):
//   uptimeScore   = uptime_ratio * 100                     (sample-weighted, exact)
//   latencyPenalty = clamp((avg_latency_ms - 500) / 100, 0, 15)
//                     -> 0 at/under 500ms, +1 point per extra 100ms, capped at 15
//   score         = round(max(0, uptimeScore - latencyPenalty))
// Uptime dominates; latency is a mild secondary penalty. Grades: A>=99, B>=95,
// C>=90, D>=75, else F.

type Row = Record<string, unknown>;

const LATENCY_FREE_MS = 500;
const LATENCY_PENALTY_PER_MS = 1 / 100;
const MAX_LATENCY_PENALTY = 15;

function gradeFor(score: number): string {
  if (score >= 99) return "A";
  if (score >= 95) return "B";
  if (score >= 90) return "C";
  if (score >= 75) return "D";
  return "F";
}

// Round the displayed uptime ratio to 4 decimals WITHOUT letting a sub-perfect
// ratio round up to an exact 1: (0.99996).toFixed(4) === "1.0000", which would
// make a 99.996%-uptime surface report `uptime_ratio: 1` and render a "100%"
// badge (the formatUptimePercent `value < 1` guard can't recover it — the ratio
// is already collapsed to 1 upstream). Only a genuine okCount === samples ratio
// (exactly 1) keeps the perfect value; any sub-1 ratio clamps to the largest
// 4-decimal value below 1.
export function displayUptimeRatio(ratio: number): number {
  const rounded = Number(ratio.toFixed(4));
  return rounded >= 1 && ratio < 1 ? 0.9999 : rounded;
}

export interface ReliabilityScore {
  score: number;
  grade: string;
  uptime_ratio: number;
  avg_latency_ms: number | null;
  sample_count: number;
  latency_sample_count: number;
}

// Score a single rolled-up window of stats. Returns null when there are no
// samples (no probe data → no score, by design). `latencySamples` is how many
// healthy probes backed `avgLatencyMs`, distinct from `samples` (the uptime total).
export function scoreFromStats({
  samples,
  okCount,
  avgLatencyMs,
  latencySamples = 0,
}: {
  samples: number;
  okCount: number;
  avgLatencyMs: number | null;
  latencySamples?: number;
}): ReliabilityScore | null {
  if (!samples) {
    return null;
  }
  const uptimeRatio = okCount / samples;
  const uptimeScore = uptimeRatio * 100;
  const latencyPenalty =
    avgLatencyMs == null
      ? 0
      : Math.min(
          MAX_LATENCY_PENALTY,
          Math.max(
            0,
            (avgLatencyMs - LATENCY_FREE_MS) * LATENCY_PENALTY_PER_MS,
          ),
        );
  // Anti-overstatement clamp, the same guard this file already applies to the
  // displayed `uptime_ratio` (displayUptimeRatio above) and the turnover
  // `stability_score`/retention composite (#2299): a sub-perfect uptime ratio in
  // [0.995, 1) rounds up — `Math.round(99.5) === 100` — which would headline a
  // flawless `score: 100` (grade A) for a surface that actually had downtime,
  // contradicting its own sub-1 `uptime_ratio`. Only a genuine okCount === samples
  // ratio (exactly 1) keeps the perfect 100; gradeFor(99) is still "A".
  let score = Math.max(0, Math.round(uptimeScore - latencyPenalty));
  if (score >= 100 && uptimeRatio < 1) score = 99;
  return {
    score,
    grade: gradeFor(score),
    uptime_ratio: displayUptimeRatio(uptimeRatio),
    avg_latency_ms: avgLatencyMs == null ? null : Math.round(avgLatencyMs),
    sample_count: samples,
    latency_sample_count: latencySamples,
  };
}

export interface ReliabilityResult {
  subnet:
    | (ReliabilityScore & {
        window: unknown;
        surface_count: number;
        day_count: number;
        computed_at: unknown;
      })
    | null;
  surfaces: Record<string, ReliabilityScore | null>;
}

// Aggregate surface_uptime_daily rows into a subnet-level score + a per-surface
// score map. `rows`: [{ surface_id, surface_key?, day, samples, ok_count,
// avg_latency_ms, latency_samples }]. Per-surface aggregation keys on the stable
// `surface_key` (the rename-proof identity from #1005), falling back to
// `surface_id` for legacy rows that predate it — so a surface renamed within the
// window stays ONE bucket instead of splitting (which would inflate
// surface_count and fragment its score). The window mean is weighted by
// latency_samples (healthy readings per day), not total samples; legacy rows
// fall back to total samples. `subnet` is null when there are no samples.
export function computeReliability(
  rows: Row[] | null | undefined,
  { window = null, now = null }: { window?: unknown; now?: unknown } = {},
): ReliabilityResult {
  const bySurface = new Map<
    unknown,
    {
      samples: number;
      okCount: number;
      latencyWeighted: number;
      latencySamples: number;
    }
  >();
  let totalSamples = 0;
  let totalOk = 0;
  let latencyWeighted = 0;
  let latencySamples = 0;
  const days = new Set<unknown>();

  for (const row of rows || []) {
    const samples = Number(row.samples) || 0;
    const okCount = Number(row.ok_count) || 0;
    const latency =
      row.avg_latency_ms == null ? null : Number(row.avg_latency_ms);
    // Healthy readings behind this day's mean; legacy rows lack it → total samples.
    const latencyCount =
      row.latency_samples == null ? samples : Number(row.latency_samples) || 0;
    // Stable identity first: a surface keeps one `surface_key` across renames,
    // while `surface_id` can change (and legacy rows only have surface_id).
    const surfaceKey = row.surface_key || row.surface_id;
    const surface = bySurface.get(surfaceKey) || {
      samples: 0,
      okCount: 0,
      latencyWeighted: 0,
      latencySamples: 0,
    };
    surface.samples += samples;
    surface.okCount += okCount;
    if (latency != null && Number.isFinite(latency) && latencyCount > 0) {
      surface.latencyWeighted += latency * latencyCount;
      surface.latencySamples += latencyCount;
      latencyWeighted += latency * latencyCount;
      latencySamples += latencyCount;
    }
    bySurface.set(surfaceKey, surface);
    totalSamples += samples;
    totalOk += okCount;
    if (row.day) {
      days.add(row.day);
    }
  }

  const surfaces: Record<string, ReliabilityScore | null> = {};
  for (const [surfaceKey, surface] of bySurface) {
    surfaces[surfaceKey as string] = scoreFromStats({
      samples: surface.samples,
      okCount: surface.okCount,
      avgLatencyMs: surface.latencySamples
        ? surface.latencyWeighted / surface.latencySamples
        : null,
      latencySamples: surface.latencySamples,
    });
  }

  const base = scoreFromStats({
    samples: totalSamples,
    okCount: totalOk,
    avgLatencyMs: latencySamples ? latencyWeighted / latencySamples : null,
    latencySamples,
  });
  const subnet = base
    ? {
        ...base,
        window,
        surface_count: bySurface.size,
        day_count: days.size,
        computed_at: now,
      }
    : null;

  return { subnet, surfaces };
}
