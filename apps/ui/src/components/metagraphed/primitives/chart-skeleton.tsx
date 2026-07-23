import { classNames } from "@/lib/metagraphed/format";

export interface ChartSkeletonProps {
  /** Height in px, matches the eventual chart height to prevent layout shift. */
  height?: number;
  /** Show a faint baseline + a shimmer trace so it reads as "a chart is loading". */
  variant?: "spark" | "bars" | "area";
  className?: string;
  label?: string;
}

/**
 * ChartSkeleton — shimmer placeholder sized to match sparklines / bar charts /
 * area charts. Renders the same footprint the resolved chart will occupy so
 * hydration and cache-restore transitions don't cause layout shift.
 */
export function ChartSkeleton({
  height = 40,
  variant = "spark",
  className,
  label = "Loading chart",
}: ChartSkeletonProps) {
  return (
    <div
      role="img"
      aria-label={label}
      className={classNames(
        "mg-chart-skeleton relative w-full overflow-hidden rounded-md",
        "border border-border/60 bg-surface-2/40",
        className,
      )}
      style={{ height }}
    >
      {/* baseline hairline */}
      <div className="pointer-events-none absolute inset-x-2 bottom-1 h-px bg-border" aria-hidden />
      {variant === "bars" ? (
        <div className="absolute inset-2 flex items-end gap-[3px]" aria-hidden>
          {Array.from({ length: 16 }).map((_, i) => (
            <div
              key={i}
              className="flex-1 rounded-sm bg-ink-strong/10 animate-pulse"
              style={{ height: `${20 + ((i * 17) % 70)}%` }}
            />
          ))}
        </div>
      ) : null}
      {variant === "area" ? (
        <div
          className="absolute inset-0 animate-pulse"
          aria-hidden
          style={{
            background:
              "linear-gradient(to top, color-mix(in oklab, var(--accent) 12%, transparent), transparent 70%)",
          }}
        />
      ) : null}
      {/* shimmer sweep */}
      <div
        className="pointer-events-none absolute inset-y-0 -left-full w-1/2 mg-shimmer-sweep"
        aria-hidden
      />
    </div>
  );
}
