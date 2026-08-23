import { classNames } from "@/lib/format";

// A local, portable equivalent of apps/ui's schema-derived HealthState: it is
// already treated as `| string` at every call site here (with a runtime string
// fallback), so a plain literal union preserves identical behavior without
// importing the app's OpenAPI contract.
type HealthState = "ok" | "warn" | "down" | "unknown";

/**
 * Universal health indicator.
 *
 * Minimal pulsing dot with optional label. The dot itself is the primary
 * affordance — color carries the state, a subtle pulse signals attention for
 * `warn` and `down`. Reduced-motion users see static dots (CSS handles this).
 *
 * Variants:
 *   - `dot`   compact, dot-only (table rows, sidebar, list rows)
 *   - `label` dot + state name (detail headers, summaries)
 *
 * Color mapping is fixed and documented:
 *   green   ok        — probes succeeding
 *   amber   warn      — degraded / high latency
 *   red     down      — failing probes / open incident
 *   grey    unknown   — never probed, offline, or stale
 */
type Variant = "dot" | "label";

const STATE_LABEL: Record<string, string> = {
  ok: "OK",
  warn: "Degraded",
  degraded: "Degraded",
  down: "Down",
  offline: "Offline",
  unknown: "Unknown",
};

const STATE_COLOR: Record<string, string> = {
  ok: "bg-health-ok",
  warn: "bg-health-warn",
  degraded: "bg-health-warn",
  down: "bg-health-down",
  offline: "bg-health-down",
  unknown: "bg-health-unknown",
};

function normalize(state?: HealthState | string): string {
  const s = (state as string) ?? "unknown";
  return STATE_COLOR[s] ? s : "unknown";
}

export function HealthDot({
  state,
  variant = "dot",
  className,
}: {
  state?: HealthState | string;
  variant?: Variant;
  className?: string;
}) {
  const key = normalize(state);
  const color = STATE_COLOR[key];
  const label = STATE_LABEL[key];
  const dot = (
    <span
      role="img"
      aria-label={`Health: ${label.toLowerCase()}`}
      className={classNames(
        "relative inline-block size-2 rounded-full mg-dot shrink-0",
        color,
        className,
      )}
    />
  );

  if (variant === "dot") return dot;

  return (
    <span className="inline-flex items-center gap-1.5">
      {dot}
      <span className="text-13 font-medium text-ink">{label}</span>
    </span>
  );
}
