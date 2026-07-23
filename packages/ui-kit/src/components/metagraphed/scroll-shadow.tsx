import { useEffect, useRef, useState, type ReactNode } from "react";
import { classNames } from "@/lib/format";

export interface ScrollShadowProps {
  /** Scroll axis. Defaults to horizontal (tables, tab strips). */
  orientation?: "horizontal" | "vertical";
  className?: string;
  innerClassName?: string;
  children: ReactNode;
}

/**
 * Adds edge-fade shadows that appear only when content overflows and the
 * user hasn't scrolled to that edge. Used by <ResponsiveTable> and the
 * profile-tabs strip so overflow is signalled the same way everywhere.
 */
export function ScrollShadow({
  orientation = "horizontal",
  className,
  innerClassName,
  children,
}: ScrollShadowProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [state, setState] = useState({ start: false, end: false });

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => {
      if (orientation === "horizontal") {
        setState({
          start: el.scrollLeft > 2,
          end: el.scrollLeft + el.clientWidth < el.scrollWidth - 2,
        });
      } else {
        setState({
          start: el.scrollTop > 2,
          end: el.scrollTop + el.clientHeight < el.scrollHeight - 2,
        });
      }
    };
    update();
    el.addEventListener("scroll", update, { passive: true });
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => {
      el.removeEventListener("scroll", update);
      ro.disconnect();
    };
  }, [orientation]);

  const isH = orientation === "horizontal";
  return (
    <div className={classNames("relative", className)}>
      <div
        ref={ref}
        className={classNames(
          isH ? "overflow-x-auto" : "overflow-y-auto",
          "mg-scroll overscroll-contain",
          innerClassName,
        )}
        style={
          isH
            ? { overflowY: "hidden", scrollbarWidth: "none" }
            : { overflowX: "hidden" }
        }
      >
        {children}
      </div>
      {state.start ? (
        <div
          aria-hidden
          className={classNames(
            "pointer-events-none absolute z-10",
            isH
              ? "left-0 top-0 h-full w-6 bg-gradient-to-r from-card to-transparent"
              : "left-0 top-0 h-6 w-full bg-gradient-to-b from-card to-transparent",
          )}
        />
      ) : null}
      {state.end ? (
        <div
          aria-hidden
          className={classNames(
            "pointer-events-none absolute z-10",
            isH
              ? "right-0 top-0 h-full w-6 bg-gradient-to-l from-card to-transparent"
              : "bottom-0 left-0 h-6 w-full bg-gradient-to-t from-card to-transparent",
          )}
        />
      ) : null}
    </div>
  );
}
