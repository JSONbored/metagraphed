import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { fallback, zodValidator } from "@tanstack/zod-adapter";
import { LeaderboardsPage } from "./-leaderboards-page";

export const leaderboardsSearchSchema = z.object({
  window: fallback(z.enum(["7d", "30d"]), "7d").default("7d"),
});

export const Route = createFileRoute("/leaderboards")({
  validateSearch: zodValidator(leaderboardsSearchSchema),
  head: () => ({
    meta: [
      { title: "Leaderboards — Metagraphed" },
      {
        name: "description",
        content:
          "Network-wide Bittensor leaderboards — registry health, RPC latency, completeness and economic-opportunity boards, plus validator weight-setting activity and neuron deregistrations ranked by subnet.",
      },
      { property: "og:title", content: "Leaderboards — Metagraphed" },
      {
        property: "og:description",
        content:
          "Network-wide Bittensor leaderboards — registry health, RPC latency, completeness and economic-opportunity boards, plus validator weight-setting activity and neuron deregistrations ranked by subnet.",
      },
    ],
  }),
  component: LeaderboardsPage,
});
