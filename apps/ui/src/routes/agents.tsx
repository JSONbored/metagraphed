import { createFileRoute } from "@tanstack/react-router";
import { AgentsPage } from "./-agents-page";

export const Route = createFileRoute("/agents")({
  head: () => ({
    meta: [
      { title: "For AI agents — Metagraphed" },
      {
        name: "description",
        content:
          "Metagraphed is machine-readable end to end: MCP server, agent tool specs, llms.txt, grounded Q&A, semantic search, and bulk data over ~129 Bittensor subnets. Point your agent here.",
      },
      { property: "og:title", content: "For AI agents — Metagraphed" },
    ],
  }),
  component: AgentsPage,
});
