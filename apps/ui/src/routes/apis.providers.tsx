import {
  defineSearchSchema,
  stripDefaultSearchParams,
  stringSearch,
  type SearchOutput,
} from "@/lib/metagraphed/url-state";
import { createFileRoute } from "@tanstack/react-router";
import { RouteLoadingSkeleton } from "@/components/metagraphed/route-loading-skeleton";
import { ProvidersPage } from "./-providers-index-page";
import { hubMeta } from "@/lib/metagraphed/hub-copy";

export type ProvidersSearch = SearchOutput<typeof providersSearchSchema>;

/**
 * #11624 dropped `view` and `sort`.
 *
 * `view` toggled a grid of 136 provider cards that #8303 had already demoted
 * out of the default; the table is the page now and the grid is gone rather
 * than one toggle away. `sort` is the table's own, and duplicating it in the
 * URL let the two disagree.
 */
export const providersSearchSchema = defineSearchSchema({
  q: stringSearch(),
  kind: stringSearch(),
  // `high` is a nav shortcut for official + provider-claimed (see nav-mega-menu-data).
  authority: stringSearch(),
});

export const Route = createFileRoute("/apis/providers")({
  validateSearch: providersSearchSchema,
  search: { middlewares: [stripDefaultSearchParams(providersSearchSchema)] },
  head: () => ({
    meta: hubMeta("/apis/providers"),
  }),
  pendingComponent: RouteLoadingSkeleton,
  component: ProvidersPage,
});
