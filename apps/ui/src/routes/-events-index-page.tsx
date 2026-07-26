import { useNavigate, useSearch } from "@tanstack/react-router";
import { ApiSourceFooter } from "@/components/metagraphed/api-source-footer";
import { ChainEventsFeed, chainEventsBaseParams } from "@/components/metagraphed/chain-events-feed";
import { ShareButton, DownloadCsvButton, ActionBar } from "@jsonbored/ui-kit";
import { buildUrl } from "@/lib/metagraphed/client";
import { ChainTabActions } from "./-chain-hub";

export function EventsPage() {
  const search = useSearch({ from: "/chain/events" });
  const navigate = useNavigate({ from: "/chain/events" });
  const eventsCsvUrl = buildUrl(
    "/api/v1/chain-events",
    chainEventsBaseParams(search.pallet, search.method),
  );

  const onFilter = (patch: { pallet?: string; method?: string; noise?: boolean }) =>
    navigate({
      search: (prev: Record<string, unknown>) => ({ ...prev, ...patch, cursor: "" }) as never,
      resetScroll: false,
    });

  return (
    <>
      <ChainTabActions>
        <ActionBar>
          <DownloadCsvButton url={eventsCsvUrl} bare />
          <ShareButton bare />
        </ActionBar>
      </ChainTabActions>
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
    </>
  );
}
