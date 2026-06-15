import type { ReactNode } from "react";
import { HeroOrnament } from "@/components/metagraphed/hero-ornament";
import { classNames } from "@/lib/metagraphed/format";

interface Props {
  eyebrow?: string;
  live?: boolean;
  title: ReactNode;
  description?: ReactNode;
  /** Right-aligned slot — share buttons, filters, etc. */
  actions?: ReactNode;
  /** When false, hides the orbital ornament (e.g. dense ops pages). */
  ornament?: boolean;
  className?: string;
}

/**
 * Compact hero strip used by every route except `/`. Same `mg-hero-slab`
 * surface + ornament rhythm as the home page so navigation between
 * routes feels visually continuous.
 */
export function PageHero({
  eyebrow,
  live,
  title,
  description,
  actions,
  ornament = true,
  className,
}: Props) {
  return (
    <section
      className={classNames(
        "mg-hero-slab relative overflow-hidden mb-6 px-5 py-7 md:px-8 md:py-9",
        className,
      )}
    >
      <div className="relative z-10 grid gap-6 md:grid-cols-[minmax(0,1fr)_auto] md:items-center">
        <div className="min-w-0 max-w-2xl">
          {eyebrow ? (
            <div className="mg-fade-in mg-label inline-flex items-center gap-2">
              {live ? <span className="mg-live-dot" /> : null}
              {eyebrow}
            </div>
          ) : null}
          <h1 className="mg-fade-in mg-fade-in-delay-1 mt-1.5 font-display text-2xl sm:text-3xl md:text-4xl font-semibold leading-[1.1] tracking-tight text-ink-strong">
            {title}
          </h1>
          {description ? (
            <p className="mg-fade-in mg-fade-in-delay-2 mt-3 max-w-xl text-sm text-ink-muted leading-relaxed">
              {description}
            </p>
          ) : null}
          {actions ? (
            <div className="mg-fade-in mg-fade-in-delay-3 mt-5 flex flex-wrap items-center gap-2">
              {actions}
            </div>
          ) : null}
        </div>
        {ornament ? (
          <div className="hidden md:block size-[200px] lg:size-[240px] shrink-0 -mr-6 -my-4 opacity-95">
            <HeroOrnament className="size-full" />
          </div>
        ) : null}
      </div>
    </section>
  );
}
