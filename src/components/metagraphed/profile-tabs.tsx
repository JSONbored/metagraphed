import { useNavigate, useSearch } from "@tanstack/react-router";
import { classNames } from "@/lib/metagraphed/format";

export interface ProfileTabSpec {
  id: string;
  label: string;
  count?: number | string;
  badge?: React.ReactNode;
}

/**
 * URL-driven tab strip. Reads the `tab` search param (non-strict so any
 * parent route works) and updates it on change. Sticks under the app
 * header for cosmos-directory-style profile navigation.
 */
export function ProfileTabs({ tabs, defaultTab }: { tabs: ProfileTabSpec[]; defaultTab?: string }) {
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as Record<string, unknown>;
  const active = (search.tab as string) || defaultTab || tabs[0]?.id;

  return (
    <nav
      aria-label="Profile sections"
      className="sticky top-14 z-10 -mx-4 md:mx-0 mt-4 border-b border-border bg-paper/95 backdrop-blur supports-[backdrop-filter]:bg-paper/80 md:rounded md:border md:bg-card"
    >
      <ul className="flex items-center gap-1 overflow-x-auto px-2 py-1.5">
        {tabs.map((t) => {
          const isActive = active === t.id;
          return (
            <li key={t.id}>
              <button
                type="button"
                onClick={() =>
                  navigate({
                    to: ".",
                    search: (prev: Record<string, unknown>) => ({ ...prev, tab: t.id }),
                    replace: true,
                  })
                }
                className={classNames(
                  "relative inline-flex items-center gap-1.5 rounded px-2.5 py-1 text-[12px] font-medium whitespace-nowrap transition-colors",
                  isActive
                    ? "bg-surface text-ink-strong after:absolute after:left-2 after:right-2 after:-bottom-[7px] after:h-[2px] after:rounded-full after:bg-accent after:content-['']"
                    : "text-ink-muted hover:text-ink-strong hover:bg-surface/60",
                )}
                aria-current={isActive ? "page" : undefined}
              >
                <span>{t.label}</span>
                {t.count != null ? (
                  <span className="font-mono text-[10px] text-ink-muted tabular-nums">
                    {t.count}
                  </span>
                ) : null}
                {t.badge ? <span className="ml-0.5">{t.badge}</span> : null}
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

export function useActiveTab(defaultTab: string): string {
  const search = useSearch({ strict: false }) as Record<string, unknown>;
  return (search.tab as string) || defaultTab;
}
