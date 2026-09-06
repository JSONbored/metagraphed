import { createFileRoute } from "@tanstack/react-router";
import {
  TRAILING_WINDOWS,
  booleanSearch,
  defineSearchSchema,
  enumSearch,
  stripDefaultSearchParams,
  stringSearch,
  type SearchOutput,
} from "@/lib/metagraphed/url-state";
import { SubnetsPage } from "./-subnets-index-page";
import { directoryHealthFilter } from "@/lib/metagraphed/subnet-health-filter";
import { hubMeta } from "@/lib/metagraphed/hub-copy";

/**
 * The page's own search contract (#11613), not the shared `tableSearchSchema`.
 *
 * That schema is read by four routes and carries twenty keys — view mode, row
 * density, cursor paging, curation, kind, staleness, provider, watchlist —
 * every one of which belonged to a control this page no longer has. Sharing
 * it here would keep those keys alive in the URL with nothing to read them,
 * and `validateSearch` REPLACES the search object, so an unread key is not
 * inert: it is dropped on the next parse, rewriting any link that carries it.
 *
 * `domain` and `api` are the two filters `/subnets/category/$slug` and
 * `/subnets/with-api` became when those routes folded in here.
 */
export const subnetsSearchSchema = defineSearchSchema({
  q: stringSearch(),
  domain: stringSearch(),
  health: { defaultValue: "", parse: directoryHealthFilter },
  // A boolean, not the string "1". TanStack's search serialiser quotes a
  // string that would parse back as a number, so `api: "1"` reached the URL
  // as `api=%221%22` -- which the retired route's redirect then produced and
  // no reader could type.
  api: booleanSearch(false),
  metric: enumSearch(["emission", "stake", "price", "validators"] as const, "emission"),
  window: enumSearch(TRAILING_WINDOWS, "30d"),
});

export type SubnetsSearch = SearchOutput<typeof subnetsSearchSchema>;

export const Route = createFileRoute("/subnets/")({
  validateSearch: subnetsSearchSchema,
  search: { middlewares: [stripDefaultSearchParams(subnetsSearchSchema)] },
  head: () => ({
    meta: hubMeta("/subnets"),
  }),
  component: SubnetsPage,
});
