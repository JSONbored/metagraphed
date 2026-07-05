// Shared builder for the 4-tier health-status Donut segments (OK / warn / Down / Unknown) used by
// the /status and /providers pages. Both pages previously inlined the identical array — same order,
// same CSS-variable colours, same "drop zero-value tiers" filter — which is easy to drift out of
// sync (#3459). The only per-page difference is the middle tier's label ("Degraded" on /status vs
// "Warn" on /providers), so that stays a parameter; everything else is centralised here.

export interface HealthStatusCounts {
  ok: number;
  warn: number;
  down: number;
  unknown: number;
}

export interface HealthStatusSegment {
  label: string;
  value: number;
  color: string;
}

export function healthStatusSegments(
  counts: HealthStatusCounts,
  options: { warnLabel?: string } = {},
): HealthStatusSegment[] {
  return [
    { label: "OK", value: counts.ok, color: "var(--health-ok, #22c55e)" },
    {
      label: options.warnLabel ?? "Degraded",
      value: counts.warn,
      color: "var(--health-warn, #f59e0b)",
    },
    { label: "Down", value: counts.down, color: "var(--health-down, #ef4444)" },
    { label: "Unknown", value: counts.unknown, color: "var(--ink-muted, #94a3b8)" },
  ].filter((s) => s.value > 0);
}
