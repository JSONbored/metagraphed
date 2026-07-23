import { Link, useRouterState } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { lazy, Suspense } from "react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";

import { classNames } from "@/lib/metagraphed/format";
import {
  freshnessQuery,
  healthQuery,
  providersQuery,
  subnetsQuery,
} from "@/lib/metagraphed/queries";
import {
  MEGA_PANELS,
  loadFilters,
  loadPersistedOpen,
  persistFilter,
  persistOpen,
} from "./nav-mega-menu-data";

// Re-export the shared catalogue/helpers so existing import sites keep working.
export { MEGA_PANELS, pushRecentView, type MegaLink, type MegaPanel } from "./nav-mega-menu-data";

// The mega-menu preview panel — live snapshots, hover-card previews, the
// per-panel search index, and (on mobile) the accordion — is the bulk of this
// feature's weight, yet it only renders once a panel is hover/open-triggered.
// Code-split those bodies out of the global app-shell chunk so the always-
// present trigger row stays cheap on first paint. The triggers below are
// intentionally kept in this (statically imported) module so the nav is
// instant; React.lazy() resolves the panel chunk on first hover-intent.
const MegaPanelBody = lazy(() =>
  import("./nav-mega-menu-content").then((m) => ({ default: m.MegaPanelBody })),
);
const MobileMegaMenuBody = lazy(() =>
  import("./nav-mega-menu-content").then((m) => ({ default: m.MobileMegaMenuBody })),
);

interface NavMegaMenuProps {
  onNavigate?: () => void;
}

