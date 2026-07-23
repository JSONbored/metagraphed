import { useCallback, useEffect, useRef } from "react";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { classNames } from "@/lib/metagraphed/format";
import { rovingTabIndex, useRovingTablist } from "@jsonbored/ui-kit";
import { ScrollShadow } from "@jsonbored/ui-kit";

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
      aria-label="Profile sections"
      className="sticky z-10 -mx-4 md:mx-0 mb-8 border-b border-border bg-paper/95 backdrop-blur supports-[backdrop-filter]:bg-paper/80"
      style={{ top: "var(--mg-sticky-offset, 3.5rem)" }}
    >
      <div className="flex items-stretch gap-3 px-4 md:px-0">
        <ScrollShadow className="min-w-0 flex-1" innerClassName="scroll-smooth">
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
                      "relative inline-flex items-center gap-1.5 px-1 py-3 text-[13px] font-medium whitespace-nowrap transition-colors mg-focus-ring",
                      isActive
                        ? "text-ink-strong after:absolute after:left-1 after:right-1 after:-bottom-[1.5px] after:h-[1.5px] after:rounded-full after:bg-accent after:content-['']"
                        : "text-ink-muted hover:text-ink-strong",
                    )}
                    aria-current={isActive ? "page" : undefined}
                  >
                    <span>{t.label}</span>
                    {t.count != null ? (
                      <span className="font-mono text-[10px] text-ink-muted tabular-nums">
                        {t.count}
                      </span>
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
