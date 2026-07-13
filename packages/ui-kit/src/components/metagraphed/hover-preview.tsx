import { useState, type ReactNode } from "react";
import { classNames } from "@/lib/format";

interface Props {
  children: ReactNode;
  content: ReactNode;
  className?: string;
  /**
   * Set when `children` isn't itself a focusable element (e.g. a plain
   * `<span>` fallback rather than a link/button) — makes the wrapper a tab
   * stop so keyboard users can still reach the preview on focus, not only
   * on hover.
   */
  focusable?: boolean;
}

/**
 * Lightweight hover/focus popover (no portal, no deps). Anchored bottom-left.
 */
export function HoverPreview({
  children,
  content,
  className,
  focusable,
}: Props) {
  const [open, setOpen] = useState(false);
  return (
    <span
      className={classNames("relative inline-flex", className)}
      tabIndex={focusable ? 0 : undefined}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
    >
      {children}
      {open ? (
        <span
          role="tooltip"
          className="absolute left-0 top-full z-40 mt-1.5 w-72 max-w-[80vw] rounded border border-border bg-card p-3 shadow-lg text-[11px] text-ink leading-relaxed"
        >
          {content}
        </span>
      ) : null}
    </span>
  );
}
