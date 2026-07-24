import { createFileRoute } from "@tanstack/react-router";
import { DomainsPage } from "./-domains-page";

export const Route = createFileRoute("/domains")({
  head: () => ({
    meta: [
      { title: "Domains — Metagraphed" },
      {
        name: "description",
        content:
          "Browse Bittensor subnets by capability domain — inference, storage, compute, finance, and more — with member count, total stake, emission share, and within-domain emission concentration per domain.",
      },
      { property: "og:title", content: "Domains — Metagraphed" },
      {
        property: "og:description",
        content:
          "Browse Bittensor subnets by capability domain with real stake and emission context per domain.",
      },
    ],
  }),
  component: DomainsPage,
});
