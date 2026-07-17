import { useEffect } from "react";
import { useNavigate, useRouterState } from "@tanstack/react-router";

/**
 * Watches `location.hash` and:
 *  - if the hash is in `sectionToTab` and the current tab differs, switches
 *    the `tab` search param to the matching tab,
 *  - then smooth-scrolls the element with that id into view.
 *
 * This wires up cross-tab deep links like
 *   /subnets/7?tab=overview#endpoints
 * even when the section actually lives under a different tab.
 */
export function useHashScroll(activeTab: string, sectionToTab: Record<string, string>) {
  const navigate = useNavigate();
  const hash = useRouterState({ select: (s) => s.location.hash });

  useEffect(() => {
    if (!hash) return;
    const id = hash.replace(/^#/, "");
    if (!id) return;

    const expectedTab = sectionToTab[id];
    if (expectedTab && expectedTab !== activeTab) {
      navigate({
        to: ".",
        search: (prev: Record<string, unknown>) => ({ ...prev, tab: expectedTab }),
        hash: id,
        replace: true,
      });
      return;
    }

    // After tab switch / on initial mount, scroll the section into view AND
    // move focus (the screen-reader cursor) to it — scrollIntoView alone moves
    // the viewport but strands assistive tech, so a deep link / SectionAnchor
    // "copy link" announced nothing. Mirrors BackToTop's technique: a temporary
    // tabindex="-1" lets a non-focusable section receive focus, and
    // preventScroll keeps .focus() from fighting the smooth scroll above.
    const scroll = () => {
      const el = document.getElementById(id);
      if (!el) return;
      el.scrollIntoView({ behavior: "smooth", block: "start" });
      const hadTabIndex = el.hasAttribute("tabindex");
      if (!hadTabIndex) el.setAttribute("tabindex", "-1");
      el.focus({ preventScroll: true });
      if (!hadTabIndex) {
        // Clean up so we don't pollute the tab order.
        window.setTimeout(() => el.removeAttribute("tabindex"), 0);
      }
    };
    // Defer so the panel for the new tab has time to mount.
    const t = window.setTimeout(scroll, 80);
    return () => window.clearTimeout(t);
  }, [hash, activeTab, sectionToTab, navigate]);
}
