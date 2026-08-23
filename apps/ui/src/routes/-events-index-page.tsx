import { useNavigate, useSearch } from "@tanstack/react-router";
import type { EventsSearch } from "./chain.events";
import { ApiSourceFooter } from "@/components/metagraphed/api-source-footer";
import { ChainEventsFeed } from "@/components/metagraphed/chain-events-feed";

export function EventsPage() {
  const search = useSearch({ from: "/chain/events" }) as EventsSearch;
  const navigate = useNavigate({ from: "/chain/events" });

  const onFilter = (patch: { pallet?: string; method?: string; noise?: boolean }) =>
    navigate({
      search: (prev: Record<string, unknown>) => ({ ...prev, ...patch, cursor: "" }),
      resetScroll: false,
    });

  return (
    <>
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
