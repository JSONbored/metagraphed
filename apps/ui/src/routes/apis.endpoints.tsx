import {
  defineSearchSchema,
  enumSearch,
  stripDefaultSearchParams,
  stringSearch,
  type SearchOutput,
} from "@/lib/metagraphed/url-state";
import { createFileRoute } from "@tanstack/react-router";

import { DirectoryRouteLoadingSkeleton } from "@/components/metagraphed/route-loading-skeleton";
import { EndpointsPage } from "./-endpoints-page";
import { hubMeta } from "@/lib/metagraphed/hub-copy";

/**
 * #11623 cut this from fourteen params to six.
 *
 * What went: `category` (the Kind filter is the endpoint's own `kind`, not a
 * bucketing of it), `region` and `eligibility` (neither was rendered by any
 * control), `callable` (replaced by an explicit status selection),
 * `view` (the Grid was a second rendering of the
 * table), `window` (the proxy-usage panel it drove is gone), `endpoint` and
 * `compare` (row expansion and the compare tray went with the tab strip),
 * `sort`/`order`/`page`/`pageSize` (the table owns all four).
 */
const endpointsSearchSchema = defineSearchSchema({
  q: stringSearch(),
  status: stringSearch(),
  kind: stringSearch(),
  provider: stringSearch(),
  latency: enumSearch(["slowest", "fastest", "archive"] as const, "slowest"),
  incidents: enumSearch(["open", "all"] as const, "open"),
});

export type EndpointsSearch = SearchOutput<typeof endpointsSearchSchema>;

export const Route = createFileRoute("/apis/endpoints")({
  validateSearch: endpointsSearchSchema,
  search: { middlewares: [stripDefaultSearchParams(endpointsSearchSchema)] },
  head: () => ({
    meta: hubMeta("/apis/endpoints"),
  }),
  pendingComponent: DirectoryRouteLoadingSkeleton,
  component: EndpointsPage,
});
