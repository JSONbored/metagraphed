import type { ReactNode } from "react";
import { classNames } from "@/lib/metagraphed/format";

interface KpiItem {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  /** Optional inline chart slot rendered below the value (sparkline/donut). */
  chart?: ReactNode;
}

interface Props {
  eyebrow?: string;
  live?: boolean;
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  /** Hairline KPI strip rendered below the hero copy. */
  kpis?: KpiItem[];
  /** Optional right-side slot (chart, illustration). */
  aside?: ReactNode;
  /** Top-right mono caption (defaults to "registry / v1"). */
  caption?: ReactNode;
  className?: string;
}

/**
 * Hero used by every route. Flat — no slab fill. Generous vertical padding,
 * mint hairline at the very top, hairline KPI strip across the bottom in
 * Blockmachine style, and a small mono caption pinned to the top-right.
 */
export function PageHero({
  eyebrow,
  live,
  title,
  description,
  actions,
  kpis,
  aside,
  caption = "registry / v1",
  className,
}: Props) {
  return (
    <section
      className={classNames(
        "mg-hero-slab relative mb-12 md:mb-16 pt-12 md:pt-20 pb-10 md:pb-14",
        className,
      )}
    >
      {caption ? (
        <div className="absolute right-0 top-4 hidden md:block">
          <span className="mg-hero-caption">{caption}</span>
        </div>
      ) : null}
      <div className="grid gap-10 md:grid-cols-[minmax(0,1fr)_auto] md:items-end">
        <div className="min-w-0 max-w-3xl">
          {eyebrow ? (
            <div className="mg-fade-in font-mono text-[10px] uppercase tracking-[0.22em] text-ink-muted inline-flex items-center gap-2">
              {live ? <span className="mg-live-dot" /> : null}
              {eyebrow}
            </div>
          ) : null}
          <h1 className="mg-fade-in mg-fade-in-delay-1 mt-4 font-display text-[2.5rem] sm:text-5xl md:text-[3.75rem] font-semibold leading-[1.02] tracking-[-0.025em] text-ink-strong">
            {title}
          </h1>
          {description ? (
            <p className="mg-fade-in mg-fade-in-delay-2 mt-5 max-w-xl text-base md:text-lg text-ink-muted leading-relaxed">
              {description}
            </p>
          ) : null}
          {actions ? (
            <div className="mg-fade-in mg-fade-in-delay-3 mt-6 flex flex-wrap items-center gap-2">
              {actions}
            </div>
          ) : null}
        </div>
        {aside ? (
          <div className="mg-fade-in mg-fade-in-delay-2 hidden md:block shrink-0">{aside}</div>
        ) : null}
      </div>

      {kpis && kpis.length > 0 ? (
        <div className="mg-fade-in mg-fade-in-delay-3 mg-kpi-strip mt-12 md:mt-16">
          {kpis.map((k) => (
            <div key={k.label}>
              <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-muted">
                {k.label}
              </div>
              <div className="mt-1.5 flex items-baseline gap-2">
                <span className="font-display text-2xl md:text-[1.75rem] font-semibold tabular-nums text-ink-strong leading-none tracking-[-0.01em]">
                  {k.value}
                </span>
                {k.hint ? (
                  <span className="font-mono text-[11px] text-ink-muted">{k.hint}</span>
                ) : null}
              </div>
              {k.chart ? <div className="mt-2.5 -ml-0.5">{k.chart}</div> : null}
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}
