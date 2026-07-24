import { createFileRoute } from "@tanstack/react-router";
import { AccountsPage } from "./-accounts-index-page";

export const Route = createFileRoute("/accounts/")({
  head: () => ({
    meta: [
      { title: "Accounts — Metagraphed" },
      {
        name: "description",
        content:
          "Look up a Bittensor account (hotkey or coldkey) — cross-subnet activity, registrations, and first-party chain-event history.",
      },
      { property: "og:title", content: "Accounts — Metagraphed" },
      {
        property: "og:description",
        content:
          "Look up a Bittensor account (hotkey or coldkey) — cross-subnet activity, registrations, and chain-event history.",
      },
    ],
  }),
  component: AccountsPage,
});
