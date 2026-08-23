import { createFileRoute } from "@tanstack/react-router";
import { stripDefaultSearchParams } from "@/lib/metagraphed/url-state";
import { z } from "zod";
import { EventsPage } from "./-chain-stream-page";

const eventsSearchSchema = z.object({
  // Server-side filters wired to the /api/v1/chain-events feed. `method` is only
  // meaningful alongside a `pallet`, matching the embedded explorer feed (#6268).
  pallet: z.string().catch("").default(""),
  method: z.string().catch("").default(""),
  cursor: z.string().catch("").default(""),
  // #8253: hide the high-volume plumbing events (ExtrinsicSuccess /
  // ExtrinsicFailed / TransactionFeePaid) that were 68% of the unfiltered
  // feed when measured live. Defaults ON -- the URL param exists so the
  // firehose stays reachable and shareable, not because the noisy view is a
  // reasonable default.
  noise: z.boolean().catch(false).default(false),
});

export type EventsSearch = z.infer<typeof eventsSearchSchema>;

export const Route = createFileRoute("/chain/events")({
  validateSearch: eventsSearchSchema,
  search: { middlewares: [stripDefaultSearchParams(eventsSearchSchema)] },
  head: () => ({
    meta: [
      { title: "Chain events — Metagraphed" },
      {
        name: "description",
        content:
          "Individual Bittensor pallet events indexed directly from the chain — newest first, distinct from aggregate activity stats.",
      },
      { property: "og:title", content: "Chain events — Metagraphed" },
      {
        property: "og:description",
        content:
          "Individual Bittensor pallet events indexed directly from the chain — newest first, distinct from aggregate activity stats.",
      },
    ],
  }),
  component: EventsPage,
});
