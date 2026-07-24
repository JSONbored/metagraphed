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
