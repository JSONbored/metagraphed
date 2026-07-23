import { useEffect, useRef, useState, type ReactNode } from "react";
import { MoreHorizontal } from "lucide-react";
import { classNames } from "@/lib/format";

export interface PageActionsProps {
  /** Always-visible primary action(s). Keep to 1 on mobile. */
  primary?: ReactNode;
  /** Secondary actions collapsed into an overflow menu on narrow viewports. */
  secondary?: ReactNode;
  /** Breakpoint at/above which secondary actions render inline. Default md. */
  inlineFrom?: "sm" | "md" | "lg";
  className?: string;
}

const INLINE_FROM: Record<"sm" | "md" | "lg", string> = {
  sm: "sm:flex",
  md: "md:flex",
  lg: "lg:flex",
};

const HIDE_UNTIL: Record<"sm" | "md" | "lg", string> = {
  sm: "hidden sm:flex",
  md: "hidden md:flex",
  lg: "hidden lg:flex",
};

const SHOW_UNTIL: Record<"sm" | "md" | "lg", string> = {
  sm: "sm:hidden",
  md: "md:hidden",
  lg: "lg:hidden",
};

/**
 * Right-anchored action bar for page headers (Delegate, Share, Compare,
 * Copy URL). Secondary actions collapse into an overflow menu on narrow
 * viewports so mobile headers stay one row tall.
 */
export function PageActions({
  primary,
  secondary,
  inlineFrom = "md",
  className,
}: PageActionsProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node))
        setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className={classNames("flex items-center gap-2", className)}>
      {primary}
      {secondary ? (
        <>
          <div
            className={classNames(
              HIDE_UNTIL[inlineFrom],
              INLINE_FROM[inlineFrom],
              "items-center gap-2",
            )}
          >
            {secondary}
          </div>
          <div
            className={classNames("relative", SHOW_UNTIL[inlineFrom])}
            ref={ref}
          >
            <button
              type="button"
              onClick={() => setOpen((v) => !v)}
              aria-label="More actions"
              aria-expanded={open}
              aria-haspopup="menu"
              className="inline-flex size-9 items-center justify-center rounded border border-border bg-card text-ink-strong hover:border-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <MoreHorizontal className="size-4" aria-hidden />
            </button>
            {open ? (
              <div
                role="menu"
                className="absolute right-0 top-full z-30 mt-2 min-w-[180px] rounded border border-border bg-card p-2 shadow-lg"
              >
                <div className="flex flex-col items-stretch gap-1 [&>*]:w-full [&>*]:justify-start">
                  {secondary}
                </div>
              </div>
            ) : null}
          </div>
        </>
      ) : null}
    </div>
  );
}
