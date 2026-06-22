/**
 * Centralized attribution copy for every metric surfaced through MetricCell
 * and SparkLegend. One place to edit so source / staleness language never
 * drifts across pages.
 *
 * Add a new entry here before wiring a new metric through MetricCell — never
 * inline the prose in component code.
 */

export interface MetricSource {
  /** Short label shown in tooltips and as section captions. */
  metric: string;
  /** Clause describing the upstream artifact / measurement. */
  source: string;
  /** One-line staleness behavior. */
  staleness: string;
  /** Default window label (e.g. "latest snapshot", "7d"). */
  defaultWindow?: string;
}

export const METRIC_SOURCES = {
  health: {
    metric: "Health trend",
    source: "Probe history · /api/v1/health",
    staleness:
      "Snapshots older than 5m turn amber; >1h dim. Live SSE replaces stale samples in place.",
    defaultWindow: "24h",
  },
  freshness: {
    metric: "Freshness",
    source: "Source snapshots · /api/v1/freshness",
    staleness: "Last-seen aged >15m amber, >24h marked stale. Surfaces never deleted on staleness.",
    defaultWindow: "latest snapshot",
  },
  drift: {
    metric: "Schema drift",
    source: "Schema diff stream · /api/v1/schemas",
    staleness:
      "Diff window relative to last verified snapshot; stable schemas dim after 24h with no change.",
    defaultWindow: "24h",
  },
  coverage: {
    metric: "Registry coverage",
    source: "Curation overlay · /api/v1/coverage",
    staleness: "Coverage levels are review-driven; updated when maintainers reclassify.",
    defaultWindow: "latest review",
  },
  uptime: {
    metric: "Uptime",
    source: "Probe history · /api/v1/endpoint-pools",
    staleness:
      "Rolling window of probe results. Single failures shown as warn before flipping to down.",
    defaultWindow: "24h",
  },
  latency: {
    metric: "Latency",
    source: "Probe samples · /api/v1/endpoint-pools",
    staleness:
      "p50 of probes in window. Cells with <3 samples in window render as 'thin' instead of a number.",
    defaultWindow: "1h",
  },
  economics: {
    metric: "Economics",
    source: "Native chain reads · /api/v1/subnets",
    staleness:
      "Updated on block-tempo cadence; mirrors Bittensor metagraph. Pre-2000 timestamps treated as unknown.",
    defaultWindow: "latest tempo",
  },
  endpoints: {
    metric: "Endpoint inventory",
    source: "Verified surfaces · /api/v1/endpoints",
    staleness:
      "Surfaces remain listed when stale; auth_required and rate_limit notes always shown.",
    defaultWindow: "latest snapshot",
  },
  gaps: {
    metric: "Open gaps",
    source: "Review queue · /api/v1/gaps",
    staleness:
      "Public read-only review state. Updated when maintainers close or open gaps in GitHub.",
    defaultWindow: "latest review",
  },
  candidates: {
    metric: "Candidates",
    source: "Discovery leads · /api/v1/candidates",
    staleness:
      "Unverified leads. Always labelled candidate until review — never treat as live registry truth.",
    defaultWindow: "latest discovery",
  },
} as const satisfies Record<string, MetricSource>;

export type MetricKey = keyof typeof METRIC_SOURCES;

/** Resolve a metric attribution by key with safe fallback for legacy callers. */
export function resolveMetric(
  key: MetricKey | undefined,
  fallback?: Partial<MetricSource>,
): MetricSource {
  if (key && METRIC_SOURCES[key]) return METRIC_SOURCES[key];
  return {
    metric: fallback?.metric ?? "Metric",
    source: fallback?.source ?? "Registry artifacts",
    staleness: fallback?.staleness ?? "Refresh follows upstream artifact cadence.",
    defaultWindow: fallback?.defaultWindow,
  };
}
