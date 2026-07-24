import { createFileRoute } from "@tanstack/react-router";
import { PortfolioPage } from "./-portfolio-page";

export const Route = createFileRoute("/portfolio")({
  head: () => ({
    meta: [
      { title: "Your positions — Metagraphed" },
      {
        name: "description",
        content:
          "Your Bittensor staking positions across every subnet for the connected wallet — hotkey-owned and delegated, valued at spot and at a slippage-aware simulated exit.",
      },
      { property: "og:title", content: "Your positions — Metagraphed" },
      {
        property: "og:description",
        content:
          "Cross-subnet staking positions for the connected wallet — spot vs. simulated-exit value, root/alpha split, and yield.",
      },
    ],
  }),
  component: PortfolioPage,
});
