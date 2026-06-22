import { classNames } from "@/lib/metagraphed/format";

/**
 * Inline placeholder matching SparkLegend's baseline footprint — used during
 * the loader→render gap on tables so sparkline cells reserve their final
 * width/height and avoid CLS as data settles in.
 */
export function SparkLegendSkeleton({
  width = 120,
  height = 22,
  className,
  withDot = true,
}: {
  width?: number;
  height?: number;
  className?: string;
  withDot?: boolean;
}) {
  return (
    <span
      aria-hidden="true"
      role="presentation"
      data-mg-skel
      style={{ width, height }}
      className={classNames("inline-flex items-center gap-1 align-middle", className)}
    >
      {withDot ? (
        <span className="size-1.5 rounded-full bg-surface motion-safe:animate-pulse" />
      ) : null}
      <span className="flex-1 h-1.5 rounded-full bg-surface motion-safe:animate-pulse" />
      <span className="w-6 h-1.5 rounded-full bg-surface motion-safe:animate-pulse opacity-70" />
    </span>
  );
}

/**
 * Compact freshness/timestamp placeholder for "X ago" cells.
 */
export function FreshnessCellSkeleton({ className }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={classNames(
        "inline-block h-3 w-14 rounded bg-surface motion-safe:animate-pulse align-middle",
        className,
      )}
    />
  );
}
