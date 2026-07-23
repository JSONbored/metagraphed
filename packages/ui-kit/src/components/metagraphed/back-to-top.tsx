import { useEffect, useState } from "react";
import { ArrowUp } from "lucide-react";
import { classNames } from "@/lib/format";

/**
 * Floating "back to top" control. Visible after the user scrolls past a
 * threshold. Scrolls the window to the top WITHOUT touching `location.hash`
 * or router state, so it never collides with hash-based scroll handlers
 * (see `useHashScroll` / `SectionQuickJump`).
 */
// #3987: the pill sits `fixed` at the bottom-right, so when a page is scrolled
// to its very end the last row of content lands directly under it (e.g. the
// Reward Drift table's final row). Hide the pill once the viewport is within
// this many px of the document bottom — its footprint (bottom offset + height)
// plus a little clearance — so it can never obscure the final content.
const BOTTOM_HIDE_GAP = 96;

export function BackToTop({ threshold = 600 }: { threshold?: number }) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") return;
    function onScroll() {
      const scrolledPast = window.scrollY > threshold;
      const doc = document.documentElement;
      const distanceToBottom =
        doc.scrollHeight - (window.scrollY + window.innerHeight);
      setVisible(scrolledPast && distanceToBottom > BOTTOM_HIDE_GAP);
    }
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
    };
  }, [threshold]);

  const onClick = () => {
    if (typeof window === "undefined") return;
    const reduced = window.matchMedia?.(
      "(prefers-reduced-motion: reduce)",
    )?.matches;
    window.scrollTo({ top: 0, left: 0, behavior: reduced ? "auto" : "smooth" });
    // Return keyboard focus to <main> without forcing another scroll.
    const main = document.querySelector("main") as HTMLElement | null;
    if (main) {
      const hadTabIndex = main.hasAttribute("tabindex");
      if (!hadTabIndex) main.setAttribute("tabindex", "-1");
      main.focus({ preventScroll: true });
      if (!hadTabIndex) {
        // Clean up so we don't pollute the tab order.
        setTimeout(() => main.removeAttribute("tabindex"), 0);
      }
    }
  };

  return (
    <button
      type="button"
      onClick={onClick}
      aria-label="Back to top"
      aria-hidden={!visible}
      tabIndex={visible ? 0 : -1}
      className={classNames(
        "fixed z-40 bottom-5 right-5 md:bottom-7 md:right-7",
        "inline-flex items-center gap-1.5 rounded-full border border-border bg-card/95 backdrop-blur",
        "px-3 py-2 mg-type-label uppercase text-ink-strong",
        "shadow-[0_8px_24px_-12px_rgba(0,0,0,0.35)] hover:border-accent/60 hover:text-accent",
        "transition-[opacity,transform,border-color,color] duration-200",
        visible
          ? "opacity-100 translate-y-0 pointer-events-auto"
          : "opacity-0 translate-y-2 pointer-events-none",
      )}
    >
      <ArrowUp className="size-3.5" />
      <span className="hidden sm:inline">Top</span>
    </button>
  );
}
