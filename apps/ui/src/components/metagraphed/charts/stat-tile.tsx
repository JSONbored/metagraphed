import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { classNames } from "@/lib/metagraphed/format";

interface Props {
  icon?: LucideIcon;
  eyebrow: string;
  value: ReactNode;
  hint?: ReactNode;
  chart?: ReactNode;
  tone?: "default" | "accent" | "ok" | "warn" | "down";
  className?: string;
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
        <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-muted truncate">
          {eyebrow}
        </div>
        <div className="mt-1 flex min-w-0 items-baseline gap-1.5">
          <span className="min-w-0 font-display text-base font-semibold tabular-nums leading-none text-ink-strong sm:text-xl md:text-2xl">
            {value}
          </span>
          {hint ? (
            <span className="min-w-0 font-mono text-[10px] text-ink-muted truncate">{hint}</span>
          ) : null}
        </div>
      </div>
      {chart ? <div className="shrink-0 opacity-80">{chart}</div> : null}
    </div>
  );
}
