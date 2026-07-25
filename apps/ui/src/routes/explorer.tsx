import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { fallback, zodValidator } from "@tanstack/zod-adapter";
import { ExplorerPage } from "./-explorer-page";

const explorerSearchSchema = z.object({
  window: fallback(z.enum(["7d", "30d"]), "7d").default("7d"),
  pallet: fallback(z.string(), "").default(""),
  method: fallback(z.string(), "").default(""),
  events_cursor: fallback(z.string(), "").default(""),
});

export const Route = createFileRoute("/explorer")({
  validateSearch: zodValidator(explorerSearchSchema),
  head: () => ({
    meta: [
      { title: "Chain explorer — Metagraphed" },
      {
        name: "description",
        content:
          "Bittensor network at a glance: daily extrinsic/block/event activity, fees, call mix, and the most active accounts — chain-direct analytics.",
      },
      { property: "og:title", content: "Chain explorer — Metagraphed" },
      {
        property: "og:description",
        content:
          "Bittensor network at a glance: daily activity, fees, call mix, and the most active accounts.",
      },
    ],
  }),
  component: ExplorerPage,
});
