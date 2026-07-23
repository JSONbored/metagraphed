import { classNames } from "@/lib/metagraphed/format";

export interface QueryProgressProps {
  /** When true, the hairline progress bar is visible and animated. */
  active: boolean;
  /** Position: absolute inside a scroll surface, or fixed to viewport top. */
  position?: "absolute" | "fixed" | "sticky";
  className?: string;
  ariaLabel?: string;
}

/**
 * QueryProgress — a 2px accent hairline that indeterminately sweeps left→right
 * while a background query is refetching. Sits above a table so users see
 * "results are updating" without the whole panel skeleton flashing.
 */
export function QueryProgress({
  active,
  position = "absolute",
  className,
  ariaLabel = "Updating results",
}: QueryProgressProps) {
  return (
    <div
      role="progressbar"
      aria-label={ariaLabel}
      aria-hidden={!active}
      className={classNames(
        "mg-query-progress pointer-events-none overflow-hidden",
        position === "absolute" && "absolute inset-x-0 top-0 z-10",
        position === "fixed" && "fixed inset-x-0 top-0 z-50",
        position === "sticky" && "sticky top-0 z-10 -mt-px",
        "h-[2px]",
        active ? "opacity-100" : "opacity-0 transition-opacity duration-300",
        className,
      )}
    >
      <div
        className={classNames("h-full w-1/3 rounded-full", active && "mg-query-progress-track")}
        style={{
          background:
            "linear-gradient(90deg, transparent, color-mix(in oklab, var(--accent) 90%, transparent), transparent)",
        }}
      />
    </div>
  );
}
