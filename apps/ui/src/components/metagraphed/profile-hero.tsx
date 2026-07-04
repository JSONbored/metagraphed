import type { ReactNode } from "react";

interface StatItem {
  label: string;
  value: ReactNode;
  hint?: string;
}

export interface ProfileHeroProps {
  eyebrow?: ReactNode;
  title: ReactNode;
  subtitle?: ReactNode;
  description?: ReactNode;
  chips?: ReactNode;
  links?: ReactNode;
  stats?: StatItem[];
  banner?: ReactNode;
  icon?: ReactNode;
}

/**
 * Shared entity-profile hero (subnet/provider detail). Blockmachine-style:
 * eyebrow + oversized title + identity, chips clustered on the right, then
 * a hairline KPI strip across the bottom.
 */
export function ProfileHero({
  eyebrow,
  title,
  subtitle,
  description,
  chips,
  links,
  stats,
  banner,
  icon,
}: ProfileHeroProps) {
  const visibleStats = (stats ?? []).filter(
    (s) => s.value !== undefined && s.value !== null && s.value !== "",
  );

  return (
    <header className="mg-hero-slab relative pt-8 md:pt-12 pb-8 md:pb-10 mb-6">
      {banner ? <div className="mb-5">{banner}</div> : null}
      <div className="grid gap-6 md:grid-cols-[minmax(0,1fr)_auto] md:items-start">
        <div className="flex items-start gap-4 min-w-0">
          {icon ? <div className="shrink-0 mt-1">{icon}</div> : null}
          <div className="min-w-0">
            {eyebrow ? (
              <div className="font-mono text-[10px] uppercase tracking-[0.2em] text-ink-muted mb-2">
                {eyebrow}
              </div>
            ) : null}
            <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
              <h1 className="font-display text-3xl md:text-4xl font-semibold tracking-[-0.01em] text-ink-strong">
                {title}
              </h1>
              {subtitle ? (
                <span className="font-mono text-xs md:text-sm text-ink-muted">{subtitle}</span>
              ) : null}
            </div>
            {description ? (
              <p className="mt-3 text-sm md:text-base text-ink-muted max-w-3xl leading-relaxed">
                {description}
              </p>
            ) : null}
          </div>
        </div>
        {chips ? (
          <div className="flex flex-wrap items-center gap-1.5 md:justify-end shrink-0 max-w-md">
            {chips}
          </div>
        ) : null}
      </div>

      {links ? <div className="mt-6">{links}</div> : null}

      {visibleStats.length > 0 ? (
        <div className="mg-kpi-strip mt-8 md:mt-10">
          {visibleStats.map((s) => (
            <div key={s.label}>
              <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-muted">
                {s.label}
              </div>
              <div className="mt-1.5 font-display text-xl md:text-2xl font-semibold text-ink-strong tabular-nums leading-none">
                {s.value}
              </div>
              {s.hint ? <div className="mt-1 text-[10px] text-ink-muted">{s.hint}</div> : null}
            </div>
          ))}
        </div>
      ) : null}
    </header>
  );
}
