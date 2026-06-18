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
 * Flat stat card. Hairline border, no fill differentiation, generous
 * vertical room. Hover lifts the border only.
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
        "relative h-full rounded-lg border bg-card p-5 md:p-6",
        "mg-hover-lift group flex flex-col gap-4",
        tone === "accent" ? "border-accent/40" : "border-border",
        className,
      )}
    >
      <div className="flex items-center gap-2">
        {Icon ? (
          <Icon
            className={classNames("size-3.5", tone === "accent" ? "text-accent" : "text-ink-muted")}
            aria-hidden
          />
        ) : null}
        <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-muted">
          {eyebrow}
        </span>
      </div>
      <div className="flex items-baseline gap-2">
        <span className="font-display text-3xl md:text-4xl font-semibold tracking-tight text-ink-strong tabular-nums leading-none">
          {value}
        </span>
        {hint ? <span className="font-mono text-[11px] text-ink-muted">{hint}</span> : null}
      </div>
      {to ? (
        <span className="mt-auto inline-flex items-center gap-1 font-mono text-[10px] uppercase tracking-[0.18em] text-ink-muted group-hover:text-ink-strong transition-colors">
          {cta}
          <ArrowUpRight className="size-3 transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5" />
        </span>
      ) : null}
    </div>
  );
  if (!to) return body;
  return (
    <Link
      to={to}
      className="block focus:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-lg"
    >
      {body}
    </Link>
  );
}
