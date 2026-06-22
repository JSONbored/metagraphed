import { useEffect, useState } from "react";
import { classNames } from "@/lib/metagraphed/format";

export interface QuickJumpItem {
  id: string;
  label: string;
}

/**
 * Sticky right-rail quick-jump for sections marked with
 * `data-section-anchor` (or any explicit `id`). Highlights the section
 * currently in view via IntersectionObserver, writes `#id` to the URL
 * on click (and updates as the user scrolls past anchors), and
 * smooth-scrolls to the clicked anchor. Updates URL via history.replace
 * so back/forward isn't polluted.
 */
export function SectionQuickJump({ items }: { items: QuickJumpItem[] }) {
  const [active, setActive] = useState<string>(items[0]?.id ?? "");

  useEffect(() => {
    if (typeof window === "undefined" || items.length === 0) return;
    const els = items
      .map((i) => document.getElementById(i.id))
      .filter((el): el is HTMLElement => !!el);
    if (els.length === 0) return;

    // Hash-on-load: if URL points to a known anchor, set it immediately.
    const initialHash = window.location.hash.replace(/^#/, "");
    if (initialHash && items.some((i) => i.id === initialHash)) {
      setActive(initialHash);
    }

    const visible = new Map<string, number>();
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) visible.set(e.target.id, e.intersectionRatio);
          else visible.delete(e.target.id);
        }
        if (visible.size === 0) return;
        // Pick the anchor with greatest visibility; tie-break by document order.
        let bestId = "";
        let bestRatio = -1;
        for (const it of items) {
          const r = visible.get(it.id);
          if (r != null && r > bestRatio) {
            bestRatio = r;
            bestId = it.id;
          }
        }
        if (bestId && bestId !== active) {
          setActive(bestId);
          // NOTE: intentionally do NOT mutate location.hash here. Writing the
          // hash during user scroll re-triggers hash-based scroll handlers
          // (see useHashScroll) and yanks the viewport back. URL only updates
          // on explicit click below.
        }
      },
      {
        // Anchor enters once 10% visible inside the viewport's middle band.
        rootMargin: "-30% 0px -55% 0px",
        threshold: [0, 0.1, 0.25, 0.5, 1],
      },
    );

    for (const el of els) io.observe(el);
    return () => io.disconnect();
  }, [items, active]);

  if (items.length === 0) return null;

  return (
    <nav aria-label="Section quick-jump" className="rounded-lg border border-border bg-card p-3">
      <div className="font-mono text-[10px] uppercase tracking-widest text-ink-muted mb-2">
        On this page
      </div>
      <ul className="space-y-0.5">
        {items.map((it) => {
          const isActive = it.id === active;
          return (
            <li key={it.id}>
              <a
                href={`#${it.id}`}
                onClick={(e) => {
                  e.preventDefault();
                  const el = document.getElementById(it.id);
                  if (!el) return;
                  // Ref-style scroll. Do NOT write `location.hash` — that
                  // re-triggers hash-based scroll handlers and yanks the
                  // viewport (the bug the back-to-top control also avoids).
                  el.scrollIntoView({ behavior: "smooth", block: "start" });
                  setActive(it.id);
                }}
                className={classNames(
                  "group flex items-center gap-2 rounded px-2 py-1 text-[12px] transition-colors",
                  isActive
                    ? "bg-surface text-ink-strong"
                    : "text-ink-muted hover:bg-surface/60 hover:text-ink-strong",
                )}
                aria-current={isActive ? "true" : undefined}
              >
                <span
                  aria-hidden
                  className={classNames(
                    "inline-block h-3 w-[2px] rounded-full transition-colors",
                    isActive ? "bg-accent" : "bg-border group-hover:bg-ink-muted",
                  )}
                />
                <span className="truncate">{it.label}</span>
              </a>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
