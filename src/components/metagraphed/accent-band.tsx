import type { ReactNode } from "react";
import { classNames } from "@/lib/metagraphed/format";

interface Props {
  children: ReactNode;
  /** When true, adds the mint dot pattern over the band. */
  pattern?: boolean;
  className?: string;
  /** Inner container className override. */
  innerClassName?: string;
}

/**
 * Full-width mint-soft band. Uses CSS positioning that respects the document
 * width (not 100vw) so it cannot push the page into horizontal overflow when
 * a vertical scrollbar is present.
 *
 * Implementation: anchor to viewport edges with left/right:0 via a
 * full-bleed wrapper that escapes its padded parent using calc-based
 * negative margins keyed to the layout container width. We use
 * `100%` + negative margins that match the parent padding (px-4 md:px-10),
 * which never exceeds the document scroll width.
 */
export function AccentBand({ children, pattern = false, className, innerClassName }: Props) {
  return (
    <section
      className={classNames(
        // Full-bleed without using 100vw — escape the <main> padding only.
        // `-mx-4 md:-mx-10` matches AppShell's <main> padding so the band
        // reaches the viewport edges without ever exceeding document width.
        "mg-accent-band relative -mx-4 md:-mx-10",
        className,
      )}
    >
      {pattern ? (
        <div className="mg-dot-grid absolute inset-0 opacity-40 pointer-events-none" aria-hidden />
      ) : null}
      <div
        className={classNames(
          "relative max-w-[1400px] mx-auto px-4 md:px-8 py-14 md:py-20",
          innerClassName,
        )}
      >
        {children}
      </div>
    </section>
  );
}