export function NavMegaMenu({ onNavigate }: NavMegaMenuProps) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const qc = useQueryClient();
  const [openKey, setOpenKeyState] = useState<string | null>(null);
  const [filters, setFilters] = useState<Record<string, string>>({});
  const openTimer = useRef<number | null>(null);
  const closeTimer = useRef<number | null>(null);
  const triggerRefs = useRef<Record<string, HTMLAnchorElement | null>>({});
  const filterInputRef = useRef<HTMLInputElement>(null);
  const itemsRef = useRef<Array<HTMLAnchorElement | null>>([]);
  const panelRef = useRef<HTMLDivElement>(null);
  const typeBufRef = useRef<string>("");
  const typeBufTimer = useRef<number | null>(null);

  // Prefetch the per-panel datasets on hover-intent so the panel never
  // appears with a blank snapshot / live area.
  const prefetchPanel = useCallback(
    (key: string) => {
      const opts =
        key === "subnets"
          ? subnetsQuery()
          : key === "providers"
            ? providersQuery()
            : key === "health" || key === "endpoints"
              ? healthQuery()
              : key === "surfaces"
                ? freshnessQuery()
                : null;
      if (opts) void qc.prefetchQuery(opts as Parameters<typeof qc.prefetchQuery>[0]);
    },
    [qc],
  );

  // Restore persisted state once.
  useEffect(() => {
    setFilters(loadFilters());
    const k = loadPersistedOpen();
    if (k && MEGA_PANELS.some((p) => p.key === k)) setOpenKeyState(k);
  }, []);

  const setOpenKey = useCallback((k: string | null) => {
    setOpenKeyState(k);
    persistOpen(k);
  }, []);

  function scheduleOpen(key: string) {
    if (closeTimer.current) {
      window.clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
    prefetchPanel(key);
    if (openTimer.current) window.clearTimeout(openTimer.current);
    openTimer.current = window.setTimeout(() => setOpenKey(key), 100);
  }
  function scheduleClose() {
    if (openTimer.current) {
      window.clearTimeout(openTimer.current);
      openTimer.current = null;
    }
    if (closeTimer.current) window.clearTimeout(closeTimer.current);
    closeTimer.current = window.setTimeout(() => setOpenKey(null), 160);
  }

  // Esc + outside click
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setOpenKey(null);
        // return focus to trigger
        const k = openKey;
        if (k) triggerRefs.current[k]?.focus();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openKey, setOpenKey]);

  // Reset item count when panel changes
  useEffect(() => {
    itemsRef.current = [];
  }, [openKey, filters]);

  const activePanel = MEGA_PANELS.find((p) => p.key === openKey) ?? null;

  function onTriggerKeyDown(e: ReactKeyboardEvent<HTMLAnchorElement>, key: string) {
    const idx = MEGA_PANELS.findIndex((p) => p.key === key);
    if (e.key === "ArrowRight") {
      e.preventDefault();
      const next = MEGA_PANELS[(idx + 1) % MEGA_PANELS.length];
      triggerRefs.current[next.key]?.focus();
      if (openKey) setOpenKey(next.key);
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      const prev = MEGA_PANELS[(idx - 1 + MEGA_PANELS.length) % MEGA_PANELS.length];
      triggerRefs.current[prev.key]?.focus();
      if (openKey) setOpenKey(prev.key);
    } else if (e.key === "ArrowDown" || e.key === "Enter") {
      e.preventDefault();
      setOpenKey(key);
      // focus search box after open
      window.setTimeout(() => filterInputRef.current?.focus(), 30);
    } else if (e.key === "Escape") {
      setOpenKey(null);
    }
  }

  function onPanelKeyDown(e: ReactKeyboardEvent<HTMLDivElement>) {
    // #3432: focus containment — while the modal panel is open, Tab / Shift+Tab
    // cycle only through the panel's own focusable elements (the filter input,
    // registered item links, and any inline links/buttons the content renders),
    // wrapping at the ends, instead of escaping into the underlying page.
    if (e.key === "Tab") {
      const panel = panelRef.current;
      if (!panel) return;
      const focusables = Array.from(
        panel.querySelectorAll<HTMLElement>(
          'a[href],button:not([disabled]),input:not([disabled]),[tabindex]:not([tabindex="-1"])',
        ),
      ).filter((el) => el.offsetWidth > 0 || el.offsetHeight > 0 || el === document.activeElement);
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
      return;
    }
    const items = itemsRef.current.filter(Boolean) as HTMLAnchorElement[];
    if (items.length === 0) return;
    const currentIdx = items.findIndex((el) => el === document.activeElement);
    if (e.key === "ArrowDown") {
      e.preventDefault();
      const next = currentIdx < 0 ? 0 : Math.min(items.length - 1, currentIdx + 1);
      items[next]?.focus();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (currentIdx <= 0) {
        filterInputRef.current?.focus();
      } else {
        items[currentIdx - 1]?.focus();
      }
    } else if (e.key === "Home") {
      e.preventDefault();
      items[0]?.focus();
    } else if (e.key === "End") {
      e.preventDefault();
      items[items.length - 1]?.focus();
    } else if (
      e.key.length === 1 &&
      !e.ctrlKey &&
      !e.metaKey &&
      !e.altKey &&
      document.activeElement !== filterInputRef.current
    ) {
      // Typeahead: append letter; jump to first item whose label starts
      // with the accumulated buffer. Buffer resets after 600 ms idle.
      typeBufRef.current += e.key.toLowerCase();
      if (typeBufTimer.current) window.clearTimeout(typeBufTimer.current);
      typeBufTimer.current = window.setTimeout(() => {
        typeBufRef.current = "";
      }, 600);
      const buf = typeBufRef.current;
      const start = Math.max(0, currentIdx);
      const ordered = [...items.slice(start + 1), ...items.slice(0, start + 1)];
      const match = ordered.find((el) =>
        (el.textContent ?? "").trim().toLowerCase().startsWith(buf),
      );
      if (match) {
        e.preventDefault();
        match.focus();
      }
    }
  }

  const registerItem = useCallback((el: HTMLAnchorElement | null, idx: number) => {
    itemsRef.current[idx] = el;
  }, []);

  return (
    <nav
      aria-label="Primary"
      className="hidden lg:flex items-center gap-0.5 relative"
      onMouseLeave={scheduleClose}
    >
      {MEGA_PANELS.map((p) => {
        const active = pathname === p.to || pathname.startsWith(p.to + "/");
        const isOpen = openKey === p.key;
        const Icon = p.icon;
        return (
          <div
            key={p.key}
            onMouseEnter={() => scheduleOpen(p.key)}
            onFocus={() => scheduleOpen(p.key)}
          >
            <Link
              to={p.to}
              ref={(el) => {
                triggerRefs.current[p.key] = el;
              }}
              aria-current={active ? "page" : undefined}
              aria-expanded={isOpen}
              aria-haspopup="true"
              onKeyDown={(e) => onTriggerKeyDown(e, p.key)}
              className={classNames(
                "relative inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 h-9 text-sm transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40",
                active || isOpen
                  ? "text-ink-strong font-medium"
                  : "text-ink-muted hover:text-ink-strong",
              )}
              onClick={() => {
                setOpenKey(null);
                onNavigate?.();
              }}
              preload="intent"
            >
              <Icon className={classNames("size-3.5", active ? "text-accent" : "opacity-70")} />
              <span>{p.label}</span>
              {active ? (
                <span
                  aria-hidden
                  className="pointer-events-none absolute left-3 right-3 -bottom-1 h-[1.5px] rounded-full bg-accent mg-fade-in"
                />
              ) : null}
            </Link>
          </div>
        );
      })}
      {activePanel ? (
        <>
          <div aria-hidden className="mg-mega-scrim" onClick={() => setOpenKey(null)} />
          <div
            ref={panelRef}
            className="absolute left-1/2 -translate-x-1/2 top-full mt-3 z-40"
            role="dialog"
            aria-modal="true"
            aria-label={`${activePanel.label} menu`}
            onKeyDown={onPanelKeyDown}
            onMouseEnter={() => {
              if (closeTimer.current) {
                window.clearTimeout(closeTimer.current);
                closeTimer.current = null;
              }
            }}
            onMouseLeave={scheduleClose}
          >
            <div className="w-[min(960px,calc(100vw-3rem))] rounded-xl mg-mega-surface mg-fade-in overflow-hidden">
              <div className="px-6 pt-5 pb-2 flex items-center gap-2 border-b border-border/70">
                <activePanel.icon className="size-3.5 text-accent" />
                <span className="font-display text-sm font-semibold text-ink-strong">
                  {activePanel.label}
                </span>
                <span className="text-[12px] text-ink-muted">— {activePanel.blurb}</span>
              </div>
              <Suspense fallback={<MegaPanelFallback />}>
                <MegaPanelBody
                  panel={activePanel}
                  filterValue={filters[activePanel.key] ?? ""}
                  onFilterChange={(v) => {
                    setFilters((prev) => ({ ...prev, [activePanel.key]: v }));
                    persistFilter(activePanel.key, v);
                  }}
                  filterInputRef={filterInputRef}
                  registerItem={registerItem}
                  onNavigate={() => {
                    setOpenKey(null);
                    onNavigate?.();
                  }}
                />
              </Suspense>
            </div>
          </div>
        </>
      ) : null}
    </nav>
  );
}

