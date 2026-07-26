import { Link, useRouterState } from "@tanstack/react-router";
import { useRef, type ReactNode } from "react";
import { ScrollShadow } from "@jsonbored/ui-kit";
import { classNames } from "@/lib/metagraphed/format";
import { useStickyStripHeight } from "@/hooks/use-sticky-strip-height";

/**
 * Shared chrome for the consolidated hubs (#8302).
 *
 * The Chain hub (#8244) established this shape; the APIs hub (#8245) needs the
 * same thing. Extracted rather than copied — a second, subtly different copy of
 * "how a hub renders its tabs" is how the two drift apart, and this epic has
 * already paid for one duplicated-definition bug (the R2 key shape behind the
 * 2026-07-26 outage).
 */
export interface HubTab {
  to: string;
  label: string;
  /** Shown under the hub title while this tab is active. */
  blurb: string;
}

/**
 * Longest match first, so a bare hub path (`/chain`, `/apis`) can act as its own
 * Overview/Catalog tab without swallowing `/chain/blocks` or `/apis/endpoints`.
 */
export function activeHubTab<T extends HubTab>(tabs: readonly T[], pathname: string): T {
  const match = [...tabs]
    .sort((a, b) => b.to.length - a.to.length)
    .find((t) => pathname === t.to || pathname.startsWith(`${t.to}/`));
  return match ?? tabs[0]!;
}

/**
 * Hub tab strip.
 *
 * Deliberately has no sibling in its flex row. The profile-tabs strip was
 * starved to 196px of a 390px viewport because a `shrink-0` controls cluster sat
 * beside it (#8254/#8281) — per-tab actions render inside the tab content via
 * HubTabActions instead, so the tabs always own the full width.
 */
export function HubTabs({ tabs, ariaLabel }: { tabs: readonly HubTab[]; ariaLabel: string }) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const active = activeHubTab(tabs, pathname);
  const ref = useRef<HTMLElement>(null);

  useStickyStripHeight(ref);

  return (
    <nav
      ref={ref}
      aria-label={ariaLabel}
      className="sticky z-[var(--mg-z-sticky)] -mx-4 mb-8 border-b border-border bg-paper/95 backdrop-blur supports-[backdrop-filter]:bg-paper/80 md:mx-0"
      style={{ top: "var(--mg-sticky-offset, 3.5rem)" }}
    >
      <ScrollShadow className="min-w-0" innerClassName="scroll-smooth">
        <ul className="flex items-center gap-6 px-4 md:px-0" role="list">
          {tabs.map((tab) => {
            const isActive = tab.to === active.to;
            return (
              <li key={tab.to}>
                <Link
                  to={tab.to}
                  aria-current={isActive ? "page" : undefined}
                  className={classNames(
                    "relative inline-flex items-center gap-1.5 whitespace-nowrap px-1 py-3 mg-type-caption-lg font-medium transition-colors mg-focus-ring",
                    isActive
                      ? "text-ink-strong after:absolute after:-bottom-[1.5px] after:left-1 after:right-1 after:h-[1.5px] after:rounded-full after:bg-accent after:content-['']"
                      : "text-ink-muted hover:text-ink-strong",
                  )}
                >
                  {tab.label}
                </Link>
              </li>
            );
          })}
        </ul>
      </ScrollShadow>
    </nav>
  );
}

/**
 * Right-aligned per-tab actions (CSV export, share, view toggles).
 *
 * Each consolidated page carried these in its own masthead. The hub owns the
 * masthead now, so they render here — above the tab content rather than beside
 * the tab strip, which is what keeps the strip full-width on mobile.
 */
export function HubTabActions({ children }: { children: ReactNode }) {
  return <div className="mb-4 flex items-center justify-end gap-2">{children}</div>;
}
