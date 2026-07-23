import { classNames } from "@/lib/format";

const tierLabels: Record<string, string> = {
  buildable: "Buildable",
  emerging: "Emerging",
  "identity-only": "Identity only",
  dormant: "Dormant",
};

export interface ReadinessGaugeProps {
  score?: number;
  tier?: string;
  details?: string[];
  compact?: boolean;
  className?: string;
}

/** Compact 0–100 integration-readiness gauge using the shared status palette. */
export function ReadinessGauge({
  score,
  tier,
  details,
  compact = false,
  className,
}: ReadinessGaugeProps) {
  if (score == null && !tier) {
    return <span className="font-mono text-[11px] text-ink-muted">—</span>;
  }

  const value = Math.max(0, Math.min(100, score ?? 0));
  const label = tierLabels[tier ?? ""] ?? tier ?? "Not classified";
  const fill =
    value >= 75
      ? "bg-health-ok"
      : value >= 45
        ? "bg-health-warn"
        : value > 0
          ? "bg-health-down"
          : "bg-health-unknown";
  const detail = details?.length ? ` Services: ${details.join(", ")}.` : "";
  const description = `Integration readiness ${value} out of 100. ${label}.${detail}`;

  return (
    <span
      tabIndex={0}
      aria-label={description}
      title={description}
      className={classNames(
        "mg-focus-ring inline-grid items-center gap-2",
        compact
          ? "min-w-[78px] grid-cols-[minmax(0,1fr)_1.75rem]"
          : "min-w-[96px] grid-cols-[minmax(0,1fr)_2rem]",
        className,
      )}
    >
      <span
        className="relative h-1.5 overflow-hidden rounded-full bg-surface-2"
        aria-hidden
      >
        <span
          className={classNames("absolute inset-y-0 left-0 rounded-full", fill)}
          style={{ width: `${value}%` }}
        />
      </span>
      <span className="text-right font-mono text-[11px] tabular-nums text-ink-strong">
        {value}
      </span>
    </span>
  );
}
