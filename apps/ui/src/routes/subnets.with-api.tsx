import { createFileRoute, redirect } from "@tanstack/react-router";

/**
 * /subnets/with-api retired into the /subnets API filter (#11613).
 *
 * #11316 shipped this as the one faceted page of the three that epic proposed
 * that survived measurement — the subnets publishing a machine-readable API
 * specification. It survived as a PAGE because the index had no way to express
 * the selection; the rebuilt index does, so the facet is a filter on the
 * registry table and the synthesis it led with belongs to that table's own
 * header rather than to a second URL that lists a subset of the same rows.
 *
 * A permanent redirect rather than a deletion: this URL is in the sitemap, in
 * llms.txt, and linked from /subnets itself, so deleting the route would answer
 * a crawler that already indexed it with a 404. 301 and not the framework's 307
 * default because the route is RETIRED rather than temporarily moved — a
 * temporary redirect tells a search engine to keep the old URL and re-check it,
 * while a permanent one transfers the signals to /subnets and lets the old URL
 * drop out.
 *
 * The static segment stays declared here, so it keeps winning precedence over
 * /subnets/$netuid the way it did as a page (#11294) and no netuid is shadowed
 * by the redirect.
 */
export const Route = createFileRoute("/subnets/with-api")({
  beforeLoad: () => {
    throw redirect({ to: "/subnets", search: { api: true }, replace: true, statusCode: 301 });
  },
});
