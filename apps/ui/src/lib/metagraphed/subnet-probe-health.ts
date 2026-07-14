import type { EndpointIncident, HealthState, HealthSummary } from "./types";

/**
 * Authoritative subnet health for the UI: probe-derived status from
 * `/api/v1/health` (per-subnet map), `/api/v1/subnets/{n}/health` (counts),
 * and — when those are still unknown — active `/api/v1/endpoint-incidents` for
 * that netuid (also probe-derived). Never invent HealthState from chain
 * lifecycle `status` ("active") (#5332).
 */

export type SubnetProbeHealthCounts = Pick<HealthSummary, "ok" | "warn" | "down" | "unknown">;

/** Worst-of rollup from per-surface probe counts (down > warn > ok > unknown). */
export function healthSummaryToState(counts: SubnetProbeHealthCounts | undefined): HealthState {
  if (!counts) return "unknown";
  if ((counts.down ?? 0) > 0) return "down";
  if ((counts.warn ?? 0) > 0) return "warn";
  if ((counts.ok ?? 0) > 0) return "ok";
  if ((counts.unknown ?? 0) > 0) return "unknown";
  return "unknown";
}

/**
 * Resolve the single canonical probe health for a subnet.
 * Prefer the global health-map entry (same source as the /subnets table);
 * fall back to rolling up the per-subnet health summary counts; then active
 * endpoint incidents for that netuid when the rollup is still unknown.
 */
export function resolveSubnetProbeHealth(opts: {
  mapHealth?: HealthState | null;
  summary?: SubnetProbeHealthCounts | null;
  incidentHealth?: HealthState | null;
}): HealthState {
  if (opts.mapHealth === "ok" || opts.mapHealth === "warn" || opts.mapHealth === "down") {
    return opts.mapHealth;
  }
  if (opts.mapHealth === "unknown" || opts.mapHealth == null) {
    const fromSummary = healthSummaryToState(opts.summary ?? undefined);
    if (fromSummary !== "unknown") return fromSummary;
    if (opts.incidentHealth === "down" || opts.incidentHealth === "warn") {
      return opts.incidentHealth;
    }
    return "unknown";
  }
  return healthSummaryToState(opts.summary ?? undefined);
}

/** Coerce loose API netuid values so `"1" === 1` comparisons never miss. */
export function coerceNetuid(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) {
    const n = Number(value);
    return Number.isInteger(n) && n >= 0 ? n : null;
  }
  return null;
}

export function sameNetuid(a: unknown, b: unknown): boolean {
  const left = coerceNetuid(a);
  const right = coerceNetuid(b);
  return left != null && right != null && left === right;
}

/**
 * Worst active endpoint-incident severity for one netuid (down > warn).
 * Incidents use the normalised UI state (`ok|warn|down|unknown`) after
 * {@link normalizeIncident}; tolerate a few raw synonyms too.
 */
export function worstActiveIncidentHealth(
  incidents: EndpointIncident[] | undefined,
  netuid: number,
): HealthState | undefined {
  if (!incidents?.length) return undefined;
  let worst: HealthState | undefined;
  for (const i of incidents) {
    if (!sameNetuid(i.netuid, netuid)) continue;
    if (i.ended_at) continue;
    const state = String(i.state ?? "").toLowerCase();
    if (state === "down" || state === "failed") return "down";
    if (state === "warn" || state === "degraded") worst = "warn";
  }
  return worst;
}

/** Parse `/subnets/{netuid}` from a pathname; null when not on a subnet page. */
export function netuidFromPathname(pathname: string): number | null {
  const m = /^\/subnets\/(\d+)(?:\/|$)/.exec(pathname);
  if (!m) return null;
  return coerceNetuid(m[1]);
}
