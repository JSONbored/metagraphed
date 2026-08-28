import { createFileRoute } from "@tanstack/react-router";
import {
  defineSearchSchema,
  enumSearch,
  stripDefaultSearchParams,
  type SearchOutput,
} from "@/lib/metagraphed/url-state";
import { ExplorerPage } from "./-explorer-page";
import { hubMeta } from "@/lib/metagraphed/hub-copy";

/**
 * Chain hub Overview — the retired /explorer (#8292, completing #8244).
 *
 * Bare /chain is the overview, so the hub's landing page is the network at a
 * glance rather than a redirect into one of its tabs.
 */
const overviewSearchSchema = defineSearchSchema({
  window: enumSearch(["7d", "30d"] as const, "7d"),
});

export type ChainOverviewSearch = SearchOutput<typeof overviewSearchSchema>;

export const Route = createFileRoute("/chain/")({
  validateSearch: overviewSearchSchema,
  search: { middlewares: [stripDefaultSearchParams(overviewSearchSchema)] },
  head: () => ({
    meta: hubMeta("/chain"),
  }),
  component: ExplorerPage,
});
