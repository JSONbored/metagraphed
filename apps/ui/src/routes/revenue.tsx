import { createFileRoute, redirect } from "@tanstack/react-router";

/**
 * /revenue retired into the /subnets revenue-evidence section (#11613).
 *
 * The page answers one facet of the subnet directory, so keeping a separate
 * top-level destination split the same evidence between two places. The
 * directory now keeps the observed-count denominator visible and sends a
 * reader from its short observed list into each subnet's full source ledger.
 *
 * A permanent redirect rather than a deletion: this URL is in the sitemap, in
 * llms.txt, and in whatever agents and inbound links already point at it, so
 * deleting the route would answer them with a 404 instead of the page that now
 * holds the answer. 301 and not the framework's 307 default because the route
 * is RETIRED rather than temporarily moved — a temporary redirect tells a
 * search engine to keep the old URL and re-check it, while a permanent one
 * transfers the signals to /subnets and lets the old URL drop out.
 *
 * The old sort/provenance search params are deliberately not forwarded. They
 * named columns of a retired table, so carrying them across would put state on
 * /subnets that nothing there can read.
 */
export const Route = createFileRoute("/revenue")({
  beforeLoad: () => {
    throw redirect({ to: "/subnets", hash: "revenue", replace: true, statusCode: 301 });
  },
});
