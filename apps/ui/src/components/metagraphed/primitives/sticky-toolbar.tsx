import type { ReactNode } from "react";
import { cn } from "@/lib/cn";
import { useScrolled } from "@/hooks/use-scrolled";

export type StickyToolbarProps = {
  children: ReactNode;
  /** Extra offset from top of viewport (e.g. sticky header height). */
  offset?: number;
  /** Show a bottom hairline once the page has scrolled. */
  hairline?: boolean;
  className?: string;
};

/**
 * Sticky filter/action toolbar used across list pages (/surfaces, /endpoints,
 * /subnets). Applies the Bone & Ink header treatment: paper background,
 * bottom hairline that appears once the user scrolls, dynamic sticky offset
 * via the shared `--mg-sticky-offset` CSS var.
 */
export function StickyToolbar({
  children,
  offset,
  hairline = true,
  className,
}: StickyToolbarProps) {
  const scrolled = useScrolled(4);
  const top = offset != null ? { top: offset } : { top: "var(--mg-sticky-offset, 0px)" };
  return (
    <div
      style={top}
      className={cn(
        "sticky z-20 -mx-4 border-b bg-paper/95 px-4 py-2 backdrop-blur transition-[border-color,box-shadow] sm:mx-0 sm:px-0",
        hairline && scrolled ? "border-border" : "border-transparent",
        className,
      )}
    >
      <div className="flex flex-wrap items-center gap-2">{children}</div>
    </div>
  );
}
