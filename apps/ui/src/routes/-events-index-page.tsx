import { useNavigate, useSearch } from "@tanstack/react-router";
import { EntityHero, FactSentence } from "@jsonbored/ui-kit";
import type { EventsSearch } from "./chain.events";
import { ApiSourceFooter } from "@/components/metagraphed/api-source-footer";
import { AppShell } from "@/components/metagraphed/app-shell";
import { ChainEventsFeed } from "@/components/metagraphed/chain-events-feed";

/**
 * The chain-hub layout used to supply this page's shell: `AppShell`, the
 * `EntityHero` and the nine-tab strip all rendered once in chain.tsx, and
 * every stream page returned a bare fragment into its `<Outlet />`. #11619
 * emptied that layout -- four of the tabs are sections of /chain now, and a
 * tab strip whose tabs are anchors on the page below it is two navigations
 * for one destination -- so each remaining stream page owns its own shell.
 *
 * Self-contained rather than a smaller shared layout on purpose: three pages
 * is not enough shape to name a layer, and a layout that exists only to hold
 * a heading is the thing that just came out. The crumb back to /chain is the
 * whole of what the tab strip was actually load-bearing for.
 */
export function EventsPage() {
  const search = useSearch({ from: "/chain/events" }) as EventsSearch;
  const navigate = useNavigate({ from: "/chain/events" });

  const onFilter = (patch: { pallet?: string; method?: string; noise?: boolean }) =>
    navigate({
      search: (prev: Record<string, unknown>) => ({ ...prev, ...patch, cursor: "" }),
      resetScroll: false,
    });

  return (
    <AppShell>
      <EntityHero
        crumbs={[{ label: "Chain", href: "/chain" }]}
        name="Events"
        sentence={
          <FactSentence>
            Individual pallet events indexed directly from the chain, distinct from the aggregate
            activity stats.
          </FactSentence>
        }
      />
      <ChainEventsFeed
        pallet={search.pallet}
        method={search.method}
        cursor={search.cursor}
        showNoise={search.noise}
        onFilter={onFilter}
      />
      <ApiSourceFooter
        paths={["/api/v1/chain-events", "/api/v1/chain-events/stats", "/api/v1/chain/stream"]}
      />
    </AppShell>
  );
}
