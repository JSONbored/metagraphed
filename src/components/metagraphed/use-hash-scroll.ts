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
export function useHashScroll(
  activeTab: string,
  sectionToTab: Record<string, string>,
) {
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

    // After tab switch / on initial mount, scroll the section into view.
    const scroll = () => {
      const el = document.getElementById(id);
      if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
    };
    // Defer so the panel for the new tab has time to mount.
    const t = window.setTimeout(scroll, 80);
    return () => window.clearTimeout(t);
  }, [hash, activeTab, sectionToTab, navigate]);
}
