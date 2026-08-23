import { stripDefaultSearchParams } from "@/lib/metagraphed/url-state";
import { createFileRoute } from "@tanstack/react-router";

import { z } from "zod";
import { Skeleton } from "@jsonbored/ui-kit";
import { EndpointsPage } from "./-endpoints-page";
import { hubMeta } from "@/lib/metagraphed/hub-copy";

/**
 * #11623 cut this from fourteen params to six.
 *
 * What went: `category` (the Kind filter is the endpoint's own `kind`, not a
 * bucketing of it), `region` and `eligibility` (neither was rendered by any
 * control), `callable` (the Status filter's `monitored` option is the honest
 * version of the same idea), `view` (the Grid was a second rendering of the
 * table), `window` (the proxy-usage panel it drove is gone), `endpoint` and
 * `compare` (row expansion and the compare tray went with the tab strip),
 * `sort`/`order`/`page`/`pageSize` (the table owns all four).
 */
const endpointsSearchSchema = z.object({
  q: z.string().catch("").default(""),
  status: z.string().catch("").default(""),
  kind: z.string().catch("").default(""),
  provider: z.string().catch("").default(""),
  latency: z.enum(["slowest", "fastest", "archive"]).catch("slowest").default("slowest"),
  incidents: z.enum(["open", "all"]).catch("open").default("open"),
});

export type EndpointsSearch = z.infer<typeof endpointsSearchSchema>;

export const Route = createFileRoute("/apis/endpoints")({
  validateSearch: endpointsSearchSchema,
  search: { middlewares: [stripDefaultSearchParams(endpointsSearchSchema)] },
  head: () => ({
    meta: hubMeta("/apis/endpoints"),
  }),
  pendingComponent: () => <Skeleton className="mx-auto my-6 h-96 w-full max-w-shell" />,
  component: EndpointsPage,
});
