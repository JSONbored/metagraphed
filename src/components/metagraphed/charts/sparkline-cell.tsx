import { Sparkline } from "./sparkline";
import type { HealthState } from "@/lib/metagraphed/types";
import { classNames } from "@/lib/metagraphed/format";

interface Props {
  values: number[];
  health?: HealthState;
  width?: number;
  height?: number;
  className?: string;
  label?: string;
  /** Optional trailing numeric (e.g. "120ms"). */
  trailing?: string;
}

const TONE: Record<HealthState, string> = {
  ok: "var(--health-ok)",
  warn: "var(--health-warn)",
  down: "var(--health-down)",
  unknown: "var(--health-unknown)",
};

/**
 * Compact sparkline cell for tables. Wraps Sparkline with a health-tinted
 * stroke, trailing value, and right-aligned layout suitable for table rows.
 */
export function SparklineCell({
  values,
  health = "unknown",
  width = 80,
  height = 22,
  className,
  label,
  trailing,
}: Props) {
  const color = TONE[health] ?? TONE.unknown;
  return (
    <div
      className={classNames("inline-flex items-center gap-2 align-middle", className)}
      title={label}
    >
      <Sparkline values={values} width={width} height={height} color={color} ariaLabel={label} />
      {trailing ? (
        <span className="font-mono text-[11px] text-ink-muted tabular-nums shrink-0">
          {trailing}
        </span>
      ) : null}
    </div>
  );
}
