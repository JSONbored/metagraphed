import { Link } from "@tanstack/react-router";
import { ArrowUpRight, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { classNames } from "@/lib/metagraphed/format";

interface Props {
  icon?: LucideIcon;
  eyebrow: string;
  value: ReactNode;
  hint?: ReactNode;
  to?: string;
  cta?: string;
  tone?: "default" | "accent";
  className?: string;
}

/**
 * Talisman-inspired stat card: tinted icon eyebrow, oversized number, a
 * subtle "view →" affordance when a destination is provided. Used on the
 * home page in place of the previous flat StatStrip.
 */
export function KpiCard({
  icon: Icon,
  eyebrow,
  value,
  hint,
  to,
  cta = "View",
  tone = "default",
  className,
}: Props) {
  const body = (
    <div
      className={classNames(
        "relative h-full rounded-xl border bg-card p-4 transition-all duration-150",
        "mg-hover-lift group flex flex-col gap-3",
        tone === "accent"
          ? "border-accent/30 hover:border-accent/60"
          : "border-border hover:border-ink/30",
        className,
      )}
    >
      <div className="flex items-center gap-2">
        {Icon ? (
          <span
            className={classNames(
              "inline-flex size-7 items-center justify-center rounded-md",
              tone === "accent" ? "bg-accent/15 text-accent-foreground" : "bg-surface/70 text-ink",
            )}
            aria-hidden
          >
            <Icon className="size-3.5" />
          </span>
        ) : null}
        <span className="mg-label">{eyebrow}</span>
      </div>
      <div className="flex items-baseline gap-2">
        <span className="font-display text-3xl font-semibold tracking-tight text-ink-strong tabular-nums leading-none">
          {value}
        </span>
        {hint ? <span className="font-mono text-[11px] text-ink-muted">{hint}</span> : null}
      </div>
      {to ? (
        <span className="mt-auto inline-flex items-center gap-1 mg-label group-hover:text-ink-strong transition-colors">
          {cta}
          <ArrowUpRight className="size-3 transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5" />
        </span>
      ) : null}
    </div>
  );
  if (!to) return body;
  // Internal route via TanStack Link.
  return (
    <Link
      to={to}
      className="block focus:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-xl"
    >
      {body}
    </Link>
  );
}
