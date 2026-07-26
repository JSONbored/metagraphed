import { useCallback, useEffect, useRef } from "react";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { classNames } from "@/lib/metagraphed/format";
import { rovingTabIndex, useRovingTablist } from "@jsonbored/ui-kit";
import { ScrollShadow } from "@jsonbored/ui-kit";
import { useStickyStripHeight } from "@/hooks/use-sticky-strip-height";

export interface ProfileTabSpec {
  id: string;
  label: string;
  count?: number | string;
  badge?: React.ReactNode;
}

/**
 * URL-driven tab strip. Reads the `tab` search param (non-strict so any
 * parent route works) and updates it on change. Sticks under the app
 * header for cosmos-directory-style profile navigation. Implements the
 * WAI-ARIA APG tabs pattern (role=tablist + roving tabindex + arrow-key
 * activation) via `useRovingTablist`.
 */
export function ProfileTabs({
  tabs,
  defaultTab,
  trailing,
}: {
  tabs: ProfileTabSpec[];
  defaultTab?: string;
  trailing?: React.ReactNode;
}) {
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as Record<string, unknown>;
  const active = (search.tab as string) || defaultTab || tabs[0]?.id;
  const activeIndex = Math.max(
    0,
    tabs.findIndex((t) => t.id === active),
  );

  const selectAt = useCallback(
    (i: number) => {
      const t = tabs[i];
      if (!t) return;
      navigate({
        to: ".",
        search: (prev: Record<string, unknown>) => ({ ...prev, tab: t.id }),
        replace: true,
        resetScroll: false,
      });
    },
    [navigate, tabs],
  );

  const { tabRef, onKeyDown } = useRovingTablist(tabs.length, selectAt);

  // Publish this strip's height so the page's inner sticky bars stack under
  // it rather than pinning to the same offset (#8254).
  const navRef = useRef<HTMLElement>(null);
  useStickyStripHeight(navRef);

  // Keep the active tab visible when it changes (esp. useful when many tabs
  // overflow horizontally on tablet/mobile).
  const listRef = useRef<HTMLUListElement>(null);
  const activeBtnRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    const btn = activeBtnRef.current;
    if (!btn || typeof btn.scrollIntoView !== "function") return;
    btn.scrollIntoView({ behavior: "smooth", inline: "center", block: "nearest" });
  }, [active]);

  return (
    <nav
      ref={navRef}
      aria-label="Profile sections"
      className="sticky z-[var(--mg-z-sticky)] -mx-4 md:mx-0 mb-8 border-b border-border bg-paper/95 backdrop-blur supports-[backdrop-filter]:bg-paper/80"
      style={{ top: "var(--mg-sticky-offset, 3.5rem)" }}
    >
      {/*
        The trailing controls are shrink-0, so on a narrow viewport they took
        whatever width they needed and left the tab strip with the remainder:
        measured 196px of a 390px viewport on /subnets/74, i.e. 2 of 14 tabs
        reachable without scrolling (#8254). Horizontal scrolling, the
        ScrollShadow edge fades and the scroll-active-tab-into-view effect were
        all working the whole time -- the strip was simply being starved of
        width. Stack the two rows on mobile so the tabs get the full viewport,
        and keep the single-row layout from md up where both fit comfortably.
      */}
      <div className="flex flex-col gap-1 px-4 md:flex-row md:items-stretch md:gap-3 md:px-0">
        <ScrollShadow className="min-w-0 md:flex-1" innerClassName="scroll-smooth">
          <ul
            ref={listRef}
            role="tablist"
            aria-orientation="horizontal"
            className="flex items-center gap-6"
          >
            {tabs.map((t, i) => {
              const isActive = active === t.id;
              return (
                <li key={t.id} role="presentation">
                  <button
                    type="button"
                    role="tab"
                    aria-selected={isActive}
                    tabIndex={rovingTabIndex(i, activeIndex)}
                    ref={(el) => {
                      tabRef(i)(el);
                      if (isActive) activeBtnRef.current = el;
                    }}
                    onKeyDown={onKeyDown(i)}
                    onClick={() => selectAt(i)}
                    className={classNames(
                      "relative inline-flex items-center gap-1.5 px-1 py-3 mg-type-caption-lg font-medium whitespace-nowrap transition-colors mg-focus-ring",
                      isActive
                        ? "text-ink-strong after:absolute after:left-1 after:right-1 after:-bottom-[1.5px] after:h-[1.5px] after:rounded-full after:bg-accent after:content-['']"
                        : "text-ink-muted hover:text-ink-strong",
                    )}
                    aria-current={isActive ? "page" : undefined}
                  >
                    <span>{t.label}</span>
                    {t.count != null ? (
                      <span className="mg-type-data-sm text-ink-muted tabular-nums">{t.count}</span>
                    ) : null}
                    {isActive ? (
                      <span
                        aria-hidden
                        className="ml-0.5 inline-block size-1 rounded-full bg-accent"
                      />
                    ) : null}
                    {t.badge ? <span className="ml-0.5">{t.badge}</span> : null}
                  </button>
                </li>
              );
            })}
          </ul>
        </ScrollShadow>
        {trailing ? (
          <div className="flex shrink-0 items-center gap-2 py-1.5">{trailing}</div>
        ) : null}
      </div>
    </nav>
  );
}

export function useActiveTab(defaultTab: string): string {
  const search = useSearch({ strict: false }) as Record<string, unknown>;
  return (search.tab as string) || defaultTab;
}
