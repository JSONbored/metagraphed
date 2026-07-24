import { useNavigate, useSearch } from "@tanstack/react-router";
import { AppShell } from "@/components/metagraphed/app-shell";
import { ApiSourceFooter } from "@/components/metagraphed/api-source-footer";
import { ChainEventsFeed, chainEventsBaseParams } from "@/components/metagraphed/chain-events-feed";
import { ShareButton, DownloadCsvButton, ActionBar } from "@jsonbored/ui-kit";
import { PageMasthead } from "@/components/metagraphed/primitives";
import { buildUrl } from "@/lib/metagraphed/client";

export function EventsPage() {
  const search = useSearch({ from: "/events/" });
  const navigate = useNavigate({ from: "/events/" });
  const eventsCsvUrl = buildUrl(
    "/api/v1/chain-events",
    chainEventsBaseParams(search.pallet, search.method),
  );

  const onFilter = (patch: { pallet?: string; method?: string }) =>
    navigate({
      search: (prev: Record<string, unknown>) => ({ ...prev, ...patch, cursor: "" }) as never,
      resetScroll: false,
    });

  return (
    <AppShell>
      <PageMasthead
        eyebrow="Explorer"
        live
        title="Chain events"
        description="Individual Bittensor pallet events indexed directly from the chain — newest first, distinct from aggregate activity stats."
        actions={
          <ActionBar>
            <DownloadCsvButton url={eventsCsvUrl} bare />
            <ShareButton bare />
          </ActionBar>
        }
      />
      <ChainEventsFeed
        pallet={search.pallet}
        method={search.method}
        cursor={search.cursor}
        onFilter={onFilter}
      />
      <ApiSourceFooter
        paths={["/api/v1/chain-events", "/api/v1/chain-events/stats", "/api/v1/chain/stream"]}
      />
    </AppShell>
  );
}
