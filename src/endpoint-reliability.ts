// Per-endpoint reliability, read once per prober run (#9357).
//
// The pool's ranking used to break ties on `latency_ms` from a single probe. When every
// candidate is `status: "ok"` — the normal case — that one sample IS the ranking, and it
// is taken against `system_health`, an 87-byte response. Measured 2026-08-04, that made
// the pool prefer the worst upstream it had by an order of magnitude:
//
//   upstream                                   probe latency   15.4 MB call
//   wss://entrypoint-finney.opentensor.ai:443      510ms           8.6s
//   wss://archive.chain.opentensor.ai:443          848ms          11.1s
//   wss://bittensor-finney...onfinality/public-ws  241ms          78.6s   <- ranked first
//
// Ranking on throughput would mean probing with a large body, which is real recurring
// bandwidth. This does something cheaper and, for the "which of these is a good
// neighbour" question, better: it ranks on how the endpoint has BEHAVED, from
// `surface_uptime_daily` — a rollup we already write and already query elsewhere. One
// D1 read per 15-minute prober run, no new probe traffic, and a 30-day window instead
// of one sample.
//
// It does not claim to predict throughput. It replaces "whoever answered a tiny request
// fastest in the last 15 minutes" with "whoever has actually stayed up and responsive
// for a month", which is the property a load balancer wants from a tie-break.
import { d1All, type ObservationsReadDb } from "./analytics-live.ts";
import { scoreFromStats } from "./reliability.ts";
import { utcWindowCutoffDay } from "./health-serving.ts";

/** Days of history behind an endpoint's reliability score. */
export const RELIABILITY_WINDOW_DAYS = 30;

// A day contributes to the latency mean only when it HAS one; weighting by total
// samples would let a day of pure failures (no latency recorded) drag the mean toward
// zero and flatter the endpoint. Mirrors bulk-health-trends.ts's own weighting.
const LATENCY_WEIGHT =
  "SUM(CASE WHEN avg_latency_ms IS NOT NULL THEN COALESCE(latency_samples, samples) ELSE 0 END)";

export interface EndpointReliability {
  score: number;
  grade: string;
  uptime_ratio: number;
  sample_count: number;
}

/**
 * `{ surface_key -> reliability }` over the trailing window, or `{}` on any failure.
 *
 * Empty rather than throwing: this is a ranking refinement on a path whose job is to
 * stay available. Losing it costs a better tie-break, and the comparator falls back to
 * the single-probe latency it used before — a degraded ranking is survivable, a prober
 * run that dies because a rollup query failed is not.
 */
export async function loadEndpointReliability(
  db: ObservationsReadDb | null | undefined,
  now: number = Date.now(),
): Promise<Record<string, EndpointReliability>> {
  if (!db) return {};
  const cutoffDay = utcWindowCutoffDay(now, RELIABILITY_WINDOW_DAYS);
  let rows: Record<string, unknown>[];
  try {
    rows = await d1All(
      db,
      `SELECT COALESCE(surface_key, surface_id) AS key,
              SUM(samples)   AS samples,
              SUM(ok_count)  AS ok_count,
              ${LATENCY_WEIGHT} AS latency_samples,
              CASE
                WHEN ${LATENCY_WEIGHT} > 0
                  THEN CAST(SUM(CASE WHEN avg_latency_ms IS NOT NULL
                                     THEN avg_latency_ms * COALESCE(latency_samples, samples)
                                     ELSE 0 END) AS REAL) / ${LATENCY_WEIGHT}
                ELSE NULL
              END AS avg_latency_ms
       FROM surface_uptime_daily
       WHERE day >= ?
       GROUP BY COALESCE(surface_key, surface_id)`,
      [cutoffDay],
    );
  } catch {
    return {};
  }

  const out: Record<string, EndpointReliability> = {};
  for (const row of rows || []) {
    const key = row.key == null ? "" : String(row.key);
    if (!key) continue;
    // Keyed on surface_key with a surface_id fallback, the rename-proof identity from
    // #1005 — a surface renamed inside the window stays ONE bucket rather than
    // splitting into two half-length ones that both look under-sampled.
    const score = scoreFromStats({
      samples: Number(row.samples) || 0,
      okCount: Number(row.ok_count) || 0,
      avgLatencyMs:
        row.avg_latency_ms == null ? null : Number(row.avg_latency_ms),
      latencySamples: Number(row.latency_samples) || 0,
    });
    if (!score) continue;
    out[key] = {
      score: score.score,
      grade: score.grade,
      uptime_ratio: score.uptime_ratio,
      sample_count: score.sample_count,
    };
  }
  return out;
}
