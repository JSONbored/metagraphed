import type { ReactNode } from "react";
import { classNames } from "@/lib/format";

export interface EntityHeroStat {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  /** Optional inline chart/viz slot rendered below the value (sparkline/donut/ministack). */
  chart?: ReactNode;
}

export interface EntityHeroProps {
  /** Small mono line above the title (e.g. "Explorer · validator", "Provider · infra"). */
  eyebrow?: ReactNode;
  /** Pulses a live-dot next to the eyebrow. */
  live?: boolean;
  /** Optional icon/avatar rendered to the left of the title (was ProfileHero's `icon`). */
  icon?: ReactNode;
  title: ReactNode;
  /** Small mono text inline with the title (was ProfileHero's `subtitle`). */
  subtitle?: ReactNode;
  description?: ReactNode;
  /** Badge/chip row — right-aligned on desktop, wraps below on mobile (was ProfileHero's `chips`). */
  chips?: ReactNode;
  /** External-link row below the description (was ProfileHero's `links`). */
  links?: ReactNode;
  /** Button/action row below the description (was PageHero's `actions`). */
  actions?: ReactNode;
  /** Rendered above everything else — e.g. a stale-data banner. */
  banner?: ReactNode;
  /** Optional right-side slot at the title row (was PageHero's `aside`). */
  aside?: ReactNode;
  /** Hairline stat strip along the bottom. Entries with no value are dropped. */
  stats?: EntityHeroStat[];
  /** Top-right mono caption, desktop only (was PageHero's `caption`). */
  caption?: ReactNode;
  /** "display" = PageHero's oversized title; "compact" = ProfileHero's smaller title + icon row. Default "compact". */
  size?: "display" | "compact";
  className?: string;
}

/**
 * Shared entity-detail hero — one variant-slotted component covering the
 * three previously-unrelated hero layouts (#5342): PageHero's oversized
 * `size="display"` title + actions/aside/caption, and ProfileHero's
 * `size="compact"` icon + subtitle + chips/links. Both share the same
 * `mg-hero-slab` background and `mg-kpi-strip` stat-strip styling underneath
 * — this component is that shared shape, parameterized by `size` for the
 * one property (title scale) that genuinely differs between them.
 *
 * `SubnetMasthead` (apps/ui/src/components/metagraphed/subnet-masthead.tsx)
 * is not migrated yet — its accent rail, breadcrumb row, and StatWithSpark
 * viz-per-tile stat spine are richer than the `stats` shape here supports.
 * A future pass can extend `EntityHeroStat` (e.g. a `tone`/`delta` field
 * matching StatWithSpark's) to close that last gap.
 */
export function EntityHero({
  eyebrow,
  live,
  icon,
  title,
  subtitle,
  description,
  chips,
  links,
  actions,
  banner,
  aside,
  stats,
  caption,
  size = "compact",
  className,
}: EntityHeroProps) {
  const visibleStats = (stats ?? []).filter(
    (s) => s.value !== undefined && s.value !== null && s.value !== "",
  );
  const display = size === "display";

  return (
    <header
      className={classNames(
        "mg-hero-slab relative",
        display
          ? "mb-12 md:mb-16 pt-12 md:pt-20 pb-10 md:pb-12"
          : "pt-8 md:pt-12 pb-8 md:pb-10 mb-6",
        className,
      )}
    >
      {caption ? (
        <div className="absolute right-0 top-4 hidden md:block">
          <span className="mg-hero-caption">{caption}</span>
        </div>
      ) : null}

      {banner ? <div className="mb-4">{banner}</div> : null}

      <div
        className={classNames(
          "grid md:grid-cols-[minmax(0,1fr)_auto]",
          display ? "gap-10 md:items-end" : "gap-6 md:items-start",
        )}
      >
        <div className="flex items-start gap-4 min-w-0 max-w-3xl">
          {icon ? <div className="shrink-0 mt-1">{icon}</div> : null}
          <div className="min-w-0">
            {eyebrow ? (
              <div
                className={classNames(
                  "text-10 text-ink-muted inline-flex items-center gap-2",
                  display ? "" : "mb-2",
                )}
              >
                {live ? <span className="mg-live-dot" /> : null}
                {eyebrow}
              </div>
            ) : null}
            <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
              <h1
                className={classNames(
                  "font-display font-semibold text-ink-strong",
                  display
                    ? "mt-4 text-40 sm:text-40 md:text-64 leading-[1.02]"
                    : "text-28 md:text-40",
                )}
              >
                {title}
              </h1>
              {!display && subtitle ? (
                <span className="font-mono text-13 md:text-13 text-ink-muted">
                  {subtitle}
                </span>
              ) : null}
            </div>
            {description ? (
              <p
                className={classNames(
                  "text-ink-muted leading-relaxed",
                  display
                    ? "mt-4 max-w-xl text-16 md:text-16"
                    : "mt-3 max-w-3xl text-13 md:text-16",
                )}
              >
                {description}
              </p>
            ) : null}
            {links ? <div className="mt-6">{links}</div> : null}
            {actions ? (
              <div className="mt-6 flex flex-wrap items-center gap-2">
                {actions}
              </div>
            ) : null}
          </div>
        </div>
        {chips ? (
          <div className="flex flex-wrap items-center gap-1.5 md:justify-end shrink-0 max-w-md">
            {chips}
          </div>
        ) : null}
        {aside ? <div className="hidden md:block shrink-0">{aside}</div> : null}
      </div>

      {visibleStats.length > 0 ? (
        <div
          className={classNames(
            "mg-kpi-strip",
            display ? "mt-12 md:mt-16" : "mt-8 md:mt-10",
          )}
        >
          {visibleStats.map((s) => (
            <div key={s.label}>
              <div className="text-13 text-ink-muted">{s.label}</div>
              <div className="mt-1.5 flex items-baseline gap-2">
                <span
                  className={classNames(
                    "font-display font-semibold tabular-nums text-ink-strong leading-none",
                    display ? "text-28 md:text-28" : "text-28 md:text-28",
                  )}
                >
                  {s.value}
                </span>
                {s.hint ? (
                  <span className="text-11 text-ink-muted">{s.hint}</span>
                ) : null}
              </div>
              {s.chart ? <div className="mt-2.5 -ml-0.5">{s.chart}</div> : null}
            </div>
          ))}
        </div>
      ) : null}
    </header>
  );
}
