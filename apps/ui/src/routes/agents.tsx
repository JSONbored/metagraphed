import { createFileRoute } from "@tanstack/react-router";
import { AgentsPage } from "./-agents-page";

export const Route = createFileRoute("/agents")({
  head: () => ({
    meta: [
      { title: "For AI agents — Metagraphed" },
      {
        name: "description",
        content:
          "Connect AI agents to Metagraphed via MCP, tool specs, llms.txt, grounded Q&A, semantic search, and bulk data across every Bittensor subnet.",
      },
      { property: "og:title", content: "For AI agents — Metagraphed" },
    ],
  }),
  component: AgentsPage,
});
