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

const LATENCY_FREE_MS = 500;
const LATENCY_PENALTY_PER_MS = 1 / 100;
const MAX_LATENCY_PENALTY = 15;

function gradeFor(score) {
  if (score >= 99) return "A";
  if (score >= 95) return "B";
  if (score >= 90) return "C";
  if (score >= 75) return "D";
  return "F";
}

// Score a single rolled-up window of stats. Returns null when there are no
// samples (no probe data → no score, by design).
export function scoreFromStats({ samples, okCount, avgLatencyMs }) {
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
  const score = Math.max(0, Math.round(uptimeScore - latencyPenalty));
  return {
    score,
    grade: gradeFor(score),
    uptime_ratio: Number(uptimeRatio.toFixed(4)),
    avg_latency_ms: avgLatencyMs == null ? null : Math.round(avgLatencyMs),
    sample_count: samples,
  };
}

// Aggregate surface_uptime_daily rows into a subnet-level score + a per-surface
// score map. `rows`: [{ surface_id, day, samples, ok_count, avg_latency_ms }].
// `subnet` is null when there are no samples across the window.
export function computeReliability(rows, { window = null, now = null } = {}) {
  const bySurface = new Map();
  let totalSamples = 0;
  let totalOk = 0;
  let latencyWeighted = 0;
  let latencySamples = 0;
  const days = new Set();

  for (const row of rows || []) {
    const samples = Number(row.samples) || 0;
    const okCount = Number(row.ok_count) || 0;
    const latency =
      row.avg_latency_ms == null ? null : Number(row.avg_latency_ms);
    const surface = bySurface.get(row.surface_id) || {
      samples: 0,
      okCount: 0,
      latencyWeighted: 0,
      latencySamples: 0,
    };
    surface.samples += samples;
    surface.okCount += okCount;
    if (latency != null && Number.isFinite(latency)) {
      surface.latencyWeighted += latency * samples;
      surface.latencySamples += samples;
      latencyWeighted += latency * samples;
      latencySamples += samples;
    }
    bySurface.set(row.surface_id, surface);
    totalSamples += samples;
    totalOk += okCount;
    if (row.day) {
      days.add(row.day);
    }
  }

  const surfaces = {};
  for (const [surfaceId, surface] of bySurface) {
    surfaces[surfaceId] = scoreFromStats({
      samples: surface.samples,
      okCount: surface.okCount,
      avgLatencyMs: surface.latencySamples
        ? surface.latencyWeighted / surface.latencySamples
        : null,
    });
  }

  const base = scoreFromStats({
    samples: totalSamples,
    okCount: totalOk,
    avgLatencyMs: latencySamples ? latencyWeighted / latencySamples : null,
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
