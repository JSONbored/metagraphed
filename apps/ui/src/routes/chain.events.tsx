import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { fallback, zodValidator } from "@tanstack/zod-adapter";
import { EventsPage } from "./-events-index-page";

const eventsSearchSchema = z.object({
  // Server-side filters wired to the /api/v1/chain-events feed. `method` is only
  // meaningful alongside a `pallet`, matching the embedded explorer feed (#6268).
  pallet: fallback(z.string(), "").default(""),
  method: fallback(z.string(), "").default(""),
  cursor: fallback(z.string(), "").default(""),
  // #8253: hide the high-volume plumbing events (ExtrinsicSuccess /
  // ExtrinsicFailed / TransactionFeePaid) that were 68% of the unfiltered
  // feed when measured live. Defaults ON -- the URL param exists so the
  // firehose stays reachable and shareable, not because the noisy view is a
  // reasonable default.
  noise: fallback(z.boolean(), false).default(false),
});

export const Route = createFileRoute("/chain/events")({
  validateSearch: zodValidator(eventsSearchSchema),
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
