import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { z } from "zod";
import { fallback, zodValidator } from "@tanstack/zod-adapter";
import { AppShell } from "@/components/metagraphed/app-shell";
import { ApiSourceFooter } from "@/components/metagraphed/api-source-footer";
import { ChainEventsFeed, chainEventsBaseParams } from "@/components/metagraphed/chain-events-feed";
import { ShareButton, DownloadCsvButton, ActionBar } from "@jsonbored/ui-kit";
import { PageMasthead } from "@/components/metagraphed/primitives";
import { buildUrl } from "@/lib/metagraphed/client";

const eventsSearchSchema = z.object({
  // Server-side filters wired to the /api/v1/chain-events feed. `method` is only
  // meaningful alongside a `pallet`, matching the embedded explorer feed (#6268).
  pallet: fallback(z.string(), "").default(""),
  method: fallback(z.string(), "").default(""),
  cursor: fallback(z.string(), "").default(""),
});

export const Route = createFileRoute("/events/")({
  validateSearch: zodValidator(eventsSearchSchema),
  head: () => ({
    meta: [
      { title: "Chain events — Metagraphed" },
      {
        name: "description",
        content:
          "Recent Bittensor pallet events indexed from the chain — pallet.method, block, and observation time, newest first.",
      },
      { property: "og:title", content: "Chain events — Metagraphed" },
      {
        property: "og:description",
        content:
          "Recent Bittensor pallet events indexed from the chain — pallet.method, block, and observation time, newest first.",
      },
    ],
  }),
  component: EventsPage,
});

function EventsPage() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
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
