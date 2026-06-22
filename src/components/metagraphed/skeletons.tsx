import { classNames } from "@/lib/metagraphed/format";

/**
 * Layout-tuned skeletons matched to the most common Metagraphed page shapes.
 * Use these in place of generic spinners so first paint mirrors the final
 * layout (no jarring blank-then-pop).
 */

function Bar({ className }: { className?: string }) {
  return <div className={classNames("animate-pulse rounded bg-surface", className)} />;
}

export function KpiStripSkeleton({ count = 4 }: { count?: number }) {
  return (
    <div className="mg-kpi-strip">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="flex flex-col gap-2">
          <Bar className="h-3 w-20" />
          <Bar className="h-7 w-28" />
          <Bar className="h-2.5 w-16" />
        </div>
      ))}
    </div>
  );
}

export function HeroSkeleton() {
  return (
    <div className="mg-hero-slab py-10">
      <div className="flex flex-col gap-4">
        <Bar className="h-3 w-32" />
        <Bar className="h-9 w-2/3 max-w-xl" />
        <Bar className="h-4 w-full max-w-2xl" />
        <Bar className="h-4 w-1/2 max-w-md" />
      </div>
      <div className="mt-8">
        <KpiStripSkeleton />
      </div>
    </div>
  );
}

export function TableRowsSkeleton({ rows = 8, cols = 5 }: { rows?: number; cols?: number }) {
  return (
    <div className="rounded border border-border bg-card overflow-hidden">
      <div
        className="border-b border-border bg-surface/40 px-3 py-2 grid gap-3"
        style={{ gridTemplateColumns: `1.4fr repeat(${cols - 1}, 1fr)` }}
      >
        {Array.from({ length: cols }).map((_, i) => (
          <Bar key={i} className="h-3" />
        ))}
      </div>
      {Array.from({ length: rows }).map((_, r) => (
        <div
          key={r}
          className="border-b border-border/60 px-3 py-3 grid gap-3 last:border-b-0"
          style={{ gridTemplateColumns: `1.4fr repeat(${cols - 1}, 1fr)` }}
        >
          {Array.from({ length: cols }).map((_, c) => (
            <Bar
              key={c}
              className={classNames(
                "h-3",
                c === 0 ? "w-3/4" : c === cols - 1 ? "w-12 justify-self-end" : "w-2/3",
              )}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

export function CardGridSkeleton({ count = 6, className }: { count?: number; className?: string }) {
  return (
    <div className={classNames("grid gap-3 sm:grid-cols-2 lg:grid-cols-3", className)}>
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="rounded border border-border bg-card p-4 flex flex-col gap-3">
          <div className="flex items-center gap-2">
            <Bar className="size-7 rounded-md" />
            <Bar className="h-3.5 w-24" />
          </div>
          <Bar className="h-3 w-full" />
          <Bar className="h-3 w-4/5" />
          <div className="mt-2 flex items-center gap-2">
            <Bar className="h-5 w-14 rounded-full" />
            <Bar className="h-5 w-10 rounded-full" />
          </div>
        </div>
      ))}
    </div>
  );
}

export function ChartSkeleton({ className }: { className?: string }) {
  return (
    <div className={classNames("rounded border border-border bg-card p-4", className)}>
      <div className="flex items-end gap-1 h-32">
        {Array.from({ length: 36 }).map((_, i) => (
          <div
            key={i}
            className="flex-1 animate-pulse rounded-sm bg-surface"
            style={{ height: `${30 + ((i * 37) % 70)}%` }}
          />
        ))}
      </div>
      <div className="mt-3 flex justify-between">
        <Bar className="h-2 w-10" />
        <Bar className="h-2 w-10" />
        <Bar className="h-2 w-10" />
      </div>
    </div>
  );
}

export function ProfileHeroSkeleton() {
  return (
    <div className="mg-hero-slab py-8">
      <div className="flex items-start gap-4">
        <Bar className="size-14 rounded-xl shrink-0" />
        <div className="flex-1 min-w-0 flex flex-col gap-2">
          <Bar className="h-3 w-24" />
          <Bar className="h-7 w-3/4 max-w-md" />
          <Bar className="h-3 w-full max-w-xl" />
        </div>
      </div>
      <div className="mt-6">
        <KpiStripSkeleton count={4} />
      </div>
    </div>
  );
}

export function ListShellSkeleton({ rows = 10 }: { rows?: number }) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <Bar className="h-8 w-64" />
        <div className="flex gap-2">
          <Bar className="h-8 w-20" />
          <Bar className="h-8 w-24" />
        </div>
      </div>
      <TableRowsSkeleton rows={rows} cols={6} />
    </div>
  );
}
