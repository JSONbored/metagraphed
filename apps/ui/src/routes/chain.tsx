import { createFileRoute, Outlet, useRouterState } from "@tanstack/react-router";
import { AppShell } from "@/components/metagraphed/app-shell";
import { PageMasthead } from "@/components/metagraphed/primitives";
import { ChainTabs, activeChainTab } from "./-chain-hub";

/**
 * Chain hub layout (#8244) — one destination for what used to be nine
 * top-level routes (/explorer, /blocks, /extrinsics, /events, /sudo,
 * /admin-changes, /runtime, plus their shared preamble duplication).
 *
 * The masthead and tab strip render once here rather than per page, which is
 * most of the point: each old route rebuilt its own heading, breadcrumb and
 * stat preamble, and several rebuilt each other's stats too.
 *
 * Detail routes (/blocks/$ref, /extrinsics/$hash) deliberately keep their own
 * URLs — only the index pages consolidate, so every existing deep link, share
 * card and agent-facing path to a specific block or extrinsic still resolves.
 */
function ChainHubLayout() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const tab = activeChainTab(pathname);

  return (
    <AppShell>
      <PageMasthead title="Chain" description={tab.blurb} pathname={pathname} live />
      <ChainTabs />
      <Outlet />
    </AppShell>
  );
}

export const Route = createFileRoute("/chain")({
  head: () => ({
    meta: [
      { title: "Chain — Metagraphed" },
      {
        name: "description",
        content:
          "The Bittensor chain at a glance — blocks, extrinsics, events, governance and runtime upgrades, indexed directly from the chain.",
      },
      { property: "og:title", content: "Chain — Metagraphed" },
      {
        property: "og:description",
        content:
          "The Bittensor chain at a glance — blocks, extrinsics, events, governance and runtime upgrades, indexed directly from the chain.",
      },
    ],
  }),
  component: ChainHubLayout,
});
