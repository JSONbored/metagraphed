import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { fallback, zodValidator } from "@tanstack/zod-adapter";
import { ExplorerPage } from "./-explorer-page";

/**
 * Chain hub Overview — the retired /explorer (#8292, completing #8244).
 *
 * Bare /chain is the overview, so the hub's landing page is the network at a
 * glance rather than a redirect into one of its tabs.
 */
const overviewSearchSchema = z.object({
  window: fallback(z.enum(["7d", "30d"]), "7d").default("7d"),
  pallet: fallback(z.string(), "").default(""),
  method: fallback(z.string(), "").default(""),
  events_cursor: fallback(z.string(), "").default(""),
});

export const Route = createFileRoute("/chain/")({
  validateSearch: zodValidator(overviewSearchSchema),
  head: () => ({
    meta: [
      { title: "Chain — Metagraphed" },
      {
        name: "description",
        content:
          "The Bittensor network at a glance — daily activity, fees, call mix, and the most active accounts, computed live from the chain-direct tiers.",
      },
      { property: "og:title", content: "Chain — Metagraphed" },
      {
        property: "og:description",
        content:
          "The Bittensor network at a glance — daily activity, fees, call mix, and the most active accounts, computed live from the chain-direct tiers.",
      },
    ],
  }),
  component: ExplorerPage,
});
