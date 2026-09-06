import { ogImageMeta } from "@/lib/metagraphed/og-card";
import { eventOgContent } from "@/lib/metagraphed/og-entity-content";
import { createFileRoute, notFound } from "@tanstack/react-router";
import { AppShell } from "@/components/metagraphed/app-shell";
import { EntityRouteLoadingSkeleton } from "@/components/metagraphed/route-loading-skeleton";
import { EmptyState, PageHeading } from "@/components/metagraphed/states";
import {
  entityNotFoundMeta,
  isMissingEntityError,
  isNotFoundMatch,
} from "@/lib/metagraphed/entity-not-found-meta";
import { rateLimitedResponse } from "@/lib/metagraphed/rate-limited-response";
import { EventDetailPage } from "./-event-detail-page";

function eventCoordinate(raw: string): string {
  if (!/^\d+$/.test(raw)) throw notFound();
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) throw notFound();
  return String(value);
}

function eventName(event: { pallet?: string | null; method?: string | null }): string | null {
  const pallet = event.pallet?.trim();
  const method = event.method?.trim();
  return pallet && method ? `${pallet}.${method}` : pallet || method || null;
}

export const Route = createFileRoute("/events/$block/$index")({
  parseParams: ({ block, index }) => ({
    block: eventCoordinate(block),
    index: eventCoordinate(index),
  }),
  loader: async ({ context, params }) => {
    let result;
    try {
      const { blockChainEventsQuery } = await import("@/lib/metagraphed/queries");
      result = await context.queryClient.ensureQueryData(blockChainEventsQuery(params.block));
    } catch (error) {
      const throttled = rateLimitedResponse(error);
      if (throttled) throw throttled;
      if (isMissingEntityError(error)) throw notFound();
      return null;
    }
    const event = result.data.events.find((row) => row.event_index === Number(params.index));
    if (!event) throw notFound();
    return { label: eventName(event), blockNumber: event.block_number ?? Number(params.block) };
  },
  head: ({ params, loaderData, match }) => {
    if (isNotFoundMatch(match)) {
      return entityNotFoundMeta(
        "Event",
        "No indexed Bittensor event matches this block and event index.",
      );
    }
    const block = loaderData?.blockNumber ?? Number(params.block);
    const label = loaderData?.label ?? `Event #${params.index}`;
    const title = `${label} in block #${block} — Metagraphed`;
    const description = `Decoded Bittensor event ${params.index} in block ${block}: pallet, method, phase, originating extrinsic, and full arguments.`;
    return {
      meta: [
        { title },
        { name: "description", content: description },
        { property: "og:title", content: title },
        { property: "og:description", content: description },
        ...ogImageMeta(eventOgContent(block, params.index, label)),
      ],
    };
  },
  pendingComponent: EntityRouteLoadingSkeleton,
  notFoundComponent: () => (
    <AppShell>
      <PageHeading
        eyebrow="Explorer"
        title="Event not found"
        description="This block and event index name no decoded event."
      />
      <EmptyState
        title="Event not found"
        description="No indexed event matches these coordinates. The block may not be indexed yet, or the event index may be outside its decoded record."
        action={{ label: "Back to events", href: "/chain/events" }}
      />
    </AppShell>
  ),
  component: EventDetailPage,
});
