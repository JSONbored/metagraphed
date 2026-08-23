import type { EndpointIncident } from "./types";
import { formatDecimal } from "@/lib/metagraphed/format";

export const DAY_MS = 24 * 60 * 60 * 1000;

/** Only a `down` incident is an outage; degraded/warn windows keep the endpoint up. */
function isOutage(incident: EndpointIncident): boolean {
  return String(incident.state ?? "") === "down";
}

/**
 * Trailing-window uptime for one endpoint as a 0–100 percentage, from the
 * endpoint-incidents feed: the union of its `down` intervals clipped to the
 * last `days` days, as a share of that window. `null` when the feed has no
 * incident for the endpoint at all — no signal, not 100%.
 */
export function sevenDayUptime(
  endpointId: string,
  incidents: readonly EndpointIncident[],
  now: number = Date.now(),
  days = 7,
): number | null {
  const relevant = incidents.filter((i) => i.endpoint_id === endpointId);
  if (relevant.length === 0) return null;
  const windowStart = now - days * DAY_MS;
  const intervals = relevant
    .filter(isOutage)
    .map((i) => {
      const start = i.started_at ? Date.parse(i.started_at) : NaN;
      const end = i.ended_at ? Date.parse(i.ended_at) : now;
      return [Math.max(start, windowStart), Math.min(end, now)] as const;
    })
    .filter(([s, e]) => Number.isFinite(s) && Number.isFinite(e) && e > s)
    .sort((a, b) => a[0] - b[0]);
  let downMs = 0;
  let cursor = -Infinity;
  for (const [s, e] of intervals) {
    const from = Math.max(s, cursor);
    if (e > from) downMs += e - from;
    cursor = Math.max(cursor, e);
  }
  const windowMs = days * DAY_MS;
  return Math.max(0, Math.min(100, (1 - downMs / windowMs) * 100));
}

/** `98.6%`, or `—` when unknown. */
export function formatUptime(pct: number | null): string {
  return pct === null ? "—" : `${formatDecimal(pct, 1)}%`;
}

/** The health text token for an uptime percentage (the 99% / 95% bands every uptime view uses). */
export function uptimeToneClass(pct: number | null): string {
  if (pct === null) return "text-ink-muted";
  if (pct >= 99) return "text-health-ok";
  if (pct >= 95) return "text-health-warn";
  return "text-health-down";
}
