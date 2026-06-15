import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { classNames } from "@/lib/metagraphed/format";

interface Props {
  icon?: LucideIcon;
  eyebrow: string;
  value: ReactNode;
  hint?: ReactNode;
  /** Optional micro-chart slot rendered on the right (e.g. Sparkline). */
  chart?: ReactNode;
  tone?: "default" | "accent" | "ok" | "warn" | "down";
  className?: string;
}

/**
 * Compact KPI tile used in dense stat strips. Lighter weight than
 * `<KpiCard>` (no internal link / CTA) so we can pack 4-6 of them above
 * the fold on list/ops routes.
 */
export function StatTile({
  icon: Icon,
  eyebrow,
  value,
  hint,
  chart,
  tone = "default",
  className,
}: Props) {
  return (
    <div
      className={classNames(
        "rounded-xl border bg-card p-3 flex items-center gap-3",
        tone === "accent" && "border-accent/30",
        tone === "ok" && "border-health-ok/30",
        tone === "warn" && "border-health-warn/30",
        tone === "down" && "border-health-down/30",
        tone === "default" && "border-border",
        className,
      )}
    >
      {Icon ? (
        <span
          aria-hidden
          className={classNames(
            "inline-flex size-8 shrink-0 items-center justify-center rounded-md",
            tone === "accent"
              ? "bg-accent/15 text-accent-foreground"
              : tone === "ok"
                ? "bg-health-ok/15 text-health-ok"
                : tone === "warn"
                  ? "bg-health-warn/15 text-health-warn"
                  : tone === "down"
                    ? "bg-health-down/15 text-health-down"
                    : "bg-surface/70 text-ink",
          )}
        >
          <Icon className="size-4" />
        </span>
      ) : null}
      <div className="min-w-0 flex-1">
        <div className="mg-label truncate">{eyebrow}</div>
        <div className="flex items-baseline gap-1.5">
          <span className="font-display text-xl md:text-2xl font-semibold tabular-nums leading-none text-ink-strong">
            {value}
          </span>
          {hint ? (
            <span className="font-mono text-[10px] text-ink-muted truncate">{hint}</span>
          ) : null}
        </div>
      </div>
      {chart ? <div className="shrink-0 opacity-80">{chart}</div> : null}
    </div>
  );
}