// Briefly shown while the lazily-loaded panel chunk resolves on first open.
// Mirrors the panel's grid footprint so the surface doesn't jump.
function MegaPanelFallback() {
  return (
    <div className="grid grid-cols-12 gap-6 p-6" aria-busy="true">
      <div className="col-span-12 h-9 rounded-md bg-surface animate-pulse" />
      <div className="col-span-5 h-28 rounded-md bg-surface animate-pulse" />
      <div className="col-span-4 h-28 rounded-md bg-surface animate-pulse" />
      <div className="col-span-3 h-28 rounded-md bg-surface animate-pulse" />
    </div>
  );
}

/* ───────────────────────── Mobile mega menu ───────────────────────── */

export function MobileMegaMenu({ onNavigate }: { onNavigate?: () => void }) {
  // The mobile drawer is only mounted while the sheet is open, so deferring the
  // accordion body keeps it out of the app-shell chunk without any UX cost.
  return (
    <Suspense fallback={<MobileMegaMenuFallback />}>
      <MobileMegaMenuBody onNavigate={onNavigate} />
    </Suspense>
  );
}

function MobileMegaMenuFallback() {
  return (
    <div className="flex flex-col gap-1" aria-busy="true">
      {[0, 1, 2, 3, 4].map((i) => (
        <div key={i} className="h-10 rounded-md bg-surface animate-pulse" />
      ))}
    </div>
  );
}
