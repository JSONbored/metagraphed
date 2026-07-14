import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { classNames } from "@/lib/format";
import { InfoTooltip } from "@/components/metagraphed/info-tooltip";

interface Props {
  icon?: LucideIcon;
  eyebrow: string;
  value: ReactNode;
  hint?: ReactNode;
  chart?: ReactNode;
  tone?: "default" | "accent" | "ok" | "warn" | "down";
  className?: string;
  /**
   * When false, the eyebrow/hint wrap instead of truncating with an
   * ellipsis — for a label too long to reliably fit one line at every
   * breakpoint (e.g. "Validators / miners" in a 2-column mobile grid).
   * Defaults to true, unchanged for every other consumer.
   */
  truncate?: boolean;
  /**
   * Optional hover/focus explainer shown as an info icon next to the eyebrow —
   * what the statistic means and what a healthy value looks like. Matches the
   * HeroStatCell tooltip pattern.
   */
  tooltip?: string;
}

/**
 * Compact KPI tile. Flat hairline, generous baseline. Used in tighter
 * stat strips where the hero KPI grid would feel oversized.
 */
export function StatTile({
  icon: Icon,
  eyebrow,
  value,
  hint,
  chart,
  tone = "default",
  className,
  truncate = true,
  tooltip,
}: Props) {
  return (
    <div
      className={classNames(
        "rounded-lg border bg-card p-4 flex items-center gap-4",
        tone === "accent" && "border-accent/40",
        tone === "ok" && "border-health-ok/40",
        tone === "warn" && "border-health-warn/40",
        tone === "down" && "border-health-down/40",
        tone === "default" && "border-border",
        className,
      )}
    >
      {Icon ? (
        <Icon
          aria-hidden
          className={classNames(
            "size-4 shrink-0",
            tone === "accent"
              ? "text-accent"
              : tone === "ok"
                ? "text-health-ok"
                : tone === "warn"
                  ? "text-health-warn"
                  : tone === "down"
                    ? "text-health-down"
                    : "text-ink-muted",
          )}
        />
      ) : null}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1 font-mono text-[10px] uppercase tracking-[0.18em] text-ink-muted">
          <span className={truncate ? "truncate" : "leading-tight"}>
            {eyebrow}
          </span>
          {tooltip ? (
            <InfoTooltip label={tooltip} className="shrink-0" />
          ) : null}
        </div>
        <div
          className={classNames(
            "mt-1 flex min-w-0 gap-1.5",
            truncate ? "items-baseline" : "flex-wrap items-baseline",
          )}
        >
          {/* #3940: shrink-0 so the hint (already truncate-clipped) absorbs constrained width instead of the value wrapping. */}
          <span className="shrink-0 font-display text-base font-semibold tabular-nums leading-none text-ink-strong sm:text-xl md:text-2xl">
            {value}
          </span>
          {hint ? (
            <span
              className={classNames(
                "min-w-0 font-mono text-[10px] text-ink-muted",
                truncate ? "truncate" : "",
              )}
            >
              {hint}
            </span>
          ) : null}
        </div>
      </div>
      {chart ? <div className="shrink-0 opacity-80">{chart}</div> : null}
    </div>
  );
}
