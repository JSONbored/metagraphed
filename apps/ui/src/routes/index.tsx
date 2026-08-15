import { createFileRoute } from "@tanstack/react-router";
import { OverviewPage } from "./-index-page";
import { hubMeta } from "@/lib/metagraphed/hub-copy";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: hubMeta("/"),
  }),
  component: OverviewPage,
});
