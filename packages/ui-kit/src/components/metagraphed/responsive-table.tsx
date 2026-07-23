import type { ReactNode } from "react";
import { classNames } from "@/lib/format";
import { ScrollShadow } from "./scroll-shadow";

export interface ResponsiveTableProps {
  /** Optional cards fallback rendered below a Tailwind breakpoint. */
  cardsFallback?: ReactNode;
  /** Breakpoint under which the cards fallback shows (default md). */
  cardsBelow?: "sm" | "md" | "lg";
  /** Min-width applied to the inner <table> — enables horizontal scroll. */
  minWidth?: number | string;
  className?: string;
  children: ReactNode;
}

const HIDE_TABLE: Record<"sm" | "md" | "lg", string> = {
  sm: "hidden sm:block",
  md: "hidden md:block",
  lg: "hidden lg:block",
};

const SHOW_CARDS: Record<"sm" | "md" | "lg", string> = {
  sm: "sm:hidden",
  md: "md:hidden",
  lg: "lg:hidden",
};

/**
 * Standard wrapper for all data tables. Provides horizontal scroll with
 * edge shadows, a min-width guarantee, and an optional cards fallback
 * for narrow viewports. Retires ad-hoc `overflow-x-auto` + `min-w-[…]`
 * patterns duplicated across list routes.
 */
export function ResponsiveTable({
  cardsFallback,
  cardsBelow = "md",
  minWidth = 720,
  className,
  children,
}: ResponsiveTableProps) {
  const min = typeof minWidth === "number" ? `${minWidth}px` : minWidth;

  if (cardsFallback != null) {
    return (
      <div className={className}>
        <div className={SHOW_CARDS[cardsBelow]}>{cardsFallback}</div>
        <div className={HIDE_TABLE[cardsBelow]}>
          <ScrollShadow>
            <div style={{ minWidth: min }}>{children}</div>
          </ScrollShadow>
        </div>
      </div>
    );
  }

  return (
    <ScrollShadow className={classNames(className)}>
      <div style={{ minWidth: min }}>{children}</div>
    </ScrollShadow>
  );
}
