import { Chip, type ChipTone } from "./chip";

export type HealthStatus = "ok" | "warn" | "down" | "unknown";

const STATUS_LABEL: Record<HealthStatus, string> = {
  ok: "Healthy",
  warn: "Degraded",
  down: "Down",
  unknown: "Unknown",
};

const STATUS_TONE: Record<HealthStatus, ChipTone> = {
  ok: "ok",
  warn: "warn",
  down: "down",
  unknown: "muted",
};

export interface StatusBadgeProps {
  status: HealthStatus;
  /** Optional override label (e.g. "Live", "Stale"). Defaults to health copy. */
  label?: string;
  /** Show a pulsing dot for live/monitored surfaces. */
  live?: boolean;
  title?: string;
  className?: string;
}

/**
 * Thin wrapper on Chip bound to the shared health tone vocabulary. Use this
 * wherever the app conveys endpoint/subnet health so the color mapping stays
 * consistent with health-palette tokens.
 */
export function StatusBadge({ status, label, live, title, className }: StatusBadgeProps) {
  return (
    <Chip
      tone={STATUS_TONE[status]}
      dot={live}
      title={title ?? STATUS_LABEL[status]}
      className={className}
    >
      {label ?? STATUS_LABEL[status]}
    </Chip>
  );
}
