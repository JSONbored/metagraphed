import { classNames } from "@/lib/format";

export type TableSkeletonDensity = "comfortable" | "compact";

export interface TableSkeletonProps {
  rows?: number;
  columns?: number;
  density?: TableSkeletonDensity;
  withHeader?: boolean;
  className?: string;
}

/**
 * Batch B primitive. Hairline row skeletons matching ListShell density —
 * every list route uses this so the loading state looks identical across
 * /subnets, /endpoints, /surfaces, /providers, /blocks, etc.
 */
export function TableSkeleton({
  rows = 8,
  columns = 5,
  density = "comfortable",
  withHeader = true,
  className,
}: TableSkeletonProps) {
  const rowPad = density === "compact" ? "py-2" : "py-3";
  return (
    <div
      role="status"
      aria-live="polite"
      aria-busy="true"
      className={classNames(
        "rounded border border-border bg-card overflow-hidden",
        className,
      )}
    >
      <span className="sr-only">Loading table…</span>
      {withHeader ? (
        <div
          className="grid gap-3 border-b border-border bg-surface-2 px-4 py-2"
          style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
        >
          {Array.from({ length: columns }).map((_, c) => (
            <span
              key={`h-${c}`}
              className="h-3 rounded bg-border/70"
              style={{ width: `${40 + ((c * 17) % 40)}%` }}
            />
          ))}
        </div>
      ) : null}
      <div>
        {Array.from({ length: rows }).map((_, r) => (
          <div
            key={r}
            className={classNames(
              "grid gap-3 border-b border-border/60 px-4 last:border-b-0",
              rowPad,
            )}
            style={{
              gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
            }}
          >
            {Array.from({ length: columns }).map((_, c) => (
              <span
                key={`${r}-${c}`}
                className="h-3 rounded bg-border/50"
                style={{
                  width: `${45 + ((r * 13 + c * 29) % 45)}%`,
                  animation: "mg-skel-pulse 1.4s ease-in-out infinite",
                  animationDelay: `${((r + c) % 6) * 90}ms`,
                }}
              />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
