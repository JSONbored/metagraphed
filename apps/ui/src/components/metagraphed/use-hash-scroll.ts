import { useEffect } from "react";
import { useNavigate, useRouterState } from "@tanstack/react-router";

/** The slice of an element `focusHashTarget` needs — kept structural so the
 * branch is unit-testable with a fake handle (the suite has no DOM), and so a
 * real `HTMLElement` satisfies it without a cast. */
export interface FocusableEl {
  hasAttribute(name: string): boolean;
  setAttribute(name: string, value: string): void;
  classList: { add(token: string): void };
  focus(options?: { preventScroll?: boolean }): void;
}

export type HashDestination =
  string | { tab: string; target?: string; search?: Readonly<Record<string, unknown>> };

/**
 * Move DOM focus — and with it the screen-reader cursor — to a hash-nav target
 * after it has scrolled into view (#6421). `scrollIntoView` moves only the
 * viewport, so without this a deep link is silent to screen-reader users and a
 * no-op for keyboard users (whose next Tab still starts from the top).
 *
 * A `<section>`/`<h2>` isn't focusable by default, so give it `tabindex="-1"`
 * when it lacks one, and focus with `preventScroll: true` so it doesn't fight
 * the smooth scroll — the technique `back-to-top.tsx` uses. The one departure:
 * `back-to-top.tsx` strips the tabindex from `<main>` on a 0ms timer, but doing
 * that here blurs the freshly focused section straight back to `<body>`
 * (verified) — which reverts a keyboard user's focus to the top and defeats the
 * "focus follows the scroll" outcome. `tabindex="-1"` is not a keyboard tab
 * stop, so leaving it in place keeps focus on the section without polluting the
 * tab order (the only thing the removal guarded against). An element that
 * already carries a tabindex keeps its own value, untouched.
 *
 * The `mg-hash-focus` class swaps the browser's default focus outline — a boxy,
 * off-brand rectangle — for the app's soft accent ring (styles.css). It's
 * scoped to `:focus`, so the class can persist harmlessly and only paints while
 * the element is actually focused. Programmatic focus fires `:focus` but not
 * `:focus-visible`, which is why the rule targets `:focus` directly.
 */
export function focusHashTarget(el: FocusableEl): void {
  el.classList.add("mg-hash-focus");
  if (!el.hasAttribute("tabindex")) el.setAttribute("tabindex", "-1");
  el.focus({ preventScroll: true });
}

/**
 * Watches `location.hash` and:
 *  - if the hash is in `sectionToTab` and the current tab differs, switches
 *    the `tab` search param to the matching tab,
 *  - then smooth-scrolls the mapped element into view and moves focus to it so
 *    legacy hashes can resolve to a consolidated section without silently
 *    losing a deep link (#6421).
 *
 * This wires up cross-tab deep links like
 *   /subnets/7?tab=overview#endpoints
 * even when the section actually lives under a different tab.
 */
export function useHashScroll(
  activeTab: string,
  sectionToTab: Record<string, HashDestination>,
  activeSearch?: Readonly<Record<string, unknown>>,
) {
  const navigate = useNavigate();
  const hash = useRouterState({ select: (s) => s.location.hash });

  useEffect(() => {
    if (!hash) return;
    const id = hash.replace(/^#/, "");
    if (!id) return;

    const destination = sectionToTab[id];
    const expectedTab = typeof destination === "string" ? destination : destination?.tab;
    const targetId = typeof destination === "string" ? id : (destination?.target ?? id);
    const expectedSearch = typeof destination === "string" ? undefined : destination?.search;
    const searchDiffers = Object.entries(expectedSearch ?? {}).some(
      ([key, value]) => activeSearch?.[key] !== value,
    );
    if ((expectedTab && expectedTab !== activeTab) || searchDiffers) {
      navigate({
        to: ".",
        search: (prev: Record<string, unknown>) => ({
          ...prev,
          tab: expectedTab,
          ...expectedSearch,
        }),
        hash: id,
        replace: true,
      });
      return;
    }

    // After tab switch / on initial mount, scroll the section into view and
    // move focus to it, so keyboard/screen-reader users following the link
    // land on the section rather than having only the viewport shift (#6421).
    const scroll = () => {
      const el = document.getElementById(targetId);
      if (!el) return;
      // Deep links should also reveal intentionally-disclosed forensic data;
      // otherwise the browser can focus a hidden target with no visible result.
      const disclosure = el.closest("details");
      if (disclosure) disclosure.open = true;
      const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
      el.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "start" });
      // Focus the section's heading when it has one, else the section itself
      // (#6421 permits either). The heading is the better target: its focus
      // ring is a tight, legible indicator rather than an outline around the
      // whole section box, and a screen reader announces the heading text.
      const focusTarget = el.querySelector<HTMLElement>("h1, h2, h3, h4, [role='heading']") ?? el;
      focusHashTarget(focusTarget);
    };
    // Defer so the panel for the new tab has time to mount.
    const t = window.setTimeout(scroll, 80);
    return () => window.clearTimeout(t);
  }, [hash, activeTab, sectionToTab, activeSearch, navigate]);
}
