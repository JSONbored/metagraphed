import { Link, useRouterState } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { ScrollShadow } from "@jsonbored/ui-kit";
import { classNames } from "@/lib/metagraphed/format";

/**
 * The Chain hub's tab set (#8290, part of #8244).
 *
 * Nine top-level routes are collapsing into one destination. They were always
 * one concept — "what the chain is doing" — split across nine pages that each
 * rebuilt their own heading and preamble, and several of which duplicated each
 * other's stats (the activity charts existed on both /explorer and /blocks;
 * most-active accounts on both /explorer and /leaderboards).
 *
 * This list grows one PR at a time so each is reviewable: Blocks and Extrinsics
 * here, then Events/Governance/Runtime (#8291), then Overview (#8292, which
 * also retires /explorer and takes over the bare /chain path).
 */
export interface ChainTab {
  to: string;
  label: string;
  /** Shown under the hub title while this tab is active. */
  blurb: string;
}

export const CHAIN_TABS: readonly ChainTab[] = [
  {
    to: "/chain",
    label: "Overview",
    blurb:
      "The network at a glance — daily activity, fees, call mix, and the most active accounts, computed live from the chain-direct tiers.",
  },
  {
    to: "/chain/blocks",
    label: "Blocks",
    blurb:
      "Recent blocks indexed directly from the chain — newest first, with author, extrinsic and event counts.",
  },
  {
    to: "/chain/extrinsics",
    label: "Extrinsics",
    blurb:
      "Recent transactions indexed directly from the chain — newest first, with call, signer and result.",
  },
  {
    to: "/chain/events",
    label: "Events",
    blurb:
      "Individual pallet events indexed directly from the chain, distinct from the aggregate activity stats.",
  },
  {
    to: "/chain/governance",
    label: "Governance",
    blurb:
      "Root-origin activity: Sudo calls and the AdminUtils config changes that tune subnet hyperparameters.",
  },
  {
    to: "/chain/runtime",
    label: "Runtime",
    blurb:
      "Spec-version upgrade history from the first-party blocks tier — every upgrade observed, newest first.",
  },
] as const;

export function activeChainTab(pathname: string): ChainTab {
  // Longest match first, so a future bare /chain overview can coexist with
  // /chain/<tab> without the shorter path swallowing them.
  const match = [...CHAIN_TABS]
    .sort((a, b) => b.to.length - a.to.length)
    .find((t) => pathname === t.to || pathname.startsWith(`${t.to}/`));
  return match ?? CHAIN_TABS[0]!;
}

/**
 * Hub tab strip.
 *
 * Deliberately has no sibling in its flex row. The profile-tabs strip was
 * starved to 196px of a 390px viewport because a `shrink-0` controls cluster
 * sat beside it (#8254) — per-tab actions here render inside the tab content
 * instead, via ChainTabActions, so the tabs always own the full width.
 */
export function ChainTabs() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const active = activeChainTab(pathname);

  return (
    <nav
      aria-label="Chain sections"
      className="sticky z-[var(--mg-z-sticky)] -mx-4 mb-8 border-b border-border bg-paper/95 backdrop-blur supports-[backdrop-filter]:bg-paper/80 md:mx-0"
      style={{ top: "var(--mg-sticky-offset, 3.5rem)" }}
    >
      <ScrollShadow className="min-w-0" innerClassName="scroll-smooth">
        <ul className="flex items-center gap-6 px-4 md:px-0" role="list">
          {CHAIN_TABS.map((tab) => {
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
 * Right-aligned per-tab actions (CSV export, share).
 *
 * Each consolidated page carried these in its own masthead. The hub owns the
 * masthead now, so they render here — above the tab's content rather than
 * beside the tab strip, which is what keeps the strip full-width on mobile.
 */
export function ChainTabActions({ children }: { children: ReactNode }) {
  return <div className="mb-4 flex items-center justify-end gap-2">{children}</div>;
}
