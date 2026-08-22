import { Link, useRouterState } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { SectionNav, type SectionNavLink } from "@jsonbored/ui-kit";

/**
 * A hub's sub-routes as the one section nav (#11607): `/chain/*` and
 * `/apis/*` are routes, not in-page sections, so the items carry `href` and
 * the current one is derived from the pathname by longest-prefix match.
 */
export interface HubTab {
  to: string;
  label: string;
  /** Shown under the hub title while this tab is active. */
  blurb: string;
}

export function activeHubTab<T extends HubTab>(tabs: readonly T[], pathname: string): T {
  const match = [...tabs]
    .sort((a, b) => b.to.length - a.to.length)
    .find((t) => pathname === t.to || pathname.startsWith(`${t.to}/`));
  return match ?? tabs[0]!;
}

const RouterLink: SectionNavLink = ({ href, children, ...rest }) => (
  <Link to={href} {...rest}>
    {children}
  </Link>
);

export function HubNav({ tabs }: { tabs: readonly HubTab[] }) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const active = activeHubTab(tabs, pathname);
  return (
    <SectionNav
      link={RouterLink}
      items={tabs.map((t) => ({
        id: t.to,
        name: t.label,
        href: t.to,
        current: t.to === active.to,
      }))}
    />
  );
}

/** The row of page-level actions under a hub nav. */
export function HubTabActions({ children }: { children: ReactNode }) {
  return <div className="mg-actions mb-4 justify-end">{children}</div>;
}
