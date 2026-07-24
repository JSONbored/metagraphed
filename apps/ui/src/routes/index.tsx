import { createFileRoute } from "@tanstack/react-router";
import { OverviewPage } from "./-index-page";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Metagraphed — Bittensor registry & block explorer" },
      {
        name: "description",
        content:
          "Unofficial registry and block explorer for Bittensor — subnet APIs, schemas, docs, endpoints, providers, health, plus live blocks, extrinsics, and events.",
      },
    ],
  }),
  component: OverviewPage,
});
