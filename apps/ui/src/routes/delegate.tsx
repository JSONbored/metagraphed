import { createFileRoute } from "@tanstack/react-router";
import { DelegatePage } from "./-delegate-page";

export const Route = createFileRoute("/delegate")({
  head: () => ({
    meta: [
      { title: "Delegate τ to Ventura Labs · Metagraphed" },
      {
        name: "description",
        content:
          "One-click delegate or redelegate τ to featured partner validators across supported Bittensor subnets.",
      },
    ],
  }),
  component: DelegatePage,
});
