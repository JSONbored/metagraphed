import { useEffect, useLayoutEffect, useRef, type ReactNode } from "react";
import { classNames } from "@/lib/metagraphed/format";
import { Breadcrumbs } from "./breadcrumbs";
import type { Crumb } from "@/components/metagraphed/breadcrumb-nav";

interface KpiItem {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  chart?: ReactNode;
}

interface Props {
  eyebrow?: string;
  live?: boolean;
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  kpis?: KpiItem[];
  /** Small right-column slot (compact stat block, avatar). Hidden on mobile. */
  aside?: ReactNode;
  /** Mono caption pinned to the top row. */
  caption?: ReactNode;
  /** Explicit pathname for breadcrumbs; defaults to window.location.pathname. */
  pathname?: string;
  /** Fully-formed breadcrumb trail (e.g. detail pages with custom labels). */
  crumbs?: Crumb[];
  /** Skip auto-rendered breadcrumbs (e.g. root routes). */
  hideBreadcrumbs?: boolean;
  className?: string;
}

const useIsoLayoutEffect = typeof window !== "undefined" ? useLayoutEffect : useEffect;

/**
 * Compact page masthead — the data-explorer counterpart to `PageHero`.
 *
 * Roughly ~120px tall vs. ~340px for `PageHero`, matching the density users
 * expect from block explorers (taostats, etherscan). Renders breadcrumbs +
 * title + optional inline KPI rail in a single, bottom-hairline-bounded band.
 *
 * Publishes its measured height to `--mg-masthead-offset` so sticky toolbars
 * and table headers can offset off the app header + masthead consistently.
 */
export function PageMasthead({
  eyebrow: _eyebrow,
  live,
  title,
  description,
  actions,
  kpis,
  aside,
  caption,
  pathname,
  crumbs,
  hideBreadcrumbs = true,
  className,
}: Props) {
  const ref = useRef<HTMLElement>(null);

  useIsoLayoutEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const publish = () => {
      const h = el.getBoundingClientRect().height;
      document.documentElement.style.setProperty("--mg-masthead-offset", `${Math.round(h)}px`);
    };
    publish();
    const ro = new ResizeObserver(publish);
    ro.observe(el);
    return () => {
      ro.disconnect();
      document.documentElement.style.removeProperty("--mg-masthead-offset");
    };
  }, []);

  return (
    <section
      ref={ref}
      className={classNames(
        "mg-masthead relative mb-6 md:mb-8 pt-3 md:pt-4 pb-3 md:pb-4 border-b border-border",
        className,
      )}
    >
      {!hideBreadcrumbs ? (
        <div className="mb-1.5 flex items-center justify-between gap-3">
          <Breadcrumbs pathname={pathname} crumbs={crumbs} />
          {caption ? (
            <span className="mg-hero-caption hidden sm:inline-flex shrink-0">{caption}</span>
          ) : null}
        </div>
      ) : null}

      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            {live ? <span className="mg-live-dot shrink-0" aria-hidden /> : null}
            <h1 className="font-display text-2xl md:text-3xl font-semibold leading-[1.15] tracking-[-0.015em] text-ink-strong min-w-0 truncate">
              {title}
            </h1>
            {/* `eyebrow` prop intentionally not rendered: the breadcrumb rail
                under the secondary nav already names the section, so a chip
                next to the H1 duplicated it on every masthead. Prop kept in
                the type so call sites don't break. */}
          </div>
          {description ? (
            <p
              className="mt-1 max-w-3xl text-[13px] text-ink-muted leading-snug line-clamp-2"
              title={typeof description === "string" ? description : undefined}
            >
              {description}
            </p>
          ) : null}
        </div>
        {actions ? (
          <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>
        ) : null}
        {aside ? <div className="hidden md:block shrink-0">{aside}</div> : null}
      </div>

      {kpis && kpis.length > 0 ? (
        <div className="mg-masthead-kpi mt-3">
          {kpis.map((k) => (
            <div key={k.label} className="min-w-0">
              <div className="font-mono text-[9.5px] uppercase tracking-[0.16em] text-ink-muted truncate">
                {k.label}
              </div>
              <div className="mt-0.5 flex items-baseline gap-1.5 min-w-0">
                <span className="font-display text-sm md:text-base font-semibold tabular-nums text-ink-strong leading-none truncate">
                  {k.value}
                </span>
                {k.hint ? (
                  <span className="font-mono text-[10px] text-ink-muted truncate">{k.hint}</span>
                ) : null}
              </div>
              {k.chart ? <div className="mt-1 -ml-0.5">{k.chart}</div> : null}
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}
