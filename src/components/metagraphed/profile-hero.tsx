import type { ReactNode } from "react";
import { classNames } from "@/lib/metagraphed/format";

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
 * Shared profile-page hero used by entity detail pages
 * (subnets, providers). Always renders identity + chips first, then
 * primary public-resource link rail, then a compact stat strip. Stats
 * with no value are hidden, never rendered as "—" placeholders.
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
    <header className="mb-4">
      {banner ? <div className="mb-3">{banner}</div> : null}
      <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
        <div className="flex items-start gap-3 min-w-0">
          {icon ? <div className="shrink-0 mt-0.5">{icon}</div> : null}
          <div className="min-w-0">
            {eyebrow ? <div className="mg-label mb-1">{eyebrow}</div> : null}
            <div className="flex flex-wrap items-center gap-3">
              <h1 className="font-display text-2xl font-semibold tracking-tight text-ink-strong">
                {title}
              </h1>
              {subtitle ? (
                <span className="font-mono text-xs text-ink-muted">{subtitle}</span>
              ) : null}
            </div>
            {description ? (
              <p className="mt-1 text-sm text-ink-muted max-w-3xl">{description}</p>
            ) : null}
          </div>
        </div>
        {chips ? <div className="flex items-center gap-2 shrink-0">{chips}</div> : null}
      </div>

      {links ? <div className="mt-3">{links}</div> : null}

      {visibleStats.length > 0 ? (
        <div className="mt-4 rounded border border-border overflow-hidden">
          <div className="h-[2px] w-full bg-gradient-to-r from-accent via-accent/60 to-transparent" />
          <div
            className={classNames(
              "grid gap-px bg-border",
              "grid-cols-2 sm:grid-cols-3 md:grid-cols-4",
              visibleStats.length >= 6 && "lg:grid-cols-6",
              visibleStats.length === 5 && "lg:grid-cols-5",
            )}
          >
            {visibleStats.map((s) => (
              <div key={s.label} className="bg-card p-3 mg-kpi">
                <div className="mg-label">{s.label}</div>
                <div className="font-display text-lg font-semibold text-ink-strong tabular-nums">
                  {s.value}
                </div>
                {s.hint ? <div className="mt-0.5 text-[10px] text-ink-muted">{s.hint}</div> : null}
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </header>
  );
}
