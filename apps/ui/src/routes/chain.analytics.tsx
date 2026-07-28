import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { fallback, zodValidator } from "@tanstack/zod-adapter";
import { ChainAnalyticsPage } from "./-chain-analytics-page";

const analyticsSearchSchema = z.object({
  window: fallback(z.enum(["7d", "30d"]), "7d").default("7d"),
});

export const Route = createFileRoute("/chain/analytics")({
  validateSearch: zodValidator(analyticsSearchSchema),
  head: () => ({
    meta: [
      { title: "Analytics — Chain — Metagraphed" },
      {
        name: "description",
        content:
          "Stake-flow sankey, concentration & emission trends, and registration economics for the Bittensor chain, computed live from the chain-direct tiers.",
      },
      { property: "og:title", content: "Analytics — Chain — Metagraphed" },
      {
        property: "og:description",
        content:
          "Stake-flow sankey, concentration & emission trends, and registration economics for the Bittensor chain, computed live from the chain-direct tiers.",
      },
    ],
  }),
  component: ChainAnalyticsPage,
});
