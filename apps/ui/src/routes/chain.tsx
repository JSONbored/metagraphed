import { createFileRoute, Outlet, useRouterState } from "@tanstack/react-router";
import { AppShell } from "@/components/metagraphed/app-shell";
import {
  DataPageCanvas,
  DataPageHero,
  DataPageModule,
  DataPageStage,
} from "@/components/metagraphed/primitives";
import { ChainTabs, activeChainTab } from "./-chain-hub";

/**
 * Chain hub layout (#8244) — one destination for what used to be nine
 * top-level routes (/explorer, /blocks, /extrinsics, /events, /sudo,
 * /admin-changes, /runtime, plus their shared preamble duplication).
 *
 * The title field and tab strip render once here rather than per page. Every
 * tab gets the same reading order: orient, choose a chain task, then inspect
 * its data — rather than rebuilding a heading and a card wall on every route.
 *
 * Detail routes (/blocks/$ref, /extrinsics/$hash) deliberately keep their own
 * URLs — only the index pages consolidate, so every existing deep link, share
 * card and agent-facing path to a specific block or extrinsic still resolves.
 */
function ChainHubLayout() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const tab = activeChainTab(pathname);
  // Analytics owns a dedicated, spacious data hero. Keeping the generic
  // compact Chain masthead above it creates two competing introductions.
  const hasDedicatedHero = pathname === "/chain/analytics";

  if (hasDedicatedHero) {
    return (
      <AppShell>
        <DataPageStage variant="tabs">
          <ChainTabs className="mg-data-hub-tabs" />
        </DataPageStage>
        <Outlet />
      </AppShell>
    );
  }

  return (
    <AppShell>
      <DataPageStage>
        <DataPageHero
          id="chain-title"
          eyebrow="Chain explorer"
          live
          title={`${tab.label}.`}
          description={tab.blurb}
        />
        <DataPageCanvas>
          <ChainTabs className="mg-data-hub-tabs" />
          <DataPageModule>
            <Outlet />
          </DataPageModule>
        </DataPageCanvas>
      </DataPageStage>
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
