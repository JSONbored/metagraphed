import { createFileRoute } from "@tanstack/react-router";
import { stripDefaultSearchParams } from "@/lib/metagraphed/url-state";
import { z } from "zod";
import { fallback, zodValidator } from "@tanstack/zod-adapter";
import { ExplorerPage } from "./-explorer-page";
import { hubMeta } from "@/lib/metagraphed/hub-copy";

/**
 * Chain hub Overview — the retired /explorer (#8292, completing #8244).
 *
 * Bare /chain is the overview, so the hub's landing page is the network at a
 * glance rather than a redirect into one of its tabs.
 */
const overviewSearchSchema = z.object({
  window: fallback(z.enum(["7d", "30d"]), "7d").default("7d"),
});

export type ChainOverviewSearch = z.infer<typeof overviewSearchSchema>;

export const Route = createFileRoute("/chain/")({
  validateSearch: zodValidator(overviewSearchSchema),
  search: { middlewares: [stripDefaultSearchParams(overviewSearchSchema)] },
  head: () => ({
    meta: hubMeta("/chain"),
  }),
  component: ExplorerPage,
});
